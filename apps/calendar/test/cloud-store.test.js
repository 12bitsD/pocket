import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudRpcError } from '../src/api/cloud-client.js';
import { createAppStore } from '../src/state/app-store.js';

function createMemoryStorage(initialObj) {
  const map = new Map();
  if (initialObj) {
    map.set('pocket.calendar.state.v4', JSON.stringify(initialObj));
  }
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => map.set(key, String(val))
  };
}

function makeJsonRes(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function handleTokenMockRpc(method, body, state) {
  if (method === 'token.list') {
    return makeJsonRes(200, { data: { tokens: state.tokensPayload } });
  }
  if (method === 'token.create') {
    state.mintCounter += 1;
    const minted = {
      token_id: `tok_ag_${state.mintCounter}`,
      kind: body.params.kind,
      label: body.params.label,
      scopes: body.params.scopes,
      token: `pck_test_${state.mintCounter}`
    };
    state.tokensPayload = [
      ...state.tokensPayload,
      { ...minted, revoked_at: null, created_at: '' }
    ];
    return makeJsonRes(200, { data: minted });
  }
  if (method === 'token.revoke') {
    state.tokensPayload = state.tokensPayload.map((t) => (
      t.token_id === body.params.token_id
        ? { ...t, revoked_at: '2026-11-24T09:00:00Z' }
        : t
    ));
    return makeJsonRes(200, {
      data: { token_id: body.params.token_id, revoked: true }
    });
  }
  return null;
}

function routeMockRpc(method, body, state) {
  const tokRes = handleTokenMockRpc(method, body, state);
  if (tokRes) {
    return tokRes;
  }
  if (method === 'auth.status') {
    return makeJsonRes(200, {
      data: { kind: 'web', label: 'UnitWeb', scopes: ['*'] }
    });
  }
  if (method === 'event.list') {
    return makeJsonRes(200, { data: { events: state.eventsPayload } });
  }
  if (method === 'todo.list') {
    return makeJsonRes(200, { data: { todos: state.todosPayload } });
  }
  if (method === 'agent.list') {
    return makeJsonRes(200, {
      data: {
        agents: [{
          agent_id: '@bot',
          name: 'Bot',
          endpoint_url: 'https://bot.example.com',
          active: true,
          updated_at: ''
        }]
      }
    });
  }
  if (method === 'todo.set' && body.params.todo_id === 'todo_locked') {
    state.todosPayload = [{
      todo_id: 'todo_locked',
      text: 'Server Authoritative',
      assignee: '@me',
      schedule_kind: 'once',
      time_hhmm: '07:00',
      once_date: '2026-11-25',
      locked: true,
      alarm_status: 'QUEUED',
      revision: 5
    }];
    return makeJsonRes(409, {
      error: { code: 'CLOUD_LOCKED', message: 'Todo is locked on device' }
    });
  }
  return makeJsonRes(200, { data: {} });
}

function createMockSocketClass(sockets, getServerSeq) {
  return class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = { open: [], message: [], close: [], error: [] };
      sockets.push(this);
      queueMicrotask(() => this.emit('open', {}));
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
      this.sent.push(msg);
      if (msg.type === 'HELLO') {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({
              type: 'HELLO_ACK',
              latest_seq: getServerSeq(),
              replayed: 0
            })
          });
        });
      }
    }

    close(code, reason) {
      queueMicrotask(() => {
        this.emit('close', { code: code || 1000, reason: reason || '' });
      });
    }
  };
}

function createMockHarness(initialSeq) {
  const sockets = [];
  const rpcCalls = [];
  const state = {
    serverSeq: initialSeq ?? 10,
    mintCounter: 0,
    eventsPayload: [{
      event_id: 'evt_1',
      event_date: '2026-11-24',
      instance_date: '2026-11-24',
      start_hhmm: '09:00',
      end_hhmm: '10:00',
      title: 'Boot Event',
      location: 'Desk',
      repeat_rule: 'none',
      reminder_policy: 'alarm',
      reminder_offset_minutes: 15,
      alarm_status: 'QUEUED',
      source: 'web',
      revision: 1,
      updated_at: '2026-11-24T00:00:00Z'
    }],
    todosPayload: [],
    tokensPayload: []
  };
  const socketCtor = createMockSocketClass(sockets, () => state.serverSeq);
  const fetchImpl = async (url, init) => {
    const method = url.split('/v1/rpc/')[1];
    const body = JSON.parse(init.body);
    rpcCalls.push({ method, body });
    return routeMockRpc(method, body, state);
  };
  return { sockets, rpcCalls, state, socketCtor, fetchImpl };
}

function sendSyncPush(ws, spec) {
  const idKey = `${spec.entityType}_id`;
  ws.emit('message', {
    data: JSON.stringify({
      type: 'SYNC_PUSH',
      seq: spec.seq,
      entity_type: spec.entityType,
      entity_id: spec.payload[idKey],
      action: spec.action,
      revision: spec.payload.revision || 1,
      payload: spec.payload
    })
  });
}

