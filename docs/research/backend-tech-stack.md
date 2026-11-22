# Pocket Cloud 后端技术选型研究

日期：2026-11-23  
状态：**调研结论，待确认后实施。**

## 结论

建议采用：

```text
Node.js 24 + TypeScript
Fastify + @fastify/websocket
PostgreSQL
node-postgres (pg) + SQL migrations
pg-boss
Node test runner + real PostgreSQL integration tests
Docker 中的持久 Node 进程与 PostgreSQL
```

这是一个针对 Pocket 的项目适配结论，不是通用语言排名。Python/FastAPI 是第二选择；Go 更适合后续吞吐量、连接数或团队经验发生明显变化时再考虑。

本报告没有运行性能基准。性能相关判断只使用官方能力说明，最终推荐主要依据开发成本、可靠任务语义和当前仓库约束。

## 1. 选型需求

Pocket Cloud 首版需要：

- 命名 HTTP/JSON RPC 与运行时 Schema 校验。
- 多客户端 WebSocket Link、心跳和断线恢复。
- 领域快照、revision、操作日志和事务 outbox。
- 单次／周期计划、重试、过期和幂等投递。
- Agent EP HTTP POST、202 接收确认与可选结果回写。
- 一个后台 Worker 与持久数据库。
- 简单部署、真实数据库集成测试，以及 Clock 后续领域扩展。

当前项目约束：

