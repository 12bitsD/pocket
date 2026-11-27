import { extractMasterEvents } from '../domain/calendar-model.js';
import {
  computeDefaultSyncRange,
  localDateIso
} from '../domain/date-time.js';
import { hasScope } from './sync-reducer.js';

function inferSource(identity, explicitSource, isNative) {
  if (explicitSource) {
    return explicitSource;
  }
  if (isNative || identity?.kind === 'device') {
    return 'local';
  }
  if (identity?.kind === 'agent') {
    return 'agent';
  }
  return 'web';
}

function queryEventSnapshot(ctx, identity, range) {
  if (!hasScope(identity, 'event.read')) {
    return Promise.resolve({ events: [] });
  }
  return ctx.client.callRpc('event.list', {
    start_date: range.startDate,
    end_date: range.endDate
  });
}

function queryTodoSnapshot(ctx, identity) {
  if (!hasScope(identity, 'todo.read')) {
    return Promise.resolve({ todos: [] });
  }
  return ctx.client.callRpc('todo.list', {});
}

export function queryAdminSnapshots(ctx, identity) {
  if (!hasScope(identity, '*')) {
    return Promise.all([{ agents: [] }, { tokens: [] }]);
  }
  return Promise.all([
    ctx.client.callRpc('agent.list', {}),
    ctx.client.callRpc('token.list', {})
  ]);
}

async function tryBootstrapSnapshot(ctx, range, callOpts) {
  let boot = null;
  try {
    boot = await ctx.client.callRpc('sync.bootstrap', {
      start_date: range.startDate,
      end_date: range.endDate
    }, callOpts);
  } catch (err) {
    if (err?.code !== 'METHOD_NOT_FOUND') {
      throw err;
    }
    boot = null;
  }
  if (!Array.isArray(boot?.events) || !Array.isArray(boot?.todos)) {
    return null;
  }
  return {
    identity: boot.identity || null,
    latestSeq: Number(boot.latest_seq || 0),
    hasLatestSeq: typeof boot.latest_seq === 'number',
    snapshot: {
      masterEvents: extractMasterEvents(boot.events),
      todos: boot.todos,
      agents: boot.agents || [],
      tokens: boot.tokens || [],
      integrations: boot.integrations || []
    }
  };
}

export async function fetchLegacySnapshot(ctx, identity, range) {
  const [evRes, tdRes, adminPair] = await Promise.all([
    queryEventSnapshot(ctx, identity, range),
    queryTodoSnapshot(ctx, identity),
    queryAdminSnapshots(ctx, identity)
  ]);
  return {
    masterEvents: extractMasterEvents(evRes.events || []),
    todos: tdRes.todos || [],
    agents: adminPair[0].agents || [],
    tokens: adminPair[1].tokens || []
  };
}

export async function fetchCloudSnapshot(ctx, identity) {
  const range = computeDefaultSyncRange(localDateIso(0, ctx.clock()));
  const fast = await tryBootstrapSnapshot(ctx, range);
  if (fast) {
    return fast.snapshot;
  }
  return fetchLegacySnapshot(ctx, identity, range);
}

export async function loadColdBootstrap(ctx, baseUrl, token, opts) {
  const reqSrc = opts?.source || (ctx.isNative ? 'local' : 'web');
  const range = computeDefaultSyncRange(localDateIso(0, ctx.clock()));
  const fast = await tryBootstrapSnapshot(
    ctx, range, { baseUrl, token, source: reqSrc }
  );
  if (fast?.identity) {
    return {
      identity: {
        ...fast.identity,
        source: inferSource(fast.identity, opts?.source, ctx.isNative)
      },
      snapshot: fast.snapshot,
      latestSeq: fast.latestSeq,
      hasLatestSeq: fast.hasLatestSeq
    };
  }
  const statusData = await ctx.client.callRpc(
    'auth.status', {}, { baseUrl, token, source: reqSrc }
  );
  const identity = {
    ...statusData,
    source: inferSource(statusData, opts?.source, ctx.isNative)
  };
  const snapshot = await fetchLegacySnapshot(ctx, identity, range);
  return { identity, snapshot, latestSeq: 0, hasLatestSeq: false };
}
