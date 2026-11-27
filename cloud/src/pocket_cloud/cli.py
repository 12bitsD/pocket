import argparse
import asyncio
from dataclasses import dataclass, replace
import json
import os
import sys
from uuid import uuid4

import httpx
import uvicorn

from .app import create_app
from .cli_commands import (
    add_domain_parsers,
    format_table,
    rpc_read,
    rpc_write,
)
from .cli_sync import add_sync_parsers
from .config import Settings
from .crypto import encryption_key
from .errors import CliError


@dataclass(frozen=True)
class Target:
    base_url: str
    token: str | None
    ws_connect: object = None


@dataclass(frozen=True)
class CliRuntime:
    target: Target
    rpc: object
    new_request_id: object


def format_http_error(response: httpx.Response) -> str:
    try:
        error = response.json().get("error", dict())
    except ValueError:
        error = dict()
    code = error.get("code", "")
    message = error.get("message", response.text)
    prefix = f"{response.status_code} {code}".strip()
    return f"{prefix}: {message}"


class RpcClient:
    def __init__(self, client, target):
        self.client = client
        self.target = target

    async def call(self, method, params, request_id=None):
        body = dict(params=params)
        if request_id is not None:
            body["request_id"] = request_id
        headers = dict()
        if self.target.token:
            headers["Authorization"] = f"Bearer {self.target.token}"
        url = f"{self.target.base_url}/v1/rpc/{method}"
        try:
            response = await self.client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise CliError(f"Request failed: {exc}") from exc
        if response.status_code >= 400:
            raise CliError(format_http_error(response))
        return response.json()["data"]


def build_parser():
    json_parent = argparse.ArgumentParser(add_help=False)
    json_parent.add_argument("--json", dest="json_output", action="store_true")

    parser = argparse.ArgumentParser(prog="pocket-cloud")
    parser.add_argument("--json", dest="root_json", action="store_true")
    parser.set_defaults(uses_http=True, is_watch=False, is_serve=False)
    groups = parser.add_subparsers(dest="group", required=True)
    groups.add_parser("serve").set_defaults(is_serve=True, uses_http=False)
    groups.add_parser("status", parents=[json_parent]).set_defaults(
        handler=handle_status
    )
    add_pair_parsers(groups, json_parent)
    add_token_parsers(groups, json_parent)
    add_agent_parsers(groups, json_parent)
    add_domain_parsers(groups, json_parent)
    add_sync_parsers(groups, json_parent)
    return parser


def parse_cli_args(argv):
    args = build_parser().parse_args(argv)
    args.json_output = bool(
        getattr(args, "root_json", False) or getattr(args, "json_output", False)
    )
    return args


def add_pair_parsers(groups, json_parent):
    pair = groups.add_parser("pair").add_subparsers(
        dest="action", required=True
    )
    pair.add_parser("create", parents=[json_parent]).set_defaults(
        handler=rpc_write("pairing.create")
    )
    claim = pair.add_parser("claim", parents=[json_parent])
    claim.add_argument("code")
    claim.add_argument("--name", required=True)
    claim.set_defaults(handler=handle_pair_claim)


def add_token_parsers(groups, json_parent):
    token = groups.add_parser("token").add_subparsers(
        dest="action", required=True
    )
    create = token.add_parser("create", parents=[json_parent])
    create.add_argument("--kind", choices=["web", "agent"], required=True)
    create.add_argument("--label", required=True)
    create.add_argument("--scopes", default="")
    create.set_defaults(handler=handle_token_create)
    token.add_parser("list", parents=[json_parent]).set_defaults(
        handler=rpc_read("token.list")
    )
    revoke = token.add_parser("revoke", parents=[json_parent])
    revoke.add_argument("token_id")
    revoke.set_defaults(handler=rpc_write("token.revoke", "token_id"))


def add_agent_parsers(groups, json_parent):
    agent = groups.add_parser("agent").add_subparsers(
        dest="action", required=True
    )
    set_parser = agent.add_parser("set", parents=[json_parent])
    set_parser.add_argument("agent_id")
    set_parser.add_argument("--url", required=True)
    set_parser.add_argument("--key")
    set_parser.add_argument("--name")
    set_parser.set_defaults(handler=handle_agent_set)
    agent.add_parser("list", parents=[json_parent]).set_defaults(
        handler=rpc_read("agent.list")
    )
    revoke = agent.add_parser("revoke", parents=[json_parent])
    revoke.add_argument("agent_id")
    revoke.set_defaults(handler=rpc_write("agent.revoke", "agent_id"))


