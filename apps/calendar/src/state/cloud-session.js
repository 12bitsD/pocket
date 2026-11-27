import { normalizeBaseUrl } from '../api/cloud-client.js';
import {
  dateViewPatch,
  localDateIso
} from '../domain/date-time.js';
import {
  fetchCloudSnapshot,
  loadColdBootstrap,
  queryAdminSnapshots
} from './bootstrap-rpc.js';
import { createDemoSeed } from './demo-seed.js';
import {
  flushOfflineQueue,
  reapplyOfflineOverlay
} from './offline-flush.js';
import {
  EMPTY_OFFLINE_QUEUE,
  normalizeOfflineQueue
} from './offline-queue.js';
import {
  applySyncBatch,
  hasScope,
  loadPersistedState,
  parseUrlBootstrap
} from './sync-reducer.js';

export { fetchCloudSnapshot, queryAdminSnapshots };

const SKIP_HISTORY_SEQ = Number.MAX_SAFE_INTEGER;

export function stripSensitiveUrlParams(page) {
  if (typeof window === 'undefined' || !window.history?.replaceState) {
    return;
  }
  window.history.replaceState({ page }, '', `?page=${page}`);
}

async function openAndSyncLink(ctx, epoch, cursorSpec) {
  if (!hasScope(ctx.state.identity, '*')) {
    ctx.state = { ...ctx.state, connectionStatus: 'online' };
    ctx.notify();
    return;
  }
  ctx.helloCursor = cursorSpec.cursor;
  ctx.expectStaleCheck = cursorSpec.checkReset;
  let ack = null;
  try {
    ack = await ctx.client.connectWs();
  } catch (err) {
    if (err?.code !== 'SUSPENDED') {
      throw err;
    }
    return;
  }
  if (ctx.sessionEpoch !== epoch) {
    return;
  }
  if (ctx.pendingHelloTask) {
    await ctx.pendingHelloTask;
  } else if (ack) {
    ctx.state = { ...ctx.state, lastSeq: ack.latest_seq };
    ctx.notify();
  }
}

function canResumeWarmSession(ctx, opts, same) {
  return Boolean(
    opts?.resumeCached &&
    same &&
    ctx.state.identity &&
    hasScope(ctx.state.identity, '*') &&
    ctx.state.lastSeq > 0
  );
}

function applyColdSessionState(ctx, auth, boot, same) {
  const prevSeq = same ? ctx.state.lastSeq : 0;
  const initSeq = boot.hasLatestSeq
    ? Math.max(prevSeq, boot.latestSeq)
    : prevSeq;
  const baseState = {
    ...ctx.state,
    mode: 'cloud',
    connectionStatus: 'connecting',
    baseUrl: auth.baseUrl,
    token: auth.token,
    identity: boot.identity,
    lastSeq: initSeq,
    offlineQueue: same ? ctx.state.offlineQueue : EMPTY_OFFLINE_QUEUE,
    ...boot.snapshot
  };
  ctx.state = reapplyOfflineOverlay(baseState);
  const cursor = boot.hasLatestSeq
    ? initSeq
    : (same ? initSeq : SKIP_HISTORY_SEQ);
  return {
    cursor,
    checkReset: same && prevSeq > 0 && !boot.hasLatestSeq
  };
}

export async function connectCloudSession(ctx, opts) {
  const baseUrl = normalizeBaseUrl(opts?.baseUrl);
  const token = String(opts?.token || '').trim();
  ctx.sessionEpoch += 1;
  const epoch = ctx.sessionEpoch;
  ctx.client.disconnect();
  const same = ctx.state.baseUrl === baseUrl && ctx.state.token === token;
  if (canResumeWarmSession(ctx, opts, same)) {
    ctx.state = { ...ctx.state, mode: 'cloud', connectionStatus: 'connecting' };
    ctx.notify();
    await openAndSyncLink(ctx, epoch, {
      cursor: ctx.state.lastSeq,
      checkReset: true
    });
    return ctx.getPublicState();
  }
  const boot = await loadColdBootstrap(ctx, baseUrl, token, opts);
  if (ctx.sessionEpoch !== epoch) {
    return ctx.getPublicState();
  }
  const cursorSpec = applyColdSessionState(
    ctx, { baseUrl, token }, boot, same
  );
  ctx.notify();
  await openAndSyncLink(ctx, epoch, cursorSpec);
  return ctx.getPublicState();
}

