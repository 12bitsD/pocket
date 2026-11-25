import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppStore } from '../src/state/app-store.js';
import { renderSettingsView } from '../src/ui/settings-view.js';
import {
  countHero,
  createDeviceServerHarness,
  makeMemoryStorage,
  waitForStore
} from './helpers/store-test-kit.js';

function createFakeNativePlugin(initialPerms) {
  const syncCalls = [];
  const openedTargets = [];
  const queuedRingEvents = [];
  let perms = {
    exactAlarm: true,
    notifications: false,
    fullScreenIntent: true,
    batteryOptimization: false,
    ...initialPerms
  };
  const plugin = {
    syncAlarms: async ({ alarms }) => {
      syncCalls.push(alarms);
      return {
        results: alarms.map((item) => ({
          alarmKey: item.alarmKey,
          entityType: item.entityType,
          entityId: item.entityId,
          status: item.onceDate === '2026-11-20'
            ? 'EXPIRED'
            : (perms.exactAlarm ? 'EXECUTED' : 'FAILED'),
          nextTriggerMs: item.onceDate === '2026-11-20' ? null : 1795500000000
        }))
      };
    },
    drainRingingEvents: async () => ({
      events: queuedRingEvents.splice(0, queuedRingEvents.length)
    }),
    checkPermissions: async () => ({ ...perms }),
    openPermissionSettings: async ({ target }) => {
      openedTargets.push(target);
      return { opened: true, target };
    }
  };
  return {
    syncCalls,
    openedTargets,
    setPermissions: (next) => {
      perms = { ...perms, ...next };
    },
    pushRingingEvent: (ev) => queuedRingEvents.push(ev),
    plugin
  };
}

async function seedArmedItems(store) {
  const onceTd = await store.saveTodo({
    text: 'Morning Train',
    assignee: '@me',
    schedule_kind: 'once',
    time_hhmm: '09:15',
    once_date: '2026-11-25'
  });
  const dailyTd = await store.saveTodo({
    text: 'Daily Check',
    assignee: '@me',
    schedule_kind: 'daily',
    time_hhmm: '07:30',
    skip_next: true
  });
  const pastTd = await store.saveTodo({
    text: 'Past Due Once',
    assignee: '@me',
    schedule_kind: 'once',
    time_hhmm: '07:00',
    once_date: '2026-11-20'
  });
  const alarmEv = await store.saveEvent({
    event_date: '2026-11-25',
    start_hhmm: '10:00',
    end_hhmm: '11:00',
    title: 'Board Sync',
    reminder_policy: 'alarm'
  });
  await waitForStore(
    store,
    (st) => {
      const ev = st.masterEvents.find((e) => e.event_id === alarmEv.event_id);
      return ev?.alarm_status === 'EXECUTED';
    },
    'alarmEv transitions to EXECUTED'
  );
  return { onceTd, dailyTd, pastTd, alarmEv };
}

function assertDrainedOutcomes(store, srv, ids, receiptsBefore) {
  const st = store.getState();
  const updatedOnce = st.todos.find((t) => t.todo_id === ids.onceTd.todo_id);
  const updatedDaily = st.todos.find((t) => t.todo_id === ids.dailyTd.todo_id);
  const updatedPast = st.todos.find((t) => t.todo_id === ids.pastTd.todo_id);
  assert.equal(updatedOnce.done, true);
  assert.equal(updatedDaily.skip_next, false);
  assert.equal(updatedPast.alarm_status, 'QUEUED');
  const trailingReceipts = srv.wsFrames.slice(receiptsBefore);
  const onceReceipts = trailingReceipts.filter(
    (f) => f.type === 'ALARM_RECEIPT' && f.entity_id === ids.onceTd.todo_id
  );
  assert.equal(onceReceipts.length, 0);
  const missedReceipt = trailingReceipts.find(
    (f) => f.type === 'ALARM_RECEIPT' &&
      f.entity_id === ids.alarmEv.event_id &&
      f.status === 'MISSED'
  );
  assert.ok(missedReceipt);
}

function assertFlushedServerLog(srv, offlineTd, offlineEv, editedOnlineId) {
  const lockFrameIdx = srv.wsFrames.findIndex(
    (f) => f.type === 'LOCK_OVERRIDE' &&
      f.todo?.todo_id === offlineTd.todo_id
  );
  const receiptIdx = srv.wsFrames.findIndex(
    (f) => f.type === 'ALARM_RECEIPT' &&
      f.entity_id === offlineTd.todo_id &&
      f.status === 'EXECUTED'
  );
  assert.ok(lockFrameIdx !== -1);
  assert.ok(receiptIdx > lockFrameIdx);
  assert.ok(
    srv.rpcLog.some(
      (r) => r.method === 'event.set' &&
        r.params.event_id === offlineEv.event_id
    )
  );
  const coalescedTodoRpc = srv.rpcLog.find(
    (r) => r.method === 'todo.set' && r.params.todo_id === editedOnlineId
  );
  assert.ok(coalescedTodoRpc);
  assert.equal(coalescedTodoRpc.params.base_revision, 1);
  assert.equal(coalescedTodoRpc.params.text, 'Edited Twice Offline');
  assert.equal(coalescedTodoRpc.params.done, true);
}

