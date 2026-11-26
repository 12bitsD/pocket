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

const ENTITY_SPECS = Object.freeze({
  event: Object.freeze({
    listKey: 'masterEvents',
    idKey: 'event_id',
    deleteMethod: 'event.delete',
    recordOfflineDelete: recordOfflineEventDelete
  }),
  todo: Object.freeze({
    listKey: 'todos',
    idKey: 'todo_id',
    deleteMethod: 'todo.delete',
    recordOfflineDelete: recordOfflineTodoDelete
  })
});

function commitUpsert(ctx, kind, item) {
  const { listKey, idKey } = ENTITY_SPECS[kind];
  ctx.state = {
    ...ctx.state,
    [listKey]: upsertByRevision(ctx.state[listKey], idKey, item)
  };
  ctx.notify();
  return item;
}

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

function runOfflinePath(ctx, spec) {
  const queuedVal = spec.onOffline();
  if (ctx.state.connectionStatus === 'online' && !ctx.flushingOffline) {
    flushOfflineQueue(ctx);
  }
  return { offline: true, value: queuedVal };
}

async function runCloudWriteWithOffline(ctx, spec) {
  if (shouldBypassRpcOffline(ctx, spec.entityType, spec.entityId)) {
    return runOfflinePath(ctx, spec);
  }
  try {
    const value = await callWriteWithConflictSync(
      ctx, spec.method, spec.params
    );
    return { offline: false, value };
  } catch (err) {
    if (isOfflineFallbackError(ctx, err)) {
      return runOfflinePath(ctx, spec);
    }
    throw err;
  }
}

async function removeEntityAction(ctx, kind, rawId) {
  const spec = ENTITY_SPECS[kind];
  const id = String(rawId);
  const existing = ctx.state[spec.listKey].find(
    (item) => item[spec.idKey] === id
  );
  if (ctx.state.mode === 'cloud') {
    const out = await runCloudWriteWithOffline(ctx, {
      entityType: kind,
      entityId: id,
      method: spec.deleteMethod,
      params: { [spec.idKey]: id, base_revision: existing?.revision },
      onOffline: () => spec.recordOfflineDelete(ctx, id)
    });
    if (out.offline) {
      return;
    }
  }
  ctx.state = {
    ...ctx.state,
    [spec.listKey]: deleteByRevision(
      ctx.state[spec.listKey], spec.idKey, id, null
    )
  };
  ctx.notify();
}

export async function saveEventAction(ctx, draft) {
  const editId = draft.event_id || draft.id || null;
  const existing = editId
    ? ctx.state.masterEvents.find((e) => e.event_id === String(editId))
    : null;
  const params = buildEventSetParams(draft, existing);
  if (ctx.state.mode !== 'cloud') {
    const localEv = buildOptimisticEventSave(params, existing, {
      idPrefix: 'demo_ev'
    });
    return commitUpsert(ctx, 'event', localEv);
  }
  const out = await runCloudWriteWithOffline(ctx, {
    entityType: 'event',
    entityId: existing?.event_id || null,
    method: 'event.set',
    params,
    onOffline: () => recordOfflineEventSave(ctx, params, existing)
  });
  if (out.offline) {
    return out.value;
  }
  commitUpsert(ctx, 'event', toMasterEvent(out.value));
  return out.value;
}

export function removeEventAction(ctx, eventId) {
  return removeEntityAction(ctx, 'event', eventId);
}

export async function saveTodoAction(ctx, draft) {
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
    return commitUpsert(ctx, 'todo', localTd);
  }
  const out = await runCloudWriteWithOffline(ctx, {
    entityType: 'todo',
    entityId: existing?.todo_id || null,
    method: 'todo.set',
    params,
    onOffline: () => recordOfflineTodoSave(ctx, params, existing)
  });
  if (out.offline) {
    return out.value;
  }
  return commitUpsert(ctx, 'todo', out.value);
}

export async function toggleTodoAction(ctx, todoId) {
  const id = String(todoId);
  const existing = ctx.state.todos.find((t) => t.todo_id === id);
  if (ctx.state.mode !== 'cloud') {
    if (!existing) {
      return null;
    }
    return commitUpsert(ctx, 'todo', buildOptimisticTodoToggle(existing));
  }
  const out = await runCloudWriteWithOffline(ctx, {
    entityType: 'todo',
    entityId: id,
    method: 'todo.toggle',
    params: { todo_id: id, base_revision: existing?.revision },
    onOffline: () => recordOfflineTodoToggle(ctx, existing)
  });
  if (out.offline) {
    return out.value;
  }
  return commitUpsert(ctx, 'todo', out.value);
}

export async function toggleSkipNextAction(ctx, todoId) {
  const existing = ctx.state.todos.find((t) => t.todo_id === String(todoId));
  if (!existing) {
    return null;
  }
  return saveTodoAction(ctx, {
    todo_id: existing.todo_id,
    skip_next: !existing.skip_next
  });
}

export function removeTodoAction(ctx, todoId) {
  return removeEntityAction(ctx, 'todo', todoId);
}

export async function triggerAgentTodoAction(ctx, todoId) {
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
  ctx.notify();
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

export async function refreshMonthRangeAction(ctx, monthSpec) {
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
  ctx.notify();
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
  ctx.notify();
}
