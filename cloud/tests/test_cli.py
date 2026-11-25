from contextlib import asynccontextmanager
import json

import httpx
import pytest

from helpers import attach_mock_http, run_loopback_server
from pocket_cloud import cli as cli_mod
from pocket_cloud.cli import CliError, main as cli_main, run
from pocket_cloud.cli_sync import format_sync_push_line


def cli_env():
    return dict(
        POCKET_URL="http://test",
        POCKET_TOKEN="test-bootstrap-key",
    )


async def test_cli_pair_create_and_claim(client, capsys):
    await run(["pair", "create", "--json"], cli_env(), client)
    code = json.loads(capsys.readouterr().out)["code"]

    await run(
        ["pair", "claim", code, "--name", "CLI Phone", "--json"],
        cli_env(),
        client,
    )
    claimed = json.loads(capsys.readouterr().out)

    assert claimed["kind"] == "device"
    assert claimed["token"].startswith("pck_")


async def test_cli_token_and_agent_commands(client, capsys):
    await run(
        [
            "token", "create", "--kind", "agent", "--label", "CLI Agent",
            "--scopes", "event.read,todo.write", "--json",
        ],
        cli_env(),
        client,
    )
    token = json.loads(capsys.readouterr().out)

    await run(
        [
            "agent", "set", "@cli-agent", "--url",
            "https://agent.example.com", "--key", "secret", "--json",
        ],
        cli_env(),
        client,
    )
    capsys.readouterr()
    await run(["agent", "list", "--json"], cli_env(), client)
    agents = json.loads(capsys.readouterr().out)["agents"]
    await run(["token", "list", "--json"], cli_env(), client)
    tokens = json.loads(capsys.readouterr().out)["tokens"]

    assert token["scopes"] == ["event.read", "todo.write"]
    assert agents[0]["agent_id"] == "@cli-agent"
    assert "credential" not in agents[0]
    assert any(item["token_id"] == token["token_id"] for item in tokens)


async def test_cli_event_commands_and_validation(client, capsys):
    await run(
        ["event", "list", "--from", "2026-11-24", "--to", "2026-11-25"],
        cli_env(),
        client,
    )
    assert capsys.readouterr().out.strip() == "(empty)"

    with pytest.raises(CliError, match="INVALID_DATE"):
        await run(["event", "list", "--from", "not-a-date"], cli_env(), client)

    add_args = [
        "event", "add", "--date", "2026-11-24", "--start", "09:00",
        "--end", "10:30", "--title", "Design Review", "--location", "Room A",
        "--repeat", "daily", "--reminder", "alarm", "--json",
    ]
    await run(add_args, cli_env(), client)
    created = json.loads(capsys.readouterr().out)
    assert created["alarm_status"] == "QUEUED"

    await run(
        [
            "event", "list", "--from", "2026-11-24",
            "--to", "2026-11-26", "--json",
        ],
        cli_env(),
        client,
    )
    listed = json.loads(capsys.readouterr().out)["events"]
    assert len(listed) == 3

    del_ev = ["event", "delete", created["event_id"], "--json"]
    await run(del_ev, cli_env(), client)
    assert json.loads(capsys.readouterr().out)["deleted"] is True


async def test_cli_todo_inline_parsing_and_ergonomics(client, capsys):
    with pytest.raises(CliError, match="Schedule options require"):
        await run(
            ["todo", "add", "Plain task", "--schedule", "daily"],
            cli_env(),
            client,
        )

    alarm_args = [
        "todo", "add", "Wake up @me 07:30", "--date", "2026-11-25", "--json",
    ]
    await run(alarm_args, cli_env(), client)
    alarm_todo = json.loads(capsys.readouterr().out)
    assert alarm_todo["assignee"] == "@me"
    assert alarm_todo["text"] == "Wake up"
    assert alarm_todo["alarm_status"] == "QUEUED"

    await run(["todo", "list"], cli_env(), client)
    table_out = capsys.readouterr().out
    assert "Wake up" in table_out and "ttl_seconds" not in table_out

    tog_cmd = ["todo", "toggle", alarm_todo["todo_id"], "--json"]
    await run(tog_cmd, cli_env(), client)
    assert json.loads(capsys.readouterr().out)["done"] is True

    del_cmd = ["todo", "delete", alarm_todo["todo_id"], "--json"]
    await run(del_cmd, cli_env(), client)
    assert json.loads(capsys.readouterr().out)["deleted"] is True


