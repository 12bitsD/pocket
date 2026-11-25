export function countHero(html) {
  return (html.match(/class="hero"/g) || []).length;
}

export function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => map.set(key, String(val))
  };
}

export function makeJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

export function waitForStore(store, predicate, label) {
  if (predicate(store.getState())) {
    return Promise.resolve(store.getState());
  }
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for: ${label}`));
    }, 3000);
    unsub = store.subscribe((next) => {
      if (predicate(next)) {
        clearTimeout(timer);
        unsub();
        resolve(next);
      }
    });
  });
}

function handleLockOverrideFrame(ws, msg, state) {
  state.seq += 1;
  const saved = {
    ...msg.todo,
    locked: true,
    alarm_status: msg.todo.assignee === '@me' ? 'QUEUED' : 'NONE',
    revision: 1
  };
  state.todos.push(saved);
  ws.emit('message', {
    data: JSON.stringify({
      type: 'SYNC_PUSH',
      seq: state.seq,
      entity_type: 'todo',
      entity_id: saved.todo_id,
      action: 'upsert',
      revision: 1,
      payload: saved
    })
  });
  ws.emit('message', {
    data: JSON.stringify({
      type: 'OVERRIDE_ACK',
      todo_id: saved.todo_id,
      revision: 1
    })
  });
}

function handleAlarmReceiptFrame(ws, msg, state) {
  const td = state.todos.find((t) => t.todo_id === msg.entity_id);
  const invalidTodo = msg.entity_type === 'todo' &&
    td && (td.done || !td.enabled);
  if (invalidTodo) {
    ws.emit('message', {
      data: JSON.stringify({
        type: 'ERROR',
        code: 'NOT_ALARM_ENTITY',
        message: 'Todo has no active phone alarm'
      })
    });
    return;
  }
  if (td) {
    td.alarm_status = msg.status;
  }
  ws.emit('message', {
    data: JSON.stringify({
      type: 'RECEIPT_ACK',
      entity_type: msg.entity_type,
      entity_id: msg.entity_id,
      status: msg.status,
      revision: 2
    })
  });
}

function replyMockSocketFrame(ws, msg, state) {
  if (msg.type === 'HELLO') {
    ws.emit('message', {
      data: JSON.stringify({
        type: 'HELLO_ACK',
        latest_seq: state.seq,
        replayed: 0
      })
    });
    return;
  }
  if (msg.type === 'LOCK_OVERRIDE') {
    handleLockOverrideFrame(ws, msg, state);
    return;
  }
  if (msg.type === 'ALARM_RECEIPT') {
    handleAlarmReceiptFrame(ws, msg, state);
  }
}

function createFakeSocketClass(sockets, wsFrames, state) {
  return class FakeSocket {
    constructor(url) {
      this.url = url;
      this.listeners = { open: [], message: [], close: [], error: [] };
      sockets.push(this);
      queueMicrotask(() => {
        if (!state.networkUp) {
          this.emit('close', { code: 1006, reason: 'Offline' });
          return;
        }
        this.emit('open', {});
      });
    }

    addEventListener(type, fn) {
      this.listeners[type]?.push(fn);
    }

    emit(type, ev) {
      for (const fn of this.listeners[type] || []) {
        fn(ev);
      }
    }

    send(raw) {
      const msg = JSON.parse(raw);
      wsFrames.push(msg);
      queueMicrotask(() => replyMockSocketFrame(this, msg, state));
    }

    close(code, reason) {
      queueMicrotask(() => {
        this.emit('close', { code: code || 1000, reason: reason || '' });
      });
    }
  };
}

const MOCK_RPC_HANDLERS = Object.freeze({
  'pairing.claim': () => ({
    token_id: 'tok_dev_1',
    token: 'pck_dev_secret',
    kind: 'device'
  }),
  'auth.status': () => ({ kind: 'device', label: 'Pixel8', scopes: ['*'] }),
  'event.list': (params, st) => ({ events: st.events }),
  'todo.list': (params, st) => ({ todos: st.todos }),
  'agent.list': () => ({ agents: [] }),
  'token.list': () => ({ tokens: [] }),
  'event.set': (params, st) => {
    st.nextId += 1;
    const saved = {
      ...params,
      event_id: params.event_id || `evt_srv_${st.nextId}`,
      alarm_status: params.reminder_policy === 'alarm' ? 'QUEUED' : 'NONE',
      source: 'local',
      revision: (params.base_revision || 0) + 1,
      updated_at: '2026-11-24T08:00:00Z'
    };
    const idx = st.events.findIndex((e) => e.event_id === saved.event_id);
    if (idx === -1) {
      st.events.push(saved);
    } else {
      st.events[idx] = saved;
    }
    return saved;
  },
  'todo.set': (params, st) => {
    const idx = st.todos.findIndex((t) => t.todo_id === params.todo_id);
    if (idx !== -1 && params.base_revision !== undefined &&
        st.todos[idx].revision !== params.base_revision) {
      return { conflict: true };
    }
    st.nextId += 1;
    const saved = {
      ...params,
      todo_id: params.todo_id || `todo_srv_${st.nextId}`,
      alarm_status: params.assignee === '@me' && !params.done && params.enabled
        ? 'QUEUED'
        : 'NONE',
      revision: (idx !== -1 ? st.todos[idx].revision : 0) + 1,
      updated_at: '2026-11-24T08:00:00Z'
    };
    if (idx === -1) {
      st.todos.push(saved);
    } else {
      st.todos[idx] = saved;
    }
    return saved;
  },
  'todo.toggle': (params, st) => {
    const idx = st.todos.findIndex((t) => t.todo_id === params.todo_id);
    const cur = st.todos[idx];
    const toggled = {
      ...cur,
      done: true,
      enabled: false,
      alarm_status: 'NONE',
      revision: (cur.revision || 1) + 1
    };
    st.todos[idx] = toggled;
    return toggled;
  }
});

export function createDeviceServerHarness() {
  const sockets = [];
  const rpcLog = [];
  const wsFrames = [];
  const state = {
    networkUp: true,
    seq: 1,
    nextId: 0,
    todos: [],
    events: []
  };
  const socketCtor = createFakeSocketClass(sockets, wsFrames, state);
  const fetchImpl = async (url, init) => {
    if (!state.networkUp) {
      throw new TypeError('Network unreachable');
    }
    const method = url.split('/v1/rpc/')[1];
    const body = JSON.parse(init.body);
    rpcLog.push({ method, params: body.params });
    const handler = MOCK_RPC_HANDLERS[method];
    const data = handler ? handler(body.params, state) : {};
    if (data?.conflict) {
      return makeJsonResponse(409, {
        error: { code: 'REVISION_CONFLICT', message: 'Stale base_revision' }
      });
    }
    return makeJsonResponse(200, { data });
  };
  return { state, sockets, rpcLog, wsFrames, socketCtor, fetchImpl };
}
