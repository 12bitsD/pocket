import { pad2 } from '../domain/date-time.js';
import {
  buildDateFieldHtml,
  buildDatePanelHtml,
  buildTimeFieldHtml,
  buildTimePanelHtml,
  formatDateButtonLabel,
  parseHhmmParts
} from './picker-views.js';

export { buildDateFieldHtml, buildTimeFieldHtml, formatDateButtonLabel };

export function syncPickerDisplay(root, targetId, nextVal, kind) {
  const input = root?.querySelector(`#${targetId}`);
  if (input) {
    input.value = nextVal;
  }
  const labelEl = root?.querySelector(`[data-picker-label="${targetId}"]`);
  if (labelEl) {
    labelEl.textContent = kind === 'date'
      ? formatDateButtonLabel(nextVal)
      : nextVal;
  }
}

export function closeAllPickers(root) {
  if (!root?.querySelectorAll) {
    return;
  }
  for (const slot of root.querySelectorAll('[data-picker-slot]')) {
    slot.hidden = true;
    slot.innerHTML = '';
  }
  for (const btn of root.querySelectorAll('[data-picker-open]')) {
    btn.setAttribute('aria-expanded', 'false');
  }
}

function updateTimeVisualsInPlace(root, slot, tid, nextVal) {
  syncPickerDisplay(root, tid, nextVal, 'time');
  const [hh, mm] = nextVal.split(':');
  const readout = slot.querySelector('.picker-readout');
  if (readout) {
    readout.textContent = nextVal;
  }
  const period = slot.querySelector('.picker-period');
  if (period) {
    period.textContent = Number(hh) < 12 ? '上午' : '下午';
  }
  for (const btn of slot.querySelectorAll('[data-pick-preset]')) {
    const active = btn.dataset.pickPreset === nextVal;
    btn.setAttribute('aria-pressed', String(active));
  }
  for (const btn of slot.querySelectorAll('[data-pick-hour]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.pickHour === hh));
  }
  for (const btn of slot.querySelectorAll('[data-pick-min]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.pickMin === mm));
  }
}

function bindWheelColumnScroll(col, ctx) {
  let timer = null;
  col.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const items = col.querySelectorAll('.picker-wheel-item');
      if (items.length === 0) {
        return;
      }
      const rawIdx = Math.round(col.scrollTop / 34);
      const idx = Math.max(0, Math.min(items.length - 1, rawIdx));
      const picked = items[idx];
      const cur = parseHhmmParts(
        ctx.root.querySelector(`#${ctx.targetId}`)?.value
      );
      const prev = `${pad2(cur.hour)}:${pad2(cur.min)}`;
      const next = col.dataset.wheel === 'hour'
        ? `${picked.dataset.pickHour}:${pad2(cur.min)}`
        : `${pad2(cur.hour)}:${picked.dataset.pickMin}`;
      if (next !== prev) {
        updateTimeVisualsInPlace(ctx.root, ctx.slot, ctx.targetId, next);
        ctx.onChange?.(ctx.targetId, next, 'time');
      }
    }, 90);
  }, { passive: true });
}

function attachWheelScrollSync(slot, root, targetId, onChange) {
  if (!slot?.querySelectorAll) {
    return;
  }
  const ctx = { slot, root, targetId, onChange };
  for (const col of slot.querySelectorAll('.picker-wheel-col')) {
    const sel = col.querySelector('[aria-selected="true"]');
    if (sel && col.clientHeight > 0) {
      col.scrollTop = sel.offsetTop - (col.clientHeight - sel.clientHeight) / 2;
    }
    if (typeof col.addEventListener === 'function') {
      bindWheelColumnScroll(col, ctx);
    }
  }
}

function togglePickerSlot(root, openBtn, todayIso, onChange) {
  const kind = openBtn.dataset.pickerOpen;
  const targetId = openBtn.dataset.pickerTarget;
  const slot = root.querySelector(`[data-picker-slot="${targetId}"]`);
  if (!slot) {
    return;
  }
  const wasOpen = !slot.hidden;
  closeAllPickers(root);
  if (wasOpen) {
    return;
  }
  const curVal = root.querySelector(`#${targetId}`)?.value || '';
  slot.innerHTML = kind === 'date'
    ? buildDatePanelHtml(targetId, curVal, todayIso, null)
    : buildTimePanelHtml(targetId, curVal);
  slot.hidden = false;
  openBtn.setAttribute('aria-expanded', 'true');
  if (kind === 'time') {
    attachWheelScrollSync(slot, root, targetId, onChange);
  }
}

