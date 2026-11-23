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

### Web 工作台与 Android 客户端（已做技术债核验与拍板）

```text
前端构建与模块化 : Vite + 原生 ES Modules / TS（不引 React/Vue 重框架）+ packages/client-core + packages/design-system
电脑端统一入口   : apps/web（直接挂载 Clock 与 Calendar 可复用视图模块，零 iframe，由 FastAPI 同源静态托管）
Android 独立包   : Capacitor 8.6 (compileSdk 36 / targetSdk 36 / minSdk 26 / AGP 8.13 / JDK 21) + Kotlin 薄原生插件
首轮客户端范围   : Clock (app.pocket.clock) + Calendar (app.pocket.calendar) 两个独立 APK；Notes 留待后续专项设计后再接入
Clock 原生权威库 : Device-Protected Storage 原生 SQLite + directBootAware 锁屏重启恢复 + USE_EXACT_ALARM / setAlarmClock + 全屏响铃服务
双独立 App 协同  : Calendar 不建第二套响铃引擎；同机通过 signature 权限显式广播直连唤醒 Clock 原生层（断网可用）+ Cloud 对账双保险
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

### 客户端技术债核验与拍板结论（2026-11-23）

1. **清偿单文件 HTML 原型债（`Vite` + `packages/client-core`，不引重框架）**：
   - 现有 `apps/clock/index.html` 与 `apps/calendar/index.html` 各含 1100+ 行内联脚本、重复工具函数、硬编码内存假数据及 `../../packages` 越界相对路径，无法直接打进 Capacitor 自包含 `webDir`，也无法在不套 `<iframe>` 的前提下拼成统一 Web 工作台。
   - **拍板**：不引 React/Vue，只引入轻量 `Vite` 构建；抽离 `packages/client-core`（RPC 客户端、`request_id` 幂等、WebSocket `Link` 同步、`PocketRuntime` 接口），将 Clock 与 Calendar 拆为可挂载模块（`mountClockApp` / `mountCalendarApp`），一套源码同时编译出 `apps/web`、`apps/clock/dist` 与 `apps/calendar/dist`，并彻底消除单大函数 `BCS003` 膨胀。
2. **手机双独立 App（Clock + Calendar）协同债：本机签名直连 + Cloud 对账双保险**：
   - 手机上 `app.pocket.clock` 与 `app.pocket.calendar` 沙箱隔离。若 Calendar 自建响铃服务会造成双套系统闹钟与双倍权限配置；若仅靠 Cloud WebSocket 中转，手机断网或 Clock 后台 WebView 被系统冻结时闹钟无法及时落盘。
   - **拍板**：**只有 Clock 持有原生响铃引擎**；同机安装时，Calendar 创建强提醒或 `@me` Todo 除了写离线 `outbox` 同步 Cloud 外，还通过相同签名证书保护的 `signature` 权限显式广播直接唤醒本机 Clock 原生层写入系统闹钟（断网飞行模式照常生效）；电脑远程设闹钟时若手机后台冻结，Cloud 与 Web 端诚实保持 `OFFLINE_QUEUED`，待 Clock 前台打开或原生 `WorkManager` 周期拉取写入 `AlarmManager` 后再推进至 `EXECUTED`。
3. **Android 14–16 (`targetSdk 36`) 与夜间自动重启（Direct Boot）系统债**：
   - 手机凌晨系统更新自动重启后停留在锁屏未输密码状态（Direct Boot）时，默认应用目录与整个 WebView 存储（含 `@capacitor-community/sqlite`、`localStorage`）均不可读。
   - **拍板**：**不使用社区 WebView SQLite 插件**；Clock 的 Kotlin 原生层使用 `Context.createDeviceProtectedStorageContext()` 在设备加密区（DE）直接维护原生 `SQLiteOpenHelper`（`alarms` + `outbox`），静态广播接收器声明 `android:directBootAware="true"` 监听 `LOCKED_BOOT_COMPLETED` / `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` / `TIME_SET` / `TIMEZONE_CHANGED`；统一调用 `AlarmManager.setAlarmClock()`（配合侧载 APK 声明 `USE_EXACT_ALARM` 及 `SCHEDULE_EXACT_ALARM` 兜底检查），周期闹钟采用“单次精确触发后由原生层计算注册下一次”；响铃前台服务按 API 34+ 规范声明 `foregroundServiceType="systemExempted|mediaPlayback"`，并用 `NotificationManager.canUseFullScreenIntent()` 检测与引导开启锁屏全屏弹起。
4. **ColorOS 真机后台限制债**：
   - 在 Clock 设置页集中提供 **4 项真实状态自检与一键跳转卡**（精确闹钟权限、锁屏全屏弹出、忽略电池优化、ColorOS 自启动与后台弹出设置）；Calendar 不承担重响铃权限，保持极轻。
5. **Calendar Todo 与 Clock 单一数据源债**：
   - `todos` 表仅存待办正文、完成态与 `linked_alarm_id` / `linked_schedule_id` 引用，不复制存储时间、开关与回执，避免多端修改产生双份脏数据。
6. **本机工具链与版本拍板**：
   - 锁定 `Capacitor 8.6.x`（要求 `Node >= 22`、`JDK 21`、`Android SDK 36`、`AGP 8.13`）；本机已有 `Node 24`、`Docker 29`、本地 `android-sdk`（`android-35/36`、`build-tools 36.0.0`）与 `gradle-8.13`，Step 1 仅需补装 `uv`，Step 3 打包 APK 前补装 `JDK 21` 即可直接复用现有 Android SDK。

---

## 3. 分阶段实施切片（先落地 Clock + Calendar，Notes 后续专项设计）

### Step 1：Pocket Cloud 第一期（Agent 计划 + 日历/Todo 后端闭环）
1. 安装 `uv`，建立 `cloud/` 项目骨架、`docker-compose.yml`（PostgreSQL）与顺序 SQL 迁移。
2. 实现初始主密钥引导、`users / grants` Bearer 权限校验与 `idempotency_keys` 防重复提交。
3. 实现 `agent_binding.set / list / revoke`（调用密钥对称加密存库、列表不回显、外网 `https://` 地址校验）。
4. 实现 `agent_alarm.set / list / cancel`、`delivery.get`、`POST /v1/deliveries/{id}/result` 以及 Calendar `event.*` / `todo.*`（含 `linked_alarm_id` / `linked_schedule_id` 事务协调）。
5. 实现后台 Worker（短事务 30 秒租约 → `httpx` POST → `202` 标 `COMPLETED`、重试复用 `delivery_id`、超时回收与过期停发），用真实 Docker PostgreSQL + 本地 HTTP Mock Agent 跑通端到端测试。

### Step 2：前端去原型债 + 电脑统一 Web 工作台首版
1. 引入轻量 `Vite` 与 `packages/client-core`，将 Clock 与 Calendar 单文件原型拆分为可挂载模块。
2. 组装 `apps/web` 统一电脑工作台，接入真实 Cloud RPC 接口跑通日常使用。

### Step 3：Cloud 第二期同步 + Clock & Calendar 双 Android 真机包
1. 实现 6 位短时配对码（`pairing.create / claim`）、WebSocket `GET /v1/link` 断点补发、普通闹钟同步与 `cloud_locked` 本地锁保护。
2. 安装 `JDK 21` 并复用本机 Android SDK 36，用 Capacitor 8.6 + Kotlin 插件打包 `Clock` 与 `Calendar` 两个独立 APK 上真机验收（含 Direct Boot 重启恢复与同机离线 `@me` 唤醒验证）。

### Step 4：Notes 专项设计与接入
1. 单独深入设计 Notes 的编辑、组织与按条目 Agent 授权交互，定稿后再接入 Cloud、`apps/web` 与第三个独立 Android App。
