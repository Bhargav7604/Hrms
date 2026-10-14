"""Lookups for pickers, file uploads, audit log, realtime SSE and user administration."""

from __future__ import annotations

import mimetypes
from pathlib import Path

import sqlalchemy as sa
from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as svc
from ..core.audit import audit, audit_trail
from ..core.rbac import ROLES
from ..core.security import CtxDep, decode_token, hash_password, require_roles
from ..core.util import ApiError, bad_request, is_uuid, new_id, not_found, now, to_json_value
from ..redis import PREFIX, get_redis, is_revoked
from ..schema import files, users

router = APIRouter(prefix="/api", tags=["common"])


# ------------------------------------------------------------------ lookups

@router.get("/lookup/{module}/{entity}")
async def lookup(module: str, entity: str, request: Request, ctx: CtxDep, q: str | None = None,
                 ids: str | None = None, limit: int = 20):
    ent = svc.entity_or_404(module, entity)
    filters = {k[2:]: v for k, v in request.query_params.items() if k.startswith("f_") and v}
    return await svc.lookup(ctx, ent, q=q, filters=filters, ids=ids.split(",") if ids else None, limit=limit)


# ------------------------------------------------------------------ files

ALLOWED_MIME = {"application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "text/csv",
                "application/dicom", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/msword"}


@router.post("/files", status_code=201)
async def upload(ctx: CtxDep, file: UploadFile = File(...), patient_id: str | None = Form(None)):
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    if mime not in ALLOWED_MIME:
        raise bad_request(f"File type {mime} is not allowed")
    if patient_id and not is_uuid(patient_id):
        raise bad_request("Invalid patient")
    fid = new_id()
    ext = Path(file.filename or "").suffix.lower()[:10]
    rel = Path(now().strftime("%Y/%m")) / f"{fid}{ext}"
    dest = settings.upload_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    size, limit = 0, settings.max_upload_mb * 1024 * 1024
    with dest.open("wb") as fh:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                fh.close()
                dest.unlink(missing_ok=True)
                raise bad_request(f"File is larger than {settings.max_upload_mb} MB")
            fh.write(chunk)
    name = (file.filename or "upload")[:200]
    await ctx.conn.execute(files.insert().values(
        id=fid, code=fid[:8].upper(), title=name, name=name, mime=mime, size=size, path=str(rel), patient_id=patient_id,
        status="Active", created_by=ctx.user_id, created_at=now(), branch_id=ctx.branch or settings.branch_id))
    await audit(ctx, "file.upload", module="files", entity="files", record={"id": fid, "patient_id": patient_id}, note=name)
    return {"id": fid, "name": name, "mime": mime, "size": size}


@router.get("/files/{fid}")
async def download(fid: str, ctx: CtxDep):
    if not is_uuid(fid):
        raise not_found()
    row = (await ctx.conn.execute(sa.select(files).where(files.c.id == fid, files.c.deleted_at.is_(None)))).mappings().first()
    if not row:
        raise not_found("File not found")
    path = (settings.upload_dir / row["path"]).resolve()
    if not str(path).startswith(str(settings.upload_dir.resolve())) or not path.exists():
        raise not_found("File missing on disk")
    await audit(ctx, "file.view", module="files", entity="files", record={"id": fid, "patient_id": row["patient_id"]})
    return FileResponse(path, media_type=row["mime"], filename=row["name"])


@router.get("/files/{fid}/meta")
async def file_meta(fid: str, ctx: CtxDep):
    row = (await ctx.conn.execute(sa.select(files.c.id, files.c.name, files.c.mime, files.c.size).where(files.c.id == fid))).mappings().first()
    if not row:
        raise not_found("File not found")
    return {k: to_json_value(v) for k, v in row.items()}


# ------------------------------------------------------------------ audit log

@router.get("/audit")
async def audit_log(ctx: CtxDep, record_id: str | None = None, patient_id: str | None = None, module: str | None = None,
                    action: str | None = None, user_id: str | None = None, date_from: str | None = None,
                    date_to: str | None = None, page: int = 1, limit: int = 50):
    require_roles(ctx, "management", "quality")
    from ..core.util import parse_dt

    return await audit_trail(ctx.conn, record_id=record_id, patient_id=patient_id, module=module, action=action,
                             user_id=user_id, date_from=parse_dt(date_from) if date_from else None,
                             date_to=parse_dt(date_to) if date_to else None, limit=min(limit, 200),
                             offset=(max(page, 1) - 1) * limit)


# ------------------------------------------------------------------ realtime (SSE over Redis pub/sub)

async def _sse(channels: list[str], request: Request):
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(*[f"{PREFIX}rt:{c}" for c in channels])
    try:
        yield "retry: 3000\n\n"
        idle = 0.0
        while not await request.is_disconnected():
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg and msg.get("type") == "message":
                ch = msg["channel"].removeprefix(f"{PREFIX}rt:")
                if ch.startswith("u:"):  # the signed-in user's private channel (messages, session events)
                    ch = "me"
                yield f"event: {ch}\ndata: {msg['data']}\n\n"
                idle = 0.0
            else:
                idle += 1.0
                if idle >= 20:
                    yield ": keep-alive\n\n"
                    idle = 0.0
    finally:
        await pubsub.unsubscribe()
        await pubsub.aclose()


@router.get("/realtime")
async def realtime(request: Request, token: str, channels: str = "changes,alerts,queue,beds"):
    claims = decode_token(token)
    if not claims or claims.get("kind") != "staff" or await is_revoked(claims["jti"]):
        raise ApiError(401, "Please sign in")
    allowed = {"changes", "alerts", "queue", "beds", "approvals"}
    chans = [c for c in channels.split(",") if c in allowed] or ["changes"]
    chans.append(f"u:{claims['sub']}")
    return StreamingResponse(_sse(chans, request), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/public/realtime/queue")
async def public_queue_stream(request: Request):
    return StreamingResponse(_sse(["queue"], request), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ user administration

class UserIn(BaseModel):
    username: str = Field(min_length=3, max_length=60, pattern=r"^[a-zA-Z0-9_.@-]+$")
    name: str = Field(min_length=1, max_length=120)
    role: str
    password: str | None = Field(default=None, min_length=8, max_length=200)
    employee_id: str | None = None
    email: str | None = None
    active: bool = True
    branches: list[str] | None = None  # allowed branches (admin: all); None keeps the current list


def _user_out(r) -> dict:
    out = {k: to_json_value(v) for k, v in dict(r).items() if k not in ("password_hash", "data")}
    out["branches"] = list(((r.get("data") or {}).get("branches")) or [])
    out["perm_role"] = (r.get("data") or {}).get("perm_role")
    return out


async def _resolve_role(conn, role: str) -> tuple[str, str | None]:
    """A built-in role, or a custom role → (its base role, custom key)."""
    from ..core import permissions

    if role in ROLES:
        return role, None
    await permissions.refresh(conn, force=True)
    cr = permissions.custom_roles().get(role)
    if not cr:
        raise bad_request("Unknown role")
    return cr.get("base") or "employee", role


async def _check_branches(conn, codes: list[str] | None) -> list[str] | None:
    if codes is None:
        return None
    from ..core.branches import active_branches

    known = {b["code"] for b in await active_branches(conn)}
    bad = [c for c in codes if c not in known]
    if bad:
        raise bad_request(f"Unknown branch {', '.join(bad)}")
    return list(dict.fromkeys(codes))


@router.get("/admin/users")
async def list_users(ctx: CtxDep, q: str | None = None):
    require_roles(ctx, "hr")
    stmt = sa.select(users).order_by(users.c.name)
    if q:
        stmt = stmt.where(sa.or_(users.c.username.ilike(f"%{q}%"), users.c.name.ilike(f"%{q}%")))
    return [_user_out(r) for r in (await ctx.conn.execute(stmt.limit(500))).mappings().all()]


@router.post("/admin/users", status_code=201)
async def create_user(body: UserIn, ctx: CtxDep):
    require_roles(ctx)
    base, custom = await _resolve_role(ctx.conn, body.role)
    if not body.password:
        raise bad_request("Password is required for a new user")
    exists = (await ctx.conn.execute(sa.select(users.c.id).where(sa.func.lower(users.c.username) == body.username.lower()))).first()
    if exists:
        raise ApiError(409, "Username already taken")
    uid = new_id()
    branches = await _check_branches(ctx.conn, body.branches)
    await ctx.conn.execute(users.insert().values(
        id=uid, username=body.username, name=body.name, role=base, password_hash=hash_password(body.password),
        employee_id=body.employee_id, email=body.email, active=body.active, created_at=now(), updated_at=now(),
        data={k: v for k, v in (("branches", branches), ("perm_role", custom)) if v}))
    await audit(ctx, "user.create", module="admin", entity="users", record={"id": uid}, after={"username": body.username, "role": body.role})
    return {"id": uid}


@router.put("/admin/users/{uid}")
async def update_user(uid: str, body: UserIn, ctx: CtxDep):
    require_roles(ctx)
    base, custom = await _resolve_role(ctx.conn, body.role)
    prev = (await ctx.conn.execute(sa.select(users).where(users.c.id == uid))).mappings().first()
    if not prev:
        raise not_found("User not found")
    values = dict(name=body.name, role=base, employee_id=body.employee_id, email=body.email, active=body.active, updated_at=now())
    data = {k: v for k, v in dict(prev["data"] or {}).items() if k != "perm_role"}
    if custom:
        data["perm_role"] = custom
    if body.password:
        values["password_hash"] = hash_password(body.password)
    branches = await _check_branches(ctx.conn, body.branches)
    if branches is not None:
        data["branches"] = branches
    values["data"] = data
    await ctx.conn.execute(users.update().where(users.c.id == uid).values(**values))
    await audit(ctx, "user.update", module="admin", entity="users", record={"id": uid},
                before={"role": prev["role"], "active": prev["active"], "branches": (prev["data"] or {}).get("branches")},
                after={"role": body.role, "active": body.active, "password_reset": bool(body.password), "branches": branches})
    if not body.active or body.password:  # deactivated or password reset → sign the user out everywhere
        from .auth import revoke_session
        from ..schema import user_sessions

        sids = (await ctx.conn.execute(sa.select(user_sessions.c.id).where(user_sessions.c.user_id == uid,
                                                                           user_sessions.c.revoked_at.is_(None)))).scalars().all()
        for sid in sids:
            await revoke_session(ctx, sid, by=ctx.user_id, reason="Account deactivated" if not body.active else "Password reset by admin")
    return {"ok": True}


@router.get("/health")
async def health():
    from ..core.registry import all_modules
    from ..db import engine
    from ..redis import ping

    db_ok = True
    try:
        async with engine.connect() as c:
            await c.execute(sa.text("SELECT 1"))
    except Exception:
        db_ok = False
    return {"status": "ok" if db_ok else "degraded", "database": db_ok, "redis": await ping(),
            "modules": len(all_modules()), "time": now().isoformat()}

