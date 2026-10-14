"""Generic settings store and per-user preferences.

Settings are JSON per namespace and scope (org → branch → department → doctor → user); the most
specific layer wins key by key. Other engines read them with
`await config_store.get_settings(ctx, "<namespace>", defaults)`; screens call
`GET /api/settings/<namespace>` → `{values, scope}` and merge over their own defaults.

Preferences (column layouts, favourites, density, rows per page…) are private to a user and live in
`users.data.prefs`: `GET /api/prefs`, `PUT /api/prefs/<key>`.
"""

from __future__ import annotations

import re
from typing import Any

import orjson
import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import JSONB

from ..core.audit import audit
from ..core.config_store import SCOPES, delete_layer, get_layer, load_layers, merge_values, put_layer, user_scope_ids
from ..core.security import CtxDep
from ..core.util import ApiError, bad_request, forbidden, to_json_value
from ..schema import users

router = APIRouter(prefix="/api", tags=["settings"])

NS_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,79}$")
PREF_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
MAX_JSON = 64 * 1024


def check_namespace(ns: str) -> str:
    if not NS_RE.match(ns or ""):
        raise bad_request("Invalid settings namespace")
    return ns


async def resolve_scope(ctx, scope: str, scope_id: str | None) -> tuple[str, str]:
    """Fill in the scope id from the acting user when it is not given."""
    if scope not in SCOPES:
        raise bad_request(f"scope must be one of {', '.join(SCOPES)}")
    if scope_id not in (None, ""):
        return scope, str(scope_id)[:80]
    if scope == "org":
        return scope, ""
    mine = dict(await user_scope_ids(ctx))
    if scope not in mine:
        raise bad_request(f"Choose the {scope} to configure")
    return scope, mine[scope]


def can_write_scope(ctx, scope: str, scope_id: str) -> bool:
    if ctx.role == "admin":
        return True
    if scope == "user":
        return scope_id == ctx.user_id
    if scope == "doctor":
        return bool(ctx.user.get("employee_id")) and scope_id == ctx.user.get("employee_id")
    return False


def ensure_scope_write(ctx, scope: str, scope_id: str) -> None:
    if not can_write_scope(ctx, scope, scope_id):
        raise forbidden("Only an administrator can change organisation, branch or department settings")


def _check_size(v: Any) -> None:
    if len(orjson.dumps(v, default=str)) > MAX_JSON:
        raise bad_request("Settings are too large (64 KB limit)")


# ------------------------------------------------------------------ settings

class SettingsIn(BaseModel):
    values: dict[str, Any]
    scope: str = "org"
    scope_id: str | None = None
    replace: bool = False  # True: replace the layer; False: merge (keys set to null are removed)


@router.get("/settings/{namespace}")
async def read_settings(namespace: str, ctx: CtxDep, scope: str | None = None, scope_id: str | None = None):
    """Effective settings for the current user, or one raw layer when `scope` is given (editors)."""
    check_namespace(namespace)
    if scope:
        scope, sid = await resolve_scope(ctx, scope, scope_id)
        if not can_write_scope(ctx, scope, sid) and scope not in ("org", "branch"):
            raise forbidden()
        layer = await get_layer(ctx.conn, "settings", namespace, scope, sid)
        # what this layer inherits from the less specific layers that apply to it
        below = [(s, i) for s, i in await user_scope_ids(ctx) if SCOPES.index(s) < SCOPES.index(scope)]
        if scope == "branch":
            below = [("org", "")]
        inherited, _ = merge_values((await load_layers(ctx, "settings", [namespace], below)).get(namespace, []))
        return {"namespace": namespace, "values": (layer or {}).get("value") or {}, "scope": scope, "scope_id": sid,
                "inherited": inherited, "updated_at": to_json_value((layer or {}).get("updated_at")),
                "updated_by": (layer or {}).get("updated_by")}
    layers = (await load_layers(ctx, "settings", [namespace])).get(namespace, [])
    values, eff_scope = merge_values(layers)
    return {"namespace": namespace, "values": values, "scope": eff_scope or "default"}