async def test_cli_agent_todo_and_trigger_command(client, app, capsys):
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode()))
        return httpx.Response(202, json=dict(accepted=True))

    async with attach_mock_http(app, handler):
        await run(
            [
                "agent", "set", "@cli-bot", "--url",
                "http://127.0.0.1:9999", "--key", "cli-secret", "--json",
            ],
            cli_env(),
            client,
        )
        capsys.readouterr()
        await run(
            [
                "todo", "add", "Summarize PRs @cli-bot 16:00",
                "--schedule", "daily", "--tz", "Asia/Shanghai", "--json",
            ],
            cli_env(),
            client,
        )
        bot_todo = json.loads(capsys.readouterr().out)
        assert bot_todo["assignee"] == "@cli-bot"

        await run(["trigger", bot_todo["todo_id"], "--json"], cli_env(), client)
        trig = json.loads(capsys.readouterr().out)
        assert trig["status"] == "COMPLETED" and trig["http_status"] == 202
        assert captured[0]["prompt"] == "Summarize PRs"


class FakeWsConnection:
    def __init__(self, incoming: list[dict]):
        self.sent: list[dict] = []
        self._incoming = list(incoming)

    async def send(self, data: str) -> None:
        self.sent.append(json.loads(data))

    async def recv(self) -> str:
        return json.dumps(self._incoming.pop(0))


async def seed_cli_sync_entities(client, capsys) -> tuple[dict, dict]:
    await run(
        [
            "todo", "add", "Morning alarm @me 07:15",
            "--date", "2026-11-29", "--json",
        ],
        cli_env(),
        client,
    )
    todo = json.loads(capsys.readouterr().out)
    await run(
        [
            "event", "add", "--date", "2026-11-29", "--start", "08:00",
            "--end", "09:00", "--title", "Flight", "--reminder", "alarm",
            "--json",
        ],
        cli_env(),
        client,
    )
    ev = json.loads(capsys.readouterr().out)
    return todo, ev


async def assert_live_cli_watch(
    live_env: dict, todo_id: str, ev_id: str, capsys
) -> None:
    ack_only = await run(
        ["sync", "watch", "--from-seq", "0", "--limit", "0", "--json"],
        live_env,
    )
    assert capsys.readouterr().out == ""
    assert ack_only["replayed"] == 2 and ack_only["frames"] == []

    watched = await run(
        ["sync", "watch", "--from-seq", "0", "--limit", "2", "--json"],
        live_env,
    )
    lines = [
        json.loads(line)
        for line in capsys.readouterr().out.strip().splitlines()
    ]
    assert len(lines) == 2 and len(watched["frames"]) == 2
    assert [lines[0]["entity_id"], lines[1]["entity_id"]] == [todo_id, ev_id]

    await run(["sync", "watch", "--from-seq", "0", "--limit", "1"], live_env)
    text_line = capsys.readouterr().out.strip()
    assert todo_id in text_line and "QUEUED" in text_line


async def assert_live_cli_ack(
    live_env: dict, todo_id: str, ev_id: str, capsys
) -> None:
    await run(
        ["sync", "ack", todo_id, "--status", "EXECUTED", "--json"],
        live_env,
    )
    td_ack = json.loads(capsys.readouterr().out)
    assert td_ack["status"] == "EXECUTED" and td_ack["entity_type"] == "todo"

    await run(
        ["sync", "ack", ev_id, "--status", "MISSED", "--json"],
        live_env,
    )
    ev_ack = json.loads(capsys.readouterr().out)
    assert ev_ack["status"] == "MISSED" and ev_ack["entity_type"] == "event"

    with pytest.raises(CliError, match="Cannot infer entity type"):
        await run(
            ["sync", "ack", "raw_123", "--status", "EXECUTED"], live_env
        )


