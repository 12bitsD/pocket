import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json

import httpx
from httpx import ASGITransport, AsyncClient

from helpers import (
    MutableClock,
    RpcCallSpec,
    attach_mock_http,
    create_agent_token,
    issue_device_token,
    post_rpc,
    register_agent,
)
from pocket_cloud.app import create_app
from pocket_cloud.scheduler import (
    dispatch_due_deliveries,
    expand_due_todos,
    run_scheduler_tick,
)


async def test_scopes_and_source_validation(client):
    bad_src = await post_rpc(
        client, "auth.status", RpcCallSpec(source="desktop")
    )
    assert bad_src.status_code == 422
    assert bad_src.json()["error"]["code"] == "INVALID_SOURCE"

    ev_reader = await create_agent_token(client, "ER", ["event.read"])
    ok_read = await post_rpc(
        client,
        "event.list",
        RpcCallSpec(
            token=ev_reader,
            params=dict(start_date="2026-11-23", end_date="2026-11-24"),
        ),
    )
    deny_write = await post_rpc(
        client,
        "event.set",
        RpcCallSpec(
            token=ev_reader,
            params=dict(
                event_date="2026-11-23",
                start_hhmm="09:00",
                end_hhmm="10:00",
                title="Blocked",
            ),
            request_id="ev-blocked",
        ),
    )
    assert ok_read.status_code == 200 and deny_write.status_code == 403


async def test_token_isolated_idempotency(client):
    td_writer = await create_agent_token(client, "TW", ["todo.write"])
    deny_list = await post_rpc(
        client, "todo.list", RpcCallSpec(token=td_writer)
    )
    assert deny_list.status_code == 403

    ok_todo = await post_rpc(
        client,
        "todo.set",
        RpcCallSpec(
            token=td_writer,
            source="agent",
            params=dict(text="Created by agent"),
            request_id="shared-req-id",
        ),
    )
    cross = await post_rpc(
        client,
        "todo.set",
        RpcCallSpec(
            source="agent",
            params=dict(text="Created by agent"),
            request_id="shared-req-id",
        ),
    )
    assert ok_todo.status_code == 200 and cross.status_code == 409


async def seed_recurrence_events(client) -> dict:
    standup = (
        await post_rpc(
            client,
            "event.set",
            RpcCallSpec(
                source="web",
                params=dict(
                    event_date="2026-11-23",
                    start_hhmm="09:00",
                    end_hhmm="09:30",
                    title="Standup",
                    repeat_rule="weekdays",
                    reminder_policy="alarm",
                ),
                request_id="ev-standup",
            ),
        )
    ).json()["data"]
    await post_rpc(
        client,
        "event.set",
        RpcCallSpec(
            params=dict(
                event_date="2026-11-24",
                start_hhmm="09:15",
                end_hhmm="10:00",
                title="Overlap Call",
            ),
            request_id="ev-overlap",
        ),
    )
    await post_rpc(
        client,
        "event.set",
        RpcCallSpec(
            params=dict(
                event_date="2026-11-24",
                start_hhmm="10:00",
                end_hhmm="10:30",
                title="Adjacent Review",
                repeat_rule="weekly",
            ),
            request_id="ev-weekly",
        ),
    )
    return standup


async def test_event_recurrence_and_overlap_conflicts(client):
    too_wide = await post_rpc(
        client,
        "event.list",
        RpcCallSpec(
            params=dict(start_date="2026-01-01", end_date="2026-03-06")
        ),
    )
    assert too_wide.status_code == 422

    standup = await seed_recurrence_events(client)
    assert standup["alarm_status"] == "QUEUED" and standup["source"] == "web"

    listed = (
        await post_rpc(
            client,
            "event.list",
            RpcCallSpec(
                params=dict(start_date="2026-11-23", end_date="2026-12-01")
            ),
        )
    ).json()["data"]["events"]
    nov24 = [item for item in listed if item["instance_date"] == "2026-11-24"]
    assert [item["has_conflict"] for item in nov24] == [True, True, False]
    weekend = [
        item
        for item in listed
        if item["instance_date"] in ("2026-11-28", "2026-11-29")
    ]
    assert weekend == []
    assert len([i for i in listed if i["instance_date"] == "2026-12-01"]) == 2


