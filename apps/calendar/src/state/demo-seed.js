import { addDaysIso } from '../domain/date-time.js';

function makeDemoEventBase(overrides) {
  return {
    repeat_rule: 'none',
    reminder_policy: 'alarm',
    reminder_offset_minutes: 15,
    alarm_status: 'QUEUED',
    source: 'local',
    revision: 1,
    updated_at: '',
    ...overrides
  };
}

function buildDemoEvents(todayIso) {
  return [
    makeDemoEventBase({
      event_id: 'demo_ev_1',
      event_date: todayIso,
      start_hhmm: '09:30',
      end_hhmm: '10:15',
      title: '产品与架构周晨会',
      location: 'Room 402',
      repeat_rule: 'weekdays'
    }),
    makeDemoEventBase({
      event_id: 'demo_ev_2',
      event_date: todayIso,
      start_hhmm: '14:00',
      end_hhmm: '15:30',
      title: 'Pocket Cloud 接口联调',
      location: '本地工作台',
      reminder_policy: 'notify',
      reminder_offset_minutes: 10,
      alarm_status: 'NONE',
      source: 'agent'
    }),
    makeDemoEventBase({
      event_id: 'demo_ev_3',
      event_date: addDaysIso(todayIso, 1),
      start_hhmm: '10:30',
      end_hhmm: '11:30',
      title: '牙科复诊预约',
      location: '市中心门诊 3F'
    })
  ];
}

function makeDemoTodoBase(overrides) {
  return {
    once_date: null,
    weekly_dow: null,
    timezone: 'Asia/Shanghai',
    done: false,
    enabled: true,
    locked: false,
    skip_next: false,
    alarm_status: 'NONE',
    next_fire_at: null,
    ttl_seconds: 900,
    revision: 1,
    updated_at: '',
    last_delivery_id: null,
    last_delivery_status: null,
    result_summary: null,
    completed_at: null,
    ...overrides
  };
}

function buildDemoTodos() {
  return [
    makeDemoTodoBase({
      todo_id: 'demo_td_1',
      text: '早起晨间洗漱与出发准备',
      assignee: '@me',
      schedule_kind: 'weekdays',
      time_hhmm: '07:30',
      locked: true,
      alarm_status: 'QUEUED'
    }),
    makeDemoTodoBase({
      todo_id: 'demo_td_2',
      text: '整理本周日程与进展，生成复盘摘要',
      assignee: '@work-agent',
      schedule_kind: 'weekly',
      time_hhmm: '16:00',
      weekly_dow: 5,
      last_delivery_id: 'demo_dlv_1',
      last_delivery_status: 'COMPLETED',
      result_summary: '已生成 4 条要点并写入周报会话 (16:01)'
    }),
    makeDemoTodoBase({
      todo_id: 'demo_td_3',
      text: '补充私有云部署环境变量说明',
      assignee: 'none',
      schedule_kind: null,
      time_hhmm: null
    })
  ];
}

function buildDemoAgents() {
  return [
    {
      agent_id: '@work-agent',
      name: '主力工作 Agent',
      endpoint_url: 'https://agent.example.invalid',
      active: true,
      updated_at: ''
    },
    {
      agent_id: '@ci-watcher',
      name: '构建巡检 Bot',
      endpoint_url: 'https://ci.example.invalid',
      active: true,
      updated_at: ''
    }
  ];
}

export function createDemoSeed(todayIso) {
  return {
    masterEvents: buildDemoEvents(todayIso),
    todos: buildDemoTodos(),
    agents: buildDemoAgents(),
    tokens: []
  };
}
