from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

from eval_step1 import (
    EvalContext,
    RpcRequest,
    claim_device_pair,
    claim_device_token,
    rpc_call,
)
from pocket_cloud.cli import run as run_cli
from pocket_cloud.cli_sync import build_ws_url


async def ws_send(ws, payload: dict) -> None:
    await ws.send(json.dumps(payload))


async def ws_recv(ws, timeout: float = 5.0) -> dict:
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def open_synced_ws(
    ws_url: str, token: str, last_seq: int
) -> tuple[object, list[dict], dict]:
    ws = await websockets.connect(ws_url)
    await ws_send(ws, dict(type="HELLO", token=token, last_seq=last_seq))
    replayed = []
    while True:
        frame = await ws_recv(ws)
        if frame["type"] == "HELLO_ACK":
            return ws, replayed, frame
        replayed.append(frame)


async def issue_web_token(
    ctx: EvalContext, client: httpx.AsyncClient, label: str
) -> str:
    res = await rpc_call(
        client,
        RpcRequest(
            "token.create",
            dict(kind="web", label=label),
            token=ctx.bootstrap_key,
        ),
    )
    assert res.status_code == 200
    return res.json()["data"]["token"]


async def fetch_latest_seq(ws_url: str, token: str) -> int:
    ws, _, ack = await open_synced_ws(ws_url, token, 0)
    await ws.close()
    return ack["latest_seq"]


async def create_future_me_todo(
    client: httpx.AsyncClient, web_tok: str
) -> str:
    future_day = (datetime.now(timezone.utc) + timedelta(days=2)).date()
    created = await rpc_call(
        client,
        RpcRequest(
            "todo.set",
            dict(
                text="Offline alarm sync",
                assignee="@me",
                schedule_kind="once",
                time_hhmm="07:45",
                once_date=future_day.isoformat(),
                timezone="UTC",
            ),
            token=web_tok,
            source="web",
        ),
    )
    todo = created.json()["data"]
    assert todo["alarm_status"] == "QUEUED"
    return todo["todo_id"]


async def assert_receipt_roundtrip(
    todo_id: str, phone_replayed: list[dict], web_ws, phone_ws
) -> None:
    matched = [f for f in phone_replayed if f["entity_id"] == todo_id]
    assert len(matched) == 1
    assert matched[0]["payload"]["alarm_status"] == "QUEUED"

    await ws_send(
        phone_ws,
        dict(
            type="ALARM_RECEIPT",
            entity_type="todo",
            entity_id=todo_id,
            status="EXECUTED",
        ),
    )
    web_live = await ws_recv(web_ws)
    phone_live = await ws_recv(phone_ws)
    ack = await ws_recv(phone_ws)
    assert web_live["entity_id"] == todo_id
    assert web_live["payload"]["alarm_status"] == "EXECUTED"
    assert phone_live["seq"] == web_live["seq"]
    assert ack["type"] == "RECEIPT_ACK" and ack["status"] == "EXECUTED"


