const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cronExpression,
  createCronJob,
  createAgentPlan,
  formatPlanCommand
} = require('../src/cron.js');

test('maps simple schedules to five-field cron expressions', () => {
  assert.equal(cronExpression('每天', '16:00'), '0 16 * * *');
  assert.equal(cronExpression('工作日', '09:30'), '30 9 * * 1-5');
  assert.equal(cronExpression('每周五', '18:45'), '45 18 * * 5');
});

test('rejects invalid schedules and times', () => {
  assert.throws(
    () => cronExpression('每小时', '16:00'),
    /Unsupported schedule/
  );
  assert.throws(
    () => cronExpression('每天', '24:00'),
    /Invalid local time/
  );
  assert.throws(
    () => cronExpression('每天', '16'),
    /Invalid local time/
  );
});

test('creates a Prompt job with an explicit local-time contract', () => {
  const job = createCronJob({
    prompt: '  整理本周笔记  ',
    schedule: '每周五',
    time: '18:45',
    notify: '完成后提醒'
  });
  assert.deepEqual(job, {
    prompt: '整理本周笔记',
    schedule: { kind: '每周五', time: '18:45', timeZone: 'Asia/Shanghai' },
    cron: '45 18 * * 5',
    notify: '完成后提醒',
    status: 'SCHEDULED'
  });
});

test('requires a non-empty Prompt', () => {
  assert.throws(
    () => createCronJob({ prompt: '  ', schedule: '每天', time: '16:00' }),
    /Prompt is required/
  );
});

test('creates cron and one-off Agent plans bound to an agentId', () => {
  const cronPlan = createAgentPlan({
    agentId: '@work-agent',
    prompt: ' 生成周五复盘清单 ',
    mode: 'cron',
    schedule: '每周五',
    time: '16:00',
    ttlMinutes: 15,
    missedPolicy: 'skip'
  });
  assert.equal(cronPlan.cron, '0 16 * * 5');
  assert.equal(cronPlan.ttlMinutes, 15);
  assert.equal(
    formatPlanCommand(cronPlan),
    'schedule @work-agent --cron "0 16 * * 5" ' +
      '--tz Asia/Shanghai --ttl 15m --missed skip'
  );

  const oncePlan = createAgentPlan({
    agentId: 'ci-watcher',
    prompt: '检查发布流水线',
    mode: 'once',
    time: '23:30',
    ttlMinutes: 20
  });
  assert.equal(oncePlan.mode, 'once');
  assert.equal(
    formatPlanCommand(oncePlan),
    'schedule @ci-watcher --at "23:30" --tz Asia/Shanghai --ttl 20m'
  );
});

test('validates agent binding, ttl, and missed policy', () => {
  assert.throws(
    () => createAgentPlan({ agentId: '', prompt: 'ok', time: '09:00' }),
    /Agent binding is required/
  );
  assert.throws(
    () => createAgentPlan({
      agentId: '@a',
      prompt: 'ok',
      time: '09:00',
      missedPolicy: 'manual'
    }),
    /Unsupported missed policy/
  );
  assert.throws(
    () => createAgentPlan({
      agentId: '@a',
      prompt: 'ok',
      time: '09:00',
      ttlMinutes: 0
    }),
    /Invalid TTL minutes/
  );
});
