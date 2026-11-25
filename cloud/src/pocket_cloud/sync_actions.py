from dataclasses import dataclass, replace
from datetime import datetime

from .auth import ensure_active_token
from .calendar_svc import EVENT_COLUMNS, serialize_event
from .errors import RpcError
from .sync_log import log_upsert
from .todo_cron import ScheduleWindow, compute_next_fire_at, ensure_lock_access
from .todo_svc import set_todo, sync_todo_snapshot
from .validators import parse_required_id

RECEIPT_ENTITIES = ("todo", "event")
RECEIPT_STATUSES = ("EXECUTED", "FAILED", "MISSED")


@dataclass(frozen=True)
class AlarmReceipt:
    entity_type: str
    entity_id: str
    status: str


async def find_past_due_me_todos(
    conn, now: datetime
) -> list[tuple[str, int]]:
    cursor = await conn.execute(
        """
        SELECT todo_id, time_hhmm, once_date, timezone, revision
        FROM todos
        WHERE assignee = '@me'
          AND schedule_kind = 'once'
          AND done = FALSE
          AND enabled = TRUE
          AND alarm_status = 'QUEUED'
          AND deleted_at IS NULL
          AND once_date IS NOT NULL
          AND time_hhmm IS NOT NULL
        """
    )
    rows = await cursor.fetchall()
    due_pairs = []
    for row in rows:
        win = ScheduleWindow("once", row[1], row[2], None, row[3])
        if compute_next_fire_at(win, now) < now:
            due_pairs.append((row[0], row[4]))
    return due_pairs


async def apply_past_due_me_todos(
    ctx, due_pairs: list[tuple[str, int]]
) -> None:
    if not due_pairs:
        return
    todo_ids = [pair[0] for pair in due_pairs]
    revisions = [pair[1] for pair in due_pairs]
    async with ctx.write_tx() as tx:
        tx_now = ctx.clock()
        cursor = await tx.execute(
            """
            UPDATE todos AS t
            SET alarm_status = 'MISSED',
                revision = t.revision + 1,
                updated_at = %s
            FROM unnest(%s::text[], %s::bigint[]) AS due(todo_id, rev)
            WHERE t.todo_id = due.todo_id
              AND t.revision = due.rev
              AND t.alarm_status = 'QUEUED'
              AND t.done = FALSE
              AND t.enabled = TRUE
              AND t.deleted_at IS NULL
            RETURNING t.todo_id
            """,
            (tx_now, todo_ids, revisions),
        )
        updated = await cursor.fetchall()
        for row in updated:
            await sync_todo_snapshot(tx, row[0])


async def expire_past_due_me_todos(ctx) -> None:
    now = ctx.clock()
    async with ctx.pool.connection() as conn:
        due_pairs = await find_past_due_me_todos(conn, now)
    await apply_past_due_me_todos(ctx, due_pairs)


def parse_alarm_receipt(msg: dict) -> AlarmReceipt:
    entity_type = msg.get("entity_type")
    if entity_type not in RECEIPT_ENTITIES:
        raise RpcError(
            422, "INVALID_ENTITY", "entity_type must be todo or event"
        )
    entity_id = parse_required_id(msg.get("entity_id"), "entity_id")
    status = msg.get("status")
    if status not in RECEIPT_STATUSES:
        raise RpcError(
            422, "INVALID_STATUS", "status must be EXECUTED, FAILED, or MISSED"
        )
    return AlarmReceipt(entity_type, entity_id, status)


async def update_todo_alarm(
    tx, identity, receipt: AlarmReceipt, now: datetime
) -> int:
    cursor = await tx.execute(
        """
        SELECT locked, assignee, done, enabled
        FROM todos WHERE todo_id = %s AND deleted_at IS NULL
        """,
        (receipt.entity_id,),
    )
    row = await cursor.fetchone()
    if row is None:
        raise RpcError(404, "NOT_FOUND", "Todo not found")
    ensure_lock_access(identity, dict(locked=row[0]))
    if row[1] != "@me" or row[2] or not row[3]:
        raise RpcError(
            422, "NOT_ALARM_ENTITY", "Todo has no active phone alarm"
        )
    await tx.execute(
        """
        UPDATE todos
        SET alarm_status = %s, revision = revision + 1, updated_at = %s
        WHERE todo_id = %s
        """,
        (receipt.status, now, receipt.entity_id),
    )
    snapshot = await sync_todo_snapshot(tx, receipt.entity_id)
    return snapshot["revision"]


async def update_event_alarm(
    tx, receipt: AlarmReceipt, now: datetime
) -> int:
    cursor = await tx.execute(
        "SELECT reminder_policy FROM events "
        "WHERE event_id = %s AND deleted_at IS NULL",
        (receipt.entity_id,),
    )
    row = await cursor.fetchone()
    if row is None:
        raise RpcError(404, "NOT_FOUND", "Event not found")
    if row[0] != "alarm":
        raise RpcError(422, "NOT_ALARM_ENTITY", "Event has no system alarm")
    sql = (
        "UPDATE events "
        "SET alarm_status = %s, revision = revision + 1, updated_at = %s "
        "WHERE event_id = %s RETURNING "
        + EVENT_COLUMNS
    )
    upd = await tx.execute(sql, (receipt.status, now, receipt.entity_id))
    snapshot = serialize_event(await upd.fetchone())
    await log_upsert(tx, "event", snapshot)
    return snapshot["revision"]


async def apply_alarm_receipt(ctx, identity, msg: dict) -> dict:
    if identity.kind == "web":
        raise RpcError(403, "FORBIDDEN", "Device token required")
    receipt = parse_alarm_receipt(msg)
    async with ctx.write_tx() as tx:
        await ensure_active_token(tx, identity.token_id)
        now = ctx.clock()
        revision = (
            await update_todo_alarm(tx, identity, receipt, now)
            if receipt.entity_type == "todo"
            else await update_event_alarm(tx, receipt, now)
        )
    return dict(
        type="RECEIPT_ACK",
        entity_type=receipt.entity_type,
        entity_id=receipt.entity_id,
        status=receipt.status,
        revision=revision,
    )


async def apply_lock_override(ctx, identity, msg: dict) -> dict:
    if identity.kind != "device":
        raise RpcError(403, "FORBIDDEN", "Device token required")
    raw_todo = msg.get("todo")
    if not isinstance(raw_todo, dict):
        raise RpcError(422, "INVALID_PARAMS", "todo must be an object")
    override_params = dict(raw_todo)
    todo_id = parse_required_id(override_params.get("todo_id"), "todo_id")
    if "locked" in override_params and override_params["locked"] is not True:
        raise RpcError(
            422, "INVALID_PARAMS", "LOCK_OVERRIDE requires locked=true"
        )
    override_params.pop("base_revision", None)
    override_params["locked"] = True
    local_identity = replace(identity, source="local")
    async with ctx.write_tx() as tx:
        await ensure_active_token(tx, identity.token_id)
        await tx.execute(
            """
            UPDATE todos SET deleted_at = NULL
            WHERE todo_id = %s AND deleted_at IS NOT NULL
            """,
            (todo_id,),
        )
        snapshot = await set_todo(ctx, tx, local_identity, override_params)
    return dict(
        type="OVERRIDE_ACK",
        todo_id=snapshot["todo_id"],
        revision=snapshot["revision"],
    )
