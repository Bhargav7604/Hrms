from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import Annotated

import jwt
import sqlalchemy as sa
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Depends, Request

from ..config import settings
from ..db import Ctx, engine
from ..redis import is_revoked
from ..schema import user_sessions, users
from . import permissions
from .branches import BRANCH_RE, allowed_branches
from .util import ApiError, new_id, now

_ph = PasswordHasher()


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, pw)
    except (VerifyMismatchError, InvalidHashError):
        return False


def sign_token(sub: str, kind: str, role: str, name: str, ttl_hours: int | None = None) -> tuple[str, dict]:
    now = int(time.time())
    claims = {"sub": sub, "kind": kind, "role": role, "name": name, "jti": new_id(), "iat": now,
              "exp": now + int((ttl_hours or settings.token_ttl_hours) * 3600)}
    return jwt.encode(claims, settings.jwt_secret, algorithm="HS256"), claims


def decode_token(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def token_from(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    if h.startswith("Bearer "):
        return h[7:]
    # Query token only for GET downloads / prints / SSE opened outside fetch().
    if request.method == "GET":
        return request.query_params.get("token")
    return None


async def _claims(request: Request, kind: str) -> dict:
    claims = decode_token(token_from(request))
    if not claims or claims.get("kind") != kind:
        raise ApiError(401, "Please sign in")
    if await is_revoked(claims["jti"]):
        raise ApiError(401, "Session ended — please sign in again")
    return claims


SESSION_TOUCH_SECONDS = 60


def requested_branch(request: Request) -> str | None:
    """Active branch: `X-Branch` header, or `?branch=` on GET downloads / SSE opened outside fetch()."""
    b = request.headers.get("x-branch") or (request.query_params.get("branch") if request.method == "GET" else None)
    return b if b and BRANCH_RE.match(b) else None


async def get_ctx(request: Request) -> AsyncIterator[Ctx]:
    """Authenticated staff request: one transaction per request, committed before the response."""
    claims = await _claims(request, "staff")
    async with engine.connect() as conn:
        async with conn.begin():
            s = user_sessions
            row = (await conn.execute(
                sa.select(users.c.id, users.c.username, users.c.name, users.c.role, users.c.employee_id, users.c.active,
                          users.c.data, s.c.revoked_at, s.c.last_active_at, s.c.id.label("session_id"))
                .select_from(users.outerjoin(s, sa.and_(s.c.id == claims["jti"], s.c.user_id == users.c.id)))
                .where(users.c.id == claims["sub"])
            )).mappings().first()
            if not row or not row["active"]:
                raise ApiError(401, "Account disabled")
            if row["revoked_at"] is not None:
                raise ApiError(401, "You were signed out from this device — please sign in again")
            user = {k: (str(v) if k in ("id", "employee_id") and v else v)
                    for k, v in row.items() if k in ("id", "username", "name", "role", "employee_id", "active")}
            user["jti"], user["exp"] = claims["jti"], claims["exp"]
            await permissions.refresh(conn)
            prole = (row["data"] or {}).get("perm_role")
            if prole and prole in permissions.custom_roles():
                user["perm_role"] = prole
            # Branch: must be one the user may open; an unknown header falls back to the first allowed
            # branch for reads, and is refused for writes so nothing lands in the wrong branch.
            branches = await allowed_branches(conn, row["role"], row["data"])
            want = requested_branch(request)
            if want and want not in branches and request.method not in ("GET", "HEAD", "OPTIONS"):
                raise ApiError(403, f"You do not have access to branch {want}", code="BRANCH_FORBIDDEN")
            branch = want if want in branches else branches[0]
            user["branches"] = branches
            ts = now()
            if row["session_id"] and (row["last_active_at"] is None
                                      or (ts - row["last_active_at"]).total_seconds() > SESSION_TOUCH_SECONDS):
                await conn.execute(s.update().where(s.c.id == row["session_id"]).values(last_active_at=ts, branch_id=branch))
            ctx = Ctx(conn=conn, user=user, ip=request.client.host if request.client else None,
                      break_glass=(request.headers.get("x-break-glass") or None), branch=branch)
            yield ctx
    await ctx.run_after_commit()


async def get_patient_ctx(request: Request) -> AsyncIterator[Ctx]:
    """Patient-portal request (UHID + OTP login)."""
    claims = await _claims(request, "patient")
    async with engine.connect() as conn:
        async with conn.begin():
            ctx = Ctx(conn=conn, user={"id": f"patient:{claims['sub']}", "patient_id": claims["sub"],
                                       "name": claims.get("name"), "role": "patient", "jti": claims["jti"], "exp": claims["exp"]},
                      ip=request.client.host if request.client else None)
            yield ctx
    await ctx.run_after_commit()


async def get_public_ctx(request: Request) -> AsyncIterator[Ctx]:
    """Unauthenticated endpoints (queue display board, QR pre-registration, portal login)."""
    async with engine.connect() as conn:
        async with conn.begin():
            ctx = Ctx(conn=conn, user={"id": "public", "name": "Public", "role": "public"},
                      ip=request.client.host if request.client else None)
            yield ctx
    await ctx.run_after_commit()


CtxDep = Annotated[Ctx, Depends(get_ctx, scope="function")]
PatientCtxDep = Annotated[Ctx, Depends(get_patient_ctx, scope="function")]
PublicCtxDep = Annotated[Ctx, Depends(get_public_ctx, scope="function")]


def require_roles(ctx: Ctx, *roles: str) -> None:
    if ctx.role != "admin" and ctx.role not in roles:
        raise ApiError(403, "Your role cannot perform this action")
