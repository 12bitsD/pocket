import { toMasterEvent } from './calendar-model.js';
import { isRecurringTodo } from './todo-model.js';

export function makeClientEntityId(prefix) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(
    bytes, (b) => b.toString(16).padStart(2, '0')
  ).join('');
  return `${prefix}_${hex}`;
}

export function isSchedulableMeTodo(todo) {
  if (!todo || todo.assignee !== '@me' || todo.done || !todo.enabled) {
    return false;
  }
  return Boolean(todo.schedule_kind && todo.time_hhmm);
}

export function isAlarmEvent(ev) {
  if (!ev || ev.reminder_policy !== 'alarm') {
    return false;
  }
  return Boolean(ev.event_date && ev.start_hhmm);
}

export function computeTodoToggleFlags(existing) {
  const recurring = isRecurringTodo(existing);
  if (recurring) {
    const nextEnabled = !existing.enabled;
    return {
      nextDone: Boolean(existing.done),
      nextEnabled,
      nextSkip: nextEnabled ? Boolean(existing.skip_next) : false
    };
  }
  const nextDone = !existing.done;
  const nextEnabled = nextDone && existing.schedule_kind === 'once'
    ? false
    : true;
  return {
    nextDone,
    nextEnabled,
    nextSkip: false
  };
}

export function buildOptimisticEventSave(params, existing, options) {
  const prefix = options?.idPrefix || 'ev';
  const source = options?.source || existing?.source || 'local';
  const eventId = existing?.event_id || params.event_id ||
    makeClientEntityId(prefix);
  const isAlarm = params.reminder_policy === 'alarm';
  return toMasterEvent({
    ...params,
    event_id: eventId,
    alarm_status: isAlarm ? 'QUEUED' : 'NONE',
    revision: (existing?.revision || 0) + 1,
    source
  });
}

export function buildOptimisticTodoSave(params, existing, idPrefix) {
  const todoId = existing?.todo_id || params.todo_id ||
    makeClientEntityId(idPrefix || 'todo');
  const merged = {
    ...existing,
    ...params,
    todo_id: todoId
  };
  return {
    ...merged,
    alarm_status: isSchedulableMeTodo(merged) ? 'QUEUED' : 'NONE',
    revision: (existing?.revision || 0) + 1
  };
}

export function buildOptimisticTodoToggle(existing) {
  const flags = computeTodoToggleFlags(existing);
  const merged = {
    ...existing,
    done: flags.nextDone,
    enabled: flags.nextEnabled,
    skip_next: flags.nextSkip
  };
  return {
    ...merged,
    alarm_status: isSchedulableMeTodo(merged) ? 'QUEUED' : 'NONE',
    revision: (existing.revision || 0) + 1
  };
}
