from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
from uuid import uuid4
import zipfile

import httpx

from eval_step1 import EvalContext, RpcRequest, claim_device_token, rpc_call
from eval_step3 import (
    build_ws_url,
    fetch_latest_seq,
    issue_web_token,
    open_synced_ws,
    ws_recv,
    ws_send,
)

REQUIRED_APK_ENTRIES = (
    "classes.dex",
    "AndroidManifest.xml",
    "resources.arsc",
    "assets/public/index.html",
)
REQUIRED_MANIFEST_MARKERS = (
    "com.pocket.calendar",
    "AlarmBootReceiver",
    "RingingActivity",
    "LOCKED_BOOT_COMPLETED",
    "SCHEDULE_EXACT_ALARM",
    "USE_FULL_SCREEN_INTENT",
)
SIGNATURE_SUFFIXES = (".RSA", ".EC", ".DSA")


def decode_binary_strings(blob: bytes) -> str:
    ascii_text = blob.decode("latin-1", errors="ignore")
    utf16_text = blob.decode("utf-16le", errors="ignore")
    return ascii_text + "\n" + utf16_text


def has_apk_signature(apk_path: Path, names: list[str]) -> bool:
    for name in names:
        upper = name.upper()
        if upper.startswith("META-INF/") and upper.endswith(SIGNATURE_SUFFIXES):
            return True
    raw_bytes = apk_path.read_bytes()
    return b"APK Sig Block 42" in raw_bytes


def resolve_built_apk_path() -> Path:
    repo_root = Path(__file__).resolve().parents[2]
    pkg_path = repo_root / "apps" / "calendar" / "package.json"
    ver = json.loads(pkg_path.read_text(encoding="utf-8"))["version"]
    return repo_root / "dist" / ("pocket-calendar-%s.apk" % ver)


def verify_apk_package_and_manifest() -> None:
    apk_path = resolve_built_apk_path()
    assert apk_path.is_file(), "Missing built Pocket Calendar APK"
    assert apk_path.stat().st_size > 100 * 1024, "APK unexpectedly small"

    with zipfile.ZipFile(apk_path, "r") as zf:
        assert zf.testzip() is None, "Corrupt ZIP entries in APK"
        names = zf.namelist()
        for entry in REQUIRED_APK_ENTRIES:
            assert entry in names, "APK missing required entry: " + entry
        assert has_apk_signature(apk_path, names), "APK is unsigned"

        web_html = zf.read("assets/public/index.html").decode("utf-8")
        assert "./src/main.js" not in web_html
        assert re.search(r"assets/.*\.js", web_html) is not None

        chunks = [decode_binary_strings(zf.read("AndroidManifest.xml"))]
        for name in names:
            if name.startswith("classes") and name.endswith(".dex"):
                chunks.append(decode_binary_strings(zf.read(name)))
        combined = "\n".join(chunks)

    for marker in REQUIRED_MANIFEST_MARKERS:
        assert marker in combined, "Missing compiled marker in APK: " + marker


async def wait_for_todo_push(
    ws, todo_id: str, expected_alarm_status: str
) -> dict:
    for _ in range(25):
        frame = await ws_recv(ws, timeout=5.0)
        matched = (
            frame.get("type") == "SYNC_PUSH"
            and frame.get("entity_type") == "todo"
            and frame.get("entity_id") == todo_id
            and frame.get("payload", dict()).get("alarm_status")
            == expected_alarm_status
        )
        if matched:
            return frame["payload"]
    raise AssertionError(
        "Did not receive SYNC_PUSH with alarm_status=" + expected_alarm_status
    )


async def send_offline_flush_sequence(phone_ws, todo_id: str) -> None:
    future_day = (datetime.now(timezone.utc) + timedelta(days=3)).date()
    await ws_send(
        phone_ws,
        dict(
            type="LOCK_OVERRIDE",
            todo=dict(
                todo_id=todo_id,
                text="Step5 Mobile Offline Locked Alarm",
                assignee="@me",
                schedule_kind="once",
                time_hhmm="06:45",
                once_date=future_day.isoformat(),
                timezone="Asia/Shanghai",
                locked=True,
            ),
        ),
    )
    override_push = await ws_recv(phone_ws)
    override_ack = await ws_recv(phone_ws)
    assert override_push["entity_id"] == todo_id
    assert override_ack["type"] == "OVERRIDE_ACK"

    await ws_send(
        phone_ws,
        dict(
            type="ALARM_RECEIPT",
            entity_type="todo",
            entity_id=todo_id,
            status="EXECUTED",
        ),
    )
    exec_push = await ws_recv(phone_ws)
    exec_ack = await ws_recv(phone_ws)
    assert exec_push["payload"]["alarm_status"] == "EXECUTED"
    assert exec_ack["type"] == "RECEIPT_ACK"


async def assert_web_lock_and_missed(
    client: httpx.AsyncClient,
    web_tok: str,
    sockets: tuple,
    todo_id: str,
) -> None:
    web_ws, phone_ws = sockets
    web_exec = await wait_for_todo_push(web_ws, todo_id, "EXECUTED")
    assert web_exec["locked"] is True

    blocked = await rpc_call(
        client,
        RpcRequest(
            "todo.set",
            dict(todo_id=todo_id, text="Illegal Web Edit"),
            token=web_tok,
            source="web",
        ),
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "CLOUD_LOCKED"

    await ws_send(
        phone_ws,
        dict(
            type="ALARM_RECEIPT",
            entity_type="todo",
            entity_id=todo_id,
            status="MISSED",
        ),
    )
    web_missed = await wait_for_todo_push(web_ws, todo_id, "MISSED")
    assert web_missed["alarm_status"] == "MISSED"


async def verify_mobile_offline_lock_alarm_e2e(
    ctx: EvalContext, client: httpx.AsyncClient
) -> None:
    ws_url = build_ws_url(ctx.base_url)
    base_seq = await fetch_latest_seq(ws_url, ctx.bootstrap_key)
    phone_tok = await claim_device_token(ctx, client, "Step5ReleasePhone")
    web_tok = await issue_web_token(ctx, client, "Step5WebViewer")
    offline_todo_id = "todo_" + uuid4().hex[:16]

    web_ws, _, _ = await open_synced_ws(ws_url, web_tok, base_seq)
    phone_ws, _, _ = await open_synced_ws(ws_url, phone_tok, base_seq)
    try:
        await send_offline_flush_sequence(phone_ws, offline_todo_id)
        await assert_web_lock_and_missed(
            client, web_tok, (web_ws, phone_ws), offline_todo_id
        )
    finally:
        await phone_ws.close()
        await web_ws.close()


async def run_step5(ctx: EvalContext) -> list[str]:
    checks: list[str] = []
    verify_apk_package_and_manifest()
    checks.append("step5.apk_package_and_manifest_integrity")

    async with httpx.AsyncClient(
        base_url=ctx.base_url, timeout=15.0
    ) as client:
        await verify_mobile_offline_lock_alarm_e2e(ctx, client)
        checks.append("step5.mobile_offline_lock_alarm_e2e")
    return checks