test('applies live SYNC_PUSH and survives async socket replace', async () => {
  const harness = createMockHarness(12);
  const store = createAppStore({
    storage: createMemoryStorage(),
    fetchImpl: harness.fetchImpl,
    WebSocketImpl: harness.socketCtor,
    clock: () => new Date(2026, 10, 24, 8, 0, 0),
    reconnectBaseMs: 30
  });
  await store.connectCloud({
    baseUrl: 'http://127.0.0.1:8787/',
    token: 'pck_web_1'
  });
  await store.connectCloud({
    baseUrl: 'http://127.0.0.1:8787/',
    token: 'pck_web_2'
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(store.getState().connectionStatus, 'online');
  assert.equal(harness.sockets.length, 2);

  const countBefore = harness.rpcCalls.length;
  const activeWs = harness.sockets.at(-1);
  sendSyncPush(activeWs, {
    seq: 13,
    entityType: 'event',
    action: 'upsert',
    payload: {
      event_id: 'evt_live',
      event_date: '2026-11-24',
      start_hhmm: '09:30',
      end_hhmm: '10:30',
      title: 'Live Overlap',
      repeat_rule: 'weekdays',
      reminder_policy: 'notify',
      source: 'agent',
      revision: 1
    }
  });
  assert.equal(harness.rpcCalls.length, countBefore);
  assert.equal(store.getState().todayEvents.length, 2);

  await store.refreshMonthRange(2026, 11);
  assert.equal(store.getState().selectedDate, '2026-12-01');
  store.destroy();
});

test('refreshes on 409 conflict and serializes scope grants', async () => {
  const harness = createMockHarness(20);
  const store = createAppStore({
    storage: createMemoryStorage(),
    fetchImpl: harness.fetchImpl,
    WebSocketImpl: harness.socketCtor,
    clock: () => new Date(2026, 10, 24, 8, 0, 0)
  });
  await store.connectCloud({
    baseUrl: 'http://127.0.0.1:8787',
    token: 'pck_web_tok'
  });
  sendSyncPush(harness.sockets.at(-1), {
    seq: 21,
    entityType: 'todo',
    action: 'upsert',
    payload: {
      todo_id: 'todo_locked',
      text: 'Phone Alarm',
      assignee: '@me',
      schedule_kind: 'once',
      time_hhmm: '07:00',
      once_date: '2026-11-25',
      locked: true,
      alarm_status: 'QUEUED',
      revision: 1
    }
  });

  await assert.rejects(
    () => store.saveTodo({ todo_id: 'todo_locked', text: 'Overwrite' }),
    (err) => err instanceof CloudRpcError && err.code === 'CLOUD_LOCKED'
  );
  assert.equal(store.getState().todos[0].revision, 5);

  const [firstGrant, secondGrant] = await Promise.all([
    store.setAgentScopeGrant('@bot', { canRead: true }),
    store.setAgentScopeGrant('@bot', { canWrite: true })
  ]);
  assert.ok(firstGrant.token);
  assert.ok(secondGrant.token);
  const activeAgentTokens = store.getState().tokens.filter(
    (t) => t.kind === 'agent' && !t.revoked_at
  );
  assert.equal(activeAgentTokens.length, 1);
  assert.equal(store.getState().agentGrants[0].canRead, true);
  assert.equal(store.getState().agentGrants[0].canWrite, true);
  store.destroy();
});

test('recovers from latest_seq reset and halts on 4401 revoke', async () => {
  const harness = createMockHarness(3);
  harness.state.eventsPayload = [];
  const storage = createMemoryStorage({
    mode: 'cloud',
    baseUrl: 'http://127.0.0.1:8787',
    token: 'pck_saved',
    identity: { kind: 'web', label: 'Saved', scopes: ['*'], source: 'web' },
    lastSeq: 50,
    masterEvents: [{
      event_id: 'stale_ev',
      event_date: '2026-11-24',
      start_hhmm: '08:00',
      end_hhmm: '09:00',
      title: 'Stale',
      repeat_rule: 'none',
      reminder_policy: 'none',
      revision: 9
    }],
    todos: []
  });
  const store = createAppStore({
    storage,
    fetchImpl: harness.fetchImpl,
    WebSocketImpl: harness.socketCtor,
    clock: () => new Date(2026, 10, 24, 8, 0, 0),
    reconnectBaseMs: 25
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(store.getState().lastSeq, 3);
  assert.equal(store.getState().masterEvents.length, 0);

  const countBefore = harness.sockets.length;
  harness.sockets.at(-1).emit('close', { code: 4401, reason: 'Revoked' });
  assert.equal(store.getState().connectionStatus, 'revoked');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.sockets.length, countBefore);
  store.destroy();
});
