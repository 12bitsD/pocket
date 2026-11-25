import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { createCloudClient } from '../../apps/calendar/src/api/cloud-client.js';
import {
  annotateConflicts
} from '../../apps/calendar/src/domain/calendar-model.js';
import { addDaysIso } from '../../apps/calendar/src/domain/date-time.js';
import { createAppStore } from '../../apps/calendar/src/state/app-store.js';

function createMeasuredStorage() {
  const map = new Map();
  let writes = 0;
  return {
    getWrites: () => writes,
    resetWrites: () => {
      writes = 0;
    },
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => {
      writes += 1;
      map.set(key, String(val));
    }
  };
}

function createTrackingSocketClass(tracker) {
  return class TrackedWebSocket {
    constructor(url) {
      const ws = new globalThis.WebSocket(url);
      tracker.openSockets.add(ws);
      ws.addEventListener('close', () => {
        tracker.openSockets.delete(ws);
      });
      return ws;
    }
  };
}

function waitForOnline(store, label) {
  if (store.getState().connectionStatus === 'online') {
    return Promise.resolve(store.getState());
  }
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timeout waiting for ${label}`));
    }, 5000);
    unsub = store.subscribe((st) => {
      if (st.connectionStatus === 'online') {
        clearTimeout(timer);
        unsub();
        resolve(st);
      }
    });
  });
}

async function seedPerfDataset(baseUrl, bootstrapToken) {
  const client = createCloudClient({
    getSession: () => ({ baseUrl, token: bootstrapToken, source: 'web' })
  });
  const pair = await client.callRpc('pairing.create', {});
  const claimed = await client.callRpc(
    'pairing.claim',
    { code: pair.code, name: 'PerfEvalPhone' },
    { baseUrl, publicCall: true, source: 'local' }
  );
  const todayIso = '2026-11-24';
  const tasks = [];
  for (let i = 0; i < 20; i += 1) {
    const startH = String(8 + (i % 10)).padStart(2, '0');
    const endH = String(9 + (i % 10)).padStart(2, '0');
    tasks.push(client.callRpc('event.set', {
      event_date: addDaysIso(todayIso, i % 5),
      start_hhmm: `${startH}:00`,
      end_hhmm: `${endH}:00`,
      title: `Perf Seeded Event #${i}`,
      repeat_rule: i % 4 === 0 ? 'daily' : 'none',
      reminder_policy: 'notify'
    }));
    tasks.push(client.callRpc('todo.set', {
      text: `Perf Seeded Todo #${i} · Mobile Latency Benchmark`,
      assignee: 'none'
    }));
  }
  await Promise.all(tasks);
  return claimed.token;
}

function buildSyntheticInstances(count) {
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:` +
    `${String(m % 60).padStart(2, '0')}`;
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const startMin = (i * 17) % (22 * 60);
    list.push({
      event_id: `syn_${i}`,
      instance_date: `2026-11-${String(24 + (i % 4)).padStart(2, '0')}`,
      start_hhmm: fmt(startMin),
      end_hhmm: fmt(startMin + 45)
    });
  }
  return list;
}

function benchmarkCpuHotPaths(store) {
  store.getState();
  const selStart = performance.now();
  for (let i = 0; i < 500; i += 1) {
    store.getState();
  }
  const selector500Ms = Number((performance.now() - selStart).toFixed(3));
  const synthetic = buildSyntheticInstances(400);
  const sweepStart = performance.now();
  const swept = annotateConflicts(synthetic);
  const conflict400Ms = Number((performance.now() - sweepStart).toFixed(3));
  assert.equal(swept.length, 400);
  assert.ok(selector500Ms < 25, `selector500Ms too slow: ${selector500Ms}ms`);
  assert.ok(conflict400Ms < 25, `conflict400Ms too slow: ${conflict400Ms}ms`);
  return { selector500Ms, conflict400Ms };
}

async function verifyTabPersistenceAndSuspend(store, storage, tracker) {
  await Promise.resolve();
  storage.resetWrites();
  store.setViewState({ page: 'month' });
  store.setViewState({ page: 'todo' });
  store.setViewState({ page: 'agenda' });
  await Promise.resolve();
  assert.equal(storage.getWrites(), 0, 'Tab switches must write 0 storage');

  store.setPowerState({ hidden: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(tracker.openSockets.size, 0, 'Background must hold 0 open WS');

  store.setPowerState({ hidden: false });
  await waitForOnline(store, 'foreground resume');
  assert.equal(tracker.httpCalls, 1, 'Foreground resume must use 0 HTTP');
}

async function measureWarmBootMs(storage, fetchImpl, socketCtor) {
  const start = performance.now();
  const warmStore = createAppStore({
    storage,
    isNativeAndroid: true,
    fetchImpl,
    WebSocketImpl: socketCtor,
    reconnectBaseMs: 150
  });
  await waitForOnline(warmStore, 'cached warm boot');
  const elapsed = Number((performance.now() - start).toFixed(2));
  warmStore.destroy();
  return elapsed;
}

async function measureColdAndWarmBoot(baseUrl, deviceToken) {
  const storage = createMeasuredStorage();
  const tracker = { httpCalls: 0, openSockets: new Set() };
  const fetchImpl = (url, init) => {
    tracker.httpCalls += 1;
    return globalThis.fetch(url, init);
  };
  const socketCtor = createTrackingSocketClass(tracker);

  const tCold0 = performance.now();
  const coldStore = createAppStore({
    storage,
    isNativeAndroid: true,
    fetchImpl,
    WebSocketImpl: socketCtor,
    reconnectBaseMs: 150
  });
  await coldStore.connectCloud({ baseUrl, token: deviceToken });
  const coldBootMs = Number((performance.now() - tCold0).toFixed(2));
  assert.equal(tracker.httpCalls, 1, 'Cold boot must use 1 HTTP request');
  const cpuMetrics = benchmarkCpuHotPaths(coldStore);
  await verifyTabPersistenceAndSuspend(coldStore, storage, tracker);
  coldStore.destroy();

  tracker.httpCalls = 0;
  const warmBootMs = await measureWarmBootMs(storage, fetchImpl, socketCtor);
  assert.equal(tracker.httpCalls, 0, 'Warm boot must use 0 HTTP requests');

  return {
    coldHttpCount: 1,
    warmHttpCount: 0,
    backgroundOpenSockets: 0,
    coldBootMs,
    warmBootMs,
    ...cpuMetrics
  };
}

async function verifyLiveGzipHeader(baseUrl, token) {
  const res = await globalThis.fetch(`${baseUrl}/v1/rpc/sync.bootstrap`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    body: JSON.stringify({ params: {}, source: 'local' })
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
}

async function main() {
  const env = process.env;
  const baseUrl = env.POCKET_EVAL_URL;
  const token = env.POCKET_EVAL_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('POCKET_EVAL_URL and POCKET_EVAL_TOKEN are required');
  }
  const deviceToken = await seedPerfDataset(baseUrl, token);
  await verifyLiveGzipHeader(baseUrl, deviceToken);
  const metrics = await measureColdAndWarmBoot(baseUrl, deviceToken);
  console.log(JSON.stringify({ ok: true, gate: 'eval_perf.mjs', metrics }));
}

main();
