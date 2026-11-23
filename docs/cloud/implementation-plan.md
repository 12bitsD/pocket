# Pocket Cloud 后端完整技术方案与分步开发实施手册

状态：**正式定稿版（v4 · 已完成 4 轮架构、并发、安全与开发可落地性审查迭代）**  
适用仓库：`12bitsD/pocket`（后端工程根目录：`cloud/`）  
关联文档：[总体架构](../architecture.md) · [Cloud 架构概览](architecture.md) · [Calendar 领域架构](calendar.md) · [设计标准](../design-standard.md)

> **交付标准**：本手册面向任何具备 Python 与 SQL 基础的后端工程师。无需翻阅任何历史讨论，严格按本文档的 **Step 1 → Step 2 → Step 3 → Step 4** 顺序即可从零搭建 `cloud/`，逐阶段跑通数据库迁移、单元测试、真实 PostgreSQL 端到端验收，并一次性通过仓库 CI 与 `bits-style v0.3.5` 规范门禁。

---

## 第一部分：全局技术方案与核心机制（整合定版）

### 1.1 系统边界与职责

Pocket Cloud 是个人自托管优先的共享后端，同时支撑两个按使用场景彻底分离的独立客户端应用（当前主线 **Pocket Calendar** 与后续规划的 **Pocket Notes**）以及用户接入的**外部 AI Agent**：

1. **身份、6 位配对码与受限授权**：首次启动幂等创建默认用户与初始主密钥；通过 5 分钟有效、带双层防爆破保护的 6 位数字配对码为手机签发独立长期设备凭证；为外部 Agent 签发按动作开关受限的 Bearer Token。
2. **时间与日程单一真相源**：管理日程（`events`）、待办（`todos`）、设备闹钟（`alarms`）与 Agent 定时计划（`schedules`）。`todos` 与 `events` 仅通过外键（`linked_alarm_id` / `linked_schedule_id`）引用闹钟或计划，**绝不复制存储触发时间、启停状态或执行回执**。
3. **云端定时调度与 Prompt 投递（`@agent` 链路）**：后台 `asyncio` 循环用 PostgreSQL 30 秒短事务租约抢占到期任务，释放数据库连接后向外部 Agent 发送 HTTP POST，收到 `202 Accepted`（或 `200 OK`）记为 `COMPLETED`；支持失败指数退避重试（复用同一 `delivery_id` 与一次性 `callback_token`）、崩溃租约自动接管、超期停发（`EXPIRED`）与结果摘要回写。
4. **有序操作流与 WebSocket 实时同步（`@me` 设备链路）**：所有客户端状态变更在同一数据库事务内写入按用户严格有序的 `operations(server_seq)` 并触发 PostgreSQL `NOTIFY`；通过 `GET /v1/link` 完成断线重连补发与实时推送，以手机原生层真实回执推进状态机，强制保护开启本机锁（`cloud_locked = true`）的闹钟不被远端或 AI 篡改。

---

### 1.2 技术栈选型与精确版本约束

**架构形态**：模块化单体（1 个 Python 容器默认在单进程内通过 FastAPI `lifespan` 同时运行 HTTP/WS 接口与后台调度循环，也支持通过 CLI 拆为独立的 `api` 进程与 `worker` 进程 + 1 个 PostgreSQL 17 容器）。**不引入 Redis、消息队列、SQLAlchemy ORM 或 APScheduler**。

| 模块层级 | 选型与版本范围 | 选型理由与关键用法 |
| --- | --- | --- |
| 运行时与包管理 | `Python >=3.12,<3.13` + `uv` | 原生 `zoneinfo`、`asyncio`、现代类型注解，`uv.lock` 锁定可复现环境 |
| HTTP 与 WebSocket | `fastapi>=0.115,<1.0` + `uvicorn[standard]>=0.32,<1.0` | 自动 OpenAPI 文档、请求体验证、原生 WebSocket 支持 |
| 数据契约校验 | `pydantic>=2.9,<3.0` | RPC 入参／出参强类型契约与自定义校验器 |
| 数据库与连接池 | `psycopg[binary,pool]>=3.2,<4.0` | 原生异步连接池 `AsyncConnectionPool`，显式控制事务、行锁、`SKIP LOCKED` 与 `LISTEN/NOTIFY` |
| 对称加密与哈希 | `cryptography>=43.0,<45.0` | `AESGCM`（AES-256-GCM）加密存储外部 Agent 调用密钥与回调重试密钥 |
| Cron 表达式计算 | `croniter>=3.0,<4.0` | 配合标准库 `zoneinfo.ZoneInfo` 计算本地时区五段 Cron 触发时刻 |
| 出站 HTTP 客户端 | `httpx>=0.27,<1.0` | 异步 POST 外部 Agent，使用连接前公网 IP 绑定 + `sni_hostname` 防御 DNS 重绑定 |
| 测试框架 | `pytest>=8.3,<9.0` + `pytest-asyncio>=0.24,<1.0` | 真实 Docker PostgreSQL + 真实本地 HTTP Mock Agent 集成测试 |

---

### 1.3 仓库编码红线（`bits-style v0.3.5` 必过指南）

仓库 CI 强制执行 `bits style check --diff --commit origin/main`。编写任何 `.py` 文件（**含 `tests/` 下所有测试代码**）必须遵守以下规则，任何一条 `violation` 都会导致退出码 `1` 阻断合并：

1. **缩进与行宽（`BCS001/BCS002`）**：4 空格缩进，文件末尾必须有且仅有一个换行符，无行尾空白；普通代码行宽 **<= 80 列**（仅不可拆分的长错误文案、SQL 语句字符串或 URL 字面量允许超宽）。
2. **严禁在业务或配置模块直接读 `os.environ` / `os.getenv`（`BCS011` 头号易踩坑点！）**：
   - `bits-style` 扫描器会将任何未豁免的 `os.environ` 或 `os.getenv` 直接判定为 **`BCS011: environment values must be passed explicitly` 硬违规**。
   - **唯一合规写法**：整个 `cloud/` 只允许在 `src/pocket_cloud/cli.py` 进程入口函数一处读取环境变量：
     ```python
     # bits:allow(BCS011): 进程入口集中读取环境变量并作为显式映射传入配置层
     raw_env = dict(os.environ)
     ```
     `config.py` 的 `load_config(env: Mapping[str, str]) -> CloudConfig` 以及所有 `tests/` 代码均通过显式字典参数传递配置，其他任何文件严禁调用 `os.environ` 或 `os.getenv`。
3. **严禁可变全局变量与参数重赋值（`BCS011`）**：
   - 严禁在模块顶层声明 `pool = None`、`active_sockets = {}` 等可变全局状态（模块级只允许定义 `UPPER_SNAKE_CASE` 不可变常量，如 `tuple`、`frozenset`）；运行期状态统一放进 `AppContext` 实例并挂载到 `app.state.ctx`，路由通过 `Depends(get_ctx)` 获取；
   - 严禁给函数参数重新赋值（如 `limit = min(limit, 100)` 违规，应写 `clamped = min(limit, 100)`）；严禁局部变量遮蔽参数名。
4. **函数规模与签名约束（`BCS003/BCS004`）**：
   - 控制流嵌套 **<= 3 层**（硬违规）、圈复杂度 **<= 10**（硬违规）；异常分支一律使用前置卫语句 `if ...: raise AppError(...)` 提前退出，RPC 方法路由使用字典查表替代长 `if/elif`；
   - 函数非空代码行建议 **<= 48 行**、局部变量 **<= 10 个**；
   - 函数参数 **<= 4 个**（不含 `self`），多于 4 个参数时封装为 `dataclass(frozen=True)` 命令对象；**严禁布尔行为参数**（如禁止 `def get_alarms(only_active: bool)`，改用枚举 `AlarmScope.ACTIVE_ONLY`；Pydantic 数据模型中的 `bool` 字段不受此限）。
5. **异常、导入与注释（`BCS013/BCS014/BCS015`）**：
   - 严禁空 `except:` 或吞异常 `pass`；
   - 模块依赖必须单向无环，严禁 `from xxx import *`，未使用的回调函数参数必须以 `_` 开头（如 `async def handler(_request: Request, exc: AppError)`）；
   - 如需留 `TODO`，格式必须为 `# TODO(owner): 明确的完成条件`。

