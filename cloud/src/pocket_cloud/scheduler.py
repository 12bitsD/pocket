import asyncio
from datetime import datetime, timedelta
import logging
from uuid import uuid4

import httpx
import psycopg
from psycopg.rows import dict_row

from .deliveries import (
    LEASE_SECONDS,
    ClaimedDelivery,
    dispatch_claimed_delivery,
    issue_callback_credentials,
)
from .errors import RpcError
from .feishu_sync import sync_due_external_calendars
from .todo_cron import compute_next_fire_at, window_from_row
from .todo_svc import bump_todo_sync, sync_todo_snapshot
from .todo_trigger import trigger_todo

LOGGER = logging.getLogger("pocket_cloud.scheduler")
__all__ = [
    "claim_due_deliveries",
    "dispatch_due_deliveries",
    "expand_due_todos",
    "run_scheduler_tick",
    "scheduler_loop",
    "trigger_todo",
]


def advance_todo_schedule(
    row: dict, now: datetime
) -> tuple[bool, datetime | None]:
    if row["schedule_kind"] == "once":
        return False, None
    window = window_from_row(row)
    base = max(now, row["next_fire_at"])
    return True, compute_next_fire_at(window, base)


async def insert_due_delivery(
    conn, secret_key: str, row: dict, now: datetime
) -> str:
    delivery_id = "dlv_%s" % uuid4().hex
    _, token_hash, token_cipher = issue_callback_credentials(secret_key)
    scheduled_for = row["next_fire_at"]
    expires_at = scheduled_for + timedelta(seconds=row["ttl_seconds"])
    cursor = await conn.execute(
        """
        INSERT INTO deliveries (
            delivery_id, todo_id, agent_id, scheduled_for, expires_at,
            status, attempt_count, next_attempt_at, callback_token_hash,
            callback_token_ciphertext, created_at
        ) VALUES (%s, %s, %s, %s, %s, 'PENDING', 0, %s, %s, %s, %s)
        ON CONFLICT (todo_id, scheduled_for) DO UPDATE SET
            agent_id = EXCLUDED.agent_id,
            expires_at = EXCLUDED.expires_at,
            status = 'PENDING',
            attempt_count = 0,
            next_attempt_at = EXCLUDED.next_attempt_at,
            lease_until = NULL,
            callback_token_hash = EXCLUDED.callback_token_hash,
            callback_token_ciphertext = EXCLUDED.callback_token_ciphertext,
            created_at = EXCLUDED.created_at
        WHERE deliveries.status = 'CANCELLED'
        RETURNING delivery_id
        """,
        (
            delivery_id,
            row["todo_id"],
            row["assignee"],
            scheduled_for,
            expires_at,
            now,
            token_hash,
            token_cipher,
            now,
        ),
    )
    inserted = await cursor.fetchone()
    return inserted[0] if inserted is not None else ""


async def expand_single_due_todo(
    tx, secret_key: str, row: dict, now: datetime
) -> str:
    enabled, next_fire = advance_todo_schedule(row, now)
    dlv_id = ""
    if not row["skip_next"]:
        dlv_id = await insert_due_delivery(tx, secret_key, row, now)
    await tx.execute(
        """
        UPDATE todos SET
            skip_next = FALSE, enabled = %s,
            next_fire_at = %s, revision = revision + 1, updated_at = %s
        WHERE todo_id = %s
        """,
        (enabled, next_fire, now, row["todo_id"]),
    )
    await sync_todo_snapshot(tx, row["todo_id"])
    return dlv_id


