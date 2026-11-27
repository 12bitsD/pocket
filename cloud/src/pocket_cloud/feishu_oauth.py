"""Feishu binding configuration, OAuth handshake, and status queries."""

from __future__ import annotations

from datetime import timedelta
import secrets

from psycopg.rows import dict_row

from .crypto import decrypt_secret, encrypt_secret, hash_secret
from .errors import RpcError
from .feishu_api import (
    build_authorize_url,
    exchange_oidc_code,
    fetch_app_access_token,
    fetch_primary_calendar_id,
    refresh_oidc_token,
)
from .validators import require_text

PROVIDER_FEISHU = "feishu"


def resolve_app_creds(ctx, row: dict | None) -> tuple[str, str]:
    app_id = (row or {}).get("app_id") or ctx.settings.feishu_app_id
    enc = (row or {}).get("app_secret_ciphertext") or ""
    secret = (
        decrypt_secret(ctx.settings.secret_key, enc)
        if enc
        else ctx.settings.feishu_app_secret
    )
    return str(app_id).strip(), str(secret).strip()


def is_feishu_connected(row: dict | None) -> bool:
    return bool(
        row and row.get("enabled") and row.get("access_token_ciphertext")
    )


def format_feishu_status(ctx, row: dict | None, event_count: int) -> dict:
    app_id, app_secret = resolve_app_creds(ctx, row)
    synced = row.get("last_synced_at") if row else None
    return dict(
        provider=PROVIDER_FEISHU,
        configured=bool(app_id and app_secret),
        connected=is_feishu_connected(row),
        app_id=app_id,
        calendar_id=str((row or {}).get("calendar_id") or ""),
        last_synced_at=synced.isoformat() if synced else None,
        last_error=str((row or {}).get("last_error") or ""),
        event_count=event_count,
    )


async def fetch_feishu_binding(conn) -> dict | None:
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            "SELECT * FROM external_calendar_bindings WHERE provider = %s",
            (PROVIDER_FEISHU,),
        )
        return await cur.fetchone()


async def count_feishu_events(conn) -> int:
    cursor = await conn.execute(
        "SELECT COUNT(*) FROM events "
        "WHERE external_provider = %s AND deleted_at IS NULL",
        (PROVIDER_FEISHU,),
    )
    row = await cursor.fetchone()
    return int(row[0]) if row else 0


async def list_integrations(ctx, conn, identity, params) -> dict:
    _ = (identity, params)
    row = await fetch_feishu_binding(conn)
    count = await count_feishu_events(conn)
    return dict(integrations=[format_feishu_status(ctx, row, count)])


def resolve_secret_cipher(ctx, params: dict, existing: dict | None) -> str:
    raw = params.get("app_secret")
    if isinstance(raw, str) and raw.strip():
        return encrypt_secret(ctx.settings.secret_key, raw.strip())
    if existing and existing.get("app_secret_ciphertext"):
        return existing["app_secret_ciphertext"]
    if ctx.settings.feishu_app_secret:
        return encrypt_secret(
            ctx.settings.secret_key, ctx.settings.feishu_app_secret
        )
    raise RpcError(422, "INVALID_APP_SECRET", "Feishu app_secret is required")


async def configure_feishu(ctx, conn, identity, params) -> dict:
    _ = identity
    app_id = require_text(
        params.get("app_id"), "INVALID_APP_ID", "Feishu app_id is required"
    )
    existing = await fetch_feishu_binding(conn)
    secret_cipher = resolve_secret_cipher(ctx, params, existing)
    await conn.execute(
        """
        INSERT INTO external_calendar_bindings (
            provider, app_id, app_secret_ciphertext, updated_at
        ) VALUES (%s, %s, %s, %s)
        ON CONFLICT (provider) DO UPDATE SET
            app_id = EXCLUDED.app_id,
            app_secret_ciphertext = EXCLUDED.app_secret_ciphertext,
            last_error = '',
            updated_at = EXCLUDED.updated_at
        """,
        (PROVIDER_FEISHU, app_id, secret_cipher, ctx.clock()),
    )
    row = await fetch_feishu_binding(conn)
    return format_feishu_status(ctx, row, await count_feishu_events(conn))


async def create_feishu_auth_url(ctx, conn, identity, params) -> dict:
    _ = identity
    row = await fetch_feishu_binding(conn)
    app_id, app_secret = resolve_app_creds(ctx, row)
    if not app_id or not app_secret:
        raise RpcError(
            400, "FEISHU_NOT_CONFIGURED", "Configure Feishu App credentials"
        )
    raw_state = f"fsh_{secrets.token_urlsafe(24)}"
    expires_at = ctx.clock() + timedelta(minutes=10)
    return_to = str(params.get("return_to") or "").strip()[:256]
    await conn.execute(
        "INSERT INTO oauth_states (state_hash, provider, return_to, expires_at)"
        " VALUES (%s, %s, %s, %s)",
        (hash_secret(raw_state), PROVIDER_FEISHU, return_to, expires_at),
    )
    base = ctx.settings.public_url.rstrip("/")
    redirect_uri = f"{base}/v1/integrations/feishu/callback"
    return dict(
        auth_url=build_authorize_url(app_id, redirect_uri, raw_state),
        redirect_uri=redirect_uri,
        expires_at=expires_at.isoformat(),
    )


