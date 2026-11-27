import {
  DOW_LABELS,
  addDaysIso,
  escapeHtml,
  minutesToHhmm,
  toMinutes
} from '../domain/date-time.js';
import { normalizeTodoTags } from '../domain/todo-model.js';
import {
  runSafely,
  selectCalendarDate,
  showUndoToast,
  toggleSecretInput
} from './dom-handlers.js';
import {
  handleDialogTagChipClick,
  handleFeishuDialogSubmit
} from './extra-handlers.js';
import { handlePickerClick, syncPickerDisplay } from './pickers.js';

const EVENT_REMINDER_FLAGS = Object.freeze({
  alarm: '--alarm -15m',
  notify: '--notify -10m',
  none: '--silent'
});

function syncTodoFieldVisibility(form, target, sched) {
  const rules = [
    ['[data-todo-when]', target === 'none'],
    ['[data-todo-date]', target === 'none' || sched !== '指定日期'],
    ['[data-todo-dow]', target === 'none' || sched !== '每周'],
    ['[data-todo-lock]', target !== '@me']
  ];
  for (const [selector, hidden] of rules) {
    const el = form.querySelector(selector);
    if (el) {
      el.hidden = hidden;
    }
  }
}

function updateTodoFormDom(form, box, fallbackDate) {
  const target = form.querySelector(
    'input[name="target"]:checked'
  )?.value || 'none';
  const sched = form.querySelector(
    'input[name="schedule"]:checked'
  )?.value || '今天';
  syncTodoFieldVisibility(form, target, sched);
  if (target === 'none') {
    box.innerHTML = '<b>$</b> todo.set --plain (仅待办，不设唤醒)';
    return;
  }
  const time = form.querySelector('#td-time')?.value || '09:00';
  const locked = form.querySelector('#td-locked')?.checked ? ' --locked' : '';
  let whenText = sched;
  if (sched === '指定日期') {
    whenText = form.querySelector('#td-date')?.value || fallbackDate;
  } else if (sched === '每周') {
    const dowEl = form.querySelector('input[name="weekly_dow"]:checked');
    const dowIdx = Number(dowEl?.value ?? 5);
    whenText = `每${DOW_LABELS[dowIdx] || '周五'}`;
  }
  box.innerHTML = `<b>$</b> todo.set --assign <b>${escapeHtml(target)}</b> ` +
    `--at "${escapeHtml(whenText)} ${escapeHtml(time)}"${locked}`;
}

function updateEventPreviewDom(form, box, fallbackDate) {
  const date = form.querySelector('#ev-date')?.value || fallbackDate;
  const start = form.querySelector('#ev-start')?.value || '09:00';
  const rawEnd = form.querySelector('#ev-end')?.value || '10:00';
  const autoFixed = toMinutes(rawEnd) <= toMinutes(start);
  const end = autoFixed ? minutesToHhmm(toMinutes(start) + 30) : rawEnd;
  const rem = form.querySelector('input[name="reminder"]:checked')?.value;
  const repeat = form.querySelector('input[name="repeat"]:checked')?.value;
  const repTag = repeat && repeat !== '不重复'
    ? ` --repeat ${escapeHtml(repeat)}`
    : '';
  const fixHint = autoFixed ? ' (自动顺延 +30m)' : '';
  const flag = EVENT_REMINDER_FLAGS[rem || 'notify'] || '--silent';
  box.innerHTML = `<b>$</b> event.set --date ${escapeHtml(date)} ` +
    `--window ${escapeHtml(start)}..${escapeHtml(end)}${fixHint}` +
    `${repTag} ${flag}`;
}

export function syncEventEndOnStartEdit(form, event) {
  if (event?.target?.id !== 'ev-start') {
    return;
  }
  const startEl = form.querySelector('#ev-start');
  const endEl = form.querySelector('#ev-end');
  if (startEl?.value && endEl?.value &&
      toMinutes(endEl.value) <= toMinutes(startEl.value)) {
    const nextEnd = minutesToHhmm(toMinutes(startEl.value) + 60);
    endEl.value = nextEnd;
    syncPickerDisplay(form, 'ev-end', nextEnd, 'time');
  }
}

