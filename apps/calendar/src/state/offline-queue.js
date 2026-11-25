import { CloudRpcError } from '../api/cloud-client.js';
import {
  buildOptimisticEventSave,
  buildOptimisticTodoSave,
  computeTodoToggleFlags,
  isAlarmEvent,
  isSchedulableMeTodo
} from '../domain/local-mutations.js';
import { buildTodoSetParams } from '../domain/todo-model.js';
import {
  deleteByRevision,
  resolveLocalDeviceFlag
} from './sync-reducer.js';

const WS_TRANSIENT_CODES = Object.freeze([
  'WS_NOT_CONNECTED',
  'WS_CLOSED',
  'WS_TIMEOUT'
]);

const RETRYABLE_HTTP_STATUSES = Object.freeze([408, 429, 500, 502, 503, 504]);

export const EMPTY_OFFLINE_QUEUE = Object.freeze({
  mutations: Object.freeze([]),
  receipts: Object.freeze([])
});

export function normalizeOfflineQueue(raw) {
  const mutations = Array.isArray(raw?.mutations) ? [...raw.mutations] : [];
  const receipts = Array.isArray(raw?.receipts) ? [...raw.receipts] : [];
  return { mutations, receipts };
}

export function hasPendingOfflineItems(queue) {
  const mutLen = queue?.mutations?.length || 0;
  const recLen = queue?.receipts?.length || 0;
  return mutLen > 0 || recLen > 0;
}

export function canUseOfflineQueue(ctx) {
  const st = ctx.state;
  if (st.mode !== 'cloud' || st.connectionStatus === 'revoked') {
    return false;
  }
  return resolveLocalDeviceFlag(st, ctx.isNative);
}

export function findQueuedMutation(queue, entityType, entityId) {
  if (!entityId) {
    return null;
  }
  return (queue?.mutations || []).find(
    (m) => m.entityType === entityType && m.entityId === entityId
  ) || null;
}

export function shouldBypassRpcOffline(ctx, entityType, entityId) {
  if (!canUseOfflineQueue(ctx)) {
    return false;
  }
  if (ctx.state.connectionStatus !== 'online' || ctx.flushingOffline) {
    return true;
  }
  return Boolean(
    findQueuedMutation(ctx.state.offlineQueue, entityType, entityId)
  );
}

export function isOfflineFallbackError(ctx, err) {
  if (!canUseOfflineQueue(ctx) || !err) {
    return false;
  }
  if (!(err instanceof CloudRpcError)) {
    return true;
  }
  if (WS_TRANSIENT_CODES.includes(err.code)) {
    return true;
  }
  return RETRYABLE_HTTP_STATUSES.includes(Number(err.status));
}

export function dropEntityReceipts(receipts, entityType, entityId) {
  return receipts.filter(
    (r) => !(r.entityType === entityType && r.entityId === entityId)
  );
}

export function replaceEntityItem(list, idKey, nextItem) {
  const filtered = list.filter((item) => item[idKey] !== nextItem[idKey]);
  return [nextItem, ...filtered];
}

function resolveBaseRev(prev, existing) {
  if (prev) {
    return prev.serverBaseRevision;
  }
  return existing?.revision;
}

function upsertMutation(queue, entry, receiptPolicy) {
  const nextMuts = (queue?.mutations || []).filter(
    (m) => !(m.entityType === entry.entityType && m.entityId === entry.entityId)
  );
  if (!entry.dropOnly) {
    nextMuts.push(entry);
  }
  const baseReceipts = queue?.receipts || [];
  const nextReceipts = receiptPolicy.dropReceipts
    ? dropEntityReceipts(baseReceipts, entry.entityType, entry.entityId)
    : [...baseReceipts];
  return { mutations: nextMuts, receipts: nextReceipts };
}

function prepareQueuedSaveParams(queue, target, params, existing) {
  const prev = findQueuedMutation(queue, target.entityType, target.entityId);
  const createdOffline = !existing || Boolean(prev?.createdOffline);
  const baseRev = resolveBaseRev(prev, existing);
  const nextParams = { ...params, [target.idKey]: target.entityId };
  if (createdOffline || baseRev === undefined) {
    delete nextParams.base_revision;
  } else {
    nextParams.base_revision = baseRev;
  }
  return { createdOffline, baseRev, nextParams };
}

