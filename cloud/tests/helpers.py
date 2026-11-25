import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
import socket
from uuid import uuid4

import httpx
import uvicorn


@dataclass(frozen=True)
class RpcCallSpec:
    params: dict | None = None
    token: str | None = "test-bootstrap-key"
    request_id: str | None = None
    source: str | None = None


class MutableClock:
    def __init__(self, initial: datetime):
        self.current = initial

    def __call__(self) -> datetime:
        return self.current

    def advance(self, seconds: int = 0, minutes: int = 0) -> datetime:
        delta = timedelta(seconds=seconds, minutes=minutes)
        self.current = self.current + delta
        return self.current


async def post_rpc(
    client, method: str, spec: RpcCallSpec | None = None
) -> httpx.Response:
    cfg = spec or RpcCallSpec()
    body = dict(params=cfg.params or dict())
    if cfg.request_id is not None:
        body["request_id"] = cfg.request_id
    if cfg.source is not None:
        body["source"] = cfg.source
    headers = dict(Authorization=f"Bearer {cfg.token}") if cfg.token else dict()
    return await client.post(f"/v1/rpc/{method}", json=body, headers=headers)


async def issue_device_pair(client, label: str = "Phone") -> tuple[str, str]:
    tag = uuid4().hex[:8]
    pair = await post_rpc(
        client, "pairing.create", RpcCallSpec(request_id=f"pair-{tag}")
    )
    code = pair.json()["data"]["code"]
    claimed = await post_rpc(
        client,
        "pairing.claim",
        RpcCallSpec(
            token=None,
            params=dict(code=code, name=label),
            request_id=f"claim-{tag}",
        ),
    )
    data = claimed.json()["data"]
    return data["token_id"], data["token"]


async def issue_device_token(client, label: str = "Phone") -> str:
    _, token = await issue_device_pair(client, label)
    return token


async def create_web_token(client, label: str = "Web") -> str:
    tag = uuid4().hex[:8]
    res = await post_rpc(
        client,
        "token.create",
        RpcCallSpec(
            params=dict(kind="web", label=label), request_id=f"web-{tag}"
        ),
    )
    return res.json()["data"]["token"]


async def register_agent(
    client, agent_id: str = "@bot", secret: str = "s3cr3t"
) -> None:
    params = dict(
        agent_id=agent_id,
        name="Bot",
        endpoint_url="http://127.0.0.1:18080",
        credential=secret,
    )
    res = await post_rpc(
        client,
        "agent.set",
        RpcCallSpec(params=params, request_id=f"agent-{agent_id}"),
    )
    assert res.status_code == 200


async def create_agent_token(client, label: str, scopes: list[str]) -> str:
    params = dict(kind="agent", label=label, scopes=scopes)
    res = await post_rpc(
        client,
        "token.create",
        RpcCallSpec(params=params, request_id=f"tok-{label}"),
    )
    return res.json()["data"]["token"]


@asynccontextmanager
async def attach_mock_http(app, handler):
    original = app.state.ctx.http_client
    mock_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app.state.ctx.http_client = mock_http
    try:
        yield mock_http
    finally:
        app.state.ctx.http_client = original
        await mock_http.aclose()


@asynccontextmanager
async def run_loopback_server(app):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(32)
    port = sock.getsockname()[1]
    config = uvicorn.Config(app, log_level="error", lifespan="off")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        while not server.started:
            await asyncio.sleep(0.01)
        yield "http://127.0.0.1:%d" % port
    finally:
        server.should_exit = True
        await asyncio.gather(task, return_exceptions=True)
        sock.close()
