from dataclasses import dataclass, replace
from hashlib import sha256
import json
from types import MappingProxyType

from psycopg.types.json import Jsonb

from .agents import list_agents, revoke_agent, set_agent
from .auth import authenticate_raw_conn
from .bootstrap_svc import bootstrap_snapshot
from .calendar_svc import delete_event, list_events, set_event
from .errors import RpcError
from .pairing import (
    PairingAttemptFailed,
    claim_pairing,
    create_pairing,
    register_failed_attempt,
)
from .todo_svc import delete_todo, list_todos, set_todo, toggle_todo
from .todo_trigger import trigger_todo
from .tokens import create_token, list_tokens, revoke_token
from .validators import require_text

VALID_SOURCES = ("local", "web", "agent")
PUBLIC_METHODS = ("pairing.claim",)
READ_METHODS = (
    "auth.status",
    "sync.bootstrap",
    "token.list",
    "agent.list",
    "event.list",
    "todo.list",
)
STANDALONE_WRITE_METHODS = ("todo.trigger",)
ADMIN_METHODS = (
    "pairing.create",
    "token.create",
    "token.list",
    "token.revoke",
    "agent.set",
    "agent.list",
    "agent.revoke",
)
SCOPED_METHODS = (
    ("event.list", "event.read"),
    ("event.set", "event.write"),
    ("event.delete", "event.write"),
    ("todo.list", "todo.read"),
    ("todo.set", "todo.write"),
    ("todo.toggle", "todo.write"),
    ("todo.delete", "todo.write"),
    ("todo.trigger", "todo.write"),
)


@dataclass(frozen=True)
class RawRpcRequest:
    method: str
    body: dict
    source: str
    raw_token: str | None


@dataclass(frozen=True)
class Call:
    ctx: object
    method: str
    identity: object
    params: dict


def auth_status(ctx, conn, identity, params) -> dict:
    return dict(
        kind=identity.kind,
        label=identity.label,
        scopes=identity.scopes,
    )


HANDLERS = MappingProxyType(
    dict(
        (
            ("agent.set", set_agent),
            ("agent.list", list_agents),
            ("agent.revoke", revoke_agent),
            ("auth.status", auth_status),
            ("sync.bootstrap", bootstrap_snapshot),
            ("pairing.create", create_pairing),
            ("pairing.claim", claim_pairing),
            ("token.create", create_token),
            ("token.list", list_tokens),
            ("token.revoke", revoke_token),
            ("event.list", list_events),
            ("event.set", set_event),
            ("event.delete", delete_event),
            ("todo.list", list_todos),
            ("todo.set", set_todo),
            ("todo.toggle", toggle_todo),
            ("todo.delete", delete_todo),
            ("todo.trigger", trigger_todo),
        )
    )
)


def parse_source(body: dict) -> str:
    source = body.get("source", "local")
    if not isinstance(source, str) or source not in VALID_SOURCES:
        raise RpcError(
            422, "INVALID_SOURCE", "source must be local, web, or agent"
        )
    return source


def check_permissions(method: str, identity) -> None:
    if method in PUBLIC_METHODS:
        return
    if identity is None:
        raise RpcError(401, "UNAUTHORIZED", "Valid bearer token required")
    if "*" in identity.scopes:
        return
    if method in ADMIN_METHODS:
        raise RpcError(403, "FORBIDDEN", "Personal token required")
    for target_method, required_scope in SCOPED_METHODS:
        if method == target_method and required_scope not in identity.scopes:
            raise RpcError(
                403, "FORBIDDEN", "Missing required scope: %s" % required_scope
            )


def extract_bearer_token(method: str, authorization: str | None) -> str | None:
    has_bearer = isinstance(authorization, str) and authorization.startswith(
        "Bearer "
    )
    if has_bearer:
        return authorization.removeprefix("Bearer ")
    if method not in PUBLIC_METHODS:
        raise RpcError(401, "UNAUTHORIZED", "Valid bearer token required")
    return None


def extract_params(body: dict) -> dict:
    params = body.get("params", dict())
    if not isinstance(params, dict):
        raise RpcError(422, "INVALID_PARAMS", "params must be an object")
    return params


async def resolve_call(ctx, conn, req: RawRpcRequest) -> Call:
    raw_id = await authenticate_raw_conn(conn, req.raw_token)
    identity = (
        replace(raw_id, source=req.source) if raw_id is not None else None
    )
    check_permissions(req.method, identity)
    return Call(ctx, req.method, identity, extract_params(req.body))


