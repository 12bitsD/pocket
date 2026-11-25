import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx

from .config import Settings
from .db import write_tx
from .sync_log import SyncHub


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class AppContext:
    settings: Settings
    pool: object
    clock: Callable[[], datetime] = field(default=utc_now)
    http_client: httpx.AsyncClient | None = None
    hub: SyncHub = field(default_factory=SyncHub)
    _locks: dict[tuple[str, str], asyncio.Lock] = field(default_factory=dict)

    def write_tx(self):
        return write_tx(self.pool, self.hub)

    def standalone_lock(self, method: str, request_id: str) -> asyncio.Lock:
        if len(self._locks) > 1024:
            idle = [k for k, lk in self._locks.items() if not lk.locked()]
            for key in idle:
                self._locks.pop(key, None)
        return self._locks.setdefault((method, request_id), asyncio.Lock())
