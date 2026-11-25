from datetime import timedelta

from .agents import list_agents
from .calendar_svc import list_events
from .todo_svc import list_todos
from .tokens import list_tokens

DEFAULT_PAST_DAYS = 7
DEFAULT_FUTURE_DAYS = 45


def has_any_scope(identity, required: str) -> bool:
    return "*" in identity.scopes or required in identity.scopes


def build_event_range_params(ctx, params: dict) -> dict:
    if "start_date" in params or "end_date" in params:
        return dict(
            start_date=params.get("start_date"),
            end_date=params.get("end_date"),
        )
    today = ctx.clock().date()
    start_iso = (today - timedelta(days=DEFAULT_PAST_DAYS)).isoformat()
    end_iso = (today + timedelta(days=DEFAULT_FUTURE_DAYS)).isoformat()
    return dict(start_date=start_iso, end_date=end_iso)


async def read_latest_seq(conn, identity) -> int:
    if "*" not in identity.scopes:
        return 0
    cursor = await conn.execute(
        "SELECT COALESCE(MAX(seq), 0) FROM sync_log"
    )
    row = await cursor.fetchone()
    return int(row[0]) if row is not None else 0


async def bootstrap_snapshot(ctx, conn, identity, params: dict) -> dict:
    latest_seq = await read_latest_seq(conn, identity)
    events = []
    if has_any_scope(identity, "event.read"):
        ev_params = build_event_range_params(ctx, params)
        events = (await list_events(ctx, conn, identity, ev_params))["events"]
    todos = []
    if has_any_scope(identity, "todo.read"):
        todos = (await list_todos(ctx, conn, identity, params))["todos"]
    agents = []
    tokens = []
    if "*" in identity.scopes:
        agents = (await list_agents(ctx, conn, identity, params))["agents"]
        tokens = (await list_tokens(ctx, conn, identity, params))["tokens"]
    return dict(
        identity=dict(
            kind=identity.kind,
            label=identity.label,
            scopes=identity.scopes,
        ),
        latest_seq=latest_seq,
        events=events,
        todos=todos,
        agents=agents,
        tokens=tokens,
    )
