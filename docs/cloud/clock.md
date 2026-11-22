# Clock 领域架构

状态：**已对齐，2026-11-23。**

Clock 包含普通闹钟、世界时钟、秒表、计时器和 Agent Alarm。普通闹钟由 Android 执行；Agent Alarm 由 Cloud 定时向 Agent EP 投递 Prompt。

## 1. 领域对象

| 对象 | 内容 |
| --- | --- |
| Alarm | 时间、重复、名称、提醒方式、启用状态、revision、Lock、执行目标 |
| Alarm Operation | 本地、Agent 或 Calendar 产生的创建、修改、取消操作 |
| Alarm Target | 首选设备、允许设备、当前执行设备和目标模式 |
| Agent Alarm | Prompt、触发计划、Agent 绑定、错过策略、启用状态 |
| Prompt Delivery | 单次 Prompt 投递、凭证校验、202 接收确认和可选结果 |

Alarm 与 Agent Alarm 使用不同状态。Android 响铃成功和 Agent 接收 Prompt 成功不能混为一个结果。

## 2. 普通闹钟主流程

```text
本地／Agent／Calendar
→ alarm operation
→ Cloud 保存快照与 operation
→ Link 推送到目标 Clock App
→ Clock 本地事务生效
→ Android 设置／修改／取消闹钟
→ EXECUTED / FAILED 回执
```

### 本地入口

Clock 在一个本地事务中写入 Alarm 与 outbox，随后立即修改 Android 闹钟。重连后发送 outbox，Cloud 去重并分配 `server_seq`。

### Agent 入口

Agent 通过 `alarm.set` 提交操作。Cloud 校验 `alarm.write`、幂等键、revision 和目标后保存并推送。收到 `ACCEPTED` 只说明 Cloud 已受理。

### Calendar 入口

Calendar 后续通过 `linked_event_id` 产生相同 Alarm Operation。Event 的创建、修改和取消使用同一关联，Clock 不主动发起 Event 关联。

## 3. Lock：单条闹钟的云端写保护

每条 Alarm 包含 `cloud_locked`，默认 `false`。

- `false`：允许云端修改时间、配置和取消。
- `true`：拒绝云端对该 Alarm 的写操作，本地用户仍可修改。
- 只有本地用户可以修改 Lock，Cloud 和 Agent 不能修改 Lock 本身。
- Lock 不影响创建其他新闹钟。

离线 Lock 与云端修改撞车时，本地受保护内容优先。重连后以本地 Lock 和内容生成新的 Cloud revision，并保留覆盖记录。

未 Lock 的极端多端并发不在首版增加人工冲突界面；Cloud 按操作顺序保存记录。

## 4. 多设备同步与切换

所有在线设备保持相同 Alarm 快照。每台设备都能离线依靠本地数据继续运行已保存的闹钟。

目标模式：

- `preferred`：优先手机；手机离线时切换到其他允许的在线设备。
- `device_id`：用户或 Agent 指定设备，只有该设备执行。

设备切换后同步新的执行目标。网络分区导致旧设备未收到切换时，允许出现重复响应，优先保留本地闹钟的可用性。

用户和 Agent 都可以通过目标参数选择设备。默认目标为 `preferred + phone`。

## 5. 错过与恢复

- 普通闹钟错过触发时间后标记 `MISSED`，不补响。
- 重复闹钟恢复下一次，不集中补响历史次数。
- 客户端重启后从本地数据库恢复未来闹钟和 outbox。
- Cloud 在重连后按 `last_applied_seq` 补发同步操作；已过执行时间的动作只同步最终状态。

## 6. Agent Alarm

### 创建与触发

用户在 Pocket 中编辑：

- `agent_endpoint` 对应的 Agent 绑定。
- `credential`。
- `source`，默认为 `pocket.clock`。
- `prompt`。
- `run_at` 或 `cron` 与 IANA 时区。
- `missed_policy`：`skip`（默认）、`latest`、`all`。

Cloud 到点生成唯一 `delivery_id`，直接向 Agent EP 发送 HTTP POST。手机离线不影响触发。

### 投递协议

```http
POST {agent_endpoint}/webhooks/clock
Authorization: Bearer <credential>
Content-Type: application/json
```

```json
{
  "version": "v1",
  "delivery_id": "dlv_01XYZ",
  "source": "pocket.clock",
  "type": "prompt.requested",
  "prompt": "整理本周笔记，生成周报草稿",
  "scheduled_for": "2026-11-23T08:00:00Z",
  "triggered_at": "2026-11-23T08:00:01Z",
  "session_hint": {
    "mode": "new"
  },
  "result_callback_url": "https://pocket.example.com/v1/deliveries/dlv_01XYZ/result"
}
```

Agent 处理：

```text
校验凭证
→ 按 source 选择 route
→ 将 payload 转换为 Prompt
→ 创建 Agent Run
→ 按 route 配置管理 Session 与结果
```

Agent 持久化或排队后返回：

```http
HTTP/1.1 202 Accepted
```

```json
{
  "delivery_id": "dlv_01XYZ",
  "status": "accepted"
}
```

Pocket 收到 202 后将本次投递标记 `COMPLETED`。Agent 后续如何执行、创建或复用 Session、展示结果均不改变这一状态。

### 重试与结果

Agent 暂时不可用时按策略重试，同一 `delivery_id` 用于去重。默认不补发错过的投递；`latest` 只补最近一次，`all` 补发所有未过期投递。

Agent 可通过 `result_callback_url` 可选回写摘要、Session 引用或结构化结果。Clock 有回写则展示，没有回写不影响投递完成。

## 7. Clock 客户端 Feature

- Alarm 本地数据库和离线 outbox。
- Android 闹钟、通知、重启恢复和实际执行回执。
- 单条 Alarm 的 `cloud_locked` 控制。
- 首选设备、指定设备和当前执行状态展示。
- Agent Alarm 的 Prompt 与计划编辑。
- 投递状态、可选结果和来源展示。

普通闹钟、秒表、计时器和世界时钟共享同一界面语言，但只有普通闹钟使用 Cloud Alarm 同步语义。

## 8. 验收场景

1. Agent 创建普通闹钟，Clock 返回真实 `EXECUTED`，重复请求不重复创建。
2. 本地离线创建闹钟仍能响铃，重连后不产生重复。
3. 离线 Lock 与云端修改撞车时保留本地受保护内容。
4. 手机离线后允许设备按策略接管，恢复后快照一致。
5. 错过普通闹钟只标记 `MISSED`，不补响。
6. 手机离线时 Agent Alarm 仍由 Cloud 按时 POST 到 Agent EP。
7. Agent 返回 202 后投递为 `COMPLETED`；重复投递使用同一 `delivery_id` 去重。
8. Agent 可选回写结果，Clock 能关联展示，未回写时不显示虚假执行状态。