---

### 1.4 `cloud/` 目录结构与单向无环分层

依赖流向固定为：`core (config/errors/ids/crypto/ssrf) → db → identity → {agent_hub, calendar_domain, sync_link} → http_api → cli`：

```text
cloud/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── README.md
├── pyproject.toml
├── uv.lock
├── migrations/
│   ├── 0001_identity_and_idempotency.sql
│   ├── 0002_agent_schedules_and_deliveries.sql
│   ├── 0003_calendar_alarms_events_todos.sql
│   └── 0004_devices_pairing_and_sync.sql
├── src/
│   └── pocket_cloud/
│       ├── __init__.py
│       ├── cli.py                 # CLI 入口：serve | api | worker | migrate
│       ├── config.py              # CloudConfig 与 load_config(env)
│       ├── context.py             # AppContext（持有 pool, secret_box, link_hub, clock, limiter）
│       ├── errors.py              # ErrorCode 枚举、AppError 异常与 HTTP 状态码映射
│       ├── ids.py                 # 前缀随机 ID 与 6 位数字配对码生成
│       ├── crypto.py              # SHA-256 令牌哈希、SecretBox(AES-256-GCM)、常量时间比较
│       ├── ssrf.py                # 公网 IP 断言（含 IPv4-mapped IPv6）与绑定 IP 的安全 POST
│       ├── db/
│       │   ├── __init__.py
│       │   ├── pool.py            # psycopg v3 AsyncConnectionPool 与 user_write_tx 事务封装
│       │   └── migrate.py         # 顺序 SQL 迁移执行器（pg_advisory_xact_lock 防并发）
│       ├── identity/
│       │   ├── __init__.py
│       │   ├── models.py          # Principal, SubjectKind, ActionScope
│       │   ├── bootstrap.py       # 默认用户与初始主密钥幂等同步/轮换
│       │   ├── auth.py            # Bearer 令牌解析与权限范围断言
│       │   ├── grants_service.py  # auth.whoami 与 grant.create / list / revoke
│       │   └── idempotency.py     # request_id 规范化哈希与防重复提交执行器
│       ├── agent_hub/
│       │   ├── __init__.py
│       │   ├── bindings_repo.py   # agent_bindings 表 SQL（含软删除复活 UPSERT）
│       │   ├── schedules_repo.py  # schedules / deliveries / delivery_results 表 SQL
│       │   ├── cron_calc.py       # croniter + ZoneInfo 计算下次触发与 missed_policy 裁剪
│       │   ├── service.py         # agent_binding.* / agent_alarm.* / delivery.* 编排
│       │   └── worker.py          # 30s 租约展开/投递/重试循环 + 幂等键过期清理
│       ├── calendar_domain/
│       │   ├── __init__.py
│       │   ├── models.py          # 周期规则枚举、提前提醒跨午夜换算辅助函数
│       │   ├── alarms_repo.py     # alarms 表 SQL 与 cloud_locked 校验
│       │   ├── events_repo.py     # events 表 SQL、周期日程区间展开与重叠检测
│       │   ├── todos_repo.py      # todos 表 SQL 与关联闹钟/计划/回执联表视图
│       │   └── service.py         # alarm.* / event.* / todo.* 单事务协调服务
│       ├── sync_link/
│       │   ├── __init__.py
│       │   ├── operations_repo.py # operations(server_seq) 写入 + PG NOTIFY + receipts 单调推进
│       │   ├── pairing_service.py # 双层限流器 + 6 位配对码创建/核销 + device.* 管理
│       │   ├── hub.py             # PG LISTEN 订阅器 + 进程内活跃 WebSocket 连接表
│       │   └── ws_handler.py      # GET /v1/link 握手、无损断点补发、实时推送、回执与心跳
│       └── http_api/
│           ├── __init__.py
│           ├── schemas.py         # 统一信封与全部 23 个 RPC 方法的 Pydantic 请求/响应模型
│           ├── deps.py            # FastAPI Depends 注入辅助
│           ├── rpc_router.py      # POST /v1/rpc/{method} 字典分发器
│           ├── callbacks.py       # POST /v1/deliveries/{delivery_id}/result 回调入口
│           └── app.py             # create_app 工厂、lifespan 优雅启停与统一异常处理器
└── tests/
    ├── conftest.py                # FakeClock、真实测试 PG 清理 fixture 与真实 HTTP Mock Agent
    ├── test_step1_foundation.py
    ├── test_step2_scheduler_delivery.py
    ├── test_step3_calendar_domain.py
    └── test_step4_pairing_and_link.py
```

---

### 1.5 三大全局底层机制（贯穿全部 Step，写代码前必读）

#### 机制 A：用户级串行写事务 `user_write_tx`（根除 `server_seq` 乱序漏同步与跨表死锁）
- **痛点**：PostgreSQL 的 `BIGSERIAL` 按调用时机取号而非提交时机排序。若事务 1 取到 `server_seq = 10`、事务 2 取到 `server_seq = 11` 且事务 2 先提交，WebSocket 客户端游标推进到 `11` 后将**永久漏掉稍后提交的 `10`**；同时 `todos / events / alarms / schedules` 多表更新若加锁顺序不同易引发死锁。
- **标准做法（`db/pool.py`）**：封装异步上下文管理器 `user_write_tx(pool, user_id)`，开启事务后第一句固定执行：
  ```sql
  SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE;
  ```
  同一 `user_id` 的所有写事务在数据库层自然排队（不同用户互不影响；外部网络请求严禁放进事务内，单次事务仅 `1–3ms`），一举保证：① `server_seq` 分配顺序与提交可见顺序 100% 一致；② 同一用户跨表修改零死锁；③ 相同 `request_id` 并发请求天然串行检查幂等表。

#### 机制 B：可注入时钟 `ctx.clock()`（支撑毫秒级确定性测试）
- `AppContext` 持有 `clock: Callable[[], datetime]`（生产默认为 `lambda: datetime.now(timezone.utc)`）。
- 所有业务计算、租约到期判定、Cron 展开、配对码过期判定均将 `now_utc = ctx.clock()` 作为显式参数 `$n` 传给 SQL（如 `WHERE next_fire_at <= $1`），**不在业务逻辑判断 SQL 中写死数据库 `now()`**（仅 `created_at / updated_at` 默认值可用 `now()`）。
- 这样在测试中只需将 `FakeClock` 拨快 `+31s` 或 `+16m`，无需 `asyncio.sleep(30)` 即可在 **0.5 秒内** 稳定测完 30 秒租约崩溃接管、5 次退避重试、15 分钟过期与 7 天幂等键清理！

#### 机制 C：`psycopg` v3 连接池与 JSONB 规范用法
- 连接池初始化：`AsyncConnectionPool(conninfo=config.database_url, min_size=2, max_size=10, open=False, kwargs={"row_factory": dict_row})`；在 FastAPI `lifespan` 启动时调 `await pool.open()`，关闭时调 `await pool.close()`。
- 写入 `JSONB` 列时一律使用 `from psycopg.types.json import Jsonb` 包装字典 `Jsonb(data_dict)`，读取时 `psycopg` 自动反序列化为 Python `dict`。

---

### 1.6 全局 HTTP / RPC 协议与错误码规范

#### 1.6.1 路由与信封格式
1. **`GET /healthz`**：免鉴权，执行 `SELECT 1`，正常返回 `200 {"status": "ok", "db": "ok"}`，数据库异常返回 `503`。
2. **`POST /v1/deliveries/{delivery_id}/result`**：外部 Agent 携带 `Authorization: Bearer <callback_token>` 回传执行摘要（请求体上限 `32 KB`）。
3. **`GET /v1/link`**：客户端出站 WebSocket 连接（首帧 `HELLO` 鉴权）。
4. **`POST /v1/rpc/{method}`**：统一具名 RPC 入口（请求体上限 `64 KB`；除 `pairing.claim` 外均需 `Authorization: Bearer <token>`）：
   - **请求信封**：
     ```json
     {
       "meta": {
         "request_id": "req_01J8Z9K2X3",
         "correlation_id": "cor_01J8Z9K2X3",
         "source": "web"
       },
       "params": {}
     }
     ```
     - **写方法**：`meta.request_id` 必填（`1..128` 字符），`meta.source` 必填（枚举：`"local" | "web" | "agent" | "calendar"`）；`correlation_id` 缺省时服务端自动生成 `cor_<hex>`。
     - **读方法**：`meta` 与 `params` 均可省略（缺省按 `{}` 处理）。
   - **成功响应信封**（同步完成返 `200`，设备离线排队返 `202`）：
     ```json
     {
       "data": {},
       "correlation_id": "cor_01J8Z9K2X3"
     }
     ```
   - **错误响应信封**：
     ```json
     {
       "error": {
         "code": "CLOUD_LOCKED",
         "message": "Alarm alm_01 is locked on device and cannot be modified remotely",
         "details": { "alarm_id": "alm_01" },
         "correlation_id": "cor_01J8Z9K2X3"
       }
     }
     ```

