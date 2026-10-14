"""Roles & permissions administration: the None / View / Edit matrix per role, custom roles."""

from __future__ import annotations

import re
from typing import Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core import permissions as perms
from ..core.audit import audit
from ..core.config_store import delete_layer, get_layer, put_layer
from ..core.rbac import ROLES
from ..core.registry import all_modules, suites
from ..core.security import CtxDep, require_roles
from ..core.util import bad_request, conflict, not_found
from ..schema import users

router = APIRouter(prefix="/api/admin/roles", tags=["admin"])

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{2,30}$")
Level = Literal["none", "view", "edit"]


def _ns(key: str) -> str:
    return f"role:{key}"


def _role_or_404(key: str) -> dict:
    if key in ROLES:
        r = perms._State.roles.get(key) or {}
        return {"key": key, "label": ROLES[key], "custom": False, "base": None, "description": r.get("description")}
    r = perms.custom_roles().get(key)
    if not r:
        raise not_found("Unknown role")
    return {"key": key, "label": r.get("label") or key, "custom": True, "base": r.get("base"), "description": r.get("description")}


async def _user_counts(conn) -> dict[str, int]:
    out: dict[str, int] = {}
    rows = (await conn.execute(sa.select(users.c.role, users.c.data["perm_role"].astext.label("pr"), sa.func.count())
                               .where(users.c.active.is_(True)).group_by(users.c.role, sa.text("2")))).all()
    for role, pr, n in rows:
        key = pr if pr and pr in perms.custom_roles() else role
        out[key] = out.get(key, 0) + n
    return out


@router.get("")
async def list_roles(ctx: CtxDep):
    require_roles(ctx)
    await perms.refresh(ctx.conn, force=True)
    counts = await _user_counts(ctx.conn)
    out = []
    for key in [*ROLES, *perms.custom_roles()]:
        r = _role_or_404(key)
        overrides = len((perms._State.roles.get(key) or {}).get("perms") or {})
        matrix = perms.role_matrix(key)
        out.append({**r, "users": counts.get(key, 0), "overrides": overrides,
                    "visible": sum(1 for v in matrix.values() if v != "none"),
                    "editable": sum(1 for v in matrix.values() if v == "edit")})
    return out


@router.get("/{key}")
async def role_matrix(key: str, ctx: CtxDep):
    require_roles(ctx)
    await perms.refresh(ctx.conn, force=True)
    role = _role_or_404(key)
    matrix = perms.role_matrix(key)
    defaults = perms.defaults_for(key)
    by_suite: dict[str, list] = {}
    for m in all_modules():
        pages = [{"key": p.key, "label": p.label, "icon": p.icon, "level": matrix[perms.perm_key("page", m.id, p.key)],
                  "default": defaults[perms.perm_key("page", m.id, p.key)]} for p in m.pages]
        ents = [{"key": e.key, "label": e.label, "icon": e.icon, "level": matrix[perms.perm_key("entity", m.id, e.key)],
                 "default": defaults[perms.perm_key("entity", m.id, e.key)], "restricted": e.restricted,
                 "readonly": e.readonly} for e in m.entities]
        by_suite.setdefault(m.suite, []).append({"id": m.id, "no": m.no, "name": m.name, "icon": m.icon, "pages": pages,
                                                 "entities": ents})
    return {"role": role, "locked": key == "admin",
            "suites": [{**s, "modules": by_suite.get(s["id"], [])} for s in suites()],
            "counts": {lv: sum(1 for v in matrix.values() if v == lv) for lv in perms.LEVELS}}


class MatrixIn(BaseModel):
    changes: dict[str, Level | None] = Field(default_factory=dict)  # perm key → level; null = back to default


def _valid_keys() -> set[str]:
    keys = set()
    for m in all_modules():
        keys |= {perms.perm_key("page", m.id, p.key) for p in m.pages}
        keys |= {perms.perm_key("entity", m.id, e.key) for e in m.entities}
    return keys


async def _save(ctx, key: str, role_meta: dict, new_perms: dict[str, str]) -> None:
    layer = (await get_layer(ctx.conn, "rbac", _ns(key), "org", "")) or {}
    value = {**(layer.get("value") or {}), **role_meta, "perms": new_perms}
    if not role_meta.get("custom") and not new_perms and not value.get("description"):
        await delete_layer(ctx.conn, "rbac", _ns(key), "org", "")
    else:
        await put_layer(ctx.conn, "rbac", _ns(key), "org", "", value, ctx.user_id)
    await perms.bump(ctx.conn)


def _meta_for(key: str) -> dict:
    r = perms._State.roles.get(key) or {}
    return {k: r[k] for k in ("label", "base", "custom", "description") if k in r}


