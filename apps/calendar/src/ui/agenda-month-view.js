import {
  describeAlarmStatus,
  formatRepeatLabel
} from '../domain/calendar-model.js';
import {
  buildMonthCells,
  escapeHtml,
  formatDelta,
  localDateTimeMs,
  pad2
} from '../domain/date-time.js';

const WEEK_SHORT = Object.freeze(['一', '二', '三', '四', '五', '六', '日']);

function buildReminderBadge(ev) {
  if (ev.reminder_policy === 'alarm') {
    return '<span class="mark-tag lock">强提醒响铃</span>';
  }
  if (ev.reminder_policy === 'notify') {
    const mins = escapeHtml(ev.reminder_offset_minutes ?? 10);
    return `<span class="mark-tag neutral">通知 -${mins}m</span>`;
  }
  return '';
}

function buildSourceBadge(ev) {
  if (ev.source === 'agent') {
    return '<span class="mark-tag neutral">@agent</span>';
  }
  if (typeof ev.source === 'string' && ev.source.startsWith('@')) {
    return `<span class="mark-tag neutral">${escapeHtml(ev.source)}</span>`;
  }
  return '';
}

function buildEventTags(ev) {
  const tags = [];
  if (ev.has_conflict) {
    tags.push('<span class="mark-tag lock">时间重叠</span>');
  }
  const rem = buildReminderBadge(ev);
  if (rem) {
    tags.push(rem);
  }
  const src = buildSourceBadge(ev);
  if (src) {
    tags.push(src);
  }
  return tags.join(' ');
}

function buildHeroReceiptHtml(ev) {
  if (ev.reminder_policy !== 'alarm') {
    return '<span class="receipt-code"><i class="dot ok"></i>TODAY</span>';
  }
  const alarm = describeAlarmStatus(ev.alarm_status);
  return `<span class="receipt-code"><i class="dot ${alarm.dotClass}"></i>` +
    `ALARM ${escapeHtml(alarm.code)}</span>`;
}

function buildAgendaHeroHtml(next, nowMs) {
  const startMs = localDateTimeMs(next.instance_date, next.start_hhmm);
  const endMs = localDateTimeMs(next.instance_date, next.end_hhmm);
  let dotCls = 'mark';
  let headText = '今日已结束 · 末场回顾';
  if (startMs > nowMs) {
    headText = `<b>${formatDelta(startMs - nowMs)}</b> 后开始 · 今日下一场`;
  } else if (endMs >= nowMs) {
    headText = '正在进行 · 今日当前日程';
  } else {
    dotCls = 'off';
  }
  const badges = buildEventTags(next) ||
    '<span class="mark-tag neutral">静默日程</span>';
  const meta = next.location || formatRepeatLabel(next.repeat_rule);
  const id = escapeHtml(next.event_id);
  const span = `${escapeHtml(next.start_hhmm)}–${escapeHtml(next.end_hhmm)}`;
  return `<article class="hero">
    <div class="hero-top">
      <span class="t-minus"><i class="dot ${dotCls}"></i>${headText}</span>
      <span class="inline-actions">${badges}</span>
    </div>
    <div class="hero-mid">
      <button class="hero-main-btn" type="button" data-edit="${id}">
        <span class="hero-range">${span}</span>
      </button>
    </div>
    <div class="hero-foot">
      <div class="hero-name">
        ${escapeHtml(next.title)} <span>${escapeHtml(meta)}</span>
      </div>
      ${buildHeroReceiptHtml(next)}
    </div>
  </article>`;
}

function buildEventRowHtml(ev, subLabel, rowCls) {
  const repeatText = formatRepeatLabel(ev.repeat_rule);
  const locText = ev.location || '无地点';
  const smallHtml = subLabel ? `<small>${escapeHtml(subLabel)}</small>` : '';
  const id = escapeHtml(ev.event_id);
  const span = `${escapeHtml(ev.start_hhmm)}–${escapeHtml(ev.end_hhmm)}`;
  const meta = `${escapeHtml(locText)} · ${escapeHtml(repeatText)}`;
  const cls = rowCls ? `row ${rowCls}` : 'row';
  return `<article class="${cls}">
    <button class="row-btn event-grid" type="button" data-edit="${id}">
      <span class="row-span">${span}${smallHtml}</span>
      <span>
        <span class="row-title">
          ${escapeHtml(ev.title)} ${buildEventTags(ev)}
        </span>
        <span class="row-meta">${meta}</span>
      </span>
    </button>
  </article>`;
}

