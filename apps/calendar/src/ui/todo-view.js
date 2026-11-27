import { DOW_LABELS, escapeHtml } from '../domain/date-time.js';
import {
  TODO_SCHEDULES,
  describeTodoStatus,
  isAgentAssignee,
  isLocalSessionState,
  isRecurringTodo,
  isTodoActive,
  isTodoRetreated,
  normalizeTodoTags,
  summarizeTodos
} from '../domain/todo-model.js';
import { buildAppUpdateBannerHtml } from '../native/update-bridge.js';
import { buildDateFieldHtml, buildTimeFieldHtml } from './pickers.js';

function buildQuickDowChips(weeklyDow) {
  const btns = DOW_LABELS.map((name, idx) => (
    `<button class="tray-btn" type="button" data-quick-dow="${idx}" ` +
    `aria-pressed="${idx === Number(weeklyDow)}">${name.slice(-1)}</button>`
  )).join('');
  return `<div class="tray-grid cols-7">${btns}</div>`;
}

export function formatComposerWhenSummary(composer) {
  let sched = composer.schedule || '今天';
  if (sched === '每周') {
    sched = `每${DOW_LABELS[Number(composer.weeklyDow ?? 5)] || '周五'}`;
  } else if (sched === '指定日期' && composer.date) {
    sched = composer.date.slice(5);
  }
  return `${sched} ${composer.time}`;
}

function buildComposerWhenPanelHtml(composer) {
  if (composer.target === 'none' || !composer.whenOpen) {
    return '';
  }
  const schedPills = TODO_SCHEDULES.map((label) => (
    `<button class="tray-btn" type="button" ` +
    `data-quick-schedule="${label}" ` +
    `aria-pressed="${label === composer.schedule}">${label}</button>`
  )).join('');
  let extra = '';
  if (composer.schedule === '指定日期') {
    extra = buildDateFieldHtml({
      id: 'quick-date',
      name: 'quickDate',
      value: composer.date,
      ariaLabel: '指定日期'
    });
  } else if (composer.schedule === '每周') {
    extra = buildQuickDowChips(composer.weeklyDow);
  }
  const timeField = buildTimeFieldHtml({
    id: 'quick-time',
    name: 'quickTime',
    value: composer.time,
    ariaLabel: '触发时间',
    compact: true
  });
  return `<div class="composer-when">
    <div class="tray-grid cols-3">${schedPills}</div>
    ${extra}
    ${timeField}
  </div>`;
}

function buildComposerHtml(state, composer) {
  const activeAgents = state.agentGrants.filter((ag) => ag.active !== false);
  const targets = [
    ['none', '仅待办', ''],
    ['@me', '@me', 'me'],
    ...activeAgents.map((ag) => [ag.agent_id, ag.agent_id, ''])
  ];
  const pills = targets.map(([id, label, cls]) => (
    `<button class="route-pill ${cls}" type="button" ` +
    `data-quick-target="${escapeHtml(id)}" ` +
    `aria-pressed="${composer.target === id}">${escapeHtml(label)}</button>`
  )).join('');
  const whenToggle = composer.target === 'none'
    ? ''
    : `<button class="when-summary-btn" type="button" ` +
      `data-toggle-composer-when ` +
      `aria-expanded="${Boolean(composer.whenOpen)}">` +
      `<span data-composer-when-text>` +
      `${escapeHtml(formatComposerWhenSummary(composer))}</span>` +
      `<i class="when-caret" aria-hidden="true">▾</i></button>`;
  return `<form class="composer-card" id="quick-todo-form">
    <div class="composer-top">
      <input class="composer-input" id="quick-todo-input" enterkeyhint="done"
        placeholder="写待办，支持 @me 07:30 或 #工作…"
        value="${escapeHtml(composer.text)}" autocomplete="off" required>
      <button class="cmd-primary" type="submit">添加</button>
    </div>
    <div class="composer-bar">
      <div class="chip-strip">${pills}</div>
      ${whenToggle}
    </div>
    ${buildComposerWhenPanelHtml(composer)}
  </form>`;
}

function buildPermissionAlertHtml(perms) {
  if (!perms) {
    return '';
  }
  const missing = !perms.exactAlarm || !perms.notifications ||
    !perms.fullScreenIntent;
  if (!missing) {
    return '';
  }
  return `<div class="perm-alert-bar" role="status">
    <span>闹钟权限未就绪，可能无法准点响铃</span>
    <button class="cmd-quiet outlined mini" type="button"
      data-open-settings>去开启 →</button>
  </div>`;
}

