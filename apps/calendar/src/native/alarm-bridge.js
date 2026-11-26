import { Capacitor, registerPlugin } from '@capacitor/core';

import {
  isAlarmEvent,
  isSchedulableMeTodo
} from '../domain/local-mutations.js';
import {
  formatTodoWhenLabel,
  isRecurringTodo
} from '../domain/todo-model.js';

function isCapacitorAndroidRuntime() {
  if (typeof Capacitor === 'undefined') {
    return false;
  }
  const isNative = Boolean(Capacitor.isNativePlatform?.());
  return isNative && Capacitor.getPlatform?.() === 'android';
}

export function detectNativeAndroid(options) {
  if (options?.nativeAlarmPlugin || options?.isNativeAndroid) {
    return true;
  }
  return isCapacitorAndroidRuntime();
}

function resolveAlarmPlugin(options) {
  if (options?.nativeAlarmPlugin) {
    return options.nativeAlarmPlugin;
  }
  if (isCapacitorAndroidRuntime()) {
    return registerPlugin('PocketAlarm');
  }
  return null;
}

function normalizePermissions(raw) {
  return {
    exactAlarm: Boolean(raw?.exactAlarm),
    notifications: Boolean(raw?.notifications),
    fullScreenIntent: Boolean(raw?.fullScreenIntent),
    batteryOptimization: Boolean(raw?.batteryOptimization)
  };
}

function mapTodoToNativeAlarm(todo, todayIso, defaultTz) {
  const when = formatTodoWhenLabel(todo, todayIso);
  return {
    alarmKey: `todo:${todo.todo_id}`,
    entityType: 'todo',
    entityId: String(todo.todo_id),
    title: String(todo.text || 'Pocket 闹钟'),
    subtitle: `${when} ${todo.time_hhmm}`,
    scheduleKind: todo.schedule_kind,
    timeHhmm: todo.time_hhmm,
    onceDate: todo.once_date || null,
    weeklyDow: todo.weekly_dow ?? null,
    repeatRule: null,
    eventDate: null,
    startHhmm: null,
    reminderOffsetMinutes: 0,
    timezone: todo.timezone || defaultTz,
    skipNext: Boolean(todo.skip_next),
    enabled: true
  };
}

function mapEventToNativeAlarm(ev, defaultTz) {
  return {
    alarmKey: `event:${ev.event_id}`,
    entityType: 'event',
    entityId: String(ev.event_id),
    title: String(ev.title || '日程强提醒'),
    subtitle: `${ev.event_date} ${ev.start_hhmm}`,
    scheduleKind: null,
    timeHhmm: null,
    onceDate: null,
    weeklyDow: null,
    repeatRule: ev.repeat_rule || 'none',
    eventDate: ev.event_date,
    startHhmm: ev.start_hhmm,
    reminderOffsetMinutes: Number(ev.reminder_offset_minutes ?? 15),
    timezone: defaultTz,
    skipNext: false,
    enabled: true
  };
}

export function buildDesiredNativeAlarms(state, defaultTz) {
  const todos = (state.todos || [])
    .filter(isSchedulableMeTodo)
    .map((td) => mapTodoToNativeAlarm(td, state.todayIso, defaultTz));
  const events = (state.masterEvents || [])
    .filter(isAlarmEvent)
    .map((ev) => mapEventToNativeAlarm(ev, defaultTz));
  return [...todos, ...events].sort(
    (a, b) => a.alarmKey.localeCompare(b.alarmKey)
  );
}

function hasPendingQueuedStatus(state) {
  const todoQueued = (state.todos || []).some(
    (t) => isSchedulableMeTodo(t) && t.alarm_status === 'QUEUED'
  );
  if (todoQueued) {
    return true;
  }
  return (state.masterEvents || []).some(
    (e) => isAlarmEvent(e) && e.alarm_status === 'QUEUED'
  );
}

function lookupAlarmStatus(state, entityType, entityId) {
  if (entityType === 'todo') {
    const td = state.todos.find((t) => t.todo_id === entityId);
    return isSchedulableMeTodo(td) ? (td.alarm_status || 'QUEUED') : null;
  }
  const ev = state.masterEvents.find((e) => e.event_id === entityId);
  return isAlarmEvent(ev) ? (ev.alarm_status || 'QUEUED') : null;
}

function shouldReportArmTransition(cur, next) {
  const validNext = next === 'EXECUTED' || next === 'FAILED';
  if (!cur || !validNext) {
    return false;
  }
  if (cur === 'QUEUED') {
    return true;
  }
  return cur !== next && (cur === 'FAILED' || next === 'FAILED');
}

async function applyArmResults(rt, results) {
  for (const item of results || []) {
    const entityType = item.entityType || item.entity_type;
    const entityId = String(item.entityId || item.entity_id || '');
    const status = item.status;
    const cur = lookupAlarmStatus(rt.storeApi.getState(), entityType, entityId);
    if (shouldReportArmTransition(cur, status)) {
      await rt.storeApi
        .sendAlarmReceipt({ entityType, entityId, status })
        .catch((err) => {
          rt.ctx.lastBridgeError = err;
        });
    }
  }
}

function normalizeDrainedEvent(ev) {
  return {
    entityType: ev.entityType || ev.entity_type,
    entityId: String(ev.entityId || ev.entity_id || ''),
    kind: ev.eventKind || ev.event_kind
  };
}

