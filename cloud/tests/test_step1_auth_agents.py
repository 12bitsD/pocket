from dataclasses import replace
import re

from httpx import ASGITransport, AsyncClient
import pytest

from helpers import RpcCallSpec, post_rpc
from pocket_cloud.app import create_app
from pocket_cloud.crypto import decrypt_secret


async def claim_code(client, code: str, request_id: str):
    return await post_rpc(
        client,
        "pairing.claim",
        RpcCallSpec(
            token=None,
            params=dict(code=code, name="Pixel"),
            request_id=request_id,
        ),
    )


async def test_pairing_code_exchanges_for_device_token(client):
    created = await post_rpc(
        client, "pairing.create", RpcCallSpec(request_id="req-pair-create")
    )
    code = created.json()["data"]["code"]
    claimed = await claim_code(client, code, "req-pair-claim")

    assert created.status_code == 200
    assert re.fullmatch(r"[0-9]{6}", code)
    assert claimed.status_code == 200
    assert claimed.json()["data"]["kind"] == "device"
    assert claimed.json()["data"]["scopes"] == ["*"]
    device_token = claimed.json()["data"]["token"]
    status = await post_rpc(
        client, "auth.status", RpcCallSpec(token=device_token)
    )
    assert status.json()["data"]["kind"] == "device"


async def test_pairing_code_rejects_eight_failed_attempts(client):
    created = await post_rpc(
        client, "pairing.create", RpcCallSpec(request_id="req-pair-failures")
    )
    code = created.json()["data"]["code"]
    wrong_code = "000000" if code != "000000" else "000001"

    for attempt in range(8):
        req_id = "req-wrong-%d" % attempt
        response = await claim_code(client, wrong_code, req_id)
        assert response.status_code == 401

    correct_after_lock = await claim_code(
        client, code, "req-correct-after-lock"
    )
    assert correct_after_lock.status_code == 401


async def test_agent_credentials_are_encrypted_and_never_listed(client, app):
    secret = "agent-call-secret"
    params = dict(
        agent_id="@work-agent",
        name="Work Agent",
        endpoint_url="https://agent.example.com",
        credential=secret,
    )
    created = await post_rpc(
        client, "agent.set", RpcCallSpec(params=params, request_id="req-ag-set")
    )
    listed = await post_rpc(client, "agent.list")

    assert created.status_code == 200
    assert listed.status_code == 200
    assert secret not in listed.text
    assert "credential" not in listed.text
    async with app.state.ctx.pool.connection() as conn:
        cursor = await conn.execute(
            "SELECT credential_ciphertext FROM agents WHERE agent_id = %s",
            ("@work-agent",),
        )
        ciphertext = (await cursor.fetchone())[0]
    assert ciphertext != secret and secret not in ciphertext
    assert decrypt_secret(app.state.settings.secret_key, ciphertext) == secret


async def test_agent_update_can_retain_credential_and_revoke(client, app):
    params = dict(
        agent_id="@work-agent",
        name="Work Agent",
        endpoint_url="https://agent.example.com",
        credential="keep-this-secret",
    )
    await post_rpc(
        client, "agent.set", RpcCallSpec(params=params, request_id="req-ag-old")
    )
    sql = "SELECT credential_ciphertext FROM agents WHERE agent_id = %s"
    async with app.state.ctx.pool.connection() as conn:
        cursor = await conn.execute(sql, ("@work-agent",))
        original_ciphertext = (await cursor.fetchone())[0]

    retained = dict(params, name="Renamed", credential=None)
    updated = await post_rpc(
        client,
        "agent.set",
        RpcCallSpec(params=retained, request_id="req-ag-retain"),
    )
    revoked = await post_rpc(
        client,
        "agent.revoke",
        RpcCallSpec(
            params=dict(agent_id="@work-agent"), request_id="req-ag-revoke"
        ),
    )
    listed = await post_rpc(client, "agent.list")

    assert updated.status_code == 200 and revoked.status_code == 200
    assert listed.json()["data"]["agents"][0]["active"] is False
    assert listed.json()["data"]["agents"][0]["name"] == "Renamed"
    async with app.state.ctx.pool.connection() as conn:
        cursor = await conn.execute(sql, ("@work-agent",))
        assert (await cursor.fetchone())[0] == original_ciphertext


@pytest.mark.parametrize(
    "agent_id,url",
    [
        ("@me", "https://agent.example.com"),
        ("@work-agent", "http://agent.example.com"),
        ("@work-agent", "https://127.0.0.1:8443"),
        ("@work-agent", "https://localhost/hook"),
        ("@work-agent", "https://10.0.0.8/hook"),
        ("@work-agent", "https://agent.example.com/path?x=1"),
        ("@work-agent", "https://agent.example.com/path#frag"),
    ],
)
async def test_agent_configuration_rejects_unsafe_values(
    client, agent_id, url
):
    params = dict(agent_id=agent_id, endpoint_url=url, credential="secret")
    response = await post_rpc(
        client,
        "agent.set",
        RpcCallSpec(params=params, request_id=f"req-bad-{agent_id}-{url}"),
    )
    assert response.status_code == 422


