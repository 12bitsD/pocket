# Pocket Cloud 后端实施手册（精简定稿版）

状态：**正式定稿，2026-11-23**  
工程目录：`cloud/`（Python 3.12 · FastAPI · PostgreSQL 17 · 单进程运行 HTTP/WS 与后台定时循环）

---

## 一、整体结构与编码规则

### 1.1 目录结构
```text
cloud/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── pyproject.toml
├── migrations/
│   ├── 0001_auth_and_agents.sql
│   ├── 0002_events_todos_deliveries.sql
│   └── 0003_sync_log.sql
├── src/pocket_cloud/
│   ├── cli.py            # 服务启动与调试 CLI 胶水层（同走 HTTP/WS 接口，支持表格与 --json 输出）
│   ├── config.py         # 配置校验（DATABASE_URL / POCKET_BOOTSTRAP_KEY / POCKET_SECRET_KEY）
│   ├── context.py        # AppContext（持有连接池、加密器、在线手机连接表、时钟）
│   ├── crypto.py         # SHA-256 令牌哈希与 AES-256-GCM 密钥加解密
│   ├── db.py             # psycopg 异步连接池、顺序迁移器与串行写事务封装
│   ├── auth.py           # Bearer 鉴权、权限开关检查与 Token 签发
│   ├── pairing.py        # 6 位配对码生成、兑换与失败计数
│   ├── tokens.py         # Token 列表、签发参数校验与吊销
│   ├── agents.py         # 外部 Agent 地址与密钥管理
│   ├── rpc.py            # RPC 分发与 request_id 防重
│   ├── errors.py         # 统一 RPC 错误
│   ├── calendar_svc.py   # 日程（含周期展开与重叠标记）与统一 Todo（含本机锁校验）
│   ├── scheduler.py      # 到期任务扫描、30s 租约发包、退避重试与回调摘要写入
│   ├── sync_ws.py        # 变更日志写入、WebSocket 握手补齐、实时推送与回执更新
│   └── app.py            # FastAPI 路由注册与统一响应封装
└── tests/
    ├── conftest.py
    ├── test_cli.py
    ├── test_step1_auth_agents.py
    ├── test_step2_calendar_scheduler.py
    └── test_step3_sync_ws.py
```

### 1.2 仓库代码规范要点（`bits-style v0.3.5`）
1. 4 空格缩进，普通代码行宽 `<= 80` 列，函数控制流嵌套 `<= 3` 层，圈复杂度 `<= 10`，函数参数 `<= 4` 个（多参数封装为 `dataclass`，使用枚举代替布尔开关参数）。
2. 仅在 `cli.py` 入口使用 `# bits:allow(BCS011): 进程入口读取环境变量` 读取 `dict(os.environ)` 并传入 `load_config(env)`；运行期状态统一挂在 `app.state.ctx`，通过 `Depends` 注入。
3. 所有写操作统一通过 `write_tx(pool)` 执行（事务首句 `SELECT pg_advisory_xact_lock(1)` 串行化单人库写入），天然保证变更序号连续与零死锁。

### 1.3 统一接口约定
- **`GET /healthz`**：探活，返回 `200 {"status": "ok"}`。
- **`POST /v1/rpc/{method}`**：业务操作统一入口。
  - 请求体：`{"request_id": "req_...", "source": "local" | "web" | "agent", "params": {...}}`（读接口可仅传 `{"params": {...}}`）。
  - 成功响应：`{"data": {...}}`（HTTP `200`）。
  - 错误响应：`{"error": {"code": "...", "message": "..."}}`（对应 `400 / 401 / 403 / 404 / 409 / 422 / 429`）。
- **`POST /v1/deliveries/{delivery_id}/result`**：Agent 携带单次 `callback_token` 回传执行摘要。
- **`GET /v1/link`**：手机端实时同步 WebSocket。

### 1.4 调试 CLI 胶水层规范（`pocket-cloud` 命令行）
CLI 既用于启动服务端，也作为调用后端 HTTP / WebSocket 接口的薄客户端胶水层（默认读取 `POCKET_URL` 与 `POCKET_TOKEN`，默认输出对齐表格，加 `--json` 输出原始 JSON），每个开发阶段同步交付对应子命令：

