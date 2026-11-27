import { dateViewPatch } from '../domain/date-time.js';
import {
  cleanInlineTokens,
  parseInlineSchedule,
  parseInlineTokens
} from '../domain/todo-model.js';
import {
  runSafely,
  showToast,
  showUndoToast,
  toggleSecretInput
} from './mobile-ux.js';
import { handlePickerClick, syncPickerDisplay } from './pickers.js';
import { formatComposerWhenSummary } from './todo-view.js';

export { runSafely, showToast, showUndoToast, toggleSecretInput };

function syncComposerWhenSummaryText(content, composer) {
  const label = content?.querySelector('[data-composer-when-text]');
  if (label) {
    label.textContent = formatComposerWhenSummary(composer);
  }
}

function applyInlineSchedulePatch(ui, rawText) {
  const sched = parseInlineSchedule(rawText);
  if (!sched) {
    return false;
  }
  let changed = false;
  if (sched.schedule !== ui.composer.schedule) {
    ui.composer.schedule = sched.schedule;
    changed = true;
  }
  if (sched.weeklyDow !== null && sched.weeklyDow !== ui.composer.weeklyDow) {
    ui.composer.weeklyDow = sched.weeklyDow;
    changed = true;
  }
  return changed;
}

function syncInlineComposerTokens(ui, target) {
  const agentIds = ui.store.getState().agentGrants.map((a) => a.agent_id);
  const parsed = parseInlineTokens(ui.composer.text, agentIds);
  let rerender = applyInlineSchedulePatch(ui, ui.composer.text);
  if (parsed.target && parsed.target !== ui.composer.target) {
    ui.composer.target = parsed.target;
    rerender = true;
  }
  if (parsed.time && parsed.time !== ui.composer.time) {
    ui.composer.time = parsed.time;
    const content = ui.doc.querySelector('#content');
    if (content?.querySelector('#quick-time')) {
      syncPickerDisplay(content, 'quick-time', parsed.time, 'time');
      syncComposerWhenSummaryText(content, ui.composer);
    } else {
      rerender = true;
    }
  }
  if (!rerender) {
    return;
  }
  const pos = target.selectionStart ?? ui.composer.text.length;
  ui.render();
  const nextEl = ui.doc.querySelector('#quick-todo-input');
  nextEl?.focus();
  nextEl?.setSelectionRange(pos, pos);
}

export function handleComposerInput(ui, event) {
  const target = event.target;
  if (target.id === 'quick-todo-input') {
    ui.composer.text = target.value;
    syncInlineComposerTokens(ui, target);
    return;
  }
  if (target.id === 'quick-time') {
    ui.composer.time = target.value;
    return;
  }
  if (target.id === 'quick-schedule') {
    ui.composer.schedule = target.value;
    ui.render();
    return;
  }
  if (target.id === 'quick-date') {
    ui.composer.date = target.value;
    return;
  }
  if (target.id === 'quick-dow') {
    ui.composer.weeklyDow = Number(target.value);
  }
}

export function handleContentSubmit(ui, event) {
  const formEl = event.target;
  const trigger = formEl.querySelector?.('button[type="submit"]');
  if (formEl.id === 'quick-todo-form') {
    event.preventDefault();
    const agentIds = ui.store.getState().agentGrants.map((a) => a.agent_id);
    const text = cleanInlineTokens(ui.composer.text, agentIds) ||
      ui.composer.text.trim();
    if (!text) {
      return;
    }
    const draft = {
      text,
      assignee: ui.composer.target,
      schedule: ui.composer.schedule,
      time_hhmm: ui.composer.time,
      once_date: ui.composer.date,
      weekly_dow: ui.composer.weeklyDow
    };
    ui.composer.text = '';
    ui.composer.whenOpen = false;
    const msg = ui.composer.target === '@me'
      ? `已设闹钟 · ${ui.composer.schedule} ${ui.composer.time}`
      : '已保存 Todo';
    runSafely(ui, ui.store.saveTodo(draft), msg, { trigger });
    return;
  }
  if (formEl.id === 'cloud-login-form') {
    event.preventDefault();
    const fd = new FormData(formEl);
    const call = ui.store.connectCloud({
      baseUrl: fd.get('baseUrl'),
      token: fd.get('token')
    });
    runSafely(ui, call, '已连接 Pocket Cloud', { trigger });
    return;
  }
  if (formEl.id === 'pair-claim-form') {
    event.preventDefault();
    const fd = new FormData(formEl);
    const call = ui.store.claimPairing({
      baseUrl: fd.get('baseUrl'),
      code: fd.get('code'),
      name: fd.get('name')
    });
    runSafely(ui, call, '配对成功，本机设备密钥已激活', { trigger });
  }
}

