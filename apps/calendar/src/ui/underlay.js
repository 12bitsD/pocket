import { describeConnection } from '../domain/calendar-model.js';
import { escapeHtml, toMinutes } from '../domain/date-time.js';
import { isTodoActive, summarizeTodos } from '../domain/todo-model.js';

export const PAGE_META = Object.freeze({
  agenda: Object.freeze(['今日日程', '/today', '新建']),
  month: Object.freeze(['月历', '/month', '新建']),
  todo: Object.freeze(['待办', '/todo', '']),
  settings: Object.freeze(['设置', '/config', ''])
});

export const NAV_ITEMS = Object.freeze([
  Object.freeze(['agenda', '今日', 'd']),
  Object.freeze(['month', '月历', 'm']),
  Object.freeze(['todo', '待办', 't'])
]);

const SVG_ATTR = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"';

export const CHEVRON_LEFT_SVG = '<svg class="btn-icon" viewBox="0 0 24 24" ' +
  'aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14.5 6.5L9 12l5.5 5.5"/></svg>';

export const CHEVRON_RIGHT_SVG = '<svg class="btn-icon" viewBox="0 0 24 24" ' +
  'aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M9.5 6.5L15 12l-5.5 5.5"/></svg>';

const NAV_ICONS = Object.freeze({
  agenda: `<svg ${SVG_ATTR}>` +
    '<circle class="nav-icon-wash" cx="12" cy="12" r="8.5" stroke="none"/>' +
    '<circle cx="12" cy="12" r="8.5"/>' +
    '<path d="M12 7.5V12l3 2"/>' +
    '<circle class="nav-icon-accent" cx="12" cy="12" r="1.3" ' +
    'stroke="none"/></svg>',
  month: `<svg ${SVG_ATTR}>` +
    '<path class="nav-icon-fill" stroke="none" ' +
    'd="M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5V9.8h-17z"/>' +
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/>' +
    '<path d="M3.5 9.8h17M8 3.2v3M16 3.2v3"/>' +
    '<circle class="nav-icon-accent" cx="12" cy="14.9" r="1.55" ' +
    'stroke="none"/></svg>',
  todo: `<svg ${SVG_ATTR}>` +
    '<rect class="nav-icon-wash" x="4" y="4" width="16" height="16" rx="3" ' +
    'stroke="none"/>' +
    '<rect x="4" y="4" width="16" height="16" rx="3"/>' +
    '<path class="nav-icon-stroke-accent" d="M8.5 12.2l2.4 2.4 4.8-5"/>' +
    '</svg>'
});

const BRAILLE_LEFT = Object.freeze([0x01, 0x02, 0x04, 0x40]);
const BRAILLE_RIGHT = Object.freeze([0x08, 0x10, 0x20, 0x80]);

export function buildTtyBarHtml(state) {
  const meta = PAGE_META[state.page] || PAGE_META.agenda;
  const slug = meta[1].slice(1);
  const pathHtml = `<b>$</b>pocket/${escapeHtml(slug)}`;
  const conn = describeConnection(state);
  const qLen = (state.offlineQueue?.mutations?.length || 0) +
    (state.offlineQueue?.receipts?.length || 0);
  const qTag = qLen > 0 ? ` · queue ${qLen}` : '';
  const statText = `${escapeHtml(conn.label)}${qTag}`;
  return {
    pathHtml,
    statHtml: `<i class="dot ${conn.dotClass}"></i>${statText}`
  };
}

function setBrailleDot(grid, dims, sx, sy) {
  if (sx < 0 || sx >= dims.subW || sy < 0 || sy >= dims.subH) {
    return;
  }
  const cx = Math.floor(sx / 2);
  const cy = Math.floor(sy / 4);
  const bit = sx % 2 === 0 ? BRAILLE_LEFT[sy % 4] : BRAILLE_RIGHT[sy % 4];
  grid[cy][cx] |= bit;
}

function drawAxisBaseline(grid, dims) {
  for (let sx = 0; sx < dims.subW; sx += 2) {
    setBrailleDot(grid, dims, sx, dims.subH - 3);
  }
  for (let hour = 0; hour <= 24; hour += 6) {
    const tx = Math.min(
      dims.subW - 1, Math.round((hour / 24) * (dims.subW - 1))
    );
    setBrailleDot(grid, dims, tx, dims.subH - 4);
    setBrailleDot(grid, dims, tx, dims.subH - 2);
  }
}

function plotTodoPulses(grid, overlay, dims, timedTodos) {
  for (const td of timedTodos) {
    const ratio = toMinutes(td.time_hhmm) / 1440;
    const sx = Math.min(dims.subW - 1, Math.round(ratio * (dims.subW - 1)));
    for (let y = 3; y <= dims.subH - 3; y += 1) {
      setBrailleDot(grid, dims, sx, y);
    }
    const key = `0:${Math.floor(sx / 2)}`;
    const sym = td.assignee === '@me'
      ? '<span class="mark">◆</span>'
      : '<span class="hi">●</span>';
    overlay.set(key, sym);
  }
}

function plotEventIntervals(grid, overlay, dims, dayEvents) {
  for (const [idx, ev] of dayEvents.entries()) {
    const x1 = Math.max(
      0, Math.round((toMinutes(ev.start_hhmm) / 1440) * (dims.subW - 1))
    );
    const rawX2 = Math.round((toMinutes(ev.end_hhmm) / 1440) * (dims.subW - 1));
    const x2 = Math.min(dims.subW - 1, Math.max(x1 + 2, rawX2));
    const rowBand = 3 + (idx % 3) * 4;
    for (let x = x1; x <= x2; x += 1) {
      setBrailleDot(grid, dims, x, rowBand);
      setBrailleDot(grid, dims, x, rowBand + 1);
    }
    const key = `${Math.floor(rowBand / 4)}:${Math.floor(x1 / 2)}`;
    if (!overlay.has(key)) {
      const sym = ev.reminder_policy === 'alarm'
        ? '<span class="mark">◆</span>'
        : '<span class="hi">▪</span>';
      overlay.set(key, sym);
    }
  }
}