async def run_with_args(args, target: Target, client):
    if args.is_serve:
        raise CliError("serve is available only from the process entry point")
    rpc = RpcClient(client, target) if client is not None else None
    data = await args.handler(args, CliRuntime(target, rpc, new_request_id))
    json_mode = getattr(args, "json_output", False)
    if not args.is_watch:
        if json_mode:
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            print(format_table(data))
    elif not json_mode and getattr(args, "limit", None) == 0:
        print(
            "latest_seq=%d replayed=%d"
            % (data["latest_seq"], data["replayed"])
        )
    return data


def build_target(env, ws_connect=None) -> Target:
    return Target(
        base_url=env.get("POCKET_URL", "http://127.0.0.1:8787").rstrip("/"),
        token=env.get("POCKET_TOKEN"),
        ws_connect=ws_connect,
    )


async def run_with_client(args, target: Target, client=None):
    if client is not None or not args.uses_http:
        return await run_with_args(args, target, client)
    async with httpx.AsyncClient(timeout=10) as owned_client:
        return await run_with_args(args, target, owned_client)


async def run(argv, env, client=None, ws_connect=None):
    args = parse_cli_args(argv)
    target = build_target(env, ws_connect)
    return await run_with_client(args, target, client)


async def handle_status(args, rt: CliRuntime):
    _ = args
    try:
        response = await rt.rpc.client.get(f"{rt.target.base_url}/healthz")
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise CliError(f"Health check failed: {exc}") from exc
    identity = await rt.rpc.call("auth.status", dict())
    return dict(health=response.json(), identity=identity)


async def handle_pair_claim(args, rt: CliRuntime):
    public_rpc = RpcClient(rt.rpc.client, replace(rt.target, token=None))
    params = dict(code=args.code, name=args.name)
    return await public_rpc.call("pairing.claim", params, rt.new_request_id())


async def handle_token_create(args, rt: CliRuntime):
    scopes = [value for value in args.scopes.split(",") if value]
    params = dict(kind=args.kind, label=args.label, scopes=scopes)
    return await rt.rpc.call("token.create", params, rt.new_request_id())


async def handle_agent_set(args, rt: CliRuntime):
    params = dict(
        agent_id=args.agent_id,
        name=args.name or args.agent_id,
        endpoint_url=args.url,
        credential=args.key,
    )
    return await rt.rpc.call("agent.set", params, rt.new_request_id())


def new_request_id():
    return f"req_{uuid4().hex}"


def load_config(env):
    try:
        settings = Settings(
            database_url=env["DATABASE_URL"],
            bootstrap_key=env["POCKET_BOOTSTRAP_KEY"],
            secret_key=env["POCKET_SECRET_KEY"],
            public_url=env.get("POCKET_PUBLIC_URL", "http://127.0.0.1:8787"),
            allow_http_loopback=env.get("POCKET_ALLOW_HTTP_LOOPBACK") == "true",
            releases_dir=env.get("POCKET_RELEASES_DIR", "").strip(),
            feishu_app_id=env.get("POCKET_FEISHU_APP_ID", "").strip(),
            feishu_app_secret=env.get("POCKET_FEISHU_APP_SECRET", "").strip(),
        )
    except KeyError as error:
        raise CliError(
            "Missing configuration: %s" % str(error.args[0])
        ) from error
    if not settings.bootstrap_key:
        raise CliError("POCKET_BOOTSTRAP_KEY must not be empty")
    try:
        encryption_key(settings.secret_key)
    except (ValueError, TypeError) as error:
        raise CliError(str(error)) from error
    return settings


def main():
    env = dict(os.environ)  # bits:allow(BCS011): 进程入口读取环境变量
    args = parse_cli_args(sys.argv[1:])
    try:
        if args.is_serve:
            settings = load_config(env)
            port = int(env.get("POCKET_PORT", "8787"))
            uvicorn.run(
                create_app(settings),
                host="0.0.0.0",
                port=port,
                ws_max_size=65536,
            )
        else:
            asyncio.run(run_with_client(args, build_target(env)))
    except CliError as error:
        print("pocket-cloud: %s" % str(error), file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        raise SystemExit(130)


if __name__ == "__main__":
    main()