async def test_event_optimistic_revisions_and_soft_delete(client):
    init_params = dict(
        event_date="2026-11-23", start_hhmm="09:00", end_hhmm="09:30",
        title="Kickoff", reminder_policy="alarm",
    )
    ev = (
        await post_rpc(
            client, "event.set",
            RpcCallSpec(params=init_params, request_id="ev-rev-1"),
        )
    ).json()["data"]
    base_fields = dict(
        event_id=ev["event_id"], event_date="2026-11-23", start_hhmm="09:00",
        end_hhmm="09:45", title="Kickoff 2", reminder_policy="notify",
    )
    stale = await post_rpc(
        client, "event.set",
        RpcCallSpec(
            params=dict(base_revision=9, **base_fields), request_id="ev-stale"
        ),
    )
    assert stale.status_code == 409

    upd = (
        await post_rpc(
            client, "event.set",
            RpcCallSpec(
                params=dict(base_revision=1, **base_fields), request_id="ev-upd"
            ),
        )
    ).json()["data"]
    assert upd["revision"] == 2 and upd["alarm_status"] == "NONE"

    del_spec = RpcCallSpec(
        params=dict(event_id=ev["event_id"], base_revision=2),
        request_id="ev-del-ok",
    )
    assert (await post_rpc(client, "event.delete", del_spec)).status_code == 200
    after_del = RpcCallSpec(
        params=dict(base_revision=1, **base_fields),
        request_id="ev-upd-after-del",
    )
    assert (await post_rpc(client, "event.set", after_del)).status_code == 404


async def assert_web_cannot_touch_locked(
    client, web_tok: str, todo_id: str
) -> None:
    cases = (
        ("upd", "todo.set", dict(text="Tamper", locked=False)),
        ("tog", "todo.toggle", dict()),
        ("trig", "todo.trigger", dict()),
        ("del", "todo.delete", dict()),
    )
    for action, method, extra in cases:
        res = await post_rpc(
            client,
            method,
            RpcCallSpec(
                token=web_tok,
                source="web",
                params=dict(todo_id=todo_id, **extra),
                request_id="tamper-" + action,
            ),
        )
        assert res.status_code == 409
        assert res.json()["error"]["code"] == "CLOUD_LOCKED"


async def test_device_locked_rule_blocks_non_local_including_trigger(
    client, app
):
    await register_agent(client, "@bot")
    device_tok = await issue_device_token(client, "Pixel9")
    web_res = await post_rpc(
        client, "token.create",
        RpcCallSpec(params=dict(kind="web", label="Web"), request_id="tok-web"),
    )
    web_tok = web_res.json()["data"]["token"]

    deny_spec = RpcCallSpec(
        token=web_tok, source="web",
        params=dict(text="Secret", locked=True), request_id="lock-deny-web",
    )
    assert (await post_rpc(client, "todo.set", deny_spec)).status_code == 409

    lock_params = dict(
        text="Locked agent job", assignee="@bot",
        schedule_kind="daily", time_hhmm="07:00", locked=True,
    )
    created = await post_rpc(
        client, "todo.set",
        RpcCallSpec(
            token=device_tok, source="local",
            params=lock_params, request_id="lock-ok-dev",
        ),
    )
    todo_id = created.json()["data"]["todo_id"]
    await assert_web_cannot_touch_locked(client, web_tok, todo_id)

    async with attach_mock_http(app, lambda req: httpx.Response(202)):
        trig_spec = RpcCallSpec(
            token=device_tok, source="local",
            params=dict(todo_id=todo_id), request_id="dev-trig-ok",
        )
        trig_res = await post_rpc(client, "todo.trigger", trig_spec)
        assert trig_res.status_code == 200


async def test_todo_cron_sunday_and_once_rollover(client, app):
    clock = MutableClock(datetime(2026, 11, 22, 9, 0, tzinfo=timezone.utc))
    app.state.ctx.clock = clock
    await register_agent(client, "@bot")

    sun_params = dict(
        text="Sunday review", assignee="@bot", schedule_kind="weekly",
        time_hhmm="18:00", weekly_dow=0, timezone="Asia/Shanghai",
    )
    sunday = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(params=sun_params, request_id="todo-sun"),
        )
    ).json()["data"]
    assert sunday["next_fire_at"] == "2026-11-22T10:00:00+00:00"

    roll_params = dict(
        text="Past time rolls", assignee="@me", schedule_kind="once",
        time_hhmm="16:00", timezone="Asia/Shanghai",
    )
    rolled = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(params=roll_params, request_id="todo-roll"),
        )
    ).json()["data"]
    assert rolled["once_date"] == "2026-11-23"

    tog_spec = RpcCallSpec(
        params=dict(todo_id=rolled["todo_id"]), request_id="tog-once"
    )
    done_todo = (await post_rpc(client, "todo.toggle", tog_spec)).json()["data"]
    assert done_todo["done"] is True and done_todo["enabled"] is False