- **服务运行**：`pocket-cloud serve`（启动服务）· `pocket-cloud status`（检查健康与当前身份）
- **Step 1 命令**：
  - `pocket-cloud pair create` / `pocket-cloud pair claim <code> --name <dev>`
  - `pocket-cloud token create --kind agent --label <name> --scopes event.read,todo.write` / `list` / `revoke <id>`
  - `pocket-cloud agent set <@id> --url <https://...> --key <secret>` / `list` / `revoke <@id>`
- **Step 2 命令**：
  - `pocket-cloud event list [--from YYYY-MM-DD --to YYYY-MM-DD]` / `add` / `delete <id>`
  - `pocket-cloud todo list` / `add "<文本，支持 @me 07:30 或 @agent 16:00 快捷解析>"` / `toggle <id>` / `delete <id>`
  - `pocket-cloud trigger <todo_id>`（**调试利器**：无需等时间到点，立即触发一次指定 `@agent` 任务并打印返回码与投递编号）
- **Step 3 命令**：
  - `pocket-cloud sync watch [--from-seq 0]`（在终端实时打印长连接推送流）
  - `pocket-cloud sync ack <todo_or_event_id> --status EXECUTED`（无需真机即可在命令行模拟手机回传响铃状态）

---

## 二、分步开发细则（共 3 步）

---

## Step 1：账号权限、6 位配对码与 Agent 绑定

### 1.1 建表语句 `migrations/0001_auth_and_agents.sql`
```sql
CREATE TABLE tokens (
    token_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'web', 'device', 'agent')),
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT[] NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pairing_codes (
    code_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    claimed_token_id TEXT NULL REFERENCES tokens(token_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY CHECK (agent_id ~ '^@[a-z0-9][a-z0-9_-]{1,30}$' AND agent_id <> '@me'),
    name TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    credential_ciphertext TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency (
    method TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (method, request_id)
);
```

### 1.2 实现要点
1. **启动引导**：同步 `.env` 中的 `POCKET_BOOTSTRAP_KEY` 到 `tokens` 表（`kind='bootstrap'`, `scopes=['*']`）；若更换主密钥则自动将旧记录置 `revoked_at = now()`。
2. **权限范围（`scopes`）**：
   - 本人端（`bootstrap / web / device`）：`['*']`；
   - 外部 Agent（`kind='agent'`）：从 `['event.read', 'event.write', 'todo.read', 'todo.write']` 中按勾选授予。
3. **6 位配对码**：
   - `pairing.create`：将未领旧码置过期，生成 5 分钟有效的 6 位数字码返回；
   - `pairing.claim`（免登录）：校验 6 位码（独立事务累计错误次数，满 8 次作废），成功后签发 `kind='device', scopes=['*']` 的长期设备 `token`。
4. **外部 Agent 绑定**：
   - `agent.set`：校验 `https://` 地址（测试配置允许本地 `http://127.0.0.1`），用 `AESGCM(POCKET_SECRET_KEY)` 加密存储调用密钥（更新时传 `credential=null` 保留原密文）；
   - `agent.list`：返回已配置 Agent 列表（隐藏密钥密文与原文）；
   - `agent.revoke`：置 `active = FALSE`。
5. **令牌管理**：`token.create`（签发受限 Agent 密钥或网页密钥）、`token.list`、`token.revoke`（吊销设备或 Agent 密钥）。

### 1.3 Step 1 验收标准
- `GET /healthz` 正常返回；主密钥可登录，受限 Agent 密钥越权访问管理接口返回 `403`。
- 6 位配对码正常兑换出手机 Token，输错满 8 次自动失效；同一 `request_id` 重复请求只创建一条记录，改参数重发返回 `409`。
- `agent.list` 不泄露密钥原文，`pytest tests/test_step1_auth_agents.py` 与 `bits style check` 全通过。

---

## Step 2：日程、统一 Todo 与定时唤醒 AI