@router.put("/{key}")
async def update_matrix(key: str, body: MatrixIn, ctx: CtxDep):
    require_roles(ctx)
    await perms.refresh(ctx.conn, force=True)
    role = _role_or_404(key)
    if key == "admin":
        raise bad_request("The administrator role always has full access")
    valid = _valid_keys()
    bad = [k for k in body.changes if k not in valid]
    if bad:
        raise bad_request(f"Unknown permission {bad[0]}")
    defaults = perms.defaults_for(key)
    cur = dict((perms._State.roles.get(key) or {}).get("perms") or {})
    before = {k: perms.role_matrix(key)[k] for k in body.changes}
    for k, lv in body.changes.items():
        if lv is None or lv == defaults[k]:
            cur.pop(k, None)
        else:
            cur[k] = lv
    await _save(ctx, key, _meta_for(key), cur)
    after = {k: perms.role_matrix(key)[k] for k in body.changes}
    changed = {k: v for k, v in after.items() if before.get(k) != v}
    if changed:
        await audit(ctx, "rbac.update", module="admin", entity="roles", record={"id": key, "code": key},
                    before={k: before[k] for k in changed}, after=changed, note=role["label"])
    return await role_matrix(key, ctx)


class CopyIn(BaseModel):
    from_role: str


@router.post("/{key}/copy")
async def copy_matrix(key: str, body: CopyIn, ctx: CtxDep):
    """Make this role's matrix identical to another role's effective matrix."""
    require_roles(ctx)
    await perms.refresh(ctx.conn, force=True)
    role = _role_or_404(key)
    _role_or_404(body.from_role)
    if key == "admin":
        raise bad_request("The administrator role always has full access")
    src = perms.role_matrix(body.from_role)
    defaults = perms.defaults_for(key)
    new = {k: v for k, v in src.items() if defaults.get(k) != v}
    await _save(ctx, key, _meta_for(key), new)
    await audit(ctx, "rbac.copy", module="admin", entity="roles", record={"id": key, "code": key},
                note=f"{role['label']} ← {body.from_role} ({len(new)} differences from default)")
    return await role_matrix(key, ctx)


@router.delete("/{key}/overrides")
async def reset_matrix(key: str, ctx: CtxDep):
    require_roles(ctx)
    await perms.refresh(ctx.conn, force=True)
    role = _role_or_404(key)
    await _save(ctx, key, _meta_for(key), {})
    await audit(ctx, "rbac.reset", module="admin", entity="roles", record={"id": key, "code": key}, note=role["label"])
    return await role_matrix(key, ctx)


class RoleIn(BaseModel):
    key: str = Field(min_length=3, max_length=31)
    label: str = Field(min_length=2, max_length=60)
    base: str
    description: str | None = Field(default=None, max_length=300)
    copy_from: str | None = None


@router.post("", status_code=201)
async def create_role(body: RoleIn, ctx: CtxDep):
    """Custom role (e.g. Ward In-charge on top of Nurse): engines see the base role, the matrix is its own."""
    require_roles(ctx)
    await perms.refresh(ctx.conn, force=True)
    key = body.key.strip().lower()
    if not KEY_RE.match(key):
        raise bad_request("Key: lowercase letters, digits and _ (3–31 characters)", {"fields": {"key": "Invalid"}})
    if key in ROLES or key in perms.custom_roles():
        raise conflict("A role with this key already exists")
    if body.base not in ROLES or body.base == "admin":
        raise bad_request("Choose a built-in base role (not administrator)", {"fields": {"base": "Invalid"}})
    meta = {"label": body.label.strip(), "base": body.base, "custom": True, "description": body.description}
    await put_layer(ctx.conn, "rbac", _ns(key), "org", "", {**meta, "perms": {}}, ctx.user_id)
    await perms.bump(ctx.conn)
    if body.copy_from:
        _role_or_404(body.copy_from)
        src = perms.role_matrix(body.copy_from)
        defaults = perms.defaults_for(key)
        await _save(ctx, key, meta, {k: v for k, v in src.items() if defaults.get(k) != v})
    await audit(ctx, "rbac.role_create", module="admin", entity="roles", record={"id": key, "code": key},
                after={**meta, "copy_from": body.copy_from})
    return await role_matrix(key, ctx)


class RoleEdit(BaseModel):
    label: str = Field(min_length=2, max_length=60)
    description: str | None = Field(default=None, max_length=300)


@router.patch("/{key}")
async def edit_role(key: str, body: RoleEdit, ctx: CtxDep):
    require_roles(ctx)
    await perms.refresh(ctx.conn, force=True)
    role = _role_or_404(key)
    if not role["custom"]:
        raise bad_request("Built-in roles cannot be renamed")
    r = perms._State.roles[key]
    await _save(ctx, key, {**_meta_for(key), "label": body.label.strip(), "description": body.description}, r.get("perms") or {})
    await audit(ctx, "rbac.role_update", module="admin", entity="roles", record={"id": key, "code": key},
                before={"label": role["label"]}, after={"label": body.label})
    return _role_or_404(key)


@router.delete("/{key}")
async def delete_role(key: str, ctx: CtxDep):
    require_roles(ctx)
    await perms.refresh(ctx.conn, force=True)
    role = _role_or_404(key)
    if not role["custom"]:
        raise bad_request("Built-in roles cannot be deleted")
    n = (await _user_counts(ctx.conn)).get(key, 0)
    if n:
        raise conflict(f"{n} user(s) still have this role — move them to another role first")
    await delete_layer(ctx.conn, "rbac", _ns(key), "org", "")
    await perms.bump(ctx.conn)
    await audit(ctx, "rbac.role_delete", module="admin", entity="roles", record={"id": key, "code": key}, note=role["label"])
    return {"ok": True}
