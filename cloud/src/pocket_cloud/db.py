from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from psycopg_pool import AsyncConnectionPool


@dataclass
class WriteTx:
    conn: object
    staged: list[dict] = field(default_factory=list)

    def execute(self, query, params=None):
        if params is None:
            return self.conn.execute(query)
        return self.conn.execute(query, params)

    def cursor(self, **kwargs):
        return self.conn.cursor(**kwargs)


async def open_pool(database_url: str):
    pool = AsyncConnectionPool(database_url, open=False)
    await pool.open()
    return pool


async def run_migrations(pool):
    async with pool.connection() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        await conn.commit()
    migrations = Path(__file__).parents[2] / "migrations"
    for path in sorted(migrations.glob("*.sql")):
        await apply_migration(pool, path)


async def apply_migration(pool, path):
    async with pool.connection() as conn:
        async with conn.transaction():
            cursor = await conn.execute(
                "SELECT version FROM schema_migrations WHERE version = %s",
                (path.name,),
            )
            if await cursor.fetchone() is not None:
                return
            await conn.execute(path.read_text())
            await conn.execute(
                "INSERT INTO schema_migrations (version) VALUES (%s)",
                (path.name,),
            )


@asynccontextmanager
async def write_tx(pool, hub=None):
    tx = None
    async with pool.connection() as conn:
        tx = WriteTx(conn=conn)
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(1)")
            yield tx
    if hub is not None and tx is not None and tx.staged:
        hub.publish_many(tx.staged)