export function recordOfflineEventSave(ctx, params, existing, notify) {
  const q = normalizeOfflineQueue(ctx.state.offlineQueue);
  const optimistic = buildOptimisticEventSave(params, existing, {
    idPrefix: 'ev',
    source: ctx.state.identity?.source || 'local'
  });
  const eventId = optimistic.event_id;
  const prep = prepareQueuedSaveParams(
    q, { entityType: 'event', idKey: 'event_id', entityId: eventId },
    params, existing
  );
  const nextQueue = upsertMutation(q, {
    kind: 'rpc',
    method: 'event.set',
    entityType: 'event',
    entityId: eventId,
    createdOffline: prep.createdOffline,
    serverBaseRevision: prep.baseRev,
    params: prep.nextParams,
    snapshot: optimistic
  }, { dropReceipts: !isAlarmEvent(optimistic) });
  ctx.state = {
    ...ctx.state,
    masterEvents: replaceEntityItem(
      ctx.state.masterEvents, 'event_id', optimistic
    ),
    offlineQueue: nextQueue
  };
  notify(ctx);
  return optimistic;
}

function buildTodoMutationEntry(ctx, todoId, nextParams, meta) {
  const isDeviceLock = Boolean(nextParams.locked) &&
    ctx.state.identity?.kind === 'device';
  if (isDeviceLock) {
    const lockPayload = { ...nextParams, locked: true };
    delete lockPayload.base_revision;
    return {
      kind: 'lock_override',
      entityType: 'todo',
      entityId: todoId,
      createdOffline: meta.createdOffline,
      serverBaseRevision: meta.baseRev,
      todo: lockPayload,
      snapshot: meta.optimistic
    };
  }
  return {
    kind: 'rpc',
    method: 'todo.set',
    entityType: 'todo',
    entityId: todoId,
    createdOffline: meta.createdOffline,
    serverBaseRevision: meta.baseRev,
    params: nextParams,
    snapshot: meta.optimistic
  };
}

export function recordOfflineTodoSave(ctx, params, existing, notify) {
  const q = normalizeOfflineQueue(ctx.state.offlineQueue);
  const optimistic = buildOptimisticTodoSave(params, existing, 'todo');
  const todoId = optimistic.todo_id;
  const prep = prepareQueuedSaveParams(
    q, { entityType: 'todo', idKey: 'todo_id', entityId: todoId },
    params, existing
  );
  const activeMe = isSchedulableMeTodo(optimistic);
  const entry = buildTodoMutationEntry(ctx, todoId, prep.nextParams, {
    createdOffline: prep.createdOffline,
    baseRev: prep.baseRev,
    optimistic
  });
  ctx.state = {
    ...ctx.state,
    todos: replaceEntityItem(ctx.state.todos, 'todo_id', optimistic),
    offlineQueue: upsertMutation(q, entry, { dropReceipts: !activeMe })
  };
  notify(ctx);
  return optimistic;
}

export function recordOfflineTodoToggle(ctx, existing, notify) {
  if (!existing) {
    return null;
  }
  const flags = computeTodoToggleFlags(existing);
  const mergedParams = buildTodoSetParams({
    done: flags.nextDone,
    enabled: flags.nextEnabled,
    skip_next: flags.nextSkip
  }, existing, { timezone: ctx.timezone });
  return recordOfflineTodoSave(ctx, mergedParams, existing, notify);
}

function recordOfflineDelete(ctx, spec, entityId, notify) {
  const q = normalizeOfflineQueue(ctx.state.offlineQueue);
  const existing = ctx.state[spec.listKey].find(
    (item) => item[spec.idKey] === entityId
  );
  const prev = findQueuedMutation(q, spec.entityType, entityId);
  const baseRev = resolveBaseRev(prev, existing);
  const entry = prev?.createdOffline
    ? { entityType: spec.entityType, entityId, dropOnly: true }
    : {
      kind: 'rpc',
      method: spec.method,
      entityType: spec.entityType,
      entityId,
      serverBaseRevision: baseRev,
      params: { [spec.idKey]: entityId, base_revision: baseRev }
    };
  ctx.state = {
    ...ctx.state,
    [spec.listKey]: deleteByRevision(
      ctx.state[spec.listKey], spec.idKey, entityId, null
    ),
    offlineQueue: upsertMutation(q, entry, { dropReceipts: true })
  };
  notify(ctx);
}

export function recordOfflineEventDelete(ctx, eventId, notify) {
  recordOfflineDelete(ctx, {
    entityType: 'event',
    idKey: 'event_id',
    listKey: 'masterEvents',
    method: 'event.delete'
  }, eventId, notify);
}

export function recordOfflineTodoDelete(ctx, todoId, notify) {
  recordOfflineDelete(ctx, {
    entityType: 'todo',
    idKey: 'todo_id',
    listKey: 'todos',
    method: 'todo.delete'
  }, todoId, notify);
}
