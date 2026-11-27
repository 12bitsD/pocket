import { addDaysIso, pad2 } from '../domain/date-time.js';
import { normalizeTodoTags } from '../domain/todo-model.js';
import { runSafely, showToast } from './mobile-ux.js';

function nextDefaultAlarmHhmm() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const next = (Math.ceil((mins + 5) / 10) * 10) % 1440;
  return `${pad2(Math.floor(next / 60))}:${pad2(next % 60)}`;
}

export function buildInitialUiState(doc, store) {
  const initState = store.getState();
  const preferClaim = Boolean(initState.isNativeAndroid) ||
    (initState.isLocalDevice && initState.mode === 'cloud');
  return {
    doc,
    store,
    editingId: null,
    toastTimer: null,
    undoAction: null,
    pendingAnim: '',
    chromeCache: {
      path: '',
      stat: '',
      navPage: '',
      uPage: '',
      uDate: '',
      uPool: null,
      uTodos: null
    },
    prefs: {
      authTab: preferClaim ? 'claim' : 'login',
      todoTagFilter: '',
      openFolds: new Set(),
      closedFolds: new Set()
    },
    composer: {
      target: '@me',
      time: nextDefaultAlarmHhmm(),
      schedule: '今天',
      date: addDaysIso(initState.todayIso, 1),
      weeklyDow: 5,
      whenOpen: false,
      text: ''
    },
    render: null,
    openModal: null,
    navigate: null,
    destroy: null
  };
}

export function handleFoldToggle(ui, event) {
  const details = event?.target;
  const foldId = details?.dataset?.foldId;
  if (!foldId || !ui.prefs) {
    return;
  }
  if (!ui.prefs.openFolds) {
    ui.prefs.openFolds = new Set();
  }
  if (!ui.prefs.closedFolds) {
    ui.prefs.closedFolds = new Set();
  }
  if (details.open) {
    ui.prefs.openFolds.add(foldId);
    ui.prefs.closedFolds.delete(foldId);
  } else {
    ui.prefs.openFolds.delete(foldId);
    ui.prefs.closedFolds.add(foldId);
  }
}

export function handleDialogTagChipClick(form, btn) {
  const tag = btn.dataset.dialogTag;
  const input = form.querySelector('#td-tags');
  if (!tag || !input) {
    return;
  }
  const tags = normalizeTodoTags(input.value);
  const exists = tags.includes(tag);
  const next = exists ? tags.filter((t) => t !== tag) : [...tags, tag];
  input.value = next.join(' ');
  btn.setAttribute('aria-pressed', String(!exists));
}

export function handleFeishuDialogSubmit(ui, fd, trigger, closeFn) {
  const appId = String(fd.get('appId') || '').trim();
  const appSecret = String(fd.get('appSecret') || '').trim();
  const task = ui.store.configureFeishu({ appId, appSecret })
    .then(() => ui.store.startFeishuOAuth());
  runSafely(ui, task, '已保存凭据，请在飞书完成授权', {
    trigger,
    onOk: closeFn
  });
}

function handleFeishuConnectClick(ui, btn) {
  const feishu = (ui.store.getState().integrations || [])
    .find((item) => item.provider === 'feishu');
  if (feishu?.configured) {
    runSafely(
      ui,
      ui.store.startFeishuOAuth(),
      '已打开飞书授权页，完成后自动同步',
      { trigger: btn }
    );
    return;
  }
  ui.openModal('feishu', null);
}

function handleFeishuSyncClick(ui, btn) {
  runSafely(ui, ui.store.syncFeishuNow(), '', {
    trigger: btn,
    onOk: (st) => {
      const msg = `飞书同步完成 · 新增 ${st?.imported || 0} / 更新 ${st?.updated || 0}`;
      showToast(ui, msg);
    }
  });
}

function handleScanPairClick(ui, btn) {
  runSafely(ui, ui.store.scanAndClaimPairing('My Phone'), '', {
    trigger: btn,
    onOk: (res) => {
      if (!res?.cancelled) {
        showToast(ui, '扫码配对成功，已连接 Pocket Cloud');
      }
    }
  });
}

export function handleExtraContentClick(ui, event) {
  const filterBtn = event.target.closest('[data-filter-tag]');
  if (filterBtn) {
    ui.prefs.todoTagFilter = filterBtn.dataset.filterTag || '';
    ui.render();
    return true;
  }
  const scanBtn = event.target.closest('[data-scan-pair-qr]');
  if (scanBtn) {
    handleScanPairClick(ui, scanBtn);
    return true;
  }
  const connBtn = event.target.closest('[data-feishu-connect]');
  if (connBtn) {
    handleFeishuConnectClick(ui, connBtn);
    return true;
  }
  const syncBtn = event.target.closest('[data-feishu-sync]');
  if (syncBtn) {
    handleFeishuSyncClick(ui, syncBtn);
    return true;
  }
  const unbindBtn = event.target.closest('[data-feishu-unbind]');
  if (unbindBtn) {
    runSafely(ui, ui.store.unbindFeishu(), '已解绑飞书日历', {
      trigger: unbindBtn
    });
    return true;
  }
  return false;
}

export function attachPairDeepLinkHandler(ui) {
  const claim = (rawUri) => {
    if (!rawUri) {
      return;
    }
    runSafely(
      ui,
      ui.store.claimPairUri(rawUri, 'My Phone'),
      '扫码配对成功，已连接 Pocket Cloud'
    );
  };
  if (typeof window !== 'undefined') {
    window.__pocketOnPairUri = claim;
  }
  const plugin = globalThis?.Capacitor?.Plugins?.PocketAlarm;
  plugin?.consumePendingPairUri?.()
    .then((res) => claim(res?.uri))
    .catch(() => {});
}
