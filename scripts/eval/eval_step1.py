from __future__ import annotations

from dataclasses import dataclass
import json
import re
from uuid import uuid4

import httpx
import psycopg

from pocket_cloud.cli import run as run_cli
from pocket_cloud.crypto import decrypt_secret


@dataclass(frozen=True)
class EvalContext:
    base_url: str
    database_url: str
    bootstrap_key: str
    secret_key: str


@dataclass(frozen=True)
class RpcRequest:
    method: str
    params: dict | None = None
    token: str | None = None
    source: str | None = None


async def rpc_call(
    client: httpx.AsyncClient, req: RpcRequest
) -> httpx.Response:
    body: dict = dict(
        params=req.params or dict(), request_id=f"eval_{uuid4().hex}"
    )
    if req.source is not None:
        body["source"] = req.source
    headers = dict(Authorization=f"Bearer {req.token}") if req.token else dict()
    return await client.post(
        f"/v1/rpc/{req.method}", json=body, headers=headers
    )


async def claim_device_pair(
    ctx: EvalContext, client: httpx.AsyncClient, name: str
) -> tuple[str, str]:
    pair = await rpc_call(
        client, RpcRequest("pairing.create", token=ctx.bootstrap_key)
    )
    code = pair.json()["data"]["code"]
    assert re.fullmatch(r"\d{6}", code)
    claimed = await rpc_call(
        client, RpcRequest("pairing.claim", dict(code=code, name=name))
    )
    assert claimed.status_code == 200
    data = claimed.json()["data"]
    assert data["kind"] == "device"
    return data["token_id"], data["token"]


async def claim_device_token(
    ctx: EvalContext, client: httpx.AsyncClient, name: str
) -> str:
    _, token = await claim_device_pair(ctx, client, name)
    return token


async def run_step1(ctx: EvalContext) -> list[str]:
    checks = []
    async with httpx.AsyncClient(
        base_url=ctx.base_url, timeout=10.0
    ) as client:
        health = await client.get("/healthz")
        assert health.status_code == 200 and health.json()["status"] == "ok"
        checks.append("step1.healthz_ok")

        unauth = await rpc_call(
            client, RpcRequest("auth.status", token="bad-token")
        )
        assert unauth.status_code == 401
        status = await rpc_call(
            client, RpcRequest("auth.status", token=ctx.bootstrap_key)
        )
        assert status.status_code == 200
        assert status.json()["data"]["kind"] == "bootstrap"
        checks.append("step1.bootstrap_auth_and_401")

        await verify_pairing_and_lockout(ctx, client)
        checks.append("step1.pairing_claim_and_8_strike_lockout")

        await verify_scopes_and_idempotency(ctx, client)
        checks.append("step1.scoped_tokens_and_idempotency")

        await verify_agent_encryption_and_cli(ctx, client)
        checks.append("step1.agent_aes_gcm_and_cli")
    return checks


async def verify_pairing_and_lockout(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    await claim_device_token(ctx, client, "EvalPhone")
    pair2 = await rpc_call(
        client, RpcRequest("pairing.create", token=ctx.bootstrap_key)
    )
    code2 = pair2.json()["data"]["code"]
    wrong = "999999" if code2 != "999999" else "000000"
    bad_req = RpcRequest("pairing.claim", dict(code=wrong, name="Bad"))
    for _ in range(8):
        res = await rpc_call(client, bad_req)
        assert res.status_code == 401
    locked = await rpc_call(
        client, RpcRequest("pairing.claim", dict(code=code2, name="TooLate"))
    )
    assert locked.status_code == 401


async def verify_scopes_and_idempotency(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    req_id = f"eval_idem_{uuid4().hex}"
    headers = dict(Authorization=f"Bearer {ctx.bootstrap_key}")
    payload = dict(
        request_id=req_id,
        params=dict(kind="agent", label="EvalReader", scopes=["event.read"]),
    )
    first = await client.post(
        "/v1/rpc/token.create", json=payload, headers=headers
    )
    replay = await client.post(
        "/v1/rpc/token.create", json=payload, headers=headers
    )
    tampered = dict(
        request_id=req_id,
        params=dict(kind="agent", label="Tampered", scopes=["event.read"]),
    )
    conflict = await client.post(
        "/v1/rpc/token.create", json=tampered, headers=headers
    )
    assert first.status_code == 200 and first.json() == replay.json()
    assert conflict.status_code == 409

    agent_tok = first.json()["data"]["token"]
    forbidden = await rpc_call(
        client, RpcRequest("token.list", token=agent_tok)
    )
    assert forbidden.status_code == 403


async def verify_agent_encryption_and_cli(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    env = dict(POCKET_URL=ctx.base_url, POCKET_TOKEN=ctx.bootstrap_key)
    raw_secret = f"sec_{uuid4().hex}"
    await run_cli(
        [
            "agent", "set", "@eval-bot", "--url",
            "http://127.0.0.1:19999", "--key", raw_secret, "--json",
        ],
        env,
        client,
    )
    listed = await run_cli(["agent", "list", "--json"], env, client)
    serialized = json.dumps(listed)
    assert raw_secret not in serialized and "ciphertext" not in serialized

    async with await psycopg.AsyncConnection.connect(ctx.database_url) as conn:
        cur = await conn.execute(
            "SELECT credential_ciphertext FROM agents WHERE agent_id = %s",
            ("@eval-bot",),
        )
        row = await cur.fetchone()
    assert row is not None and raw_secret not in row[0]
    assert decrypt_secret(ctx.secret_key, row[0]) == raw_secret
