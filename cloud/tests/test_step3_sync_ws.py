import asyncio
from datetime import datetime, timezone
import json

import httpx
import pytest
import websockets
from websockets.exceptions import ConnectionClosed

from helpers import (
    MutableClock,
    RpcCallSpec,
    attach_mock_http,
    create_agent_token,
    create_web_token,
    issue_device_pair,
    issue_device_token,
    post_rpc,
    register_agent,
    run_loopback_server,
)
from pocket_cloud.cli_sync import build_ws_url
from pocket_cloud.scheduler import dispatch_due_deliveries, expand_due_todos


async def send_json(ws, payload: dict) -> None:
    await ws.send(json.dumps(payload))


async def recv_json(ws, timeout: float = 3.0) -> dict:
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def connect_hello(
    ws_url: str, token: str, last_seq: int = 0
) -> tuple[object, list[dict], dict]:
    ws = await websockets.connect(ws_url)
    await send_json(ws, dict(type="HELLO", token=token, last_seq=last_seq))
    replayed = []
    while True:
        frame = await recv_json(ws)
        if frame["type"] == "HELLO_ACK":
            return ws, replayed, frame
        replayed.append(frame)


async def expect_ws_close_code(ws_url: str, first_msg: dict, code: int) -> None:
    async with websockets.connect(ws_url) as ws:
        await send_json(ws, first_msg)
        with pytest.raises(ConnectionClosed) as exc_info:
            await asyncio.wait_for(ws.recv(), timeout=3.0)
        assert exc_info.value.rcvd is not None
        assert exc_info.value.rcvd.code == code


async def test_ws_handshake_auth_and_validation(client, app):
    agent_tok = await create_agent_token(client, "WSAgent", ["todo.read"])
    dev_tok = await issue_device_token(client, "WSPhone")

    async with run_loopback_server(app) as base_url:
        ws_url = build_ws_url(base_url)
        await expect_ws_close_code(ws_url, dict(type="PING"), 4422)
        await expect_ws_close_code(
            ws_url, dict(type="HELLO", token="bad-token", last_seq=0), 4401
        )
        await expect_ws_close_code(
            ws_url, dict(type="HELLO", token=agent_tok, last_seq=0), 4403
        )
        await expect_ws_close_code(
            ws_url, dict(type="HELLO", token=dev_tok, last_seq=-1), 4422
        )
        await expect_ws_close_code(
            ws_url, dict(type="HELLO", token=dev_tok, last_seq=True), 4422
        )
        ws, replayed, ack = await connect_hello(ws_url, dev_tok, 0)
        await ws.close()
        assert replayed == [] and ack["replayed"] == 0


async def seed_offline_mutations(client) -> tuple[str, str]:
    ev_params = dict(
        event_date="2026-11-25", start_hhmm="09:00", end_hhmm="10:00",
        title="Sync Event", reminder_policy="alarm",
    )
    ev = (
        await post_rpc(
            client, "event.set",
            RpcCallSpec(params=ev_params, request_id="s3-ev-1"),
        )
    ).json()["data"]
    stale_params = dict(ev_params, event_id=ev["event_id"], base_revision=99)
    stale = await post_rpc(
        client, "event.set",
        RpcCallSpec(params=stale_params, request_id="s3-ev-conflict"),
    )
    assert stale.status_code == 409

    del_ev = dict(event_id=ev["event_id"], base_revision=1)
    await post_rpc(
        client, "event.delete", RpcCallSpec(params=del_ev, request_id="s3-ev-d")
    )
    td = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(params=dict(text="Offline task"), request_id="s3-td-1"),
        )
    ).json()["data"]
    td_ref = dict(todo_id=td["todo_id"])
    await post_rpc(
        client, "todo.toggle", RpcCallSpec(params=td_ref, request_id="s3-td-t")
    )
    await post_rpc(
        client, "todo.delete", RpcCallSpec(params=td_ref, request_id="s3-td-d")
    )
    return ev["event_id"], td["todo_id"]


