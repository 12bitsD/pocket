import { CloudRpcError } from '../api/cloud-client.js';
import {
  buildEventSetParams,
  toMasterEvent
} from '../domain/calendar-model.js';
import {
  computeMonthFetchRange,
  localDateIso,
  pad2
} from '../domain/date-time.js';
import {
  buildOptimisticEventSave,
  buildOptimisticTodoSave,
  buildOptimisticTodoToggle
} from '../domain/local-mutations.js';
import { buildTodoSetParams } from '../domain/todo-model.js';
import { flushOfflineQueue } from './offline-flush.js';
import {
  isOfflineFallbackError,
  recordOfflineEventDelete,
  recordOfflineEventSave,
  recordOfflineTodoDelete,
  recordOfflineTodoSave,
  recordOfflineTodoToggle,
  shouldBypassRpcOffline
} from './offline-queue.js';
import {
  deleteByRevision,
  hasScope,
  mergeMasterEvents,
  mergeTodoList,
  upsertByRevision
} from './sync-reducer.js';

async function callWriteWithConflictSync(ctx, method, params) {
  try {
    return await ctx.client.callRpc(method, params);
  } catch (err) {
    if (err?.status === 409 && typeof ctx.resyncSnapshot === 'function') {
      await ctx.resyncSnapshot();
    }
    throw err;
  }
}

function scheduleFlushIfOnline(ctx, notify) {
  if (ctx.state.connectionStatus === 'online' && !ctx.flushingOffline) {
    flushOfflineQueue(ctx, notify);
  }
}

async function runCloudWriteWithOffline(ctx, spec, notify) {
  if (shouldBypassRpcOffline(ctx, spec.entityType, spec.entityId)) {
    const queuedVal = spec.onOffline();
    scheduleFlushIfOnline(ctx, notify);
    return { offline: true, value: queuedVal };
  }
  let result = null;
  let rpcErr = null;
  try {
    result = await callWriteWithConflictSync(ctx, spec.method, spec.params);
  } catch (err) {
    rpcErr = err;
  }
  if (!rpcErr) {
    return { offline: false, value: result };
  }
  if (isOfflineFallbackError(ctx, rpcErr)) {
    const queuedVal = spec.onOffline();
    scheduleFlushIfOnline(ctx, notify);
    return { offline: true, value: queuedVal };
  }
  throw rpcErr;
}

export async function saveEventAction(ctx, draft, notify) {
  const editId = draft.event_id || draft.id || null;
  const existing = editId
    ? ctx.state.masterEvents.find((e) => e.event_id === String(editId))
    : null;
  const params = buildEventSetParams(draft, existing);
  if (ctx.state.mode !== 'cloud') {
    const localEv = buildOptimisticEventSave(params, existing, {
      idPrefix: 'demo_ev'
    });
    ctx.state = {
      ...ctx.state,
      masterEvents: upsertByRevision(
        ctx.state.masterEvents, 'event_id', localEv
      )
    };
    notify(ctx);
    return localEv;
  }
  const outcome = await runCloudWriteWithOffline(ctx, {
    entityType: 'event',
    entityId: existing?.event_id || null,
    method: 'event.set',
    params,
    onOffline: () => recordOfflineEventSave(ctx, params, existing, notify)
  }, notify);
  if (outcome.offline) {
    return outcome.value;
  }
  ctx.state = {
    ...ctx.state,
    masterEvents: upsertByRevision(
      ctx.state.masterEvents, 'event_id', toMasterEvent(outcome.value)
    )
  };
  notify(ctx);
  return outcome.value;
}

export async function removeEventAction(ctx, eventId, notify) {
  const id = String(eventId);
  const existing = ctx.state.masterEvents.find((e) => e.event_id === id);
  if (ctx.state.mode === 'cloud') {
    const outcome = await runCloudWriteWithOffline(ctx, {
      entityType: 'event',
      entityId: id,
      method: 'event.delete',
      params: { event_id: id, base_revision: existing?.revision },
      onOffline: () => recordOfflineEventDelete(ctx, id, notify)
    }, notify);
    if (outcome.offline) {
      return;
    }
  }
  ctx.state = {
    ...ctx.state,
    masterEvents: deleteByRevision(ctx.state.masterEvents, 'event_id', id, null)
  };
  notify(ctx);
}

export async function saveTodoAction(ctx, draft, notify) {
  const editId = draft.todo_id || draft.id || null;
  const existing = editId
    ? ctx.state.todos.find((t) => t.todo_id === String(editId))
    : null;
  const params = buildTodoSetParams(draft, existing, {
    todayIso: localDateIso(0, ctx.clock()),
    timezone: ctx.timezone
  });
  if (ctx.state.mode !== 'cloud') {
    const localTd = buildOptimisticTodoSave(params, existing, 'demo_td');
    ctx.state = {
      ...ctx.state,
      todos: upsertByRevision(ctx.state.todos, 'todo_id', localTd)
    };
    notify(ctx);
    return localTd;
  }
  const outcome = await runCloudWriteWithOffline(ctx, {
    entityType: 'todo',
    entityId: existing?.todo_id || null,
    method: 'todo.set',
    params,
    onOffline: () => recordOfflineTodoSave(ctx, params, existing, notify)
  }, notify);
  if (outcome.offline) {
    return outcome.value;
  }
  ctx.state = {
    ...ctx.state,
    todos: upsertByRevision(ctx.state.todos, 'todo_id', outcome.value)
  };
  notify(ctx);
  return outcome.value;
}

