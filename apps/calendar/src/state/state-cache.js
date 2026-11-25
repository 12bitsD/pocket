import { expandMasterEvents } from '../domain/calendar-model.js';
import {
  computeMonthFetchRange,
  localDateIso
} from '../domain/date-time.js';
import {
  deriveAgentGrants,
  summarizeTodos
} from '../domain/todo-model.js';
import {
  hasScope,
  resolveLocalDeviceFlag,
  savePersistedState
} from './sync-reducer.js';

export function createSelectorCache() {
  return {
    todayMasterRef: null,
    todayIso: '',
    todayEvents: [],
    monthMasterRef: null,
    monthStart: '',
    monthEnd: '',
    monthEvents: [],
    todosRef: null,
    todoSummary: null,
    agentsRef: null,
    tokensRef: null,
    agentGrants: [],
    stateRef: null,
    publicTodayIso: '',
    publicNative: null,
    publicSnapshot: null
  };
}

function selectTodayEvents(cache, masterEvents, todayIso) {
  if (cache.todayMasterRef !== masterEvents || cache.todayIso !== todayIso) {
    cache.todayMasterRef = masterEvents;
    cache.todayIso = todayIso;
    cache.todayEvents = expandMasterEvents(masterEvents, todayIso, todayIso);
  }
  return cache.todayEvents;
}

function selectMonthEvents(cache, masterEvents, range) {
  const sameRange = cache.monthStart === range.startDate &&
    cache.monthEnd === range.endDate;
  if (cache.monthMasterRef !== masterEvents || !sameRange) {
    cache.monthMasterRef = masterEvents;
    cache.monthStart = range.startDate;
    cache.monthEnd = range.endDate;
    cache.monthEvents = expandMasterEvents(
      masterEvents, range.startDate, range.endDate
    );
  }
  return cache.monthEvents;
}

function selectTodoAndAgentDerived(cache, st) {
  if (cache.todosRef !== st.todos || !cache.todoSummary) {
    cache.todosRef = st.todos;
    cache.todoSummary = summarizeTodos(st.todos);
  }
  if (cache.agentsRef !== st.agents || cache.tokensRef !== st.tokens) {
    cache.agentsRef = st.agents;
    cache.tokensRef = st.tokens;
    cache.agentGrants = deriveAgentGrants(st.agents, st.tokens);
  }
}

export function selectPublicState(ctx) {
  const st = ctx.state;
  const cache = ctx.selectorCache;
  const todayIso = localDateIso(0, ctx.clock());
  const hit = cache.publicSnapshot &&
    cache.stateRef === st &&
    cache.publicTodayIso === todayIso &&
    cache.publicNative === ctx.isNative;
  if (hit) {
    return cache.publicSnapshot;
  }
  const monthRange = computeMonthFetchRange(st.viewYear, st.viewMonth);
  selectTodoAndAgentDerived(cache, st);
  const snapshot = {
    ...st,
    todayIso,
    isNativeAndroid: ctx.isNative,
    isLocalDevice: resolveLocalDeviceFlag(st, ctx.isNative),
    canAdmin: st.mode !== 'cloud' || hasScope(st.identity, '*'),
    todoSummary: cache.todoSummary,
    todayEvents: selectTodayEvents(cache, st.masterEvents, todayIso),
    monthEvents: selectMonthEvents(cache, st.masterEvents, monthRange),
    agentGrants: cache.agentGrants
  };
  cache.stateRef = st;
  cache.publicTodayIso = todayIso;
  cache.publicNative = ctx.isNative;
  cache.publicSnapshot = snapshot;
  return snapshot;
}

const DURABLE_KEYS = Object.freeze([
  'mode',
  'baseUrl',
  'token',
  'identity',
  'lastSeq',
  'theme',
  'masterEvents',
  'todos',
  'agents',
  'tokens',
  'offlineQueue'
]);

function matchesDurableRefs(prevRefs, state) {
  if (!prevRefs) {
    return false;
  }
  for (const key of DURABLE_KEYS) {
    if (prevRefs[key] !== state[key]) {
      return false;
    }
  }
  return true;
}

function captureDurableRefs(state) {
  const refs = {};
  for (const key of DURABLE_KEYS) {
    refs[key] = state[key];
  }
  return refs;
}

export function createPersistenceScheduler(storage, initialState) {
  const sched = {
    storage,
    lastRefs: initialState ? captureDurableRefs(initialState) : null,
    pendingState: null,
    scheduled: false,
    disposed: false
  };
  const flushNow = () => {
    if (!sched.storage || !sched.pendingState) {
      sched.scheduled = false;
      return false;
    }
    const target = sched.pendingState;
    sched.pendingState = null;
    sched.scheduled = false;
    if (matchesDurableRefs(sched.lastRefs, target)) {
      return false;
    }
    const ok = savePersistedState(sched.storage, target);
    if (ok) {
      sched.lastRefs = captureDurableRefs(target);
    }
    return ok;
  };
  const schedule = (state) => {
    if (!sched.storage || sched.disposed ||
        matchesDurableRefs(sched.lastRefs, state)) {
      return;
    }
    sched.pendingState = state;
    if (!sched.scheduled) {
      sched.scheduled = true;
      queueMicrotask(flushNow);
    }
  };
  return {
    schedule,
    flushNow,
    dispose: () => {
      flushNow();
      sched.disposed = true;
    }
  };
}

export function bindRuntimePowerListeners(onPower, onFlush) {
  const cleanups = [];
  if (typeof document !== 'undefined' && document.addEventListener) {
    const onVis = () => {
      const hidden = document.visibilityState === 'hidden';
      if (hidden) {
        onFlush();
      }
      onPower({ hidden });
    };
    document.addEventListener('visibilitychange', onVis);
    cleanups.push(
      () => document.removeEventListener('visibilitychange', onVis)
    );
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    const onOffline = () => onPower({ offline: true });
    const onOnline = () => onPower({ offline: false });
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onFlush);
    cleanups.push(() => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onFlush);
    });
  }
  return () => {
    for (const fn of cleanups) {
      fn();
    }
  };
}
