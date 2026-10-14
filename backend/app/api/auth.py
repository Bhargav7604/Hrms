from __future__ import annotations

import re
import time
from datetime import UTC, datetime

import sqlalchemy as sa
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..core.audit import audit
from ..core.config_store import get_layer
from ..core.security import CtxDep, PublicCtxDep, hash_password, require_roles, sign_token, verify_password
from ..core.util import ApiError, not_found, now, to_json_value
from ..redis import rate_limited, reset_rate_limit, revoke_token
from ..schema import employees, user_sessions, users

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


# ------------------------------------------------------------------ devices & sessions

_BROWSERS = [("Edge", r"Edg(e|A|iOS)?/"), ("Opera", r"OPR/|Opera"), ("Samsung Internet", r"SamsungBrowser/"),
             ("Chrome", r"Chrome/|CriOS/"), ("Firefox", r"Firefox/|FxiOS/"), ("Safari", r"Safari/"),
             ("curl", r"^curl/"), ("Python", r"python-|httpx")]
_OSES = [("iOS", r"iPhone|iPad|iPod"), ("Android", r"Android"), ("Windows", r"Windows"), ("ChromeOS", r"CrOS"),
         ("macOS", r"Mac OS X|Macintosh"), ("Linux", r"Linux")]


def parse_user_agent(ua: str) -> dict:
    ua = ua or ""
    browser = next((n for n, rx in _BROWSERS if re.search(rx, ua)), "Browser")
    os_ = next((n for n, rx in _OSES if re.search(rx, ua)), "")
    kind = "Tablet" if re.search(r"iPad|Tablet", ua) else "Mobile" if re.search(r"Mobi|iPhone|Android", ua) else "Desktop"
    device = f"{browser} on {os_}" if os_ else browser
    return {"browser": browser, "os": os_ or None, "device": device, "kind": kind}


async def session_limit(conn) -> int:
    layer = await get_layer(conn, "settings", "security", "org", "")
    v = ((layer or {}).get("value") or {}).get("max_concurrent_sessions")
    try:
        return max(0, int(v)) if v is not None else settings.max_concurrent_sessions
    except (TypeError, ValueError):
        return settings.max_concurrent_sessions


async def revoke_session(ctx, sid: str, *, by: str, reason: str) -> bool:
    row = (await ctx.conn.execute(sa.select(user_sessions).where(user_sessions.c.id == sid))).mappings().first()
    if not row or row["revoked_at"] is not None:
        return False
    await ctx.conn.execute(user_sessions.update().where(user_sessions.c.id == sid)
                           .values(revoked_at=now(), revoked_by=by, revoke_reason=reason))
    ttl = int((row["expires_at"] - now()).total_seconds())
    if ttl > 0:
        ctx.on_commit(lambda: revoke_token(sid, ttl))
    return True


async def _start_session(ctx, request: Request, user_id: str, claims: dict) -> list[str]:
    """Record the new sign-in and sign out the oldest sessions beyond the concurrent-session limit."""
    ua = request.headers.get("user-agent", "")[:400]
    info = parse_user_agent(ua)
    ts = now()
    await ctx.conn.execute(user_sessions.insert().values(
        id=claims["jti"], user_id=user_id, device=info["device"], browser=info["browser"], os=info["os"],
        user_agent=ua, ip=ctx.ip, created_at=ts, last_active_at=ts,
        expires_at=datetime.fromtimestamp(claims["exp"], UTC)))
    limit = await session_limit(ctx.conn)
    if not limit:
        return []
    live = (await ctx.conn.execute(
        sa.select(user_sessions.c.id).where(user_sessions.c.user_id == user_id, user_sessions.c.revoked_at.is_(None),
                                            user_sessions.c.expires_at > ts)
        .order_by(sa.func.coalesce(user_sessions.c.last_active_at, user_sessions.c.created_at).desc(),
                  user_sessions.c.created_at.desc())
    )).scalars().all()
    evicted = [sid for sid in live if sid != claims["jti"]][max(0, limit - 1):]
    for sid in evicted:
        await revoke_session(ctx, sid, by=user_id, reason=f"Concurrent-session limit ({limit}) — signed in elsewhere")
    return evicted


def _session_out(r, current: str | None) -> dict:
    d = {k: to_json_value(v) for k, v in dict(r).items() if k != "user_agent"}
    d["current"] = r["id"] == current
    d["kind"] = parse_user_agent(r["user_agent"] or "")["kind"]
    return d


@router.get("/sessions")
async def my_sessions(ctx: CtxDep, user_id: str | None = None):
    """Signed-in devices of the current user (admin: of any user with `user_id`)."""
    uid = ctx.user_id
    if user_id and user_id != ctx.user_id:
        require_roles(ctx)
        uid = user_id
    rows = (await ctx.conn.execute(
        sa.select(user_sessions).where(user_sessions.c.user_id == uid, user_sessions.c.revoked_at.is_(None),
                                       user_sessions.c.expires_at > now())
        .order_by(user_sessions.c.last_active_at.desc().nulls_last())
    )).mappings().all()
    return {"sessions": [_session_out(r, ctx.user["jti"]) for r in rows], "limit": await session_limit(ctx.conn),
            "current": ctx.user["jti"]}


