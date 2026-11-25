import { REPEAT_LABELS, formatRepeatLabel } from '../domain/calendar-model.js';
import { addDaysIso, DOW_LABELS, escapeHtml } from '../domain/date-time.js';
import {
  TODO_SCHEDULES,
  isAgentAssignee,
  isRecurringTodo,
  todoScheduleUiValue
} from '../domain/todo-model.js';

const REMINDER_ITEMS = Object.freeze([
  Object.freeze(['none', '不提醒']),
  Object.freeze(['notify', '普通通知 (-10m)']),
  Object.freeze(['alarm', '强提醒响铃 (-15m)'])
]);

function buildRadioChoicesHtml(name, pairs, currentVal, extraAttr) {
  return pairs.map(([val, label]) => {
    const chk = val === currentVal ? 'checked' : '';
    return `<label class="choice">` +
      `<input type="radio" name="${name}" ${extraAttr} ` +
      `value="${escapeHtml(val)}" ${chk}>` +
      `<span>${escapeHtml(label)}</span></label>`;
  }).join('');
}

function resolveEventDefaults(state, existing) {
  const fallbackDate = state.page === 'agenda'
    ? state.todayIso
    : state.selectedDate;
  if (!existing) {
    return {
      date: fallbackDate,
      start: '10:00',
      end: '11:00',
      title: '',
      loc: '',
      repeat: '不重复',
      rem: 'notify'
    };
  }
  return {
    date: existing.event_date,
    start: existing.start_hhmm,
    end: existing.end_hhmm,
    title: existing.title,
    loc: existing.location,
    repeat: formatRepeatLabel(existing.repeat_rule),
    rem: existing.reminder_policy
  };
}

function buildEventDateAndTimeFields(vals) {
  return `<div class="field">
      <label for="ev-date">DATE</label>
      <div class="date-row">
        <input class="date-input" id="ev-date" name="date" type="date"
          value="${escapeHtml(vals.date)}" required>
        <div class="date-shortcuts">
          <button class="cmd-quiet outlined mini" type="button"
            data-date-offset="0">今天</button>
          <button class="cmd-quiet outlined mini" type="button"
            data-date-offset="1">明天</button>
          <button class="cmd-quiet outlined mini" type="button"
            data-date-offset="2">后天</button>
        </div>
      </div>
    </div>
    <div class="field">
      <div class="field-head">
        <label for="ev-start">TIME WINDOW</label>
        <div class="date-shortcuts">
          <button class="cmd-quiet outlined mini" type="button"
            data-dur-mins="30">30m</button>
          <button class="cmd-quiet outlined mini" type="button"
            data-dur-mins="60">1h</button>
          <button class="cmd-quiet outlined mini" type="button"
            data-dur-mins="120">2h</button>
        </div>
      </div>
      <div class="time-range-row">
        <input class="time-compact" id="ev-start" name="start" type="time"
          aria-label="开始时间" value="${escapeHtml(vals.start)}" required>
        <span class="range-sep">→</span>
        <input class="time-compact" id="ev-end" name="end" type="time"
          aria-label="结束时间" value="${escapeHtml(vals.end)}" required>
      </div>
    </div>`;
}

export function buildEventDialogHtml(state, editId) {
  const existing = editId
    ? state.masterEvents.find((e) => e.event_id === String(editId))
    : null;
  const vals = resolveEventDefaults(state, existing);
  const repeatPairs = Object.values(REPEAT_LABELS).map((r) => [r, r]);
  const repeatHtml = buildRadioChoicesHtml(
    'repeat', repeatPairs, vals.repeat, ''
  );
  const remHtml = buildRadioChoicesHtml(
    'reminder', REMINDER_ITEMS, vals.rem, ''
  );
  const delBtn = existing
    ? '<button class="btn-block" type="button" ' +
      'id="delete-event">删除日程</button>'
    : '';
  return `
    ${buildEventDateAndTimeFields(vals)}
    <div class="field">
      <label for="ev-title">TITLE</label>
      <input id="ev-title" name="title" placeholder="例如：评审会议 / 高铁检票"
        enterkeyhint="done" value="${escapeHtml(vals.title)}" required>
    </div>
    <div class="field">
      <label for="ev-loc">LOCATION / NOTE</label>
      <input id="ev-loc" name="location" placeholder="可选地点或说明"
        enterkeyhint="done" value="${escapeHtml(vals.loc)}">
    </div>
    <fieldset><legend>REPEAT</legend>
      <div class="choices">${repeatHtml}</div></fieldset>
    <fieldset><legend>REMINDER POLICY</legend>
      <div class="choices">${remHtml}</div></fieldset>
    <div class="cli-preview" id="cli-preview" aria-live="polite"></div>
    <button class="btn-block primary" type="submit">保存日程</button>
    ${delBtn}`;
}

