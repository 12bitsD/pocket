import {
  describeAlarmStatus,
  formatRepeatLabel
} from '../domain/calendar-model.js';
import {
  buildMonthCells,
  escapeHtml,
  formatDelta,
  localDateTimeMs
} from '../domain/date-time.js';
import { buildAppUpdateBannerHtml } from '../native/update-bridge.js';
import { CHEVRON_LEFT_SVG, CHEVRON_RIGHT_SVG } from './underlay.js';

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

function buildEventTags(ev) {
  const tags = [];
  if (ev.has_conflict) {
    tags.push('<span class="mark-tag lock">时间重叠</span>');
  }
  const rem = buildReminderBadge(ev);
  if (rem) {
    tags.push(rem);
  }
  return tags.join(' ');
}

function formatEventSourceMeta(ev) {
  if (ev.source === 'agent') {
    return '@agent';
  }
  if (typeof ev.source === 'string' && ev.source.startsWith('@')) {
    return ev.source;
  }
  return '';
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
    headText = `<b>${formatDelta(startMs - nowMs)}</b> 后开始`;
  } else if (endMs >= nowMs) {
    headText = '正在进行';
  } else {
    dotCls = 'off';
  }
  const badges = buildEventTags(next);
  const meta = next.location || formatRepeatLabel(next.repeat_rule);
  const id = escapeHtml(next.event_id);
  const span = `${escapeHtml(next.start_hhmm)} – ${escapeHtml(next.end_hhmm)}`;
  return `<article class="hero">
    <div class="hero-top">
      <span class="t-minus"><i class="dot ${dotCls}"></i>${headText}</span>
      ${buildHeroReceiptHtml(next)}
    </div>
    <button class="hero-main-btn" type="button" data-edit="${id}">
      <span class="hero-range">${span}</span>
      <span class="hero-event-title">${escapeHtml(next.title)}</span>
    </button>
    <div class="hero-foot">
      <span class="hero-meta-text">${escapeHtml(meta)}</span>
      <span class="inline-actions">${badges}</span>
    </div>
  </article>`;
}

function buildEventRowHtml(ev, subLabel, rowCls) {
  const repeatText = formatRepeatLabel(ev.repeat_rule);
  const srcMeta = formatEventSourceMeta(ev);
  const metaParts = [
    ev.location || (repeatText !== '不重复' ? repeatText : ''),
    srcMeta
  ].filter(Boolean);
  const locText = metaParts.join(' · ');
  const subText = subLabel || ev.end_hhmm;
  const id = escapeHtml(ev.event_id);
  const cls = rowCls ? `row ${rowCls}` : 'row';
  return `<article class="${cls}">
    <button class="row-btn event-grid" type="button" data-edit="${id}">
      <span class="row-span">
        ${escapeHtml(ev.start_hhmm)}
        <small>${escapeHtml(subText)}</small>
      </span>
      <span>
        <span class="row-title">
          ${escapeHtml(ev.title)} ${buildEventTags(ev)}
        </span>
        ${locText ? `<span class="row-meta">${escapeHtml(locText)}</span>` : ''}
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
    return buildEventRowHtml(ev, past ? '已结束' : '', past ? 'disabled' : '');
  }).join('');
  const emptyRest = '<div class="row compact">' +
    '<span class="row-meta">今日其余时段空闲</span></div>';
  const todayHead = `今日 · ${escapeHtml(state.todayIso)}`;
  return `<div class="foreground-stack">
    ${buildAppUpdateBannerHtml(state)}
    ${hero}
    <div class="col-head">
      <span>${todayHead}</span>
    </div>
    <div class="rows">${rows || emptyRest}</div>
  </div>`;
}

function groupEventsByDate(events) {
  const byDay = new Map();
  for (const ev of events || []) {
    const list = byDay.get(ev.instance_date);
    if (list) {
      list.push(ev);
    } else {
      byDay.set(ev.instance_date, [ev]);
    }
  }
  return byDay;
}

function buildMonthCellHtml(cell, state, dayEvents) {
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
    <span class="cal-num">${cell.day}</span>
    <span class="cal-dots">${dots}</span>
  </button>`;
}

export function renderMonthView(state) {
  const cells = buildMonthCells(state.viewYear, state.viewMonth);
  const byDay = groupEventsByDate(state.monthEvents);
  const monthLabel = `${state.viewYear}年 ${state.viewMonth + 1}月`;
  const gridHtml = cells
    .map((c) => buildMonthCellHtml(c, state, byDay.get(c.iso) || []))
    .join('');
  const selectedEvents = byDay.get(state.selectedDate) || [];
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
        <span class="cal-month-label">${monthLabel}</span>
        <div class="inline-actions">
          <button class="ghost-chip" type="button"
            data-month-today>今天</button>
          <button class="nav-arrow-btn" type="button"
            aria-label="上个月" data-month-step="-1">${CHEVRON_LEFT_SVG}</button>
          <button class="nav-arrow-btn" type="button"
            aria-label="下个月" data-month-step="1">${CHEVRON_RIGHT_SVG}</button>
        </div>
      </div>
      <div class="cal-weekdays">${weekHtml}</div>
      <div class="cal-grid">${gridHtml}</div>
    </div>
    <div class="col-head">
      <span>${selHead}</span>
      <button class="cmd-quiet mini" type="button"
        data-open-event>+ 添加</button>
    </div>
    <div class="rows">${dayRows || emptyDay}</div>
  </div>`;
}
