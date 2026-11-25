const ACK_TYPES = Object.freeze(['RECEIPT_ACK', 'OVERRIDE_ACK', 'PONG']);
const FRAME_ACK_TIMEOUT_MS = 10000;
const MAX_RECONNECT_DELAY_MS = 30000;

function parseFrameSafe(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    parsed = null;
  }
  return parsed;
}

function bindSocketEvents(ws, handlers) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('open', handlers.onOpen);
    ws.addEventListener('message', handlers.onMessage);
    ws.addEventListener('close', handlers.onClose);
    ws.addEventListener('error', handlers.onError);
    return;
  }
  ws.onopen = handlers.onOpen;
  ws.onmessage = handlers.onMessage;
  ws.onclose = handlers.onClose;
  ws.onerror = handlers.onError;
}

export function closeRawSocket(ws) {
  if (!ws) {
    return false;
  }
  let closed = true;
  try {
    ws.close(1000, 'Client close');
  } catch {
    closed = false;
  }
  return closed;
}

function clearReconnectTimer(ctx) {
  clearTimeout(ctx.timer);
  ctx.timer = null;
}

function detachActiveSocket(ctx) {
  const active = ctx.ws;
  ctx.ws = null;
  ctx.ready = false;
  return closeRawSocket(active);
}

function resumeSocketNow(ctx, makeError, buildWsUrl) {
  clearReconnectTimer(ctx);
  ctx.attempt = 0;
  ctx.onStatusChange?.({ status: 'connecting' });
  openLinkSocket(ctx, makeError, buildWsUrl).catch((err) => {
    ctx.lastError = err;
  });
}

function enterBackgroundSuspend(ctx) {
  const session = ctx.getSession();
  if (ctx.stopped || ctx.revoked || ctx.suspended ||
      !session.baseUrl || !session.token) {
    return;
  }
  clearReconnectTimer(ctx);
  ctx.suspended = true;
  detachActiveSocket(ctx);
  ctx.onStatusChange?.({ status: 'suspended' });
}

function settleNextPending(ctx, frame, makeError) {
  const waiter = ctx.pendingAcks.shift();
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timer);
  if (frame.type === 'ERROR') {
    waiter.reject(makeError(400, frame.code, frame.message));
  } else {
    waiter.resolve(frame);
  }
  if (ctx.wantSuspend && ctx.pendingAcks.length === 0) {
    enterBackgroundSuspend(ctx);
  }
}

export function rejectAllPending(ctx, reason) {
  while (ctx.pendingAcks.length > 0) {
    const waiter = ctx.pendingAcks.shift();
    clearTimeout(waiter.timer);
    waiter.reject(reason);
  }
}

function handleIncomingFrame(ctx, frame, handshake, makeError) {
  if (!frame || typeof frame !== 'object') {
    return;
  }
  if (frame.type === 'SYNC_PUSH') {
    if (!ctx.ready) {
      handshake.catchupFrames.push(frame);
      return;
    }
    ctx.onSyncFrame?.(frame);
    return;
  }
  if (frame.type === 'HELLO_ACK') {
    ctx.attempt = 0;
    ctx.ready = true;
    const reset = frame.latest_seq < handshake.sentLastSeq;
    ctx.onStatusChange?.({ status: 'online' });
    const ackInfo = {
      ...frame,
      sentLastSeq: handshake.sentLastSeq,
      reset,
      catchupFrames: handshake.catchupFrames
    };
    ctx.onHelloAck?.(ackInfo);
    handshake.resolve(ackInfo);
    return;
  }
  if (ACK_TYPES.includes(frame.type) || frame.type === 'ERROR') {
    settleNextPending(ctx, frame, makeError);
  }
}

function computeReconnectDelay(baseDelayMs, attempt) {
  const raw = Math.min(MAX_RECONNECT_DELAY_MS, baseDelayMs * (2 ** attempt));
  if (attempt < 2) {
    return raw;
  }
  const jitter = 0.85 + (Math.random() * 0.3);
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.round(raw * jitter));
}

export function scheduleSocketReconnect(ctx, makeError, buildWsUrl) {
  if (ctx.stopped || ctx.revoked || ctx.suspended) {
    return;
  }
  clearReconnectTimer(ctx);
  if (ctx.netOffline) {
    ctx.onStatusChange?.({ status: 'offline' });
    return;
  }
  const delay = computeReconnectDelay(ctx.baseDelayMs, ctx.attempt);
  ctx.attempt += 1;
  ctx.onStatusChange?.({ status: 'reconnecting', attempt: ctx.attempt });
  ctx.timer = setTimeout(() => {
    ctx.timer = null;
    if (!ctx.stopped && !ctx.revoked && !ctx.suspended && !ctx.netOffline) {
      openLinkSocket(ctx, makeError, buildWsUrl).catch((err) => {
        ctx.lastError = err;
      });
    }
  }, delay);
}

function handleSocketClose(ctx, ws, event, deps) {
  if (ctx.ws !== ws) {
    const codeTag = ctx.suspended ? 'SUSPENDED' : 'SUPERSEDED';
    deps.handshake.reject(deps.makeError(499, codeTag, 'Socket closed'));
    return;
  }
  const code = Number(event?.code || 0);
  ctx.ws = null;
  ctx.ready = false;
  rejectAllPending(ctx, deps.makeError(503, 'WS_CLOSED', 'Link closed'));
  if (code === 4401 || code === 4403) {
    ctx.revoked = true;
    clearReconnectTimer(ctx);
    const err = deps.makeError(401, 'AUTH_REVOKED', 'Session revoked');
    ctx.onStatusChange?.({ status: 'revoked', code });
    deps.handshake.reject(err);
    return;
  }
  deps.handshake.reject(deps.makeError(503, 'WS_CLOSED', `Closed (${code})`));
  if (ctx.wantSuspend) {
    enterBackgroundSuspend(ctx);
    return;
  }
  if (!ctx.stopped && !ctx.suspended) {
    scheduleSocketReconnect(ctx, deps.makeError, deps.buildWsUrl);
  }
}