async def verify_offline_catchup_and_alarm_receipt(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    ws_url = build_ws_url(ctx.base_url)
    base_seq = await fetch_latest_seq(ws_url, ctx.bootstrap_key)
    phone_tok = await claim_device_token(ctx, client, "Step3AlarmPhone")
    web_tok = await issue_web_token(ctx, client, "Step3WebClient")
    todo_id = await create_future_me_todo(client, web_tok)

    web_ws, _, web_ack = await open_synced_ws(ws_url, web_tok, base_seq)
    phone_ws, phone_replayed, _ = await open_synced_ws(
        ws_url, phone_tok, base_seq
    )
    try:
        assert web_ack["replayed"] >= 1
        await assert_receipt_roundtrip(
            todo_id, phone_replayed, web_ws, phone_ws
        )
    finally:
        await web_ws.close()
        await phone_ws.close()


async def verify_past_due_auto_missed(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    ws_url = build_ws_url(ctx.base_url)
    base_seq = await fetch_latest_seq(ws_url, ctx.bootstrap_key)
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date()
    created = await rpc_call(
        client,
        RpcRequest(
            "todo.set",
            dict(
                text="Past due alarm",
                assignee="@me",
                schedule_kind="once",
                time_hhmm="06:30",
                once_date=yesterday.isoformat(),
                timezone="UTC",
            ),
            token=ctx.bootstrap_key,
        ),
    )
    todo_id = created.json()["data"]["todo_id"]
    assert created.json()["data"]["alarm_status"] == "QUEUED"

    ws, replayed, _ = await open_synced_ws(ws_url, ctx.bootstrap_key, base_seq)
    await ws.close()
    for_todo = [item for item in replayed if item["entity_id"] == todo_id]
    assert for_todo[-1]["payload"]["alarm_status"] == "MISSED"


async def assert_override_exchange(
    todo_id: str, base_seq: int, web_ws, phone_ws
) -> None:
    await ws_send(
        web_ws,
        dict(
            type="LOCK_OVERRIDE",
            todo=dict(todo_id=todo_id, text="Web illegal lock"),
        ),
    )
    err_frame = await ws_recv(web_ws)
    assert err_frame["type"] == "ERROR" and err_frame["code"] == "FORBIDDEN"

    await ws_send(
        phone_ws,
        dict(
            type="LOCK_OVERRIDE",
            todo=dict(
                todo_id=todo_id,
                text="Phone offline locked",
                locked=True,
                base_revision=1,
            ),
        ),
    )
    web_push = await ws_recv(web_ws)
    phone_push = await ws_recv(phone_ws)
    ack = await ws_recv(phone_ws)
    assert ack["type"] == "OVERRIDE_ACK" and ack["revision"] == 3
    assert web_push["seq"] > base_seq and web_push["seq"] == phone_push["seq"]
    assert web_push["payload"]["locked"] is True
    assert web_push["payload"]["text"] == "Phone offline locked"


async def verify_lock_override_and_forbidden(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    ws_url = build_ws_url(ctx.base_url)
    phone_tok = await claim_device_token(ctx, client, "Step3LockPhone")
    web_tok = await issue_web_token(ctx, client, "Step3LockWeb")
    created = await rpc_call(
        client,
        RpcRequest(
            "todo.set", dict(text="Cloud draft"), token=web_tok, source="web"
        ),
    )
    todo_id = created.json()["data"]["todo_id"]
    await rpc_call(
        client,
        RpcRequest(
            "todo.set",
            dict(todo_id=todo_id, text="Cloud edited", base_revision=1),
            token=web_tok,
            source="web",
        ),
    )
    base_seq = await fetch_latest_seq(ws_url, ctx.bootstrap_key)
    web_ws, _, _ = await open_synced_ws(ws_url, web_tok, base_seq)
    phone_ws, _, _ = await open_synced_ws(ws_url, phone_tok, base_seq)
    try:
        await assert_override_exchange(todo_id, base_seq, web_ws, phone_ws)
    finally:
        await web_ws.close()
        await phone_ws.close()


async def verify_token_revoke_kicks_ws(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    ws_url = build_ws_url(ctx.base_url)
    base_seq = await fetch_latest_seq(ws_url, ctx.bootstrap_key)
    token_id, phone_tok = await claim_device_pair(
        ctx, client, "Step3RevokePhone"
    )
    phone_ws, _, _ = await open_synced_ws(ws_url, phone_tok, base_seq)
    try:
        revoked = await rpc_call(
            client,
            RpcRequest(
                "token.revoke",
                dict(token_id=token_id),
                token=ctx.bootstrap_key,
            ),
        )
        assert revoked.status_code == 200
        closed_code = 0
        try:
            await ws_recv(phone_ws)
        except ConnectionClosed as exc:
            closed_code = exc.rcvd.code if exc.rcvd is not None else 0
        assert closed_code == 4401
    finally:
        await phone_ws.close()


async def verify_sync_cli_end_to_end(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    env = dict(POCKET_URL=ctx.base_url, POCKET_TOKEN=ctx.bootstrap_key)
    ev = await run_cli(
        [
            "event", "add", "--date", "2026-11-30", "--start", "08:00",
            "--end", "08:30", "--title", "Step3 CLI Alarm",
            "--reminder", "alarm", "--json",
        ],
        env,
        client,
    )
    assert ev["alarm_status"] == "QUEUED"

    ack = await run_cli(
        ["sync", "ack", ev["event_id"], "--status", "EXECUTED", "--json"],
        env,
        client,
    )
    assert ack["status"] == "EXECUTED" and ack["entity_type"] == "event"

    watched = await run_cli(
        ["sync", "watch", "--from-seq", "0", "--limit", "3", "--json"],
        env,
        client,
    )
    assert len(watched["frames"]) == 3
    tail = await run_cli(
        ["sync", "watch", "--from-seq", "0", "--limit", "0", "--json"],
        env,
        client,
    )
    assert tail["latest_seq"] >= watched["frames"][-1]["seq"]


async def run_step3(ctx: EvalContext) -> list[str]:
    checks: list[str] = []
    async with httpx.AsyncClient(
        base_url=ctx.base_url, timeout=15.0
    ) as client:
        await verify_offline_catchup_and_alarm_receipt(ctx, client)
        checks.append("step3.offline_catchup_and_alarm_receipt_sync_push")

        await verify_past_due_auto_missed(ctx, client)
        checks.append("step3.past_due_once_me_auto_missed_on_hello")

        await verify_lock_override_and_forbidden(ctx, client)
        checks.append("step3.device_lock_override_vs_web_forbidden")

        await verify_token_revoke_kicks_ws(ctx, client)
        checks.append("step3.token_revoke_kicks_active_ws_4401")

        await verify_sync_cli_end_to_end(ctx, client)
        checks.append("step3.cli_sync_ack_and_watch_e2e")
    return checks
