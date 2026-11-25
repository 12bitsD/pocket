import {
  addDaysIso,
  isoWeekday,
  minutesToHhmm,
  mondayIndexFromIso,
  toMinutes
} from './date-time.js';

export const REPEAT_LABELS = Object.freeze({
  none: '不重复',
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周'
});

const REPEAT_BY_INPUT = Object.freeze({
  none: 'none',
  daily: 'daily',
  weekdays: 'weekdays',
  weekly: 'weekly',
  '不重复': 'none',
  '每天': 'daily',
  '工作日': 'weekdays',
  '每周': 'weekly'
});

const REMINDER_OFFSETS = Object.freeze({ none: 0, notify: 10, alarm: 15 });

function pickField(primary, secondary, fallback) {
  if (primary !== undefined && primary !== null && primary !== '') {
    return primary;
  }
  if (secondary !== undefined && secondary !== null && secondary !== '') {
    return secondary;
  }
  return fallback;
}

function coerceOffsetMinutes(rawOffset, defaultOffset) {
  if (rawOffset === undefined || rawOffset === null || rawOffset === '') {
    return defaultOffset;
  }
  const num = Number(rawOffset);
  if (!Number.isFinite(num)) {
    return defaultOffset;
  }
  return Math.max(0, Math.min(1440, Math.trunc(num)));
}

export function normalizeRepeatRule(raw) {
  return REPEAT_BY_INPUT[raw] || 'none';
}

export function formatRepeatLabel(rule) {
  return REPEAT_LABELS[rule] || REPEAT_LABELS.none;
}

export function describeAlarmStatus(rawStatus) {
  const status = rawStatus || 'QUEUED';
  if (status === 'EXECUTED') {
    return { dotClass: 'ok', code: 'EXECUTED' };
  }
  if (status === 'QUEUED' || status === 'FAILED') {
    return { dotClass: 'mark', code: status };
  }
  const code = status === 'NONE' ? 'LOCAL' : status;
  return { dotClass: 'off', code };
}

export function describeConnection(state) {
  if (state.mode !== 'cloud') {
    return { dotClass: 'off', label: 'DEMO · LOCAL' };
  }
  if (state.connectionStatus === 'revoked') {
    return { dotClass: 'mark', label: 'AUTH REVOKED' };
  }
  if (state.connectionStatus === 'reconnecting') {
    return { dotClass: 'mark', label: 'RECONNECTING' };
  }
  if (state.connectionStatus === 'connecting') {
    return { dotClass: 'off', label: 'CONNECTING' };
  }
  if (state.connectionStatus === 'suspended') {
    return { dotClass: 'off', label: 'IDLE · SAVING' };
  }
  if (state.connectionStatus === 'online') {
    const kind = (state.identity?.kind || 'web').toUpperCase();
    return { dotClass: 'ok', label: `ONLINE · ${kind}` };
  }
  return { dotClass: 'off', label: 'OFFLINE' };
}

export function matchesRepeatRule(rule, anchorIso, candidateIso) {
  if (candidateIso < anchorIso) {
    return false;
  }
  if (rule === 'none') {
    return candidateIso === anchorIso;
  }
  if (rule === 'daily') {
    return true;
  }
  if (rule === 'weekdays') {
    return mondayIndexFromIso(candidateIso) < 5;
  }
  return isoWeekday(candidateIso) === isoWeekday(anchorIso);
}

function compareInstances(left, right) {
  return (
    left.instance_date.localeCompare(right.instance_date) ||
    left.start_hhmm.localeCompare(right.start_hhmm) ||
    left.end_hhmm.localeCompare(right.end_hhmm) ||
    String(left.event_id).localeCompare(String(right.event_id))
  );
}

export function annotateConflicts(instances) {
  if (!instances || instances.length === 0) {
    return [];
  }
  const ordered = instances
    .map((item) => ({ ...item, has_conflict: false }))
    .sort(compareInstances);
  let curDay = '';
  let maxItem = null;
  for (const target of ordered) {
    if (target.instance_date !== curDay) {
      curDay = target.instance_date;
      maxItem = target;
      continue;
    }
    if (target.start_hhmm < maxItem.end_hhmm) {
      target.has_conflict = true;
      maxItem.has_conflict = true;
    }
    if (target.end_hhmm > maxItem.end_hhmm) {
      maxItem = target;
    }
  }
  return ordered;
}