async def unbind_feishu(ctx, conn, identity, params) -> dict:
    _ = (identity, params)
    await conn.execute(
        """
        UPDATE external_calendar_bindings SET
            calendar_id = '', access_token_ciphertext = '',
            refresh_token_ciphertext = '', token_expires_at = NULL,
            enabled = FALSE, last_error = '', updated_at = %s
        WHERE provider = %s
        """,
        (ctx.clock(), PROVIDER_FEISHU),
    )
    row = await fetch_feishu_binding(conn)
    return format_feishu_status(ctx, row, await count_feishu_events(conn))


async def save_refreshed_tokens(ctx, tok_data: dict, fallback_ref: str) -> str:
    now = ctx.clock()
    access_tok = str(tok_data["access_token"])
    new_ref = str(tok_data.get("refresh_token") or fallback_ref)
    ttl = max(60, int(tok_data.get("expires_in") or 7200))
    async with ctx.write_tx() as tx:
        await tx.execute(
            """
            UPDATE external_calendar_bindings SET
                access_token_ciphertext = %s,
                refresh_token_ciphertext = %s,
                token_expires_at = %s,
                updated_at = %s
            WHERE provider = %s
            """,
            (
                encrypt_secret(ctx.settings.secret_key, access_tok),
                encrypt_secret(ctx.settings.secret_key, new_ref),
                now + timedelta(seconds=ttl),
                now,
                PROVIDER_FEISHU,
            ),
        )
    return access_tok


async def ensure_fresh_user_token(ctx, row: dict) -> str:
    expires = row.get("token_expires_at")
    enc_access = row.get("access_token_ciphertext") or ""
    if enc_access and (
        expires is None or expires > ctx.clock() + timedelta(minutes=5)
    ):
        return decrypt_secret(ctx.settings.secret_key, enc_access)
    enc_refresh = row.get("refresh_token_ciphertext") or ""
    if not enc_refresh:
        raise RpcError(401, "FEISHU_TOKEN_EXPIRED", "Reconnect Feishu account")
    app_id, app_secret = resolve_app_creds(ctx, row)
    app_tok = await fetch_app_access_token(ctx.http_client, app_id, app_secret)
    ref_tok = decrypt_secret(ctx.settings.secret_key, enc_refresh)
    tok_data = await refresh_oidc_token(ctx.http_client, app_tok, ref_tok)
    return await save_refreshed_tokens(ctx, tok_data, ref_tok)


async def persist_feishu_binding(
    ctx, creds: tuple[str, str], cal_id: str, tok_data: dict
) -> None:
    now = ctx.clock()
    ttl = max(60, int(tok_data.get("expires_in") or 7200))
    ref = str(tok_data.get("refresh_token") or "")
    enc_acc = encrypt_secret(
        ctx.settings.secret_key, str(tok_data["access_token"])
    )
    enc_ref = encrypt_secret(ctx.settings.secret_key, ref) if ref else ""
    async with ctx.write_tx() as tx:
        await tx.execute(
            """
            INSERT INTO external_calendar_bindings (
                provider, app_id, app_secret_ciphertext, calendar_id,
                access_token_ciphertext, refresh_token_ciphertext,
                token_expires_at, enabled, last_error, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, TRUE, '', %s)
            ON CONFLICT (provider) DO UPDATE SET
                calendar_id = EXCLUDED.calendar_id,
                access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
                token_expires_at = EXCLUDED.token_expires_at,
                enabled = TRUE,
                last_error = '',
                updated_at = EXCLUDED.updated_at
            """,
            (
                PROVIDER_FEISHU, creds[0],
                encrypt_secret(ctx.settings.secret_key, creds[1]),
                cal_id, enc_acc, enc_ref, now + timedelta(seconds=ttl), now,
            ),
        )


async def exchange_feishu_callback(ctx, code: str, state: str) -> None:
    async with ctx.write_tx() as tx:
        cur = await tx.execute(
            "DELETE FROM oauth_states WHERE state_hash=%s AND provider=%s "
            "AND expires_at > %s RETURNING return_to",
            (hash_secret(state), PROVIDER_FEISHU, ctx.clock()),
        )
        if await cur.fetchone() is None:
            raise RpcError(400, "INVALID_OAUTH_STATE", "OAuth state expired")
        row = await fetch_feishu_binding(tx)
    creds = resolve_app_creds(ctx, row)
    app_tok = await fetch_app_access_token(ctx.http_client, creds[0], creds[1])
    tok_data = await exchange_oidc_code(ctx.http_client, app_tok, code)
    cal_id = await fetch_primary_calendar_id(
        ctx.http_client, str(tok_data["access_token"])
    )
    await persist_feishu_binding(ctx, creds, cal_id, tok_data)