function buildIntervalBraille(page, dayEvents, timedTodos) {
  const charCols = 48;
  const charRows = 4;
  const dims = { subW: charCols * 2, subH: charRows * 4 };
  const grid = Array.from({ length: charRows }, () => Array(charCols).fill(0));
  const overlay = new Map();
  drawAxisBaseline(grid, dims);
  if (page === 'todo') {
    plotTodoPulses(grid, overlay, dims, timedTodos);
  } else {
    plotEventIntervals(grid, overlay, dims, dayEvents);
  }
  return grid.map((row, rIdx) => row.map((mask, cIdx) => {
    const key = `${rIdx}:${cIdx}`;
    if (overlay.has(key)) {
      return overlay.get(key);
    }
    return mask === 0 ? ' ' : String.fromCodePoint(0x2800 + mask);
  }).join(''));
}

function buildUnderlayEquations(state, focusDate, dayEvents) {
  const overlapCount = dayEvents.filter((e) => e.has_conflict).length;
  const eq1 = state.page === 'todo'
    ? 'route: Todo ↦ { ∅, @me ↦ alarm, @agent ↦ post }'
    : `w ≡ (d + ⌊13(m+1)/5⌋ + K) mod 7     date = ${escapeHtml(focusDate)}`;
  const summary = state.todoSummary || summarizeTodos(state.todos);
  let eq2 = `Iₖ = [sₖ, eₖ),  ∀i≠j: Iᵢ ∩ Iⱼ = ∅   (|I| = ${dayEvents.length})`;
  if (state.page === 'todo') {
    const open = summary.openCount;
    const cyc = summary.cycleCount;
    eq2 = `|todo| = ${open},  |cycle| = ${cyc}   ◆=@me  ●=@agent`;
  } else if (overlapCount > 0) {
    eq2 = `Iₖ = [sₖ, eₖ)   ⋂ Iₖ ≠ ∅ (${overlapCount} overlapping)`;
  }
  const eq2Cls = overlapCount > 0 && state.page !== 'todo' ? 'mark' : 'hi';
  return { eq1, eq2, eq2Cls };
}

function formatUnderlayLine(row, spec) {
  const axis = row % 6 === 0 ? `w${row / 6}` : String(row).padStart(2, '0');
  if (row <= 29) {
    return `${axis}│`;
  }
  if (row === 30) {
    return `${axis}│   ∶       +       ·       ≡       ·       +       ∶`;
  }
  if (row === 31) {
    return `${axis}│  <span class="hi">${spec.eq1}</span>`;
  }
  if (row >= 32 && row <= 35) {
    return `${axis}│   ${spec.bandLines[row - 32]}`;
  }
  if (row === 36) {
    return `${axis}│   00h         06h         12h         18h        24h`;
  }
  if (row === 37) {
    return `${axis}│  <span class="${spec.eq2Cls}">${spec.eq2}</span>`;
  }
  return `${axis}│   ·       ∶       ∆       ·       ∈       ∶       ·`;
}

export function buildAsciiUnderlayHtml(state) {
  const focusDate = state.page === 'month'
    ? state.selectedDate
    : state.todayIso;
  const pool = state.page === 'month' ? state.monthEvents : state.todayEvents;
  const dayEvents = pool.filter((e) => e.instance_date === focusDate);
  const timedTodos = state.todos.filter(
    (t) => isTodoActive(t) && t.assignee !== 'none' && t.time_hhmm
  );
  const bandLines = buildIntervalBraille(state.page, dayEvents, timedTodos);
  const eqSpec = buildUnderlayEquations(state, focusDate, dayEvents);
  const spec = { ...eqSpec, bandLines };
  const lines = [];
  for (let row = 1; row <= 38; row += 1) {
    lines.push(formatUnderlayLine(row, spec));
  }
  return lines.join('\n');
}

export function syncUnderlayDom(doc, cache, state) {
  const canvas = doc.querySelector('#ascii-canvas');
  if (!canvas) {
    return;
  }
  const focusDate = state.page === 'month'
    ? state.selectedDate
    : state.todayIso;
  const pool = state.page === 'month' ? state.monthEvents : state.todayEvents;
  const same = cache.uPage === state.page &&
    cache.uDate === focusDate &&
    cache.uPool === pool &&
    cache.uTodos === state.todos;
  if (!same) {
    cache.uPage = state.page;
    cache.uDate = focusDate;
    cache.uPool = pool;
    cache.uTodos = state.todos;
    canvas.innerHTML = buildAsciiUnderlayHtml(state);
  }
}

export function syncBottomNavDom(doc, cache, page) {
  if (cache.navPage === page) {
    return;
  }
  cache.navPage = page;
  doc.querySelector('#bottom-nav').innerHTML = NAV_ITEMS.map(
    ([id, label, key]) => (
      `<button class="nav-item" type="button" data-page="${id}" ` +
      `${page === id ? 'aria-current="page"' : ''}>` +
      `<span class="nav-icon" aria-hidden="true">${NAV_ICONS[id]}</span>` +
      `<span class="nav-label"><span>${label}</span>` +
      `<kbd>[${key}]</kbd></span></button>`
    )
  ).join('');
}