function toggleAgentGrant(ui, btn, agentId, field) {
  const cur = ui.store.getState().agentGrants
    .find((a) => a.agent_id === agentId);
  if (cur) {
    const call = ui.store.setAgentScopeGrant(agentId, { [field]: !cur[field] });
    runSafely(ui, call, 'Agent 权限已更新', { trigger: btn });
  }
}

function copyTokenToClipboard(ui, secret) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    showToast(ui, '当前环境不支持自动复制，请长按或全选复制');
    return;
  }
  navigator.clipboard.writeText(secret)
    .then(() => showToast(ui, '已复制到剪贴板'))
    .catch(() => showToast(ui, '复制被拦截，请手动全选复制'));
}

export function stepMonthView(ui, delta) {
  const st = ui.store.getState();
  const dt = new Date(st.viewYear, st.viewMonth + delta, 1);
  const call = ui.store.refreshMonthRange(dt.getFullYear(), dt.getMonth());
  runSafely(ui, call, '');
}

export function selectCalendarDate(ui, iso) {
  const st = ui.store.getState();
  const next = dateViewPatch(iso);
  if (next.viewYear !== st.viewYear || next.viewMonth !== st.viewMonth) {
    const call = ui.store.refreshMonthRange(next.viewYear, next.viewMonth, iso);
    runSafely(ui, call, '');
    return;
  }
  ui.store.setViewState({ focusDate: iso });
}

function handleCheckAppUpdate(ui, btn) {
  runSafely(ui, ui.store.checkAppUpdate(), '', {
    trigger: btn,
    onOk: (res) => {
      const msg = res?.available
        ? `发现新版 v${res.release.version_name}`
        : '当前已是最新版本';
      showToast(ui, msg);
    }
  });
}

function handleInstallAppUpdate(ui, btn) {
  runSafely(ui, ui.store.installAppUpdate(), '', {
    trigger: btn,
    onOk: (res) => {
      const msg = res?.status === 'PERMISSION_REQUIRED'
        ? '请开启「允许安装未知应用」后再次点击更新'
        : '下载校验完成，正在调起系统安装器…';
      showToast(ui, msg);
    }
  });
}

