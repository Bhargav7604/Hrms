from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import orjson
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from .config import settings

log = logging.getLogger("vlack.db")


def _json_dumps(v: Any) -> str:
    return orjson.dumps(v, default=str).decode()


engine = create_async_engine(
    settings.database_url,
    pool_size=20,
    max_overflow=20,
    pool_pre_ping=True,
    echo=settings.sql_echo,
    json_serializer=_json_dumps,
    json_deserializer=orjson.loads,
)


@dataclass
class Ctx:
    """Per-request unit of work: one connection + transaction, the acting user, and
    callbacks to run once the transaction has committed (Redis publish, job enqueue)."""

    conn: AsyncConnection
    user: dict
    ip: str | None = None
    break_glass: str | None = None
    # Active branch (X-Branch header). None for system jobs/seeds: no branch filtering, records
    # are created in the default branch.
    branch: str | None = None
    after_commit: list[Callable[[], Awaitable[None]]] = field(default_factory=list)

    @property
    def role(self) -> str:
        return self.user.get("role", "")

    @property
    def user_id(self) -> str:
        return str(self.user.get("id", "system"))

    def on_commit(self, fn: Callable[[], Awaitable[None]]) -> None:
        self.after_commit.append(fn)

    async def run_after_commit(self) -> None:
        for fn in self.after_commit:
            try:
                await fn()
            except Exception:  # never fail a committed request because of a side effect
                log.exception("after-commit callback failed")
        self.after_commit.clear()


SYSTEM_USER = {"id": "system", "name": "System", "role": "admin", "username": "system"}


class system_ctx:
    """`async with system_ctx() as ctx:` — for seeds, jobs and tests."""

    def __init__(self, user: dict | None = None):
        self.user = user or SYSTEM_USER

    async def __aenter__(self) -> Ctx:
        self._conn_cm = engine.connect()
        conn = await self._conn_cm.__aenter__()
        self._tx = await conn.begin()
        self.ctx = Ctx(conn=conn, user=self.user)
        return self.ctx

    async def __aexit__(self, exc_type, exc, tb):
        try:
            if exc_type:
                await self._tx.rollback()
            else:
                await self._tx.commit()
        finally:
            await self._conn_cm.__aexit__(exc_type, exc, tb)
        if not exc_type:
            await self.ctx.run_after_commit()