export async function toggleTodoAction(ctx, todoId, notify) {
  const id = String(todoId);
  const existing = ctx.state.todos.find((t) => t.todo_id === id);
  if (ctx.state.mode !== 'cloud') {
    if (!existing) {
      return null;
    }
    const updated = buildOptimisticTodoToggle(existing);
    ctx.state = {
      ...ctx.state,
      todos: upsertByRevision(ctx.state.todos, 'todo_id', updated)
    };
    notify(ctx);
    return updated;
  }
  const outcome = await runCloudWriteWithOffline(ctx, {
    entityType: 'todo',
    entityId: id,
    method: 'todo.toggle',
    params: { todo_id: id, base_revision: existing?.revision },
    onOffline: () => recordOfflineTodoToggle(ctx, existing, notify)
  }, notify);
  if (outcome.offline) {
    return outcome.value;
  }
  ctx.state = {
    ...ctx.state,
    todos: upsertByRevision(ctx.state.todos, 'todo_id', outcome.value)
  };
  notify(ctx);
  return outcome.value;
}

export async function toggleSkipNextAction(ctx, todoId, notify) {
  const existing = ctx.state.todos.find((t) => t.todo_id === String(todoId));
  if (!existing) {
    return null;
  }
  return saveTodoAction(
    ctx,
    { todo_id: existing.todo_id, skip_next: !existing.skip_next },
    notify
  );
}

export async function removeTodoAction(ctx, todoId, notify) {
  const id = String(todoId);
  const existing = ctx.state.todos.find((t) => t.todo_id === id);
  if (ctx.state.mode === 'cloud') {
    const outcome = await runCloudWriteWithOffline(ctx, {
      entityType: 'todo',
      entityId: id,
      method: 'todo.delete',
      params: { todo_id: id, base_revision: existing?.revision },
      onOffline: () => recordOfflineTodoDelete(ctx, id, notify)
    }, notify);
    if (outcome.offline) {
      return;
    }
  }
  ctx.state = {
    ...ctx.state,
    todos: deleteByRevision(ctx.state.todos, 'todo_id', id, null)
  };
  notify(ctx);
}

export async function triggerAgentTodoAction(ctx, todoId, notify) {
  if (ctx.state.mode !== 'cloud') {
    throw new CloudRpcError(400, 'DEMO_MODE', 'Connect Pocket Cloud first');
  }
  const id = String(todoId);
  const result = await ctx.client.callRpc('todo.trigger', { todo_id: id });
  const tdRes = await ctx.client.callRpc('todo.list', {});
  ctx.state = {
    ...ctx.state,
    todos: mergeTodoList(ctx.state.todos, tdRes.todos)
  };
  notify(ctx);
  return result;
}

function resolveMonthSelectedDate(ctx, year, month, explicitDate) {
  if (explicitDate) {
    return explicitDate;
  }
  const prefix = `${year}-${pad2(month + 1)}-`;
  if (String(ctx.state.selectedDate || '').startsWith(prefix)) {
    return ctx.state.selectedDate;
  }
  const todayIso = localDateIso(0, ctx.clock());
  if (todayIso.startsWith(prefix)) {
    return todayIso;
  }
  return `${prefix}01`;
}

export async function refreshMonthRangeAction(ctx, monthSpec, notify) {
  const targetYear = monthSpec.year;
  const targetMonth = monthSpec.month;
  const selectedDate = resolveMonthSelectedDate(
    ctx, targetYear, targetMonth, monthSpec.selectedDate
  );
  ctx.state = {
    ...ctx.state,
    selectedDate,
    viewYear: targetYear,
    viewMonth: targetMonth
  };
  notify(ctx);
  const canRead = ctx.state.mode === 'cloud' &&
    hasScope(ctx.state.identity, 'event.read');
  if (!canRead || shouldBypassRpcOffline(ctx, 'event', null)) {
    return;
  }
  const epoch = ctx.sessionEpoch;
  const range = computeMonthFetchRange(targetYear, targetMonth);
  const res = await ctx.client.callRpc('event.list', {
    start_date: range.startDate,
    end_date: range.endDate
  });
  if (ctx.sessionEpoch !== epoch || ctx.state.mode !== 'cloud') {
    return;
  }
  ctx.state = {
    ...ctx.state,
    masterEvents: mergeMasterEvents(ctx.state.masterEvents, res.events || [])
  };
  notify(ctx);
}
