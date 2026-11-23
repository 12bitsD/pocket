# Pocket Cloud 架构

状态：**已对齐，2026-11-23。**

Pocket Cloud 是 **Pocket Calendar**（时间与日程）、**Pocket Notes**（独立笔记）两个独立客户端应用与外部 Agent 共用的私有后端。采用模块化单体：一个 Python FastAPI 服务（含 HTTP RPC 与 WebSocket Link）、一个后台任务循环、一个 PostgreSQL 数据库，部署配置统一集中在仓库 [`../../cloud/`](../../cloud/) 目录下，**不引入 Redis、独立消息队列或 APScheduler**。

## 1. 模块结构

```text
Web 工作台 / Android Apps / External Agent
                  │ HTTP JSON & WebSocket
                  ▼
    HTTP & WS Interface：Schema / Bearer Auth / Idempotency
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
   Clock 领域  Calendar 领域  Notes 领域
        └─────────┼─────────┘
                  ▼
  PostgreSQL（领域表 + operations + schedules + deliveries + idempotency_keys）
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   Link Gateway       Asyncio Worker：先短事务标记租约，再事务外 HTTP POST
```

接口服务与后台任务循环在代码上解耦，默认可在同一容器进程内通过生命周期一起启动，后续也可拆分为独立进程。

## 2. 数据分组

| 数据组 | 主要对象 | 用途 |
| --- | --- | --- |
| Identity & Pairing | `users`, `devices`, `pairing_codes`, `agent_bindings`, `links`, `grants` | 初始密钥、6 位配对码、设备独立凭证、Agent 加密配置与动作权限 |
| Idempotency & Sync | `idempotency_keys`, `operations`, `receipts`, `outbox` | 防重复提交、`server_seq` 顺序、断点补发与回执 |
| Clock | `alarms`, `alarm_targets` | 普通闹钟快照、本机锁与目标设备策略 |
| Calendar | `events`, `todos` | 日程快照、冲突检测与统一 `@指派` Todo（仅保存 `linked_alarm_id` / `linked_schedule_id` 引用，不重复存时间与回执状态） |
| Notes（后续专项扩展） | `notes`, `note_revisions` | 后续专项打磨后的笔记快照与细粒度授权范围 |
| Schedule & Delivery | `schedules`, `deliveries`, `delivery_results` | 单次/周期计划、每次触发投递、一次性回调密钥与回传摘要 |

**事务与预留规则**：业务表变更与 `outbox` / 待触发记录写入必须在同一数据库事务中提交；第一期给 `schedules` 预留 `revision` 与 `deleted_at` 字段，以便第二期无缝接入客户端同步。

## 3. 接口路由与防重复提交契约

### 路由划分

- **业务能力统一走具名 RPC**：`POST /v1/rpc/{method}`
  - 身份与设备：`pairing.create`, `pairing.claim`, `device.list`, `device.revoke`, `device.status`
  - Agent 绑定：`agent_binding.set`, `agent_binding.list`, `agent_binding.revoke`
  - 普通闹钟：`alarm.list`, `alarm.set`, `alarm.cancel`, `operation.get`
  - Agent 计划：`agent_alarm.list`, `agent_alarm.set`, `agent_alarm.cancel`, `delivery.get`
  - 日历与 Todo：`event.list`, `event.read`, `event.set`, `event.cancel`, `todo.list`, `todo.set`, `todo.toggle`, `todo.cancel`
- **基础与外部端点走普通路径**：
  - `GET /healthz`：健康与数据库探活
  - `POST /v1/deliveries/{delivery_id}/result`：外部 Agent 携带一次性回调密钥回传执行摘要
  - `GET /v1/link`：客户端出站 WebSocket 连接

### 统一返回与幂等规则

