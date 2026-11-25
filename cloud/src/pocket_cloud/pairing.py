from datetime import timedelta
import secrets
import uuid

from .auth import issue_token
from .crypto import hash_secret
from .errors import RpcError
from .validators import require_text


class PairingAttemptFailed(Exception):
    def __init__(self, code_id):
        self.code_id = code_id


async def create_pairing(ctx, conn, identity, params):
    now = ctx.clock()
    await conn.execute(
        """
        UPDATE pairing_codes SET expires_at = %s
        WHERE claimed_token_id IS NULL AND expires_at > %s
        """,
        (now, now),
    )
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = now + timedelta(minutes=5)
    code_id = f"pair_{uuid.uuid4().hex}"
    await conn.execute(
        """
        INSERT INTO pairing_codes (code_id, code_hash, expires_at)
        VALUES (%s, %s, %s)
        """,
        (code_id, hash_secret(code), expires_at),
    )
    return dict(code=code, expires_at=expires_at.isoformat())


async def claim_pairing(ctx, conn, identity, params):
    name = require_text(
        params.get("name"), "INVALID_NAME", "Device name is required"
    )
    now = ctx.clock()
    cursor = await conn.execute(
        """
        SELECT code_id, code_hash, failed_attempts, expires_at
        FROM pairing_codes
        WHERE claimed_token_id IS NULL
        ORDER BY created_at DESC LIMIT 1
        """
    )
    row = await cursor.fetchone()
    if row is None or row[3] <= now:
        raise RpcError(401, "INVALID_PAIRING_CODE", "Pairing code is invalid")
    code = params.get("code")
    supplied_hash = hash_secret(code if isinstance(code, str) else "")
    if supplied_hash != row[1] or row[2] >= 8:
        raise PairingAttemptFailed(row[0])
    token = await issue_token(conn, "device", name, ["*"])
    await conn.execute(
        "UPDATE pairing_codes SET claimed_token_id = %s WHERE code_id = %s",
        (token["token_id"], row[0]),
    )
    return token


async def register_failed_attempt(pool, code_id, now):
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE pairing_codes
                SET failed_attempts = failed_attempts + 1,
                    expires_at = CASE
                        WHEN failed_attempts + 1 >= 8 THEN %s
                        ELSE expires_at
                    END
                WHERE code_id = %s
                """,
                (now, code_id),
            )