function syncDialogShortcutStates(form, todayIso) {
  if (!form?.querySelectorAll) {
    return;
  }
  const evDate = form.querySelector('#ev-date')?.value || '';
  for (const btn of form.querySelectorAll('[data-date-offset]')) {
    const iso = addDaysIso(todayIso, Number(btn.dataset.dateOffset));
    btn.setAttribute('aria-pressed', String(evDate === iso));
  }
  const tdDate = form.querySelector('#td-date')?.value || '';
  for (const btn of form.querySelectorAll('[data-todo-date-offset]')) {
    const iso = addDaysIso(todayIso, Number(btn.dataset.todoDateOffset));
    btn.setAttribute('aria-pressed', String(tdDate === iso));
  }
  const s = form.querySelector('#ev-start')?.value;
  const e = form.querySelector('#ev-end')?.value;
  const dur = s && e ? toMinutes(e) - toMinutes(s) : -1;
  for (const btn of form.querySelectorAll('[data-dur-mins]')) {
    const active = dur === Number(btn.dataset.durMins);
    btn.setAttribute('aria-pressed', String(active));
  }
}

export function updateFormDialogDom(form, fallbackDate) {
  if (form.dataset.kind === 'todo') {
    const target = form.querySelector(
      'input[name="target"]:checked'
    )?.value || 'none';
    const sched = form.querySelector(
      'input[name="schedule"]:checked'
    )?.value || '今天';
    syncTodoFieldVisibility(form, target, sched);
  }
  syncDialogShortcutStates(form, fallbackDate);
  const box = form.querySelector('#cli-preview');
  if (!box) {
    return;
  }
  if (form.dataset.kind === 'agent') {
    const id = form.querySelector('#ag-id')?.value || '@agent';
    const url = form.querySelector('#ag-url')?.value || 'https://...';
    box.innerHTML = `<b>$</b> agent.set ${escapeHtml(id)} ` +
      `--url ${escapeHtml(url)}`;
    return;
  }
  if (form.dataset.kind === 'todo') {
    updateTodoFormDom(form, box, fallbackDate);
    return;
  }
  updateEventPreviewDom(form, box, fallbackDate);
}

function applyDurationShortcut(ui, form, durBtn) {
  const startVal = form.querySelector('#ev-start')?.value || '10:00';
  const endEl = form.querySelector('#ev-end');
  if (endEl) {
    const mins = Number(durBtn.dataset.durMins);
    const nextEnd = minutesToHhmm(toMinutes(startVal) + mins);
    endEl.value = nextEnd;
    syncPickerDisplay(form, 'ev-end', nextEnd, 'time');
    updateFormDialogDom(form, ui.store.getState().todayIso);
  }
  return true;
}

function applyDateShortcutClick(ui, form, event) {
  const durBtn = event.target.closest('[data-dur-mins]');
  if (durBtn) {
    return applyDurationShortcut(ui, form, durBtn);
  }
  const evDateBtn = event.target.closest('[data-date-offset]');
  const tdDateBtn = event.target.closest('[data-todo-date-offset]');
  const btn = evDateBtn || tdDateBtn;
  if (!btn) {
    return false;
  }
  const targetId = evDateBtn ? 'ev-date' : 'td-date';
  const rawOff = evDateBtn
    ? btn.dataset.dateOffset
    : btn.dataset.todoDateOffset;
  const input = form.querySelector(`#${targetId}`);
  if (input) {
    const today = ui.store.getState().todayIso;
    const nextIso = addDaysIso(today, Number(rawOff));
    input.value = nextIso;
    syncPickerDisplay(form, targetId, nextIso, 'date');
    updateFormDialogDom(form, today);
  }
  return true;
}

const DELETE_SPECS = Object.freeze({
  event: Object.freeze({
    listKey: 'masterEvents',
    idKey: 'event_id',
    removeKey: 'removeEvent',
    saveKey: 'saveEvent',
    label: '日程已删除'
  }),
  todo: Object.freeze({
    listKey: 'todos',
    idKey: 'todo_id',
    removeKey: 'removeTodo',
    saveKey: 'saveTodo',
    label: 'Todo 已删除'
  })
});

function closeFormDialog(ui) {
  ui.doc.querySelector('#form-dialog')?.close();
}

function handleDeleteWithUndo(ui, kind, btn) {
  const spec = DELETE_SPECS[kind] || DELETE_SPECS.todo;
  const st = ui.store.getState();
  const snap = st[spec.listKey].find(
    (item) => item[spec.idKey] === ui.editingId
  );
  const call = ui.store[spec.removeKey](ui.editingId);
  runSafely(ui, call, '', {
    trigger: btn,
    onOk: () => {
      closeFormDialog(ui);
      if (snap) {
        const draft = { ...snap };
        delete draft[spec.idKey];
        delete draft.base_revision;
        showUndoToast(ui, spec.label, () => ui.store[spec.saveKey](draft));
      }
    }
  });
}