async def test_offline_catchup_and_rollback_safety(client, app):
    ev_id, td_id = await seed_offline_mutations(client)
    async with run_loopback_server(app) as base_url:
        ws_url = build_ws_url(base_url)
        ws1, frames, ack = await connect_hello(ws_url, "test-bootstrap-key", 0)
        await ws1.close()
        assert ack["replayed"] == 5 and len(frames) == 5
        seqs = [item["seq"] for item in frames]
        assert seqs == sorted(seqs) and ack["latest_seq"] == seqs[-1]
        assert [(f["entity_type"], f["action"]) for f in frames] == [
            ("event", "upsert"),
            ("event", "delete"),
            ("todo", "upsert"),
            ("todo", "upsert"),
            ("todo", "delete"),
        ]
        assert frames[1]["payload"] == dict(
            event_id=ev_id, deleted=True, revision=2
        )
        assert frames[4]["payload"] == dict(
            todo_id=td_id, deleted=True, revision=3
        )

        ws2, delta, ack2 = await connect_hello(
            ws_url, "test-bootstrap-key", seqs[2]
        )
        await ws2.close()
        assert ack2["replayed"] == 2
        assert [item["seq"] for item in delta] == seqs[3:]


async def create_once_me_todo(
    client, req_id: str, text: str, time_hhmm: str
) -> dict:
    params = dict(
        text=text,
        assignee="@me",
        schedule_kind="once",
        time_hhmm=time_hhmm,
        once_date="2026-11-24",
        timezone="Asia/Shanghai",
    )
    res = await post_rpc(
        client, "todo.set", RpcCallSpec(params=params, request_id=req_id)
    )
    return res.json()["data"]


async def assert_todo_alarm_map(client, expected: dict) -> None:
    todos = (await post_rpc(client, "todo.list")).json()["data"]["todos"]
    by_id = dict((item["todo_id"], item["alarm_status"]) for item in todos)
    for todo_id, status in expected.items():
        assert by_id[todo_id] == status


async def test_past_due_once_me_todo_auto_missed_on_hello(client, app):
    app.state.ctx.clock = MutableClock(
        datetime(2026, 11, 24, 1, 0, tzinfo=timezone.utc)
    )
    past_todo = await create_once_me_todo(
        client, "s3-past-me", "Morning meds", "08:30"
    )
    future_todo = await create_once_me_todo(
        client, "s3-future-me", "Lunch call", "10:30"
    )
    assert past_todo["alarm_status"] == "QUEUED"

    async with run_loopback_server(app) as base_url:
        ws, frames, ack = await connect_hello(
            build_ws_url(base_url), "test-bootstrap-key", 0
        )
        await ws.close()

    assert ack["replayed"] == 3
    assert frames[-1]["entity_id"] == past_todo["todo_id"]
    assert frames[-1]["payload"]["alarm_status"] == "MISSED"
    assert frames[-1]["revision"] == 2
    await assert_todo_alarm_map(
        client,
        dict(
            (
                (past_todo["todo_id"], "MISSED"),
                (future_todo["todo_id"], "QUEUED"),
            )
        ),
    )


async def verify_receipt_errors(phone_ws, todo_id: str) -> None:
    await send_json(
        phone_ws,
        dict(
            type="ALARM_RECEIPT",
            entity_type="todo",
            entity_id="todo_missing",
            status="EXECUTED",
        ),
    )
    not_found = await recv_json(phone_ws)
    assert not_found["type"] == "ERROR" and not_found["code"] == "NOT_FOUND"

    await send_json(
        phone_ws,
        dict(
            type="ALARM_RECEIPT",
            entity_type="todo",
            entity_id=todo_id,
            status="SNOOZED",
        ),
    )
    bad_status = await recv_json(phone_ws)
    assert bad_status["type"] == "ERROR"
    assert bad_status["code"] == "INVALID_STATUS"


