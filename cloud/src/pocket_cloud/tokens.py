from .auth import issue_token
from .errors import RpcError
from .validators import require_text

AGENT_SCOPES = ("event.read", "event.write", "todo.read", "todo.write")
TOKEN_KINDS = ("web", "agent")


async def create_token(ctx, conn, identity, params):
    kind = params.get("kind")
    if kind not in TOKEN_KINDS:
        raise RpcError(
            422, "INVALID_TOKEN_KIND", "Token kind must be web or agent"
        )
    label = require_text(
        params.get("label"), "INVALID_LABEL", "Token label is required"
    )
    scopes = ["*"] if kind == "web" else validate_scopes(params.get("scopes"))
    return await issue_token(conn, kind, label, scopes)


def validate_scopes(scopes):
    if not isinstance(scopes, list) or any(
        not isinstance(scope, str) for scope in scopes
    ):
        raise RpcError(422, "INVALID_SCOPES", "Agent scopes must be a list")
    if any(scope not in AGENT_SCOPES for scope in scopes):
        raise RpcError(422, "INVALID_SCOPES", "Unknown Agent scope")
    return list(dict.fromkeys(scopes))


async def list_tokens(ctx, conn, identity, params):
    cursor = await conn.execute(
        """
        SELECT token_id, kind, label, scopes, revoked_at, created_at
        FROM tokens ORDER BY created_at DESC, token_id DESC
        """
    )
    rows = await cursor.fetchall()
    return dict(tokens=[serialize_token(row) for row in rows])


def serialize_token(row):
    return dict(
        token_id=row[0],
        kind=row[1],
        label=row[2],
        scopes=row[3],
        revoked_at=row[4].isoformat() if row[4] else None,
        created_at=row[5].isoformat(),
    )


async def revoke_token(ctx, conn, identity, params):
    token_id = require_text(
        params.get("token_id"), "INVALID_TOKEN_ID", "token_id is required"
    )
    cursor = await conn.execute(
        """
        UPDATE tokens SET revoked_at = COALESCE(revoked_at, now())
        WHERE token_id = %s AND kind <> 'bootstrap'
        RETURNING token_id
        """,
        (token_id,),
    )
    if await cursor.fetchone() is None:
        raise RpcError(404, "TOKEN_NOT_FOUND", "Revocable token not found")
    return dict(token_id=token_id, revoked=True)