function buildTodoActionButtons(existing, state, lockedBlocked) {
  const disAttr = lockedBlocked ? 'disabled' : '';
  const buttons = [
    `<button class="btn-block primary" type="submit" ${disAttr}>保存</button>`
  ];
  const canTrig = Boolean(
    existing && isAgentAssignee(existing.assignee) && state.mode === 'cloud'
  );
  if (canTrig) {
    const id = escapeHtml(existing.todo_id);
    buttons.push(
      `<button class="btn-block" type="button" id="trigger-todo" ${disAttr} ` +
      `data-trigger-todo="${id}">立即触发 Agent 执行</button>`
    );
  }
  if (existing && isRecurringTodo(existing) && existing.enabled) {
    const label = existing.skip_next ? '恢复下次触发' : '跳过下一次';
    buttons.push(
      `<button class="btn-block" type="button" id="skip-next-todo" ` +
      `${disAttr}>${label}</button>`
    );
  }
  if (existing) {
    buttons.push(
      `<button class="btn-block" type="button" id="delete-todo" ` +
      `${disAttr}>删除</button>`
    );
  }
  return buttons.join('\n');
}

function buildTodoTargets(state, targetVal) {
  const activeAgents = state.agentGrants.filter(
    (ag) => ag.active !== false || ag.agent_id === targetVal
  );
  return [
    ['none', '仅待办 (不定时)'],
    ['@me', '@me 手机响铃'],
    ...activeAgents.map((ag) => [ag.agent_id, `${ag.agent_id} 自动执行`])
  ];
}

function resolveDialogLocalFlag(state) {
  if (state.isLocalDevice !== undefined) {
    return Boolean(state.isLocalDevice);
  }
  return state.mode !== 'cloud' || state.identity?.source === 'local';
}

function formatLockAttrs(locked, isLocal) {
  return [locked ? 'checked' : '', isLocal ? '' : 'disabled']
    .filter(Boolean)
    .join(' ');
}

function prepareTodoDialogSpec(state, editId) {
  const existing = editId
    ? state.todos.find((t) => t.todo_id === String(editId))
    : null;
  const isLocal = resolveDialogLocalFlag(state);
  const lockedBlocked = Boolean(existing?.locked) && !isLocal;
  const targetVal = existing ? existing.assignee : '@me';
  const dowVal = existing?.weekly_dow ?? 5;
  return {
    existing,
    lockedBlocked,
    disAttr: lockedBlocked ? 'disabled' : '',
    lockAttrs: formatLockAttrs(Boolean(existing?.locked), isLocal),
    textVal: escapeHtml(existing?.text || ''),
    timeVal: escapeHtml(existing?.time_hhmm || '07:30'),
    dateVal: escapeHtml(existing?.once_date || addDaysIso(state.todayIso, 1)),
    targetVal,
    schedVal: todoScheduleUiValue(existing, state.todayIso),
    dowHtml: DOW_LABELS.map((name, idx) => (
      `<option value="${idx}" ${idx === dowVal ? 'selected' : ''}>` +
      `每${name}</option>`
    )).join('')
  };
}

