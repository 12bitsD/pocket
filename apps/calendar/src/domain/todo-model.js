import { describeAlarmStatus } from './calendar-model.js';
import { addDaysIso, DOW_LABELS } from './date-time.js';

export const TODO_SCHEDULES = Object.freeze([
  '今天', '明天', '指定日期', '每天', '工作日', '每周'
]);

const RECURRING_KINDS = Object.freeze(['daily', 'weekdays', 'weekly']);

const UI_TO_KIND = Object.freeze({
  once: 'once',
  daily: 'daily',
  weekdays: 'weekdays',
  weekly: 'weekly',
  '今天': 'once',
  '明天': 'once',
  '指定日期': 'once',
  '每天': 'daily',
  '工作日': 'weekdays',
  '每周': 'weekly',
  '每周五': 'weekly'
});

export function isRecurringTodo(todo) {
  return (
    todo.assignee !== 'none' &&
    RECURRING_KINDS.includes(todo.schedule_kind)
  );
}

export function isTodoActive(todo) {
  return isRecurringTodo(todo) ? Boolean(todo.enabled) : !todo.done;
}

export function isTodoRetreated(todo) {
  if (isRecurringTodo(todo)) {
    return !todo.enabled;
  }
  if (todo.done) {
    return true;
  }
  return (
    todo.alarm_status === 'MISSED' ||
    todo.last_delivery_status === 'EXPIRED'
  );
}

export function isAgentAssignee(assignee) {
  return (
    typeof assignee === 'string' &&
    assignee.startsWith('@') &&
    assignee !== '@me'
  );
}

export function isLocalSessionState(state) {
  return Boolean(
    state.isLocalDevice ?? (
      state.mode !== 'cloud' || state.identity?.source === 'local'
    )
  );
}

export function cronExpressionForTodo(todo) {
  const [hh, mm] = String(todo.time_hhmm || '09:00').split(':').map(Number);
  let dow = '*';
  if (todo.schedule_kind === 'weekdays') {
    dow = '1-5';
  } else if (todo.schedule_kind === 'weekly') {
    dow = String(todo.weekly_dow ?? 5);
  }
  return `${mm} ${hh} * * ${dow}`;
}

export function summarizeTodos(todos) {
  let openCount = 0;
  let cycleCount = 0;
  let meCount = 0;
  let agentCount = 0;
  for (const item of todos || []) {
    const recurring = isRecurringTodo(item);
    const active = isTodoActive(item);
    cycleCount += Number(recurring && active);
    openCount += Number(!recurring && !item.done);
    meCount += Number(active && item.assignee === '@me');
    agentCount += Number(active && isAgentAssignee(item.assignee));
  }
  return { openCount, cycleCount, meCount, agentCount };
}

function escapeRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortedCandidateHandles(agentIds) {
  const unique = new Set(['@me', ...(agentIds || []).filter(Boolean)]);
  return [...unique].sort((a, b) => b.length - a.length);
}

function makeHandlePattern(handle) {
  return new RegExp(
    `(?<![A-Za-z0-9_@-])${escapeRegex(handle)}(?![A-Za-z0-9_-])`,
    'g'
  );
}

export function parseInlineTokens(rawText, agentIds) {
  const text = String(rawText || '');
  let target = null;
  for (const handle of sortedCandidateHandles(agentIds)) {
    if (makeHandlePattern(handle).test(text)) {
      target = handle;
      break;
    }
  }
  const match = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  const time = match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
  return { target, time };
}

const INLINE_DOW_MAP = Object.freeze({
  '日': 0,
  '天': 0,
  '一': 1,
  '二': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6
});

const INLINE_SCHED_RE = /(?:^|\s)(今天|明天|每天|工作日|每周([一二三四五六日天])?)(?=\s|$)/;

export function parseInlineSchedule(rawText) {
  const match = INLINE_SCHED_RE.exec(String(rawText || ''));
  if (!match) {
    return null;
  }
  const token = match[1];
  if (token.startsWith('每周')) {
    const dowChar = match[2] || '五';
    return { schedule: '每周', weeklyDow: INLINE_DOW_MAP[dowChar] ?? 5 };
  }
  return { schedule: token, weeklyDow: null };
}