#### 1.6.2 标准错误码与 HTTP 状态码映射表

| `error.code` | HTTP 状态码 | 触发场景 | 写入幂等表？ |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | `422` | JSON 解析失败、缺少必填字段、字段格式/枚举/区间不合法 | 否 |
| `UNKNOWN_METHOD` | `404` | `/v1/rpc/{method}` 未在路由表注册 | 否 |
| `UNAUTHENTICATED` | `401` | 缺失、格式错误、已过期或已吊销的 Bearer / Callback Token | 否 |
| `PERMISSION_DENIED` | `403` | Token 缺少目标动作权限，或非手机本机试图设置/修改 `cloud_locked` 标志 | 否 |
| `UNSAFE_ENDPOINT` | `422` | Agent 地址非 `https://`、带账密或解析至私网/回环/链路本地/CGNAT 地址 | 否 |
| `NOT_FOUND` | `404` | 目标记录不存在或已软删除 | 否 |
| `IDEMPOTENCY_CONFLICT` | `409` | 同一 `(user_id, method, request_id)` 重复提交但 `params` 哈希不同 | 否 |
| `REVISION_CONFLICT` | `409` | 传入 `base_revision` 与数据库当前 `revision` 不一致 | 否 |
| `CLOUD_LOCKED` | `409` | 非手机本机来源尝试修改或删除已开启 `cloud_locked` 的闹钟及其关联项 | 否 |
| `PAIRING_INVALID` | `400` | 6 位配对码错误、不存在或已超过 5 分钟有效期 | 否 |
| `RATE_LIMITED` | `429` | 配对码兑换触发 IP 限流（`>5次/分钟`）、全局限流（`>20次/分钟`）或单码错满 10 次作废 | 否 |
| `PAYLOAD_TOO_LARGE` | `413` | 请求体超出大小上限 | 否 |
| `INTERNAL_ERROR` | `500` | 未预期异常（服务端记结构化错误日志，对外隐藏内部堆栈与凭据） | 否 |

---

## 第二部分：四阶段手把手开发实施细则（Step 1 – Step 4）

---

## Step 1：工程骨架、加解密、身份权限与幂等网关

### Step 1 任务分解

#### 1.1 创建项目配置与容器文件
1. **新建 `cloud/pyproject.toml`**：
   ```toml
   [build-system]
   requires = ["hatchling>=1.25"]
   build-backend = "hatchling.build"

   [project]
   name = "pocket-cloud"
   version = "0.2.0"
   description = "Self-hosted sync and Agent scheduling backend for Pocket"
   requires-python = ">=3.12,<3.13"
   dependencies = [
       "cryptography>=43.0,<45.0",
       "croniter>=3.0,<4.0",
       "fastapi>=0.115,<1.0",
       "httpx>=0.27,<1.0",
       "psycopg[binary,pool]>=3.2,<4.0",
       "pydantic>=2.9,<3.0",
       "uvicorn[standard]>=0.32,<1.0",
   ]

   [project.optional-dependencies]
   dev = [
       "pytest>=8.3,<9.0",
       "pytest-asyncio>=0.24,<1.0",
   ]

   [project.scripts]
   pocket-cloud = "pocket_cloud.cli:main"

   [tool.hatch.build.targets.wheel]
   packages = ["src/pocket_cloud"]

   [tool.pytest.ini_options]
   asyncio_mode = "auto"
   testpaths = ["tests"]
   ```
2. **新建 `cloud/Dockerfile`**：
   ```dockerfile
   FROM python:3.12-slim

   COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

   WORKDIR /app/cloud
   COPY cloud/pyproject.toml cloud/uv.lock* ./
   RUN uv sync --no-dev --no-install-project

   COPY cloud/migrations ./migrations
   COPY cloud/src ./src
   RUN uv sync --no-dev

   EXPOSE 8787
   CMD ["uv", "run", "pocket-cloud", "serve"]
   ```
3. **本机初始化命令**：
   ```sh
   # 若本机未装 uv：curl -LsSf https://astral.sh/uv/install.sh | sh
   cd cloud && uv python install 3.12 && uv sync --dev
   ```

#### 1.2 实现 `config.py`、`ids.py`、`crypto.py`、`errors.py`
1. **`config.py`**（与 `cloud/.env.example` 字段严格对齐）：
   - `DATABASE_URL`：必填，须以 `postgresql://` 开头；
   - `POCKET_BOOTSTRAP_KEY`：必填，去空白后长度 `>= 16`，且禁止等于示例占位值 `"change-me-bootstrap-key"`；
   - `POCKET_SECRET_KEY`：必填，支持标准或 URL-safe Base64 解码（自动补齐 `=` padding），解码后字节长度**必须严格等于 `32`**，否则抛启动配置错误并打印生成示例命令；
   - `POCKET_PUBLIC_URL`：默认 `"http://127.0.0.1:8787"`，去掉末尾 `/`；
   - `POCKET_PORT`：整数 `1..65535`，默认 `8787`；
   - `POCKET_ALLOW_PRIVATE_AGENT_EP`：`"0"`（默认，映射为 `EndpointPolicy.PUBLIC_HTTPS_ONLY`）或 `"1"`（映射为 `EndpointPolicy.ALLOW_LOCAL_HTTP`）；
   - `POCKET_TRUST_PROXY_HEADERS`：`"0"`（默认）或 `"1"`；
   - `POCKET_WORKER_POLL_MS`：整数 `100..60000`，默认 `1000`。
2. **`ids.py`**：
   - `new_id(prefix: str) -> str`：`f"{prefix}_{secrets.token_hex(12)}"`（统一前缀：`usr`, `grt`, `agt`, `sch`, `dlv`, `alm`, `evt`, `tdo`, `dev`, `prc`, `lnk`, `op`, `rcp`, `cor`, `con`）；
   - `new_bearer_token(prefix: str = "pkt") -> str`：`f"{prefix}_{secrets.token_urlsafe(32)}"`；
   - `new_pairing_code() -> str`：`f"{secrets.randbelow(1_000_000):06d}"`。
3. **`crypto.py`**：
   - `hash_token(raw: str) -> str`：`hashlib.sha256(raw.encode("utf-8")).hexdigest()`；
   - `verify_hash(raw: str, expected_hex: str) -> bool`：`hmac.compare_digest(hash_token(raw), expected_hex)`；
   - `SecretBox(master_key: bytes)`：
     - `encrypt(plaintext: str) -> str`：每次随机 `nonce = secrets.token_bytes(12)`，`ct = AESGCM(master_key).encrypt(nonce, plaintext.encode("utf-8"), None)`，输出 `"v1:" + urlsafe_b64encode(nonce) + ":" + urlsafe_b64encode(ct)`；
     - `decrypt(token: str) -> str`：校验 `"v1:"` 头并解码解密，校验失败抛 `AppError(ErrorCode.INTERNAL_ERROR, "Ciphertext integrity check failed")`。