async def test_cli_sync_watch_and_ack_live_and_injected(client, app, capsys):
    todo, ev = await seed_cli_sync_entities(client, capsys)
    async with run_loopback_server(app) as base_url:
        live_env = dict(POCKET_URL=base_url, POCKET_TOKEN="test-bootstrap-key")
        await assert_live_cli_watch(
            live_env, todo["todo_id"], ev["event_id"], capsys
        )
        await assert_live_cli_ack(
            live_env, todo["todo_id"], ev["event_id"], capsys
        )

    fake_ws = FakeWsConnection(
        [dict(type="HELLO_ACK", latest_seq=9, replayed=0)]
    )

    @asynccontextmanager
    async def fake_connect(url: str):
        assert url == "wss://cloud.example.com/v1/link"
        yield fake_ws

    https_env = dict(POCKET_URL="https://cloud.example.com", POCKET_TOKEN="tok")
    injected = await run(
        ["--json", "sync", "watch", "--from-seq", "9", "--limit", "0"],
        https_env,
        ws_connect=fake_connect,
    )
    assert injected["latest_seq"] == 9
    assert fake_ws.sent[0] == dict(type="HELLO", token="tok", last_seq=9)


async def test_cli_sync_validation_and_custom_ack(capsys):
    with pytest.raises(CliError, match="--from-seq must be >= 0"):
        await run(["sync", "watch", "--from-seq", "-1"], cli_env())
    with pytest.raises(CliError, match="--limit must be >= 0"):
        await run(["sync", "watch", "--limit", "-1"], cli_env())
    with pytest.raises(CliError, match="POCKET_TOKEN is required"):
        await run(["sync", "watch"], dict(POCKET_URL="http://test"))

    fake_ack = FakeWsConnection(
        [
            dict(type="HELLO_ACK", latest_seq=4, replayed=0),
            dict(
                type="RECEIPT_ACK",
                entity_type="todo",
                entity_id="custom_1",
                status="FAILED",
                revision=2,
            ),
        ]
    )

    @asynccontextmanager
    async def ack_connect(url: str):
        _ = url
        yield fake_ack

    ack_out = await run(
        [
            "--json", "sync", "ack", "custom_1",
            "--entity", "todo", "--status", "FAILED",
        ],
        cli_env(),
        ws_connect=ack_connect,
    )
    assert json.loads(capsys.readouterr().out)["entity_id"] == "custom_1"
    assert ack_out["status"] == "FAILED"
    assert fake_ack.sent[0]["last_seq"] > 0


def test_cli_sync_formatting_and_interrupt(monkeypatch):
    del_line = format_sync_push_line(
        dict(
            seq=3,
            action="delete",
            entity_type="todo",
            entity_id="t1",
            revision=2,
        )
    )
    up_line = format_sync_push_line(
        dict(
            seq=4,
            action="upsert",
            entity_type="todo",
            entity_id="t1",
            revision=3,
            payload=dict(text="Line 1\nLine 2", alarm_status="EXECUTED"),
        )
    )
    assert del_line == "#3 delete todo t1 rev=2"
    assert "\n" not in up_line and "Line 1 Line 2" in up_line

    def raise_interrupt(coro):
        coro.close()
        raise KeyboardInterrupt

    monkeypatch.setattr(cli_mod.sys, "argv", ["pocket-cloud", "sync", "watch"])
    monkeypatch.setattr(cli_mod.asyncio, "run", raise_interrupt)
    with pytest.raises(SystemExit) as exit_exc:
        cli_main()
    assert exit_exc.value.code == 130