export function cleanInlineTokens(rawText, agentIds) {
  let cleaned = String(rawText || '');
  for (const handle of sortedCandidateHandles(agentIds)) {
    cleaned = cleaned.replace(makeHandlePattern(handle), ' ');
  }
  return cleaned
    .replace(INLINE_SCHED_RE, ' ')
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function resolveOnceDate(rawSched, draft, existing, todayIso) {
  if (rawSched === '今天') {
    return todayIso;
  }
  if (rawSched === '明天') {
    return addDaysIso(todayIso, 1);
  }
  return draft.once_date || draft.date || existing?.once_date || todayIso;
}

function resolveWeeklyDow(rawSched, draft, existing) {
  if (rawSched === '每周五' && draft.weekly_dow === undefined) {
    return 5;
  }
  const candidate = draft.weekly_dow ?? existing?.weekly_dow ?? 5;
  const num = Number(candidate);
  return Number.isInteger(num) && num >= 0 && num <= 6 ? num : 5;
}

function resolveTodoWindow(assignee, draft, existing, todayIso) {
  if (assignee === 'none') {
    return {
      schedule_kind: null,
      time_hhmm: null,
      once_date: null,
      weekly_dow: null
    };
  }
  const rawSched = draft.schedule_kind ?? draft.schedule ??
    existing?.schedule_kind ?? 'once';
  const kind = UI_TO_KIND[rawSched] || 'once';
  const time = draft.time_hhmm || draft.time || existing?.time_hhmm || '09:00';
  return {
    schedule_kind: kind,
    time_hhmm: time,
    once_date: kind === 'once'
      ? resolveOnceDate(rawSched, draft, existing, todayIso)
      : null,
    weekly_dow: kind === 'weekly'
      ? resolveWeeklyDow(rawSched, draft, existing)
      : null
  };
}

function resolveTodoMetadata(draft, existing, defaultTz) {
  return {
    timezone: draft.timezone || existing?.timezone || defaultTz,
    done: draft.done ?? existing?.done ?? false,
    enabled: draft.enabled ?? existing?.enabled ?? true,
    locked: draft.locked ?? existing?.locked ?? false,
    skip_next: draft.skip_next ?? existing?.skip_next ?? false,
    ttl_seconds: draft.ttl_seconds ?? existing?.ttl_seconds ?? 900
  };
}

export function buildTodoSetParams(draft, existing, context) {
  const todayIso = context?.todayIso || '2026-01-01';
  const defaultTz = context?.timezone || 'Asia/Shanghai';
  const assignee = draft.assignee ?? draft.target ??
    existing?.assignee ?? 'none';
  const win = resolveTodoWindow(assignee, draft, existing, todayIso);
  const meta = resolveTodoMetadata(draft, existing, defaultTz);
  const payload = {
    text: String(draft.text ?? existing?.text ?? '').trim(),
    assignee,
    ...win,
    ...meta
  };
  if (existing?.todo_id) {
    payload.todo_id = existing.todo_id;
    payload.base_revision = existing.revision;
  }
  return payload;
}

export function todoScheduleUiValue(todo, todayIso) {
  if (!todo || todo.assignee === 'none' || !todo.schedule_kind) {
    return '工作日';
  }
  if (todo.schedule_kind === 'daily') {
    return '每天';
  }
  if (todo.schedule_kind === 'weekdays') {
    return '工作日';
  }
  if (todo.schedule_kind === 'weekly') {
    return '每周';
  }
  if (todo.once_date === todayIso) {
    return '今天';
  }
  if (todo.once_date === addDaysIso(todayIso, 1)) {
    return '明天';
  }
  return '指定日期';
}

export function formatTodoWhenLabel(todo, todayIso) {
  if (todo.schedule_kind === 'daily') {
    return '每天';
  }
  if (todo.schedule_kind === 'weekdays') {
    return '工作日';
  }
  if (todo.schedule_kind === 'weekly') {
    return `每${DOW_LABELS[todo.weekly_dow ?? 5]}`;
  }
  if (todo.once_date === todayIso) {
    return '今天';
  }
  return todo.once_date ? todo.once_date.slice(5) : '单次';
}

function appendTodoFlags(parts, todo) {
  if (todo.skip_next) {
    parts.push('已跳过下次');
  }
  if (todo.locked) {
    parts.push('LOCKED 本机锁');
  }
  return parts.join(' · ');
}

function describeMeTodo(todo, whenLabel) {
  const alarm = describeAlarmStatus(todo.alarm_status);
  const subtitle = appendTodoFlags(
    [whenLabel, `本机闹钟 ${alarm.code}`], todo
  );
  return { dotClass: alarm.dotClass, code: alarm.code, subtitle };
}

function describeAgentTodo(todo, whenLabel) {
  const spec = isRecurringTodo(todo)
    ? `cron ${cronExpressionForTodo(todo)}`
    : `${whenLabel} ${todo.time_hhmm}`;
  const status = todo.last_delivery_status || '等待触发';
  let dotClass = 'off';
  if (status === 'COMPLETED') {
    dotClass = 'ok';
  } else if (status === 'PENDING' || status === 'DISPATCHING') {
    dotClass = 'mark';
  }
  const subtitle = appendTodoFlags([spec, status], todo);
  return { dotClass, code: status, subtitle };
}

export function describeTodoStatus(todo, todayIso) {
  if (todo.assignee === 'none') {
    const text = todo.done ? '已完成' : '普通待办 · 不设唤醒';
    return { dotClass: 'off', code: '', subtitle: text };
  }
  const whenLabel = formatTodoWhenLabel(todo, todayIso);
  if (isRecurringTodo(todo) && !todo.enabled) {
    return { dotClass: 'off', code: 'PAUSED', subtitle: `${whenLabel} · 已暂停` };
  }
  if (!isRecurringTodo(todo) && todo.done) {
    return { dotClass: 'off', code: 'DONE', subtitle: `${whenLabel} · 已完成` };
  }
  if (todo.assignee === '@me') {
    return describeMeTodo(todo, whenLabel);
  }
  if (isAgentAssignee(todo.assignee)) {
    return describeAgentTodo(todo, whenLabel);
  }
  return { dotClass: 'off', code: '', subtitle: whenLabel };
}

function matchesAgentToken(tok, agentId) {
  return (
    tok.kind === 'agent' &&
    !tok.revoked_at &&
    (tok.label === agentId || tok.label.startsWith(`${agentId}:`))
  );
}

export function deriveAgentGrants(agents, tokens) {
  const safeTokens = tokens || [];
  return (agents || []).map((ag) => {
    const matched = safeTokens.filter((t) => matchesAgentToken(t, ag.agent_id));
    const scopeSet = new Set(matched.flatMap((t) => t.scopes || []));
    const canRead = scopeSet.has('event.read') || scopeSet.has('todo.read');
    const canWrite = scopeSet.has('event.write') || scopeSet.has('todo.write');
    return {
      ...ag,
      canRead,
      canWrite,
      tokenIds: matched.map((t) => t.token_id)
    };
  });
}
