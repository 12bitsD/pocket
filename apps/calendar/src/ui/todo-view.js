import { DOW_LABELS, escapeHtml } from '../domain/date-time.js';
import {
  TODO_SCHEDULES,
  describeTodoStatus,
  isAgentAssignee,
  isLocalSessionState,
  isRecurringTodo,
  isTodoActive,
  isTodoRetreated,
  summarizeTodos
} from '../domain/todo-model.js';

function buildComposerWhenHtml(composer) {
  if (composer.target === 'none') {
    return '';
  }
  const schedOpts = TODO_SCHEDULES.map((label) => {
    const sel = label === composer.schedule ? 'selected' : '';
    return `<option value="${label}" ${sel}>${label}</option>`;
  }).join('');
  let extraInput = '';
  if (composer.schedule === '指定日期') {
    extraInput = `<input id="quick-date" type="date" ` +
      `value="${escapeHtml(composer.date)}" aria-label="指定日期">`;
  } else if (composer.schedule === '每周') {
    const dowOpts = DOW_LABELS.map((name, idx) => {
      const sel = idx === Number(composer.weeklyDow) ? 'selected' : '';
      return `<option value="${idx}" ${sel}>${name}</option>`;
    }).join('');
    extraInput = `<select id="quick-dow" aria-label="星期">${dowOpts}</select>`;
  }
  const hint = composer.target === '@me'
    ? '→ 本机准点响铃'
    : `→ 云端发给 ${escapeHtml(composer.target)}`;
  return `<div class="composer-when">
    <span>${hint}</span>
    <div class="date-shortcuts">
      <select id="quick-schedule" aria-label="触发周期">${schedOpts}</select>
      ${extraInput}
      <input id="quick-time" type="time"
        value="${escapeHtml(composer.time)}" aria-label="触发时间">
    </div>
  </div>`;
}

function buildComposerHtml(state, composer) {
  const activeAgents = state.agentGrants.filter((ag) => ag.active !== false);
  const targets = [
    ['none', '仅待办', ''],
    ['@me', '@me 响铃', 'me'],
    ...activeAgents.map((ag) => [ag.agent_id, ag.agent_id, ''])
  ];
  const pills = targets.map(([id, label, cls]) => (
    `<button class="route-pill ${cls}" type="button" ` +
    `data-quick-target="${escapeHtml(id)}" ` +
    `aria-pressed="${composer.target === id}">${escapeHtml(label)}</button>`
  )).join('');
  return `<form class="composer-card" id="quick-todo-form">
    <div class="composer-top">
      <input class="composer-input" id="quick-todo-input" enterkeyhint="done"
        placeholder="写待办，或输入 @me / @agent 16:00…"
        value="${escapeHtml(composer.text)}" autocomplete="off" required>
      <button class="cmd-primary" type="submit">↵ 添加</button>
    </div>
    <div class="composer-bar">
      <div class="route-pills">${pills}</div>
    </div>
    ${buildComposerWhenHtml(composer)}
  </form>`;
}

function buildTodoTagsHtml(item) {
  const tags = [];
  if (item.locked) {
    tags.push('<span class="mark-tag lock">LOCKED · 本机锁</span>');
  }
  const hhmm = escapeHtml(item.time_hhmm);
  if (item.assignee === '@me') {
    tags.push(`<span class="mark-tag lock">@me · ${hhmm} 响铃</span>`);
  } else if (item.assignee !== 'none') {
    const who = escapeHtml(item.assignee);
    tags.push(`<span class="mark-tag neutral">${who} · ${hhmm}</span>`);
  }
  return tags.join(' ');
}

