# Pocket Cloud

Self-hosted backend shared by **Pocket Calendar** and **Pocket Notes**.

- **Stack**: Python 3.12 · FastAPI · PostgreSQL 17 (`psycopg` v3 + migrations)
- **Step 1**: bootstrap authentication, 6-digit device pairing, scoped tokens,
  encrypted external Agent configuration, idempotent RPC, and HTTP-based CLI
- **Step 2**: calendar events with recurrence/conflict detection, unified Todos
  (`none`, `@me`, `@agent`), device-only `locked` protection, and background
  scheduler with 30s lease retry and single-use Agent result callbacks
- **Step 3**: ordered `sync_log`, zero-gap WebSocket `/v1/link` catch-up and
  live `SYNC_PUSH`, `@me` alarm receipts (`EXECUTED` / `FAILED` / `MISSED`),
  device `LOCK_OVERRIDE`, instant token revocation kick, and sync CLI
- **Performance & Mobile Battery**: single-RTT `sync.bootstrap` cold-start
  snapshot (`*`, `event.read`, `todo.read`), single-checkout DB authentication
  reuse, partial/covering PostgreSQL indexes (`0004_performance_indexes.sql`),
  `GZipMiddleware` response compression, and bounded concurrent (`Semaphore(8)`)
  outbound `@agent` webhook dispatch

## Configuration

Copy `.env.example` to `.env` and replace every placeholder before starting.
`POCKET_SECRET_KEY` must be base64-encoded 32-byte key material. Generate the
required values locally with your preferred secret generator; do not commit
`.env`.

`POCKET_ALLOW_HTTP_LOOPBACK` defaults to `false`. Set it to `true` only in a
local test environment that needs an `http://127.0.0.1` Agent endpoint.

## Run

From the repository root:

```sh
cp cloud/.env.example cloud/.env
docker compose -f cloud/docker-compose.yml up -d --build
curl http://127.0.0.1:8787/healthz
```

The service applies ordered SQL migrations and synchronizes the bootstrap token
at startup. Changing `POCKET_BOOTSTRAP_KEY` revokes the previous bootstrap key.

## CLI

The CLI (`pocket`, also installed as `pocket-cloud`) calls the same HTTP RPC and
WebSocket `/v1/link` APIs as web and mobile clients. Inside the container,
`POCKET_URL` defaults to the local service; use the bootstrap key or a paired
device token for personal commands:

```sh
docker compose -f cloud/docker-compose.yml exec pocket-cloud sh -c '
  export POCKET_TOKEN="$POCKET_BOOTSTRAP_KEY"
  pocket status
  pocket pair create
  pocket token create --kind agent --label reader \
    --scopes event.read,todo.read
  pocket agent set @work-agent \
    --url https://agent.example.com --key replace-with-agent-secret
  pocket agent list

  # Step 2: events, unified todos, and immediate @agent trigger
  pocket event add --date 2026-11-24 --start 09:00 --end 10:00 \
    --title "Design Review" --repeat weekdays --reminder alarm
  pocket event list --from 2026-11-24 --to 2026-11-30
  pocket todo add "Wake up @me 07:30" --date 2026-11-25
  pocket todo add "Daily digest @work-agent 16:00" --schedule daily
  pocket todo list
  pocket trigger <todo_id>

  # Step 3: WebSocket sync stream and alarm receipt ack
  # --status: EXECUTED | FAILED | MISSED (pass --entity todo|event for custom IDs)
  pocket sync watch --from-seq 0 --limit 5
  pocket sync ack <todo_or_event_id> --status EXECUTED
'
```

Claim a pairing code without a management token:

```sh
docker compose -f cloud/docker-compose.yml exec pocket-cloud \
  pocket pair claim 123456 --name "My phone"
```

Replace `123456` with the code returned by `pair create`. Add `--json` to any
client command for machine-readable output (`sync watch --json` streams one
JSON line per `SYNC_PUSH` frame; `--limit 0` exits after `HELLO_ACK`). Token
plaintext is returned only when created or claimed; store it in a secret
manager.

## Tests

Tests require a **disposable PostgreSQL 17 database** and run API, WebSocket,
and CLI checks against real database and server calls. With Docker, start an
isolated database on port `55432`:

```sh
docker run -d --name pocket-cloud-test \
  -e POSTGRES_USER=pocket \
  -e POSTGRES_PASSWORD=pocket \
  -e POSTGRES_DB=pocket_test \
  -p 55432:5432 postgres:17-alpine

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e UV_PROJECT_ENVIRONMENT=/tmp/pocket-venv \
  -v "$PWD/cloud:/app" -w /app \
  ghcr.io/astral-sh/uv:python3.12-bookworm-slim \
  uv run --frozen pytest -q
```

Use `--database-url` after `pytest` to override the default disposable database
URL. Never point the tests at a production database: fixtures delete test
records. Remove the test container after the run with
`docker rm -f pocket-cloud-test`.

Detailed protocol and schema rules live in
[`../docs/cloud/architecture.md`](../docs/cloud/architecture.md), and the
step-by-step backend engineering blueprint lives in
[`../docs/cloud/implementation-plan.md`](../docs/cloud/implementation-plan.md).
