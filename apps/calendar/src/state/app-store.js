import { createCloudClient } from '../api/cloud-client.js';
import { dateViewPatch } from '../domain/date-time.js';
import {
  attachNativeAlarmBridge,
  detectNativeAndroid
} from '../native/alarm-bridge.js';
import {
  createPairingAction,
  createTokenAction,
  refreshAdminLists,
  revokeAgentAction,
  revokeTokenByIdAction,
  saveAgentAction,
  setAgentScopeGrantAction
} from './admin-actions.js';
import {
  buildInitialState,
  claimPairingSession,
  connectCloudSession,
  disconnectCloudSession,
  fetchCloudSnapshot,
  handleHelloAckSession,
  stripSensitiveUrlParams
} from './cloud-session.js';
import {
  dispatchOrQueueAlarmReceipt,
  reapplyOfflineOverlay
} from './offline-flush.js';
import {
  bindRuntimePowerListeners,
  createPersistenceScheduler,
  createSelectorCache,
  selectPublicState
} from './state-cache.js';
import {
  refreshMonthRangeAction,
  removeEventAction,
  removeTodoAction,
  saveEventAction,
  saveTodoAction,
  toggleSkipNextAction,
  toggleTodoAction,
  triggerAgentTodoAction
} from './store-actions.js';
import {
  applySyncFrame,
  hasScope
} from './sync-reducer.js';

function detectTimezone() {
  let zone = 'Asia/Shanghai';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone;
  } catch {
    zone = 'Asia/Shanghai';
  }
  return zone;
}

function notifySubscribers(ctx) {
  ctx.persistence.schedule(ctx.state);
  const snapshot = selectPublicState(ctx);
  for (const fn of ctx.listeners) {
    fn(snapshot);
  }
}

function attachStoreClient(ctx, options) {
  ctx.client = createCloudClient({
    fetchImpl: options?.fetchImpl,
    WebSocketImpl: options?.WebSocketImpl,
    reconnectBaseMs: options?.reconnectBaseMs,
    getSession: () => ({
      baseUrl: ctx.state.baseUrl,
      token: ctx.state.token,
      source: ctx.state.identity?.source || (ctx.isNative ? 'local' : 'web'),
      lastSeq: ctx.helloCursor ?? ctx.state.lastSeq
    }),
    onSyncFrame: (frame) => {
      if (ctx.state.mode !== 'cloud') {
        return;
      }
      if (Array.isArray(ctx.syncBuffer)) {
        ctx.syncBuffer.push(frame);
        return;
      }
      ctx.state = reapplyOfflineOverlay(applySyncFrame(ctx.state, frame));
      notifySubscribers(ctx);
    },
    onHelloAck: (ack) => {
      handleHelloAckSession(ctx, ack).catch((err) => {
        ctx.lastBootError = err;
      });
    },
    onStatusChange: (ev) => {
      if (ctx.state.mode === 'cloud') {
        ctx.state = { ...ctx.state, connectionStatus: ev.status };
        notifySubscribers(ctx);
      }
    }
  });
}

function updateViewPatch(ctx, patch) {
  const dateFields = patch.focusDate
    ? dateViewPatch(patch.focusDate)
    : {};
  const cleanPatch = { ...patch, ...dateFields };
  delete cleanPatch.focusDate;
  const nextPage = cleanPatch.page || ctx.state.page;
  const lastMain = nextPage !== 'settings'
    ? nextPage
    : ctx.state.lastMainPage;
  ctx.state = { ...ctx.state, ...cleanPatch, lastMainPage: lastMain };
  notifySubscribers(ctx);
}

const BOUND_ACTIONS = Object.freeze({
  saveEvent: saveEventAction,
  removeEvent: removeEventAction,
  saveTodo: saveTodoAction,
  toggleTodo: toggleTodoAction,
  toggleSkipNext: toggleSkipNextAction,
  removeTodo: removeTodoAction,
  triggerAgentTodo: triggerAgentTodoAction,
  connectCloud: connectCloudSession,
  claimPairing: claimPairingSession,
  disconnectCloud: disconnectCloudSession,
  createPairingCode: createPairingAction,
  saveAgent: saveAgentAction,
  revokeAgent: revokeAgentAction,
  setAgentScopeGrant: setAgentScopeGrantAction,
  createScopedToken: createTokenAction,
  revokeToken: revokeTokenByIdAction,
  sendAlarmReceipt: dispatchOrQueueAlarmReceipt,
  refreshAdminSnapshot: refreshAdminLists
});

function bindActions(ctx) {
  const out = {};
  for (const [name, fn] of Object.entries(BOUND_ACTIONS)) {
    out[name] = fn.bind(null, ctx);
  }
  return out;
}

