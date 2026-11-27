import assert from 'node:assert/strict';
import test from 'node:test';

import {
  annotateConflicts,
  buildEventSetParams,
  expandMasterEvents,
  toMasterEvent
} from '../src/domain/calendar-model.js';
import {
  computeDefaultSyncRange,
  computeMonthFetchRange,
  toMinutes
} from '../src/domain/date-time.js';
import {
  buildTodoSetParams,
  cleanInlineTokens,
  cronExpressionForTodo,
  describeTodoStatus,
  parseInlineTokens
} from '../src/domain/todo-model.js';
import { createDemoSeed } from '../src/state/demo-seed.js';
import {
  renderAgendaView,
  renderMonthView
} from '../src/ui/agenda-month-view.js';
import { renderSettingsView } from '../src/ui/settings-view.js';
import { renderTodoView } from '../src/ui/todo-view.js';
import { buildTtyBarHtml } from '../src/ui/underlay.js';

function countHeroCards(html) {
  return (html.match(/class="hero"/g) || []).length;
}

const SAMPLE_MASTERS = Object.freeze([
  {
    event_id: 'ev_once',
    event_date: '2026-11-23',
    start_hhmm: '08:00',
    end_hhmm: '08:30',
    title: 'Once',
    repeat_rule: 'none',
    reminder_policy: 'none'
  },
  {
    event_id: 'ev_weekdays',
    event_date: '2026-11-23',
    start_hhmm: '09:00',
    end_hhmm: '09:30',
    title: 'Standup',
    repeat_rule: 'weekdays',
    reminder_policy: 'notify'
  },
  {
    event_id: 'ev_weekly',
    event_date: '2026-11-24',
    start_hhmm: '15:00',
    end_hhmm: '16:00',
    title: 'Weekly Tue',
    repeat_rule: 'weekly',
    reminder_policy: 'alarm'
  },
  {
    event_id: 'ev_daily',
    event_date: '2026-11-27',
    start_hhmm: '20:00',
    end_hhmm: '20:30',
    title: 'Daily Log',
    repeat_rule: 'daily',
    reminder_policy: 'none'
  }
]);

test('expands recurrence rules across multi-week date windows', () => {
  const expanded = expandMasterEvents(
    SAMPLE_MASTERS, '2026-11-23', '2026-12-01'
  );
  const byId = (id) => expanded
    .filter((item) => item.event_id === id)
    .map((item) => item.instance_date);

  assert.deepEqual(byId('ev_once'), ['2026-11-23']);
  assert.equal(byId('ev_weekdays').includes('2026-11-28'), false);
  assert.equal(byId('ev_weekdays').includes('2026-11-29'), false);
  assert.equal(byId('ev_weekdays').length, 7);
  assert.deepEqual(byId('ev_weekly'), ['2026-11-24', '2026-12-01']);
  assert.equal(byId('ev_daily').length, 5);
});

test('marks overlapping same-day events and covers full current month', () => {
  const annotated = annotateConflicts([
    {
      event_id: 'a',
      instance_date: '2026-11-24',
      start_hhmm: '10:00',
      end_hhmm: '11:00',
      title: 'A'
    },
    {
      event_id: 'b',
      instance_date: '2026-11-24',
      start_hhmm: '10:30',
      end_hhmm: '11:30',
      title: 'B'
    },
    {
      event_id: 'c',
      instance_date: '2026-11-24',
      start_hhmm: '11:30',
      end_hhmm: '12:00',
      title: 'C'
    }
  ]);
  assert.equal(annotated.find((e) => e.event_id === 'a').has_conflict, true);
  assert.equal(annotated.find((e) => e.event_id === 'b').has_conflict, true);
  assert.equal(annotated.find((e) => e.event_id === 'c').has_conflict, false);

  const range = computeMonthFetchRange(2026, 10);
  const syncRange = computeDefaultSyncRange('2026-11-24');
  assert.equal(syncRange.startDate <= '2026-11-01', true);
  const startMs = Date.parse(`${syncRange.startDate}T00:00:00Z`);
  const endMs = Date.parse(`${syncRange.endDate}T00:00:00Z`);
  assert.equal(Math.round((endMs - startMs) / 86400000), 62);
  assert.ok(range.startDate <= '2026-11-01');
  assert.equal(toMinutes('09:30'), 570);
});

