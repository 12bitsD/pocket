from __future__ import annotations

from pathlib import Path
import re
from uuid import uuid4

import httpx

from eval_step1 import EvalContext, RpcRequest, rpc_call
from eval_step2 import MockAgentState, start_mock_server, stop_mock_server
from eval_step3 import build_ws_url, issue_web_token, open_synced_ws, ws_recv

ASSET_ATTR_RE = re.compile(r"""(?:src|href)=["']([^"']+)["']""")


def verify_dist_bundle() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dist_dir = repo_root / "apps" / "calendar" / "dist"
    index_path = dist_dir / "index.html"
    assert index_path.is_file(), "Missing apps/calendar/dist/index.html"
    html = index_path.read_text(encoding="utf-8")
    assert "./src/main.js" not in html
    assert "../../packages/" not in html
    refs = ASSET_ATTR_RE.findall(html)
    assert len(refs) >= 2, "Expected bundled JS and CSS refs in dist/index.html"
    js_count = 0
    css_count = 0
    for ref in refs:
        assert not ref.startswith("/"), "Asset path must be relative: " + ref
        clean_ref = ref[2:] if ref.startswith("./") else ref
        asset_path = (dist_dir / clean_ref).resolve()
        assert asset_path.is_file(), "Missing bundled asset: " + ref
        assert asset_path.stat().st_size > 0
        if asset_path.suffix == ".js":
            js_count += 1
        elif asset_path.suffix == ".css":
            css_count += 1
    assert js_count >= 1 and css_count >= 1


async def verify_cors_preflight(client: httpx.AsyncClient) -> None:
    headers = dict(
        (
            ("Origin", "http://localhost:5173"),
            ("Access-Control-Request-Method", "POST"),
            ("Access-Control-Request-Headers", "Authorization, Content-Type"),
        )
    )
    resp = await client.options("/v1/rpc/todo.set", headers=headers)
    assert resp.status_code == 200
    allow_origin = resp.headers.get("access-control-allow-origin", "")
    allow_headers = resp.headers.get("access-control-allow-headers", "").lower()
    assert allow_origin in ("*", "http://localhost:5173")
    assert "authorization" in allow_headers
    assert "content-type" in allow_headers


async def wait_for_ws_summary(
    ws, todo_id: str, expected_summary: str
) -> dict:
    for _ in range(25):
        frame = await ws_recv(ws, timeout=5.0)
        matched = (
            frame.get("type") == "SYNC_PUSH"
            and frame.get("entity_type") == "todo"
            and frame.get("entity_id") == todo_id
            and frame.get("payload", dict()).get("result_summary")
            == expected_summary
        )
        if matched:
            return frame["payload"]
    raise AssertionError("Did not receive live SYNC_PUSH with result_summary")


async def setup_web_agent_todo(
    client: httpx.AsyncClient, web_tok: str, port: int, secret: str
) -> str:
    agent_res = await rpc_call(
        client,
        RpcRequest(
            "agent.set",
            dict(
                agent_id="@web-agent",
                name="Step4 Web Agent",
                endpoint_url="http://127.0.0.1:%d" % port,
                credential=secret,
            ),
            token=web_tok,
            source="web",
        ),
    )
    assert agent_res.status_code == 200
    todo_res = await rpc_call(
        client,
        RpcRequest(
            "todo.set",
            dict(
                text="Step4 browser dispatch",
                assignee="@web-agent",
                schedule_kind="daily",
                time_hhmm="23:50",
                timezone="Asia/Shanghai",
            ),
            token=web_tok,
            source="web",
        ),
    )
    assert todo_res.status_code == 200
    return todo_res.json()["data"]["todo_id"]


async def run_web_agent_flow(
    ctx: EvalContext, client: httpx.AsyncClient, port: int, secret: str
) -> None:
    web_tok = await issue_web_token(ctx, client, "Step4WebConsole")
    ws_url = build_ws_url(ctx.base_url)
    web_ws, _, ack = await open_synced_ws(ws_url, web_tok, 0)
    try:
        todo_id = await setup_web_agent_todo(client, web_tok, port, secret)
        trig_res = await rpc_call(
            client,
            RpcRequest(
                "todo.trigger",
                dict(todo_id=todo_id),
                token=web_tok,
                source="web",
            ),
        )
        assert trig_res.status_code == 200
        pushed = await wait_for_ws_summary(
            web_ws, todo_id, "Mock executed: Step4 browser dispatch"
        )
        assert pushed["last_delivery_status"] == "COMPLETED"
        assert ack["latest_seq"] >= 0
    finally:
        await web_ws.close()


async def verify_web_agent_live_push(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    secret = "step4_sec_" + uuid4().hex
    state = MockAgentState(secret)
    server, task, sock, port = await start_mock_server(state)
    try:
        await run_web_agent_flow(ctx, client, port, secret)
    finally:
        await stop_mock_server(state, server, task, sock)


async def run_step4(ctx: EvalContext) -> list[str]:
    checks: list[str] = []
    verify_dist_bundle()
    checks.append("step4.vite_dist_bundle_integrity")

    async with httpx.AsyncClient(
        base_url=ctx.base_url, timeout=15.0
    ) as client:
        await verify_cors_preflight(client)
        checks.append("step4.cors_preflight_options_rpc")

        await verify_web_agent_live_push(ctx, client)
        checks.append("step4.web_ws_agent_trigger_and_live_callback_sync")
    return checks
