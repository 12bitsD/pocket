from dataclasses import dataclass
from datetime import datetime, timedelta
import hmac
from secrets import token_urlsafe

import httpx
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .crypto import decrypt_secret, encrypt_secret, hash_secret
from .errors import RpcError
from .todo_svc import bump_todo_sync
from .validators import require_text

BACKOFF_SECONDS = (5, 15, 45, 120, 300)
LEASE_SECONDS = 30
TERMINAL_DELIVERY_STATES = ("CANCELLED", "EXPIRED", "FAILED")


@dataclass(frozen=True)
class ClaimedDelivery:
    delivery_id: str
    todo_id: str
    agent_id: str
    prompt: str
    scheduled_for: datetime
    expires_at: datetime
    attempt_count: int
    endpoint_url: str
    credential_ciphertext: str
    callback_token_ciphertext: str


def issue_callback_credentials(secret_key: str) -> tuple[str, str, str]:
    raw_token = f"cbk_{token_urlsafe(32)}"
    token_hash = hash_secret(raw_token)
    ciphertext = encrypt_secret(secret_key, raw_token)
    return raw_token, token_hash, ciphertext


def build_webhook_request(
    ctx, claim: ClaimedDelivery
) -> tuple[str, dict, dict]:
    secret_key = ctx.settings.secret_key
    agent_secret = decrypt_secret(secret_key, claim.credential_ciphertext)
    cbk_token = decrypt_secret(secret_key, claim.callback_token_ciphertext)
    url = f"{claim.endpoint_url.rstrip('/')}/webhooks/pocket"
    base_pub = ctx.settings.public_url.rstrip("/")
    cbk_url = f"{base_pub}/v1/deliveries/{claim.delivery_id}/result"
    body = dict(
        delivery_id=claim.delivery_id,
        todo_id=claim.todo_id,
        agent_id=claim.agent_id,
        prompt=claim.prompt,
        scheduled_for=claim.scheduled_for.isoformat(),
        result_callback_url=cbk_url,
        callback_token=cbk_token,
    )
    headers = dict(Authorization=f"Bearer {agent_secret}")
    return url, body, headers


async def post_webhook(ctx, claim: ClaimedDelivery) -> int | None:
    url, body, headers = build_webhook_request(ctx, claim)
    status_code = None
    try:
        resp = await ctx.http_client.post(
            url,
            json=body,
            headers=headers,
            follow_redirects=False,
            timeout=10.0,
        )
        status_code = resp.status_code
    except httpx.HTTPError:
        status_code = None
    return status_code


def classify_failure(
    claim: ClaimedDelivery, http_status: int | None, now: datetime
) -> tuple[str, datetime]:
    retryable = (
        http_status is None
        or http_status == 429
        or 500 <= http_status <= 599
    )
    if not retryable:
        return "FAILED", now
    idx = min(claim.attempt_count - 1, len(BACKOFF_SECONDS) - 1)
    next_at = now + timedelta(seconds=BACKOFF_SECONDS[max(0, idx)])
    expired = now >= claim.expires_at or next_at >= claim.expires_at
    return ("EXPIRED" if expired else "PENDING"), next_at


async def apply_delivery_outcome(
    conn, delivery_id: str, outcome: tuple[str, datetime], now: datetime
) -> bool:
    new_status, next_at = outcome
    if new_status == "COMPLETED":
        cursor = await conn.execute(
            """
            UPDATE deliveries
            SET status = 'COMPLETED',
                lease_until = NULL,
                completed_at = COALESCE(completed_at, %s)
            WHERE delivery_id = %s
              AND status NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED')
            RETURNING delivery_id
            """,
            (now, delivery_id),
        )
        return (await cursor.fetchone()) is not None
    cursor = await conn.execute(
        """
        UPDATE deliveries
        SET status = %s, next_attempt_at = %s, lease_until = NULL
        WHERE delivery_id = %s
          AND status NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED')
        RETURNING delivery_id
        """,
        (new_status, next_at, delivery_id),
    )
    return (await cursor.fetchone()) is not None