#### 1.3 编写迁移执行器 `db/migrate.py` 与 `0001_identity_and_idempotency.sql`
1. `migrate.py` 在单事务内获取 `SELECT pg_advisory_xact_lock(706311)`，确保 `schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())` 存在，按文件名升序执行未记录的 `.sql` 文件并写入版本号。
2. **`migrations/0001_identity_and_idempotency.sql`**：
   ```sql
   CREATE TABLE users (
       user_id TEXT PRIMARY KEY,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );

   CREATE TABLE grants (
       grant_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
       subject_kind TEXT NOT NULL CHECK (subject_kind IN ('bootstrap', 'web', 'device', 'agent')),
       subject_id TEXT NOT NULL,
       label TEXT NOT NULL,
       token_hash TEXT NOT NULL UNIQUE,
       actions TEXT[] NOT NULL,
       expires_at TIMESTAMPTZ NULL,
       revoked_at TIMESTAMPTZ NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );

   CREATE INDEX idx_grants_user_active ON grants (user_id) WHERE revoked_at IS NULL;

   CREATE TABLE idempotency_keys (
       user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
       method TEXT NOT NULL,
       request_id TEXT NOT NULL,
       payload_hash TEXT NOT NULL,
       status_code INTEGER NOT NULL,
       response_body JSONB NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, method, request_id)
   );

   CREATE INDEX idx_idempotency_created_at ON idempotency_keys (created_at);
   ```

#### 1.4 实现启动引导、权限检查与幂等执行器（`identity/`）
1. **`bootstrap.py`**：
   - 在 `pg_advisory_xact_lock(706312)` 事务内：若 `users` 表为空，创建默认用户 `'usr_owner'`；
   - 计算 `boot_hash = hash_token(config.bootstrap_key)`：将所有 `subject_kind = 'bootstrap' AND token_hash <> boot_hash AND revoked_at IS NULL` 的旧记录置 `revoked_at = now()`（支持改环境变量平滑换主密钥）；若不存在活跃 `boot_hash` 记录，则插入 `actions = ARRAY['*']` 的 bootstrap grant。
2. **权限范围（Action Scopes）常量定义**：
   - 全权：`*`（仅限 `bootstrap` / `web` / `device`）；
   - 管理权限（禁止授予 `subject_kind == 'agent'`）：`grant.manage`, `pairing.manage`, `device.manage`, `agent_binding.manage`；
   - 领域读写权限（可按需勾选授予 `agent`）：`alarm.read`, `alarm.write`, `agent_alarm.read`, `agent_alarm.write`, `event.read`, `event.write`, `todo.read`, `todo.write`。
3. **`auth.py`**：
   - 解析 `Authorization: Bearer <token>` 请求头，按 `token_hash` 查 `grants`：若不存在、`revoked_at IS NOT NULL` 或 `(expires_at IS NOT NULL AND expires_at <= ctx.clock())`，一律抛 `UNAUTHENTICATED (401)`；
   - `require_any_action(principal, allowed_actions)`：若 `'*'` 在 `principal.actions` 中或任意一个 `allowed_actions` 命中则放行，否则抛 `PERMISSION_DENIED (403)`。
4. **`idempotency.py`**：
   - 写方法在通过鉴权、动作权限检查与 Pydantic `params` 校验之后，对原始 `params` 字典计算 `payload_hash = sha256(json.dumps(raw_params, sort_keys=True, separators=(",", ":"), ensure_ascii=False))`；
   - 进入 `async with user_write_tx(ctx.pool, principal.user_id) as conn:`：
     - 查 `idempotency_keys`：命中且 `payload_hash` 一致 → 原样返回已存 `(status_code, response_body)`；命中但 `payload_hash` 不同 → 抛 `IDEMPOTENCY_CONFLICT (409)`；
     - 未命中 → 调用业务处理函数得到 `(status_code, data_dict)`，同事务插入 `idempotency_keys` 后提交。

#### 1.5 实现 Step 1 RPC 方法与 `cli.py`
1. **`auth.whoami`**（读，任意有效 Token）：
   - 返回：`{"user_id": "usr_owner", "grant_id": "grt_...", "subject_kind": "bootstrap", "subject_id": "owner-bootstrap", "actions": ["*"]}`。
2. **`grant.create`**（写，需 `grant.manage`）：
   - 入参 `params`: `{"subject_kind": "agent" | "web", "subject_id": "@work-agent", "label": "Work Agent", "actions": ["event.read", "todo.write"], "expires_at": null | "2027-01-01T00:00:00Z"}`（若 `subject_kind == "agent"` 且 `actions` 含 `"*"` 或任何 `*.manage`，抛 `422 VALIDATION_ERROR`）；
   - 返回 `200`: `{"grant_id": "grt_...", "token": "pkt_...", "subject_kind": "agent", "subject_id": "@work-agent", "label": "Work Agent", "actions": [...], "expires_at": null, "created_at": "..."}`。
3. **`grant.list`**（读，需 `grant.manage`）：返回 `{"grants": [...]}`（不含 `token` 和 `token_hash`）。
4. **`grant.revoke`**（写，需 `grant.manage`）：入参 `{"grant_id": "grt_..."}` → 置 `revoked_at = ctx.clock()`，返回 `{"grant_id": "grt_...", "revoked_at": "..."}`。
5. **`cli.py`**：支持 `pocket-cloud migrate | serve | api | worker` 四个子命令（Step 1 中 `worker` 循环先留空协程壳，Step 2 填入调度逻辑）。

### Step 1 完成门禁（DoD）
```sh
docker compose -f cloud/docker-compose.yml up -d postgres
cd cloud && uv run pytest tests/test_step1_foundation.py -v
bits style check cloud
```
必测用例：① `/healthz` 探活；② 主密钥轮换后旧密钥 `401`；③ Agent 授权禁含 `*` 且越权调 `grant.list` 返 `403`；④ 8 协程并发同 `request_id` 调 `grant.create` 严格只写 1 行且返回一致，同 `request_id` 异参返 `409`；⑤ 过期 `expires_at` Token（拨快 `FakeClock`）返 `401`。

---

## Step 2：Agent 绑定、防重绑定 SSRF、30 秒租约调度与回调闭环

### Step 2 任务分解

#### 2.1 数据库迁移 `migrations/0002_agent_schedules_and_deliveries.sql`
```sql
CREATE TABLE agent_bindings (
    agent_binding_id TEXT NOT NULL CHECK (agent_binding_id ~ '^@[a-z0-9][a-z0-9_-]{1,30}$' AND agent_binding_id <> '@me'),
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    credential_ciphertext TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, agent_binding_id)
);

CREATE TABLE schedules (
    schedule_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    agent_binding_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'pocket.calendar',
    prompt TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('once', 'cron')),
    run_at TIMESTAMPTZ NULL,
    cron_expr TEXT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    expires_at TIMESTAMPTZ NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK (ttl_seconds BETWEEN 60 AND 86400),
    missed_policy TEXT NOT NULL DEFAULT 'skip' CHECK (missed_policy IN ('skip', 'latest', 'all')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    skip_next BOOLEAN NOT NULL DEFAULT FALSE,
    origin_kind TEXT NOT NULL DEFAULT 'standalone' CHECK (origin_kind IN ('standalone', 'todo')),
    next_fire_at TIMESTAMPTZ NULL,
    last_scheduled_at TIMESTAMPTZ NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, agent_binding_id) REFERENCES agent_bindings(user_id, agent_binding_id),
    CHECK (
        (mode = 'once' AND run_at IS NOT NULL AND cron_expr IS NULL) OR
        (mode = 'cron' AND cron_expr IS NOT NULL AND run_at IS NULL)
    )
);

CREATE INDEX idx_schedules_due
    ON schedules (next_fire_at)
    WHERE enabled = TRUE AND deleted_at IS NULL AND next_fire_at IS NOT NULL;

CREATE TABLE deliveries (
    delivery_id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    agent_binding_id TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ NULL,
    callback_token_hash TEXT NOT NULL,
    callback_token_ciphertext TEXT NOT NULL,
    last_http_status INTEGER NULL,
    last_error TEXT NULL,
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, scheduled_for)
);

CREATE INDEX idx_deliveries_claimable
    ON deliveries (next_attempt_at)
    WHERE status IN ('PENDING', 'DISPATCHING');

CREATE TABLE delivery_results (
    delivery_id TEXT PRIMARY KEY REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    external_session_ref TEXT NULL,
    payload JSONB NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### 2.2 实现零私有 API 的防 DNS 重绑定 SSRF 出站层（`ssrf.py`）
1. **公网 IP 校验 `assert_public_ip(raw_ip: str)`**：
   - `addr = ipaddress.ip_address(raw_ip)`；若 `isinstance(addr, ipaddress.IPv6Address)` 且 `addr.ipv4_mapped is not None`，令 `addr = addr.ipv4_mapped`（拦截 `::ffff:127.0.0.1`）；
   - 必须满足 `addr.is_global is True` 且不在 `ipaddress.ip_network("100.64.0.0/10")`（CGNAT）内，否则抛 `AppError(ErrorCode.UNSAFE_ENDPOINT, ...)`。
2. **安全发包函数 `post_agent_webhook(client: httpx.AsyncClient, endpoint_url: str, policy: EndpointPolicy, headers: dict, body_bytes: bytes) -> httpx.Response`**：
   - 解析 `urllib.parse.urlsplit(endpoint_url.rstrip("/") + "/webhooks/pocket")`：禁止 `username/password`；
   - 若 `policy == EndpointPolicy.ALLOW_LOCAL_HTTP`（仅测试模式）：允许 `http://127.0.0.1` / `http://localhost` 直接用 `client.post(..., follow_redirects=False)` 发送；
   - 若 `policy == EndpointPolicy.PUBLIC_HTTPS_ONLY`（生产默认）：
     - 强制 `scheme == "https"`；
     - 调用 `await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)` 获取全部解析结果，对**每一个**候选 IP 执行 `assert_public_ip(ip)`（只要含任何一个私网 IP 立即拒绝）；
     - 取首个通过校验的 `verified_ip`（IPv6 加方括号 `f"[{verified_ip}]"`），构造固定 IP 目标 URL `f"https://{ip_host}:{port}{path_and_query}"`，构造 `httpx.Request("POST", pinned_url, headers={**headers, "Host": host_header}, content=body_bytes, extensions={"sni_hostname": host})`，使用 `follow_redirects=False`、`timeout=httpx.Timeout(10.0, connect=5.0)` 发送——**彻底杜绝 DNS 重绑定与 `302` 内网跳转，同时完整保留 `httpx` 原生 TLS 证书域名校验**！