### 2.1 建表语句 `migrations/0002_events_todos_deliveries.sql`
```sql
CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    event_date DATE NOT NULL,
    start_hhmm TEXT NOT NULL CHECK (start_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_hhmm TEXT NOT NULL CHECK (end_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    repeat_rule TEXT NOT NULL DEFAULT 'none' CHECK (repeat_rule IN ('none', 'daily', 'weekdays', 'weekly')),
    reminder_policy TEXT NOT NULL DEFAULT 'notify' CHECK (reminder_policy IN ('none', 'notify', 'alarm')),
    reminder_offset_minutes INTEGER NOT NULL DEFAULT 15 CHECK (reminder_offset_minutes BETWEEN 0 AND 1440),
    alarm_status TEXT NOT NULL DEFAULT 'NONE' CHECK (alarm_status IN ('NONE', 'QUEUED', 'EXECUTED', 'FAILED', 'MISSED')),
    source TEXT NOT NULL DEFAULT 'local',
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_hhmm < end_hhmm)
);

CREATE TABLE todos (
    todo_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    assignee TEXT NOT NULL DEFAULT 'none',
    schedule_kind TEXT NULL CHECK (schedule_kind IN ('once', 'daily', 'weekdays', 'weekly')),
    time_hhmm TEXT NULL CHECK (time_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    once_date DATE NULL,
    weekly_dow SMALLINT NULL CHECK (weekly_dow BETWEEN 0 AND 6),
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    done BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    locked BOOLEAN NOT NULL DEFAULT FALSE,
    skip_next BOOLEAN NOT NULL DEFAULT FALSE,
    alarm_status TEXT NOT NULL DEFAULT 'NONE' CHECK (alarm_status IN ('NONE', 'QUEUED', 'EXECUTED', 'FAILED', 'MISSED')),
    next_fire_at TIMESTAMPTZ NULL,
    ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK (ttl_seconds BETWEEN 60 AND 86400),
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (assignee = 'none' AND schedule_kind IS NULL AND time_hhmm IS NULL) OR
        (assignee <> 'none' AND schedule_kind IS NOT NULL AND time_hhmm IS NOT NULL)
    )
);

CREATE INDEX idx_todos_agent_due
    ON todos (next_fire_at)
    WHERE deleted_at IS NULL AND enabled = TRUE AND assignee LIKE '@%' AND assignee <> '@me';

CREATE TABLE deliveries (
    delivery_id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL REFERENCES todos(todo_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    scheduled_for TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ NULL,
    callback_token_hash TEXT NOT NULL,
    callback_token_ciphertext TEXT NOT NULL,
    result_summary TEXT NULL,
    result_payload JSONB NULL,
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (todo_id, scheduled_for)
);

CREATE INDEX idx_deliveries_claimable
    ON deliveries (next_attempt_at)
    WHERE status IN ('PENDING', 'DISPATCHING');
```

### 2.2 日程与统一 Todo 接口（6 个核心方法）
1. **`event.list`**（`event.read`）：入参 `{start_date, end_date}`（最多 62 天），展开单次与周期日程实例，按日计算 `has_conflict: true/false`。
2. **`event.set`**（`event.write`）：新建或按 `base_revision` 更新日程；选 `reminder_policy='alarm'` 时初始 `alarm_status='QUEUED'` 等待手机同步写入系统闹钟。
3. **`event.delete`**（`event.write`）：按 `base_revision` 软删除日程。
4. **`todo.list`**（`todo.read`）：返回所有未删 Todo，并附带 `@agent` 条目最近一次 `deliveries` 的 `status` 与 `result_summary`。
5. **`todo.set`**（`todo.write`）：
   - 统一保存 `none`（仅待办）、`@me`（手机响铃，置 `alarm_status='QUEUED'`）或 `@agent_id`（用 `croniter + ZoneInfo` 算出 `next_fire_at`）；
   - **本机锁校验**：仅 `kind='device'` 且 `source='local'` 的请求可开启/关闭 `locked` 或修改已锁定的 Todo；网页与 Agent 修改已锁定条目直接返回 `409 CLOUD_LOCKED`；
   - 若修改时间或将 `@agent` 切换为其他对象，自动将该条 Todo 下尚未发出的 `PENDING` 投递置为 `CANCELLED`。
6. **`todo.toggle` & `todo.delete`**（`todo.write`）：
   - 单次事项切换 `done`（完成时停用未触发提醒）；周期事项切换 `enabled` 开关（重开时重算 `next_fire_at`）；删除时软删除 Todo 并取消待发投递（同样受 `locked` 保护）。