function buildTodoLeftControl(item, lockedBlocked) {
  const disAttr = lockedBlocked ? 'disabled' : '';
  const id = escapeHtml(item.todo_id);
  const label = escapeHtml(item.text);
  if (isRecurringTodo(item)) {
    return `<button class="todo-switch" type="button" ${disAttr} ` +
      `aria-label="启停${label}" aria-pressed="${Boolean(item.enabled)}" ` +
      `data-switch-todo="${id}">${item.enabled ? 'ON' : 'OFF'}</button>`;
  }
  return `<button class="todo-check" type="button" ${disAttr} ` +
    `aria-label="完成${label}" aria-pressed="${Boolean(item.done)}" ` +
    `data-toggle-todo="${id}">${item.done ? '✓' : ''}</button>`;
}

function resolveTodoRowClass(item) {
  if (!isRecurringTodo(item) && item.done) {
    return 'done';
  }
  return isTodoRetreated(item) ? 'paused' : '';
}

function buildInlineTriggerFoot(item, state, lockedBlocked) {
  const allowed = state.mode === 'cloud' &&
    isAgentAssignee(item.assignee) &&
    !lockedBlocked;
  if (!allowed) {
    return '';
  }
  return `<div class="todo-foot">` +
    `<button class="cmd-quiet outlined mini" type="button" ` +
    `data-trigger-todo="${escapeHtml(item.todo_id)}">立即触发</button></div>`;
}

function buildTodoRowHtml(item, state) {
  const lockedBlocked = Boolean(item.locked) && !isLocalSessionState(state);
  const desc = describeTodoStatus(item, state.todayIso);
  const dotHtml = item.assignee === 'none'
    ? ''
    : `<i class="dot ${desc.dotClass}"></i> `;
  const receiptHtml = item.result_summary
    ? `<div class="todo-receipt">↳ ${escapeHtml(item.result_summary)}</div>`
    : '';
  const id = escapeHtml(item.todo_id);
  return `<article class="todo-row ${resolveTodoRowClass(item)}">
    ${buildTodoLeftControl(item, lockedBlocked)}
    <div class="stack-sm">
      <button class="todo-body-btn" type="button" data-edit-todo="${id}">
        <div class="todo-head">
          <span class="todo-title">${escapeHtml(item.text)}</span>
          <span class="inline-actions">${buildTodoTagsHtml(item)}</span>
        </div>
        <span class="todo-sub">${dotHtml}${escapeHtml(desc.subtitle)}</span>
        ${receiptHtml}
      </button>
      ${buildInlineTriggerFoot(item, state, lockedBlocked)}
    </div>
  </article>`;
}

function buildGroupedTodoRows(todos, state) {
  const active = todos.filter((item) => isTodoActive(item));
  const retreated = todos.filter((item) => !isTodoActive(item));
  const actHtml = active.map((item) => buildTodoRowHtml(item, state)).join('');
  if (retreated.length === 0) {
    return `<div class="rows">${actHtml}</div>`;
  }
  const retHtml = retreated
    .map((item) => buildTodoRowHtml(item, state))
    .join('');
  const divLabel = `RETREATED · 已完成或暂停 (${retreated.length})`;
  const divider = active.length > 0
    ? `<div class="sub-divider">${divLabel}</div>`
    : '';
  return `<div class="rows">${actHtml}${divider}${retHtml}</div>`;
}

export function renderTodoView(state, composerState) {
  const composer = composerState || {
    target: '@me',
    time: '07:30',
    schedule: '工作日',
    date: state.todayIso,
    weeklyDow: 5,
    text: ''
  };
  const emptyHtml = '<div class="empty">暂无待办或唤醒任务<br>' +
    '<span class="row-meta">' +
    '在上方输入事项，支持敲 @me 07:30 或 明天 / 工作日</span></div>';
  const summary = state.todoSummary || summarizeTodos(state.todos);
  const listSection = state.todos.length > 0
    ? buildGroupedTodoRows(state.todos, state)
    : emptyHtml;
  return `<div class="foreground-stack">
    ${buildComposerHtml(state, composer)}
    <div class="col-head">
      <span>OPEN ${summary.openCount} · CYCLES ${summary.cycleCount}</span>
      <span>ASSIGNEE / ROUTE</span>
    </div>
    ${listSection}
  </div>`;
}