@router.post("/sessions/{sid}/revoke")
async def revoke_my_session(sid: str, ctx: CtxDep):
    owner = (await ctx.conn.execute(sa.select(user_sessions.c.user_id).where(user_sessions.c.id == sid))).scalar()
    if not owner:
        raise not_found("Session not found")
    if str(owner) != ctx.user_id:
        require_roles(ctx)  # admin may sign out anyone's device
    ok = await revoke_session(ctx, sid, by=ctx.user_id, reason="Signed out remotely")
    await audit(ctx, "auth.session_revoked", module="auth", record={"id": str(owner)}, note=sid[:8])
    return {"ok": ok}


@router.post("/sessions/revoke-others")
async def revoke_other_sessions(ctx: CtxDep):
    ids = (await ctx.conn.execute(sa.select(user_sessions.c.id).where(
        user_sessions.c.user_id == ctx.user_id, user_sessions.c.revoked_at.is_(None), user_sessions.c.id != ctx.user["jti"]))).scalars().all()
    for sid in ids:
        await revoke_session(ctx, sid, by=ctx.user_id, reason="Signed out from all other devices")
    await audit(ctx, "auth.sessions_revoked", module="auth", note=f"{len(ids)} sessions")
    return {"ok": True, "revoked": len(ids)}


@router.post("/login")
async def login(body: LoginIn, ctx: PublicCtxDep, request: Request):
    rl_key = f"login:{body.username.lower()}:{ctx.ip}"
    if await rate_limited(rl_key, settings.login_max_attempts, 900):
        raise ApiError(429, "Too many sign-in attempts. Try again in 15 minutes.")
    row = (await ctx.conn.execute(sa.select(users).where(sa.func.lower(users.c.username) == body.username.lower()))).mappings().first()
    if not row or not row["active"] or not verify_password(body.password, row["password_hash"]):
        ctx.user = {"id": "anonymous", "name": body.username, "role": "-"}
        await audit(ctx, "auth.login_failed", module="auth", note=body.username)
        # Returned (not raised) so the failed-attempt audit row is committed.
        return JSONResponse({"message": "Invalid username or password"}, status_code=401)
    await reset_rate_limit(rl_key)
    await ctx.conn.execute(users.update().where(users.c.id == row["id"]).values(last_login_at=now()))
    token, claims = sign_token(str(row["id"]), "staff", row["role"], row["name"])
    ctx.user = {"id": str(row["id"]), "name": row["name"], "role": row["role"]}
    evicted = await _start_session(ctx, request, str(row["id"]), claims)
    await audit(ctx, "auth.login", module="auth", record={"id": str(row["id"])},
                note=f"signed out {len(evicted)} older session(s)" if evicted else None)
    return {"token": token, "user": _public_user(row), "signed_out_sessions": len(evicted)}


def _public_user(row) -> dict:
    return {"id": str(row["id"]), "username": row["username"], "name": row["name"], "role": row["role"],
            "employee_id": str(row["employee_id"]) if row["employee_id"] else None}


@router.get("/me")
async def me(ctx: CtxDep):
    emp = None
    if ctx.user.get("employee_id"):
        r = (await ctx.conn.execute(sa.select(employees).where(employees.c.id == ctx.user["employee_id"]))).mappings().first()
        if r:
            emp = {k: to_json_value(v) for k, v in r.items() if k not in ("search", "data")}
    return {"user": {k: v for k, v in ctx.user.items() if k not in ("jti", "exp")}, "employee": emp}


@router.post("/logout")
async def logout(ctx: CtxDep):
    await revoke_token(ctx.user["jti"], int(ctx.user["exp"] - time.time()))
    await ctx.conn.execute(user_sessions.update().where(user_sessions.c.id == ctx.user["jti"])
                           .values(revoked_at=now(), revoked_by=ctx.user_id, revoke_reason="Signed out"))
    await audit(ctx, "auth.logout", module="auth")
    return {"ok": True}


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/change-password")
async def change_password(body: PasswordIn, ctx: CtxDep):
    row = (await ctx.conn.execute(sa.select(users.c.password_hash).where(users.c.id == ctx.user_id))).first()
    if not row or not verify_password(body.current_password, row.password_hash):
        raise ApiError(400, "Current password is incorrect")
    await ctx.conn.execute(users.update().where(users.c.id == ctx.user_id).values(password_hash=hash_password(body.new_password), updated_at=now()))
    await audit(ctx, "auth.password_changed", module="auth")
    return {"ok": True}
