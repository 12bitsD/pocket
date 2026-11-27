import asyncio
from dataclasses import dataclass, replace
import json

from fastapi import WebSocketDisconnect

from .app_releases import scan_local_latest
from .auth import authenticate_token
from .errors import RpcError
from .sync_actions import (
    apply_alarm_receipt,
    apply_lock_override,
    apply_past_due_me_todos,
    find_past_due_me_todos,
)
from .sync_log import (
    Subscriber,
    close_socket_quietly,
    fetch_sync_catchup,
)

MAX_WS_FRAME_BYTES = 65536
HELLO_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class SessionHello:
    identity: object
    last_seq: int


def parse_json_frame(raw: str) -> dict | None:
    parsed = None
    try:
        candidate = json.loads(raw)
        if isinstance(candidate, dict):
            parsed = candidate
    except ValueError:
        parsed = None
    return parsed


async def dispatch_client_dict(ctx, identity, msg: dict) -> dict:
    msg_type = msg.get("type")
    if msg_type == "ALARM_RECEIPT":
        return await apply_alarm_receipt(ctx, identity, msg)
    if msg_type == "LOCK_OVERRIDE":
        return await apply_lock_override(ctx, identity, msg)
    if msg_type == "PING":
        return dict(type="PONG")
    raise RpcError(422, "UNKNOWN_TYPE", "Unsupported frame type")


async def process_client_frame(ctx, identity, raw: str) -> dict:
    msg = parse_json_frame(raw)
    if msg is None:
        return dict(
            type="ERROR",
            code="INVALID_JSON",
            message="Frame must be a JSON object",
        )
    reply = None
    try:
        reply = await dispatch_client_dict(ctx, identity, msg)
    except RpcError as err:
        reply = dict(type="ERROR", code=err.code, message=err.message)
    return reply


async def send_frame_safe(websocket, payload: dict) -> bool:
    sent = True
    try:
        await websocket.send_json(payload)
    except (WebSocketDisconnect, RuntimeError, OSError):
        sent = False
    return sent


async def await_ws_text(websocket, timeout: float | None) -> str:
    if timeout is None:
        return await websocket.receive_text()
    return await asyncio.wait_for(websocket.receive_text(), timeout=timeout)


async def recv_text_safe(
    websocket, timeout: float | None = None
) -> str | None:
    raw = None
    close_pair = None
    try:
        raw = await await_ws_text(websocket, timeout)
    except TimeoutError:
        close_pair = (4408, "Handshake timeout")
    except KeyError:
        close_pair = (1003, "Text frames required")
    except (WebSocketDisconnect, RuntimeError, OSError):
        raw = None
    if close_pair is not None:
        await close_socket_quietly(websocket, close_pair[0], close_pair[1])
        return None
    if raw is not None and len(raw.encode("utf-8")) > MAX_WS_FRAME_BYTES:
        await close_socket_quietly(websocket, 1009, "Frame too large")
        return None
    return raw


async def run_ws_writer(
    websocket, sub: Subscriber, initial_seq: int
) -> None:
    high_seq = initial_seq
    while not sub.kicked:
        item = await sub.queue.get()
        if item is None:
            break
        if item.get("type") == "SYNC_PUSH":
            if item["seq"] <= high_seq:
                continue
            high_seq = item["seq"]
        if not await send_frame_safe(websocket, item):
            break


async def run_ws_reader(ctx, identity, sub: Subscriber) -> None:
    while not sub.kicked:
        raw = await recv_text_safe(sub.websocket)
        if raw is None:
            break
        reply = await process_client_frame(ctx, identity, raw)
        ctx.hub.enqueue(sub, reply)


async def handshake_hello(
    ctx, websocket, timeout: float = HELLO_TIMEOUT_SECONDS
) -> SessionHello | None:
    raw = await recv_text_safe(websocket, timeout=timeout)
    if raw is None:
        return None
    msg = parse_json_frame(raw)
    if msg is None or msg.get("type") != "HELLO":
        await close_socket_quietly(websocket, 4422, "Expected HELLO")
        return None
    identity = await authenticate_token(ctx.pool, msg.get("token"))
    if identity is None:
        await close_socket_quietly(websocket, 4401, "Unauthorized")
        return None
    if "*" not in identity.scopes:
        await close_socket_quietly(websocket, 4403, "Personal token required")
        return None
    last_seq = msg.get("last_seq", 0)
    if isinstance(last_seq, bool) or not isinstance(last_seq, int) or (
        last_seq < 0
    ):
        await close_socket_quietly(websocket, 4422, "Invalid last_seq")
        return None
    src = "local" if identity.kind == "device" else "web"
    return SessionHello(replace(identity, source=src), last_seq)


async def load_initial_catchup(
    ctx, token_id: str, last_seq: int
) -> tuple[bool, int, list[dict]]:
    now = ctx.clock()
    due_pairs = []
    async with ctx.pool.connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM tokens WHERE token_id = %s AND revoked_at IS NULL",
            (token_id,),
        )
        if await cur.fetchone() is None:
            return False, 0, []
        due_pairs = await find_past_due_me_todos(conn, now)
        if not due_pairs:
            latest, frames = await fetch_sync_catchup(conn, last_seq)
            return True, latest, frames
    await apply_past_due_me_todos(ctx, due_pairs)
    async with ctx.pool.connection() as conn:
        latest, frames = await fetch_sync_catchup(conn, last_seq)
    return True, latest, frames


async def send_catchup_replay(
    ctx, websocket, latest_seq: int, replay_frames: list[dict]
) -> int | None:
    for frame in replay_frames:
        if not await send_frame_safe(websocket, frame):
            return None
    ack = dict(
        type="HELLO_ACK", latest_seq=latest_seq, replayed=len(replay_frames)
    )
    latest_app = scan_local_latest(ctx.settings.releases_dir)
    if latest_app is not None:
        ack["latest_app"] = latest_app
    if not await send_frame_safe(websocket, ack):
        return None
    return latest_seq


async def prepare_and_replay_session(
    ctx, sub: Subscriber, hello: SessionHello
) -> int | None:
    websocket = sub.websocket
    if sub.kicked:
        await close_socket_quietly(websocket, 4401, "Token revoked")
        return None
    active, latest, frames = await load_initial_catchup(
        ctx, hello.identity.token_id, hello.last_seq
    )
    if sub.kicked or not active:
        await close_socket_quietly(websocket, 4401, "Token revoked")
        return None
    return await send_catchup_replay(ctx, websocket, latest, frames)


async def stream_session(
    ctx, sub: Subscriber, hello: SessionHello
) -> None:
    high_seq = await prepare_and_replay_session(ctx, sub, hello)
    if high_seq is None or sub.kicked:
        return
    reader = asyncio.create_task(run_ws_reader(ctx, hello.identity, sub))
    writer = asyncio.create_task(run_ws_writer(sub.websocket, sub, high_seq))
    done, pending = await asyncio.wait(
        (reader, writer), return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, *done, return_exceptions=True)


async def handle_sync_ws(ctx, websocket) -> None:
    await websocket.accept()
    hello = await handshake_hello(ctx, websocket)
    if hello is None:
        return
    sub = ctx.hub.register(hello.identity.token_id, websocket)
    try:
        await stream_session(ctx, sub, hello)
    finally:
        ctx.hub.unregister(sub)
