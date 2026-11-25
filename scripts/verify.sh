#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STEP="all"
GATE="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --step)
      STEP="$2"
      shift 2
      ;;
    --gate)
      GATE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

PG_CONTAINER="pocket-verify-pg-$$"
APP_CONTAINER="pocket-verify-app-$$"
PG_PORT=$((56000 + (RANDOM % 2000)))
APP_PORT=$((58000 + (RANDOM % 2000)))
SECRET_KEY="AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
BOOTSTRAP_KEY="verify-bootstrap-key-$$"
CAL_VERSION="$(node -p "require('./apps/calendar/package.json').version")"

cleanup() {
  docker rm -f "$APP_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  rm -rf cloud/.venv cloud/.pytest_cache \
    cloud/src/pocket_cloud/__pycache__ \
    cloud/tests/__pycache__ \
    scripts/eval/__pycache__
}
trap cleanup EXIT

start_pg() {
  echo "==> [Gate 2/5] Starting isolated PostgreSQL 17 on port $PG_PORT"
  docker run -d --name "$PG_CONTAINER" \
    --tmpfs /var/lib/postgresql/data:rw,size=256m \
    -e POSTGRES_USER=pocket \
    -e POSTGRES_PASSWORD=pocket \
    -e POSTGRES_DB=pocket_test \
    -p "127.0.0.1:${PG_PORT}:5432" \
    postgres:17-alpine >/dev/null

  for _ in $(seq 1 30); do
    if docker exec "$PG_CONTAINER" \
      pg_isready -U pocket -d pocket_test >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "PostgreSQL failed to become ready" >&2
  exit 1
}

DB_HOST="host.docker.internal:${PG_PORT}"
DB_URL_DOCKER="postgresql://pocket:pocket@${DB_HOST}/pocket_test"
HAS_BUILD_CMD="const p=require('./package.json');"
HAS_BUILD_CMD="${HAS_BUILD_CMD} process.exit(p.scripts.build ? 0 : 1)"

if [[ "$GATE" == "all" || "$GATE" == "unit" ]]; then
  echo "==> [Gate 1/5] Workspace tests & frontend syntax/build checks"
  npm test
  npm run check
  if node -e "$HAS_BUILD_CMD"; then
    npm run build
  fi

  start_pg
  echo "==> [Gate 3/5] Running backend pytest suite against real PostgreSQL 17"
  docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -v "$ROOT_DIR/cloud:/app" \
    -v pocket-uv-cache:/root/.cache/uv \
    -v pocket-uv-venv:/tmp/pocket-venv \
    -e UV_LINK_MODE=copy \
    -e UV_PROJECT_ENVIRONMENT=/tmp/pocket-venv \
    -w /app \
    ghcr.io/astral-sh/uv:python3.12-bookworm-slim \
    uv run --frozen pytest -q --database-url "$DB_URL_DOCKER"
fi

if [[ "$GATE" == "all" || "$GATE" == "e2e" || "$GATE" == "e2e-step" ]]; then
  if [[ ! -f "$ROOT_DIR/apps/calendar/dist/index.html" ]] && \
     node -e "$HAS_BUILD_CMD"; then
    npm run build >/dev/null
  fi
  if [[ "$STEP" == "5" || "$STEP" == "all" ]] && \
     [[ ! -f "$ROOT_DIR/dist/pocket-calendar-${CAL_VERSION}.apk" ]]; then
    echo "==> [Gate 4a/5] Building signed Pocket Calendar Android APK"
    bash "$ROOT_DIR/scripts/build-android-apk.sh" "$CAL_VERSION"
  fi
  if [[ "$GATE" == "e2e" || "$GATE" == "e2e-step" ]]; then
    start_pg
  fi
  ONLY_FLAG=()
  if [[ "$GATE" == "e2e-step" ]]; then
    ONLY_FLAG=(--only)
  fi
  echo "==> [Gate 4/5] Building image & running black-box E2E (step=$STEP)"
  docker build -q -t pocket-cloud:verify -f cloud/Dockerfile . >/dev/null
  docker run -d --name "$APP_CONTAINER" \
    --add-host=host.docker.internal:host-gateway \
    -e DATABASE_URL="$DB_URL_DOCKER" \
    -e POCKET_BOOTSTRAP_KEY="$BOOTSTRAP_KEY" \
    -e POCKET_SECRET_KEY="$SECRET_KEY" \
    -e POCKET_PUBLIC_URL="http://127.0.0.1:8787" \
    -e POCKET_ALLOW_HTTP_LOOPBACK="true" \
    -e POCKET_PORT="8787" \
    -p "127.0.0.1:${APP_PORT}:8787" \
    pocket-cloud:verify >/dev/null

  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done

  docker run --rm \
    --network "container:${APP_CONTAINER}" \
    -v "$ROOT_DIR:/workspace" \
    -v pocket-uv-cache:/root/.cache/uv \
    -v pocket-uv-venv:/tmp/pocket-venv \
    -e UV_LINK_MODE=copy \
    -e UV_PROJECT_ENVIRONMENT=/tmp/pocket-venv \
    -w /workspace/cloud \
    -e PYTHONPATH="/workspace/cloud/src:/workspace/scripts/eval" \
    -e POCKET_HOST_PORT="${APP_PORT}" \
    ghcr.io/astral-sh/uv:python3.12-bookworm-slim \
    uv run --frozen --no-dev python /workspace/scripts/eval/run_evals.py \
      --step "$STEP" \
      ${ONLY_FLAG[@]+"${ONLY_FLAG[@]}"} \
      --base-url "http://127.0.0.1:8787" \
      --database-url "$DB_URL_DOCKER" \
      --bootstrap-key "$BOOTSTRAP_KEY" \
      --secret-key "$SECRET_KEY"

  if [[ -f "$ROOT_DIR/scripts/eval/eval_web.mjs" ]] && \
     [[ "$STEP" == "4" || "$STEP" == "5" || "$STEP" == "all" ]]; then
    echo "==> [Gate 4b/5] Running host Node Web & Perf E2E Evals"
    POCKET_EVAL_URL="http://127.0.0.1:${APP_PORT}" \
    POCKET_EVAL_TOKEN="$BOOTSTRAP_KEY" \
    node "$ROOT_DIR/scripts/eval/eval_web.mjs"
    if [[ -f "$ROOT_DIR/scripts/eval/eval_perf.mjs" ]]; then
      POCKET_EVAL_URL="http://127.0.0.1:${APP_PORT}" \
      POCKET_EVAL_TOKEN="$BOOTSTRAP_KEY" \
      node "$ROOT_DIR/scripts/eval/eval_perf.mjs"
    fi
  fi
fi

cleanup

if [[ "$GATE" == "all" || "$GATE" == "static" ]]; then
  echo "==> [Gate 5/5] Running Bits Style, Redundancy, Design & Hygiene Audit"
  python3 scripts/eval/audit_codebase.py --root "$ROOT_DIR"
fi

echo "ALL VERIFICATION GATES PASSED (step=$STEP, gate=$GATE)"
