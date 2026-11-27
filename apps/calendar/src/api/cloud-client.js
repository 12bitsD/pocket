import {
  disconnectLinkSocket,
  openLinkSocket,
  scheduleSocketReconnect,
  sendLinkFrame,
  setLinkPowerState
} from './link-socket.js';

const READ_METHODS = Object.freeze([
  'auth.status',
  'sync.bootstrap',
  'token.list',
  'agent.list',
  'event.list',
  'todo.list'
]);

export class CloudRpcError extends Error {
  constructor(status, code, message) {
    super(message || code || 'Cloud RPC failed');
    this.name = 'CloudRpcError';
    this.status = status;
    this.code = code || 'RPC_ERROR';
  }
}

function makeRpcError(status, code, message) {
  return new CloudRpcError(status, code, message);
}

export function normalizeBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new CloudRpcError(400, 'INVALID_URL', 'Cloud URL must be http(s)');
  }
  return trimmed;
}

export function buildWsUrl(baseUrl) {
  const clean = normalizeBaseUrl(baseUrl);
  const wsBase = clean.replace(/^http/i, 'ws');
  return `${wsBase}/v1/link`;
}

function makeRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `req_${crypto.randomUUID()}`;
  }
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function parseJsonSafe(response) {
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return parsed;
}

function buildRpcInit(method, params, session, callOpts) {
  const headers = { 'Content-Type': 'application/json' };
  const token = callOpts?.token ?? session.token;
  if (!callOpts?.publicCall && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const body = {
    params: params || {},
    source: callOpts?.source || session.source || 'web'
  };
  if (!READ_METHODS.includes(method)) {
    body.request_id = callOpts?.requestId || makeRequestId();
  }
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

async function executeRpc(ctx, method, params, callOpts) {
  const session = ctx.getSession();
  const baseUrl = normalizeBaseUrl(callOpts?.baseUrl ?? session.baseUrl);
  const token = callOpts?.token ?? session.token;
  const init = buildRpcInit(method, params, session, callOpts);
  const res = await ctx.fetchImpl(`${baseUrl}/v1/rpc/${method}`, init);
  const payload = await parseJsonSafe(res);
  if (!res.ok) {
    const isSessionAuth = !callOpts?.publicCall && token &&
      token === session.token;
    if (res.status === 401 && isSessionAuth) {
      ctx.revoked = true;
      clearTimeout(ctx.timer);
      ctx.onStatusChange?.({ status: 'revoked', code: 401 });
    }
    const code = payload?.error?.code || 'HTTP_ERROR';
    const message = payload?.error?.message || `HTTP ${res.status}`;
    throw new CloudRpcError(res.status, code, message);
  }
  return payload?.data;
}

async function executeGetLatestApp(ctx) {
  const session = ctx.getSession();
  const baseUrl = normalizeBaseUrl(session.baseUrl);
  const headers = {};
  if (session.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  const res = await ctx.fetchImpl(`${baseUrl}/v1/app/latest`, {
    method: 'GET',
    headers
  });
  const payload = await parseJsonSafe(res);
  if (!res.ok) {
    const code = payload?.error?.code || 'HTTP_ERROR';
    const message = payload?.error?.message || `HTTP ${res.status}`;
    throw new CloudRpcError(res.status, code, message);
  }
  return payload?.data || null;
}

export function createCloudClient(options) {
  const ctx = {
    fetchImpl: options?.fetchImpl || globalThis.fetch?.bind(globalThis),
    WebSocketImpl: options?.WebSocketImpl ?? globalThis.WebSocket ?? null,
    getSession: options?.getSession || (() => ({})),
    onSyncFrame: options?.onSyncFrame || null,
    onAppUpdate: options?.onAppUpdate || null,
    onHelloAck: options?.onHelloAck || null,
    onStatusChange: options?.onStatusChange || null,
    baseDelayMs: options?.reconnectBaseMs ?? 500,
    ws: null,
    ready: false,
    stopped: false,
    revoked: false,
    suspended: false,
    wantSuspend: false,
    netOffline: false,
    attempt: 0,
    timer: null,
    lastError: null,
    pendingAcks: []
  };
  return Object.freeze({
    callRpc: (method, params, opts) => executeRpc(ctx, method, params, opts),
    fetchLatestApp: () => executeGetLatestApp(ctx),
    connectWs: () => openLinkSocket(ctx, makeRpcError, buildWsUrl),
    disconnect: () => disconnectLinkSocket(ctx, makeRpcError),
    scheduleRetry: () => {
      ctx.stopped = false;
      scheduleSocketReconnect(ctx, makeRpcError, buildWsUrl);
    },
    setPowerState: (patch) => setLinkPowerState(
      ctx, patch, makeRpcError, buildWsUrl
    ),
    sendWsFrame: (frame) => sendLinkFrame(ctx, frame, makeRpcError, buildWsUrl),
    isConnected: () => Boolean(ctx.ws && ctx.ready),
    isSuspended: () => Boolean(ctx.suspended)
  });
}
