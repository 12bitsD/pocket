from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4

from psycopg.rows import dict_row

from .agents import ensure_active_agent
from .errors import RpcError
from .sync_log import log_delete, log_upsert
from .todo_cron import (
    TodoFlags,
    TodoSpec,
    build_todo_spec,
    derive_runtime_fields,
    ensure_lock_access,
    is_agent_assignee,
    window_from_row,
)
from .validators import (
    parse_optional_id,
    parse_optional_revision,
    parse_required_id,
    verify_revision,
)

TODO_NOT_FOUND = ("TODO_NOT_FOUND", "Todo not found")

TODO_FIELD_NAMES = (
    "todo_id", "text", "assignee", "schedule_kind", "time_hhmm",
    "once_date", "weekly_dow", "timezone", "done", "enabled",
    "locked", "skip_next", "alarm_status", "next_fire_at",
    "ttl_seconds", "revision", "updated_at",
)
TODO_COLUMNS = ", ".join(TODO_FIELD_NAMES)
TODO_QUALIFIED = ", ".join("t." + col for col in TODO_FIELD_NAMES)

TODO_SNAPSHOT_SELECT = (
    "SELECT "
    + TODO_QUALIFIED
    + ", d.delivery_id, d.status, d.result_summary, d.completed_at "
    + "FROM todos t "
    + "LEFT JOIN LATERAL ("
    + "SELECT delivery_id, status, result_summary, completed_at "
    + "FROM deliveries WHERE todo_id = t.todo_id "
    + "ORDER BY created_at DESC, scheduled_for DESC, delivery_id DESC LIMIT 1"
    + ") d ON t.assignee LIKE '@%%' AND t.assignee <> '@me' "
)


@dataclass(frozen=True)
class TodoWriteEntry:
    todo_id: str
    spec: TodoSpec
    revision: int
    updated_at: datetime


def serialize_todo(row) -> dict:
    return dict(
        todo_id=row[0],
        text=row[1],
        assignee=row[2],
        schedule_kind=row[3],
        time_hhmm=row[4],
        once_date=row[5].isoformat() if row[5] else None,
        weekly_dow=row[6],
        timezone=row[7],
        done=row[8],
        enabled=row[9],
        locked=row[10],
        skip_next=row[11],
        alarm_status=row[12],
        next_fire_at=row[13].isoformat() if row[13] else None,
        ttl_seconds=row[14],
        revision=row[15],
        updated_at=row[16].isoformat(),
        last_delivery_id=row[17],
        last_delivery_status=row[18],
        result_summary=row[19],
        completed_at=row[20].isoformat() if row[20] else None,
    )


async def fetch_todo_snapshot(conn, todo_id: str) -> dict | None:
    cursor = await conn.execute(
        TODO_SNAPSHOT_SELECT + "WHERE t.todo_id = %s AND t.deleted_at IS NULL",
        (todo_id,),
    )
    row = await cursor.fetchone()
    return serialize_todo(row) if row is not None else None


async def sync_todo_snapshot(conn, todo_id: str) -> dict | None:
    snapshot = await fetch_todo_snapshot(conn, todo_id)
    if snapshot is not None:
        await log_upsert(conn, "todo", snapshot)
    return snapshot


async def bump_todo_sync(conn, todo_id: str, now: datetime) -> dict | None:
    cursor = await conn.execute(
        """
        UPDATE todos
        SET revision = revision + 1, updated_at = %s
        WHERE todo_id = %s AND deleted_at IS NULL
        RETURNING todo_id
        """,
        (now, todo_id),
    )
    if await cursor.fetchone() is None:
        return None
    return await sync_todo_snapshot(conn, todo_id)


async def cancel_pending_deliveries(conn, todo_id: str) -> None:
    await conn.execute(
        """
        UPDATE deliveries
        SET status = 'CANCELLED', lease_until = NULL
        WHERE todo_id = %s AND status IN ('PENDING', 'DISPATCHING')
        """,
        (todo_id,),
    )


async def fetch_todo_dict(conn, todo_id: str) -> dict | None:
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            "SELECT " + TODO_COLUMNS + ", deleted_at FROM todos "
            "WHERE todo_id = %s",
            (todo_id,),
        )
        return await cur.fetchone()


async def validate_assignee(conn, assignee) -> str:
    if not isinstance(assignee, str):
        raise RpcError(422, "INVALID_ASSIGNEE", "Invalid todo assignee")
    if assignee in ("none", "@me"):
        return assignee
    await ensure_active_agent(conn, assignee)
    return assignee


def should_cancel_pending(existing: dict, spec: TodoSpec) -> bool:
    if not is_agent_assignee(existing["assignee"]):
        return False
    win = spec.window
    new_key = (
        spec.assignee,
        spec.enabled and not spec.done,
        win.schedule_kind if win else None,
        win.time_hhmm if win else None,
        win.once_date if win else None,
        win.weekly_dow if win else None,
        spec.timezone_name,
    )
    old_key = (
        existing["assignee"],
        existing["enabled"] and not existing["done"],
        existing["schedule_kind"],
        existing["time_hhmm"],
        existing["once_date"],
        existing["weekly_dow"],
        existing["timezone"],
    )
    return new_key != old_key


