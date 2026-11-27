import {
  buildMonthCells,
  DOW_LABELS,
  escapeHtml,
  pad2
} from '../domain/date-time.js';
import { CHEVRON_LEFT_SVG, CHEVRON_RIGHT_SVG } from './underlay.js';

const HOURS = Object.freeze(Array.from({ length: 24 }, (_, idx) => pad2(idx)));
const MINUTE_STEPS = Object.freeze(
  Array.from({ length: 12 }, (_, idx) => pad2(idx * 5))
);
const TIME_PRESETS = Object.freeze(['07:30', '09:00', '14:00', '21:00']);
const WEEK_HEADERS = Object.freeze(['一', '二', '三', '四', '五', '六', '日']);

export function parseHhmmParts(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  const hour = match ? Math.min(23, Math.max(0, Number(match[1]))) : 9;
  const min = match ? Math.min(59, Math.max(0, Number(match[2]))) : 0;
  return { hour, min };
}

export function parseIsoParts(raw, fallbackIso) {
  const src = /^\d{4}-\d{2}-\d{2}$/.test(String(raw || ''))
    ? String(raw)
    : String(fallbackIso || '2026-01-01');
  const [year, month, day] = src.split('-').map(Number);
  return { year, month: month - 1, day };
}

export function formatDateButtonLabel(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) {
    return String(iso || '');
  }
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return `${y}年${m}月${d}日 · ${DOW_LABELS[dow] || ''}`;
}

export function buildTimeFieldHtml(spec) {
  const id = escapeHtml(spec.id);
  const name = escapeHtml(spec.name || spec.id);
  const val = escapeHtml(spec.value || '09:00');
  const aria = escapeHtml(spec.ariaLabel || '选择时间');
  const dis = spec.disabled ? 'disabled' : '';
  const extraCls = spec.compact ? 'compact' : 'large';
  return `<div class="picker-anchor" data-picker-wrap="${id}">
    <input type="hidden" id="${id}" name="${name}" value="${val}">
    <button class="picker-trigger time-trigger ${extraCls}" type="button" ${dis}
      aria-label="${aria}" aria-expanded="false"
      data-picker-open="time" data-picker-target="${id}">
      <span data-picker-label="${id}">${val}</span>
    </button>
    <div class="picker-slot" data-picker-slot="${id}" hidden></div>
  </div>`;
}

export function buildDateFieldHtml(spec) {
  const id = escapeHtml(spec.id);
  const name = escapeHtml(spec.name || spec.id);
  const val = escapeHtml(spec.value || '');
  const aria = escapeHtml(spec.ariaLabel || '选择日期');
  const dis = spec.disabled ? 'disabled' : '';
  const label = escapeHtml(formatDateButtonLabel(spec.value));
  return `<div class="picker-anchor" data-picker-wrap="${id}">
    <input type="hidden" id="${id}" name="${name}" value="${val}">
    <button class="picker-trigger date-trigger" type="button" ${dis}
      aria-label="${aria}" aria-expanded="false"
      data-picker-open="date" data-picker-target="${id}">
      <span data-picker-label="${id}">${label}</span>
    </button>
    <div class="picker-slot" data-picker-slot="${id}" hidden></div>
  </div>`;
}

function buildWheelColumnHtml(items, attr, tid, activeVal) {
  return items.map((val) => (
    `<button class="picker-wheel-item" type="button" ${attr}="${val}" ` +
    `data-picker-target="${tid}" aria-selected="${val === activeVal}">` +
    `${val}</button>`
  )).join('');
}

export function buildTimePanelHtml(targetId, currentVal) {
  const { hour, min } = parseHhmmParts(currentVal);
  const hh = pad2(hour);
  const mm = pad2(min);
  const tid = escapeHtml(targetId);
  const period = hour < 12 ? '上午' : '下午';
  const mList = MINUTE_STEPS.includes(mm)
    ? MINUTE_STEPS
    : [...MINUTE_STEPS, mm].sort();
  const hBtns = buildWheelColumnHtml(HOURS, 'data-pick-hour', tid, hh);
  const mBtns = buildWheelColumnHtml(mList, 'data-pick-min', tid, mm);
  const presets = TIME_PRESETS.map((val) => (
    `<button class="picker-preset-btn" type="button" ` +
    `data-pick-preset="${val}" data-picker-target="${tid}" ` +
    `aria-pressed="${val === `${hh}:${mm}`}">${val}</button>`
  )).join('');
  return `<div class="picker-panel time-panel">
    <div class="picker-head">
      <div class="picker-readout-group">
        <span class="picker-readout">${hh}:${mm}</span>
        <span class="picker-period">${period}</span>
      </div>
      <div class="inline-actions">
        <button class="step-chip" type="button"
          data-pick-min-step="-1" data-picker-target="${tid}">−1</button>
        <button class="step-chip" type="button"
          data-pick-min-step="1" data-picker-target="${tid}">+1</button>
        <button class="cmd-primary mini" type="button"
          data-picker-done="${tid}">完成</button>
      </div>
    </div>
    <div class="picker-wheel-shell">
      <div class="picker-wheel-band" aria-hidden="true"><span>:</span></div>
      <div class="picker-wheel-col" data-wheel="hour">${hBtns}</div>
      <div class="picker-wheel-col" data-wheel="min">${mBtns}</div>
    </div>
    <div class="picker-presets">${presets}</div>
  </div>`;
}

export function buildDatePanelHtml(targetId, selectedIso, todayIso, viewYm) {
  const base = viewYm || parseIsoParts(selectedIso, todayIso);
  const cells = buildMonthCells(base.year, base.month);
  const ymLabel = `${base.year}年 ${base.month + 1}月`;
  const tid = escapeHtml(targetId);
  const weekHtml = WEEK_HEADERS.map((w) => `<span>${w}</span>`).join('');
  const gridHtml = cells.map((cell) => {
    const cls = ['cal-cell', 'mini-cal-cell'];
    if (cell.outside) {
      cls.push('outside');
    }
    if (cell.iso === todayIso) {
      cls.push('today');
    }
    const sel = cell.iso === selectedIso;
    return `<button class="${cls.join(' ')}" type="button" ` +
      `data-pick-cal-day="${cell.iso}" data-picker-target="${tid}" ` +
      `aria-selected="${sel}"><span class="cal-num">${cell.day}</span>` +
      `</button>`;
  }).join('');
  return `<div class="picker-panel cal-panel" data-cal-year="${base.year}"
      data-cal-month="${base.month}">
    <div class="picker-head cal-picker-head">
      <span class="picker-cal-title">${ymLabel}</span>
      <div class="inline-actions">
        <button class="ghost-chip" type="button"
          data-pick-cal-today data-picker-target="${tid}">今天</button>
        <button class="nav-arrow-btn" type="button" aria-label="上个月"
          data-pick-cal-step="-1"
          data-picker-target="${tid}">${CHEVRON_LEFT_SVG}</button>
        <button class="nav-arrow-btn" type="button" aria-label="下个月"
          data-pick-cal-step="1"
          data-picker-target="${tid}">${CHEVRON_RIGHT_SVG}</button>
      </div>
    </div>
    <div class="cal-weekdays">${weekHtml}</div>
    <div class="cal-grid">${gridHtml}</div>
  </div>`;
}
