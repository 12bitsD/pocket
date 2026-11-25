import ipaddress
import re
from urllib.parse import urlsplit

from .crypto import encrypt_secret
from .errors import RpcError
from .validators import require_text

AGENT_ID_PATTERN = re.compile(r"@[a-z0-9][a-z0-9_-]{1,30}")


async def set_agent(ctx, conn, identity, params):
    agent_id = params.get("agent_id")
    endpoint_url = params.get("endpoint_url")
    validate_agent_id(agent_id)
    validate_endpoint(ctx.settings, endpoint_url)
    name = require_text(
        params.get("name", agent_id), "INVALID_NAME", "Agent name is required"
    )
    credential = params.get("credential")
    cursor = await conn.execute(
        "SELECT credential_ciphertext FROM agents WHERE agent_id = %s",
        (agent_id,),
    )
    row = await cursor.fetchone()
    ciphertext = resolve_ciphertext(ctx.settings.secret_key, credential, row)
    await conn.execute(
        """
        INSERT INTO agents (
            agent_id, name, endpoint_url, credential_ciphertext
        ) VALUES (%s, %s, %s, %s)
        ON CONFLICT (agent_id) DO UPDATE SET
            name = EXCLUDED.name,
            endpoint_url = EXCLUDED.endpoint_url,
            credential_ciphertext = EXCLUDED.credential_ciphertext,
            active = TRUE,
            updated_at = now()
        """,
        (agent_id, name, endpoint_url, ciphertext),
    )
    return dict(agent_id=agent_id, active=True)


def resolve_ciphertext(secret_key: str, credential, existing_row) -> str:
    if credential is None:
        if existing_row is None:
            raise RpcError(422, "CREDENTIAL_REQUIRED", "Credential is required")
        return existing_row[0]
    if not isinstance(credential, str) or not credential:
        raise RpcError(422, "INVALID_CREDENTIAL", "Credential must be text")
    return encrypt_secret(secret_key, credential)


def validate_agent_id(agent_id) -> None:
    valid = isinstance(agent_id, str) and AGENT_ID_PATTERN.fullmatch(agent_id)
    if not valid or agent_id == "@me":
        raise RpcError(422, "INVALID_AGENT_ID", "Invalid external Agent id")


def is_safe_endpoint_host(settings, scheme: str, host: str) -> bool:
    lowered = host.lower()
    if lowered == "localhost" or lowered.endswith(".localhost"):
        return False
    is_loopback_http = scheme == "http" and host == "127.0.0.1"
    if settings.allow_http_loopback and is_loopback_http:
        return True
    if scheme != "https":
        return False
    addr = None
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        addr = None
    return True if addr is None else addr.is_global


def validate_endpoint(settings, endpoint_url) -> None:
    is_clean = isinstance(endpoint_url, str) and (
        endpoint_url == endpoint_url.strip()
    )
    if not is_clean:
        raise RpcError(422, "INVALID_ENDPOINT", "HTTPS endpoint is required")
    parsed = urlsplit(endpoint_url)
    has_extras = bool(
        parsed.query or parsed.fragment or parsed.username or parsed.password
    )
    host = parsed.hostname
    if not parsed.netloc or not host or has_extras:
        raise RpcError(422, "INVALID_ENDPOINT", "HTTPS endpoint is required")
    if not is_safe_endpoint_host(settings, parsed.scheme, host):
        raise RpcError(422, "INVALID_ENDPOINT", "HTTPS endpoint is required")


async def ensure_active_agent(conn, agent_id: str) -> tuple[str, str]:
    cursor = await conn.execute(
        """
        SELECT active, endpoint_url, credential_ciphertext
        FROM agents WHERE agent_id = %s
        """,
        (agent_id,),
    )
    row = await cursor.fetchone()
    if row is None:
        raise RpcError(404, "AGENT_NOT_FOUND", "Agent not found")
    if not row[0]:
        raise RpcError(422, "AGENT_INACTIVE", "Agent is inactive")
    return row[1], row[2]


async def list_agents(ctx, conn, identity, params):
    cursor = await conn.execute(
        """
        SELECT agent_id, name, endpoint_url, active, updated_at
        FROM agents ORDER BY agent_id
        """
    )
    rows = await cursor.fetchall()
    agents = [
        dict(
            agent_id=row[0],
            name=row[1],
            endpoint_url=row[2],
            active=row[3],
            updated_at=row[4].isoformat(),
        )
        for row in rows
    ]
    return dict(agents=agents)


async def revoke_agent(ctx, conn, identity, params):
    agent_id = params.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id:
        raise RpcError(404, "AGENT_NOT_FOUND", "Agent not found")
    cursor = await conn.execute(
        """
        UPDATE agents SET active = FALSE, updated_at = now()
        WHERE agent_id = %s RETURNING agent_id
        """,
        (agent_id,),
    )
    if await cursor.fetchone() is None:
        raise RpcError(404, "AGENT_NOT_FOUND", "Agent not found")
    return dict(agent_id=agent_id, active=False)
