import assert from 'node:assert/strict';

import {
  CloudRpcError,
  createCloudClient
} from '../../apps/calendar/src/api/cloud-client.js';
import { addDaysIso } from '../../apps/calendar/src/domain/date-time.js';
import { createAppStore } from '../../apps/calendar/src/state/app-store.js';
import {
  renderAgendaView,
  renderMonthView
} from '../../apps/calendar/src/ui/agenda-month-view.js';
import {
  renderSettingsView
} from '../../apps/calendar/src/ui/settings-view.js';
import { renderTodoView } from '../../apps/calendar/src/ui/todo-view.js';
import { buildTtyBarHtml } from '../../apps/calendar/src/ui/underlay.js';

function countHero(html) {
  return (html.match(/class="hero"/g) || []).length;
}

function waitForStore(store, predicate, label) {
  if (predicate(store.getState())) {
    return Promise.resolve(store.getState());
  }
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for store condition: ${label}`));
    }, 5000);
    unsub = store.subscribe((next) => {
      if (predicate(next)) {
        clearTimeout(timer);
        unsub();
        resolve(next);
      }
    });
  });
}

async function verifyEventsAndViews(webStore) {
  const todayIso = webStore.getState().todayIso;
  await webStore.saveEvent({
    event_date: todayIso,
    start_hhmm: '10:00',
    end_hhmm: '11:00',
    title: 'Web Eval Arch Sync',
    location: 'Room A',
    repeat_rule: 'none',
    reminder_policy: 'alarm'
  });
  await webStore.saveEvent({
    event_date: todayIso,
    start_hhmm: '10:30',
    end_hhmm: '11:30',
    title: 'Web Eval Overlap Review',
    location: 'Room B',
    repeat_rule: 'none',
    reminder_policy: 'notify'
  });
  const state = webStore.getState();
  const refTime = Date.parse(`${todayIso}T08:00:00`);
  const agendaHtml = renderAgendaView(state, refTime);
  const monthHtml = renderMonthView(state);
  assert.ok(agendaHtml.includes('Web Eval Arch Sync'));
  assert.ok(agendaHtml.includes('Web Eval Overlap Review'));
  assert.ok(agendaHtml.includes('时间重叠'));
  assert.ok(agendaHtml.includes('ALARM QUEUED'));
  assert.ok(monthHtml.includes('时间重叠'));
  assert.ok(countHero(agendaHtml) <= 1);
  assert.equal(countHero(monthHtml), 0);
  assert.equal(countHero(renderTodoView(state)), 0);
  assert.equal(countHero(renderSettingsView(state)), 1);
}

async function verifyAlarmReceiptTransition(todoId, webStore, deviceStore) {
  await assert.rejects(
    () => webStore.saveTodo({
      todo_id: todoId,
      text: 'Web illegal overwrite'
    }),
    (err) => err instanceof CloudRpcError && err.code === 'CLOUD_LOCKED'
  );
  const ack = await deviceStore.sendAlarmReceipt({
    entityType: 'todo',
    entityId: todoId,
    status: 'EXECUTED'
  });
  assert.equal(ack.type, 'RECEIPT_ACK');
  await waitForStore(
    webStore,
    (st) => {
      const found = st.todos.find((t) => t.todo_id === todoId);
      return found?.alarm_status === 'EXECUTED';
    },
    'webStore receives EXECUTED alarm_status'
  );
  const afterHtml = renderTodoView(webStore.getState());
  assert.ok(afterHtml.includes('EXECUTED'));
}

async function verifyPairingLockAndReceipt(baseUrl, webStore, deviceStore) {
  const pair = await webStore.createPairingCode();
  assert.match(pair.code, /^\d{6}$/);
  assert.ok(renderSettingsView(webStore.getState()).includes(pair.code));

  await deviceStore.claimPairing({
    baseUrl,
    code: pair.code,
    name: 'HostEvalDevice'
  });
  assert.equal(deviceStore.getState().identity.kind, 'device');
  assert.equal(deviceStore.getState().identity.source, 'local');

  const futureDate = addDaysIso(webStore.getState().todayIso, 2);
  const created = await deviceStore.saveTodo({
    text: 'HostEval Locked Alarm',
    assignee: '@me',
    schedule_kind: 'once',
    time_hhmm: '07:15',
    once_date: futureDate,
    locked: true
  });
  await waitForStore(
    webStore,
    (st) => st.todos.some((t) => t.todo_id === created.todo_id),
    'webStore receives locked @me todo'
  );
  const beforeHtml = renderTodoView(webStore.getState());
  assert.ok(beforeHtml.includes('QUEUED'));
  assert.ok(beforeHtml.includes('LOCKED · 本机锁'));
  await verifyAlarmReceiptTransition(created.todo_id, webStore, deviceStore);
}

async function verifyAgentScopedWriteSync(baseUrl, webStore) {
  await webStore.saveAgent({
    agentId: '@host-eval-agent',
    name: 'Host Eval Agent',
    endpointUrl: 'http://127.0.0.1:19876',
    credential: 'sec_host_eval_123'
  });
  await webStore.saveAgent({
    agentId: '@host-eval-agent',
    name: 'Host Eval Agent Renamed',
    endpointUrl: 'http://127.0.0.1:19876',
    credential: ''
  });
  const [m1, minted] = await Promise.all([
    webStore.setAgentScopeGrant('@host-eval-agent', { canRead: true }),
    webStore.setAgentScopeGrant('@host-eval-agent', { canWrite: true })
  ]);
  void m1;
  assert.ok(minted.token.startsWith('pck_'));

  const agentClient = createCloudClient({
    getSession: () => ({
      baseUrl,
      token: minted.token,
      source: 'agent'
    })
  });
  const todayIso = webStore.getState().todayIso;
  const agentEv = await agentClient.callRpc('event.set', {
    event_date: todayIso,
    start_hhmm: '16:00',
    end_hhmm: '16:45',
    title: 'Agent Scheduled Briefing',
    location: 'Automated',
    repeat_rule: 'none',
    reminder_policy: 'notify',
    reminder_offset_minutes: 10
  });
  await waitForStore(
    webStore,
    (st) => st.todayEvents.some((e) => e.event_id === agentEv.event_id),
    'webStore receives agent event via SYNC_PUSH'
  );
  const agendaHtml = renderAgendaView(
    webStore.getState(), Date.parse(`${todayIso}T08:00:00`)
  );
  assert.ok(agendaHtml.includes('Agent Scheduled Briefing'));
  assert.ok(agendaHtml.includes('@agent'));
}

function createGatedWebSocket(state) {
  return class GatedWebSocket {
    constructor(url) {
      if (!state.online) {
        this.listeners = { close: [] };
        queueMicrotask(() => {
          for (const fn of this.listeners.close) {
            fn({ code: 1006, reason: 'Offline' });
          }
        });
        return;
      }
      const real = new globalThis.WebSocket(url);
      state.activeSocket = real;
      return real;
    }

    addEventListener(type, fn) {
      if (this.listeners?.[type]) {
        this.listeners[type].push(fn);
      }
    }

    close() {}
  };
}

function createMobileEvalBridge() {
  const armedCalls = [];
  const state = { online: true, activeSocket: null };
  const plugin = {
    syncAlarms: async ({ alarms }) => {
      armedCalls.push(alarms);
      return {
        results: alarms.map((item) => ({
          alarmKey: item.alarmKey,
          entityType: item.entityType,
          entityId: item.entityId,
          status: 'EXECUTED',
          nextTriggerMs: Date.now() + 3600000
        }))
      };
    },
    drainRingingEvents: async () => ({ events: [] }),
    checkPermissions: async () => ({
      exactAlarm: true,
      notifications: true,
      fullScreenIntent: false,
      batteryOptimization: true
    }),
    openPermissionSettings: async ({ target }) => ({ opened: true, target })
  };
  const fetchImpl = (url, init) => (
    state.online
      ? globalThis.fetch(url, init)
      : Promise.reject(new TypeError('Mobile offline'))
  );
  const gatedSocketCtor = createGatedWebSocket(state);
  return { armedCalls, state, plugin, fetchImpl, gatedSocketCtor };
}

async function assertOfflineMobileCreateAndFlush(mob, mobileStore, webStore) {
  mob.state.online = false;
  mob.state.activeSocket?.close(1000, 'Simulated airplane mode');
  await waitForStore(
    mobileStore,
    (st) => st.connectionStatus !== 'online',
    'mobileStore enters offline/reconnecting mode'
  );
  const futureDate = addDaysIso(webStore.getState().todayIso, 3);
  const offlineTodo = await mobileStore.saveTodo({
    text: 'Android Airplane Mode Locked Alarm',
    assignee: '@me',
    schedule_kind: 'once',
    time_hhmm: '06:50',
    once_date: futureDate,
    locked: true
  });
  await waitForStore(
    mobileStore,
    (st) => {
      const td = st.todos.find((t) => t.todo_id === offlineTodo.todo_id);
      return td?.alarm_status === 'EXECUTED';
    },
    'PocketAlarm arms offline todo immediately'
  );
  assert.ok(
    mob.armedCalls.at(-1).some(
      (a) => a.alarmKey === `todo:${offlineTodo.todo_id}`
    )
  );
  mob.state.online = true;
  await waitForStore(
    webStore,
    (st) => {
      const td = st.todos.find((t) => t.todo_id === offlineTodo.todo_id);
      return Boolean(td?.locked && td?.alarm_status === 'EXECUTED');
    },
    'webStore receives flushed LOCK_OVERRIDE + EXECUTED receipt'
  );
}

async function verifyNativeMobileOfflineFlush(baseUrl, webStore) {
  const mob = createMobileEvalBridge();
  const mobileStore = createAppStore({
    isNativeAndroid: true,
    nativeAlarmPlugin: mob.plugin,
    fetchImpl: mob.fetchImpl,
    WebSocketImpl: mob.gatedSocketCtor,
    reconnectBaseMs: 120
  });
  try {
    await waitForStore(
      mobileStore,
      (st) => Boolean(st.nativePermissions?.exactAlarm),
      'mobileStore loads nativePermissions'
    );
    const prePairSettings = renderSettingsView(mobileStore.getState());
    assert.equal(countHero(prePairSettings), 1);
    assert.ok(prePairSettings.includes('id="pair-claim-form"'));
    assert.ok(prePairSettings.includes('DEVICE ALARM PERMISSIONS (4)'));

    const pair = await webStore.createPairingCode();
    await mobileStore.claimPairing({
      baseUrl,
      code: pair.code,
      name: 'AndroidBridgePhone'
    });
    await assertOfflineMobileCreateAndFlush(mob, mobileStore, webStore);
  } finally {
    mobileStore.destroy();
  }
}

async function runHostWebEval(baseUrl, bootstrapToken) {
  const adminClient = createCloudClient({
    getSession: () => ({ baseUrl, token: bootstrapToken, source: 'web' })
  });
  const webTok = await adminClient.callRpc('token.create', {
    kind: 'web',
    label: 'HostEvalWebSession'
  });
  const webStore = createAppStore({ reconnectBaseMs: 200 });
  const deviceStore = createAppStore({ reconnectBaseMs: 200 });
  try {
    await webStore.connectCloud({
      baseUrl,
      token: webTok.token,
      source: 'web'
    });
    assert.equal(webStore.getState().connectionStatus, 'online');
    assert.ok(buildTtyBarHtml(webStore.getState()).statHtml.includes('ONLINE'));

    await verifyEventsAndViews(webStore);
    await verifyPairingLockAndReceipt(baseUrl, webStore, deviceStore);
    await verifyAgentScopedWriteSync(baseUrl, webStore);
    await verifyNativeMobileOfflineFlush(baseUrl, webStore);
  } finally {
    webStore.destroy();
    deviceStore.destroy();
  }
}

async function main() {
  const env = process.env;
  const baseUrl = env.POCKET_EVAL_URL;
  const token = env.POCKET_EVAL_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('POCKET_EVAL_URL and POCKET_EVAL_TOKEN are required');
  }
  await runHostWebEval(baseUrl, token);
  console.log(JSON.stringify({ ok: true, gate: 'eval_web.mjs' }));
}

main();
