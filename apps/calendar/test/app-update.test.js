import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppStore } from '../src/state/app-store.js';
import { renderAgendaView } from '../src/ui/agenda-month-view.js';
import { renderSettingsView } from '../src/ui/settings-view.js';
import {
  createDeviceServerHarness,
  makeJsonResponse
} from './helpers/store-test-kit.js';

function makeNativePlugin(versionCode, installOutcome) {
  const installs = [];
  return {
    installs,
    syncAlarms: async () => ({ results: [] }),
    drainRingingEvents: async () => ({ events: [] }),
    checkPermissions: async () => ({
      exactAlarm: true,
      notifications: true,
      fullScreenIntent: true,
      batteryOptimization: true
    }),
    getAppInfo: async () => ({
      versionName: '0.2.0',
      versionCode,
      canInstallUpdates: true
    }),
    installAppUpdate: async (spec) => {
      installs.push(spec);
      return installOutcome || { status: 'INSTALLER_LAUNCHED' };
    }
  };
}

function makeUpdateHarness(latestRelease) {
  const base = createDeviceServerHarness();
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/v1/app/latest')) {
      return makeJsonResponse(200, { data: latestRelease });
    }
    return base.fetchImpl(url, init);
  };
  return { ...base, fetchImpl };
}

test('receives live APP_UPDATE WS push and invokes SHA-256 native installer',
  async () => {
    const plugin = makeNativePlugin(20099);
    const release = {
      version_name: '0.2.1',
      version_code: 20199,
      sha256: 'deadbeef',
      notes: '修好闹钟',
      download_path: '/v1/app/download/0.2.1'
    };
    const h = makeUpdateHarness(release);
    const store = createAppStore({
      isNativeAndroid: true,
      nativeAlarmPlugin: plugin,
      fetchImpl: h.fetchImpl,
      WebSocketImpl: h.socketCtor,
      reconnectBaseMs: 20
    });
    await store.connectCloud({
      baseUrl: 'https://pocket.local',
      token: 'pck_test'
    });
    const ws = h.sockets.at(-1);
    ws.emit('message', {
      data: JSON.stringify({ type: 'APP_UPDATE', release })
    });
    await new Promise((r) => setTimeout(r, 20));
    const st = store.getState();
    assert.equal(st.appUpdate?.version_name, '0.2.1');
    assert.ok(renderAgendaView(st).includes('发现新版 v0.2.1'));
    assert.ok(renderSettingsView(st).includes('有新版 v0.2.1'));

    const res = await store.installAppUpdate();
    assert.equal(res.status, 'INSTALLER_LAUNCHED');
    assert.equal(plugin.installs.length, 1);
    assert.equal(
      plugin.installs[0].url, 'https://pocket.local/v1/app/download/0.2.1'
    );
    assert.equal(plugin.installs[0].token, 'pck_test');
    assert.equal(plugin.installs[0].sha256, 'deadbeef');

    store.dismissAppUpdate();
    assert.equal(
      renderAgendaView(store.getState()).includes('发现新版 v0.2.1'), false
    );
    const manual = await store.checkAppUpdate();
    assert.equal(manual.available, true);
    assert.equal(manual.release.version_name, '0.2.1');
    store.destroy();
  });

test('ignores older or equal APP_UPDATE versions', async () => {
  const plugin = makeNativePlugin(20199);
  const h = makeUpdateHarness(null);
  const store = createAppStore({
    isNativeAndroid: true,
    nativeAlarmPlugin: plugin,
    fetchImpl: h.fetchImpl,
    WebSocketImpl: h.socketCtor,
    reconnectBaseMs: 20
  });
  await store.connectCloud({
    baseUrl: 'https://pocket.local',
    token: 'pck_test'
  });
  h.sockets.at(-1).emit('message', {
    data: JSON.stringify({
      type: 'APP_UPDATE',
      release: {
        version_name: '0.2.1',
        version_code: 20199,
        sha256: 'abc',
        download_path: '/v1/app/download/0.2.1'
      }
    })
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getState().appUpdate, null);
  store.destroy();
});
