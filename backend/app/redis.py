"""Redis: caching, realtime pub/sub, rate limiting, OTPs and token revocation.

Redis is an accelerator, not a source of truth: every helper degrades gracefully so
clinical workflows keep running if Redis is unavailable (downtime mode).
"""

from __future__ import annotations

import logging
import secrets
from collections.abc import Awaitable, Callable
from typing import Any

import orjson
from redis.asyncio import Redis, from_url

from .config import settings

log = logging.getLogger("vlack.redis")
PREFIX = "vlack:"
_redis: Redis | None = None


def get_redis() -> Redis:
    global _redis
    if _redis is None:
        _redis = from_url(settings.redis_url, decode_responses=True, socket_connect_timeout=2, socket_timeout=2)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


async def ping() -> bool:
    try:
        return bool(await get_redis().ping())
    except Exception:
        return False


async def cached(key: str, ttl: int, fn: Callable[[], Awaitable[Any]]) -> Any:
    k = f"{PREFIX}cache:{key}"
    try:
        hit = await get_redis().get(k)
        if hit is not None:
            return orjson.loads(hit)
    except Exception as e:
        log.warning("cache read failed: %s", e)
    value = await fn()
    try:
        await get_redis().set(k, orjson.dumps(value, default=str), ex=ttl)
    except Exception as e:
        log.warning("cache write failed: %s", e)
    return value


async def invalidate(prefix: str) -> None:
    try:
        r = get_redis()
        async for k in r.scan_iter(f"{PREFIX}cache:{prefix}*", count=500):
            await r.delete(k)
    except Exception as e:
        log.warning("cache invalidate failed: %s", e)


async def publish(channel: str, payload: dict) -> None:
    """Realtime fan-out to SSE subscribers (see api/realtime.py)."""
    try:
        await get_redis().publish(f"{PREFIX}rt:{channel}", orjson.dumps(payload, default=str))
    except Exception as e:
        log.warning("publish failed: %s", e)


async def rate_limited(key: str, limit: int, window_s: int) -> bool:
    """True when `key` exceeded `limit` hits within `window_s`. Fails open."""
    try:
        r = get_redis()
        k = f"{PREFIX}rl:{key}"
        n = await r.incr(k)
        if n == 1:
            await r.expire(k, window_s)
        return n > limit
    except Exception:
        return False


async def reset_rate_limit(key: str) -> None:
    try:
        await get_redis().delete(f"{PREFIX}rl:{key}")
    except Exception:
        pass


async def otp_issue(purpose: str, subject: str, ttl: int = 300) -> str:
    code = f"{secrets.randbelow(1_000_000):06d}"
    await get_redis().set(f"{PREFIX}otp:{purpose}:{subject}", code, ex=ttl)
    return code


async def otp_verify(purpose: str, subject: str, code: str) -> bool:
    r = get_redis()
    k = f"{PREFIX}otp:{purpose}:{subject}"
    want = await r.get(k)
    if want and secrets.compare_digest(want, str(code).strip()):
        await r.delete(k)
        return True
    return False


async def revoke_token(jti: str, ttl: int) -> None:
    await get_redis().set(f"{PREFIX}revoked:{jti}", "1", ex=max(ttl, 1))


async def is_revoked(jti: str) -> bool:
    try:
        return bool(await get_redis().exists(f"{PREFIX}revoked:{jti}"))
    except Exception:
        return False
