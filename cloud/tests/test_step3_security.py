import asyncio

import httpx
import pytest
import websockets
from websockets.exceptions import ConnectionClosed

from helpers import (
    RpcCallSpec,
    attach_mock_http,
    create_web_token,
    issue_device_pair,
    issue_device_token,
    post_rpc,
    register_agent,
    run_loopback_server,
)
from pocket_cloud.cli_sync import build_ws_url
from pocket_cloud.sync_log import MAX_WS_QUEUE
from pocket_cloud.sync_ws import handshake_hello
from test_step3_sync_ws import connect_hello, recv_json, send_json


async def test_cors_preflight_allows_browser_rpc_headers(client):
    headers = dict(
        (
            ("Origin", "http://localhost:5173"),
            ("Access-Control-Request-Method", "POST"),
            ("Access-Control-Request-Headers", "authorization,content-type"),
        )
    )
    res = await client.options("/v1/rpc/event.list", headers=headers)
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "*"


async def test_stale_last_seq_reports_true_head_and_streams_live(client, app):
    await post_rpc(
        client,
        "todo.set",
        RpcCallSpec(params=dict(text="Seed 1"), request_id="stale-1"),
    )
    async with run_loopback_server(app) as base_url:
        ws, replayed, ack = await connect_hello(
            build_ws_url(base_url), "test-bootstrap-key", 500
        )
        try:
            assert replayed == [] and ack["replayed"] == 0
            assert ack["latest_seq"] < 500
            await post_rpc(
                client,
                "todo.set",
                RpcCallSpec(params=dict(text="Live 2"), request_id="stale-2"),
            )
            live = await recv_json(ws)
            assert live["payload"]["text"] == "Live 2"
        finally:
            await ws.close()


async def seed_alarm_guard_entities(
    client, dev_tok: str
) -> tuple[str, str, str]:
    plain_td = (
        await post_rpc(
            client,
            "todo.set",
            RpcCallSpec(params=dict(text="Plain"), request_id="sec-plain-td"),
        )
    ).json()["data"]["todo_id"]
    locked_params = dict(
        text="Locked alarm",
        assignee="@me",
        schedule_kind="once",
        time_hhmm="07:00",
        once_date="2026-11-30",
        locked=True,
    )
    locked_td = (
        await post_rpc(
            client,
            "todo.set",
            RpcCallSpec(
                token=dev_tok,
                source="local",
                params=locked_params,
                request_id="sec-locked-td",
            ),
        )
    ).json()["data"]["todo_id"]
    notify_ev = (
        await post_rpc(
            client,
            "event.set",
            RpcCallSpec(
                params=dict(
                    event_date="2026-11-30",
                    start_hhmm="10:00",
                    end_hhmm="11:00",
                    title="Notify only",
                    reminder_policy="notify",
                ),
                request_id="sec-notify-ev",
            ),
        )
    ).json()["data"]["event_id"]
    return plain_td, locked_td, notify_ev


async def assert_ws_error_code(ws, frame: dict, code: str) -> None:
    await send_json(ws, frame)
    reply = await recv_json(ws)
    assert reply["type"] == "ERROR" and reply["code"] == code


async def assert_receipt_guards(
    sockets: tuple, ids: tuple[str, str, str]
) -> None:
    web_ws, boot_ws, phone_ws = sockets
    plain_td, locked_td, notify_ev = ids
    locked_frame = dict(
        type="ALARM_RECEIPT",
        entity_type="todo",
        entity_id=locked_td,
        status="EXECUTED",
    )
    await assert_ws_error_code(web_ws, locked_frame, "FORBIDDEN")
    await assert_ws_error_code(boot_ws, locked_frame, "CLOUD_LOCKED")
    await assert_ws_error_code(
        phone_ws,
        dict(
            type="ALARM_RECEIPT",
            entity_type="todo",
            entity_id=plain_td,
            status="EXECUTED",
        ),
        "NOT_ALARM_ENTITY",
    )
    await assert_ws_error_code(
        phone_ws,
        dict(
            type="ALARM_RECEIPT",
            entity_type="event",
            entity_id=notify_ev,
            status="EXECUTED",
        ),
        "NOT_ALARM_ENTITY",
    )


async def test_alarm_receipt_security_and_domain_guards(client, app):
    dev_tok = await issue_device_token(client, "GuardPhone")
    web_tok = await create_web_token(client, "GuardWeb")
    ids = await seed_alarm_guard_entities(client, dev_tok)

    async with run_loopback_server(app) as base_url:
        ws_url = build_ws_url(base_url)
        web_ws, _, ack = await connect_hello(ws_url, web_tok, 0)
        boot_ws, _, _ = await connect_hello(
            ws_url, "test-bootstrap-key", ack["latest_seq"]
        )
        phone_ws, _, _ = await connect_hello(
            ws_url, dev_tok, ack["latest_seq"]
        )
        try:
            await assert_receipt_guards((web_ws, boot_ws, phone_ws), ids)
        finally:
            await web_ws.close()
            await boot_ws.close()
            await phone_ws.close()


async def assert_override_resurrects(
    phone_ws, web_ws, todo_id: str
) -> None:
    await assert_ws_error_code(
        phone_ws,
        dict(type="LOCK_OVERRIDE", todo=dict(text="No id")),
        "INVALID_ID",
    )
    await assert_ws_error_code(
        phone_ws,
        dict(
            type="LOCK_OVERRIDE",
            todo=dict(todo_id=todo_id, text="Bad", locked=False),
        ),
        "INVALID_PARAMS",
    )
    await send_json(
        phone_ws,
        dict(
            type="LOCK_OVERRIDE",
            todo=dict(todo_id=todo_id, text="Saved on phone"),
        ),
    )
    web_push = await recv_json(web_ws)
    _ = await recv_json(phone_ws)
    override_ack = await recv_json(phone_ws)
    assert override_ack["revision"] == 3
    assert web_push["payload"]["locked"] is True
    assert web_push["payload"]["text"] == "Saved on phone"