async def write_todo_row(conn, entry: TodoWriteEntry) -> dict:
    spec = entry.spec
    win = spec.window
    values = (
        entry.todo_id, spec.text, spec.assignee,
        win.schedule_kind if win else None,
        win.time_hhmm if win else None,
        win.once_date if win else None,
        win.weekly_dow if win else None,
        spec.timezone_name, spec.done, spec.enabled, spec.locked,
        spec.skip_next, spec.alarm_status, spec.next_fire_at,
        spec.ttl_seconds, entry.revision, entry.updated_at,
    )
    sql = (
        "INSERT INTO todos ("
        + TODO_COLUMNS
        + ") VALUES ("
        + ", ".join(["%s"] * len(TODO_FIELD_NAMES))
        + ") ON CONFLICT (todo_id) DO UPDATE SET "
        + ", ".join(
            f"{col} = EXCLUDED.{col}"
            for col in TODO_FIELD_NAMES
            if col != "todo_id"
        )
    )
    await conn.execute(sql, values)
    return await fetch_todo_snapshot(conn, entry.todo_id)


def guard_existing_todo(existing: dict, identity, base_rev) -> None:
    verify_revision(
        existing["revision"], existing["deleted_at"], base_rev, TODO_NOT_FOUND
    )
    ensure_lock_access(identity, existing)


async def load_active_todo(conn, identity, params: dict) -> dict:
    todo_id = parse_required_id(params.get("todo_id"), "todo_id")
    base_rev = parse_optional_revision(params.get("base_revision"))
    row = await fetch_todo_dict(conn, todo_id)
    if row is None:
        raise RpcError(404, TODO_NOT_FOUND[0], TODO_NOT_FOUND[1])
    guard_existing_todo(row, identity, base_rev)
    return row


async def set_todo(ctx, conn, identity, params) -> dict:
    raw_id = parse_optional_id(params.get("todo_id"), "todo_id")
    base_rev = parse_optional_revision(params.get("base_revision"))
    existing = await fetch_todo_dict(conn, raw_id) if raw_id else None
    if existing is None and base_rev is not None:
        raise RpcError(409, "REVISION_CONFLICT", "Revision mismatch")
    if existing is not None:
        guard_existing_todo(existing, identity, base_rev)
    await validate_assignee(conn, params.get("assignee", "none"))
    now = ctx.clock()
    spec = build_todo_spec(identity, params, existing, now)
    target_id = raw_id or f"todo_{uuid4().hex}"
    next_rev = (existing["revision"] + 1) if existing is not None else 1
    if existing is not None and should_cancel_pending(existing, spec):
        await cancel_pending_deliveries(conn, target_id)
    entry = TodoWriteEntry(target_id, spec, next_rev, now)
    snapshot = await write_todo_row(conn, entry)
    await log_upsert(conn, "todo", snapshot)
    return snapshot


def flip_todo_flags(row: dict) -> TodoFlags:
    kind = row["schedule_kind"]
    if kind is None or kind == "once":
        new_done = not row["done"]
        if new_done:
            new_enabled = False if kind == "once" else row["enabled"]
            return TodoFlags(row["locked"], True, new_enabled, False)
        return TodoFlags(row["locked"], False, True, row["skip_next"])
    new_enabled = not row["enabled"]
    skip = row["skip_next"] if new_enabled else False
    return TodoFlags(row["locked"], row["done"], new_enabled, skip)


async def toggle_todo(ctx, conn, identity, params) -> dict:
    row = await load_active_todo(conn, identity, params)
    todo_id = row["todo_id"]
    now = ctx.clock()
    window = window_from_row(row)
    flags = flip_todo_flags(row)
    runtime = derive_runtime_fields(row["assignee"], window, flags, now)
    if not (flags.enabled and not flags.done):
        await cancel_pending_deliveries(conn, todo_id)
    await conn.execute(
        """
        UPDATE todos SET
            done = %s, enabled = %s, skip_next = %s,
            alarm_status = %s, next_fire_at = %s,
            revision = %s, updated_at = %s
        WHERE todo_id = %s
        """,
        (
            flags.done,
            flags.enabled,
            runtime.skip_next,
            runtime.alarm_status,
            runtime.next_fire_at,
            row["revision"] + 1,
            now,
            todo_id,
        ),
    )
    return await sync_todo_snapshot(conn, todo_id)


async def delete_todo(ctx, conn, identity, params) -> dict:
    row = await load_active_todo(conn, identity, params)
    todo_id = row["todo_id"]
    now = ctx.clock()
    new_rev = row["revision"] + 1
    await cancel_pending_deliveries(conn, todo_id)
    await conn.execute(
        """
        UPDATE todos SET
            deleted_at = %s, next_fire_at = NULL,
            revision = %s, updated_at = %s
        WHERE todo_id = %s
        """,
        (now, new_rev, now, todo_id),
    )
    await log_delete(conn, "todo", todo_id, new_rev)
    return dict(todo_id=todo_id, deleted=True, revision=new_rev)


async def list_todos(ctx, conn, identity, params) -> dict:
    cursor = await conn.execute(
        TODO_SNAPSHOT_SELECT
        + "WHERE t.deleted_at IS NULL "
        + "ORDER BY t.done ASC, t.updated_at DESC, t.todo_id ASC",
        (),
    )
    rows = await cursor.fetchall()
    return dict(todos=[serialize_todo(row) for row in rows])