async def make_early_callback_handler(client):
    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        dlv_url = f"/v1/deliveries/{body['delivery_id']}/result"
        headers = dict(Authorization=f"Bearer {body['callback_token']}")
        cbk_res = await client.post(
            dlv_url,
            headers=headers,
            json=dict(result_summary="Early summary before 202"),
        )
        assert cbk_res.status_code == 200
        assert list(cbk_res.json().keys()) == ["data"]
        replay = await client.post(
            dlv_url, headers=headers, json=dict(result_summary="Overwrite")
        )
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "DELIVERY_ALREADY_COMPLETED"
        return httpx.Response(202)

    return handler


async def test_callback_single_use_and_preserve_on_edit(client, app):
    app.state.ctx.clock = MutableClock(
        datetime(2026, 11, 24, 8, 0, tzinfo=timezone.utc)
    )
    await register_agent(client, "@bot", "agent-bearer-key")

    base_params = dict(
        text="Cluster check", assignee="@bot", schedule_kind="daily",
        time_hhmm="16:05", timezone="Asia/Shanghai", ttl_seconds=120,
    )
    todo_id = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(params=base_params, request_id="todo-cbk"),
        )
    ).json()["data"]["todo_id"]

    async with attach_mock_http(app, await make_early_callback_handler(client)):
        trig_res = await post_rpc(
            client, "todo.trigger",
            RpcCallSpec(params=dict(todo_id=todo_id), request_id="trig-early"),
        )
        assert trig_res.status_code == 200

    edited = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(
                params=dict(base_params, todo_id=todo_id, text="Renamed"),
                request_id="todo-cbk-rename",
            ),
        )
    ).json()["data"]
    assert edited["result_summary"] == "Early summary before 202"


async def verify_failed_delivery_blocks_callback(client, todo_id, captured):
    trig_spec = RpcCallSpec(
        params=dict(todo_id=todo_id), request_id="trig-400-cbk"
    )
    await post_rpc(client, "todo.trigger", trig_spec)
    cbk_hdr = dict(Authorization=f"Bearer {captured[1]['callback_token']}")
    failed_cbk = await client.post(
        f"/v1/deliveries/{captured[1]['delivery_id']}/result",
        headers=cbk_hdr,
        json=dict(result_summary="Resurrect"),
    )
    assert failed_cbk.status_code == 409
    assert failed_cbk.json()["error"]["code"] == "DELIVERY_FAILED"


async def test_expired_callback_persists_status_and_failed_blocks_callback(
    client, app
):
    clock = MutableClock(datetime(2026, 11, 24, 8, 0, tzinfo=timezone.utc))
    app.state.ctx.clock = clock
    await register_agent(client, "@bot")

    ttl_params = dict(
        text="TTL test", assignee="@bot", schedule_kind="once",
        time_hhmm="16:00", once_date="2026-11-24",
        timezone="Asia/Shanghai", ttl_seconds=60,
    )
    todo = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(params=ttl_params, request_id="todo-ttl-exp"),
        )
    ).json()["data"]
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode()))
        return httpx.Response(503 if len(captured) == 1 else 400)

    async with attach_mock_http(app, handler):
        await expand_due_todos(app.state.ctx)
        await dispatch_due_deliveries(app.state.ctx)
        clock.advance(seconds=65)
        cbk_hdr = dict(Authorization=f"Bearer {captured[0]['callback_token']}")
        late = await client.post(
            f"/v1/deliveries/{captured[0]['delivery_id']}/result",
            headers=cbk_hdr,
            json=dict(result_summary="Too late"),
        )
        assert late.status_code == 409
        listed = (await post_rpc(client, "todo.list")).json()["data"]["todos"]
        assert listed[0]["last_delivery_status"] == "EXPIRED"
        await verify_failed_delivery_blocks_callback(
            client, todo["todo_id"], captured
        )


async def verify_revoked_agent_rejects_trigger(client, todo_id: str) -> None:
    rev_spec = RpcCallSpec(params=dict(agent_id="@bot"), request_id="rev-bot")
    await post_rpc(client, "agent.revoke", rev_spec)
    trig_inact = RpcCallSpec(
        params=dict(todo_id=todo_id), request_id="trig-inactive"
    )
    res = await post_rpc(client, "todo.trigger", trig_inact)
    assert res.status_code == 422