#### 2.3 实现 Cron 计算与到期展开（`agent_hub/cron_calc.py`）
1. 校验 `len(cron_expr.split()) == 5`、`croniter.is_valid(cron_expr)` 及 `ZoneInfo(timezone)` 合法。
2. `compute_next_fire_utc(cron_expr: str, tz_name: str, after_utc: datetime) -> datetime`：将 `after_utc` 转 `ZoneInfo(tz_name)`，执行 `croniter(cron_expr, local_dt).get_next(datetime)` 再转回 `timezone.utc`。
3. **到期展开规则（`GRACE_SECONDS = 120`, `MAX_CATCHUP = 10`）**：
   - **单次计划 `once`**：生成 1 条 `delivery`（若 `expires_at <= now_utc` 状态直接为 `'EXPIRED'`，否则为 `'PENDING'`），将 `schedules` 更新为 `enabled = FALSE, next_fire_at = NULL, last_scheduled_at = run_at`。
   - **周期计划 `cron`**：
     - 收集从 `schedule.next_fire_at` 起所有 `<= now_utc` 的触发时刻 `due_slots`，并算出严格 `> now_utc` 的 `new_next_fire_at`（若停机超 7 天且策略为 `'skip'`，直接从 `now_utc - 121s` 起算，防止空转循环）；
     - 若 `schedule.skip_next` 为真：弹出 `due_slots[0]` 不发，并将 `schedules.skip_next` 清回 `False`；
     - 对剩余 `due_slots` 按策略筛选：
       - `'skip'`：仅当 `now_utc - due_slots[-1] <= 120s` 且未超 `ttl_seconds` 时保留 `due_slots[-1]`，更早历史点直接丢弃；
       - `'latest'`：保留 `due_slots[-1]`（超 `ttl_seconds` 记 `'EXPIRED'`，否则记 `'PENDING'`）；
       - `'all'`：取 `due_slots[-10:]` 中未超 `ttl_seconds` 的槽位全部生成 `'PENDING'`；
     - 每条 `delivery` 生成独立一次性 `cbk_<token>`，同时存 `callback_token_hash` 与 `SecretBox.encrypt(cbk_token)`（确保重试同一 `delivery_id` 时发出完全相同的回调令牌），`ON CONFLICT (schedule_id, scheduled_for) DO NOTHING`。

#### 2.4 实现两阶段 30s 租约 Worker 与回调接口（`worker.py` & `callbacks.py`）
1. **Worker 单轮执行 `run_worker_tick(ctx)`**（拆为三个独立短事务，事务外发 HTTP）：
   - **短事务 1**：锁定并展开 `schedules WHERE enabled = TRUE AND deleted_at IS NULL AND next_fire_at <= $now`（`FOR UPDATE SKIP LOCKED LIMIT 20`）。
   - **短事务 2**：
     - 先将 `status IN ('PENDING', 'DISPATCHING') AND expires_at <= $now AND (lease_until IS NULL OR lease_until <= $now)` 批量更新为 `'EXPIRED'`；
     - 再用 `FOR UPDATE SKIP LOCKED LIMIT 10` 抢占 `((status = 'PENDING' AND next_attempt_at <= $now) OR (status = 'DISPATCHING' AND lease_until <= $now)) AND expires_at > $now` 的行，更新 `status = 'DISPATCHING', lease_until = $now + interval '30 seconds', attempt_count = attempt_count + 1`，联表查出 `prompt / source / endpoint_url / credential_ciphertext / binding_active / schedule_enabled`，**立即提交事务释放连接**。
   - **事务外发包**：并发（`asyncio.gather` 上限 10）调用 `post_agent_webhook` 发送：
     ```json
     {
       "version": "v1",
       "delivery_id": "dlv_...",
       "schedule_id": "sch_...",
       "source": "pocket.calendar",
       "type": "prompt.requested",
       "prompt": "整理本周进展，生成复盘摘要",
       "scheduled_for": "2026-11-23T08:00:00Z",
       "triggered_at": "2026-11-23T08:00:01Z",
       "result_callback_url": "https://pocket.example.com/v1/deliveries/dlv_.../result",
       "callback_token": "cbk_..."
     }
     ```
   - **短事务 3（写回状态）**：
     - 收到 HTTP `202` 或 `200`：更新 `status = 'COMPLETED', lease_until = NULL, completed_at = $now, last_http_status = code`；
     - 失败时先查父 `schedule` 与 `agent_binding` 是否仍处于启用未删状态：若已被用户取消/停用，更新 `status = 'CANCELLED'`；
     - 若为 `400 / 401 / 403 / 404 / 422` 永久客户端错误，或 `attempt_count >= 6`：更新 `status = 'FAILED'`；
     - 若为超时/网络异常/`408`/`429`/`5xx`：查退避表 `RETRY_DELAYS = (5, 15, 45, 120, 300)` 计算 `next_try = $now + delay`；若 `next_try >= expires_at` 则标 `'EXPIRED'`，否则回退 `status = 'PENDING', lease_until = NULL, next_attempt_at = next_try`。
   - *(注：在 Step 3/4 接入 Todo 与操作流后，若状态变更的 `delivery` 关联了某条 `todo`，在同一写回事务内顺手调用 `emit_todo_updated_op` 让前端实时看到 `202 COMPLETED` 状态。)*
2. **定期清理**：Worker 每满 1 小时执行 `DELETE FROM idempotency_keys WHERE created_at < $now - interval '7 days'`。
3. **回调端点 `POST /v1/deliveries/{delivery_id}/result`**：
   - 校验请求体 `<= 32 KB`，提取 `Authorization: Bearer <cbk_token>`；
   - 查 `deliveries.callback_token_hash` 并执行 `verify_hash`，不匹配返 `401 UNAUTHENTICATED`；
   - 幂等写入 `INSERT INTO delivery_results (delivery_id, summary, external_session_ref, payload, received_at) VALUES (...) ON CONFLICT (delivery_id) DO UPDATE SET summary = EXCLUDED.summary, external_session_ref = EXCLUDED.external_session_ref, payload = EXCLUDED.payload, received_at = EXCLUDED.received_at`，返回 `200 {"delivery_id": "...", "status": "recorded"}`。