test('renders Android claim tab default and 4-permission card', async () => {
  const nativeHarness = createFakeNativePlugin();
  const store = createAppStore({
    isNativeAndroid: true,
    nativeAlarmPlugin: nativeHarness.plugin,
    clock: () => new Date(2026, 10, 24, 8, 0, 0)
  });
  await waitForStore(
    store,
    (st) => Boolean(st.nativePermissions),
    'nativePermissions loaded'
  );

  const settingsHtml = renderSettingsView(store.getState());
  assert.equal(countHero(settingsHtml), 1);
  assert.ok(!settingsHtml.includes('<article class="job-card">'));
  assert.ok(settingsHtml.includes('id="pair-claim-form"'));
  assert.ok(settingsHtml.includes('DEVICE ALARM PERMISSIONS (4)'));
  assert.ok(settingsHtml.includes('aria-label="去开启：后台省电白名单'));
  assert.ok(settingsHtml.includes('READY'));
  assert.ok(settingsHtml.includes('REQUIRED'));

  await store.openNativePermission('batteryOptimization');
  assert.deepEqual(nativeHarness.openedTargets, ['batteryOptimization']);

  nativeHarness.setPermissions({
    notifications: true,
    batteryOptimization: true
  });
  const refreshed = await store.refreshNativePermissions();
  assert.equal(refreshed.notifications, true);
  assert.equal(refreshed.batteryOptimization, true);
  store.destroy();
});

test('arms alarms, dedupes syncs, and drains ringing events', async () => {
  const srv = createDeviceServerHarness();
  const nativeHarness = createFakeNativePlugin();
  const store = createAppStore({
    isNativeAndroid: true,
    nativeAlarmPlugin: nativeHarness.plugin,
    fetchImpl: srv.fetchImpl,
    WebSocketImpl: srv.socketCtor,
    clock: () => new Date(2026, 10, 24, 8, 0, 0),
    reconnectBaseMs: 25
  });
  await store.claimPairing({
    baseUrl: 'http://127.0.0.1:8787',
    code: '654321',
    name: 'TestPhone'
  });

  const ids = await seedArmedItems(store);
  const syncCountAfterArm = nativeHarness.syncCalls.length;
  store.setTheme('black');
  await Promise.resolve();
  assert.equal(nativeHarness.syncCalls.length, syncCountAfterArm);

  const receiptsBefore = srv.wsFrames.length;
  const armedReceipts = srv.wsFrames.filter(
    (f) => f.type === 'ALARM_RECEIPT'
  );
  assert.equal(armedReceipts.length, 3);

  nativeHarness.pushRingingEvent({
    entityType: 'todo',
    entityId: ids.onceTd.todo_id,
    eventKind: 'DISMISSED'
  });
  nativeHarness.pushRingingEvent({
    entityType: 'todo',
    entityId: ids.dailyTd.todo_id,
    eventKind: 'SKIP_CONSUMED'
  });
  nativeHarness.pushRingingEvent({
    entityType: 'event',
    entityId: ids.alarmEv.event_id,
    eventKind: 'MISSED'
  });
  await store.drainNativeRingingEvents();
  assertDrainedOutcomes(store, srv, ids, receiptsBefore);
  store.destroy();
});

async function createAndMutateOffline(store, existingTdId) {
  await store.saveTodo({
    todo_id: existingTdId,
    text: 'Edited Once Offline'
  });
  await store.saveTodo({
    todo_id: existingTdId,
    text: 'Edited Twice Offline'
  });
  await store.toggleTodo(existingTdId);

  const offlineTd = await store.saveTodo({
    text: 'Offline Locked Flight',
    assignee: '@me',
    schedule_kind: 'once',
    time_hhmm: '06:40',
    once_date: '2026-11-26',
    locked: true
  });
  const offlineEv = await store.saveEvent({
    event_date: '2026-11-26',
    start_hhmm: '14:00',
    end_hhmm: '15:00',
    title: 'Offline Strong Event',
    reminder_policy: 'alarm'
  });
  await waitForStore(
    store,
    (st) => {
      const td = st.todos.find((t) => t.todo_id === offlineTd.todo_id);
      return td?.alarm_status === 'EXECUTED';
    },
    'offlineTd armed locally'
  );
  return { offlineTd, offlineEv };
}

test('queues locked todo and coalesced edits then flushes', async () => {
  const srv = createDeviceServerHarness();
  const nativeHarness = createFakeNativePlugin();
  const store = createAppStore({
    storage: makeMemoryStorage(),
    isNativeAndroid: true,
    nativeAlarmPlugin: nativeHarness.plugin,
    fetchImpl: srv.fetchImpl,
    WebSocketImpl: srv.socketCtor,
    clock: () => new Date(2026, 10, 24, 8, 0, 0),
    reconnectBaseMs: 30
  });
  await store.claimPairing({
    baseUrl: 'http://127.0.0.1:8787',
    code: '112233',
    name: 'OfflinePhone'
  });
  const seededOnline = await store.saveTodo({
    text: 'Initial Cloud Todo',
    assignee: 'none'
  });

  srv.state.networkUp = false;
  srv.sockets.at(-1).close(1006, 'Disconnected');
  await waitForStore(
    store,
    (st) => st.connectionStatus !== 'online',
    'store enters reconnecting state'
  );

  const { offlineTd, offlineEv } = await createAndMutateOffline(
    store, seededOnline.todo_id
  );
  assert.match(offlineTd.todo_id, /^todo_[0-9a-f]{16}$/);
  assert.match(offlineEv.event_id, /^ev_[0-9a-f]{16}$/);

  srv.state.networkUp = true;
  await waitForStore(
    store,
    (st) => st.connectionStatus === 'online' &&
      st.offlineQueue.mutations.length === 0 &&
      st.offlineQueue.receipts.length === 0,
    'offline queue fully flushed after reconnect'
  );
  assertFlushedServerLog(srv, offlineTd, offlineEv, seededOnline.todo_id);
  store.destroy();
});