async def finalize_delivery(
    ctx, claim: ClaimedDelivery, http_status: int | None
) -> str:
    now = ctx.clock()
    succeeded = http_status in (200, 202)
    outcome = (
        ("COMPLETED", now)
        if succeeded
        else classify_failure(claim, http_status, now)
    )
    new_status = outcome[0]
    async with ctx.write_tx() as tx:
        changed = await apply_delivery_outcome(
            tx, claim.delivery_id, outcome, now
        )
        if changed:
            await bump_todo_sync(tx, claim.todo_id, now)
    return new_status


async def dispatch_claimed_delivery(ctx, claim: ClaimedDelivery) -> dict:
    http_status = await post_webhook(ctx, claim)
    status = await finalize_delivery(ctx, claim, http_status)
    return dict(
        delivery_id=claim.delivery_id,
        todo_id=claim.todo_id,
        agent_id=claim.agent_id,
        status=status,
        http_status=http_status,
        attempt_count=claim.attempt_count,
    )


def extract_callback_token(body: dict, authorization: str | None) -> str:
    raw = None
    if authorization and authorization.startswith("Bearer "):
        raw = authorization.removeprefix("Bearer ").strip()
    elif "callback_token" in body:
        raw = body.get("callback_token")
    if not isinstance(raw, str) or not raw.startswith("cbk_"):
        raise RpcError(401, "UNAUTHORIZED", "Valid callback token required")
    return raw


def extract_result_fields(body: dict) -> tuple[str, Jsonb | None]:
    raw_summary = (
        body.get("result_summary")
        if "result_summary" in body
        else body.get("summary")
    )
    summary = require_text(
        raw_summary, "INVALID_SUMMARY", "result_summary is required"
    )
    payload = (
        body.get("result_payload")
        if "result_payload" in body
        else body.get("payload")
    )
    wrapped = Jsonb(payload) if payload is not None else None
    return summary, wrapped


def check_callback_preconditions(
    row: dict | None, supplied_hash: str, now: datetime
) -> RpcError | None:
    if row is None:
        return RpcError(404, "DELIVERY_NOT_FOUND", "Delivery not found")
    if not hmac.compare_digest(supplied_hash, row["callback_token_hash"]):
        return RpcError(401, "UNAUTHORIZED", "Invalid callback token")
    status = row["status"]
    if status in TERMINAL_DELIVERY_STATES:
        msg = "Delivery is " + status.lower()
        return RpcError(409, "DELIVERY_" + status, msg)
    if row["result_summary"] is not None:
        return RpcError(
            409, "DELIVERY_ALREADY_COMPLETED", "Callback token already used"
        )
    if now >= row["expires_at"]:
        return RpcError(409, "DELIVERY_EXPIRED", "Delivery has expired")
    return None


async def record_delivery_result(
    ctx, delivery_id: str, body: dict, authorization: str | None
) -> dict:
    raw_token = extract_callback_token(body, authorization)
    summary, payload_json = extract_result_fields(body)
    supplied_hash = hash_secret(raw_token)
    now = ctx.clock()
    error_to_raise = None
    todo_id = ""
    async with ctx.write_tx() as tx:
        async with tx.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT status, expires_at, callback_token_hash, todo_id,
                       result_summary
                FROM deliveries WHERE delivery_id = %s
                """,
                (delivery_id,),
            )
            row = await cur.fetchone()
        error_to_raise = check_callback_preconditions(row, supplied_hash, now)
        should_expire = (
            row is not None
            and error_to_raise is not None
            and error_to_raise.code == "DELIVERY_EXPIRED"
            and row["status"] != "COMPLETED"
        )
        if should_expire:
            await tx.execute(
                """
                UPDATE deliveries SET status = 'EXPIRED', lease_until = NULL
                WHERE delivery_id = %s
                """,
                (delivery_id,),
            )
            await bump_todo_sync(tx, row["todo_id"], now)
        elif error_to_raise is None:
            todo_id = row["todo_id"]
            await tx.execute(
                """
                UPDATE deliveries SET
                    status = 'COMPLETED', lease_until = NULL,
                    result_summary = %s, result_payload = %s, completed_at = %s
                WHERE delivery_id = %s
                """,
                (summary, payload_json, now, delivery_id),
            )
            await bump_todo_sync(tx, todo_id, now)
    if error_to_raise is not None:
        raise error_to_raise
    info = dict(
        delivery_id=delivery_id,
        todo_id=todo_id,
        status="COMPLETED",
        result_summary=summary,
    )
    return dict(data=info)
