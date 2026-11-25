from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import socket
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx
import uvicorn

from eval_step1 import EvalContext, RpcRequest, claim_device_token, rpc_call
from pocket_cloud.cli import run as run_cli


class MockAgentState:
    def __init__(self, expected_secret: str):
        self.expected_secret = expected_secret
        self.calls: list[dict] = []
        self.tasks: list[asyncio.Task] = []
        self.fail_first_todo_id: str | None = None
        self.failed_once = False


def build_mock_agent_app(state: MockAgentState) -> FastAPI:
    app = FastAPI()

    @app.post("/webhooks/pocket")
    async def webhook(request: Request):
        auth = request.headers.get("authorization", "")
        if auth != "Bearer " + state.expected_secret:
            return JSONResponse(dict(error="bad_auth"), status_code=401)
        payload = await request.json()
        state.calls.append(payload)
        should_503 = (
            payload.get("todo_id") == state.fail_first_todo_id
            and not state.failed_once
        )
        if should_503:
            state.failed_once = True
            return JSONResponse(dict(error="busy"), status_code=503)
        state.tasks.append(asyncio.create_task(send_callback(payload)))
        return JSONResponse(dict(accepted=True), status_code=202)

    return app


async def send_callback(payload: dict) -> None:
    await asyncio.sleep(0.05)
    summary = "Mock executed: " + payload["prompt"]
    headers = dict(Authorization="Bearer " + payload["callback_token"])
    body = dict(
        result_summary=summary,
        result_payload=dict(delivery_id=payload["delivery_id"]),
    )
    async with httpx.AsyncClient(timeout=5.0) as client:
        first = await client.post(
            payload["result_callback_url"], json=body, headers=headers
        )
        assert first.status_code == 200
        replay = await client.post(
            payload["result_callback_url"], json=body, headers=headers
        )
        assert replay.status_code == 409


async def start_mock_server(
    state: MockAgentState,
) -> tuple[uvicorn.Server, asyncio.Task, socket.socket, int]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(32)
    port = sock.getsockname()[1]
    config = uvicorn.Config(build_mock_agent_app(state), log_level="error")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        await asyncio.sleep(0.02)
    return server, task, sock, port


async def stop_mock_server(
    state: MockAgentState,
    server: uvicorn.Server,
    task: asyncio.Task,
    sock: socket.socket,
) -> None:
    if state.tasks:
        await asyncio.gather(*state.tasks, return_exceptions=True)
    server.should_exit = True
    await asyncio.gather(task, return_exceptions=True)
    sock.close()


