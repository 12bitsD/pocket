from datetime import datetime, timezone
import json
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
import pytest

from pocket_cloud.qr_util import encode_qr_matrix, qr_to_svg, qr_to_terminal


async def call_rpc(client, settings, method: str, params: dict):
    headers = {"Authorization": f"Bearer {settings.bootstrap_key}"}
    body = dict(params=params, request_id=f"req_{uuid4().hex}")
    return await client.post(f"/v1/rpc/{method}", json=body, headers=headers)


def handle_feishu_mock(request: httpx.Request, state: dict) -> httpx.Response:
    path = request.url.path
    if path.endswith("/auth/v3/app_access_token/internal"):
        return httpx.Response(200, json=dict(code=0, app_access_token="app_t"))
    if path.endswith("/authen/v1/oidc/access_token"):
        data = dict(access_token="u_1", refresh_token="r_1", expires_in=7200)
        return httpx.Response(200, json=dict(code=0, data=data))
    if path.endswith("/calendar/v4/calendars/primary"):
        cal = dict(calendar=dict(calendar_id="cal_feishu"))
        payload = dict(code=0, data=dict(calendars=[cal]))
        return httpx.Response(200, json=payload)
    if path.endswith("/calendar/v4/calendars/cal_feishu/events"):
        if request.method == "GET":
            return httpx.Response(
                200, json=dict(code=0, data=dict(items=state["items"]))
            )
        state["pushed"].append(json.loads(request.content.decode()))
        ev = dict(event_id="fsh_created_1")
        return httpx.Response(200, json=dict(code=0, data=dict(event=ev)))
    if "/events/fsh_created_1" in path and request.method == "DELETE":
        state["deleted"].append("fsh_created_1")
        return httpx.Response(200, json=dict(code=0, data=dict()))
    return httpx.Response(404, json=dict(code=404, msg="not found"))


@pytest.mark.asyncio
async def test_todo_tags_and_qr_pairing_rpc(client, settings):
    created = await call_rpc(
        client,
        settings,
        "todo.set",
        dict(text="整理周报", assignee="none", tags=["#工作", "项目", "工作"]),
    )
    assert created.status_code == 200
    todo = created.json()["data"]
    assert todo["tags"] == ["工作", "项目"]

    listed = await call_rpc(client, settings, "todo.list", dict())
    todos = listed.json()["data"]["todos"]
    found = [t for t in todos if t["todo_id"] == todo["todo_id"]]
    assert found[0]["tags"] == ["工作", "项目"]

    pair = await call_rpc(client, settings, "pairing.create", dict())
    pdata = pair.json()["data"]
    assert pdata["pair_uri"].startswith("pocket://pair?url=")
    assert f"code={pdata['code']}" in pdata["pair_uri"]
    assert pdata["qr_svg"].startswith("<svg")
    assert len(encode_qr_matrix(pdata["pair_uri"])) in (29, 33, 37, 41)
    assert "viewBox" in qr_to_svg(pdata["pair_uri"])
    assert qr_to_terminal(pdata["pair_uri"]).strip() != ""


async def assert_feishu_roundtrip(client, settings, mock_state: dict) -> None:
    cfg = await call_rpc(
        client,
        settings,
        "integration.feishu.configure",
        dict(app_id="cli_test123", app_secret="sec_feishu_xyz"),
    )
    assert cfg.json()["data"]["configured"] is True
    auth = await call_rpc(
        client, settings, "integration.feishu.auth_url", dict()
    )
    state_val = parse_qs(urlparse(auth.json()["data"]["auth_url"]).query)[
        "state"
    ][0]
    cb = await client.get(
        "/v1/integrations/feishu/callback",
        params=dict(code="oauth_code_1", state=state_val),
    )
    assert cb.status_code == 200 and "已绑定飞书日历" in cb.text
    ev_list = await call_rpc(
        client,
        settings,
        "event.list",
        dict(start_date="2026-10-14", end_date="2026-10-16"),
    )
    assert "飞书产品评审" in [e["title"] for e in ev_list.json()["data"]["events"]]

    created = await call_rpc(
        client,
        settings,
        "event.set",
        dict(
            event_date="2026-10-15",
            start_hhmm="14:00",
            end_hhmm="15:00",
            title="Pocket 双向回写测试",
        ),
    )
    assert mock_state["pushed"][0]["summary"] == "Pocket 双向回写测试"
    ev_id = created.json()["data"]["event_id"]
    del_res = await call_rpc(
        client, settings, "event.delete", dict(event_id=ev_id)
    )
    assert del_res.status_code == 200
    assert mock_state["deleted"] == ["fsh_created_1"]
    unbind = await call_rpc(
        client, settings, "integration.feishu.unbind", dict()
    )
    assert unbind.json()["data"]["connected"] is False


@pytest.mark.asyncio
async def test_feishu_oauth_and_two_way_sync(app, client, settings):
    start_ts = int(
        datetime(2026, 10, 15, 2, 0, tzinfo=timezone.utc).timestamp()
    )
    end_ts = int(
        datetime(2026, 10, 15, 3, 0, tzinfo=timezone.utc).timestamp()
    )
    mock_state = dict(
        items=[
            dict(
                event_id="fsh_ev_1",
                summary="飞书产品评审",
                location=dict(name="A301"),
                start_time=dict(timestamp=str(start_ts)),
                end_time=dict(timestamp=str(end_ts)),
                etag="etag_1",
            )
        ],
        pushed=[],
        deleted=[],
    )
    mock_http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda req: handle_feishu_mock(req, mock_state)
        )
    )
    old_http = app.state.ctx.http_client
    app.state.ctx.http_client = mock_http
    try:
        await assert_feishu_roundtrip(client, settings, mock_state)
    finally:
        app.state.ctx.http_client = old_http
        await mock_http.aclose()