function createHandshakeState(sentLastSeq, resolve, reject) {
  let settled = false;
  return {
    sentLastSeq,
    catchupFrames: [],
    resolve: (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    },
    reject: (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  };
}

function wireHandshakeSocket(ctx, ws, token, deps) {
  bindSocketEvents(ws, {
    onOpen: () => {
      if (ctx.ws !== ws || ctx.stopped) {
        closeRawSocket(ws);
        return;
      }
      ws.send(JSON.stringify({
        type: 'HELLO',
        token,
        last_seq: deps.handshake.sentLastSeq
      }));
    },
    onMessage: (ev) => {
      if (ctx.ws === ws && !ctx.stopped) {
        const parsed = parseFrameSafe(ev.data);
        handleIncomingFrame(ctx, parsed, deps.handshake, deps.makeError);
      }
    },
    onClose: (ev) => handleSocketClose(ctx, ws, ev, deps),
    onError: () => {}
  });
}

export function openLinkSocket(ctx, makeError, buildWsUrl) {
  const session = ctx.getSession();
  if (!ctx.WebSocketImpl || !session.baseUrl || !session.token) {
    return Promise.resolve(null);
  }
  if (ctx.wantSuspend) {
    enterBackgroundSuspend(ctx);
    return Promise.resolve(null);
  }
  if (ctx.ws) {
    detachActiveSocket(ctx);
  }
  ctx.stopped = false;
  ctx.revoked = false;
  ctx.suspended = false;
  clearReconnectTimer(ctx);
  const sentLastSeq = Math.max(0, Math.trunc(Number(session.lastSeq || 0)));
  const ws = new ctx.WebSocketImpl(buildWsUrl(session.baseUrl));
  ctx.ws = ws;
  return new Promise((resolve, reject) => {
    const handshake = createHandshakeState(sentLastSeq, resolve, reject);
    wireHandshakeSocket(
      ctx, ws, session.token, { handshake, makeError, buildWsUrl }
    );
  });
}

export function disconnectLinkSocket(ctx, makeError) {
  ctx.stopped = true;
  ctx.suspended = false;
  ctx.wantSuspend = false;
  clearReconnectTimer(ctx);
  rejectAllPending(ctx, makeError(499, 'DISCONNECTED', 'Disconnected'));
  return detachActiveSocket(ctx);
}

function enterOfflineMode(ctx, makeError) {
  clearReconnectTimer(ctx);
  if (ctx.ws) {
    const active = ctx.ws;
    ctx.ws = null;
    ctx.ready = false;
    rejectAllPending(ctx, makeError(503, 'WS_CLOSED', 'Network offline'));
    closeRawSocket(active);
  }
  if (!ctx.stopped && !ctx.revoked && !ctx.suspended) {
    ctx.onStatusChange?.({ status: 'offline' });
  }
}

function applyOfflinePatch(ctx, offline, makeError, buildWsUrl) {
  const wasOffline = ctx.netOffline;
  ctx.netOffline = offline;
  if (offline) {
    enterOfflineMode(ctx, makeError);
    return;
  }
  const canResume = wasOffline && !ctx.stopped && !ctx.revoked &&
    !ctx.suspended && !ctx.ws;
  if (canResume) {
    resumeSocketNow(ctx, makeError, buildWsUrl);
  }
}

export function setLinkPowerState(ctx, patch, makeError, buildWsUrl) {
  if (typeof patch?.offline === 'boolean') {
    applyOfflinePatch(ctx, patch.offline, makeError, buildWsUrl);
  }
  if (typeof patch?.hidden !== 'boolean') {
    return;
  }
  ctx.wantSuspend = patch.hidden;
  if (patch.hidden) {
    clearReconnectTimer(ctx);
    if (ctx.pendingAcks.length === 0) {
      enterBackgroundSuspend(ctx);
    }
    return;
  }
  if (!ctx.suspended) {
    return;
  }
  ctx.suspended = false;
  if (ctx.stopped || ctx.revoked) {
    return;
  }
  if (ctx.netOffline) {
    ctx.onStatusChange?.({ status: 'offline' });
    return;
  }
  resumeSocketNow(ctx, makeError, buildWsUrl);
}

export function sendLinkFrame(ctx, frame, makeError, buildWsUrl) {
  if (!ctx.ws || !ctx.ready) {
    return Promise.reject(
      makeError(503, 'WS_NOT_CONNECTED', 'Sync link is not ready')
    );
  }
  const activeWs = ctx.ws;
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const idx = ctx.pendingAcks.indexOf(waiter);
      if (idx !== -1) {
        ctx.pendingAcks.splice(idx, 1);
      }
      if (ctx.ws === activeWs) {
        detachActiveSocket(ctx);
        rejectAllPending(ctx, makeError(504, 'WS_TIMEOUT', 'Ack timed out'));
        if (ctx.wantSuspend) {
          enterBackgroundSuspend(ctx);
        } else {
          scheduleSocketReconnect(ctx, makeError, buildWsUrl);
        }
      }
      reject(makeError(504, 'WS_TIMEOUT', 'WebSocket ack timed out'));
    }, FRAME_ACK_TIMEOUT_MS);
    ctx.pendingAcks.push(waiter);
    activeWs.send(JSON.stringify(frame));
  });
}