async def verify_events_and_cli(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    env = dict(POCKET_URL=ctx.base_url, POCKET_TOKEN=ctx.bootstrap_key)
    ev1_cmd = [
        "event", "add", "--date", "2026-11-23", "--start", "10:00",
        "--end", "11:00", "--title", "Weekday Sync",
        "--repeat", "weekdays", "--reminder", "alarm", "--json",
    ]
    ev1 = await run_cli(ev1_cmd, env, client)
    assert ev1["alarm_status"] == "QUEUED"

    ev2_cmd = [
        "event", "add", "--date", "2026-11-24", "--start", "10:30",
        "--end", "11:30", "--title", "Client Call", "--json",
    ]
    await run_cli(ev2_cmd, env, client)

    list_cmd = [
        "event", "list", "--from", "2026-11-23", "--to", "2026-11-29", "--json",
    ]
    events = (await run_cli(list_cmd, env, client))["events"]
    tue = [item for item in events if item["instance_date"] == "2026-11-24"]
    assert len(tue) == 2 and all(item["has_conflict"] for item in tue)
    assert [i for i in events if i["instance_date"] == "2026-11-28"] == []

    del_cmd = ["event", "delete", ev1["event_id"], "--json"]
    assert (await run_cli(del_cmd, env, client))["deleted"] is True


async def verify_cloud_locked(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    dev_token = await claim_device_token(ctx, client, "EvalDev2")
    deny_req = RpcRequest(
        "todo.set",
        dict(text="Web cannot lock", locked=True),
        token=ctx.bootstrap_key,
        source="web",
    )
    denied = await rpc_call(client, deny_req)
    assert denied.status_code == 409
    assert denied.json()["error"]["code"] == "CLOUD_LOCKED"

    lock_params = dict(
        text="Device locked alarm", assignee="@me", schedule_kind="once",
        time_hhmm="07:30", once_date="2026-11-26", locked=True,
    )
    dev_created = await rpc_call(
        client,
        RpcRequest("todo.set", lock_params, token=dev_token, source="local"),
    )
    todo_id = dev_created.json()["data"]["todo_id"]
    web_tog = await rpc_call(
        client,
        RpcRequest(
            "todo.toggle", dict(todo_id=todo_id),
            token=ctx.bootstrap_key, source="web",
        ),
    )
    assert web_tog.status_code == 409
    dev_tog = await rpc_call(
        client,
        RpcRequest(
            "todo.toggle", dict(todo_id=todo_id),
            token=dev_token, source="local",
        ),
    )
    assert dev_tog.status_code == 200 and dev_tog.json()["data"]["done"] is True


async def wait_for_todo_summary(
    client: httpx.AsyncClient, token: str, todo_id: str, expected: str
) -> dict:
    for _ in range(45):
        res = await rpc_call(client, RpcRequest("todo.list", token=token))
        todos = res.json()["data"]["todos"]
        matched = [item for item in todos if item["todo_id"] == todo_id]
        if matched and matched[0]["result_summary"] == expected:
            return matched[0]
        await asyncio.sleep(0.3)
    raise AssertionError("Timed out waiting for callback result_summary")


async def check_scheduled_503_retry(
    ctx: EvalContext, client: httpx.AsyncClient, state: MockAgentState
) -> None:
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    due_res = await rpc_call(
        client,
        RpcRequest(
            "todo.set",
            dict(
                text="Auto retry job",
                assignee="@step2-bot",
                schedule_kind="once",
                time_hhmm=past.strftime("%H:%M"),
                once_date=past.date().isoformat(),
                timezone="UTC",
            ),
            token=ctx.bootstrap_key,
        ),
    )
    due_id = due_res.json()["data"]["todo_id"]
    state.fail_first_todo_id = due_id

    completed = await wait_for_todo_summary(
        client, ctx.bootstrap_key, due_id, "Mock executed: Auto retry job"
    )
    due_calls = [call for call in state.calls if call["todo_id"] == due_id]
    assert len(due_calls) == 2
    assert due_calls[0]["delivery_id"] == due_calls[1]["delivery_id"]
    assert completed["last_delivery_id"] == due_calls[1]["delivery_id"]
    assert completed["last_delivery_status"] == "COMPLETED"


async def verify_locked_trigger_guard(
    ctx: EvalContext, client: httpx.AsyncClient, todo_id: str
) -> None:
    dev_tok = await claim_device_token(ctx, client, "LockedTrigPhone")
    base = dict(
        todo_id=todo_id, text="Manual trigger check", assignee="@step2-bot",
        schedule_kind="daily", time_hhmm="23:45", timezone="Asia/Shanghai",
    )
    await rpc_call(
        client,
        RpcRequest(
            "todo.set", dict(base, locked=True), token=dev_tok, source="local"
        ),
    )
    blocked = await rpc_call(
        client,
        RpcRequest(
            "todo.trigger", dict(todo_id=todo_id),
            token=ctx.bootstrap_key, source="web",
        ),
    )
    assert blocked.status_code == 409
    await rpc_call(
        client,
        RpcRequest(
            "todo.set", dict(base, locked=False), token=dev_tok, source="local"
        ),
    )


async def check_cli_todo_and_trigger(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    env = dict(POCKET_URL=ctx.base_url, POCKET_TOKEN=ctx.bootstrap_key)
    add_cmd = [
        "todo", "add", "Manual trigger check @step2-bot 23:45",
        "--schedule", "daily", "--tz", "Asia/Shanghai", "--json",
    ]
    cli_todo = await run_cli(add_cmd, env, client)
    todo_id = cli_todo["todo_id"]
    await verify_locked_trigger_guard(ctx, client, todo_id)

    trig = await run_cli(["trigger", todo_id, "--json"], env, client)
    assert trig["status"] == "COMPLETED" and trig["http_status"] == 202
    await wait_for_todo_summary(
        client,
        ctx.bootstrap_key,
        todo_id,
        "Mock executed: Manual trigger check",
    )
    toggled = await run_cli(["todo", "toggle", todo_id, "--json"], env, client)
    assert toggled["enabled"] is False
    assert toggled["result_summary"] == "Mock executed: Manual trigger check"
    deleted = await run_cli(["todo", "delete", todo_id, "--json"], env, client)
    assert deleted["deleted"] is True


async def verify_scheduler_retry_callback_and_trigger(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    secret = "mock_sec_" + uuid4().hex
    state = MockAgentState(secret)
    server, task, sock, port = await start_mock_server(state)
    env = dict(POCKET_URL=ctx.base_url, POCKET_TOKEN=ctx.bootstrap_key)
    try:
        agent_cmd = [
            "agent", "set", "@step2-bot", "--url",
            "http://127.0.0.1:%d" % port, "--key", secret, "--json",
        ]
        await run_cli(agent_cmd, env, client)
        await check_scheduled_503_retry(ctx, client, state)
        await check_cli_todo_and_trigger(ctx, client)
    finally:
        await stop_mock_server(state, server, task, sock)


async def run_step2(ctx: EvalContext) -> list[str]:
    checks: list[str] = []
    async with httpx.AsyncClient(
        base_url=ctx.base_url, timeout=15.0
    ) as client:
        await verify_events_and_cli(ctx, client)
        checks.append("step2.events_recurrence_conflict_and_cli")

        await verify_cloud_locked(ctx, client)
        checks.append("step2.cloud_locked_409_vs_local_device_200")

        await verify_scheduler_retry_callback_and_trigger(ctx, client)
        checks.append("step2.mock_agent_503_retry_202_callback_and_trigger")
    return checks
