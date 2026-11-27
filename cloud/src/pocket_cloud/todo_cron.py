from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

from .errors import RpcError
from .validators import (
    parse_bool_field,
    parse_hhmm,
    parse_int_bounds,
    parse_iso_date,
    require_text,
)

SCHEDULE_KINDS = ("once", "daily", "weekdays", "weekly")


@dataclass(frozen=True)
class ScheduleWindow:
    schedule_kind: str
    time_hhmm: str
    once_date: date | None
    weekly_dow: int | None
    timezone_name: str


@dataclass(frozen=True)
class TodoFlags:
    locked: bool
    done: bool
    enabled: bool
    skip_next: bool


@dataclass(frozen=True)
class TodoRuntime:
    skip_next: bool
    alarm_status: str
    next_fire_at: datetime | None


@dataclass(frozen=True)
class TodoSpec:
    text: str
    assignee: str
    window: ScheduleWindow | None
    timezone_name: str
    done: bool
    enabled: bool
    locked: bool
    skip_next: bool
    alarm_status: str
    next_fire_at: datetime | None
    ttl_seconds: int
    tags: tuple[str, ...] = ()


def is_agent_assignee(assignee: str) -> bool:
    return assignee.startswith("@") and assignee != "@me"


def window_from_row(row: dict) -> ScheduleWindow | None:
    if row["schedule_kind"] is None:
        return None
    return ScheduleWindow(
        row["schedule_kind"],
        row["time_hhmm"],
        row["once_date"],
        row["weekly_dow"],
        row["timezone"],
    )


def is_local_device(identity) -> bool:
    return (
        identity is not None
        and identity.kind == "device"
        and identity.source == "local"
    )


def ensure_lock_access(identity, target: dict | TodoFlags) -> None:
    locked = (
        target.locked
        if isinstance(target, TodoFlags)
        else bool(target.get("locked", False))
    )
    if locked and not is_local_device(identity):
        raise RpcError(409, "CLOUD_LOCKED", "Todo is locked on device")


def parse_zone(timezone_name) -> tuple[str, ZoneInfo]:
    clean = require_text(
        timezone_name, "INVALID_TIMEZONE", "IANA timezone is required"
    )
    try:
        return clean, ZoneInfo(clean)
    except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
        raise RpcError(
            422, "INVALID_TIMEZONE", "Unknown IANA timezone"
        ) from exc


def cron_expr_for(window: ScheduleWindow) -> str:
    hour = int(window.time_hhmm[:2])
    minute = int(window.time_hhmm[3:])
    if window.schedule_kind == "daily":
        suffix = "*"
    elif window.schedule_kind == "weekdays":
        suffix = "1-5"
    else:
        suffix = str(window.weekly_dow)
    return f"{minute} {hour} * * {suffix}"


def compute_next_fire_at(
    window: ScheduleWindow, base_utc: datetime
) -> datetime:
    zone = ZoneInfo(window.timezone_name)
    if window.schedule_kind == "once":
        hour = int(window.time_hhmm[:2])
        minute = int(window.time_hhmm[3:])
        target = window.once_date
        local_dt = datetime(
            target.year, target.month, target.day, hour, minute, tzinfo=zone
        )
        return local_dt.astimezone(timezone.utc)
    local_base = base_utc.astimezone(zone)
    nxt_local = croniter(cron_expr_for(window), local_base).get_next(datetime)
    return nxt_local.astimezone(timezone.utc)


def resolve_once_date(
    params: dict, zone: ZoneInfo, now: datetime, time_hhmm: str
) -> date:
    raw_once = params.get("once_date")
    if raw_once is not None:
        return parse_iso_date(raw_once, "once_date")
    local_now = now.astimezone(zone)
    delta = 0 if local_now.strftime("%H:%M") < time_hhmm else 1
    return local_now.date() + timedelta(days=delta)


def parse_schedule_window(
    params: dict, tz_name: str, zone: ZoneInfo, now: datetime
) -> ScheduleWindow:
    kind = params.get("schedule_kind")
    if kind not in SCHEDULE_KINDS:
        raise RpcError(422, "INVALID_SCHEDULE", "Valid schedule_kind required")
    time_hhmm = parse_hhmm(params.get("time_hhmm"), "time_hhmm")
    once_date = (
        resolve_once_date(params, zone, now, time_hhmm)
        if kind == "once"
        else None
    )
    weekly_dow = (
        parse_int_bounds(
            params.get("weekly_dow"),
            (0, 6),
            ("INVALID_SCHEDULE", "weekly_dow must be 0..6"),
        )
        if kind == "weekly"
        else None
    )
    return ScheduleWindow(kind, time_hhmm, once_date, weekly_dow, tz_name)


def derive_runtime_fields(
    assignee: str,
    window: ScheduleWindow | None,
    flags: TodoFlags,
    now: datetime,
) -> TodoRuntime:
    active_run = flags.enabled and not flags.done
    if window is not None and is_agent_assignee(assignee) and active_run:
        next_fire = compute_next_fire_at(window, now)
    else:
        next_fire = None
    alarm = "QUEUED" if (assignee == "@me" and active_run) else "NONE"
    skip = flags.skip_next if (window is not None and active_run) else False
    return TodoRuntime(skip, alarm, next_fire)


def parse_todo_flags(params: dict, existing: dict | None) -> TodoFlags:
    defaults = dict(
        locked=bool(existing["locked"]) if existing is not None else False,
        done=False,
        enabled=True,
        skip_next=False,
    )
    return TodoFlags(
        locked=parse_bool_field(params, "locked", defaults),
        done=parse_bool_field(params, "done", defaults),
        enabled=parse_bool_field(params, "enabled", defaults),
        skip_next=parse_bool_field(params, "skip_next", defaults),
    )


def clean_single_tag(item) -> str:
    if not isinstance(item, str):
        raise RpcError(422, "INVALID_TAGS", "each tag must be text")
    return item.strip().lstrip("#")[:24]


def parse_todo_tags(params: dict, existing: dict | None) -> tuple[str, ...]:
    if "tags" not in params:
        prev = existing.get("tags") if existing is not None else None
        return tuple(prev or ())
    raw = params.get("tags")
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise RpcError(422, "INVALID_TAGS", "tags must be a list of strings")
    cleaned = []
    for item in raw:
        val = clean_single_tag(item)
        if val and val not in cleaned:
            cleaned.append(val)
    return tuple(cleaned[:8])


def build_todo_spec(
    identity, params: dict, existing: dict | None, now: datetime
) -> TodoSpec:
    flags = parse_todo_flags(params, existing)
    ensure_lock_access(identity, flags)
    text = require_text(
        params.get("text"), "INVALID_TEXT", "Todo text is required"
    )
    assignee = params.get("assignee", "none")
    tz_name, zone = parse_zone(params.get("timezone", "Asia/Shanghai"))
    window = (
        None
        if assignee == "none"
        else parse_schedule_window(params, tz_name, zone, now)
    )
    runtime = derive_runtime_fields(assignee, window, flags, now)
    ttl_seconds = parse_int_bounds(
        params.get("ttl_seconds", 900),
        (60, 86400),
        ("INVALID_TTL", "ttl_seconds must be 60..86400"),
    )
    return TodoSpec(
        text=text,
        assignee=assignee,
        window=window,
        timezone_name=tz_name,
        done=flags.done,
        enabled=flags.enabled,
        locked=flags.locked,
        skip_next=runtime.skip_next,
        alarm_status=runtime.alarm_status,
        next_fire_at=runtime.next_fire_at,
        ttl_seconds=ttl_seconds,
        tags=parse_todo_tags(params, existing),
    )
