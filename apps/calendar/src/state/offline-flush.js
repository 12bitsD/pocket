import { toMasterEvent } from '../domain/calendar-model.js';
import {
  isAlarmEvent,
  isSchedulableMeTodo
} from '../domain/local-mutations.js';
import {
  canUseOfflineQueue,
  dropEntityReceipts,
  findQueuedMutation,
  hasPendingOfflineItems,
  isOfflineFallbackError,
  normalizeOfflineQueue,
  replaceEntityItem
} from './offline-queue.js';
import {
  deleteByRevision,
  upsertByRevision
} from './sync-reducer.js';

const BENIGN_RECEIPT_CODES = Object.freeze([
  'NOT_ALARM_ENTITY',
  'NOT_FOUND',
  'TODO_NOT_FOUND',
  'EVENT_NOT_FOUND'
]);

export function isReceiptEligibleInState(state, entityType, entityId) {
  if (entityType === 'todo') {
    const td = state.todos.find((item) => item.todo_id === entityId);
    return isSchedulableMeTodo(td);
  }
  if (entityType === 'event') {
    const ev = state.masterEvents.find((item) => item.event_id === entityId);
    return isAlarmEvent(ev);
  }
  return false;
}

function applyLocalAlarmStatus(state, entityType, entityId, status) {
  if (entityType === 'todo') {
    const idx = state.todos.findIndex((t) => t.todo_id === entityId);
    if (idx === -1 || state.todos[idx].alarm_status === status) {
      return state;
    }
    const todos = [...state.todos];
    todos[idx] = { ...todos[idx], alarm_status: status };
    return { ...state, todos };
  }
  const idx = state.masterEvents.findIndex((e) => e.event_id === entityId);
  if (idx === -1 || state.masterEvents[idx].alarm_status === status) {
    return state;
  }
  const masterEvents = [...state.masterEvents];
  masterEvents[idx] = { ...masterEvents[idx], alarm_status: status };
  return { ...state, masterEvents };
}

function enqueueAlarmReceipt(ctx, rec, notify) {
  const q = normalizeOfflineQueue(ctx.state.offlineQueue);
  const filtered = dropEntityReceipts(q.receipts, rec.entityType, rec.entityId);
  filtered.push(rec);
  ctx.state = {
    ...applyLocalAlarmStatus(
      ctx.state, rec.entityType, rec.entityId, rec.status
    ),
    offlineQueue: { mutations: q.mutations, receipts: filtered }
  };
  notify(ctx);
  if (ctx.state.connectionStatus === 'online' && !ctx.flushingOffline) {
    flushOfflineQueue(ctx, notify);
  }
  return {
    type: 'QUEUED_OFFLINE',
    entity_type: rec.entityType,
    entity_id: rec.entityId,
    status: rec.status
  };
}

function shouldHoldReceiptInQueue(ctx, rec) {
  const hasMut = Boolean(
    findQueuedMutation(ctx.state.offlineQueue, rec.entityType, rec.entityId)
  );
  if (hasMut || ctx.flushingOffline) {
    return true;
  }
  return !ctx.client.isConnected() || ctx.state.connectionStatus !== 'online';
}

function normalizeReceiptInput(rawRec) {
  return {
    entityType: rawRec.entityType || rawRec.entity_type,
    entityId: String(rawRec.entityId || rawRec.entity_id || ''),
    status: rawRec.status
  };
}

function sendRawReceiptFrame(ctx, rec) {
  return ctx.client.sendWsFrame({
    type: 'ALARM_RECEIPT',
    entity_type: rec.entityType,
    entity_id: rec.entityId,
    status: rec.status
  });
}

async function sendLiveReceiptOrFallback(ctx, rec, notify) {
  let ack = null;
  let sendErr = null;
  try {
    ack = await sendRawReceiptFrame(ctx, rec);
  } catch (err) {
    sendErr = err;
  }
  if (!sendErr) {
    return ack;
  }
  if (isOfflineFallbackError(ctx, sendErr)) {
    return enqueueAlarmReceipt(ctx, rec, notify);
  }
  if (BENIGN_RECEIPT_CODES.includes(sendErr.code)) {
    return { type: 'SKIPPED_STALE', code: sendErr.code };
  }
  throw sendErr;
}

export async function dispatchOrQueueAlarmReceipt(ctx, rawRec, notify) {
  const rec = normalizeReceiptInput(rawRec);
  const eligible = isReceiptEligibleInState(
    ctx.state, rec.entityType, rec.entityId
  );
  if (!eligible) {
    return { type: 'SKIPPED_INACTIVE', status: rec.status };
  }
  const prevState = ctx.state;
  ctx.state = applyLocalAlarmStatus(
    ctx.state, rec.entityType, rec.entityId, rec.status
  );
  if (ctx.state !== prevState) {
    notify(ctx);
  }
  if (ctx.state.mode !== 'cloud') {
    return { type: 'LOCAL_RECEIPT', status: rec.status };
  }
  if (shouldHoldReceiptInQueue(ctx, rec) && canUseOfflineQueue(ctx)) {
    return enqueueAlarmReceipt(ctx, rec, notify);
  }
  return sendLiveReceiptOrFallback(ctx, rec, notify);
}

