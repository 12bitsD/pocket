import assert from 'node:assert/strict';
import test from 'node:test';

import { annotateConflicts } from '../src/domain/calendar-model.js';
import { createAppStore } from '../src/state/app-store.js';
import { waitForStore } from './helpers/store-test-kit.js';

const BOOT_EVENTS = Object.freeze([{
  event_id: 'ev_boot_1',
  event_date: '2026-11-24',
  start_hhmm: '10:00',
  end_hhmm: '11:00',
  title: 'Fast Boot Event',
  repeat_rule: 'none',
  reminder_policy: 'notify',
  revision: 1
}]);

const BOOT_TODOS = Object.freeze([{
  todo_id: 'td_boot_1',
  text: 'Fast Boot Todo',
  assignee: 'none',
  done: false,
  enabled: true,
  revision: 1
}]);

function createCountingStorage(seedObj) {
  const map = new Map();
  let writes = 0;
  if (seedObj) {
    map.set('pocket.calendar.state.v4', JSON.stringify(seedObj));
  }
  return {
    getWrites: () => writes,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => {
      writes += 1;
      map.set(key, String(val));
    }
  };
}

function makeJson(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function emitMockHelloReply(ws, msg, state) {
  if (msg.type !== 'HELLO') {
    return;
  }
  queueMicrotask(() => {
    for (const frame of state.replayFrames) {
      if (frame.seq > msg.last_seq) {
        ws.emit('message', { data: JSON.stringify(frame) });
      }
    }
    ws.emit('message', {
      data: JSON.stringify({
        type: 'HELLO_ACK',
        latest_seq: state.latestSeq,
        replayed: 0
      })
    });
  });
}

function createBootstrapSocketClass(sockets, state) {
  return class PerfSocket {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.sent = [];
      this.listeners = { open: [], message: [], close: [], error: [] };
      sockets.push(this);
      queueMicrotask(() => {
        if (!state.online) {
          this.closed = true;
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
      this.sent.push(msg);
      emitMockHelloReply(this, msg, state);
    }

    close(code, reason) {
      if (!this.closed) {
        this.closed = true;
        queueMicrotask(() => {
          this.emit('close', { code: code || 1000, reason: reason || '' });
        });
      }
    }
  };
}

function createPerfHarness(latestSeq) {
  const sockets = [];
  const rpcLog = [];
  const state = { online: true, latestSeq, replayFrames: [] };
  const socketCtor = createBootstrapSocketClass(sockets, state);
  const fetchImpl = async (url, init) => {
    if (!state.online) {
      throw new TypeError('Offline');
    }
    const method = url.split('/v1/rpc/')[1];
    const body = JSON.parse(init.body);
    rpcLog.push({ method, body });
    if (method === 'sync.bootstrap') {
      return makeJson(200, {
        data: {
          identity: { kind: 'device', label: 'Phone', scopes: ['*'] },
          latest_seq: state.latestSeq,
          events: BOOT_EVENTS,
          todos: BOOT_TODOS,
          agents: [],
          tokens: []
        }
      });
    }
    if (method === 'todo.set') {
      const id = body.params.todo_id || 'td_created';
      return makeJson(200, {
        data: { ...body.params, todo_id: id, revision: 2 }
      });
    }
    return makeJson(200, { data: {} });
  };
  return { sockets, rpcLog, state, socketCtor, fetchImpl };
}

function makeTodoSyncFrame(seq, todoId, text) {
  return {
    type: 'SYNC_PUSH',
    seq,
    entity_type: 'todo',
    entity_id: todoId,
    action: 'upsert',
    revision: 1,
    payload: {
      todo_id: todoId,
      text,
      assignee: 'none',
      done: false,
      enabled: true,
      revision: 1
    }
  };
}

test('cold login uses 1 sync.bootstrap HTTP call and warm boot uses 0',
  async () => {
    const harness = createPerfHarness(15);
    const storage = createCountingStorage();
    const coldStore = createAppStore({
      storage,
      isNativeAndroid: true,
      fetchImpl: harness.fetchImpl,
      WebSocketImpl: harness.socketCtor,
      clock: () => new Date(2026, 10, 24, 8, 0, 0)
    });
    await coldStore.connectCloud({
      baseUrl: 'http://127.0.0.1:8787',
      token: 'pck_mobile_1'
    });
    assert.equal(harness.rpcLog.length, 1);
    assert.equal(harness.rpcLog[0].method, 'sync.bootstrap');
    assert.equal(harness.rpcLog[0].body.request_id, undefined);
    assert.equal(harness.sockets[0].sent[0].last_seq, 15);
    coldStore.destroy();

    harness.rpcLog.length = 0;
    harness.state.latestSeq = 16;
    harness.state.replayFrames = [
      makeTodoSyncFrame(16, 'td_delta_16', 'Delta Over WS Only')
    ];
    const warmStore = createAppStore({
      storage,
      isNativeAndroid: true,
      fetchImpl: harness.fetchImpl,
      WebSocketImpl: harness.socketCtor,
      clock: () => new Date(2026, 10, 24, 8, 5, 0)
    });
    await waitForStore(
      warmStore,
      (st) => st.connectionStatus === 'online' && st.lastSeq === 16,
      'warm boot reaches online via WS catchup'
    );
    assert.equal(harness.rpcLog.length, 0);
    assert.ok(
      warmStore.getState().todos.some((t) => t.todo_id === 'td_delta_16')
    );
    warmStore.destroy();
  });

async function verifyOfflinePauseAndResume(harness, store) {
  harness.state.online = false;
  store.setPowerState({ offline: true });
  const countOffline = harness.sockets.length;
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(store.getState().connectionStatus, 'offline');
  assert.equal(harness.sockets.length, countOffline);

  harness.state.online = true;
  store.setPowerState({ offline: false });
  await waitForStore(
    store,
    (st) => st.connectionStatus === 'online',
    'online event triggers immediate reconnect'
  );
}

test('suspends WS in background and pauses retry timers when offline',
  async () => {
    const harness = createPerfHarness(10);
    const store = createAppStore({
      isNativeAndroid: true,
      fetchImpl: harness.fetchImpl,
      WebSocketImpl: harness.socketCtor,
      clock: () => new Date(2026, 10, 24, 8, 0, 0),
      reconnectBaseMs: 25
    });
    await store.connectCloud({
      baseUrl: 'http://127.0.0.1:8787',
      token: 'pck_mobile_bg'
    });
    const firstSocket = harness.sockets.at(-1);

    store.setPowerState({ hidden: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(firstSocket.closed, true);
    assert.equal(store.getState().connectionStatus, 'suspended');
    assert.equal(harness.sockets.length, 1);

    const bgTodo = await store.saveTodo({
      text: 'Created While Screen Off',
      assignee: 'none'
    });
    assert.equal(harness.rpcLog.length, 1);
    assert.equal(store.getState().offlineQueue.mutations.length, 1);

    store.setPowerState({ hidden: false });
    await waitForStore(
      store,
      (st) => st.connectionStatus === 'online' &&
        st.offlineQueue.mutations.length === 0,
      'foreground resume reconnects and flushes offline queue'
    );
    const flushed = harness.rpcLog.some(
      (r) => r.method === 'todo.set' &&
        r.body.params.todo_id === bgTodo.todo_id
    );
    assert.ok(flushed);
    await verifyOfflinePauseAndResume(harness, store);
    store.destroy();
  });

test('memoizes selectors and coalesces rapid localStorage writes',
  async () => {
    const harness = createPerfHarness(20);
    const storage = createCountingStorage();
    const store = createAppStore({
      storage,
      fetchImpl: harness.fetchImpl,
      WebSocketImpl: harness.socketCtor,
      clock: () => new Date(2026, 10, 24, 8, 0, 0)
    });
    await store.connectCloud({
      baseUrl: 'http://127.0.0.1:8787',
      token: 'pck_memo'
    });
    await Promise.resolve();
    const writesAfterBoot = storage.getWrites();
    const snapA = store.getState();
    assert.equal(snapA, store.getState());

    store.setViewState({ page: 'month' });
    store.setViewState({ page: 'todo' });
    store.setViewState({ page: 'agenda' });
    await Promise.resolve();
    assert.equal(storage.getWrites(), writesAfterBoot);
    assert.equal(store.getState().monthEvents, snapA.monthEvents);
    assert.equal(store.getState().todayEvents, snapA.todayEvents);
    assert.equal(store.getState().todoSummary, snapA.todoSummary);

    const ws = harness.sockets.at(-1);
    for (let seq = 21; seq <= 70; seq += 1) {
      const frame = makeTodoSyncFrame(seq, `td_burst_${seq}`, `Burst ${seq}`);
      ws.emit('message', { data: JSON.stringify(frame) });
    }
    await Promise.resolve();
    assert.equal(storage.getWrites() - writesAfterBoot, 1);
    store.destroy();
  });

function naiveConflictsJs(items) {
  const ordered = items.map((x) => ({ ...x })).sort(
    (a, b) => a.instance_date.localeCompare(b.instance_date) ||
      a.start_hhmm.localeCompare(b.start_hhmm) ||
      a.end_hhmm.localeCompare(b.end_hhmm) ||
      a.event_id.localeCompare(b.event_id)
  );
  return ordered.map((t) => ordered.some(
    (o) => o !== t &&
      o.instance_date === t.instance_date &&
      t.start_hhmm < o.end_hhmm &&
      o.start_hhmm < t.end_hhmm
  ));
}

function makeRandomEventItem(nextInt, idx) {
  const day = `2026-11-${String(24 + nextInt(3)).padStart(2, '0')}`;
  const sMin = nextInt(22 * 60);
  const eMin = Math.min(23 * 60 + 59, sMin + 15 * (1 + nextInt(8)));
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:` +
    `${String(m % 60).padStart(2, '0')}`;
  return {
    event_id: `ev_${idx}`,
    instance_date: day,
    start_hhmm: fmt(sMin),
    end_hhmm: fmt(eMin)
  };
}

test('linear annotateConflicts matches quadratic oracle across random inputs',
  () => {
    let seed = 424242;
    const nextInt = (mod) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % mod;
    };
    for (let trial = 0; trial < 120; trial += 1) {
      const len = nextInt(35);
      const list = Array.from(
        { length: len }, (_, i) => makeRandomEventItem(nextInt, i)
      );
      const expected = naiveConflictsJs(list);
      const actual = annotateConflicts(list).map((x) => x.has_conflict);
      assert.deepEqual(actual, expected);
    }
  });