export function toMasterEvent(raw) {
  const policy = pickField(raw.reminder_policy, raw.reminder, 'notify');
  const defaultOffset = REMINDER_OFFSETS[policy] ?? 10;
  const fallbackAlarm = policy === 'alarm' ? 'QUEUED' : 'NONE';
  const ruleRaw = pickField(raw.repeat_rule, raw.repeat, 'none');
  return {
    event_id: String(pickField(raw.event_id, raw.id, '')),
    event_date: pickField(raw.event_date, raw.date, ''),
    start_hhmm: pickField(raw.start_hhmm, raw.start, '09:00'),
    end_hhmm: pickField(raw.end_hhmm, raw.end, '10:00'),
    title: String(raw.title || '').trim(),
    location: String(raw.location || '').trim(),
    repeat_rule: normalizeRepeatRule(ruleRaw),
    reminder_policy: policy,
    reminder_offset_minutes: coerceOffsetMinutes(
      raw.reminder_offset_minutes, defaultOffset
    ),
    alarm_status: raw.alarm_status || fallbackAlarm,
    source: raw.source || 'local',
    revision: Number(raw.revision || 1),
    updated_at: raw.updated_at || ''
  };
}

export function extractMasterEvents(instances) {
  const byId = new Map();
  for (const item of instances) {
    const master = toMasterEvent(item);
    const prev = byId.get(master.event_id);
    if (!prev || master.revision >= prev.revision) {
      byId.set(master.event_id, master);
    }
  }
  return [...byId.values()];
}

function isNormalizedMaster(raw) {
  return Boolean(
    raw &&
    typeof raw.event_id === 'string' &&
    typeof raw.start_hhmm === 'string' &&
    typeof raw.repeat_rule === 'string' &&
    raw.reminder_offset_minutes !== undefined
  );
}

function expandSingleMaster(master, startDate, endDate, instances) {
  if (master.event_date > endDate) {
    return;
  }
  if (master.repeat_rule === 'none') {
    if (master.event_date >= startDate) {
      instances.push({ ...master, instance_date: master.event_date });
    }
    return;
  }
  let cursor = master.event_date > startDate ? master.event_date : startDate;
  while (cursor <= endDate) {
    if (matchesRepeatRule(master.repeat_rule, master.event_date, cursor)) {
      instances.push({ ...master, instance_date: cursor });
    }
    cursor = addDaysIso(cursor, 1);
  }
}

export function expandMasterEvents(masterEvents, startDate, endDate) {
  if (!startDate || !endDate || endDate < startDate) {
    return [];
  }
  const instances = [];
  for (const raw of masterEvents) {
    const master = isNormalizedMaster(raw) ? raw : toMasterEvent(raw);
    expandSingleMaster(master, startDate, endDate, instances);
  }
  return annotateConflicts(instances);
}

function resolveEventOffset(draft, existing, policy) {
  if (draft.reminder_offset_minutes !== undefined) {
    return coerceOffsetMinutes(
      draft.reminder_offset_minutes, REMINDER_OFFSETS[policy] ?? 10
    );
  }
  if (existing && existing.reminder_policy === policy) {
    return coerceOffsetMinutes(
      existing.reminder_offset_minutes, REMINDER_OFFSETS[policy] ?? 10
    );
  }
  return REMINDER_OFFSETS[policy] ?? 10;
}

export function buildEventSetParams(draft, existing) {
  const start = pickField(
    draft.start_hhmm, draft.start, existing?.start_hhmm || '09:00'
  );
  let end = pickField(
    draft.end_hhmm, draft.end, existing?.end_hhmm || '10:00'
  );
  if (toMinutes(end) <= toMinutes(start)) {
    end = minutesToHhmm(toMinutes(start) + 30);
  }
  const policy = pickField(
    draft.reminder_policy, draft.reminder, existing?.reminder_policy || 'notify'
  );
  const ruleRaw = pickField(
    draft.repeat_rule, draft.repeat, existing?.repeat_rule || 'none'
  );
  const dateVal = pickField(
    draft.event_date, draft.date, existing?.event_date || ''
  );
  const payload = {
    event_date: dateVal,
    start_hhmm: start,
    end_hhmm: end,
    title: String(pickField(draft.title, existing?.title, '')).trim(),
    location: String(draft.location ?? existing?.location ?? '').trim(),
    repeat_rule: normalizeRepeatRule(ruleRaw),
    reminder_policy: policy,
    reminder_offset_minutes: resolveEventOffset(draft, existing, policy)
  };
  if (existing?.event_id) {
    payload.event_id = existing.event_id;
    payload.base_revision = existing.revision;
  }
  return payload;
}
