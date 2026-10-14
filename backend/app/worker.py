"""Background worker (arq on Redis): scheduled jobs for every engine.

Run it next to the API (one process is enough; jobs are `unique`, so extra replicas do not double-run):

    cd backend && .venv/bin/arq app.worker.WorkerSettings

Jobs
* own:   dispatch queued notifications (every minute), IP room + nursing charges (00:05),
         day-before appointment reminders (18:00)
* every `app.engines.<name>` module may declare `CRON = [(async_fn, {"hour": 1, "minute": 30}), ...]`;
  the dict holds arq `cron()` keyword arguments (month / day / weekday / hour / minute / second).
  Job functions receive the arq context dict and open their own `app.db.system_ctx()`.
Times are hospital local time (settings.timezone)."""

from __future__ import annotations

import importlib
import logging
import pkgutil
from collections.abc import Awaitable, Callable
from typing import Any

from arq import cron
from arq.connections import RedisSettings
from arq.cron import CronJob

from . import engines as engines_pkg
from .config import settings
from .core.registry import load_registry
from .db import engine, system_ctx
from .redis import close_redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("vlack.worker")

JobFn = Callable[[dict], Awaitable[Any]]

# Same start-up as the API: module registry first, then engines (their hooks and listeners register on import).
load_registry(strict=settings.strict_modules)
_ENGINE_MODULES = [importlib.import_module(f"app.engines.{m.name}")
                   for m in sorted(pkgutil.iter_modules(engines_pkg.__path__), key=lambda i: i.name)]


# ------------------------------------------------------------------ own jobs

async def dispatch_notifications(arq_ctx: dict) -> dict:
    from .engines.notify import dispatch

    async with system_ctx() as ctx:
        return await dispatch(ctx)


async def daily_room_charges(arq_ctx: dict) -> int:
    from .engines.billing import post_daily_charges

    async with system_ctx() as ctx:
        n = await post_daily_charges(ctx)
    log.info("daily room / nursing charges posted for %s admissions", n)
    return n


async def appointment_reminders(arq_ctx: dict) -> int:
    from .engines.notify import queue_reminders

    async with system_ctx() as ctx:
        return await queue_reminders(ctx)


OWN_JOBS: list[tuple[JobFn, dict]] = [
    (dispatch_notifications, {}),  # every minute (second 0)
    (daily_room_charges, {"hour": 0, "minute": 5}),
    (appointment_reminders, {"hour": 18, "minute": 0}),
]


def collect_cron_jobs() -> list[CronJob]:
    jobs: list[CronJob] = []
    seen: set[str] = set()
    specs: list[tuple[str, JobFn, dict]] = [(f"worker.{fn.__name__}", fn, spec) for fn, spec in OWN_JOBS]
    for mod in _ENGINE_MODULES:
        for fn, spec in getattr(mod, "CRON", []) or []:
            specs.append((f"{mod.__name__.rsplit('.', 1)[-1]}.{fn.__name__}", fn, spec))
    for name, fn, spec in specs:
        if name in seen:
            continue
        seen.add(name)
        jobs.append(cron(fn, name=name, run_at_startup=False, unique=True, timeout=600, **spec))
        log.info("scheduled %s %s", name, spec or "every minute")
    return jobs


async def on_shutdown(arq_ctx: dict) -> None:
    await close_redis()
    await engine.dispose()


class WorkerSettings:
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    functions = [dispatch_notifications, daily_room_charges, appointment_reminders]
    cron_jobs = collect_cron_jobs()
    on_shutdown = on_shutdown
    timezone = settings.tz
    max_jobs = 4
    job_timeout = 600
    keep_result = 3600
    health_check_interval = 60