function buildPrimaryTimeTagHtml(item) {
  if (item.assignee === 'none' || !item.time_hhmm) {
    return '';
  }
  const hhmm = escapeHtml(item.time_hhmm);
  const cls = item.assignee === '@me'
    ? 'todo-time-stamp me'
    : 'todo-time-stamp';
  return `<span class="${cls}">${hhmm}</span>`;
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
  const rawSub = item.locked
    ? desc.subtitle.replace(/\s*·\s*LOCKED 本机锁/g, '')
    : desc.subtitle;
  const cleanSub = isAgentAssignee(item.assignee)
    ? `${item.assignee} · ${rawSub}`
    : rawSub;
  const dotHtml = item.assignee === 'none'
    ? ''
    : `<i class="dot ${desc.dotClass}"></i> `;
  const lockTag = item.locked
    ? '<span class="mark-tag lock">LOCKED · 本机锁</span>'
    : '';
  const tagChips = normalizeTodoTags(item.tags).map(
    (t) => `<span class="todo-tag-pill">#${escapeHtml(t)}</span>`
  ).join('');
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
          ${buildPrimaryTimeTagHtml(item)}
        </div>
        <div class="todo-meta-row">
          <span class="todo-sub">${dotHtml}${escapeHtml(cleanSub)}</span>
          ${tagChips}${lockTag}
        </div>
        ${receiptHtml}
      </button>
      ${buildInlineTriggerFoot(item, state, lockedBlocked)}
    </div>
  </article>`;
}

function buildTagFilterBarHtml(todos, activeFilter) {
  const counts = new Map();
  for (const item of todos) {
    for (const tag of normalizeTodoTags(item.tags)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  if (counts.size === 0) {
    return '';
  }
  const pills = [
    `<button class="route-pill" type="button" data-filter-tag="" ` +
      `aria-pressed="${!activeFilter}">全部 ${todos.length}</button>`
  ];
  for (const [tag, cnt] of counts.entries()) {
    const safe = escapeHtml(tag);
    pills.push(
      `<button class="route-pill" type="button" data-filter-tag="${safe}" ` +
        `aria-pressed="${activeFilter === tag}">#${safe} ${cnt}</button>`
    );
  }
  return `<div class="chip-strip tag-filter-bar">${pills.join('')}</div>`;
}

function buildFoldDeck(spec) {
  const fid = escapeHtml(spec.id);
  const title = escapeHtml(spec.title);
  return `<details class="fold todo-group" data-fold-id="${fid}" ` +
    `${spec.open ? 'open' : ''}>
    <summary><span>${title}</span>` +
    `<span class="fold-badge">${spec.count}</span></summary>
    <div class="rows fold-body">${spec.rowsHtml}</div>
  </details>`;
}

function groupActiveTodosByPrimaryTag(active) {
  const byTag = new Map();
  for (const item of active) {
    const key = normalizeTodoTags(item.tags)[0] || '';
    if (!byTag.has(key)) {
      byTag.set(key, []);
    }
    byTag.get(key).push(item);
  }
  return byTag;
}

function buildActiveTodoDecks(active, state, activeFilter, closedFolds) {
  const byTag = groupActiveTodosByPrimaryTag(active);
  const hasTagged = [...byTag.keys()].some(Boolean);
  if (activeFilter || !hasTagged) {
    const fid = activeFilter ? `todo-tag-${activeFilter}` : 'todo-active';
    return buildFoldDeck({
      id: fid,
      title: activeFilter ? `#${activeFilter}` : '进行中',
      count: active.length,
      rowsHtml: active.map((it) => buildTodoRowHtml(it, state)).join(''),
      open: !closedFolds?.has(fid)
    });
  }
  return [...byTag.entries()].map(([key, list]) => {
    const fid = key ? `todo-tag-${key}` : 'todo-untagged';
    return buildFoldDeck({
      id: fid,
      title: key ? `#${key}` : '未分类',
      count: list.length,
      rowsHtml: list.map((it) => buildTodoRowHtml(it, state)).join(''),
      open: !closedFolds?.has(fid)
    });
  }).join('');
}

function buildGroupedTodoRows(todos, state, uiPrefs) {
  const activeFilter = uiPrefs?.todoTagFilter || '';
  const filtered = activeFilter
    ? todos.filter((it) => normalizeTodoTags(it.tags).includes(activeFilter))
    : todos;
  const active = filtered.filter((item) => isTodoActive(item));
  const retreated = filtered.filter((item) => !isTodoActive(item));
  const decks = [];
  if (active.length > 0) {
    decks.push(
      buildActiveTodoDecks(active, state, activeFilter, uiPrefs?.closedFolds)
    );
  }
  if (retreated.length > 0) {
    decks.push(buildFoldDeck({
      id: 'todo-done',
      title: '已完成或暂停',
      count: retreated.length,
      rowsHtml: retreated.map((item) => buildTodoRowHtml(item, state)).join(''),
      open: Boolean(uiPrefs?.openFolds?.has('todo-done'))
    }));
  }
  return `${buildTagFilterBarHtml(todos, activeFilter)}` +
    `<div class="stack-sm">${decks.join('')}</div>`;
}

export function renderTodoView(state, composerState, uiPrefs) {
  const composer = composerState || {
    target: '@me',
    time: '07:30',
    schedule: '今天',
    date: state.todayIso,
    weeklyDow: 5,
    text: ''
  };
  const emptyHtml = '<div class="empty">暂无待办或唤醒任务<br>' +
    '<span class="row-meta">' +
    '在上方输入事项，支持 @me 07:30 或 #工作</span></div>';
  const summary = state.todoSummary || summarizeTodos(state.todos);
  const listSection = state.todos.length > 0
    ? buildGroupedTodoRows(state.todos, state, uiPrefs)
    : emptyHtml;
  return `<div class="foreground-stack">
    ${buildAppUpdateBannerHtml(state)}
    ${buildComposerHtml(state, composer)}
    ${buildPermissionAlertHtml(state.nativePermissions)}
    <div class="col-head">
      <span>待办 ${summary.openCount} · 循环 ${summary.cycleCount}</span>
    </div>
    ${listSection}
  </div>`;
}