async def verify_live_alarm_flow(client, web_tok, web_ws, phone_ws) -> None:
    params = dict(
        text="Ring phone", assignee="@me", schedule_kind="once",
        time_hhmm="23:50", once_date="2026-11-28",
    )
    todo = (
        await post_rpc(
            client,
            "todo.set",
            RpcCallSpec(
                token=web_tok, source="web",
                params=params, request_id="s3-live-todo",
            ),
        )
    ).json()["data"]
    w_push1 = await recv_json(web_ws)
    p_push1 = await recv_json(phone_ws)
    assert w_push1["seq"] == p_push1["seq"]
    assert p_push1["payload"]["alarm_status"] == "QUEUED"

    await send_json(
        phone_ws,
        dict(
            type="ALARM_RECEIPT", entity_type="todo",
            entity_id=todo["todo_id"], status="EXECUTED",
        ),
    )
    w_push2 = await recv_json(web_ws)
    p_push2 = await recv_json(phone_ws)
    receipt_ack = await recv_json(phone_ws)
    assert w_push2["payload"]["alarm_status"] == "EXECUTED"
    assert p_push2["seq"] == w_push2["seq"]
    assert receipt_ack == dict(
        type="RECEIPT_ACK", entity_type="todo",
        entity_id=todo["todo_id"], status="EXECUTED", revision=2,
    )
    await verify_receipt_errors(phone_ws, todo["todo_id"])


async def test_live_multi_client_sync_push_and_alarm_receipts(client, app):
    dev_tok = await issue_device_token(client, "AlarmPhone")
    web_tok = await create_web_token(client, "WebTab")

    async with run_loopback_server(app) as base_url:
        ws_url = build_ws_url(base_url)
        web_ws, _, _ = await connect_hello(ws_url, web_tok, 0)
        phone_ws, _, _ = await connect_hello(ws_url, dev_tok, 0)
        try:
            await verify_live_alarm_flow(client, web_tok, web_ws, phone_ws)
        finally:
            await web_ws.close()
            await phone_ws.close()


async def run_scheduler_ws_assertions(
    client, app, web_ws, captured: list[dict]
) -> None:
    params = dict(
        text="Agent summary task", assignee="@bot", schedule_kind="once",
        time_hhmm="16:00", once_date="2026-11-24", timezone="Asia/Shanghai",
    )
    todo = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(params=params, request_id="s3-agent-td"),
        )
    ).json()["data"]
    assert (await recv_json(web_ws))["entity_id"] == todo["todo_id"]

    await expand_due_todos(app.state.ctx)
    expanded = await recv_json(web_ws)
    assert expanded["payload"]["last_delivery_status"] == "PENDING"

    await dispatch_due_deliveries(app.state.ctx)
    dispatched = await recv_json(web_ws)
    assert dispatched["payload"]["last_delivery_status"] == "COMPLETED"

    cbk = captured[0]
    cbk_hdr = dict(Authorization="Bearer " + cbk["callback_token"])
    cbk_res = await client.post(
        "/v1/deliveries/%s/result" % cbk["delivery_id"],
        headers=cbk_hdr,
        json=dict(result_summary="Live WS summary ready"),
    )
    assert cbk_res.status_code == 200
    summary_push = await recv_json(web_ws)
    assert summary_push["payload"]["result_summary"] == "Live WS summary ready"
    assert summary_push["revision"] > dispatched["revision"]


async def test_scheduler_and_delivery_callback_live_sync_push(client, app):
    app.state.ctx.clock = MutableClock(
        datetime(2026, 11, 24, 8, 0, tzinfo=timezone.utc)
    )
    await register_agent(client, "@bot", "bot-sec")
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode()))
        return httpx.Response(202, json=dict(accepted=True))

    async with attach_mock_http(app, handler):
        async with run_loopback_server(app) as base_url:
            web_ws, _, _ = await connect_hello(
                build_ws_url(base_url), "test-bootstrap-key", 0
            )
            try:
                await run_scheduler_ws_assertions(
                    client, app, web_ws, captured
                )
            finally:
                await web_ws.close()