async def get_settings(ctx, namespace: str) -> dict:
    """Effective settings values for the current user (most specific scope wins) — for engines."""
    check_namespace(namespace)
    layers = (await load_layers(ctx, "settings", [namespace])).get(namespace, [])
    values, _ = merge_values(layers)
    return values


@router.put("/settings/{namespace}")
async def write_settings(namespace: str, body: SettingsIn, ctx: CtxDep):
    check_namespace(namespace)
    scope, sid = await resolve_scope(ctx, body.scope, body.scope_id)
    ensure_scope_write(ctx, scope, sid)
    prev = ((await get_layer(ctx.conn, "settings", namespace, scope, sid)) or {}).get("value") or {}
    nxt = {} if body.replace else dict(prev)
    for k, v in body.values.items():
        if v is None:
            nxt.pop(k, None)
        else:
            nxt[str(k)[:80]] = v
    _check_size(nxt)
    await put_layer(ctx.conn, "settings", namespace, scope, sid, nxt, ctx.user_id)
    changed = {k: nxt.get(k) for k in set(prev) | set(nxt) if prev.get(k) != nxt.get(k)}
    if changed:
        await audit(ctx, "settings.update", module="settings", entity=namespace,
                    before={k: prev.get(k) for k in changed}, after=changed, note=f"{scope}:{sid or 'org'}")
    return {"namespace": namespace, "values": nxt, "scope": scope, "scope_id": sid}


@router.delete("/settings/{namespace}")
async def reset_settings(namespace: str, ctx: CtxDep, scope: str = "org", scope_id: str | None = None):
    check_namespace(namespace)
    scope, sid = await resolve_scope(ctx, scope, scope_id)
    ensure_scope_write(ctx, scope, sid)
    n = await delete_layer(ctx.conn, "settings", namespace, scope, sid)
    if n:
        await audit(ctx, "settings.reset", module="settings", entity=namespace, note=f"{scope}:{sid or 'org'}")
    return {"ok": True, "removed": n}


# ------------------------------------------------------------------ per-user preferences

class PrefIn(BaseModel):
    value: Any = None


async def _prefs(ctx) -> dict:
    data = (await ctx.conn.execute(sa.select(users.c.data).where(users.c.id == ctx.user_id))).scalar() or {}
    return dict(data.get("prefs") or {})


@router.get("/prefs")
async def read_prefs(ctx: CtxDep):
    return {"prefs": await _prefs(ctx)}


@router.put("/prefs/{key}")
async def write_pref(key: str, body: PrefIn, ctx: CtxDep):
    if not PREF_RE.match(key):
        raise bad_request("Invalid preference key")
    if ctx.user_id in ("system", "public"):
        raise ApiError(400, "Preferences need a signed-in user")
    _check_size(body.value)
    patch = sa.bindparam("pref_patch", {key: body.value}, type_=JSONB)
    if body.value is None:
        expr = sa.func.coalesce(users.c.data, sa.text("'{}'::jsonb")).op("||")(sa.func.jsonb_build_object(
            "prefs", sa.func.coalesce(users.c.data["prefs"], sa.text("'{}'::jsonb")).op("-")(key)))
    else:
        expr = sa.func.coalesce(users.c.data, sa.text("'{}'::jsonb")).op("||")(sa.func.jsonb_build_object(
            "prefs", sa.func.coalesce(users.c.data["prefs"], sa.text("'{}'::jsonb")).op("||")(patch)))
    await ctx.conn.execute(users.update().where(users.c.id == ctx.user_id).values(data=expr))
    return {"key": key, "value": body.value}


@router.delete("/prefs/{key}")
async def delete_pref(key: str, ctx: CtxDep):
    return await write_pref(key, PrefIn(value=None), ctx)
