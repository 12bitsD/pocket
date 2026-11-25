from datetime import date, timedelta
import re

from .agents import AGENT_ID_PATTERN
from .calendar_svc import REMINDER_POLICIES, REPEAT_RULES
from .errors import CliError
from .todo_cron import SCHEDULE_KINDS
from .validators import HHMM_PATTERN

INLINE_ASSIGNEE_RE = re.compile(
    r"(?<!\S)("
    + AGENT_ID_PATTERN.pattern
    + r")\s+("
    + HHMM_PATTERN.pattern
    + r")(?!\S)"
)

CURATED_COLUMNS = (
    (
        "events",
        (
            "event_id",
            "instance_date",
            "start_hhmm",
            "end_hhmm",
            "title",
            "reminder_policy",
            "alarm_status",
            "has_conflict",
        ),
    ),
    (
        "todos",
        (
            "todo_id",
            "assignee",
            "schedule_kind",
            "time_hhmm",
            "done",
            "enabled",
            "locked",
            "alarm_status",
            "last_delivery_status",
            "text",
            "result_summary",
        ),
    ),
)


def add_domain_parsers(groups, json_parent) -> None:
    add_event_parsers(groups, json_parent)
    add_todo_parsers(groups, json_parent)
    trigger = groups.add_parser("trigger", parents=[json_parent])
    trigger.add_argument("todo_id")


def add_event_parsers(groups, json_parent) -> None:
    event = groups.add_parser("event").add_subparsers(
        dest="action", required=True
    )
    list_parser = event.add_parser("list", parents=[json_parent])
    list_parser.add_argument("--from", dest="start_date")
    list_parser.add_argument("--to", dest="end_date")
    add_parser = event.add_parser("add", parents=[json_parent])
    add_parser.add_argument("--date", required=True)
    add_parser.add_argument("--start", required=True)
    add_parser.add_argument("--end", required=True)
    add_parser.add_argument("--title", required=True)
    add_parser.add_argument("--location", default="")
    add_parser.add_argument(
        "--repeat", default="none", choices=list(REPEAT_RULES)
    )
    add_parser.add_argument(
        "--reminder", default="notify", choices=list(REMINDER_POLICIES)
    )
    add_parser.add_argument("--offset", type=int, default=15)
    delete_parser = event.add_parser("delete", parents=[json_parent])
    delete_parser.add_argument("event_id")


def add_todo_parsers(groups, json_parent) -> None:
    todo = groups.add_parser("todo").add_subparsers(
        dest="action", required=True
    )
    todo.add_parser("list", parents=[json_parent])
    add_parser = todo.add_parser("add", parents=[json_parent])
    add_parser.add_argument("text")
    add_parser.add_argument("--schedule", choices=list(SCHEDULE_KINDS))
    add_parser.add_argument("--date")
    add_parser.add_argument("--dow", type=int)
    add_parser.add_argument("--tz", default="Asia/Shanghai")
    toggle_parser = todo.add_parser("toggle", parents=[json_parent])
    toggle_parser.add_argument("todo_id")
    delete_parser = todo.add_parser("delete", parents=[json_parent])
    delete_parser.add_argument("todo_id")


def strip_matched_span(raw_text: str, match) -> str:
    head = raw_text[: match.start()]
    tail = raw_text[match.end() :]
    stripped = (head + " " + tail).strip()
    return re.sub(r"\s+", " ", stripped) or raw_text


def parse_inline_todo(args) -> dict:
    raw_text = args.text.strip()
    match = INLINE_ASSIGNEE_RE.search(raw_text)
    if match is None:
        has_sched_opts = (
            args.schedule is not None
            or args.date is not None
            or args.dow is not None
        )
        if has_sched_opts:
            raise CliError(
                "Schedule options require @me or @agent HH:MM in todo text"
            )
        return dict(text=raw_text, assignee="none", timezone=args.tz)
    default_kind = "weekly" if args.dow is not None else "once"
    params = dict(
        text=strip_matched_span(raw_text, match),
        assignee=match.group(1),
        schedule_kind=args.schedule or default_kind,
        time_hhmm=match.group(2),
        timezone=args.tz,
    )
    if args.date is not None:
        params["once_date"] = args.date
    if args.dow is not None:
        params["weekly_dow"] = args.dow
    return params


def default_end_date(start: str) -> str:
    try:
        return (date.fromisoformat(start) + timedelta(days=7)).isoformat()
    except ValueError:
        return start


async def execute_event(args, rpc, new_request_id) -> dict:
    if args.action == "list":
        start = args.start_date or date.today().isoformat()
        end = args.end_date or default_end_date(start)
        return await rpc.call(
            "event.list", dict(start_date=start, end_date=end)
        )
    if args.action == "delete":
        return await rpc.call(
            "event.delete", dict(event_id=args.event_id), new_request_id()
        )
    params = dict(
        event_date=args.date,
        start_hhmm=args.start,
        end_hhmm=args.end,
        title=args.title,
        location=args.location,
        repeat_rule=args.repeat,
        reminder_policy=args.reminder,
        reminder_offset_minutes=args.offset,
    )
    return await rpc.call("event.set", params, new_request_id())


async def execute_todo(args, rpc, new_request_id) -> dict:
    if args.action == "list":
        return await rpc.call("todo.list", dict())
    if args.action == "toggle":
        return await rpc.call(
            "todo.toggle", dict(todo_id=args.todo_id), new_request_id()
        )
    if args.action == "delete":
        return await rpc.call(
            "todo.delete", dict(todo_id=args.todo_id), new_request_id()
        )
    payload = parse_inline_todo(args)
    return await rpc.call("todo.set", payload, new_request_id())


async def execute_domain(args, rpc, new_request_id) -> dict:
    if args.group == "event":
        return await execute_event(args, rpc, new_request_id)
    if args.group == "todo":
        return await execute_todo(args, rpc, new_request_id)
    return await rpc.call(
        "todo.trigger", dict(todo_id=args.todo_id), new_request_id()
    )


def select_columns(key: str | None, rows: list[dict]) -> list[str]:
    for target_key, cols in CURATED_COLUMNS:
        if key == target_key:
            return [col for col in cols if col in rows[0]]
    return list(rows[0])


def format_table(data) -> str:
    if isinstance(data, dict) and len(data) == 1:
        key, value = next(iter(data.items()))
        if isinstance(value, list):
            if not value:
                return "(empty)"
            if isinstance(value[0], dict):
                return format_rows(value, select_columns(key, value))
    if isinstance(data, dict):
        return "\n".join(
            "%s: %s" % (key, format_cell(val)) for key, val in data.items()
        )
    return format_cell(data)


def format_rows(rows: list[dict], columns: list[str]) -> str:
    values = [
        [format_cell(row.get(column)) for column in columns] for row in rows
    ]
    widths = [
        max(len(column), *(len(row[index]) for row in values))
        for index, column in enumerate(columns)
    ]
    lines = [
        "  ".join(
            column.ljust(widths[index]) for index, column in enumerate(columns)
        ).rstrip()
    ]
    lines.extend(
        "  ".join(
            value.ljust(widths[index]) for index, value in enumerate(row)
        ).rstrip()
        for row in values
    )
    return "\n".join(lines)


def format_cell(value) -> str:
    if isinstance(value, list):
        return ",".join(str(item) for item in value)
    if isinstance(value, dict):
        return " ".join("%s=%s" % (k, format_cell(v)) for k, v in value.items())
    if value is None:
        return "-"
    clean = " ".join(str(value).splitlines())
    return (clean[:45] + "...") if len(clean) > 48 else clean