function buildStoreApi(ctx) {
  return Object.freeze({
    ...bindActions(ctx),
    getState: () => selectPublicState(ctx),
    subscribe: (fn) => {
      ctx.listeners.add(fn);
      return () => ctx.listeners.delete(fn);
    },
    destroy: () => {
      ctx.sessionEpoch += 1;
      ctx.unbindPower?.();
      ctx.persistence.dispose();
      ctx.alarmBridge?.destroy();
      ctx.client.disconnect();
      ctx.listeners.clear();
    },
    setViewState: (patch) => updateViewPatch(ctx, patch),
    setTheme: (theme) => {
      ctx.state = { ...ctx.state, theme };
      notifySubscribers(ctx);
    },
    clearMintedToken: () => {
      ctx.state = { ...ctx.state, lastMintedToken: null };
      notifySubscribers(ctx);
    },
    refreshMonthRange: (year, month, selectedDate) => refreshMonthRangeAction(
      ctx, { year, month, selectedDate }
    ),
    setPowerState: (patch) => {
      if (patch?.hidden) {
        ctx.persistence.flushNow();
      }
      ctx.client.setPowerState(patch);
    },
    flushPersistence: () => ctx.persistence.flushNow(),
    refreshNativePermissions: () => ctx.alarmBridge.refreshPermissions(),
    openNativePermission: (target) => ctx.alarmBridge.openPermission(target),
    drainNativeRingingEvents: () => ctx.alarmBridge.drainRingingEvents()
  });
}

function handleBootFailure(ctx, err) {
  ctx.lastBootError = err;
  if (ctx.state.mode !== 'cloud' ||
      err?.code === 'SUSPENDED' ||
      err?.code === 'DISCONNECTED') {
    return;
  }
  if (err?.status === 401 || err?.status === 403) {
    ctx.state = { ...ctx.state, connectionStatus: 'revoked' };
    notifySubscribers(ctx);
    return;
  }
  ctx.state = { ...ctx.state, connectionStatus: 'offline' };
  notifySubscribers(ctx);
  if (ctx.state.identity && hasScope(ctx.state.identity, '*')) {
    ctx.client.scheduleRetry();
  }
}

function startInitialCloudBoot(ctx, query) {
  if (query.cloudUrl && query.token) {
    stripSensitiveUrlParams(query.page);
    ctx.bootPromise = connectCloudSession(
      ctx, { baseUrl: query.cloudUrl, token: query.token }
    ).catch((err) => handleBootFailure(ctx, err));
    return;
  }
  if (ctx.state.mode === 'cloud') {
    ctx.bootPromise = connectCloudSession(ctx, {
      baseUrl: ctx.state.baseUrl,
      token: ctx.state.token,
      source: ctx.state.identity?.source,
      resumeCached: true
    }).catch((err) => handleBootFailure(ctx, err));
  }
}

async function resyncCloudSnapshot(ctx) {
  if (ctx.state.mode !== 'cloud' || !ctx.state.identity) {
    return;
  }
  const epoch = ctx.sessionEpoch;
  const snap = await fetchCloudSnapshot(ctx, ctx.state.identity)
    .catch(() => null);
  if (snap && ctx.sessionEpoch === epoch && ctx.state.mode === 'cloud') {
    ctx.state = reapplyOfflineOverlay({ ...ctx.state, ...snap });
    notifySubscribers(ctx);
  }
}

export function createAppStore(options) {
  const clock = options?.clock || (() => new Date());
  const boot = buildInitialState(options, clock);
  const storage = options?.storage ?? null;
  const ctx = {
    storage,
    clock,
    timezone: options?.defaultTimezone || detectTimezone(),
    isNative: detectNativeAndroid(options),
    listeners: new Set(),
    state: boot.state,
    selectorCache: createSelectorCache(),
    persistence: createPersistenceScheduler(storage, boot.state),
    unbindPower: null,
    client: null,
    alarmBridge: null,
    sessionEpoch: 0,
    helloCursor: null,
    expectStaleCheck: true,
    syncBuffer: null,
    pendingHelloTask: null,
    lastBootError: null,
    lastBridgeError: null,
    flushingOffline: false,
    flushChain: Promise.resolve(),
    grantChain: Promise.resolve(),
    notify: () => notifySubscribers(ctx),
    getPublicState: () => selectPublicState(ctx),
    resyncSnapshot: () => resyncCloudSnapshot(ctx)
  };
  attachStoreClient(ctx, options);
  ctx.unbindPower = bindRuntimePowerListeners(
    (patch) => ctx.client.setPowerState(patch),
    () => ctx.persistence.flushNow()
  );
  const api = buildStoreApi(ctx);
  ctx.alarmBridge = attachNativeAlarmBridge(ctx, api, options);
  startInitialCloudBoot(ctx, boot.query);
  return api;
}