const CLICK_HANDLERS = [
  ['[data-check-app-update]', handleCheckAppUpdate],
  ['[data-install-app-update]', handleInstallAppUpdate],
  ['[data-dismiss-app-update]', (ui) => ui.store.dismissAppUpdate()],
  ['[data-open-settings]', (ui) => ui.navigate?.('settings')],
  ['[data-set-theme]', (ui, btn) => ui.store.setTheme(btn.dataset.setTheme)],
  ['[data-toggle-composer-when]', (ui) => {
    ui.composer.whenOpen = !ui.composer.whenOpen;
    ui.render();
  }],
  ['[data-perm-test-ring]', (ui, btn) => runSafely(
    ui, ui.store.triggerTestAlarm(), '已触发测试响铃', { trigger: btn }
  )],
  ['[data-perm-refresh]', (ui, btn) => runSafely(
    ui, ui.store.refreshNativePermissions(), '已完成权限自检', { trigger: btn }
  )],
  ['[data-perm-jump]', (ui, btn) => runSafely(
    ui, ui.store.openNativePermission(btn.dataset.permJump), '',
    { trigger: btn }
  )],
  ['[data-grant-read]', (ui, btn) => toggleAgentGrant(
    ui, btn, btn.dataset.grantRead, 'canRead'
  )],
  ['[data-grant-write]', (ui, btn) => toggleAgentGrant(
    ui, btn, btn.dataset.grantWrite, 'canWrite'
  )],
  ['[data-toggle-secret]', (ui, btn) => toggleSecretInput(
    ui.doc.querySelector('#content'), btn
  )],
  ['[data-revoke-token]', (ui, btn) => runSafely(
    ui, ui.store.revokeToken(btn.dataset.revokeToken), '令牌已吊销',
    { trigger: btn }
  )],
  ['[data-mint-web-token]', (ui, btn) => runSafely(
    ui,
    ui.store.createScopedToken({ kind: 'web', label: 'Browser Web' }),
    '已签发 Web 令牌',
    { trigger: btn }
  )],
  ['[data-copy-token]', (ui, btn) => copyTokenToClipboard(
    ui, btn.dataset.copyToken
  )],
  ['[data-dismiss-token]', (ui) => ui.store.clearMintedToken()],
  ['[data-auth-tab]', (ui, btn) => {
    ui.prefs.authTab = btn.dataset.authTab;
    ui.render();
  }],
  ['[data-create-pair]', (ui, btn) => runSafely(
    ui, ui.store.createPairingCode(), '已生成 6 位配对码', { trigger: btn }
  )],
  ['[data-disconnect-cloud]', (ui) => {
    ui.store.disconnectCloud();
    showToast(ui, '已切回本地演示模式');
  }],
  ['[data-open-agent]', (ui) => ui.openModal('agent', null)],
  ['[data-edit-agent]', (ui, btn) => ui.openModal(
    'agent', btn.dataset.editAgent
  )],
  ['[data-revoke-agent]', (ui, btn) => runSafely(
    ui, ui.store.revokeAgent(btn.dataset.revokeAgent), '已停用',
    { trigger: btn }
  )],
  ['[data-edit]', (ui, btn) => ui.openModal('event', btn.dataset.edit)],
  ['[data-open-event]', (ui) => ui.openModal('event', null)],
  ['[data-pick-date]', (ui, btn) => selectCalendarDate(
    ui, btn.dataset.pickDate
  )],
  ['[data-month-step]', (ui, btn) => stepMonthView(
    ui, Number(btn.dataset.monthStep)
  )],
  ['[data-month-today]', (ui) => selectCalendarDate(
    ui, ui.store.getState().todayIso
  )],
  ['[data-quick-target]', (ui, btn) => {
    ui.composer.target = btn.dataset.quickTarget;
    ui.render();
  }],
  ['[data-quick-schedule]', (ui, btn) => {
    ui.composer.schedule = btn.dataset.quickSchedule;
    ui.render();
  }],
  ['[data-quick-dow]', (ui, btn) => {
    ui.composer.weeklyDow = Number(btn.dataset.quickDow);
    ui.render();
  }],
  ['[data-toggle-todo], [data-switch-todo]', (ui, btn) => {
    const id = btn.dataset.toggleTodo || btn.dataset.switchTodo;
    runSafely(ui, ui.store.toggleTodo(id), '', { trigger: btn });
  }],
  ['[data-trigger-todo]', (ui, btn) => runSafely(
    ui,
    ui.store.triggerAgentTodo(btn.dataset.triggerTodo),
    '已触发投递',
    { trigger: btn }
  )],
  ['[data-edit-todo]', (ui, btn) => ui.openModal('todo', btn.dataset.editTodo)]
];

export function handleContentClick(ui, event) {
  const content = ui.doc.querySelector('#content');
  const todayIso = ui.store.getState().todayIso;
  const picked = handlePickerClick(content, event, todayIso, (tid, val) => {
    if (tid === 'quick-time') {
      ui.composer.time = val;
      syncComposerWhenSummaryText(content, ui.composer);
    } else if (tid === 'quick-date') {
      ui.composer.date = val;
      syncComposerWhenSummaryText(content, ui.composer);
    }
  });
  if (picked) {
    return;
  }
  for (const [selector, handler] of CLICK_HANDLERS) {
    const btn = event.target.closest(selector);
    if (btn) {
      handler(ui, btn);
      return;
    }
  }
}
