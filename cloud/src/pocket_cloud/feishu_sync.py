"""Server-authoritative Feishu two-way sync engine and RPC entry points."""

from __future__ import annotations

from datetime import datetime, timedelta
import logging
from uuid import uuid4

import httpx

from .calendar_svc import EVENT_COLUMNS, serialize_event
from .errors import RpcError
from .feishu_api import (
    FeishuCalTarget,
    feishu_item_to_pocket,
    list_calendar_events,
    push_feishu_event,
    remove_feishu_event,
)
from .feishu_oauth import (
    PROVIDER_FEISHU,
    configure_feishu,
    create_feishu_auth_url,
    ensure_fresh_user_token,
    exchange_feishu_callback,
    fetch_feishu_binding,
    is_feishu_connected,
    list_integrations,
    unbind_feishu,
)
from .sync_log import log_delete, log_upsert

LOGGER = logging.getLogger("pocket_cloud.feishu")
SYNC_INTERVAL_SECS = 300

__all__ = [
    "complete_feishu_callback",
    "configure_feishu",
    "create_feishu_auth_url",
    "list_integrations",
    "mirror_event_to_feishu",
    "sync_due_external_calendars",
    "sync_feishu_pull",
    "sync_feishu_rpc",
    "unbind_feishu",
]


async def upsert_pulled_event(tx, cal_id: str, mapped: dict, now: datetime):
    ext_id = mapped["external_event_id"]
    cur = await tx.execute(
        "SELECT event_id, revision FROM events "
        "WHERE external_provider = %s AND external_event_id = %s",
        (PROVIDER_FEISHU, ext_id),
    )
    existing = await cur.fetchone()
    ev_id, rev, kind = (
        (f"evt_{uuid4().hex}", 1, "imported")
        if existing is None
        else (existing[0], int(existing[1]) + 1, "updated")
    )
    res = await tx.execute(
        "INSERT INTO events ("
        + EVENT_COLUMNS
        + ", external_provider, external_calendar_id,"
        + " external_event_id, external_etag, deleted_at"
        + ") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL)"
        + " ON CONFLICT (event_id) DO UPDATE SET"
        + " event_date=EXCLUDED.event_date, start_hhmm=EXCLUDED.start_hhmm,"
        + " end_hhmm=EXCLUDED.end_hhmm, title=EXCLUDED.title,"
        + " location=EXCLUDED.location, external_etag=EXCLUDED.external_etag,"
        + " deleted_at=NULL, revision=EXCLUDED.revision,"
        + " updated_at=EXCLUDED.updated_at RETURNING "
        + EVENT_COLUMNS,
        (
            ev_id, mapped["event_date"], mapped["start_hhmm"],
            mapped["end_hhmm"], mapped["title"], mapped["location"],
            "none", "notify", 15, "NONE", PROVIDER_FEISHU, rev, now,
            PROVIDER_FEISHU, cal_id, ext_id, mapped["etag"],
        ),
    )
    await log_upsert(tx, "event", serialize_event(await res.fetchone()))
    return kind


async def prune_removed_events(
    tx, cal_id: str, seen_ids: set[str], now: datetime
) -> int:
    cursor = await tx.execute(
        "SELECT event_id, revision, external_event_id FROM events "
        "WHERE external_provider = %s AND external_calendar_id = %s "
        "AND deleted_at IS NULL",
        (PROVIDER_FEISHU, cal_id),
    )
    deleted = 0
    for ev_id, rev, ext_id in await cursor.fetchall():
        if ext_id not in seen_ids:
            new_rev = int(rev) + 1
            await tx.execute(
                "UPDATE events SET deleted_at=%s, revision=%s, updated_at=%s "
                "WHERE event_id=%s",
                (now, new_rev, now, ev_id),
            )
            await log_delete(tx, "event", ev_id, new_rev)
            deleted += 1
    return deleted