#### 2.5 实现 Step 2 全部 7 个 RPC 方法
- **`agent_binding.set`**（写，`agent_binding.manage`）：
  - `params`: `{"agent_binding_id": "@work-agent", "name": "主力 Agent", "endpoint_url": "https://...", "credential": "sk-..." | null, "active": true, "base_revision": null | 1}`
  - 软删除复活规则：`base_revision == null` 时若库中不存在记录则新建（此时 `credential` 必填）；若存在 `deleted_at IS NOT NULL` 的已删记录则复活并 `revision + 1`（`credential` 必填）；若已存在未删活跃记录但传了 `base_revision == null`，抛 `409 REVISION_CONFLICT`。更新已有记录时 `credential == null` 表示保持原密文不变。
- **`agent_binding.list`**（读，`agent_binding.manage` 或 `agent_alarm.read` 或 `todo.read`）：返回所有未删绑定（仅含 `has_credential: true`，绝不含密文/明文）。
- **`agent_binding.revoke`**（写，`agent_binding.manage`）：`params: {"agent_binding_id": "@work-agent", "base_revision": 1}` → 置 `active = FALSE`，并将该绑定下所有 `PENDING` 投递置为 `'CANCELLED'`。
- **`agent_alarm.set` / `agent_alarm.list` / `agent_alarm.cancel` / `delivery.get`**：按 2.3/2.4 规则读写 `schedules` 与 `deliveries`（`cancel` 同步将该计划下 `PENDING` 投递置为 `'CANCELLED'`）。

### Step 2 完成门禁（DoD）
`uv run pytest tests/test_step2_scheduler_delivery.py -v` 全绿 + `bits style check cloud` 0 违规。必测：① 私网 IP、CGNAT、`[::ffff:127.0.0.1]`、`302` 重定向全部被 `UNSAFE_ENDPOINT` 拦截；② 真实本地 HTTP Mock Agent `202` 完成闭环；③ 两次 `503` 后第三次 `202` 复用同一 `delivery_id` 与 `callback_token`；④ 拨快 `FakeClock` `+31s` 自动接管 `DISPATCHING` 僵尸任务；⑤ 飞行途中取消计划不再重试；⑥ 回调摘要写入与错误令牌 `401`。

---

## Step 3：日程、闹钟与统一 `@指派` Todo 领域层

### Step 3 任务分解

#### 3.1 数据库迁移 `migrations/0003_calendar_alarms_events_todos.sql`
```sql
CREATE TABLE alarms (
    alarm_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    time_hhmm TEXT NOT NULL CHECK (time_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'daily', 'weekdays', 'weekly')),
    once_date DATE NULL,
    weekly_dow SMALLINT NULL CHECK (weekly_dow BETWEEN 0 AND 6),
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    skip_next BOOLEAN NOT NULL DEFAULT FALSE,
    cloud_locked BOOLEAN NOT NULL DEFAULT FALSE,
    target_mode TEXT NOT NULL DEFAULT 'preferred' CHECK (target_mode IN ('preferred', 'device_id')),
    target_device_id TEXT NULL,
    execution_status TEXT NOT NULL DEFAULT 'ACCEPTED'
        CHECK (execution_status IN ('ACCEPTED', 'OFFLINE_QUEUED', 'DELIVERED', 'APPLIED', 'EXECUTED', 'FAILED', 'MISSED')),
    origin_kind TEXT NOT NULL DEFAULT 'standalone' CHECK (origin_kind IN ('standalone', 'todo', 'event')),
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (schedule_kind = 'once' AND once_date IS NOT NULL AND weekly_dow IS NULL) OR
        (schedule_kind IN ('daily', 'weekdays') AND once_date IS NULL AND weekly_dow IS NULL) OR
        (schedule_kind = 'weekly' AND once_date IS NULL AND weekly_dow IS NOT NULL)
    )
);

CREATE INDEX idx_alarms_user_active ON alarms (user_id) WHERE deleted_at IS NULL;

CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    event_date DATE NOT NULL,
    start_hhmm TEXT NOT NULL CHECK (start_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_hhmm TEXT NOT NULL CHECK (end_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    repeat_rule TEXT NOT NULL DEFAULT 'none' CHECK (repeat_rule IN ('none', 'daily', 'weekdays', 'weekly')),
    reminder_policy TEXT NOT NULL DEFAULT 'notify' CHECK (reminder_policy IN ('none', 'notify', 'alarm')),
    reminder_offset_minutes INTEGER NOT NULL DEFAULT 15 CHECK (reminder_offset_minutes BETWEEN 0 AND 1440),
    linked_alarm_id TEXT NULL REFERENCES alarms(alarm_id),
    source TEXT NOT NULL DEFAULT 'local',
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_hhmm < end_hhmm)
);

CREATE INDEX idx_events_user_date ON events (user_id, event_date) WHERE deleted_at IS NULL;

CREATE TABLE todos (
    todo_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    assignee TEXT NOT NULL DEFAULT 'none',
    is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    linked_alarm_id TEXT NULL REFERENCES alarms(alarm_id),
    linked_schedule_id TEXT NULL REFERENCES schedules(schedule_id),
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (assignee = 'none' AND linked_alarm_id IS NULL AND linked_schedule_id IS NULL) OR
        (assignee = '@me' AND linked_alarm_id IS NOT NULL AND linked_schedule_id IS NULL) OR
        (assignee LIKE '@%' AND assignee <> '@me' AND linked_alarm_id IS NULL AND linked_schedule_id IS NOT NULL)
    )
);

CREATE INDEX idx_todos_user_active ON todos (user_id) WHERE deleted_at IS NULL;
```

*(注：`weekly_dow` 遵循 Python `date.weekday()` 约定：`0=周一 .. 4=周五 .. 6=周日`；映射为五段 Cron 周字段时公式为 `cron_dow = (weekly_dow + 1) % 7`；前端内联语法如 `@me 07:30 ...` 由前端在提交前解析为结构化字段，后端 `todo.set` 保持原样存储 `text` 正文，绝不用正则暗中裁剪用户 Prompt。)*

#### 3.2 实现 `cloud_locked` 护栏与 Agent 跨领域权限检查
1. **本机信任判定**：仅当 `principal.subject_kind == "device" and meta.source == "local"` 时视为手机本机直接操作（`is_local_device = True`）。
   - 非手机本机尝试在新建/更新时改变 `cloud_locked` 为 `True`（或把已有的 `True` 改为 `False`）→ 抛 `403 PERMISSION_DENIED`；
   - 非手机本机尝试修改、切换指派对象、切换开闭或删除一条已处于 `cloud_locked == True` 的闹钟（或关联该闹钟的 `Todo` / `Event`）→ 抛 `409 CLOUD_LOCKED`。
2. **Agent 越权防绕过**：
   - 当 `principal.subject_kind == "agent"` 调用 `todo.set` / `todo.toggle` / `todo.cancel` 时：除 `todo.write` 外，若新或旧 `assignee == "@me"` 必须同时持有 `alarm.write`；若新或旧 `assignee` 为 `@agent_x` 必须同时持有 `agent_alarm.write`！
   - 当 `agent` 调用 `event.set` / `event.cancel` 且新或旧 `reminder_policy == "alarm"` 时，除 `event.write` 外必须同时持有 `alarm.write`。

#### 3.3 实现 `todo.set` 单事务状态转换矩阵（`calendar_domain/service.py`）
在同一个 `user_write_tx` 事务中严格按旧 `assignee` → 新 `assignee` 转换：
- **`none → none`**：仅写 `todos`；
- **`none → @me`**：创建 `alarms(origin_kind='todo')`，回填 `linked_alarm_id`，`is_recurring = (schedule_kind != 'once')`；
- **`none → @agent_x`**：校验 `agent_bindings` 存在且 `active`，创建 `schedules(origin_kind='todo', prompt=text)`，回填 `linked_schedule_id`，`is_recurring = (schedule_kind != 'once')`；
- **`@me → @me`**：校验 `cloud_locked` 后原地更新该 `alarms` 行（`revision + 1`）；
- **`@agent_x → @agent_y`**：原地更新该 `schedules` 行并重算 `next_fire_at`（若此前待发的 `PENDING deliveries` 时间已变则置 `'CANCELLED'`）；
- **`@me → @agent_x`**：校验原闹钟未锁 → 软删除原 `alarms`（`deleted_at = now, enabled = FALSE`）→ 新建 `schedules` → 更新 `todos` 外键；
- **`@agent_x → @me`**：软删除原 `schedules`（并将未发 `PENDING deliveries` 置 `'CANCELLED'`）→ 新建 `alarms` → 更新 `todos` 外键；
- **`@me / @agent_x → none`**：校验原闹钟未锁 → 软删除原关联 `alarms` 或 `schedules`（及 `PENDING deliveries`）→ 清空 `todos` 外键并置 `is_recurring = FALSE`。

