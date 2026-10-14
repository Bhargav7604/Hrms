"""Vlack HRMS API — FastAPI application factory."""

from __future__ import annotations

import importlib
import logging
import pkgutil
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import engines as engines_pkg
from .api import auth, common, meta, rbac, records
from .config import settings
from .core.registry import load_registry
from .db import engine
from .redis import close_redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("vlack")


def run_migrations() -> None:
    from alembic.config import Config

    from alembic import command

    from .config import BACKEND_ROOT

    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    command.upgrade(cfg, "head")


def load_engines() -> list:
    """Every module in app/engines registers its hooks on import and may expose `router`."""
    routers = []
    for info in sorted(pkgutil.iter_modules(engines_pkg.__path__), key=lambda i: i.name):
        mod = importlib.import_module(f"app.engines.{info.name}")
        for attr in ("router", "public_router"):
            if hasattr(mod, attr):
                routers.append(getattr(mod, attr))
    return routers


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.auto_migrate:
        import asyncio

        await asyncio.to_thread(run_migrations)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    yield
    await close_redis()
    await engine.dispose()


def create_app() -> FastAPI:
    modules, errors = load_registry(strict=settings.strict_modules)
    for e in errors:
        log.warning("module definition problem: %s", e)
    app = FastAPI(
        title="Vlack HRMS API",
        version="0.1.0",
        description=f"Hospital Information & Management System — {len(modules)} modules.",
        lifespan=lifespan,
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException):
        d = exc.detail
        body = d if isinstance(d, dict) and "message" in d else {"message": str(d)}
        return JSONResponse(body, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        fields = {".".join(str(x) for x in e["loc"][1:]): e["msg"] for e in exc.errors()}
        return JSONResponse({"message": "Invalid request", "details": {"fields": fields}}, status_code=422)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception):
        log.exception("unhandled error", exc_info=exc)
        return JSONResponse({"message": "Something went wrong. The error has been logged."}, status_code=500)

    for r in (auth.router, meta.router, records.router, common.router, rbac.router, *load_engines()):
        app.include_router(r)

    # Production: serve the built React app from the same origin.
    dist = settings.web_dist
    if (dist / "index.html").exists():
        # built JS/CSS live under /static so SPA routes such as /assets/dashboard keep working
        if (dist / "static").is_dir():
            app.mount("/static", StaticFiles(directory=dist / "static"), name="static")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            f = (dist / path).resolve()
            if path and f.is_file() and str(f).startswith(str(dist.resolve())):
                return FileResponse(f)
            return FileResponse(dist / "index.html")

    return app


app = create_app()