const EDIT_DIALOG_ACTIONS = [
  ['#skip-next-todo', (ui, btn) => runSafely(
    ui, ui.store.toggleSkipNext(ui.editingId), '已更新跳过状态',
    { onOk: () => closeFormDialog(ui), trigger: btn }
  )],
  ['#trigger-todo', (ui, btn) => runSafely(
    ui, ui.store.triggerAgentTodo(ui.editingId), '已触发 Agent 执行',
    { onOk: () => closeFormDialog(ui), trigger: btn }
  )],
  ['#delete-event', (ui, btn) => handleDeleteWithUndo(ui, 'event', btn)],
  ['#delete-todo', (ui, btn) => handleDeleteWithUndo(ui, 'todo', btn)]
];

export function handleDialogClick(ui, event) {
  const form = ui.doc.querySelector('#active-form');
  const secretBtn = event.target.closest('[data-toggle-secret]');
  if (secretBtn) {
    toggleSecretInput(form, secretBtn);
    return;
  }
  const tagBtn = event.target.closest('[data-dialog-tag]');
  if (tagBtn) {
    handleDialogTagChipClick(form, tagBtn);
    return;
  }
  const todayIso = ui.store.getState().todayIso;
  const picked = handlePickerClick(form, event, todayIso, (tid) => {
    if (tid === 'ev-start') {
      syncEventEndOnStartEdit(form, { target: { id: 'ev-start' } });
    }
    updateFormDialogDom(form, todayIso);
  });
  if (picked || applyDateShortcutClick(ui, form, event) || !ui.editingId) {
    return;
  }
  for (const [selector, handler] of EDIT_DIALOG_ACTIONS) {
    const btn = event.target.closest(selector);
    if (btn) {
      handler(ui, btn);
      return;
    }
  }
}

function submitTodoDialog(ui, fd, submitBtn) {
  const target = String(fd.get('target') || 'none');
  const call = ui.store.saveTodo({
    todo_id: ui.editingId,
    text: fd.get('text'),
    assignee: target,
    schedule: fd.get('schedule'),
    time_hhmm: fd.get('time'),
    once_date: fd.get('date'),
    weekly_dow: fd.get('weekly_dow'),
    locked: target === '@me' && Boolean(fd.get('locked')),
    tags: normalizeTodoTags(fd.get('tags'))
  });
  runSafely(ui, call, 'Todo 已保存', {
    onOk: () => closeFormDialog(ui),
    trigger: submitBtn
  });
}

function submitEventDialog(ui, fd, submitBtn) {
  const date = String(fd.get('date') || ui.store.getState().selectedDate);
  const draft = {
    event_id: ui.editingId,
    event_date: date,
    start_hhmm: fd.get('start'),
    end_hhmm: fd.get('end'),
    title: fd.get('title'),
    reminder: fd.get('reminder')
  };
  if (fd.has('location')) {
    draft.location = fd.get('location');
  }
  if (fd.has('repeat')) {
    draft.repeat = fd.get('repeat');
  }
  const call = ui.store.saveEvent(draft);
  runSafely(ui, call, '日程已保存', {
    trigger: submitBtn,
    onOk: () => {
      closeFormDialog(ui);
      selectCalendarDate(ui, date);
    }
  });
}

export function handleDialogSubmit(ui, event) {
  event.preventDefault();
  const form = ui.doc.querySelector('#active-form');
  const submitBtn = form.querySelector('button[type="submit"]');
  const fd = new FormData(form);
  const kind = form.dataset.kind;
  if (kind === 'agent') {
    const call = ui.store.saveAgent({
      agentId: fd.get('agentId'),
      name: fd.get('name'),
      endpointUrl: fd.get('endpointUrl'),
      credential: fd.get('credential')
    });
    runSafely(ui, call, 'Agent 配置已保存', {
      onOk: () => closeFormDialog(ui),
      trigger: submitBtn
    });
    return;
  }
  if (kind === 'feishu') {
    handleFeishuDialogSubmit(ui, fd, submitBtn, () => closeFormDialog(ui));
    return;
  }
  if (kind === 'todo') {
    submitTodoDialog(ui, fd, submitBtn);
    return;
  }
  submitEventDialog(ui, fd, submitBtn);
}