- 成功与失败统一返回带 `correlation_id` 的 JSON 结构；失败直接返回对应 HTTP 状态码（`400/401/403/404/409/422`）和明确错误码。
- 写请求共同包含 `request_id`、`user_id`、`base_revision`、`source`（`local | web | agent | calendar`）、`expires_at`（单次计划）和 `correlation_id`。
- **幂等判定**：
  - 同一用户、同一方法、同一 `request_id` 重复提交：请求体哈希一致时直接返回首次结果；**请求体不一致返回 `409` 冲突拒绝**。
  - 首次请求若因参数校验失败或无权限直接被拒，不写入 `idempotency_keys`，修正参数后可正常提交。

## 4. Agent 绑定与安全边界

- **Agent 配置独立存储**：外部 Agent 的网址与调用密钥单独保存在 `agent_bindings`，定时计划仅引用 `agent_binding_id`；更换密钥或停用绑定时一处生效。
- **调用密钥加密不回显**：调用外部 Agent 的密钥使用服务端主密钥对称加密存库，`list` 接口永不返回密钥原文。
- **一次性回调密钥**：每次触发生成 `delivery_id` 时，单独生成仅对该次投递有效的 `callback_token`（库中存哈希），Agent 回传结果时只校验该回调密钥，不复用调用密钥。
- **发送地址限制**：正式环境仅允许向合法外网 `https://` 地址发起 POST，拒绝请求服务端所在内网与元数据地址；仅本地测试配置显式开启时允许指向本机测试服务。

## 5. 定时触发、重试与防崩溃机制

- **先短事务标记，再发外部请求**：
  1. Worker 用短事务（`SELECT ... FOR UPDATE SKIP LOCKED`）捞取到期任务，标记为发送中并写入 **30 秒超时租约**，立即提交事务释放数据库连接（避免等待外部响应占住连接池）；
  2. 事务外通过 `httpx` 向 Agent EP 发送 POST；
  3. 收到 `202 Accepted` 记为 `COMPLETED`；网络错误或 5xx 按退避间隔重试，**重试复用同一个 `delivery_id`** 供 Agent 端去重；
  4. 若发请求中途进程崩溃，30 秒租约到期后自动被下一轮扫描重新接管。
- **单次与周期过期语义**：单次计划使用具体截止时间 `expires_at`；周期 `cron` 计划使用每次触发后的相对有效时长（如 `ttl_seconds = 900`），超过有效期标记 `EXPIRED` 停止发送。
- **错过补发上限**：`missed_policy` 默认 `skip`；选 `latest` 只补最近一次；选 `all` 时设单次最大补发条数（如 10 条），防止服务停机过久重启后瞬间突发大量请求。

## 6. Link 与双向同步（第二期接入）

- 客户端通过出站 WebSocket 连接 `GET /v1/link`；`link_id` 代表长期设备绑定关系，`connection_id` 代表单次连接。
- 断线重连握手：`HELLO { user_id, link_id, device_id, last_applied_seq } → WELCOME { connection_id, current_server_seq }`，按 `last_applied_seq` 补发缺失操作后恢复实时推送。
- Cloud 使用全局递增 `server_seq` 排序，不使用设备本地时间做 LWW；通过 `base_revision` 检测过期写，删除采用带 revision 的 tombstone 防旧更新复活。

## 7. 操作与投递状态

```text
ACCEPTED       Cloud 已持久化请求
OFFLINE_QUEUED 等待目标设备连接
DELIVERED      已推送到目标客户端
APPLIED        客户端本地数据库已提交
EXECUTED       Android 原生层已确认闹钟设置生效
COMPLETED      本次定时 Prompt 已被外部 Agent 202 接收
CONFLICT       revision 过期或幂等参数冲突
REJECTED       权限不足或地址/参数被拒绝
FAILED         客户端原生执行失败或投递最终失败
MISSED         超过设备闹钟触发时间（不补响）
EXPIRED        超过允许投递的有效窗口
```

每一步状态均由真实回执推进，不把受理当作设备已执行或 Agent 已跑完。