async def test_loopback_http_is_available_in_test_configuration(client):
    params = dict(
        agent_id="@local-agent",
        endpoint_url="http://127.0.0.1:9000",
        credential="secret",
    )
    response = await post_rpc(
        client,
        "agent.set",
        RpcCallSpec(params=params, request_id="req-agent-loopback"),
    )
    assert response.status_code == 200


async def test_agent_token_has_only_granted_scopes(client):
    params = dict(kind="agent", label="Reader", scopes=["event.read"])
    created = await post_rpc(
        client,
        "token.create",
        RpcCallSpec(params=params, request_id="req-token-scopes"),
    )
    assert created.status_code == 200
    data = created.json()["data"]
    assert data["scopes"] == ["event.read"]
    forbidden = await post_rpc(
        client, "token.list", RpcCallSpec(token=data["token"])
    )
    assert forbidden.status_code == 403
    allowed = await post_rpc(
        client, "auth.status", RpcCallSpec(token=data["token"])
    )
    assert allowed.status_code == 200


async def test_token_revoke_invalidates_credentials(client):
    created = await post_rpc(
        client,
        "token.create",
        RpcCallSpec(
            params=dict(kind="web", label="Browser"),
            request_id="req-token-revoke-create",
        ),
    )
    data = created.json()["data"]
    revoked = await post_rpc(
        client,
        "token.revoke",
        RpcCallSpec(
            params=dict(token_id=data["token_id"]),
            request_id="req-token-revoke",
        ),
    )
    listed = await post_rpc(client, "token.list")

    assert revoked.status_code == 200 and listed.status_code == 200
    first_tok = listed.json()["data"]["tokens"][0]
    assert first_tok["revoked_at"] is not None
    assert "token" not in first_tok and "token_hash" not in first_tok
    status = await post_rpc(
        client, "auth.status", RpcCallSpec(token=data["token"])
    )
    assert status.status_code == 401


async def test_request_id_replays_response_and_rejects_changed_params(client):
    params = dict(kind="agent", label="Idempotent", scopes=["todo.write"])
    spec = RpcCallSpec(params=params, request_id="req-idempotent")
    first = await post_rpc(client, "token.create", spec)
    replay = await post_rpc(client, "token.create", spec)
    changed = await post_rpc(
        client,
        "token.create",
        RpcCallSpec(
            params=dict(params, label="Changed"), request_id="req-idempotent"
        ),
    )
    listed = await post_rpc(client, "token.list")

    assert first.json() == replay.json()
    assert changed.status_code == 409
    assert changed.json()["error"]["code"] == "REQUEST_ID_CONFLICT"
    tokens = listed.json()["data"]["tokens"]
    assert sum(item["label"] == "Idempotent" for item in tokens) == 1


async def test_expired_pairing_code_is_rejected(client, app):
    created = await post_rpc(
        client, "pairing.create", RpcCallSpec(request_id="req-expired-create")
    )
    code = created.json()["data"]["code"]
    async with app.state.ctx.pool.connection() as conn:
        await conn.execute(
            "UPDATE pairing_codes SET expires_at = %s",
            (app.state.ctx.clock(),),
        )
    claimed = await claim_code(client, code, "req-expired-claim")
    assert claimed.status_code == 401


@pytest.mark.parametrize("method", ["auth.status", "pairing.create"])
async def test_invalid_token_is_rejected(client, method):
    response = await post_rpc(
        client, method, RpcCallSpec(token="not-a-token")
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


async def test_bootstrap_token_reads_current_identity(client):
    response = await post_rpc(client, "auth.status")
    assert response.status_code == 200
    assert response.json()["data"] == dict(
        kind="bootstrap",
        label="Initial bootstrap key",
        scopes=["*"],
    )


async def test_bootstrap_rotation_revokes_old_key(client, settings):
    rotated_app = create_app(replace(settings, bootstrap_key="rotated-key"))
    async with rotated_app.router.lifespan_context(rotated_app):
        transport = ASGITransport(app=rotated_app)
        async with AsyncClient(
            transport=transport, base_url="http://test"
        ) as rotated_client:
            old_status = await post_rpc(client, "auth.status")
            new_status = await post_rpc(
                rotated_client,
                "auth.status",
                RpcCallSpec(token="rotated-key"),
            )
    assert old_status.status_code == 401 and new_status.status_code == 200


async def test_health(client):
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == dict(status="ok")