async def test_cancel_dispatching_and_revoked_agent_handling(client, app):
    clock = MutableClock(datetime(2026, 11, 24, 7, 59, tzinfo=timezone.utc))
    app.state.ctx.clock = clock
    await register_agent(client, "@bot")

    todo_id = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(
                params=dict(
                    text="In-flight cancel", assignee="@bot",
                    schedule_kind="daily", time_hhmm="16:00",
                    timezone="Asia/Shanghai",
                ),
                request_id="todo-inflight",
            ),
        )
    ).json()["data"]["todo_id"]
    clock.advance(minutes=1)
    dlv_id = (await expand_due_todos(app.state.ctx))[0]
    in_flight, proceed = asyncio.Event(), asyncio.Event()

    async def slow_503(request: httpx.Request) -> httpx.Response:
        in_flight.set()
        await proceed.wait()
        return httpx.Response(503)

    async with attach_mock_http(app, slow_503):
        task = asyncio.create_task(dispatch_due_deliveries(app.state.ctx))
        await in_flight.wait()
        await post_rpc(
            client, "todo.toggle",
            RpcCallSpec(params=dict(todo_id=todo_id), request_id="tog-cancel"),
        )
        proceed.set()
        await task

    async with app.state.ctx.pool.connection() as conn:
        cur = await conn.execute(
            "SELECT status FROM deliveries WHERE delivery_id = %s", (dlv_id,)
        )
        assert (await cur.fetchone())[0] == "CANCELLED"
    await verify_revoked_agent_rejects_trigger(client, todo_id)


async def test_scheduler_skip_next_and_rearm_cancelled_slot(client, app):
    clock = MutableClock(datetime(2026, 11, 24, 7, 50, tzinfo=timezone.utc))
    app.state.ctx.clock = clock
    await register_agent(client, "@bot")

    skip_params = dict(
        text="Skip first", assignee="@bot", schedule_kind="daily",
        time_hhmm="16:00", timezone="Asia/Shanghai", skip_next=True,
    )
    created = (
        await post_rpc(
            client, "todo.set",
            RpcCallSpec(params=skip_params, request_id="todo-skip"),
        )
    ).json()["data"]
    clock.advance(minutes=10)
    assert await expand_due_todos(app.state.ctx) == []
    skipped = (await post_rpc(client, "todo.list")).json()["data"]["todos"][0]
    assert skipped["skip_next"] is False and skipped["revision"] == 2

    clock.current = datetime(2026, 11, 25, 8, 0, tzinfo=timezone.utc)
    assert len(await expand_due_todos(app.state.ctx)) == 1
    tog_off = RpcCallSpec(
        params=dict(todo_id=created["todo_id"]), request_id="tog-off"
    )
    await post_rpc(client, "todo.toggle", tog_off)
    resave = dict(skip_params, todo_id=created["todo_id"], skip_next=False)
    clock.current = datetime(2026, 11, 24, 23, 0, tzinfo=timezone.utc)
    await post_rpc(
        client, "todo.set", RpcCallSpec(params=resave, request_id="resave-same")
    )
    clock.current = datetime(2026, 11, 25, 8, 0, tzinfo=timezone.utc)
    assert len(await expand_due_todos(app.state.ctx)) == 1


async def test_live_background_scheduler_loop(settings):
    live_settings = replace(
        settings, scheduler_enabled=True, scheduler_interval=0.05
    )
    live_app = create_app(live_settings)
    received = asyncio.Event()

    def ok_handler(request: httpx.Request) -> httpx.Response:
        received.set()
        return httpx.Response(200, json=dict(ok=True))

    async with live_app.router.lifespan_context(live_app):
        async with attach_mock_http(live_app, ok_handler):
            transport = ASGITransport(app=live_app)
            async with AsyncClient(
                transport=transport, base_url="http://test"
            ) as live_client:
                await register_agent(live_client, "@live-bot")
                past = datetime.now(timezone.utc) - timedelta(minutes=1)
                due_params = dict(
                    text="Live tick", assignee="@live-bot",
                    schedule_kind="once", time_hhmm=past.strftime("%H:%M"),
                    once_date=past.date().isoformat(), timezone="UTC",
                )
                await post_rpc(
                    live_client, "todo.set",
                    RpcCallSpec(params=due_params, request_id="live-tick-1"),
                )
                await asyncio.wait_for(received.wait(), timeout=3.0)
                await run_scheduler_tick(live_app.state.ctx)
