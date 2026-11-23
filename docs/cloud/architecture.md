# Pocket Cloud 架构概览

状态：**精简定稿版，2026-11-23**

Pocket Cloud 是 **Pocket Calendar**（日程与时间）和 **Pocket Notes**（独立笔记）共用的个人私有后端，使用单个 Python FastAPI 进程（含 HTTP 接口、WebSocket 实时同步与后台定时循环）配合单个 PostgreSQL 数据库运行。详细建表语句与分步开发说明见 [后端实施手册](implementation-plan.md)。

## 1. 核心数据表（共 8 张）

| 表名 | 作用 |
| --- | --- |
| `tokens` | 保存主密钥、已绑定手机凭证与按权限开关受限的 Agent 密钥 |
| `pairing_codes` | 5 分钟有效的 6 位手机绑定码 |
| `agents` | 外部 Agent 名称、接收网址与加密调用密钥 |
| `events` | 日程安排、重复规则、提前强提醒与手机闹钟执行状态 |
| `todos` | 统一待办（含普通待办、`@me` 响铃参数、本机锁与 `@agent` 定时参数） |
| `deliveries` | 每次向外部 Agent 发送任务的记录、一次性回调密钥与回传结果摘要 |
| `sync_log` | 按顺序编号的变更记录，用于手机断线重连补齐与多端实时同步 |
| `idempotency` | 记录已处理的 `request_id`，防止网络重试产生重复数据 |

## 2. 接口一览

- **业务接口 `POST /v1/rpc/{method}`**：
  - 账号与设备：`pairing.create`, `pairing.claim`, `token.create`, `token.list`, `token.revoke`
  - Agent 配置：`agent.set`, `agent.list`, `agent.revoke`
  - 日程管理：`event.list`, `event.set`, `event.delete`
  - 统一 Todo：`todo.list`, `todo.set`, `todo.toggle`, `todo.delete`
- **连接与回调端点**：
  - `GET /healthz`：健康检查
  - `POST /v1/deliveries/{delivery_id}/result`：Agent 携带一次性回调密钥写回结果摘要
  - `GET /v1/link`：手机与网页端实时同步长连接（补发 `sync_log` 与接收手机 `EXECUTED` 响铃回执）
- **调试 CLI 胶水层（`pocket-cloud`）**：复用同一套 HTTP/WS 接口提供命令行快捷操作（配对、密钥签发、日程/Todo 增删查、`trigger` 立即触发 Agent 调试、`sync watch / ack` 盯盘与模拟手机回执）。