async def test_lock_override_guards_and_resurrects_deleted_todo(client, app):
    dev_tok = await issue_device_token(client, "ResurrectPhone")
    web_tok = await create_web_token(client, "ResurrectWeb")
    todo_id = (
        await post_rpc(
            client,
            "todo.set",
            RpcCallSpec(
                token=web_tok,
                source="web",
                params=dict(text="Web created"),
                request_id="res-td-1",
            ),
        )
    ).json()["data"]["todo_id"]
    await post_rpc(
        client,
        "todo.delete",
        RpcCallSpec(
            token=web_tok,
            source="web",
            params=dict(todo_id=todo_id),
            request_id="res-td-del",
        ),
    )

    async with run_loopback_server(app) as base_url:
        ws_url = build_ws_url(base_url)
        phone_ws, _, ack = await connect_hello(ws_url, dev_tok, 0)
        web_ws, _, _ = await connect_hello(ws_url, web_tok, ack["latest_seq"])
        try:
            await assert_override_resurrects(phone_ws, web_ws, todo_id)
        finally:
            await phone_ws.close()
            await web_ws.close()


class IdleWebSocket:
    def __init__(self) -> None:
        self.closed_code = 0

    async def receive_text(self) -> str:
        await asyncio.sleep(5.0)
        return ""

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_code = code
        _ = reason


async def test_ws_frame_limits_timeout_and_slow_consumer(client, app):
    idle = IdleWebSocket()
    assert await handshake_hello(app.state.ctx, idle, timeout=0.02) is None
    assert idle.closed_code == 4408

    dev_tok = await issue_device_token(client, "LimitsPhone")
    async with run_loopback_server(app) as base_url:
        ws_url = build_ws_url(base_url)
        async with websockets.connect(ws_url) as bin_ws:
            await bin_ws.send(b"\x00\x01")
            with pytest.raises(ConnectionClosed) as bin_exc:
                await asyncio.wait_for(bin_ws.recv(), timeout=3.0)
            assert bin_exc.value.rcvd.code == 1003

        big_ws, _, _ = await connect_hello(ws_url, dev_tok, 0)
        try:
            await big_ws.send("x" * 70000)
            with pytest.raises(ConnectionClosed) as big_exc:
                await asyncio.wait_for(big_ws.recv(), timeout=3.0)
            assert big_exc.value.rcvd.code == 1009
        finally:
            await big_ws.close()

        slow_ws, _, _ = await connect_hello(ws_url, dev_tok, 0)
        try:
            burst = [
                dict(type="SYNC_PUSH", seq=idx + 1000, payload=dict())
                for idx in range(MAX_WS_QUEUE + 2)
            ]
            app.state.ctx.hub.publish_many(burst)
            with pytest.raises(ConnectionClosed) as slow_exc:
                while True:
                    await asyncio.wait_for(slow_ws.recv(), timeout=3.0)
            assert slow_exc.value.rcvd.code == 1013
        finally:
            await slow_ws.close()


async def exercise_retryable_trigger_and_revoke(
    client, app, sockets: tuple, ids: tuple[str, str]
) -> None:
    web_ws, dev_ws = sockets
    todo_id, tok_id = ids
    await post_rpc(
        client,
        "todo.trigger",
        RpcCallSpec(params=dict(todo_id=todo_id), request_id="sec-trig-503"),
    )
    pushed = await recv_json(web_ws)
    assert pushed["payload"]["last_delivery_status"] == "PENDING"

    rev_spec = RpcCallSpec(
        params=dict(token_id=tok_id), request_id="sec-idem-rev"
    )
    await post_rpc(client, "token.revoke", rev_spec)
    with pytest.raises(ConnectionClosed) as rev_exc:
        while True:
            await asyncio.wait_for(dev_ws.recv(), timeout=3.0)
    assert rev_exc.value.rcvd.code == 4401

    ghost_sock = IdleWebSocket()
    ghost_sub = app.state.ctx.hub.register(tok_id, ghost_sock)
    await post_rpc(client, "token.revoke", rev_spec)
    assert ghost_sub.kicked is True and ghost_sock.closed_code == 4401


async def test_trigger_retryable_sync_and_idempotent_revoke_kick(client, app):
    await register_agent(client, "@bot", "s3cr3t")
    todo_id = (
        await post_rpc(
            client,
            "todo.set",
            RpcCallSpec(
                params=dict(
                    text="Retryable trigger",
                    assignee="@bot",
                    schedule_kind="daily",
                    time_hhmm="18:00",
                ),
                request_id="sec-trig-td",
            ),
        )
    ).json()["data"]["todo_id"]
    tok_id, dev_tok = await issue_device_pair(client, "IdemRevoke")

    def fail_503(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    async with attach_mock_http(app, fail_503):
        async with run_loopback_server(app) as base_url:
            ws_url = build_ws_url(base_url)
            web_ws, _, ack = await connect_hello(
                ws_url, "test-bootstrap-key", 0
            )
            dev_ws, _, _ = await connect_hello(
                ws_url, dev_tok, ack["latest_seq"]
            )
            try:
                await exercise_retryable_trigger_and_revoke(
                    client, app, (web_ws, dev_ws), (todo_id, tok_id)
                )
            finally:
                await web_ws.close()
                await dev_ws.close()
