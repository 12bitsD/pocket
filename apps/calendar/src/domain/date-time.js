const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

export const DOW_LABELS = Object.freeze([
  '周日', '周一', '周二', '周三', '周四', '周五', '周六'
]);

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => HTML_ESCAPES[ch]
  );
}

export function pad2(num) {
  return String(num).padStart(2, '0');
}

export function formatDateParts(dateObj) {
  const year = dateObj.getFullYear();
  const month = pad2(dateObj.getMonth() + 1);
  const day = pad2(dateObj.getDate());
  return `${year}-${month}-${day}`;
}

export function parseIsoParts(dateIso) {
  const parts = String(dateIso).split('-').map(Number);
  return [parts[0], parts[1] - 1, parts[2]];
}

export function dateViewPatch(dateIso) {
  return {
    selectedDate: dateIso,
    viewYear: Number(dateIso.slice(0, 4)),
    viewMonth: Number(dateIso.slice(5, 7)) - 1
  };
}

export function localDateIso(offsetDays, baseDate) {
  const anchor = baseDate ? new Date(baseDate.getTime()) : new Date();
  anchor.setHours(0, 0, 0, 0);
  anchor.setDate(anchor.getDate() + (offsetDays || 0));
  return formatDateParts(anchor);
}

export function addDaysIso(dateIso, deltaDays) {
  const [year, monthIdx, day] = parseIsoParts(dateIso);
  const dateObj = new Date(year, monthIdx, day + deltaDays);
  return formatDateParts(dateObj);
}

export function isoWeekday(dateIso) {
  const [year, monthIdx, day] = parseIsoParts(dateIso);
  return new Date(year, monthIdx, day).getDay();
}

export function mondayIndexFromIso(dateIso) {
  return (isoWeekday(dateIso) + 6) % 7;
}

export function toMinutes(hhmm) {
  const [hours, mins] = String(hhmm || '00:00').split(':').map(Number);
  return hours * 60 + mins;
}

export function minutesToHhmm(totalMinutes) {
  const clamped = Math.max(0, Math.min(1439, Math.trunc(totalMinutes)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

export function localDateTimeMs(dateIso, hhmm) {
  const [year, monthIdx, day] = parseIsoParts(dateIso);
  const [hours, mins] = String(hhmm || '00:00').split(':').map(Number);
  return new Date(year, monthIdx, day, hours, mins, 0, 0).getTime();
}

export function formatDelta(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  return `${Math.floor(mins / 60)}h ${pad2(mins % 60)}m`;
}

export function buildMonthCells(year, month) {
  const startOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const cells = [];
  for (let i = 0; i < total; i += 1) {
    const dt = new Date(year, month, 1 - startOffset + i);
    cells.push({
      iso: formatDateParts(dt),
      day: dt.getDate(),
      outside: dt.getMonth() !== month
    });
  }
  return cells;
}

export function computeMonthFetchRange(year, month) {
  const cells = buildMonthCells(year, month);
  return {
    startDate: cells[0].iso,
    endDate: cells[cells.length - 1].iso
  };
}

export function computeDefaultSyncRange(todayIso) {
  const [year, monthIdx] = parseIsoParts(todayIso);
  const grid = computeMonthFetchRange(year, monthIdx);
  return {
    startDate: grid.startDate,
    endDate: addDaysIso(grid.startDate, 62)
  };
}
