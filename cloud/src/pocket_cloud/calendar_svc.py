from dataclasses import dataclass
from datetime import date, datetime, timedelta
from uuid import uuid4

from .errors import RpcError
from .sync_log import log_delete, log_upsert
from .validators import (
    parse_hhmm,
    parse_int_bounds,
    parse_iso_date,
    parse_optional_id,
    parse_optional_revision,
    parse_required_id,
    require_text,
    verify_revision,
)

REPEAT_RULES = ("none", "daily", "weekdays", "weekly")
REMINDER_POLICIES = ("none", "notify", "alarm")
EVENT_NOT_FOUND = ("EVENT_NOT_FOUND", "Event not found")

EVENT_COLUMNS = (
    "event_id, event_date, start_hhmm, end_hhmm, title, location, "
    "repeat_rule, reminder_policy, reminder_offset_minutes, "
    "alarm_status, source, revision, updated_at"
)


@dataclass(frozen=True)
class EventWriteRow:
    event_id: str
    event_date: date
    start_hhmm: str
    end_hhmm: str
    title: str
    location: str
    repeat_rule: str
    reminder_policy: str
    reminder_offset_minutes: int
    alarm_status: str
    source: str
    revision: int
    updated_at: datetime


def parse_event_options(params: dict) -> tuple[str, str, int]:
    repeat_rule = params.get("repeat_rule", "none")
    if repeat_rule not in REPEAT_RULES:
        raise RpcError(422, "INVALID_REPEAT_RULE", "Unsupported repeat_rule")
    policy = params.get("reminder_policy", "notify")
    if policy not in REMINDER_POLICIES:
        raise RpcError(
            422, "INVALID_REMINDER_POLICY", "Unsupported reminder_policy"
        )
    offset = parse_int_bounds(
        params.get("reminder_offset_minutes", 15),
        (0, 1440),
        ("INVALID_REMINDER_OFFSET", "Offset must be 0..1440 minutes"),
    )
    return repeat_rule, policy, offset


def build_event_write_row(
    params: dict, source: str, target_id: str, meta: tuple[int, datetime]
) -> EventWriteRow:
    start_hhmm = parse_hhmm(params.get("start_hhmm"), "start_hhmm")
    end_hhmm = parse_hhmm(params.get("end_hhmm"), "end_hhmm")
    if start_hhmm >= end_hhmm:
        raise RpcError(
            422, "INVALID_TIME_RANGE", "start_hhmm must precede end_hhmm"
        )
    title = require_text(
        params.get("title"), "INVALID_TITLE", "Event title is required"
    )
    location = params.get("location", "")
    if not isinstance(location, str):
        raise RpcError(422, "INVALID_LOCATION", "location must be text")
    repeat_rule, policy, offset = parse_event_options(params)
    return EventWriteRow(
        event_id=target_id,
        event_date=parse_iso_date(params.get("event_date"), "event_date"),
        start_hhmm=start_hhmm,
        end_hhmm=end_hhmm,
        title=title,
        location=location.strip(),
        repeat_rule=repeat_rule,
        reminder_policy=policy,
        reminder_offset_minutes=offset,
        alarm_status="QUEUED" if policy == "alarm" else "NONE",
        source=source,
        revision=meta[0],
        updated_at=meta[1],
    )


def serialize_event(row, instance_day: date | None = None) -> dict:
    payload = dict(
        event_id=row[0],
        event_date=row[1].isoformat(),
        start_hhmm=row[2],
        end_hhmm=row[3],
        title=row[4],
        location=row[5],
        repeat_rule=row[6],
        reminder_policy=row[7],
        reminder_offset_minutes=row[8],
        alarm_status=row[9],
        source=row[10],
        revision=row[11],
        updated_at=row[12].isoformat(),
    )
    if instance_day is not None:
        payload["instance_date"] = instance_day.isoformat()
    return payload


def matches_repeat_rule(rule: str, anchor: date, candidate: date) -> bool:
    if candidate < anchor:
        return False
    if rule == "none":
        return candidate == anchor
    if rule == "daily":
        return True
    if rule == "weekdays":
        return candidate.weekday() < 5
    return candidate.weekday() == anchor.weekday()


def expand_event_row(row, start_day: date, end_day: date) -> list[dict]:
    anchor, rule = row[1], row[6]
    first_day = max(anchor, start_day)
    span = max(0, (end_day - first_day).days + 1)
    return [
        serialize_event(row, first_day + timedelta(days=offset))
        for offset in range(span)
        if matches_repeat_rule(rule, anchor, first_day + timedelta(days=offset))
    ]


