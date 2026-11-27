import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
import httpx

from .app_releases import (
    APK_MIME,
    APK_PREFIX,
    APK_SUFFIX,
    require_bearer_auth,
    resolve_local_apk,
    scan_local_latest,
    store_uploaded_apk,
)
from .auth import sync_bootstrap
from .config import Settings
from .context import AppContext
from .db import open_pool, run_migrations
from .deliveries import record_delivery_result
from .errors import RpcError
from .rpc import dispatch
from .scheduler import scheduler_loop
from .sync_ws import handle_sync_ws


async def parse_json_object(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError as exc:
        raise RpcError(
            400, "INVALID_JSON", "Request body must be JSON"
        ) from exc
    if not isinstance(body, dict):
        raise RpcError(422, "INVALID_PARAMS", "Request body must be an object")
    return body


def build_lifespan(settings: Settings):
    @asynccontextmanager
    async def lifespan(app):
        pool = await open_pool(settings.database_url)
        http_client = httpx.AsyncClient(follow_redirects=False, timeout=10.0)
        stop_event = asyncio.Event()
        scheduler_task = None
        try:
            await run_migrations(pool)
            await sync_bootstrap(pool, settings.bootstrap_key)
            ctx = AppContext(
                settings=settings, pool=pool, http_client=http_client
            )
            app.state.ctx = ctx
            if settings.scheduler_enabled:
                scheduler_task = asyncio.create_task(
                    scheduler_loop(ctx, stop_event)
                )
            yield
        finally:
            stop_event.set()
            if scheduler_task is not None:
                scheduler_task.cancel()
                await asyncio.gather(scheduler_task, return_exceptions=True)
            await http_client.aclose()
            await pool.close()

    return lifespan


def register_app_release_routes(app: FastAPI) -> None:
    @app.get("/v1/app/latest")
    async def app_latest(request: Request):
        ctx = app.state.ctx
        await require_bearer_auth(ctx, request.headers.get("authorization"))
        return dict(data=scan_local_latest(ctx.settings.releases_dir))

    @app.get("/v1/app/download/{version}")
    async def app_download(version: str, request: Request):
        ctx = app.state.ctx
        await require_bearer_auth(ctx, request.headers.get("authorization"))
        apk_path, hex_hash = resolve_local_apk(
            ctx.settings.releases_dir, version
        )
        return FileResponse(
            path=apk_path,
            media_type=APK_MIME,
            filename=f"{APK_PREFIX}{version}{APK_SUFFIX}",
            headers={"X-Pocket-Sha256": hex_hash},
        )

    @app.post("/v1/app/releases")
    async def app_upload(request: Request, version: str, notes: str = ""):
        ctx = app.state.ctx
        await require_bearer_auth(
            ctx, request.headers.get("authorization"), require_admin=True
        )
        raw_bytes = await request.body()
        meta = store_uploaded_apk(
            ctx.settings.releases_dir, version, raw_bytes, notes
        )
        ctx.hub.publish_many([dict(type="APP_UPDATE", release=meta)])
        return dict(data=meta)


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(title="Pocket Cloud", lifespan=build_lifespan(settings))
    app.state.settings = settings
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(RpcError)
    async def rpc_error_handler(request, error):
        err = dict(code=error.code, message=error.message)
        return JSONResponse(dict(error=err), status_code=error.status)

    @app.get("/healthz")
    async def health():
        return dict(status="ok")

    register_app_release_routes(app)

    @app.post("/v1/rpc/{method}")
    async def rpc(method: str, request: Request):
        body = await parse_json_object(request)
        return await dispatch(
            app.state.ctx,
            method,
            body,
            request.headers.get("authorization"),
        )

    @app.post("/v1/deliveries/{delivery_id}/result")
    async def delivery_result(delivery_id: str, request: Request):
        body = await parse_json_object(request)
        return await record_delivery_result(
            app.state.ctx,
            delivery_id,
            body,
            request.headers.get("authorization"),
        )

    @app.websocket("/v1/link")
    async def sync_link(websocket: WebSocket):
        await handle_sync_ws(app.state.ctx, websocket)

    return app
