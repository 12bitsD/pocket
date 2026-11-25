from datetime import datetime, timedelta
from uuid import uuid4

from psycopg.rows import dict_row

from .agents import ensure_active_agent
from .deliveries import (
    LEASE_SECONDS,
    ClaimedDelivery,
    dispatch_claimed_delivery,
    issue_callback_credentials,
)
from .errors import RpcError
from .todo_cron import ensure_lock_access, is_agent_assignee
from .validators import parse_required_id


async def next_unique_schedule(
    conn, todo_id: str, now: datetime, planned: datetime | None
) -> datetime:
    cursor = await conn.execute(
        "SELECT MAX(scheduled_for) FROM deliveries WHERE todo_id = %s",
        (todo_id,),
    )
    max_sched = (await cursor.fetchone())[0]
    candidate = (
        max_sched + timedelta(microseconds=1)
        if (max_sched is not None and max_sched >= now)
        else now
    )
    if planned is not None and candidate == planned:
        return candidate + timedelta(microseconds=1)
    return candidate


async def load_trigger_target(
    conn, identity, todo_id: str
) -> tuple[dict, tuple[str, str]]:
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            """
            SELECT todo_id, text, assignee, ttl_seconds, locked, next_fire_at
            FROM todos WHERE todo_id = %s AND deleted_at IS NULL
            """,
            (todo_id,),
        )
        todo = await cur.fetchone()
    if todo is None:
        raise RpcError(404, "TODO_NOT_FOUND", "Todo not found")
    ensure_lock_access(identity, todo)
    if not is_agent_assignee(todo["assignee"]):
        raise RpcError(422, "NOT_AGENT_TODO", "Todo has no external Agent")
    agent_pair = await ensure_active_agent(conn, todo["assignee"])
    return todo, agent_pair


async def create_manual_claim(ctx, identity, todo_id: str) -> ClaimedDelivery:
    now = ctx.clock()
    async with ctx.write_tx() as tx:
        todo, agent_pair = await load_trigger_target(tx, identity, todo_id)
        scheduled = await next_unique_schedule(
            tx, todo_id, now, todo["next_fire_at"]
        )
        expires = scheduled + timedelta(seconds=todo["ttl_seconds"])
        lease_until = now + timedelta(seconds=LEASE_SECONDS)
        delivery_id = "dlv_%s" % uuid4().hex
        _, tok_hash, tok_cipher = issue_callback_credentials(
            ctx.settings.secret_key
        )
        await tx.execute(
            """
            INSERT INTO deliveries (
                delivery_id, todo_id, agent_id, scheduled_for, expires_at,
                status, attempt_count, next_attempt_at, lease_until,
                callback_token_hash, callback_token_ciphertext, created_at
            ) VALUES (%s, %s, %s, %s, %s, 'DISPATCHING', 1, %s, %s, %s, %s, %s)
            """,
            (
                delivery_id,
                todo_id,
                todo["assignee"],
                scheduled,
                expires,
                now,
                lease_until,
                tok_hash,
                tok_cipher,
                now,
            ),
        )
        return ClaimedDelivery(
            delivery_id=delivery_id,
            todo_id=todo_id,
            agent_id=todo["assignee"],
            prompt=todo["text"],
            scheduled_for=scheduled,
            expires_at=expires,
            attempt_count=1,
            endpoint_url=agent_pair[0],
            credential_ciphertext=agent_pair[1],
            callback_token_ciphertext=tok_cipher,
        )


async def trigger_todo(ctx, identity, params) -> dict:
    todo_id = parse_required_id(params.get("todo_id"), "todo_id")
    claim = await create_manual_claim(ctx, identity, todo_id)
    return await dispatch_claimed_delivery(ctx, claim)
