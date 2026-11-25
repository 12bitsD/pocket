from dataclasses import dataclass
from secrets import token_urlsafe
from uuid import uuid4

from .crypto import hash_secret
from .db import write_tx
from .errors import RpcError


@dataclass(frozen=True)
class Identity:
    token_id: str
    kind: str
    label: str
    scopes: list[str]
    source: str = "local"


async def sync_bootstrap(pool, bootstrap_key: str):
    token_hash = hash_secret(bootstrap_key)
    token_id = f"tok_bootstrap_{token_hash[:16]}"
    async with write_tx(pool) as tx:
        await tx.execute(
            """
            UPDATE tokens SET revoked_at = now()
            WHERE kind = 'bootstrap' AND token_hash <> %s
                AND revoked_at IS NULL
            """,
            (token_hash,),
        )
        await tx.execute(
            """
            INSERT INTO tokens (
                token_id, kind, label, token_hash, scopes, revoked_at
            ) VALUES (%s, 'bootstrap', 'Initial bootstrap key', %s, %s, NULL)
            ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NULL
            """,
            (token_id, token_hash, ["*"]),
        )


async def issue_token(conn, kind, label, scopes):
    token = f"pck_{token_urlsafe(32)}"
    token_id = f"tok_{uuid4().hex}"
    await conn.execute(
        """
        INSERT INTO tokens (token_id, kind, label, token_hash, scopes)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (token_id, kind, label, hash_secret(token), scopes),
    )
    return dict(
        token_id=token_id,
        kind=kind,
        label=label,
        scopes=scopes,
        token=token,
    )


async def ensure_active_token(conn, token_id: str) -> None:
    cursor = await conn.execute(
        "SELECT 1 FROM tokens WHERE token_id = %s AND revoked_at IS NULL",
        (token_id,),
    )
    if await cursor.fetchone() is None:
        raise RpcError(401, "UNAUTHORIZED", "Token revoked")


async def authenticate_raw_conn(
    conn, raw_token: str | None
) -> Identity | None:
    if not isinstance(raw_token, str) or not raw_token:
        return None
    token_hash = hash_secret(raw_token)
    cursor = await conn.execute(
        """
        SELECT token_id, kind, label, scopes FROM tokens
        WHERE token_hash = %s AND revoked_at IS NULL
        """,
        (token_hash,),
    )
    row = await cursor.fetchone()
    return Identity(*row) if row is not None else None


async def authenticate_token(pool, raw_token: str | None) -> Identity | None:
    if not isinstance(raw_token, str) or not raw_token:
        return None
    async with pool.connection() as conn:
        return await authenticate_raw_conn(conn, raw_token)