async def expand_due_todos(ctx) -> list[str]:
    now = ctx.clock()
    created_ids = []
    async with ctx.write_tx() as tx:
        async with tx.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT
                    todo_id, assignee, schedule_kind, time_hhmm, once_date,
                    weekly_dow, timezone, skip_next, next_fire_at, ttl_seconds
                FROM todos
                WHERE deleted_at IS NULL
                  AND enabled = TRUE
                  AND done = FALSE
                  AND assignee LIKE '@%%'
                  AND assignee <> '@me'
                  AND next_fire_at IS NOT NULL
                  AND next_fire_at <= %s
                ORDER BY next_fire_at ASC, todo_id ASC
                """,
                (now,),
            )
            rows = await cur.fetchall()
        for row in rows:
            dlv_id = await expand_single_due_todo(
                tx, ctx.settings.secret_key, row, now
            )
            if dlv_id:
                created_ids.append(dlv_id)
    return created_ids


def terminal_claim_status(row: dict, now: datetime) -> str | None:
    paused_recurring = (
        row["schedule_kind"] != "once" and not row["todo_enabled"]
    )
    if row["todo_deleted"] is not None or row["todo_done"] or paused_recurring:
        return "CANCELLED"
    if now >= row["expires_at"]:
        return "EXPIRED"
    if not row["agent_active"]:
        return "FAILED"
    return None


async def claim_single_row(
    tx, row: dict, now: datetime
) -> ClaimedDelivery | None:
    delivery_id = row["delivery_id"]
    terminal = terminal_claim_status(row, now)
    if terminal is not None:
        await tx.execute(
            """
            UPDATE deliveries SET status = %s, lease_until = NULL
            WHERE delivery_id = %s
            """,
            (terminal, delivery_id),
        )
        await bump_todo_sync(tx, row["todo_id"], now)
        return None
    attempt = row["attempt_count"] + 1
    lease_until = now + timedelta(seconds=LEASE_SECONDS)
    await tx.execute(
        """
        UPDATE deliveries
        SET status = 'DISPATCHING', attempt_count = %s, lease_until = %s
        WHERE delivery_id = %s
        """,
        (attempt, lease_until, delivery_id),
    )
    return ClaimedDelivery(
        delivery_id=delivery_id,
        todo_id=row["todo_id"],
        agent_id=row["agent_id"],
        prompt=row["text"],
        scheduled_for=row["scheduled_for"],
        expires_at=row["expires_at"],
        attempt_count=attempt,
        endpoint_url=row["endpoint_url"],
        credential_ciphertext=row["credential_ciphertext"],
        callback_token_ciphertext=row["callback_token_ciphertext"],
    )


async def claim_due_deliveries(ctx) -> list[ClaimedDelivery]:
    now = ctx.clock()
    claimed = []
    async with ctx.write_tx() as tx:
        async with tx.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT
                    d.delivery_id, d.todo_id, d.agent_id, d.scheduled_for,
                    d.expires_at, d.attempt_count,
                    d.callback_token_ciphertext, t.text,
                    t.deleted_at AS todo_deleted,
                    t.schedule_kind,
                    t.enabled AS todo_enabled, t.done AS todo_done,
                    a.endpoint_url, a.credential_ciphertext,
                    a.active AS agent_active
                FROM deliveries d
                JOIN todos t ON t.todo_id = d.todo_id
                JOIN agents a ON a.agent_id = d.agent_id
                WHERE (
                    (d.status = 'PENDING' AND d.next_attempt_at <= %s)
                    OR (
                        d.status = 'DISPATCHING'
                        AND d.lease_until IS NOT NULL
                        AND d.lease_until <= %s
                    )
                )
                ORDER BY d.next_attempt_at ASC, d.delivery_id ASC
                FOR UPDATE OF d SKIP LOCKED
                """,
                (now, now),
            )
            rows = await cur.fetchall()
        for row in rows:
            item = await claim_single_row(tx, row, now)
            if item is not None:
                claimed.append(item)
    return claimed


DISPATCH_CONCURRENCY = 8


async def dispatch_guarded(
    ctx, sem: asyncio.Semaphore, item: ClaimedDelivery
) -> dict:
    async with sem:
        return await dispatch_claimed_delivery(ctx, item)


async def dispatch_due_deliveries(ctx) -> list[dict]:
    claimed = await claim_due_deliveries(ctx)
    if len(claimed) <= 1:
        return [await dispatch_claimed_delivery(ctx, item) for item in claimed]
    sem = asyncio.Semaphore(DISPATCH_CONCURRENCY)
    tasks = [dispatch_guarded(ctx, sem, item) for item in claimed]
    return list(await asyncio.gather(*tasks))


async def run_scheduler_tick(ctx) -> None:
    await expand_due_todos(ctx)
    await dispatch_due_deliveries(ctx)
    await sync_due_external_calendars(ctx)


async def wait_or_stop(stop_event: asyncio.Event, delay: float) -> None:
    stopped = False
    try:
        stopped = await asyncio.wait_for(stop_event.wait(), timeout=delay)
    except TimeoutError:
        stopped = False
    _ = stopped


async def scheduler_loop(ctx, stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            await run_scheduler_tick(ctx)
        except (psycopg.Error, httpx.HTTPError, RpcError, OSError):
            LOGGER.exception("Scheduler loop iteration failed")
        await wait_or_stop(stop_event, ctx.settings.scheduler_interval)
