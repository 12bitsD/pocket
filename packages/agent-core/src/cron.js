const SCHEDULE_DAYS = Object.freeze({
  '每天': '*',
  '工作日': '1-5',
  '每周五': '5'
});
const MISSED_POLICIES = new Set(['skip', 'latest', 'all']);

function parseTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new RangeError(`Invalid local time: ${time}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new RangeError(`Invalid local time: ${time}`);
  }
  return `${minute} ${hour}`;
}

function cronExpression(schedule, time) {
  if (!Object.hasOwn(SCHEDULE_DAYS, schedule)) {
    throw new RangeError(`Unsupported schedule: ${schedule}`);
  }
  return `${parseTime(time)} * * ${SCHEDULE_DAYS[schedule]}`;
}

function cleanText(value, message) {
  const text = String(value || '').trim();
  if (!text) {
    throw new RangeError(message);
  }
  return text;
}

function createCronJob(spec) {
  const zone = spec.timeZone ?? 'Asia/Shanghai';
  return {
    prompt: cleanText(spec.prompt, 'Prompt is required'),
    schedule: {
      kind: spec.schedule,
      time: spec.time,
      timeZone: cleanText(zone, 'Time zone is required')
    },
    cron: cronExpression(spec.schedule, spec.time),
    notify: spec.notify ?? '仅异常提醒',
    status: 'SCHEDULED'
  };
}

function checkPlan(spec) {
  const policy = spec.missedPolicy ?? 'skip';
  if (!MISSED_POLICIES.has(policy)) {
    throw new RangeError(`Unsupported missed policy: ${policy}`);
  }
  const ttl = Number(spec.ttlMinutes ?? 15);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 1440) {
    throw new RangeError(`Invalid TTL minutes: ${spec.ttlMinutes}`);
  }
  return {
    agentId: cleanText(spec.agentId, 'Agent binding is required'),
    prompt: cleanText(spec.prompt, 'Prompt is required'),
    zone: cleanText(
      spec.timeZone ?? 'Asia/Shanghai',
      'Time zone is required'
    ),
    ttl,
    policy
  };
}

function createAgentPlan(spec) {
  const base = checkPlan(spec);
  const mode = spec.mode ?? 'cron';
  parseTime(spec.time);
  if (mode === 'once') {
    return {
      agentId: base.agentId,
      prompt: base.prompt,
      mode: 'once',
      runAt: spec.time,
      timeZone: base.zone,
      ttlMinutes: base.ttl,
      missedPolicy: base.policy,
      status: 'SCHEDULED'
    };
  }
  if (mode !== 'cron') {
    throw new RangeError(`Unsupported trigger mode: ${mode}`);
  }
  const kind = spec.schedule ?? '每天';
  return {
    agentId: base.agentId,
    prompt: base.prompt,
    mode: 'cron',
    schedule: { kind, time: spec.time, timeZone: base.zone },
    cron: cronExpression(kind, spec.time),
    ttlMinutes: base.ttl,
    missedPolicy: base.policy,
    status: 'SCHEDULED'
  };
}

function formatPlanCommand(plan) {
  const handle = plan.agentId.startsWith('@')
    ? plan.agentId
    : `@${plan.agentId}`;
  if (plan.mode === 'once') {
    return (
      `schedule ${handle} --at "${plan.runAt}" ` +
      `--tz ${plan.timeZone} --ttl ${plan.ttlMinutes}m`
    );
  }
  return (
    `schedule ${handle} --cron "${plan.cron}" ` +
    `--tz ${plan.schedule.timeZone} --ttl ${plan.ttlMinutes}m ` +
    `--missed ${plan.missedPolicy}`
  );
}

const api = Object.freeze({
  cronExpression,
  createCronJob,
  createAgentPlan,
  formatPlanCommand
});

if (typeof module === 'object' && module.exports) {
  module.exports = api;
}
if (typeof globalThis !== 'undefined') {
  globalThis.PocketAgent = api;
}