function applyTimeChange(root, targetId, nextVal, onChange) {
  syncPickerDisplay(root, targetId, nextVal, 'time');
  const slot = root.querySelector(`[data-picker-slot="${targetId}"]`);
  if (slot && !slot.hidden) {
    slot.innerHTML = buildTimePanelHtml(targetId, nextVal);
    attachWheelScrollSync(slot, root, targetId, onChange);
  }
  onChange?.(targetId, nextVal, 'time');
}

function stepTimeMinutes(rawVal, delta) {
  const cur = parseHhmmParts(rawVal);
  const nextTotal = (cur.hour * 60 + cur.min + delta + 1440) % 1440;
  return `${pad2(Math.floor(nextTotal / 60))}:${pad2(nextTotal % 60)}`;
}

function handleTimeCellClick(root, target, onChange) {
  const presetBtn = target.closest('[data-pick-preset]');
  if (presetBtn) {
    const tid = presetBtn.dataset.pickerTarget;
    applyTimeChange(root, tid, presetBtn.dataset.pickPreset, onChange);
    return true;
  }
  const hourBtn = target.closest('[data-pick-hour]');
  if (hourBtn) {
    const tid = hourBtn.dataset.pickerTarget;
    const { min } = parseHhmmParts(root.querySelector(`#${tid}`)?.value);
    const next = `${hourBtn.dataset.pickHour}:${pad2(min)}`;
    applyTimeChange(root, tid, next, onChange);
    return true;
  }
  const minBtn = target.closest('[data-pick-min]');
  if (minBtn) {
    const tid = minBtn.dataset.pickerTarget;
    const { hour } = parseHhmmParts(root.querySelector(`#${tid}`)?.value);
    const next = `${pad2(hour)}:${minBtn.dataset.pickMin}`;
    applyTimeChange(root, tid, next, onChange);
    return true;
  }
  const stepBtn = target.closest('[data-pick-min-step]');
  if (!stepBtn) {
    return false;
  }
  const tid = stepBtn.dataset.pickerTarget;
  const next = stepTimeMinutes(
    root.querySelector(`#${tid}`)?.value, Number(stepBtn.dataset.pickMinStep)
  );
  applyTimeChange(root, tid, next, onChange);
  return true;
}

function handleDateCellClick(root, target, todayIso, onChange) {
  const todayBtn = target.closest('[data-pick-cal-today]');
  if (todayBtn) {
    const tid = todayBtn.dataset.pickerTarget;
    syncPickerDisplay(root, tid, todayIso, 'date');
    closeAllPickers(root);
    onChange?.(tid, todayIso, 'date');
    return true;
  }
  const stepBtn = target.closest('[data-pick-cal-step]');
  if (stepBtn) {
    const tid = stepBtn.dataset.pickerTarget;
    const panel = stepBtn.closest('.picker-panel');
    const slot = root.querySelector(`[data-picker-slot="${tid}"]`);
    if (panel && slot) {
      const dt = new Date(
        Number(panel.dataset.calYear),
        Number(panel.dataset.calMonth) + Number(stepBtn.dataset.pickCalStep),
        1
      );
      const curVal = root.querySelector(`#${tid}`)?.value || todayIso;
      slot.innerHTML = buildDatePanelHtml(tid, curVal, todayIso, {
        year: dt.getFullYear(), month: dt.getMonth()
      });
    }
    return true;
  }
  const dayBtn = target.closest('[data-pick-cal-day]');
  if (!dayBtn) {
    return false;
  }
  const tid = dayBtn.dataset.pickerTarget;
  const iso = dayBtn.dataset.pickCalDay;
  syncPickerDisplay(root, tid, iso, 'date');
  closeAllPickers(root);
  onChange?.(tid, iso, 'date');
  return true;
}

export function handlePickerClick(root, event, todayIso, onChange) {
  const target = event?.target;
  if (!root || !target?.closest) {
    return false;
  }
  const openBtn = target.closest('[data-picker-open]');
  if (openBtn) {
    togglePickerSlot(root, openBtn, todayIso, onChange);
    return true;
  }
  if (target.closest('[data-picker-done]')) {
    closeAllPickers(root);
    return true;
  }
  return handleTimeCellClick(root, target, onChange) ||
    handleDateCellClick(root, target, todayIso, onChange);
}