def annotate_conflicts(instances: list[dict]) -> list[dict]:
    ordered = sorted(
        instances,
        key=lambda item: (
            item["instance_date"],
            item["start_hhmm"],
            item["end_hhmm"],
            item["event_id"],
        ),
    )
    cur_day = ""
    max_item = None
    for target in ordered:
        target["has_conflict"] = False
        day = target["instance_date"]
        if day != cur_day:
            cur_day = day
            max_item = target
            continue
        if target["start_hhmm"] < max_item["end_hhmm"]:
            target["has_conflict"] = True
            max_item["has_conflict"] = True
        if target["end_hhmm"] > max_item["end_hhmm"]:
            max_item = target
    return ordered


async def list_events(ctx, conn, identity, params) -> dict:
    start_day = parse_iso_date(params.get("start_date"), "start_date")
    end_day = parse_iso_date(params.get("end_date"), "end_date")
    if end_day < start_day or (end_day - start_day).days > 62:
        raise RpcError(
            422, "INVALID_DATE_RANGE", "Date range must be 0..62 days"
        )
    cursor = await conn.execute(
        "SELECT "
        + EVENT_COLUMNS
        + " FROM events WHERE deleted_at IS NULL AND event_date <= %s"
        + " AND (repeat_rule <> 'none' OR event_date >= %s)"
        + " ORDER BY event_date ASC, start_hhmm ASC, event_id ASC",
        (end_day, start_day),
    )
    rows = await cursor.fetchall()
    instances = []
    for row in rows:
        instances.extend(expand_event_row(row, start_day, end_day))
    return dict(events=annotate_conflicts(instances))


async def write_event_row(conn, entry: EventWriteRow) -> dict:
    values = (
        entry.event_id, entry.event_date, entry.start_hhmm, entry.end_hhmm,
        entry.title, entry.location, entry.repeat_rule, entry.reminder_policy,
        entry.reminder_offset_minutes, entry.alarm_status, entry.source,
        entry.revision, entry.updated_at,
    )
    sql = (
        "INSERT INTO events ("
        + EVENT_COLUMNS
        + ") VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
        + "ON CONFLICT (event_id) DO UPDATE SET "
        + "event_date = EXCLUDED.event_date, start_hhmm = EXCLUDED.start_hhmm, "
        + "end_hhmm = EXCLUDED.end_hhmm, title = EXCLUDED.title, "
        + "location = EXCLUDED.location, repeat_rule = EXCLUDED.repeat_rule, "
        + "reminder_policy = EXCLUDED.reminder_policy, "
        + "reminder_offset_minutes = EXCLUDED.reminder_offset_minutes, "
        + "alarm_status = EXCLUDED.alarm_status, source = EXCLUDED.source, "
        + "revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at "
        + "RETURNING "
        + EVENT_COLUMNS
    )
    cursor = await conn.execute(sql, values)
    return serialize_event(await cursor.fetchone())


async def set_event(ctx, conn, identity, params) -> dict:
    raw_id = parse_optional_id(params.get("event_id"), "event_id")
    base_rev = parse_optional_revision(params.get("base_revision"))
    now = ctx.clock()
    existing = None
    if raw_id is not None:
        cursor = await conn.execute(
            "SELECT revision, deleted_at FROM events WHERE event_id = %s",
            (raw_id,),
        )
        existing = await cursor.fetchone()
    if existing is None:
        if base_rev is not None:
            raise RpcError(409, "REVISION_CONFLICT", "Revision mismatch")
        target_id = raw_id or f"evt_{uuid4().hex}"
        next_rev = 1
    else:
        verify_revision(existing[0], existing[1], base_rev, EVENT_NOT_FOUND)
        target_id = raw_id
        next_rev = existing[0] + 1
    entry = build_event_write_row(
        params, identity.source, target_id, (next_rev, now)
    )
    snapshot = await write_event_row(conn, entry)
    await log_upsert(conn, "event", snapshot)
    return snapshot


async def delete_event(ctx, conn, identity, params) -> dict:
    event_id = parse_required_id(params.get("event_id"), "event_id")
    base_rev = parse_optional_revision(params.get("base_revision"))
    cursor = await conn.execute(
        "SELECT revision, deleted_at FROM events WHERE event_id = %s",
        (event_id,),
    )
    row = await cursor.fetchone()
    if row is None:
        raise RpcError(404, EVENT_NOT_FOUND[0], EVENT_NOT_FOUND[1])
    verify_revision(row[0], row[1], base_rev, EVENT_NOT_FOUND)
    now = ctx.clock()
    new_rev = row[0] + 1
    await conn.execute(
        """
        UPDATE events
        SET deleted_at = %s, revision = %s, updated_at = %s
        WHERE event_id = %s
        """,
        (now, new_rev, now, event_id),
    )
    await log_delete(conn, "event", event_id, new_rev)
    return dict(event_id=event_id, deleted=True, revision=new_rev)
