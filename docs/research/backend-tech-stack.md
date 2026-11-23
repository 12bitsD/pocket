# Pocket 后端与客户端技术选型（已定稿）

日期：2026-11-23  
状态：**已确认定稿**（取代早期草稿中的 Node/Fastify 候选建议）。

---

## 1. 最终拍板技术栈

### Pocket Cloud（后端与自托管服务）

```text
Runtime & 包管理 : Python 3.12 + uv (pyproject.toml + uv.lock)
Web & 协议契约   : FastAPI + Pydantic v2 + Uvicorn (HTTP JSON RPC + WebSocket + 静态托管 Web 工作台)
数据库与迁移     : PostgreSQL + psycopg v3 (async pool) + 显式顺序 SQL migrations
定时与后台投递   : PostgreSQL 权威表 + 轻量 asyncio Worker (FOR UPDATE SKIP LOCKED) + croniter + zoneinfo
出站 HTTP 客户端 : httpx.AsyncClient
测试与代码规范   : pytest + pytest-asyncio + 真实 Docker PostgreSQL + bits-style v0.3.5
部署形态         : Docker Compose (pocket-cloud + postgres，个人自托管优先)
```

### Web 工作台与 Android 客户端

```text
共享界面与设计系统 : Web 模块 + packages/design-system + packages/agent-core（遵循 docs/design-standard.md）
电脑端统一入口     : apps/web（统一管理闹钟、Agent 计划、日历、笔记、设备配对与 Agent 绑定）
Android 独立客户端 : Capacitor 容器打包本地 Web 资源 + Kotlin 薄层原生插件
Android 本地权威库 : 原生 SQLite（保存本地闹钟与离线 outbox）+ AlarmManager / BroadcastReceiver / 全屏响铃 Activity
```

---

## 2. 关键选型理由与取舍

### 为什么后端选 Python 3.12 + FastAPI + 显式 SQL，且不用 APScheduler？

1. **契约与开发效率**：FastAPI + Pydantic v2 自动生成精确的 JSON Schema 与 OpenAPI 文档，对外部 Agent 接入和个人快速迭代最省心；`bits-style v0.3.5` 原生支持 Python 扫描。
2. **显式 SQL 优于重 ORM**：Pocket Cloud 的核心一致性依赖事务内同时写业务表与队列、`base_revision` 校验以及 `SELECT ... FOR UPDATE SKIP LOCKED` 租约抢占；用 `psycopg` v3 直接写 SQL 最直观透明，不隐藏锁和事务边界。
3. **PostgreSQL 表驱动 Worker 优于 APScheduler / Redis**：
   - APScheduler 的持久 job store 不能多实例安全共享，且会与 Pocket 自身的 `schedules / deliveries` 表形成两套重复状态；
   - 直接用 PostgreSQL 权威表 + `croniter` + `zoneinfo` 计算下次触发时间，由轻量 `asyncio` 循环用短事务 30 秒租约抢占后在事务外发送请求，零额外中间件就同时满足崩溃恢复、幂等重试与 `missed_policy` 控制。
4. **PostgreSQL 优于 SQLite（云端）**：云端需同时跑 HTTP/WS 请求与后台投递循环，PostgreSQL 的行锁与 `SKIP LOCKED` 能避免 SQLite 单写锁争用，集成测试也直接使用真实 Docker PostgreSQL。

### 为什么客户端选 Web 界面复用 + Capacitor + Kotlin 薄插件？

1. **一套视觉两端共用**：已打磨成型的活字终端设计系统（`packages/design-system`）和业务交互逻辑 95% 用 JS/TS 编写，同时服务电脑统一 Web 工作台与手机 App，无需用 Jetpack Compose 重画第二套界面。
2. **Kotlin 兜底系统硬能力**：浏览器和通用通知插件无法可靠保证“静音模式强制响铃、黑屏全屏唤醒、重启未解锁自动恢复闹钟、ColorOS 自启动设置引导”；这部分底层能力直接用标准 Kotlin 写极薄的原生插件与原生 SQLite 存储最稳妥。
3. **规范边界清晰**：核心业务逻辑留在 Python 与 JS/TS 中接受 `bits-style` 检查，生成的 Android 原生工程目录在 `bits.toml` 中明确排除。

---

## 3. 分阶段实施切片

### Step 1：Pocket Cloud 第一期（Agent 计划闭环）
1. 安装 `uv`，建立 `cloud/` 项目骨架、`docker-compose.yml`（PostgreSQL）与顺序 SQL 迁移。
2. 实现初始主密钥引导、`users / grants` Bearer 权限校验与 `idempotency_keys` 防重复提交。
3. 实现 `agent_binding.set / list / revoke`（调用密钥对称加密存库、列表不回显、外网 `https://` 地址校验）。
4. 实现 `agent_alarm.set / list / cancel`、`delivery.get` 与 `POST /v1/deliveries/{id}/result`（支持单次截止时间与周期 `cron` 相对 `ttl`，签发一次性回调密钥）。
5. 实现后台 Worker（短事务 30 秒租约 → `httpx` POST → `202` 标 `COMPLETED`、重试复用 `delivery_id`、超时回收与过期停发）。
6. 用真实 Docker PostgreSQL + 真实本地 HTTP Mock Agent 跑通端到端集成测试。

### Step 2：电脑 Web 工作台首版打通
1. 建立统一 Web 工作台外壳，嵌入 Clock（闹钟 + Agent 计划 + 世界时钟 + 配置）视图并连接真实 Cloud RPC 接口。
2. 验证在浏览器端配置真实外部 Agent 并完成定时投递与回传展示。

### Step 3：Cloud 第二期 + Clock Android 真机客户端
1. 实现 6 位短时配对码（`pairing.create / claim`）、WebSocket `GET /v1/link` 断点补发、普通闹钟同步与 `cloud_locked` 本地锁保护。
2. 用 Capacitor + Kotlin 原生插件（原生 SQLite + `AlarmManager` + 开机广播 + 锁屏响铃页）打包 `apps/clock` Android APK 并上真机验收。
