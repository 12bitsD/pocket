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
from .cli_commands import add_domain_parsers, execute_domain, format_table
from .cli_sync import add_sync_parsers, execute_sync
from .config import Settings
from .crypto import encryption_key
from .errors import CliError


@dataclass(frozen=True)
class Target:
    base_url: str
    token: str | None
    ws_connect: object = None


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
    groups = parser.add_subparsers(dest="group", required=True)
    groups.add_parser("serve")
    groups.add_parser("status", parents=[json_parent])
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
    pair.add_parser("create", parents=[json_parent])
    claim = pair.add_parser("claim", parents=[json_parent])
    claim.add_argument("code")
    claim.add_argument("--name", required=True)


def add_token_parsers(groups, json_parent):
    token = groups.add_parser("token").add_subparsers(
        dest="action", required=True
    )
    create = token.add_parser("create", parents=[json_parent])
    create.add_argument("--kind", choices=["web", "agent"], required=True)
    create.add_argument("--label", required=True)
    create.add_argument("--scopes", default="")
    token.add_parser("list", parents=[json_parent])
    revoke = token.add_parser("revoke", parents=[json_parent])
    revoke.add_argument("token_id")


def add_agent_parsers(groups, json_parent):
    agent = groups.add_parser("agent").add_subparsers(
        dest="action", required=True
    )
    set_parser = agent.add_parser("set", parents=[json_parent])
    set_parser.add_argument("agent_id")
    set_parser.add_argument("--url", required=True)
    set_parser.add_argument("--key")
    set_parser.add_argument("--name")
    agent.add_parser("list", parents=[json_parent])
    revoke = agent.add_parser("revoke", parents=[json_parent])
    revoke.add_argument("agent_id")


async def run_with_args(args, target: Target, client):
    if args.group == "serve":
        raise CliError("serve is available only from the process entry point")
    data = await execute(args, target, client)
    is_watch = args.group == "sync" and getattr(args, "action", "") == "watch"
    json_mode = getattr(args, "json_output", False)
    if not is_watch:
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
    if client is not None or args.group == "sync":
        return await run_with_args(args, target, client)
    async with httpx.AsyncClient(timeout=10) as owned_client:
        return await run_with_args(args, target, owned_client)


async def run(argv, env, client=None, ws_connect=None):
    args = parse_cli_args(argv)
    target = build_target(env, ws_connect)
    return await run_with_client(args, target, client)


async def execute(args, target, client):
    if args.group == "sync":
        return await execute_sync(args, target)
    rpc = RpcClient(client, target)
    if args.group == "status":
        try:
            response = await client.get(f"{target.base_url}/healthz")
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise CliError(f"Health check failed: {exc}") from exc
        identity = await rpc.call("auth.status", dict())
        return dict(health=response.json(), identity=identity)
    if args.group == "pair":
        return await execute_pair(args, rpc)
    if args.group == "token":
        return await execute_token(args, rpc)
    if args.group == "agent":
        return await execute_agent(args, rpc)
    return await execute_domain(args, rpc, new_request_id)


async def execute_pair(args, rpc):
    if args.action == "create":
        return await rpc.call("pairing.create", dict(), new_request_id())
    public_rpc = RpcClient(rpc.client, replace(rpc.target, token=None))
    params = dict(code=args.code, name=args.name)
    return await public_rpc.call("pairing.claim", params, new_request_id())


async def execute_token(args, rpc):
    if args.action == "list":
        return await rpc.call("token.list", dict())
    if args.action == "revoke":
        params = dict(token_id=args.token_id)
        return await rpc.call("token.revoke", params, new_request_id())
    scopes = [value for value in args.scopes.split(",") if value]
    params = dict(kind=args.kind, label=args.label, scopes=scopes)
    return await rpc.call("token.create", params, new_request_id())


async def execute_agent(args, rpc):
    if args.action == "list":
        return await rpc.call("agent.list", dict())
    if args.action == "revoke":
        params = dict(agent_id=args.agent_id)
        return await rpc.call("agent.revoke", params, new_request_id())
    params = dict(
        agent_id=args.agent_id,
        name=args.name or args.agent_id,
        endpoint_url=args.url,
        credential=args.key,
    )
    return await rpc.call("agent.set", params, new_request_id())


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
        )
    except KeyError as error:
        raise CliError("Missing configuration: %s" % str(error.args[0]))
    if not settings.bootstrap_key:
        raise CliError("POCKET_BOOTSTRAP_KEY must not be empty")
    try:
        encryption_key(settings.secret_key)
    except (ValueError, TypeError) as error:
        raise CliError(str(error))
    return settings


def main():
    env = dict(os.environ)  # bits:allow(BCS011): 进程入口读取环境变量
    args = parse_cli_args(sys.argv[1:])
    try:
        if args.group == "serve":
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