export function reapplyOfflineOverlay(state) {
  const q = normalizeOfflineQueue(state.offlineQueue);
  if (!hasPendingOfflineItems(q)) {
    return state;
  }
  let masterEvents = [...state.masterEvents];
  let todos = [...state.todos];
  for (const mut of q.mutations) {
    if (mut.entityType === 'event') {
      masterEvents = mut.method === 'event.delete'
        ? deleteByRevision(masterEvents, 'event_id', mut.entityId, null)
        : replaceEntityItem(masterEvents, 'event_id', mut.snapshot);
    } else if (mut.entityType === 'todo') {
      todos = mut.method === 'todo.delete'
        ? deleteByRevision(todos, 'todo_id', mut.entityId, null)
        : replaceEntityItem(todos, 'todo_id', mut.snapshot);
    }
  }
  let overlaid = { ...state, masterEvents, todos };
  for (const rec of q.receipts) {
    if (isReceiptEligibleInState(overlaid, rec.entityType, rec.entityId)) {
      overlaid = applyLocalAlarmStatus(
        overlaid, rec.entityType, rec.entityId, rec.status
      );
    }
  }
  return overlaid;
}

function dropQueueEntry(ctx, kind, targetItem) {
  const q = normalizeOfflineQueue(ctx.state.offlineQueue);
  ctx.state = {
    ...ctx.state,
    offlineQueue: {
      mutations: kind === 'mutation'
        ? q.mutations.filter((m) => m !== targetItem)
        : q.mutations,
      receipts: kind === 'receipt'
        ? q.receipts.filter((r) => r !== targetItem)
        : q.receipts
    }
  };
}

function applyRpcFlushResult(ctx, item, res) {
  if (!res) {
    return;
  }
  if (item.method === 'event.set') {
    ctx.state = {
      ...ctx.state,
      masterEvents: upsertByRevision(
        ctx.state.masterEvents, 'event_id', toMasterEvent(res)
      )
    };
  } else if (item.method === 'todo.set' || item.method === 'todo.toggle') {
    ctx.state = {
      ...ctx.state,
      todos: upsertByRevision(ctx.state.todos, 'todo_id', res)
    };
  }
}

async function flushNextMutation(ctx, item, stats) {
  let res = null;
  let flushErr = null;
  try {
    res = item.kind === 'lock_override'
      ? await ctx.client.sendWsFrame({ type: 'LOCK_OVERRIDE', todo: item.todo })
      : await ctx.client.callRpc(item.method, item.params);
  } catch (err) {
    flushErr = err;
  }
  if (flushErr && isOfflineFallbackError(ctx, flushErr)) {
    return false;
  }
  if (!flushErr && item.kind === 'rpc') {
    applyRpcFlushResult(ctx, item, res);
  } else if (flushErr) {
    stats.hadConflictOrMissing = true;
  }
  dropQueueEntry(ctx, 'mutation', item);
  return true;
}

async function flushNextReceipt(ctx, rec) {
  if (!isReceiptEligibleInState(ctx.state, rec.entityType, rec.entityId)) {
    dropQueueEntry(ctx, 'receipt', rec);
    return true;
  }
  let sendErr = null;
  try {
    await sendRawReceiptFrame(ctx, rec);
  } catch (err) {
    sendErr = err;
  }
  if (sendErr && isOfflineFallbackError(ctx, sendErr)) {
    return false;
  }
  dropQueueEntry(ctx, 'receipt', rec);
  if (!sendErr) {
    ctx.state = applyLocalAlarmStatus(
      ctx.state, rec.entityType, rec.entityId, rec.status
    );
  }
  return true;
}

async function drainOfflineQueueItems(ctx, stats) {
  while (hasPendingOfflineItems(ctx.state.offlineQueue)) {
    if (ctx.state.mode !== 'cloud' || ctx.state.connectionStatus !== 'online') {
      return;
    }
    const q = normalizeOfflineQueue(ctx.state.offlineQueue);
    const nextLock = q.mutations.find((m) => m.kind === 'lock_override');
    const nextMut = nextLock || q.mutations[0] || null;
    const ok = nextMut
      ? await flushNextMutation(ctx, nextMut, stats)
      : await flushNextReceipt(ctx, q.receipts[0]);
    if (!ok) {
      return;
    }
  }
}

export function flushOfflineQueue(ctx, notify) {
  if (!hasPendingOfflineItems(ctx.state.offlineQueue) ||
      ctx.state.mode !== 'cloud') {
    return Promise.resolve();
  }
  const runFlush = async () => {
    if (ctx.state.mode !== 'cloud' || ctx.state.connectionStatus !== 'online') {
      return;
    }
    const stats = { hadConflictOrMissing: false };
    ctx.flushingOffline = true;
    try {
      await drainOfflineQueueItems(ctx, stats);
    } finally {
      ctx.flushingOffline = false;
      ctx.state = reapplyOfflineOverlay(ctx.state);
      notify(ctx);
    }
    const shouldResync = stats.hadConflictOrMissing &&
      typeof ctx.resyncSnapshot === 'function';
    if (shouldResync) {
      await ctx.resyncSnapshot();
    }
  };
  ctx.flushChain = (ctx.flushChain || Promise.resolve()).then(
    runFlush, runFlush
  );
  return ctx.flushChain;
}
