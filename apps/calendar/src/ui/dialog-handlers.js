import {
  DOW_LABELS,
  addDaysIso,
  escapeHtml,
  minutesToHhmm,
  toMinutes
} from '../domain/date-time.js';
import {
  runSafely,
  selectCalendarDate,
  showUndoToast,
  toggleSecretInput
} from './dom-handlers.js';

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
    const dowIdx = Number(form.querySelector('#td-dow')?.value ?? 5);
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
    endEl.value = minutesToHhmm(toMinutes(startEl.value) + 60);
  }
}

export function updateFormDialogDom(form, fallbackDate) {
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
    endEl.value = minutesToHhmm(toMinutes(startVal) + mins);
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
  const selector = evDateBtn ? '#ev-date' : '#td-date';
  const rawOff = evDateBtn
    ? btn.dataset.dateOffset
    : btn.dataset.todoDateOffset;
  const input = form.querySelector(selector);
  if (input) {
    const today = ui.store.getState().todayIso;
    input.value = addDaysIso(today, Number(rawOff));
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

function handleDeleteWithUndo(ui, kind, closeDialog, btn) {
  const spec = DELETE_SPECS[kind] || DELETE_SPECS.todo;
  const st = ui.store.getState();
  const snap = st[spec.listKey].find(
    (item) => item[spec.idKey] === ui.editingId
  );
  const call = ui.store[spec.removeKey](ui.editingId);
  runSafely(ui, call, '', {
    trigger: btn,
    onOk: () => {
      closeDialog();
      if (snap) {
        const draft = { ...snap };
        delete draft[spec.idKey];
        delete draft.base_revision;
        showUndoToast(ui, spec.label, () => ui.store[spec.saveKey](draft));
      }
    }
  });
}

export function handleDialogClick(ui, event) {
  const form = ui.doc.querySelector('#active-form');
  const dialog = ui.doc.querySelector('#form-dialog');
  const closeDialog = () => dialog.close();
  const secretBtn = event.target.closest('[data-toggle-secret]');
  if (secretBtn) {
    toggleSecretInput(form, secretBtn);
    return;
  }
  if (applyDateShortcutClick(ui, form, event) || !ui.editingId) {
    return;
  }
  const skipBtn = event.target.closest('#skip-next-todo');
  if (skipBtn) {
    const call = ui.store.toggleSkipNext(ui.editingId);
    runSafely(ui, call, '已更新跳过状态', {
      onOk: closeDialog,
      trigger: skipBtn
    });
    return;
  }
  const trigBtn = event.target.closest('#trigger-todo');
  if (trigBtn) {
    const call = ui.store.triggerAgentTodo(ui.editingId);
    runSafely(ui, call, '已触发 Agent 执行', {
      onOk: closeDialog,
      trigger: trigBtn
    });
    return;
  }
  const delEvBtn = event.target.closest('#delete-event');
  if (delEvBtn) {
    handleDeleteWithUndo(ui, 'event', closeDialog, delEvBtn);
    return;
  }
  const delTdBtn = event.target.closest('#delete-todo');
  if (delTdBtn) {
    handleDeleteWithUndo(ui, 'todo', closeDialog, delTdBtn);
  }
}

function submitTodoDialog(ui, fd, closeDialog, submitBtn) {
  const target = String(fd.get('target') || 'none');
  const call = ui.store.saveTodo({
    todo_id: ui.editingId,
    text: fd.get('text'),
    assignee: target,
    schedule: fd.get('schedule'),
    time_hhmm: fd.get('time'),
    once_date: fd.get('date'),
    weekly_dow: fd.get('weekly_dow'),
    locked: target === '@me' && Boolean(fd.get('locked'))
  });
  runSafely(ui, call, 'Todo 已保存', {
    onOk: closeDialog,
    trigger: submitBtn
  });
}

function submitEventDialog(ui, fd, closeDialog, submitBtn) {
  const date = String(fd.get('date') || ui.store.getState().selectedDate);
  const call = ui.store.saveEvent({
    event_id: ui.editingId,
    event_date: date,
    start_hhmm: fd.get('start'),
    end_hhmm: fd.get('end'),
    title: fd.get('title'),
    location: fd.get('location'),
    repeat: fd.get('repeat'),
    reminder: fd.get('reminder')
  });
  runSafely(ui, call, '日程已保存', {
    trigger: submitBtn,
    onOk: () => {
      closeDialog();
      selectCalendarDate(ui, date);
    }
  });
}

export function handleDialogSubmit(ui, event) {
  event.preventDefault();
  const form = ui.doc.querySelector('#active-form');
  const dialog = ui.doc.querySelector('#form-dialog');
  const submitBtn = form.querySelector('button[type="submit"]');
  const closeDialog = () => dialog.close();
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
      onOk: closeDialog,
      trigger: submitBtn
    });
    return;
  }
  if (kind === 'todo') {
    submitTodoDialog(ui, fd, closeDialog, submitBtn);
    return;
  }
  submitEventDialog(ui, fd, closeDialog, submitBtn);
}
