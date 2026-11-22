# Pocket Cloud 架构

状态：**已对齐，2026-11-23。**

Pocket Cloud 是三个独立 Android App 和外部 Agent 共用的后端。首版采用模块化单体：一个 HTTP/WebSocket 服务、一个后台 Worker、一个关系数据库。领域在代码与数据上隔离，共享基础设施保持简单。

## 1. 模块结构

```text
Agent / Android Apps
        │ HTTP/JSON
        ▼
HTTP Interface：Schema / Permission / Idempotency
        │
        ├── Clock Domain
        ├── Calendar Domain
        └── Notes Domain
        │
        ▼
Snapshot + Revision + Operations + Persistent Outbox
        │
        ├── Link Gateway：WebSocket push / reconnect
        ├── Scheduler：单次与周期触发
        └── Prompt Delivery：Agent EP / 202 / result callback
        │
        ▼
Relational DB + Background Worker
```

HTTP Interface 只做协议、权限和同步响应，不伪造客户端或 Agent 的执行结果。领域模块负责自己的业务不变量；Sync、Scheduler 和 Delivery 通过明确接口交接。

## 2. 后端模块

| 模块 | 职责 |
| --- | --- |
| HTTP Interface | 命名 RPC、JSON Schema、同步读取、幂等键、统一错误 |
| Identity & Permission | User ID、设备、Agent 绑定、Link、动作与资源授权 |
| Link Gateway | 连接注册、心跳、WebSocket 推送、断线握手 |
| Sync | `server_seq`、revision、操作日志、outbox、回执和补发 |
| Domain Modules | 各领域快照、业务规则、领域间关联 |
| Scheduler | 保存计划、计算下次触发、生成单次投递或领域动作 |
| Prompt Delivery | Agent EP、凭证、订阅源、重试、202 接收确认 |
| Result Receiver | 可选结果、摘要、Session 引用和结构化回写 |
| Observation | 操作来源、因果链、延迟、失败与过期记录 |

后台 Worker 从持久存储读取待触发计划和待投递操作。数据库提交与 outbox 写入在同一个事务中完成，避免数据已变更但异步动作丢失。

## 3. 数据分组

| 数据组 | 主要对象 | 用途 |
| --- | --- | --- |
| Identity | users、devices、agents、links、grants | 身份、绑定和授权 |
| Sync | operations、receipts、outbox | 顺序、去重、补发和回执 |
| Clock | alarms、alarm_targets | 闹钟快照与执行目标 |
| Calendar | events、reminder_links | Event 与提醒关联 |
| Notes | notes、note_revisions | 内容版本和授权范围 |
| Schedule | schedules、deliveries | 触发计划与每次投递 |
| Result | delivery_results | 可选 Agent 回写与外部引用 |

各领域使用自己的业务表。`operations` 只承载共同同步语义，不替代领域数据结构。

## 4. HTTP 能力契约

当前能力按领域命名：

```text
device.status / operation.get
alarm.list / alarm.set / alarm.cancel
agent_alarm.list / agent_alarm.set / agent_alarm.cancel
delivery.get / delivery.result.write
```

后续领域沿用同一风格注册 `event.*`、`note.*`。读操作直接返回 Cloud 当前快照；设备写操作返回 `202 ACCEPTED + operation_id`；Agent 投递返回 `delivery_id`。

写请求共同包含：

- `request_id`：同一 User 下的幂等键。
- `user_id`：账户标识。
- `base_revision`：调用方看到的实体版本。
- `source`：`local`、`agent`、`calendar`。
- `expires_at`：允许执行或投递的截止时间。
- `correlation_id`：跨模块关联同一业务链。

## 5. Link 与双向同步

### 长期逻辑 Link

客户端通过出站 WebSocket 连接 Cloud。`link_id` 是稳定关系，`connection_id` 是一次临时连接；重连不改变 Link 身份。

```text
Client → HELLO { user_id, link_id, device_id, last_applied_seq }
Cloud  → WELCOME { connection_id, current_server_seq }
```