async function runResetResync(ctx, ack, epoch) {
  ctx.syncBuffer = [];
  let snap = null;
  try {
    snap = await fetchCloudSnapshot(ctx, ctx.state.identity);
  } finally {
    const buffered = ctx.syncBuffer || [];
    ctx.syncBuffer = null;
    if (snap && ctx.sessionEpoch === epoch && ctx.state.mode === 'cloud') {
      const baseState = {
        ...ctx.state,
        ...snap,
        lastSeq: ack.latest_seq,
        connectionStatus: 'online'
      };
      ctx.state = reapplyOfflineOverlay(applySyncBatch(baseState, buffered));
      ctx.notify();
    }
  }
  if (ctx.sessionEpoch === epoch && ctx.state.mode === 'cloud') {
    await flushOfflineQueue(ctx);
  }
}

function trackPendingHelloTask(ctx, promise) {
  const task = promise.finally(() => {
    if (ctx.pendingHelloTask === task) {
      ctx.pendingHelloTask = null;
    }
  });
  ctx.pendingHelloTask = task;
  return task;
}

export function handleHelloAckSession(ctx, ack) {
  if (ctx.state.mode !== 'cloud' || !ctx.state.identity) {
    return Promise.resolve();
  }
  const isReset = Boolean(ctx.expectStaleCheck) && ack.reset;
  ctx.expectStaleCheck = true;
  ctx.helloCursor = null;
  if (isReset) {
    return trackPendingHelloTask(
      ctx, runResetResync(ctx, ack, ctx.sessionEpoch)
    );
  }
  const baseState = {
    ...ctx.state,
    lastSeq: ack.latest_seq,
    connectionStatus: 'online'
  };
  ctx.state = reapplyOfflineOverlay(
    applySyncBatch(baseState, ack.catchupFrames || [])
  );
  ctx.notify();
  return trackPendingHelloTask(ctx, flushOfflineQueue(ctx));
}

export async function claimPairingSession(ctx, opts) {
  const baseUrl = normalizeBaseUrl(opts?.baseUrl || ctx.state.baseUrl);
  const code = String(opts?.code || '').trim();
  const name = opts?.name || 'Pocket Phone';
  const claimed = await ctx.client.callRpc(
    'pairing.claim',
    { code, name },
    { baseUrl, publicCall: true, source: 'local' }
  );
  await connectCloudSession(
    ctx, { baseUrl, token: claimed.token, source: 'local' }
  );
  return claimed;
}

export function disconnectCloudSession(ctx) {
  ctx.sessionEpoch += 1;
  ctx.syncBuffer = null;
  ctx.pendingHelloTask = null;
  ctx.client.disconnect();
  const demo = createDemoSeed(localDateIso(0, ctx.clock()));
  ctx.state = {
    ...ctx.state,
    mode: 'demo',
    connectionStatus: 'demo',
    baseUrl: '',
    token: '',
    identity: null,
    lastSeq: 0,
    activePairing: null,
    lastMintedToken: null,
    appUpdate: null,
    appUpdateDismissed: false,
    offlineQueue: EMPTY_OFFLINE_QUEUE,
    ...demo
  };
  ctx.notify();
}

function selectCachedConnection(cached) {
  if (cached?.mode === 'cloud' && cached.baseUrl && cached.token) {
    return {
      mode: 'cloud',
      connectionStatus: 'offline',
      baseUrl: cached.baseUrl,
      token: cached.token,
      identity: cached.identity || null,
      lastSeq: Number(cached.lastSeq || 0)
    };
  }
  return {
    mode: 'demo',
    connectionStatus: 'demo',
    baseUrl: '',
    token: '',
    identity: null,
    lastSeq: 0
  };
}

export function buildInitialState(options, clock) {
  const todayIso = localDateIso(0, clock());
  const cached = loadPersistedState(options?.storage);
  const query = parseUrlBootstrap(options?.initialQuery);
  const demo = createDemoSeed(todayIso);
  const conn = selectCachedConnection(cached);
  return {
    query,
    state: {
      ...conn,
      theme: query.theme || cached?.theme || 'white',
      motionOff: query.motionOff,
      page: query.page,
      lastMainPage: query.page === 'settings' ? 'agenda' : query.page,
      ...dateViewPatch(todayIso),
      masterEvents: cached?.masterEvents || demo.masterEvents,
      todos: cached?.todos || demo.todos,
      agents: cached?.agents || demo.agents,
      tokens: cached?.tokens || [],
      offlineQueue: normalizeOfflineQueue(cached?.offlineQueue),
      nativePermissions: null,
      activePairing: null,
      lastMintedToken: null
    }
  };
}