async def dispatch(ctx, method, body, authorization):
    if method not in HANDLERS:
        raise RpcError(404, "METHOD_NOT_FOUND", "Unknown RPC method")
    source = parse_source(body)
    raw_token = extract_bearer_token(method, authorization)
    req = RawRpcRequest(method, body, source, raw_token)
    if method in READ_METHODS:
        async with ctx.pool.connection() as conn:
            call = await resolve_call(ctx, conn, req)
            data = await call_handler(call, conn)
        return dict(data=data)
    if method in STANDALONE_WRITE_METHODS:
        return await dispatch_standalone_write(ctx, req)
    try:
        return await dispatch_write(ctx, req)
    except PairingAttemptFailed as error:
        await register_failed_attempt(ctx.pool, error.code_id, ctx.clock())
        raise RpcError(
            401, "INVALID_PAIRING_CODE", "Pairing code is invalid"
        ) from error


async def call_handler(call: Call, conn):
    handler = HANDLERS[call.method]
    result = handler(call.ctx, conn, call.identity, call.params)
    return await result if hasattr(result, "__await__") else result


def prepare_idempotency(call: Call, body: dict, source: str) -> tuple[str, str]:
    request_id = require_text(
        body.get("request_id"), "REQUEST_ID_REQUIRED", "request_id is required"
    )
    token_id = call.identity.token_id if call.identity is not None else None
    payload = dict(token_id=token_id, source=source, params=call.params)
    return request_id, hash_payload(payload)


async def store_idempotency(
    conn, call: Call, request_id: str, entry: dict
) -> None:
    await conn.execute(
        """
        INSERT INTO idempotency (
            method, request_id, payload_hash, response_body
        ) VALUES (%s, %s, %s, %s)
        """,
        (call.method, request_id, entry["hash"], Jsonb(entry["response"])),
    )


async def dispatch_write(ctx, req: RawRpcRequest) -> dict:
    call = None
    response = None
    async with ctx.write_tx() as tx:
        call = await resolve_call(ctx, tx, req)
        request_id, payload_hash = prepare_idempotency(
            call, req.body, req.source
        )
        cached = await replay_response(
            tx, call.method, request_id, payload_hash
        )
        if cached is not None:
            response = cached
        else:
            data = await call_handler(call, tx)
            response = dict(data=data)
            entry = dict(hash=payload_hash, response=response)
            await store_idempotency(tx, call, request_id, entry)
    if call is not None and call.method == "token.revoke":
        await ctx.hub.kick_token(response["data"]["token_id"])
    return response


def standalone_lock_key(body: dict) -> str | None:
    raw = body.get("request_id")
    if not isinstance(raw, str) or not raw.strip():
        return None
    return sha256(raw.strip().encode()).hexdigest()


async def run_standalone_write_locked(ctx, req: RawRpcRequest) -> dict:
    call = None
    request_id = ""
    payload_hash = ""
    async with ctx.write_tx() as tx:
        call = await resolve_call(ctx, tx, req)
        request_id, payload_hash = prepare_idempotency(
            call, req.body, req.source
        )
        cached = await replay_response(
            tx, call.method, request_id, payload_hash
        )
        if cached is not None:
            return cached
    handler = HANDLERS[call.method]
    data = await handler(ctx, call.identity, call.params)
    response = dict(data=data)
    entry = dict(hash=payload_hash, response=response)
    async with ctx.write_tx() as tx:
        await store_idempotency(tx, call, request_id, entry)
    return response


async def dispatch_standalone_write(ctx, req: RawRpcRequest) -> dict:
    key = standalone_lock_key(req.body)
    if key is None:
        return await run_standalone_write_locked(ctx, req)
    async with ctx.standalone_lock(req.method, key):
        return await run_standalone_write_locked(ctx, req)


async def replay_response(
    conn, method: str, request_id: str, payload_hash: str
):
    cursor = await conn.execute(
        """
        SELECT payload_hash, response_body FROM idempotency
        WHERE method = %s AND request_id = %s
        """,
        (method, request_id),
    )
    row = await cursor.fetchone()
    if row is None:
        return None
    if row[0] != payload_hash:
        raise RpcError(409, "REQUEST_ID_CONFLICT", "request_id payload changed")
    return row[1]


def hash_payload(payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode()).hexdigest()
