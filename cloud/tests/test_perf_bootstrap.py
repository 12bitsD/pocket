import asyncio
from contextlib import asynccontextmanager
import random
import time

import httpx

from pocket_cloud.calendar_svc import annotate_conflicts
from pocket_cloud.scheduler import run_scheduler_tick

from .helpers import (
    RpcCallSpec,
    attach_mock_http,
    create_agent_token,
    post_rpc,
    register_agent,
)


class CheckoutCountingPool:
    def __init__(self, inner):
        self._inner = inner
        self.checkouts = 0

    @asynccontextmanager
    async def connection(self):
        self.checkouts += 1
        async with self._inner.connection() as conn:
            yield conn


def naive_conflicts(instances: list[dict]) -> list[bool]:
    ordered = sorted(
        instances,
        key=lambda item: (
            item["instance_date"],
            item["start_hhmm"],
            item["end_hhmm"],
            item["event_id"],
        ),
    )
    flags = []
    for target in ordered:
        day = target["instance_date"]
        hit = any(
            other is not target
            and other["instance_date"] == day
            and target["start_hhmm"] < other["end_hhmm"]
            and other["start_hhmm"] < target["end_hhmm"]
            for other in ordered
        )
        flags.append(hit)
    return flags


def make_random_instance(rng: random.Random, idx: int) -> dict:
    day = "2026-11-%02d" % rng.randint(24, 26)
    start_min = rng.randint(0, 22 * 60)
    dur_min = rng.choice((15, 30, 45, 60, 120, 240))
    end_min = min(23 * 60 + 59, start_min + dur_min)
    s_hhmm = "%02d:%02d" % (start_min // 60, start_min % 60)
    e_hhmm = "%02d:%02d" % (end_min // 60, end_min % 60)
    return dict(
        event_id="evt_%d" % idx,
        instance_date=day,
        start_hhmm=s_hhmm,
        end_hhmm=e_hhmm,
    )


def test_linear_annotate_conflicts_matches_oracle():
    rng = random.Random(20261124)
    for trial in range(120):
        count = rng.randint(0, 35)
        raw = [make_random_instance(rng, idx) for idx in range(count)]
        expected = naive_conflicts([dict(item) for item in raw])
        actual = [
            item["has_conflict"]
            for item in annotate_conflicts([dict(item) for item in raw])
        ]
        assert actual == expected, "Mismatch at trial %d" % trial


async def seed_bootstrap_entities(client) -> None:
    await register_agent(client, "@perf-bot", "sec_perf")
    ev_old = dict(
        event_date="2024-01-10",
        start_hhmm="09:00",
        end_hhmm="10:00",
        title="Ancient One-Off",
        repeat_rule="none",
    )
    ev_rep = dict(
        event_date="2026-11-01",
        start_hhmm="08:30",
        end_hhmm="09:00",
        title="Daily Standup",
        repeat_rule="daily",
    )
    await post_rpc(
        client, "event.set", RpcCallSpec(params=ev_old, request_id="p-ev-old")
    )
    await post_rpc(
        client, "event.set", RpcCallSpec(params=ev_rep, request_id="p-ev-rep")
    )
    td_params = dict(text="Perf Todo", assignee="none")
    await post_rpc(
        client, "todo.set", RpcCallSpec(params=td_params, request_id="p-td-1")
    )


async def test_sync_bootstrap_and_write_single_checkout(app, client):
    await seed_bootstrap_entities(client)
    real_pool = app.state.ctx.pool
    counting = CheckoutCountingPool(real_pool)
    app.state.ctx.pool = counting
    try:
        res = await post_rpc(
            client,
            "sync.bootstrap",
            RpcCallSpec(
                params=dict(start_date="2026-11-24", end_date="2026-11-26")
            ),
        )
        assert res.status_code == 200
        assert counting.checkouts == 1
        data = res.json()["data"]
        assert data["identity"]["kind"] == "bootstrap"
        assert data["latest_seq"] >= 3
        assert [x["title"] for x in data["events"]] == [
            "Daily Standup",
            "Daily Standup",
            "Daily Standup",
        ]
        assert len(data["todos"]) == 1
        assert len(data["agents"]) == 1
        assert len(data["tokens"]) >= 1

        w_res = await post_rpc(
            client,
            "todo.set",
            RpcCallSpec(
                params=dict(text="Single Tx Write", assignee="none"),
                request_id="p-single-tx",
            ),
        )
        assert w_res.status_code == 200
        assert counting.checkouts == 2
    finally:
        app.state.ctx.pool = real_pool


async def test_sync_bootstrap_respects_agent_scopes(client):
    await seed_bootstrap_entities(client)
    ev_tok = await create_agent_token(client, "@perf-bot:ev", ["event.read"])
    td_tok = await create_agent_token(client, "@perf-bot:td", ["todo.read"])

    ev_res = await post_rpc(
        client,
        "sync.bootstrap",
        RpcCallSpec(
            token=ev_tok,
            params=dict(start_date="2026-11-24", end_date="2026-11-24"),
        ),
    )
    ev_data = ev_res.json()["data"]
    assert ev_data["latest_seq"] == 0
    assert len(ev_data["events"]) == 1
    assert ev_data["todos"] == []
    assert ev_data["agents"] == []
    assert ev_data["tokens"] == []

    td_res = await post_rpc(
        client, "sync.bootstrap", RpcCallSpec(token=td_tok)
    )
    td_data = td_res.json()["data"]
    assert td_data["events"] == []
    assert len(td_data["todos"]) == 1


async def test_gzip_compression_for_large_bootstrap(client):
    for idx in range(25):
        params = dict(
            text="Compressible Todo Item Number %03d — Paper Teletype" % idx,
            assignee="none",
        )
        await post_rpc(
            client,
            "todo.set",
            RpcCallSpec(params=params, request_id="gz-td-%d" % idx),
        )
    headers = dict(
        Authorization="Bearer test-bootstrap-key",
        **{"Accept-Encoding": "gzip"},
    )
    resp = await client.post(
        "/v1/rpc/sync.bootstrap", json=dict(params=dict()), headers=headers
    )
    assert resp.status_code == 200
    assert resp.headers.get("content-encoding") == "gzip"
    assert len(resp.json()["data"]["todos"]) == 25


async def test_scheduler_dispatches_webhooks_concurrently(app, client):
    await register_agent(client, "@parallel-bot", "sec_par")
    now = app.state.ctx.clock()
    due_date = now.date().isoformat()
    for idx in range(4):
        params = dict(
            text="Parallel Task %d" % idx,
            assignee="@parallel-bot",
            schedule_kind="once",
            once_date=due_date,
            time_hhmm="00:00",
            timezone="UTC",
        )
        await post_rpc(
            client,
            "todo.set",
            RpcCallSpec(params=params, request_id="par-td-%d" % idx),
        )

    async def slow_webhook(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.08)
        return httpx.Response(202, json=dict(accepted=True))

    async with attach_mock_http(app, slow_webhook):
        started = time.perf_counter()
        await run_scheduler_tick(app.state.ctx)
        elapsed = time.perf_counter() - started
    assert elapsed < 0.24
