import base64

from httpx import ASGITransport, AsyncClient
import pytest

from pocket_cloud.app import create_app
from pocket_cloud.config import Settings

DEFAULT_DATABASE_URL = (
    "postgresql://pocket:pocket@host.docker.internal:55432/pocket_test"
)


def pytest_addoption(parser):
    parser.addoption(
        "--database-url",
        default=DEFAULT_DATABASE_URL,
        help="PostgreSQL database reserved for Pocket tests",
    )


@pytest.fixture
def settings(request):
    return Settings(
        database_url=request.config.getoption("--database-url"),
        bootstrap_key="test-bootstrap-key",
        secret_key=base64.b64encode(bytes(range(32))).decode(),
        public_url="http://127.0.0.1:8787",
        allow_http_loopback=True,
        scheduler_enabled=False,
    )


@pytest.fixture
async def app(settings):
    application = create_app(settings)
    async with application.router.lifespan_context(application):
        async with application.state.ctx.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM sync_log")
                await conn.execute("DELETE FROM deliveries")
                await conn.execute("DELETE FROM todos")
                await conn.execute("DELETE FROM events")
                await conn.execute("DELETE FROM idempotency")
                await conn.execute("DELETE FROM pairing_codes")
                await conn.execute("DELETE FROM agents")
                await conn.execute(
                    "DELETE FROM tokens WHERE kind <> 'bootstrap'"
                )
        yield application


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as value:
        yield value