#### 3.4 实现 `todo.toggle`、`event.*` 展开与强提醒联动
1. **`todo.toggle`**：
   - `is_recurring == False`（单次项）：翻转 `todos.done`；变为 `True` 时将关联单次 `alarm / schedule` 置 `enabled = FALSE`（及 `PENDING` 投递置 `'CANCELLED'`）；从 `True` 翻回 `False` 时，仅当关联触发时间仍在 `ctx.clock()` 未来时恢复 `enabled = TRUE`（已过去的时间保持 `enabled = FALSE`，绝不补响）。
   - `is_recurring == True`（周期循环项）：保持 `todos.done = False`，翻转关联 `alarms.enabled` 或 `schedules.enabled`（重新开启 `cron` 时按 `ctx.clock()` 重算 `next_fire_at` 并清零 `skip_next`）。
2. **`event.set` 提前强提醒计算**：
   - 计算触发本地时间 `dt = datetime.combine(event_date, start_time) - timedelta(minutes=reminder_offset_minutes)`：
     - `repeat_rule == 'none'` → `schedule_kind = 'once', once_date = dt.date(), time_hhmm = dt.strftime('%H:%M')`；
     - `repeat_rule == 'daily'` → `schedule_kind = 'daily', time_hhmm = dt.strftime('%H:%M')`；
     - `repeat_rule == 'weekly'` → `schedule_kind = 'weekly', weekly_dow = dt.date().weekday(), time_hhmm = dt.strftime('%H:%M')`（自动处理跨午夜前推一天的情况）；
     - `repeat_rule == 'weekdays'` → 校验 `start_minutes >= reminder_offset_minutes`（不允许跨午夜变成周日到周四，超界抛 `422 VALIDATION_ERROR`），`schedule_kind = 'weekdays'`。
3. **`event.list(start_date, end_date)` 展开与冲突标记**：
   - 限制 `(end_date - start_date).days` 在 `0..62` 之间；
   - 查询单次命中行与 `event_date <= end_date` 的周期行，在内存按日期展开为具体当日实例（带 `occurrence_date`），对同一 `occurrence_date` 内满足 `a.start_hhmm < b.end_hhmm and b.start_hhmm < a.end_hhmm` 的实例标 `has_conflict = True`。

#### 3.5 Step 3 关键请求/响应完整 JSON 示例

**示例 1：`POST /v1/rpc/todo.set`（新建周期 `@me` 闹钟并加本机锁）**
```json
{
  "meta": {
    "request_id": "req_todo_001",
    "source": "local"
  },
  "params": {
    "todo_id": null,
    "base_revision": null,
    "text": "早起晨间洗漱与出发准备",
    "assignee": "@me",
    "when": {
      "time_hhmm": "07:30",
      "schedule_kind": "weekdays",
      "once_date": null,
      "weekly_dow": null,
      "timezone": "Asia/Shanghai",
      "ttl_seconds": 900,
      "missed_policy": "skip",
      "cloud_locked": true,
      "skip_next": false
    }
  }
}
```

**示例 2：`POST /v1/rpc/todo.list` 返回结构**
```json
{
  "data": {
    "todos": [
      {
        "todo_id": "tdo_a1b2c3d4e5f6a1b2c3d4e5f6",
        "text": "整理本周日程与进展，生成复盘摘要",
        "assignee": "@work-agent",
        "is_recurring": true,
        "done": false,
        "revision": 1,
        "updated_at": "2026-11-23T08:00:00Z",
        "alarm": null,
        "schedule": {
          "schedule_id": "sch_112233445566112233445566",
          "mode": "cron",
          "run_at": null,
          "cron_expr": "0 16 * * 5",
          "timezone": "Asia/Shanghai",
          "enabled": true,
          "skip_next": false,
          "next_fire_at": "2026-11-27T08:00:00Z",
          "last_delivery_status": "COMPLETED",
          "last_receipt_summary": "已生成 4 条要点并写入周报会话"
        }
      }
    ]
  },
  "correlation_id": "cor_..."
}
```

### Step 3 完成门禁（DoD）
`uv run pytest tests/test_step3_calendar_domain.py -v` 全绿 + `bits style check cloud` 0 违规。必测：① `todo.set` 全 8 种指派切换无残留闹钟或待发计划；② `todo.toggle` 区分单次完成与周期启停；③ `cloud_locked` 阻断一切 Web/Agent 直接或借道 Todo/Event 的修改删除；④ Agent 缺 `alarm.write` 无法通过 `todo.set` 建 `@me` 闹钟；⑤ 周期日程按月展开与冲突检测准确。

---

## Step 4：6 位配对码、有序 `operations` 流与 WebSocket `Link` 双向同步

### Step 4 任务分解

#### 4.1 数据库迁移 `migrations/0004_devices_pairing_and_sync.sql`
```sql
CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'web')),
    grant_id TEXT NOT NULL REFERENCES grants(grant_id),
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pairing_codes (
    code_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    claimed_by_device_id TEXT NULL REFERENCES devices(device_id),
    claimed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_active ON pairing_codes (expires_at) WHERE claimed_at IS NULL;

CREATE TABLE links (
    link_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL UNIQUE REFERENCES devices(device_id) ON DELETE CASCADE,
    last_acked_seq BIGINT NOT NULL DEFAULT 0,
    last_connected_at TIMESTAMPTZ NULL,
    last_disconnected_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE operations (
    server_seq BIGSERIAL PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('alarm', 'event', 'todo')),
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
    entity_revision BIGINT NOT NULL,
    target_device_id TEXT NULL,
    status TEXT NOT NULL DEFAULT 'ACCEPTED'
        CHECK (status IN ('ACCEPTED', 'OFFLINE_QUEUED', 'DELIVERED', 'APPLIED', 'EXECUTED', 'FAILED', 'MISSED')),
    payload JSONB NOT NULL,
    source TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_operations_user_seq ON operations (user_id, server_seq ASC);

CREATE TABLE receipts (
    receipt_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    reported_status TEXT NOT NULL CHECK (reported_status IN ('DELIVERED', 'APPLIED', 'EXECUTED', 'FAILED', 'MISSED')),
    detail TEXT NULL,
    reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (operation_id, device_id, reported_status)
);
```

#### 4.2 实现双层防爆破 6 位配对码与设备管理（`pairing_service.py`）
1. **双层内存滑动窗口限流器（防外部扫描器恶意废码）**：
   - 默认读取 `request.client.host` 作为客户端 IP（仅当 `POCKET_TRUST_PROXY_HEADERS == "1"` 时取 `X-Forwarded-For` 首段）；
   - 单 IP 限制 `<= 5 次 / 60s`，全局所有 IP 合计限制 `<= 20 次 / 60s`；超限直接返回 `429 RATE_LIMITED`，**不增加配对码的 `failed_attempts`**。
2. **`pairing.create`**（写，`pairing.manage`）：将用户名下未核销旧码置过期，生成 6 位数字码 `pairing_code`（存 `hash_token(code)`，`expires_at = now + 5m`），返回 `{"code_id", "pairing_code", "expires_at"}`。
3. **`pairing.claim`**（公开免 Bearer）：
   - 入参：`{"pairing_code": "482910", "device_name": "OnePlus 13", "platform": "android" | "web"}`；
   - 在独立短事务中 `SELECT * FROM pairing_codes WHERE claimed_at IS NULL AND expires_at > $now AND failed_attempts < 10 FOR UPDATE`：
     - 未找到活跃码 → 返回 `400 PAIRING_INVALID`；
     - 哈希不匹配 → `UPDATE pairing_codes SET failed_attempts = failed_attempts + 1` **并提交事务**后抛错（若自增后 `>= 10` 抛 `429 RATE_LIMITED`，否则抛 `400 PAIRING_INVALID`）；
     - 匹配 → 同事务插入 `grants(subject_kind='device', actions=['*'])`、`devices`、`links`，标记 `claimed_at = $now`，返回 `{"user_id", "device_id", "link_id", "device_token"}`。