function buildTodoTimingFields(spec, schedHtml) {
  return `<div class="field" data-todo-when>
      <label for="td-time">WHEN · 触发时间与周期</label>
      <input class="time-input" id="td-time" name="time" type="time"
        ${spec.disAttr} value="${spec.timeVal}">
      <div class="choices" style="margin-top:6px">${schedHtml}</div>
    </div>
    <div class="field" data-todo-date>
      <label for="td-date">DATE · 指定触发日期</label>
      <div class="date-row">
        <input class="date-input" id="td-date" name="date" type="date"
          ${spec.disAttr} value="${spec.dateVal}">
        <div class="date-shortcuts">
          <button class="cmd-quiet outlined mini" type="button" ${spec.disAttr}
            data-todo-date-offset="1">明天</button>
          <button class="cmd-quiet outlined mini" type="button" ${spec.disAttr}
            data-todo-date-offset="2">后天</button>
        </div>
      </div>
    </div>
    <div class="field" data-todo-dow>
      <label for="td-dow">WEEKDAY · 每周触发日</label>
      <select id="td-dow" name="weekly_dow"
        ${spec.disAttr}>${spec.dowHtml}</select>
    </div>`;
}

export function buildTodoDialogHtml(state, editId) {
  const spec = prepareTodoDialogSpec(state, editId);
  const targets = buildTodoTargets(state, spec.targetVal);
  const targetHtml = buildRadioChoicesHtml(
    'target', targets, spec.targetVal, spec.disAttr
  );
  const schedHtml = buildRadioChoicesHtml(
    'schedule', TODO_SCHEDULES.map((s) => [s, s]), spec.schedVal, spec.disAttr
  );
  const lockNotice = spec.lockedBlocked
    ? '<div class="mark-tag lock">' +
      'LOCKED · 本机锁（仅手机本机可修改或删除）</div>'
    : '';
  return `
    ${lockNotice}
    <div class="field">
      <label for="td-text">TODO / PROMPT (选 @agent 时直接作为发送正文)</label>
      <textarea class="prompt-input" id="td-text" name="text" ${spec.disAttr}
        placeholder="要做的事…" required>${spec.textVal}</textarea>
    </div>
    <fieldset><legend>ASSIGNEE · 到点唤醒谁</legend>
      <div class="choices">${targetHtml}</div></fieldset>
    ${buildTodoTimingFields(spec, schedHtml)}
    <div class="field" data-todo-lock>
      <label class="choice">
        <input type="checkbox" id="td-locked" name="locked" ${spec.lockAttrs}>
        <span>LOCKED 本机锁（仅手机本机可开启或修改）</span>
      </label>
    </div>
    <div class="cli-preview" id="cli-preview" aria-live="polite"></div>
    ${buildTodoActionButtons(spec.existing, state, spec.lockedBlocked)}`;
}

export function buildAgentDialogHtml(state, editAgentId) {
  const existing = editAgentId
    ? state.agentGrants.find((ag) => ag.agent_id === editAgentId)
    : null;
  const idAttr = existing ? 'readonly' : '';
  const keyReq = existing ? '' : 'required';
  const keyHint = existing ? '留空则保留现有加密密钥' : 'Bearer 调用密钥';
  const agId = escapeHtml(existing?.agent_id || '@');
  const agName = escapeHtml(existing?.name || '');
  const agUrl = escapeHtml(existing?.endpoint_url || '');
  return `
    <div class="field">
      <label for="ag-id">AGENT HANDLE (@开头，小写字母/数字/-/_)</label>
      <input id="ag-id" name="agentId" placeholder="@work-agent"
        autocapitalize="off" spellcheck="false" autocomplete="off"
        value="${agId}" ${idAttr} required>
    </div>
    <div class="field">
      <label for="ag-name">DISPLAY NAME</label>
      <input id="ag-name" name="name" placeholder="主力工作 Agent"
        value="${agName}" required>
    </div>
    <div class="field">
      <label for="ag-url">WEBHOOK ENDPOINT URL (自动拼接 /webhooks/pocket)</label>
      <input id="ag-url" name="endpointUrl" type="url" inputmode="url"
        autocapitalize="off" spellcheck="false"
        placeholder="https://agent.example.com" value="${agUrl}" required>
    </div>
    <div class="field">
      <label for="ag-key">CREDENTIAL SECRET</label>
      <div class="secret-row">
        <input id="ag-key" name="credential" type="password"
          autocapitalize="off" spellcheck="false" autocomplete="off"
          placeholder="${keyHint}" ${keyReq}>
        <button class="cmd-quiet outlined mini" type="button"
          data-toggle-secret="ag-key">显示</button>
      </div>
    </div>
    <div class="cli-preview" id="cli-preview" aria-live="polite"></div>
    <button class="btn-block primary" type="submit">保存 Agent 配置</button>`;
}
