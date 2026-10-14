"""In-process hooks and domain events.

Entity hooks (run inside the request transaction; raising aborts the operation):
    @hook("ipd.admissions", "before_create")
    async def fn(ctx, draft): ...
  events: before_create(ctx, draft) · after_create(ctx, rec) · before_update(ctx, next, prev)
          after_update(ctx, rec, prev) · before_transition(ctx, next, prev) · after_transition(ctx, rec, prev)

Domain events (best-effort listeners: notifications, analytics):
    @listen("order.resulted")
    async def fn(ctx, payload): ...
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger("vlack.hooks")

_hooks: dict[str, list[Callable[..., Awaitable[Any]]]] = defaultdict(list)
_listeners: dict[str, list[Callable[..., Awaitable[Any]]]] = defaultdict(list)


def hook(fqn: str, event: str):
    def deco(fn):
        _hooks[f"{fqn}:{event}"].append(fn)
        return fn

    return deco


def listen(name: str):
    def deco(fn):
        _listeners[name].append(fn)
        return fn

    return deco


async def run_hooks(fqn: str, event: str, ctx, *args) -> None:
    for fn in _hooks.get(f"{fqn}:{event}", []):
        await fn(ctx, *args)


async def emit(name: str, ctx, payload: dict) -> None:
    for fn in _listeners.get(name, []):
        try:
            await fn(ctx, payload)
        except Exception:
            log.exception("listener for %s failed", name)
