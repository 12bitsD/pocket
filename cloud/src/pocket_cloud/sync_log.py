import asyncio
from dataclasses import dataclass, field

from fastapi import WebSocketDisconnect
from psycopg.types.json import Jsonb

from .db import WriteTx

MAX_WS_QUEUE = 256


@dataclass(frozen=True)
class SyncEntry:
    entity_type: str
    entity_id: str
    action: str
    revision: int
    payload: dict


def make_bounded_queue() -> asyncio.Queue:
    return asyncio.Queue(maxsize=MAX_WS_QUEUE)


@dataclass(eq=False)
class Subscriber:
    token_id: str
    websocket: object
    queue: asyncio.Queue = field(default_factory=make_bounded_queue)
    kicked: bool = False


async def close_socket_quietly(websocket, code: int, reason: str) -> bool:
    closed = True
    try:
        await websocket.close(code=code, reason=reason)
    except (WebSocketDisconnect, RuntimeError, OSError):
        closed = False
    return closed


class SyncHub:
    def __init__(self) -> None:
        self._subscribers: set[Subscriber] = set()

    def register(self, token_id: str, websocket) -> Subscriber:
        sub = Subscriber(token_id=token_id, websocket=websocket)
        self._subscribers.add(sub)
        return sub

    def unregister(self, sub: Subscriber) -> None:
        self._subscribers.discard(sub)

    def enqueue(self, sub: Subscriber, item: dict) -> None:
        if sub.kicked:
            return
        if sub.queue.full():
            self._subscribers.discard(sub)
            sub.kicked = True
            asyncio.create_task(
                close_socket_quietly(sub.websocket, 1013, "Slow consumer")
            )
            return
        sub.queue.put_nowait(item)

    def publish_many(self, frames: list[dict]) -> None:
        targets = tuple(self._subscribers)
        for frame in frames:
            for sub in targets:
                self.enqueue(sub, frame)

    async def kick_token(self, token_id: str) -> None:
        matched = [
            sub for sub in tuple(self._subscribers) if sub.token_id == token_id
        ]
        for sub in matched:
            self._subscribers.discard(sub)
            sub.kicked = True
            if sub.queue.full():
                sub.queue.get_nowait()
            sub.queue.put_nowait(None)
            await close_socket_quietly(sub.websocket, 4401, "Token revoked")


def make_sync_frame(seq: int, entry: SyncEntry) -> dict:
    return dict(
        type="SYNC_PUSH",
        seq=seq,
        entity_type=entry.entity_type,
        entity_id=entry.entity_id,
        action=entry.action,
        revision=entry.revision,
        payload=entry.payload,
    )


async def append_sync_log(tx: WriteTx, entry: SyncEntry) -> dict:
    cursor = await tx.execute(
        """
        INSERT INTO sync_log (
            entity_type, entity_id, action, revision, payload
        ) VALUES (%s, %s, %s, %s, %s)
        RETURNING seq
        """,
        (
            entry.entity_type,
            entry.entity_id,
            entry.action,
            entry.revision,
            Jsonb(entry.payload),
        ),
    )
    row = await cursor.fetchone()
    frame = make_sync_frame(row[0], entry)
    tx.staged.append(frame)
    return frame


async def log_upsert(tx: WriteTx, entity_type: str, snapshot: dict) -> dict:
    id_key = entity_type + "_id"
    entry = SyncEntry(
        entity_type=entity_type,
        entity_id=snapshot[id_key],
        action="upsert",
        revision=snapshot["revision"],
        payload=snapshot,
    )
    return await append_sync_log(tx, entry)


async def log_delete(
    tx: WriteTx, entity_type: str, entity_id: str, revision: int
) -> dict:
    id_key = entity_type + "_id"
    payload = dict(
        ((id_key, entity_id), ("deleted", True), ("revision", revision))
    )
    entry = SyncEntry(entity_type, entity_id, "delete", revision, payload)
    return await append_sync_log(tx, entry)


async def fetch_sync_catchup(
    conn, last_seq: int
) -> tuple[int, list[dict]]:
    cursor = await conn.execute(
        """
        WITH head AS (
            SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM sync_log
        )
        SELECT
            h.latest_seq, s.seq, s.entity_type, s.entity_id,
            s.action, s.revision, s.payload
        FROM head h
        LEFT JOIN sync_log s ON s.seq > %s
        ORDER BY s.seq ASC
        """,
        (last_seq,),
    )
    rows = await cursor.fetchall()
    latest_seq = rows[0][0] if rows else 0
    frames = [
        make_sync_frame(
            row[1], SyncEntry(row[2], row[3], row[4], row[5], row[6])
        )
        for row in rows
        if row[1] is not None
    ]
    return latest_seq, frames