### 2.3 后台定时唤醒与结果回传（`scheduler.py`）
1. **到期展开**：每秒扫描 `next_fire_at <= now` 的 `@agent` Todo：
   - 若 `skip_next = TRUE`：跳过本次，重置 `skip_next = FALSE` 并推进下一次 `next_fire_at`；
   - 否则生成一条 `PENDING` 的 `deliveries`（签发一次性 `cbk_` 回调密钥），单次事项置 `enabled=FALSE, next_fire_at=NULL`，周期事项推进下一次 `next_fire_at`。
2. **30 秒租约发包与重试**：
   - 短事务用 `FOR UPDATE SKIP LOCKED` 抢占到期 `deliveries` 标为 `DISPATCHING`（写 30 秒 `lease_until`）后立即释放连接；
   - 事务外用 `httpx`（`follow_redirects=False`，超时 10s）向 `{endpoint_url}/webhooks/pocket` 发送 Prompt 与 `result_callback_url`、`callback_token`；
   - 收到 `202 / 200` 标为 `COMPLETED`；网络或 5xx 错误按 `(5s, 15s, 45s, 120s, 300s)` 退避重试（复用同一 `delivery_id`），超过 `expires_at` 标为 `EXPIRED`。
3. **回写结果摘要**：`POST /v1/deliveries/{delivery_id}/result` 校验 `callback_token` 后直接更新 `deliveries.result_summary` 与 `result_payload`。

### 2.4 Step 2 验收标准
- 日程区间展开与时间重叠标记准确；Todo 在 `仅待办 / @me / @agent` 间任意切换与开关正常；本机锁成功拦截非本机修改。
- 本地真实 HTTP Mock Agent 跑通：到点自动收到 POST 返回 `202`、模拟 `503` 重试复用同一 `delivery_id`、回调摘要写回后 `todo.list` 立即可见。

---

## Step 3：手机实时同步与响铃回执闭环

### 3.1 建表语句 `migrations/0003_sync_log.sql`
```sql
CREATE TABLE sync_log (
    seq BIGSERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('event', 'todo')),
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
    revision BIGINT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.2 实现要点（`sync_ws.py`）
1. **同事务记录变更**：每次 `event.*`、`todo.*` 修改数据或 Agent 回写摘要更新 Todo 视图时，在同一事务内向 `sync_log` 追加一行最新快照，并在提交后推送给内存连接表中的在线客户端。
2. **WebSocket `GET /v1/link` 流程**：
   - **握手补齐**：客户端连上发 `HELLO {token, last_seq}` → 服务端先挂入实时队列，查出 `seq > last_seq` 的所有历史 `sync_log` 顺序补发（已过期的单次 `@me` 提醒自动置为 `MISSED`），随后切换为实时推送 `SYNC_PUSH`。
   - **手机响铃回执**：手机原生层设好或触发系统闹钟后发 `ALARM_RECEIPT {entity_type, entity_id, status: 'EXECUTED' | 'FAILED' | 'MISSED'}` → 服务端更新对应 `todos.alarm_status` 或 `events.alarm_status` 并同步给网页端。
   - **离线本机锁覆盖**：若手机离线期间给某条 Todo 开启了 `locked`，重连发 `LOCK_OVERRIDE` 时以手机本地锁定内容为准更新快照并生成新 `seq` 对齐全端。
   - **踢下线**：调用 `token.revoke` 吊销某台手机凭证时，立即断开其活跃 WebSocket 连接。
3. **接入自动测试**：在 `.github/workflows/test.yml` 加入 PostgreSQL 服务容器，自动运行 `npm test && npm run check`、`uv run pytest` 与 `bits style check`。

### 3.3 Step 3 验收标准
- 手机离线期间网页新建 `@me` Todo 显示 `QUEUED`；手机连上 `/v1/link` 自动补齐并回传 `EXECUTED` 后，网页端状态实时变为 `EXECUTED`。
- 吊销手机 Token 立即断开连接；全仓前端测试、后端真实 PostgreSQL 测试与 `bits style check` 全部零错误通过。