test('parses @meeting-agent safely and preserves event/todo fields', () => {
  const agents = ['@work-agent', '@meeting-agent'];
  const parsed = parseInlineTokens(
    '同步纪要 @meeting-agent 16:45 ops@meta.com', agents
  );
  assert.deepEqual(parsed, { target: '@meeting-agent', time: '16:45' });
  assert.equal(
    cleanInlineTokens('同步纪要 @meeting-agent 16:45', agents),
    '同步纪要'
  );

  const existingEv = toMasterEvent({
    event_id: 'ev_custom',
    event_date: '2026-11-25',
    start_hhmm: '14:00',
    end_hhmm: '15:00',
    title: 'Keep Offset',
    reminder_policy: 'notify',
    reminder_offset_minutes: 25,
    revision: 3
  });
  const evPatch = buildEventSetParams({ title: 'Renamed' }, existingEv);
  assert.equal(evPatch.reminder_offset_minutes, 25);
  assert.equal(evPatch.event_date, '2026-11-25');

  const existingTd = {
    todo_id: 'todo_99',
    text: 'Original prompt',
    assignee: '@work-agent',
    schedule_kind: 'weekly',
    time_hhmm: '16:00',
    once_date: null,
    weekly_dow: 3,
    timezone: 'Asia/Shanghai',
    done: false,
    enabled: true,
    locked: false,
    skip_next: false,
    ttl_seconds: 1800,
    revision: 4
  };
  const toggledSkip = buildTodoSetParams(
    { skip_next: true },
    existingTd,
    { todayIso: '2026-11-24', timezone: 'UTC' }
  );
  assert.equal(toggledSkip.weekly_dow, 3);
  assert.equal(toggledSkip.ttl_seconds, 1800);
  assert.equal(toggledSkip.skip_next, true);
  assert.equal(cronExpressionForTodo(existingTd), '0 16 * * 3');
});

test('formats honest @me and @agent status subtitles', () => {
  const queuedMe = describeTodoStatus({
    assignee: '@me',
    schedule_kind: 'once',
    time_hhmm: '07:30',
    once_date: '2026-11-25',
    done: false,
    enabled: true,
    locked: true,
    skip_next: false,
    alarm_status: 'QUEUED'
  }, '2026-11-24');
  assert.equal(queuedMe.subtitle.includes('QUEUED'), true);
  assert.equal(queuedMe.subtitle.includes('EXECUTED'), false);
  assert.equal(queuedMe.subtitle.includes('LOCKED 本机锁'), true);

  const execMe = describeTodoStatus({
    assignee: '@me',
    schedule_kind: 'daily',
    time_hhmm: '07:30',
    done: false,
    enabled: true,
    alarm_status: 'EXECUTED'
  }, '2026-11-24');
  assert.equal(execMe.subtitle.includes('EXECUTED'), true);
  assert.equal(execMe.dotClass, 'ok');
});

test('escapes XSS sinks and enforces single-hero-card rule', () => {
  const seed = createDemoSeed('2026-11-24');
  const xssEv = toMasterEvent({
    event_id: 'ev"><img src=x onerror=1>',
    event_date: '2026-11-24',
    start_hhmm: '11:00',
    end_hhmm: '12:00',
    title: '<script>alert(1)</script>',
    reminder_policy: 'notify',
    reminder_offset_minutes: '<svg onload=alert(1)>'
  });
  assert.equal(xssEv.reminder_offset_minutes, 10);
  const masters = [...seed.masterEvents, xssEv];
  const todayEvs = expandMasterEvents(masters, '2026-11-24', '2026-11-24');
  const monthEvs = expandMasterEvents(masters, '2026-11-01', '2026-11-30');
  const demoState = {
    mode: 'demo',
    connectionStatus: 'demo',
    page: 'agenda',
    todayIso: '2026-11-24',
    selectedDate: '2026-11-24',
    viewYear: 2026,
    viewMonth: 10,
    todayEvents: todayEvs,
    monthEvents: monthEvs,
    todos: seed.todos,
    agentGrants: seed.agents,
    tokens: []
  };
  const tty = buildTtyBarHtml(demoState);
  assert.equal(tty.statHtml, '');
  const agendaHtml = renderAgendaView(
    demoState, Date.parse('2026-11-24T08:00:00')
  );
  assert.equal(agendaHtml.includes('<script>'), false);
  assert.equal(agendaHtml.includes('<svg'), false);
  assert.equal(countHeroCards(agendaHtml), 1);
  assert.equal(countHeroCards(renderMonthView(demoState)), 0);
  assert.equal(countHeroCards(renderTodoView(demoState)), 0);
  assert.equal(countHeroCards(renderSettingsView(demoState)), 1);
});