export function renderAgendaView(state, nowMs) {
  const now = nowMs ?? Date.now();
  const todayList = state.todayEvents;
  const next = todayList.find(
    (ev) => localDateTimeMs(ev.instance_date, ev.end_hhmm) >= now
  ) || todayList.at(-1) || null;
  const others = next
    ? todayList.filter((ev) => ev.event_id !== next.event_id)
    : [];
  const hero = next
    ? buildAgendaHeroHtml(next, now)
    : `<div class="empty">今天（${escapeHtml(state.todayIso)}）没有日程安排<br>` +
      '<button class="cmd-quiet outlined" type="button" data-open-event>' +
      '+ 新建今日日程</button></div>';
  const rows = others.map((ev) => {
    const past = localDateTimeMs(ev.instance_date, ev.end_hhmm) < now;
    return buildEventRowHtml(ev, past ? '已结束' : '今天', past ? 'disabled' : '');
  }).join('');
  const emptyRest = '<div class="row" style="padding:14px 2px">' +
    '<span class="row-meta">' +
    '今日其余时段空闲（跨天日程在 [m] 月历查看）</span></div>';
  const todayHead = `TODAY · ${escapeHtml(state.todayIso)} ` +
    `(其余 ${others.length} 场)`;
  return `<div class="foreground-stack">
    ${hero}
    <div class="col-head">
      <span>${todayHead}</span>
      <span>REMINDER</span>
    </div>
    <div class="rows">${rows || emptyRest}</div>
  </div>`;
}

function buildMonthCellHtml(cell, state) {
  const dayEvents = state.monthEvents.filter(
    (ev) => ev.instance_date === cell.iso
  );
  const dots = dayEvents.slice(0, 3).map((ev) => (
    `<i class="${ev.reminder_policy === 'alarm' ? 'strong' : 'normal'}"></i>`
  )).join('');
  const classes = ['cal-cell'];
  if (cell.outside) {
    classes.push('outside');
  }
  if (cell.iso === state.todayIso) {
    classes.push('today');
  }
  const selected = cell.iso === state.selectedDate;
  const countLabel = dayEvents.length > 0 ? ` · ${dayEvents.length} 场日程` : '';
  const aria = escapeHtml(`${cell.iso}${countLabel}`);
  return `<button class="${classes.join(' ')}" type="button" ` +
    `aria-label="${aria}" ` +
    `data-pick-date="${escapeHtml(cell.iso)}" aria-selected="${selected}">
    <span>${pad2(cell.day)}</span>
    <span class="cal-dots">${dots}</span>
  </button>`;
}

export function renderMonthView(state) {
  const cells = buildMonthCells(state.viewYear, state.viewMonth);
  const monthLabel = `${state.viewYear}-${pad2(state.viewMonth + 1)}`;
  const gridHtml = cells.map((c) => buildMonthCellHtml(c, state)).join('');
  const selectedEvents = state.monthEvents.filter(
    (ev) => ev.instance_date === state.selectedDate
  );
  const dayRows = selectedEvents
    .map((ev) => buildEventRowHtml(ev, '', ''))
    .join('');
  const emptyDay = '<div class="row compact">' +
    '<span class="row-meta">当日暂无日程安排</span>' +
    '<button class="cmd-quiet mini" type="button" data-open-event>' +
    '+ 添加</button></div>';
  const weekHtml = WEEK_SHORT.map((w) => `<span>${w}</span>`).join('');
  const selHead = `${escapeHtml(state.selectedDate)} ` +
    `(${selectedEvents.length})`;
  return `<div class="foreground-stack">
    <div class="cal-card">
      <div class="cal-toolbar">
        <button class="cmd-quiet outlined mini" type="button"
          data-month-step="-1">← prev</button>
        <span class="cal-month-label">${monthLabel}</span>
        <div class="date-shortcuts">
          <button class="cmd-quiet outlined mini" type="button"
            data-month-today>today</button>
          <button class="cmd-quiet outlined mini" type="button"
            data-month-step="1">next →</button>
        </div>
      </div>
      <div class="cal-weekdays">${weekHtml}</div>
      <div class="cal-grid">${gridHtml}</div>
    </div>
    <div class="col-head">
      <span>${selHead}</span>
      <button class="cmd-quiet outlined mini" type="button"
        data-open-event>+ 在该日新建</button>
    </div>
    <div class="rows">${dayRows || emptyDay}</div>
  </div>`;
}
