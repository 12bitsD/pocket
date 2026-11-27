import { formatRepeatLabel } from '../domain/calendar-model.js';
import {
  addDaysIso,
  DOW_LABELS,
  escapeHtml,
  toMinutes
} from '../domain/date-time.js';
import {
  TODO_SCHEDULES,
  isAgentAssignee,
  isLocalSessionState,
  isRecurringTodo,
  todoScheduleUiValue
} from '../domain/todo-model.js';
import { buildDateFieldHtml, buildTimeFieldHtml } from './pickers.js';
import {
  buildFeishuDialogHtml,
  buildTodoTagPickerHtml
} from './settings-sections.js';

export { buildFeishuDialogHtml };

const REMINDER_ITEMS = Object.freeze([
  Object.freeze(['none', '不提醒']),
  Object.freeze(['notify', '通知']),
  Object.freeze(['alarm', '响铃'])
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

function buildEventDateAndTimeFields(vals, todayIso) {
  const dateField = buildDateFieldHtml({
    id: 'ev-date', name: 'date', value: vals.date, ariaLabel: '日程日期'
  });
  const startField = buildTimeFieldHtml({
    id: 'ev-start', name: 'start', value: vals.start,
    ariaLabel: '开始时间', compact: true, externalSlot: true
  });
  const endField = buildTimeFieldHtml({
    id: 'ev-end', name: 'end', value: vals.end,
    ariaLabel: '结束时间', compact: true, externalSlot: true
  });
  const dur = toMinutes(vals.end) - toMinutes(vals.start);
  const dayBtns = [['0', '今天'], ['1', '明天'], ['2', '后天']].map(([o, l]) => {
    const active = vals.date === addDaysIso(todayIso, Number(o));
    return `<button class="ghost-chip" type="button" ` +
      `aria-pressed="${active}" data-date-offset="${o}">${l}</button>`;
  }).join('');
  const durBtns = [['30', '30m'], ['60', '1h'], ['120', '2h']].map(([m, l]) => {
    const active = dur === Number(m);
    return `<button class="ghost-chip" type="button" ` +
      `aria-pressed="${active}" data-dur-mins="${m}">${l}</button>`;
  }).join('');
  return `<div class="field">
      <div class="field-head">
        <label>日期</label>
        <div class="ghost-row">${dayBtns}</div>
      </div>
      ${dateField}
    </div>
    <div class="field">
      <div class="field-head">
        <label>时间</label>
        <div class="ghost-row">${durBtns}</div>
      </div>
      <div class="time-range-row">
        ${startField}<span class="range-sep">→</span>${endField}
      </div>
      <div class="picker-slot" data-picker-slot="ev-start" hidden></div>
      <div class="picker-slot" data-picker-slot="ev-end" hidden></div>
    </div>`;
}

export function buildEventDialogHtml(state, editId) {
  const existing = editId
    ? state.masterEvents.find((e) => e.event_id === String(editId))
    : null;
  const vals = resolveEventDefaults(state, existing);
  const remHtml = buildRadioChoicesHtml(
    'reminder', REMINDER_ITEMS, vals.rem, ''
  );
  const delBtn = existing
    ? '<div class="dialog-sub-actions">' +
      '<button class="text-danger-btn" type="button" ' +
      'id="delete-event">删除日程</button></div>'
    : '';
  return `
    <div class="field">
      <input class="title-field-input" id="ev-title" name="title"
        placeholder="日程名称…" enterkeyhint="done"
        value="${escapeHtml(vals.title)}" required>
    </div>
    ${buildEventDateAndTimeFields(vals, state.todayIso)}
    <fieldset><legend>提醒</legend>
      <div class="seg-choices cols-3">${remHtml}</div></fieldset>
    <button class="btn-block primary" type="submit">保存</button>
    ${delBtn}`;
}

function buildTodoActionButtons(existing, state, lockedBlocked) {
  const disAttr = lockedBlocked ? 'disabled' : '';
  const primary = `<button class="btn-block primary" type="submit" ` +
    `${disAttr}>保存</button>`;
  if (!existing) {
    return primary;
  }
  const secondary = [];
  if (isAgentAssignee(existing.assignee) && state.mode === 'cloud') {
    const id = escapeHtml(existing.todo_id);
    secondary.push(
      `<button class="ghost-chip" type="button" id="trigger-todo" ${disAttr} ` +
      `data-trigger-todo="${id}">立即触发</button>`
    );
  }
  if (isRecurringTodo(existing) && existing.enabled) {
    const label = existing.skip_next ? '恢复下次' : '跳过下次';
    secondary.push(
      `<button class="ghost-chip" type="button" id="skip-next-todo" ` +
      `${disAttr}>${label}</button>`
    );
  }
  secondary.push(
    `<button class="text-danger-btn" type="button" id="delete-todo" ` +
    `${disAttr}>删除</button>`
  );
  const subHtml = secondary.join('');
  return `${primary}<div class="dialog-sub-actions">${subHtml}</div>`;
}

function buildTodoTargets(state, targetVal) {
  const activeAgents = state.agentGrants.filter(
    (ag) => ag.active !== false || ag.agent_id === targetVal
  );
  return [
    ['none', '仅待办'],
    ['@me', '本机响铃'],
    ...activeAgents.map((ag) => [ag.agent_id, ag.agent_id])
  ];
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
  const isLocal = isLocalSessionState(state);
  const lockedBlocked = Boolean(existing?.locked) && !isLocal;
  const targetVal = existing ? existing.assignee : '@me';
  const dowVal = existing?.weekly_dow ?? 5;
  const dowPairs = DOW_LABELS.map((name, idx) => [String(idx), name]);
  return {
    existing,
    lockedBlocked,
    disAttr: lockedBlocked ? 'disabled' : '',
    lockAttrs: formatLockAttrs(Boolean(existing?.locked), isLocal),
    textVal: escapeHtml(existing?.text || ''),
    timeVal: existing?.time_hhmm || '07:30',
    dateVal: existing?.once_date || addDaysIso(state.todayIso, 1),
    targetVal,
    schedVal: existing ? todoScheduleUiValue(existing, state.todayIso) : '今天',
    dowHtml: buildRadioChoicesHtml(
      'weekly_dow', dowPairs, String(dowVal), lockedBlocked ? 'disabled' : ''
    )
  };
}

function buildTodoTimingFields(spec, schedHtml) {
  const timeField = buildTimeFieldHtml({
    id: 'td-time', name: 'time', value: spec.timeVal,
    ariaLabel: '触发时间', disabled: spec.lockedBlocked
  });
  const dateField = buildDateFieldHtml({
    id: 'td-date', name: 'date', value: spec.dateVal,
    ariaLabel: '指定日期', disabled: spec.lockedBlocked
  });
  return `<div class="field" data-todo-when>
      <label>时间与频率</label>
      ${timeField}
      <div class="seg-choices cols-3 todo-sched-grid">${schedHtml}</div>
    </div>
    <div class="field" data-todo-date>
      <div class="field-head">
        <label>指定日期</label>
        <div class="ghost-row">
          <button class="ghost-chip" type="button" ${spec.disAttr}
            data-todo-date-offset="1">明天</button>
          <button class="ghost-chip" type="button" ${spec.disAttr}
            data-todo-date-offset="2">后天</button>
        </div>
      </div>
      ${dateField}
    </div>
    <fieldset data-todo-dow><legend>每周触发日</legend>
      <div class="choices">${spec.dowHtml}</div></fieldset>`;
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
      <textarea class="title-field-input todo-title-input" id="td-text"
        name="text" rows="2" ${spec.disAttr}
        placeholder="要做的事…" required>${spec.textVal}</textarea>
    </div>
    <fieldset><legend>方式</legend>
      <div class="chip-strip choice-strip">${targetHtml}</div></fieldset>
    ${buildTodoTagPickerHtml(state, spec.existing?.tags, spec.disAttr)}
    ${buildTodoTimingFields(spec, schedHtml)}
    <div class="field" data-todo-lock>
      <label class="lock-toggle-row">
        <span>本机锁 <em>仅手机本机可改</em></span>
        <input type="checkbox" id="td-locked" name="locked" ${spec.lockAttrs}>
      </label>
    </div>
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
      <label for="ag-id">Agent 标识（@开头）</label>
      <input id="ag-id" name="agentId" placeholder="@work-agent"
        autocapitalize="off" spellcheck="false" autocomplete="off"
        value="${agId}" ${idAttr} required>
    </div>
    <div class="field">
      <label for="ag-name">名称</label>
      <input id="ag-name" name="name" placeholder="主力工作 Agent"
        value="${agName}" required>
    </div>
    <div class="field">
      <label for="ag-url">Webhook 地址</label>
      <input id="ag-url" name="endpointUrl" type="url" inputmode="url"
        autocapitalize="off" spellcheck="false"
        placeholder="https://agent.example.com" value="${agUrl}" required>
    </div>
    <div class="field">
      <label for="ag-key">调用密钥</label>
      <div class="secret-row">
        <input id="ag-key" name="credential" type="password"
          autocapitalize="off" spellcheck="false" autocomplete="off"
          placeholder="${keyHint}" ${keyReq}>
        <button class="cmd-quiet outlined mini" type="button"
          data-toggle-secret="ag-key">显示</button>
      </div>
    </div>
    <button class="btn-block primary" type="submit">保存</button>`;
}