async function applyTodoRingingEvent(storeApi, ev) {
  const td = storeApi.getState().todos.find((t) => t.todo_id === ev.entityId);
  if (!td) {
    return;
  }
  if (ev.kind === 'DISMISSED' && !isRecurringTodo(td) && !td.done) {
    await storeApi.toggleTodo(ev.entityId);
    return;
  }
  if (ev.kind === 'SKIP_CONSUMED' && td.skip_next) {
    await storeApi.saveTodo({ todo_id: ev.entityId, skip_next: false });
  }
}

async function applyDrainedEvent(storeApi, rawEv) {
  const ev = normalizeDrainedEvent(rawEv);
  if (ev.entityType === 'todo' && ev.kind !== 'MISSED') {
    await applyTodoRingingEvent(storeApi, ev);
    return;
  }
  if (ev.kind === 'MISSED' &&
      lookupAlarmStatus(storeApi.getState(), ev.entityType, ev.entityId)) {
    await storeApi.sendAlarmReceipt({
      entityType: ev.entityType,
      entityId: ev.entityId,
      status: 'MISSED'
    });
  }
}

function bindResumeListeners(onResume) {
  const cleanups = [];
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', onResume);
    cleanups.push(() => window.removeEventListener('focus', onResume));
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    const onVis = () => {
      if (document.visibilityState !== 'hidden') {
        onResume();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    cleanups.push(
      () => document.removeEventListener('visibilitychange', onVis)
    );
  }
  return () => {
    for (const fn of cleanups) {
      fn();
    }
  };
}

async function executePermissionRefresh(rt) {
  if (rt.disposed || typeof rt.plugin.checkPermissions !== 'function') {
    return rt.ctx.state.nativePermissions;
  }
  const raw = await rt.plugin.checkPermissions();
  if (!rt.disposed) {
    const perms = normalizePermissions(raw);
    rt.ctx.state = { ...rt.ctx.state, nativePermissions: perms };
    rt.ctx.notify();
  }
  return rt.ctx.state.nativePermissions;
}

async function executeRingingDrain(rt) {
  if (rt.disposed || typeof rt.plugin.drainRingingEvents !== 'function') {
    return [];
  }
  const res = await rt.plugin.drainRingingEvents();
  const events = res?.events || [];
  for (const item of events) {
    if (!rt.disposed) {
      await applyDrainedEvent(rt.storeApi, item);
    }
  }
  return events;
}

async function executeAlarmSync(rt) {
  if (rt.disposed || typeof rt.plugin.syncAlarms !== 'function') {
    return;
  }
  const snap = rt.storeApi.getState();
  const alarms = buildDesiredNativeAlarms(snap, rt.ctx.timezone);
  const nextHash = JSON.stringify(alarms);
  if (nextHash === rt.lastSpecHash && !hasPendingQueuedStatus(snap)) {
    return;
  }
  rt.lastSpecHash = nextHash;
  const res = await rt.plugin.syncAlarms({ alarms });
  if (!rt.disposed) {
    await applyArmResults(rt, res?.results);
  }
}

function recordBridgeError(rt) {
  return (err) => {
    rt.ctx.lastBridgeError = err;
  };
}

function createBridgeRuntime(ctx, storeApi, plugin) {
  const rt = {
    ctx,
    storeApi,
    plugin,
    disposed: false,
    syncScheduled: false,
    lastSpecHash: '',
    chain: Promise.resolve()
  };
  const onErr = recordBridgeError(rt);
  const enqueue = (fn) => {
    rt.chain = rt.chain.then(fn, fn);
    return rt.chain;
  };
  const scheduleSync = () => {
    if (rt.disposed || rt.syncScheduled) {
      return;
    }
    rt.syncScheduled = true;
    queueMicrotask(() => {
      rt.syncScheduled = false;
      enqueue(() => executeAlarmSync(rt)).catch(onErr);
    });
  };
  return {
    rt,
    onErr,
    scheduleSync,
    refreshPermissions: () => enqueue(() => executePermissionRefresh(rt)),
    drainRingingEvents: () => enqueue(() => executeRingingDrain(rt))
  };
}

export function attachNativeAlarmBridge(ctx, storeApi, options) {
  const plugin = resolveAlarmPlugin(options);
  if (!plugin) {
    return Object.freeze({
      refreshPermissions: async () => null,
      openPermission: async () => null,
      drainRingingEvents: async () => [],
      destroy: () => {}
    });
  }
  const ctrl = createBridgeRuntime(ctx, storeApi, plugin);
  const unsubStore = storeApi.subscribe(ctrl.scheduleSync);
  const runResumePass = () => {
    ctrl.refreshPermissions().catch(ctrl.onErr);
    ctrl.drainRingingEvents().then(ctrl.scheduleSync).catch(ctrl.onErr);
  };
  const unbindResume = bindResumeListeners(runResumePass);
  runResumePass();

  return Object.freeze({
    refreshPermissions: ctrl.refreshPermissions,
    openPermission: async (target) => {
      if (ctrl.rt.disposed ||
          typeof plugin.openPermissionSettings !== 'function') {
        return null;
      }
      return plugin.openPermissionSettings({ target });
    },
    drainRingingEvents: ctrl.drainRingingEvents,
    destroy: () => {
      ctrl.rt.disposed = true;
      unsubStore();
      unbindResume();
    }
  });
}
