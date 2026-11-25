import {
  extractMasterEvents,
  toMasterEvent
} from '../domain/calendar-model.js';

const STORAGE_KEY = 'pocket.calendar.state.v4';
const VALID_PAGES = Object.freeze(['agenda', 'month', 'todo', 'settings']);

export function hasScope(identity, required) {
  const scopes = identity?.scopes || [];
  return scopes.includes('*') || scopes.includes(required);
}

export function resolveLocalDeviceFlag(state, isNative) {
  return (
    Boolean(isNative) ||
    state.mode !== 'cloud' ||
    state.identity?.source === 'local'
  );
}

export function upsertByRevision(list, idKey, incoming) {
  const id = incoming[idKey];
  const idx = list.findIndex((item) => item[idKey] === id);
  if (idx === -1) {
    return [incoming, ...list];
  }
  if ((list[idx].revision || 0) > (incoming.revision || 0)) {
    return list;
  }
  const copy = [...list];
  copy[idx] = incoming;
  return copy;
}

export function deleteByRevision(list, idKey, entityId, revision) {
  const idx = list.findIndex((item) => item[idKey] === entityId);
  if (idx === -1) {
    return list;
  }
  if (revision && (list[idx].revision || 0) > revision) {
    return list;
  }
  return list.filter((item) => item[idKey] !== entityId);
}

export function mergeMasterEvents(existingList, instances) {
  let next = [...existingList];
  for (const master of extractMasterEvents(instances || [])) {
    next = upsertByRevision(next, 'event_id', master);
  }
  return next;
}

export function mergeTodoList(existingList, incomingTodos) {
  let next = [...existingList];
  for (const item of incomingTodos || []) {
    next = upsertByRevision(next, 'todo_id', item);
  }
  return next;
}

export function applySyncFrame(data, frame) {
  const seq = Math.max(data.lastSeq || 0, Number(frame.seq || 0));
  if (frame.entity_type === 'event') {
    const masterEvents = frame.action === 'delete'
      ? deleteByRevision(
        data.masterEvents, 'event_id', frame.entity_id, frame.revision
      )
      : upsertByRevision(
        data.masterEvents, 'event_id', toMasterEvent(frame.payload)
      );
    return { ...data, lastSeq: seq, masterEvents };
  }
  if (frame.entity_type === 'todo') {
    const todos = frame.action === 'delete'
      ? deleteByRevision(data.todos, 'todo_id', frame.entity_id, frame.revision)
      : upsertByRevision(data.todos, 'todo_id', { ...frame.payload });
    return { ...data, lastSeq: seq, todos };
  }
  return { ...data, lastSeq: seq };
}

export function applySyncBatch(data, frames) {
  let next = data;
  for (const frame of frames || []) {
    next = applySyncFrame(next, frame);
  }
  return next;
}

export function loadPersistedState(storage) {
  if (!storage) {
    return null;
  }
  let parsed = null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export function savePersistedState(storage, state) {
  if (!storage) {
    return false;
  }
  const snapshot = {
    mode: state.mode,
    baseUrl: state.baseUrl,
    token: state.token,
    identity: state.identity,
    lastSeq: state.lastSeq,
    theme: state.theme,
    masterEvents: state.masterEvents,
    todos: state.todos,
    agents: state.agents,
    tokens: state.tokens,
    offlineQueue: state.offlineQueue
  };
  let saved = true;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    saved = false;
  }
  return saved;
}

export function parseUrlBootstrap(searchStr) {
  const params = new URLSearchParams(searchStr || '');
  const rawPage = params.get('page') || '';
  const page = VALID_PAGES.includes(rawPage) ? rawPage : 'agenda';
  return {
    page,
    theme: params.get('theme') === 'black' ? 'black' : null,
    motionOff: params.get('motion') === 'off',
    createKind: params.get('create') || '',
    cloudUrl: (params.get('cloud') || '').trim(),
    token: (params.get('token') || '').trim()
  };
}