- 本机已有 Node v24；CI 已使用 Node 与 npm。
- `packages/agent-core` 的 Cron 逻辑可直接复用。
- `bits-style v0.3.5` 对 Python 和 JS/TS 有扫描适配，Go 文件会进入 `unsupported`，[官方支持边界](https://github.com/12bitsD/bits-style/blob/v0.3.5/docs/language-support.md)。
- 本机系统 Python 为 3.9，采用现代 FastAPI 栈时需要由 `uv` 管理新版 Python。

## 2. 候选 A：Python / FastAPI

### 建议组合

```text
Python（由 uv 管理）
FastAPI + Pydantic
SQLAlchemy Async + Alembic
APScheduler AsyncIOScheduler + SQLAlchemyJobStore
PostgreSQL
HTTPX + pytest
```

### 已核实能力

- FastAPI 基于 Python 类型和 Pydantic 提供请求校验、JSON Schema、OpenAPI 与文档生成，[FastAPI Features](https://fastapi.tiangolo.com/features/)。
- FastAPI 原生支持 WebSocket；其文档同时指出，示例中的进程内连接列表只适用于单进程，跨进程广播需要额外基础设施，[FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/)。
- SQLAlchemy 提供 Core 和 ORM 的 asyncio 支持以及异步事务接口，[SQLAlchemy Asyncio](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html)。
- APScheduler 支持 date、interval、cron、持久 job store 和 misfire／coalescing；官方在自由选择后端时推荐 PostgreSQL 上的 SQLAlchemyJobStore，[APScheduler Job Stores](https://apscheduler.readthedocs.io/en/3.x/userguide.html#job-stores)。

### 优点

- Pydantic 模型与自动 OpenAPI 是三个候选中最省事的 Agent 接口文档方案。
- 编写领域逻辑和脚本任务直接，适合个人项目快速迭代。
- APScheduler 与 Pocket 的 date、cron、misfire 策略有明显对应关系。
- bits-style 有 Python 扫描适配。

### 代价

- 当前仓库需要新增 Python 包管理、CI、类型检查与测试体系，现有 Cron JS 逻辑需要移植或保持双实现。
- APScheduler 的持久 job store 不等于 Pocket 的业务 outbox。快照、operation、delivery 和 receipt 仍需自行实现。
- APScheduler 文档明确要求 job store 不能由多个 scheduler 共享；未来多 Worker 或多实例时需要重新核对调度拓扑。
- WebSocket 的业务连接注册和跨进程同步仍需 Pocket 自己设计，框架不会自动解决。

### 适合条件

如果后续希望大量使用 Python 的 Agent／数据工具，或者团队对 FastAPI 明显更熟悉，Python 是非常合理的第二选择，而不是技术上的淘汰项。

## 3. 候选 B：TypeScript / Node.js

### 建议组合

```text
Node.js 24 + TypeScript
Fastify + JSON Schema / Ajv
@fastify/websocket
node-postgres (pg) + SQL migrations
pg-boss
Node test runner
```

### 已核实能力

- Fastify 使用 JSON Schema 进行请求校验和响应序列化，支持共享 Schema 与错误处理，[Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)。
- `@fastify/websocket` 提供 WebSocket 路由、认证 hooks 和 `injectWS` 测试入口，[Fastify WebSocket](https://github.com/fastify/fastify-websocket)。
- `node-postgres` 可直接使用 PostgreSQL；需要显式事务和锁时，不必让 ORM 隐藏 SQL，[Drizzle 对两种 Node PostgreSQL 驱动的说明](https://orm.drizzle.team/docs/get-started-postgresql)。
- pg-boss 使用 PostgreSQL 的 `SKIP LOCKED` 处理并发任务领取，支持在既有事务中创建任务、Cron／RRULE、延迟、重试、死信和 LISTEN／NOTIFY 低延迟分发，[pg-boss](https://github.com/timgit/pg-boss)。
- pg-boss 当前要求 Node 22.12+ 与 PostgreSQL 13+，Node 24 和 PostgreSQL 当前支持版本满足这一范围，[pg-boss Requirements](https://github.com/timgit/pg-boss#requirements)。

### 优点

- 直接复用当前 npm workspace、Node CI、测试方式与 `agent-core`，新增依赖体系最少。
- Fastify 的 JSON Schema 与 Pocket 的具名 RPC 很匹配，响应 Schema 也能防止误返回额外字段。
- pg-boss 与 Pocket 已确定的“数据库事务＋后台投递＋Cron＋重试”高度重合，不需要 Redis。
- `pg`＋显式 SQL 让 outbox、revision、`FOR UPDATE`、`SKIP LOCKED` 等关键行为保持可见，避免把一致性藏在框架里。
- Node 内置 test runner、Fastify 注入和 WebSocket 注入可以覆盖主要接口，减少测试框架数量。

### 代价

- OpenAPI 文档不如 FastAPI 自动，需要维护 Schema 与文档生成配置。
- pg-boss 是任务队列，不是 Pocket 的领域同步协议；`operations / server_seq / receipts` 仍需按架构实现。
- TypeScript 类型不会自动成为运行时契约，HTTP 入口仍必须使用 JSON Schema 校验。
- Node 进程内 WebSocket 连接同样需要由 Pocket 管理 Link Registry；多实例时需要数据库状态而非内存状态作为权威。

### 适合条件

最符合当前仓库和首版目标：快速实现、少量基础设施、可靠任务投递和可持续扩展。

## 4. 候选 C：Go

### 建议组合

```text
Go
net/http 或轻量 HTTP router
Gorilla WebSocket
pgx/v5
River
PostgreSQL
```

### 已核实能力

- pgx 提供 PostgreSQL 驱动、连接池、JSONB、事务和 LISTEN／NOTIFY，[pgx](https://github.com/jackc/pgx)。
- Gorilla WebSocket 是 Go 的 WebSocket 实现，[gorilla/websocket](https://github.com/gorilla/websocket)。
- River 使用 PostgreSQL 持久化任务，支持事务内插入，只有事务提交后任务才对 Worker 可见，[River Transactions](https://riverqueue.com/docs#inserting-jobs)。

### 优点

- 单二进制部署和较低运行资源占用有吸引力。
- pgx＋River 对 PostgreSQL 队列、锁和后台 Worker 的支持清晰。
- 强类型模型适合长期维护较大的后端。

### 代价

- 需要新的 Go 模块、CI、测试与契约维护体系，现有 Cron JS 逻辑需要移植。
- 编写 Schema、WebSocket 和领域适配的代码量通常高于另外两条路线。
- 当前 bits-style 没有 Go 扫描适配，按 Pocket 的 AGENTS.md 会新增明确的 `unsupported` 成本。

### 适合条件

当 Pocket 的连接数、吞吐量或团队 Go 经验成为主要约束时再选。首版没有必要仅为潜在性能提前承担这些成本。

## 5. PostgreSQL 与 SQLite

### 选择 PostgreSQL

- PostgreSQL 提供行锁和 `SKIP LOCKED`，适合持久 outbox 和并发任务领取，[PostgreSQL SELECT / Locking Clause](https://www.postgresql.org/docs/current/sql-select.html)。
- `jsonb` 支持索引和丰富的查询操作，适合保存事件 payload 与可选结构化结果，[PostgreSQL JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)。
- pg-boss 和 River 都以 PostgreSQL 事务作为后台任务可靠性基础。

### SQLite 的适用边界

SQLite WAL 支持读写并发，但同一时间只有一个 writer，并且所有进程必须位于同一主机，[SQLite WAL](https://www.sqlite.org/wal.html)。它适合本地工具、原型或严格的单进程应用，不利于 Pocket 的 Web 进程、Worker、集成测试和未来多实例共享同一任务队列。

首版建议使用真实 PostgreSQL 做集成测试，避免用 SQLite 测试替代 PostgreSQL 的锁与队列行为。

## 6. 最终推荐的项目结构

```text
cloud/
  package.json          Node 24 / TypeScript
  src/
    http/               Fastify routes + JSON Schema
    identity/           User / Device / Grant
    link/               WebSocket registry + handshake
    sync/               operations + revisions + receipts
    clock/              Alarm + Agent Alarm domain
    scheduler/          pg-boss integration
    delivery/           Agent POST + result callback
    db/                 pg + migrations
  test/                 HTTP / WebSocket / PostgreSQL tests
```

`pg` 与 SQL migrations 负责领域事务；pg-boss 负责后台任务与 Cron。业务 `operations` 和 `delivery_results` 仍由 Pocket 自己定义，不让队列库代替领域模型。

部署采用持久 Node 进程和 PostgreSQL，因为 Link 需要长期连接，Scheduler 与 Delivery 需要持续恢复。首版不需要独立的 Redis、Kafka 或多语言 Worker。

## 7. 第一个垂直实现切片

建议先实现 **Agent Alarm → Cloud Scheduler → Mock Agent 202 → Delivery Completed**：

1. 建立 `cloud` workspace、Fastify 健康检查、PostgreSQL migration 和 pg-boss。
2. 实现 `agent_alarm.set`，保存 Prompt、run_at、Agent EP、凭证引用与 missed policy。
3. 到点生成唯一 `delivery_id`，通过 Node 原生 `fetch` POST 到 Mock Agent。
4. Mock Agent 持久化请求并返回 202，Pocket 将 delivery 标记 `COMPLETED`。
5. 同一 `delivery_id` 重试只产生一次逻辑投递。
6. 实现可选 `delivery.result.write`，能按 `delivery_id` 关联结果。
7. 重启 Cloud 后验证未来计划恢复；过期任务按默认策略不补发。

验收使用真实 PostgreSQL 和真实 HTTP Mock Agent，不用纯函数测试代替端到端投递证据。

## 8. 后续再评估的触发条件

- 需要大量 Python Agent 工具或数据处理：重新评估 FastAPI。
- Link 连接数或 Worker 吞吐量成为主要瓶颈：重新评估 Go。
- 多实例调度成为硬需求：分别核验 pg-boss、APScheduler 和 River 的实际拓扑，而不是只比较语言。
- Agent 客户端类型增多：补充 OpenAPI 生成和客户端 SDK 工作流。