4. **`device.list` / `device.status` / `device.revoke`**：`revoke` 在同事务吊销 `devices` 与 `grants` 后，立即调用 `link_hub.disconnect_device(device_id, code=4003)` 踢下线。

#### 4.3 实现 `operations` 写入、`PG LISTEN/NOTIFY` 与状态机推进
1. **`append_operation`（在 `user_write_tx` 内调用）**：
   - 改造 `alarm.*`、`event.*`、`todo.*` 写服务及 Worker/Callback 的 Todo 回执更新：每次业务表写入后，在同一事务内 `INSERT INTO operations (...) RETURNING server_seq, *`，并执行：
     ```sql
     SELECT pg_notify('pocket_ops', $1 || ':' || $2::text);
     ```
     （参数为 `user_id` 与 `server_seq`）。
   - 若为需真机响铃的 `alarm` 新建/修改操作且当前 `LinkHub` 无在线 Android 设备（且非发起该操作的本机），初始状态设为 `'OFFLINE_QUEUED'`，`alarm.set` 返回 HTTP `202`。
2. **`LinkHub` 跨进程通知监听（`sync_link/hub.py`）**：
   - 启动一条独立的 `autocommit=True` 数据库连接执行 `LISTEN pocket_ops`；收到通知 `<user_id>:<seq>` 后查出该条 `Operation` 分发给本进程内存里该用户所有活跃 WebSocket 连接的 `asyncio.Queue(maxsize=256)`——**无论单进程 `serve` 还是拆成 `api + worker` 双进程均天然实时推送**！
3. **回执单调状态推进与离线锁覆盖**：
   - 优先级：`ACCEPTED (1) < OFFLINE_QUEUED (2) < DELIVERED (3) < APPLIED (4) < EXECUTED / FAILED / MISSED (5，终态)`；低优先级回执绝不倒退高优先级状态。
   - `alarm.resolve_lock_override`（仅限 `device + source="local"`）：以手机本地锁定快照强制更新 `alarms`（`cloud_locked = TRUE, revision = revision + 1`）并写入新 `operations` 广播全端。

#### 4.4 实现 WebSocket `GET /v1/link` 与优雅停机
1. **无损衔接四步握手**：
   - 连上后 5 秒内收首帧 `HELLO { "type": "HELLO", "token": "pkt_...", "device_id": "dev_...", "link_id": "lnk_...", "last_applied_seq": 42 }`（超时关 `4001`；同 `link_id` 旧连接关 `4000`）；
   - **Step A**：先将该连接队列注册进 `LinkHub` 接收实时广播；
   - **Step B**：查询当前最大 `snapshot_seq`，发 `WELCOME { "type": "WELCOME", "connection_id": "con_...", "current_server_seq": snapshot_seq }`；
   - **Step C**：按 `server_seq ASC` 分批补发 `last_applied_seq < server_seq <= snapshot_seq` 的历史操作（若单次闹钟触发时间已早于 `ctx.clock()`，标记 `is_past_due: true` 并将未终态推进为 `MISSED`）；
   - **Step D**：消费实时队列，自动丢弃 `op.server_seq <= sent_seq` 的已发项，其余实时发出 `OP_PUSH`（队列满溢关 `4008` 让客户端重连重同步）。
2. **`lifespan` 优雅停机顺序（`http_api/app.py`）**：
   - 收到退出信号 → ① 置位 `worker_stop_event` 并等待在途 HTTP 投递完成（最长 10s）→ ② 遍历 `LinkHub` 发送 close `1001` 关闭活跃 WebSocket → ③ 关闭出站 `httpx.AsyncClient`、`LISTEN` 连接与 `AsyncConnectionPool`。

#### 4.5 更新仓库 CI（`.github/workflows/test.yml`）
在 `test.yml` 中配置 `postgres:17-alpine` service container，安装 `uv` 与 Python 3.12，依次运行前端契约测试（`npm test && npm run check`）、后端全套真实数据库集成测试（`cd cloud && uv sync --dev && uv run pytest -v`），并与 `bits.yml` 共同把守 `bits style check`。

### Step 4 完成门禁（DoD）
- [ ] 单 IP 连续 6 次调 `pairing.claim` 触发 `429` 限流且不废掉合法配对码；跨 IP 输错满 10 次该码作废；`device.revoke` 1 秒内踢断活跃 WebSocket。
- [ ] 10 协程并发写 `todo / event / alarm` 时，在线 WebSocket 客户端收到的 `server_seq` 连续递增无空洞；模拟断线后带任意中间 `last_applied_seq` 重连补发零丢失、零重复。
- [ ] Worker 完成 `@agent` 投递或收到 `/result` 回调时，在线客户端实时收到关联 `todo` 的 `OP_PUSH` 更新帧。
- [ ] 全仓跑通：`npm test && npm run check`、`cd cloud && uv run pytest -v`、`bits style check . --baseline bits-baseline.json`（**0 violations, 0 unsupported**）。

---

## 附录：四轮审查与迭代修订记录（Review Log）

| 轮次 | 审查视角 | 发现的关键缺陷 / 盲区 | 已落地的修正方案 |
| --- | --- | --- | --- |
| **第 1 轮** | 并发、事务与安全边界 | ① PostgreSQL `BIGSERIAL` 先取号慢提交会导致客户端游标永久漏同步；② 多表交叉修改存在死锁风险；③ `getaddrinfo` 后调 `httpx` 存在 DNS 重绑定 TOCTOU 窗口与 `::ffff:127.0.0.1` 绕过；④ 公网攻击者发 5 个错包即可恶意锁死合法用户的 6 位配对码 | ① 引入 `user_write_tx`（锁 `users` 行），同时根除同用户 `server_seq` 乱序可见、跨表死锁与幂等并发竞态；② 校验 IPv4-mapped IPv6，改用固定已验证公网 IP + `sni_hostname` + 禁重定向；③ 增加单 IP `5次/分钟` 前置限流，不消耗配对码本身容错次数 |
| **第 2 轮** | 跨模块联动与多进程拓扑 | ① `agent_bindings` 软删除后同名重建会撞主键；② 取消计划时在途 `DISPATCHING` 失败后仍会僵尸重试；③ Worker 投递完成或 Agent 回传摘要时，在线客户端收不到实时 Todo 更新，且拆进程模式下内存 `LinkHub` 无法感知 Worker 变更 | ① 明确 `agent_binding.set` 软删除复活与活跃防误覆写规则；② `deliveries` 增加 `'CANCELLED'` 终态与重试前父计划启用守卫；③ 引入轻量 PG `LISTEN/NOTIFY` 桥接 `operations` 写入与 `LinkHub`，并在回执更新时同步推送 `todo` 操作 |
| **第 3 轮** | 普通后端开发零猜测落地性 | ① 直接写 `os.environ` 会触发仓库 `bits-style` 的 `BCS011` 硬错误；② 若指导子类化 `httpcore` 内部池易遇私有接口不兼容；③ 真实睡眠测 30s 租约与 5 次退避会导致测试极慢且不稳定；④ 周期日程在月历区间如何展开未给算法 | ① 明确仅 `cli.py` 一处带 `bits:allow(BCS011)` 读取环境字典注入；② 改用 `httpx` 原生公开参数 `extensions={"sni_hostname": host}`；③ 注入 `ctx.clock()` 参数化全部时间 SQL 实现毫秒级 `FakeClock` 测试；④ 补齐 `pyproject.toml`、`Dockerfile`、周期日程区间展开与全部 23 个方法契约 |
| **第 4 轮** | 全仓一致性与运维收尾 | ① `0002` 迁移草稿中 `deliveries.completed_at` 默认值误写非空；② 反向代理下 `X-Forwarded-For` 伪造可绕过 IP 限流；③ 容器停机时在途投递与活跃 WS 缺少优雅排空顺序 | ① 修正 `completed_at TIMESTAMPTZ NULL`；② 默认不信任转发头（配 `POCKET_TRUST_PROXY_HEADERS` 开关）并加全局 `20次/分钟` 硬上限；③ 规定 `lifespan` 停机排空 Worker → `1001` 关 WS → 关连接池的标准顺序 |