async def sync_feishu_pull(ctx) -> dict:
    async with ctx.pool.connection() as conn:
        row = await fetch_feishu_binding(conn)
    if not is_feishu_connected(row):
        raise RpcError(400, "FEISHU_NOT_CONNECTED", "Feishu is not connected")
    now = ctx.clock()
    target = FeishuCalTarget(
        await ensure_fresh_user_token(ctx, row),
        str(row.get("calendar_id") or "primary"),
    )
    window = (
        int((now - timedelta(days=14)).timestamp()),
        int((now + timedelta(days=60)).timestamp()),
    )
    items = await list_calendar_events(ctx.http_client, target, window)
    stats = dict(imported=0, updated=0, deleted=0)
    seen_ids: set[str] = set()
    async with ctx.write_tx() as tx:
        for item in items:
            mapped = feishu_item_to_pocket(item)
            if mapped is not None:
                seen_ids.add(mapped["external_event_id"])
                kind = await upsert_pulled_event(
                    tx, target.calendar_id, mapped, now
                )
                stats[kind] += 1
        stats["deleted"] = await prune_removed_events(
            tx, target.calendar_id, seen_ids, now
        )
        await tx.execute(
            "UPDATE external_calendar_bindings SET last_synced_at=%s, "
            "last_error='', updated_at=%s WHERE provider=%s",
            (now, now, PROVIDER_FEISHU),
        )
    stats["synced_at"] = now.isoformat()
    return stats


async def sync_feishu_rpc(ctx, identity, params) -> dict:
    _ = (identity, params)
    return await sync_feishu_pull(ctx)


async def complete_feishu_callback(ctx, code: str, state: str) -> dict:
    await exchange_feishu_callback(ctx, code, state)
    return await sync_feishu_pull(ctx)


async def load_mirror_context(ctx, event_id: str):
    async with ctx.pool.connection() as conn:
        binding = await fetch_feishu_binding(conn)
        if not is_feishu_connected(binding):
            return None, None
        cur = await conn.execute(
            "SELECT "
            + EVENT_COLUMNS
            + ", external_event_id FROM events WHERE event_id = %s",
            (event_id,),
        )
        return binding, await cur.fetchone()


async def mirror_event_to_feishu(
    ctx, event_id: str, deleted: bool = False
) -> None:
    binding, ev_row = await load_mirror_context(ctx, event_id)
    if binding is None or ev_row is None:
        return
    ext_id = ev_row[13]
    try:
        target = FeishuCalTarget(
            await ensure_fresh_user_token(ctx, binding),
            str(binding.get("calendar_id") or "primary"),
        )
        if deleted:
            if ext_id:
                await remove_feishu_event(ctx.http_client, target, ext_id)
            return
        new_id = await push_feishu_event(
            ctx.http_client, target, serialize_event(ev_row), ext_id
        )
        if new_id and new_id != ext_id:
            async with ctx.write_tx() as tx:
                await tx.execute(
                    "UPDATE events SET external_provider=%s, "
                    "external_calendar_id=%s, external_event_id=%s "
                    "WHERE event_id=%s",
                    (PROVIDER_FEISHU, target.calendar_id, new_id, event_id),
                )
    except (RpcError, httpx.HTTPError) as exc:
        LOGGER.warning("Feishu event mirror failed for %s: %s", event_id, exc)


async def sync_due_external_calendars(ctx) -> None:
    now = ctx.clock()
    async with ctx.pool.connection() as conn:
        row = await fetch_feishu_binding(conn)
    if not is_feishu_connected(row):
        return
    last = row.get("last_synced_at")
    if last is not None and last > now - timedelta(seconds=SYNC_INTERVAL_SECS):
        return
    try:
        await sync_feishu_pull(ctx)
    except (RpcError, httpx.HTTPError) as exc:
        async with ctx.write_tx() as tx:
            await tx.execute(
                "UPDATE external_calendar_bindings SET last_error=%s, "
                "updated_at=%s WHERE provider=%s",
                (str(exc)[:240], now, PROVIDER_FEISHU),
            )
