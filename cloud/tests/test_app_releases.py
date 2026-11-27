from dataclasses import replace
from hashlib import sha256
from types import MappingProxyType

from httpx import ASGITransport, AsyncClient
import pytest
from starlette.testclient import TestClient

from pocket_cloud.app import create_app

AUTH_HDR = MappingProxyType({"Authorization": "Bearer test-bootstrap-key"})
FAKE_APK = b"PK\x03\x04pocket-fake-apk-payload-for-test"


@pytest.mark.asyncio
async def test_app_release_upload_latest_download_and_ws_push(
    settings, tmp_path
):
    rel_settings = replace(settings, releases_dir=str(tmp_path))
    app = create_app(rel_settings)
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://t") as cli:
            empty = await cli.get("/v1/app/latest", headers=AUTH_HDR)
            assert empty.status_code == 200
            assert empty.json()["data"] is None

            bad = await cli.post(
                "/v1/app/releases?version=0.2.1",
                headers=AUTH_HDR,
                content=b"not-a-zip",
            )
            assert bad.status_code == 422

            up = await cli.post(
                "/v1/app/releases?version=0.2.1&notes=Fix+alarm",
                headers=AUTH_HDR,
                content=FAKE_APK,
            )
            assert up.status_code == 200
            meta = up.json()["data"]
            expected_sha = sha256(FAKE_APK).hexdigest()
            assert meta["version_name"] == "0.2.1"
            assert meta["version_code"] == 20199
            assert meta["sha256"] == expected_sha
            assert meta["notes"] == "Fix alarm"

            latest = await cli.get("/v1/app/latest", headers=AUTH_HDR)
            assert latest.status_code == 200
            assert latest.json()["data"]["version_name"] == "0.2.1"

            dl = await cli.get(meta["download_path"], headers=AUTH_HDR)
            assert dl.status_code == 200
            assert dl.content == FAKE_APK
            assert dl.headers["x-pocket-sha256"] == expected_sha


def test_app_release_ws_hello_ack_and_live_push(settings, tmp_path):
    rel_settings = replace(settings, releases_dir=str(tmp_path))
    app = create_app(rel_settings)
    with TestClient(app) as client:
        res1 = client.post(
            "/v1/app/releases?version=0.2.1",
            headers=AUTH_HDR,
            content=FAKE_APK,
        )
        assert res1.status_code == 200
        with client.websocket_connect("/v1/link") as ws:
            ws.send_json(
                dict(type="HELLO", token="test-bootstrap-key", last_seq=0)
            )
            ack = ws.receive_json()
            while ack.get("type") != "HELLO_ACK":
                ack = ws.receive_json()
            assert ack["latest_app"]["version_name"] == "0.2.1"

            res2 = client.post(
                "/v1/app/releases?version=0.2.2&notes=OTA+Push",
                headers=AUTH_HDR,
                content=FAKE_APK + b"-v2",
            )
            assert res2.status_code == 200
            pushed = ws.receive_json()
            assert pushed["type"] == "APP_UPDATE"
            assert pushed["release"]["version_name"] == "0.2.2"
            assert pushed["release"]["notes"] == "OTA Push"