async def exercise_lock_override_ws(
    todo_id: str, web_ws, phone_ws
) -> None:
    await send_json(
        web_ws,
        dict(
            type="LOCK_OVERRIDE",
            todo=dict(todo_id=todo_id, text="Web hijack"),
        ),
    )
    denied = await recv_json(web_ws)
    assert denied == dict(
        type="ERROR", code="FORBIDDEN", message="Device token required"
    )

    await send_json(
        phone_ws,
        dict(
            type="LOCK_OVERRIDE",
            todo=dict(
                todo_id=todo_id,
                text="Phone locked offline",
                base_revision=1,
                locked=True,
            ),
        ),
    )
    web_push = await recv_json(web_ws)
    phone_push = await recv_json(phone_ws)
    override_ack = await recv_json(phone_ws)
    assert override_ack == dict(
        type="OVERRIDE_ACK", todo_id=todo_id, revision=3
    )
    assert web_push["seq"] == phone_push["seq"]
    assert web_push["payload"]["locked"] is True
    assert web_push["payload"]["text"] == "Phone locked offline"


async def test_lock_override_device_only_and_conflict_resolution(client, app):
    dev_tok = await issue_device_token(client, "LockPhone")
    web_tok = await create_web_token(client, "WebLock")
    todo = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(
                token=web_tok, source="web",
                params=dict(text="Web v1"), request_id="s3-lock-v1",
            ),
        )
    ).json()["data"]
    todo_id = todo["todo_id"]
    await post_rpc(
        client, "todo.set",
        RpcCallSpec(
            token=web_tok, source="web",
            params=dict(todo_id=todo_id, text="Web v2", base_revision=1),
            request_id="s3-lock-v2",
        ),
    )

    async with run_loopback_server(app) as base_url:
        ws_url = build_ws_url(base_url)
        web_ws, _, ack = await connect_hello(ws_url, web_tok, 0)
        phone_ws, _, _ = await connect_hello(ws_url, dev_tok, ack["latest_seq"])
        try:
            await exercise_lock_override_ws(todo_id, web_ws, phone_ws)
        finally:
            await web_ws.close()
            await phone_ws.close()

    blocked = await post_rpc(
        client, "todo.set",
        RpcCallSpec(
            token=web_tok, source="web",
            params=dict(todo_id=todo_id, text="Blocked"),
            request_id="s3-lock-blocked",
        ),
    )
    assert blocked.status_code == 409


async def assert_ws_kicked_4401(ws) -> None:
    with pytest.raises(ConnectionClosed) as exc_info:
        await asyncio.wait_for(ws.recv(), timeout=3.0)
    assert exc_info.value.rcvd.code == 4401


async def test_token_revoke_kicks_active_websockets_immediately(client, app):
    tok_id_1, dev_tok_1 = await issue_device_pair(client, "KickPhone1")
    _, dev_tok_2 = await issue_device_pair(client, "KeepPhone2")

    async with run_loopback_server(app) as base_url:
        ws_url = build_ws_url(base_url)
        ws1_a, _, _ = await connect_hello(ws_url, dev_tok_1, 0)
        ws1_b, _, _ = await connect_hello(ws_url, dev_tok_1, 0)
        ws2, _, _ = await connect_hello(ws_url, dev_tok_2, 0)
        try:
            rev = await post_rpc(
                client, "token.revoke",
                RpcCallSpec(
                    params=dict(token_id=tok_id_1), request_id="s3-revoke-1"
                ),
            )
            assert rev.status_code == 200
            await assert_ws_kicked_4401(ws1_a)
            await assert_ws_kicked_4401(ws1_b)

            await post_rpc(
                client, "todo.set",
                RpcCallSpec(
                    params=dict(text="Still alive"), request_id="s3-after-kick"
                ),
            )
            assert (await recv_json(ws2))["payload"]["text"] == "Still alive"
            await expect_ws_close_code(
                ws_url, dict(type="HELLO", token=dev_tok_1, last_seq=0), 4401
            )
        finally:
            await ws1_a.close()
            await ws1_b.close()
            await ws2.close()
