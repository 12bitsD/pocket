import asyncio
from contextlib import asynccontextmanager
import json

import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException

from .errors import CliError

SYNC_STATUS_CHOICES = ("EXECUTED", "FAILED", "MISSED")
SYNC_ENTITY_CHOICES = ("todo", "event")
SKIP_REPLAY_SEQ = 1 << 62


def add_sync_parsers(groups, json_parent) -> None:
    sync = groups.add_parser("sync").add_subparsers(
        dest="action", required=True
    )
    watch = sync.add_parser("watch", parents=[json_parent])
    watch.add_argument("--from-seq", dest="from_seq", type=int, default=0)
    watch.add_argument("--limit", type=int, default=None)

    ack = sync.add_parser("ack", parents=[json_parent])
    ack.add_argument("entity_id")
    ack.add_argument(
        "--status", choices=list(SYNC_STATUS_CHOICES), required=True
    )
    ack.add_argument(
        "--entity", choices=list(SYNC_ENTITY_CHOICES), default=None
    )


def build_ws_url(base_url: str) -> str:
    clean = base_url.rstrip("/")
    if clean.startswith("https://"):
        return "wss://" + clean.removeprefix("https://") + "/v1/link"
    if clean.startswith("http://"):
        return "ws://" + clean.removeprefix("http://") + "/v1/link"
    if clean.startswith(("ws://", "wss://")):
        return clean + "/v1/link"
    return "ws://" + clean + "/v1/link"


def infer_entity_type(entity_id: str, explicit: str | None) -> str:
    if explicit is not None:
        return explicit
    if entity_id.startswith("evt_"):
        return "event"
    if entity_id.startswith("todo_"):
        return "todo"
    raise CliError(
        "Cannot infer entity type from id; pass --entity todo or --entity event"
    )


def format_ws_closed(exc: ConnectionClosed) -> str:
    rcvd = getattr(exc, "rcvd", None)
    if rcvd is not None:
        return "WebSocket closed (%s): %s" % (rcvd.code, rcvd.reason)
    return "WebSocket closed: %s" % str(exc)


def format_sync_push_line(frame: dict) -> str:
    if frame["action"] == "delete":
        return "#%d delete %s %s rev=%d" % (
            frame["seq"],
            frame["entity_type"],
            frame["entity_id"],
            frame["revision"],
        )
    payload = frame.get("payload") or dict()
    raw_label = payload.get("title") or payload.get("text") or "-"
    label = " ".join(str(raw_label).splitlines()) or "-"
    alarm = (
        payload.get("alarm_status")
        or payload.get("last_delivery_status")
        or "-"
    )
    return "#%d %s %s %s rev=%d status=%s %s" % (
        frame["seq"],
        frame["action"],
        frame["entity_type"],
        frame["entity_id"],
        frame["revision"],
        alarm,
        label,
    )


async def recv_ws_frame(ws) -> dict:
    raw = None
    err_msg = None
    try:
        raw = await ws.recv()
    except ConnectionClosed as exc:
        err_msg = format_ws_closed(exc)
    except (WebSocketException, OSError) as exc:
        err_msg = "WebSocket error: %s" % str(exc)
    if err_msg is not None:
        raise CliError(err_msg)
    text = raw.decode() if isinstance(raw, bytes) else raw
    frame = json.loads(text)
    if frame.get("type") == "ERROR":
        msg = "%s: %s" % (frame.get("code", "ERROR"), frame.get("message", ""))
        raise CliError(msg)
    return frame


@asynccontextmanager
async def open_sync_ws(target, last_seq: int):
    if not target.token:
        raise CliError("POCKET_TOKEN is required")
    connect_fn = target.ws_connect or websockets.connect
    url = build_ws_url(target.base_url)
    hello = dict(type="HELLO", token=target.token, last_seq=last_seq)
    err_msg = None
    try:
        async with connect_fn(url) as ws:
            await ws.send(json.dumps(hello))
            yield ws
    except ConnectionClosed as exc:
        err_msg = format_ws_closed(exc)
    except TimeoutError:
        err_msg = "WebSocket request timed out"
    except (WebSocketException, OSError) as exc:
        err_msg = "WebSocket connection failed: %s" % str(exc)
    if err_msg is not None:
        raise CliError(err_msg)


async def watch_session(ws, args) -> dict:
    limit = args.limit
    json_mode = getattr(args, "json_output", False)
    frames: list[dict] = []
    latest_seq = args.from_seq
    replayed = 0
    while True:
        frame = await recv_ws_frame(ws)
        frame_type = frame.get("type")
        if frame_type == "HELLO_ACK":
            latest_seq = frame["latest_seq"]
            replayed = frame["replayed"]
            if limit == 0:
                break
        elif frame_type == "SYNC_PUSH" and limit != 0:
            line = (
                json.dumps(frame, ensure_ascii=False)
                if json_mode
                else format_sync_push_line(frame)
            )
            print(line, flush=True)
            frames.append(frame)
            latest_seq = max(latest_seq, frame["seq"])
            if limit is not None and len(frames) >= limit:
                break
    return dict(latest_seq=latest_seq, replayed=replayed, frames=frames)


async def execute_sync_watch(args, target) -> dict:
    if args.from_seq < 0:
        raise CliError("--from-seq must be >= 0")
    if args.limit is not None and args.limit < 0:
        raise CliError("--limit must be >= 0")
    result = None
    async with open_sync_ws(target, args.from_seq) as ws:
        result = await watch_session(ws, args)
    return result


async def execute_sync_ack(args, target) -> dict:
    entity_type = infer_entity_type(args.entity_id, args.entity)
    receipt = dict(
        type="ALARM_RECEIPT",
        entity_type=entity_type,
        entity_id=args.entity_id,
        status=args.status,
    )
    ack_frame = None
    async with asyncio.timeout(10.0):
        async with open_sync_ws(target, SKIP_REPLAY_SEQ) as ws:
            await ws.send(json.dumps(receipt))
            while ack_frame is None:
                frame = await recv_ws_frame(ws)
                if frame.get("type") == "RECEIPT_ACK":
                    ack_frame = frame
    return ack_frame


async def execute_sync(args, target) -> dict:
    if args.action == "watch":
        return await execute_sync_watch(args, target)
    return await execute_sync_ack(args, target)
