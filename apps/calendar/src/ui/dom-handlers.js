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

export { runSafely, showToast, showUndoToast, toggleSecretInput };

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
    const timeEl = ui.doc.querySelector('#quick-time');
    if (timeEl) {
      timeEl.value = parsed.time;
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
    runSafely(ui, ui.store.saveTodo(draft), '已保存 Todo', { trigger });
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

function handleAgentGrantClick(ui, target) {
  const grantRead = target.closest('[data-grant-read]');
  const grantWrite = target.closest('[data-grant-write]');
  const btn = grantRead || grantWrite;
  if (!btn) {
    return false;
  }
  const id = btn.dataset.grantRead || btn.dataset.grantWrite;
  const cur = ui.store.getState().agentGrants.find((a) => a.agent_id === id);
  if (cur) {
    const patch = grantRead
      ? { canRead: !cur.canRead }
      : { canWrite: !cur.canWrite };
    const call = ui.store.setAgentScopeGrant(id, patch);
    runSafely(ui, call, 'Agent 权限已更新', { trigger: btn });
  }
  return true;
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

function handleTokenSettingsClick(ui, target) {
  const secretBtn = target.closest('[data-toggle-secret]');
  if (secretBtn) {
    toggleSecretInput(ui.doc.querySelector('#content'), secretBtn);
    return true;
  }
  const revTok = target.closest('[data-revoke-token]');
  if (revTok) {
    const call = ui.store.revokeToken(revTok.dataset.revokeToken);
    runSafely(ui, call, '令牌已吊销', { trigger: revTok });
    return true;
  }
  const mintBtn = target.closest('[data-mint-web-token]');
  if (mintBtn) {
    const call = ui.store.createScopedToken({
      kind: 'web',
      label: 'Browser Web'
    });
    runSafely(ui, call, '已签发 Web 令牌', { trigger: mintBtn });
    return true;
  }
  const copyTok = target.closest('[data-copy-token]');
  if (copyTok) {
    copyTokenToClipboard(ui, copyTok.dataset.copyToken);
    return true;
  }
  if (target.closest('[data-dismiss-token]')) {
    ui.store.clearMintedToken();
    return true;
  }
  return false;
}

function handlePermissionClick(ui, target) {
  const refBtn = target.closest('[data-perm-refresh]');
  if (refBtn) {
    const call = ui.store.refreshNativePermissions();
    runSafely(ui, call, '已完成权限自检', { trigger: refBtn });
    return true;
  }
  const permJump = target.closest('[data-perm-jump]');
  if (permJump) {
    const call = ui.store.openNativePermission(permJump.dataset.permJump);
    runSafely(ui, call, '', { trigger: permJump });
    return true;
  }
  return false;
}

function handleSettingsClick(ui, target) {
  const handledSub = handlePermissionClick(ui, target) ||
    handleAgentGrantClick(ui, target) ||
    handleTokenSettingsClick(ui, target);
  if (handledSub) {
    return true;
  }
  const authTab = target.closest('[data-auth-tab]');
  if (authTab) {
    ui.prefs.authTab = authTab.dataset.authTab;
    ui.render();
    return true;
  }
  const pairBtn = target.closest('[data-create-pair]');
  if (pairBtn) {
    const call = ui.store.createPairingCode();
    runSafely(ui, call, '已生成 6 位配对码', { trigger: pairBtn });
    return true;
  }
  if (target.closest('[data-disconnect-cloud]')) {
    ui.store.disconnectCloud();
    showToast(ui, '已切回本地演示模式');
    return true;
  }
  if (target.closest('[data-open-agent]')) {
    ui.openModal('agent', null);
    return true;
  }
  const editAg = target.closest('[data-edit-agent]');
  if (editAg) {
    ui.openModal('agent', editAg.dataset.editAgent);
    return true;
  }
  const revAg = target.closest('[data-revoke-agent]');
  if (revAg) {
    const call = ui.store.revokeAgent(revAg.dataset.revokeAgent);
    runSafely(ui, call, '已停用', { trigger: revAg });
    return true;
  }
  return false;
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
    const call = ui.store.refreshMonthRange(
      next.viewYear, next.viewMonth, iso
    );
    runSafely(ui, call, '');
    return;
  }
  ui.store.setViewState({ focusDate: iso });
}

function handleCalendarClick(ui, target) {
  const editEv = target.closest('[data-edit]');
  if (editEv) {
    ui.openModal('event', editEv.dataset.edit);
    return true;
  }
  if (target.closest('[data-open-event]')) {
    ui.openModal('event', null);
    return true;
  }
  const pickDate = target.closest('[data-pick-date]');
  if (pickDate) {
    selectCalendarDate(ui, pickDate.dataset.pickDate);
    return true;
  }
  const monthStep = target.closest('[data-month-step]');
  if (monthStep) {
    stepMonthView(ui, Number(monthStep.dataset.monthStep));
    return true;
  }
  if (target.closest('[data-month-today]')) {
    selectCalendarDate(ui, ui.store.getState().todayIso);
    return true;
  }
  return false;
}

export function handleContentClick(ui, event) {
  const target = event.target;
  if (handleSettingsClick(ui, target) || handleCalendarClick(ui, target)) {
    return;
  }
  const qTarget = target.closest('[data-quick-target]');
  if (qTarget) {
    ui.composer.target = qTarget.dataset.quickTarget;
    ui.render();
    return;
  }
  const togTodo = target.closest('[data-toggle-todo], [data-switch-todo]');
  if (togTodo) {
    const id = togTodo.dataset.toggleTodo || togTodo.dataset.switchTodo;
    runSafely(ui, ui.store.toggleTodo(id), '', { trigger: togTodo });
    return;
  }
  const trigTd = target.closest('[data-trigger-todo]');
  if (trigTd) {
    const call = ui.store.triggerAgentTodo(trigTd.dataset.triggerTodo);
    runSafely(ui, call, '已触发投递', { trigger: trigTd });
    return;
  }
  const editTd = target.closest('[data-edit-todo]');
  if (editTd) {
    ui.openModal('todo', editTd.dataset.editTodo);
  }
}