在线时 Cloud 主动推送操作。断线后客户端提供 `last_applied_seq`，Cloud 补发后续操作，再恢复实时推送。心跳只维护连接状态，不承担业务轮询。

### 数据职责

Cloud 保存当前期望快照和有序操作；客户端保存本地执行快照、离线 outbox 和原生执行状态。

```text
Local / Agent / Calendar
→ Operation
→ Cloud server_seq
→ Client local transaction
→ Native execution
→ Receipt
```

重复 `operation_id` 只应用一次。删除使用带 revision 的 tombstone，防止旧更新复活对象。

### 冲突

Cloud 分配操作顺序，不使用设备时间做 Last-Write-Wins。`base_revision` 用于识别过期写入；领域可以定义更具体的保护规则，例如 Clock 的 Lock。

## 6. 操作与执行状态

```text
ACCEPTED       Cloud 已持久化请求
OFFLINE_QUEUED 等待可用 Link
DELIVERED      已推送到客户端或 Agent
APPLIED        客户端领域数据库已提交
EXECUTED       Android 已确认实际效果
COMPLETED      本次定时投递已被 Agent 接收
CONFLICT       revision 已过期
REJECTED       权限或参数拒绝
FAILED         客户端、投递或外部执行失败
MISSED         超过动作执行时间
EXPIRED        超过允许投递时间
```

`ACCEPTED` 不代表设备成功；`DELIVERED` 不代表客户端已应用；`COMPLETED` 不代表 Agent 已执行完 Prompt。状态必须沿真实回执推进。

## 7. Scheduler 与 Prompt Delivery

### 定时计划

`schedule` 保存 `run_at` 或 `cron`、IANA 时区、payload、目标绑定和 `missed_policy`。Cloud 到点生成唯一 `delivery_id`，周期计划的每次触发都是独立投递。

默认错过不补发；用户可选择 `latest` 或 `all`。超过 `expires_at` 的投递只保留状态，不再发出。

### Agent 投递

绑定配置包含：

- `agent_endpoint`
- `credential`
- `source`
- `session_hint`
- `result_callback_url`

Pocket 使用 HTTP POST 投递完整 Prompt。Agent 持久化或排队后返回 `202 Accepted`，Pocket 将本次投递标记为 `COMPLETED`。同一 `delivery_id` 的重试必须保持幂等。

可选结果回写包含 `delivery_id`、摘要、外部 Session 引用、结构化结果和记录时间。结果回写不改变本次投递已经完成的事实。

## 8. 权限模型

权限由调用主体、User ID、Link 或 Agent、动作、资源范围、有效期和撤销状态组成。当前动作包括：

```text
alarm.write / alarm.read
agent_alarm.write / agent_alarm.read
delivery.write / delivery.result.write
```

各领域新增自己的动作。Cloud 在接收请求时检查权限，客户端在应用操作前检查目标与 revision，Agent 在接收投递时验证凭证和 `delivery_id`。

## 9. 可靠性与恢复

- Cloud 重启后从数据库恢复计划、操作和 outbox。
- 客户端重启后从本地数据库恢复未来动作与 outbox。
- Agent 暂时不可用时按投递策略重试，超过期限标记 `EXPIRED`。
- 同一 `request_id`、`operation_id` 或 `delivery_id` 重复提交返回首次结果。
- 原生执行失败保留 Cloud 期望状态并记录 `FAILED`，不伪造回滚成功。
- 跨模块流程通过 `correlation_id` 关联，不把不同步骤压成一个 `success`。

## 10. 领域接入顺序

1. 定义领域数据、权限动作和正常／异常场景。
2. 实现领域模块与 HTTP 能力。
3. 接入 operations、outbox、receipts 和 Link。
4. 在独立 Android App 中实现本地存储与 Operation Applier。
5. 验收重复、离线、过期、撤销和恢复路径。

当前实现范围见 [Clock 领域架构](clock.md)。
