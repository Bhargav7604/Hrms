"""Layered configuration store (table `config_entries`).

Two kinds share one table:
- ``fieldconfig`` — per form/screen and per field: visible, required, readonly, editable,
  label, default, mask, order (value = ``{"fields": {<key>: {...}}}``).
- ``settings`` — free JSON per namespace (value = the settings dict).

Scopes, least → most specific: org → branch → department → doctor → user. A request resolves
the layers that apply to its user (active branch, the user's employee department, the user's
employee id as "doctor", the user id) and the most specific value wins, property by property.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from ..config import settings
from ..schema import config_entries, employees
from .util import new_id, now

SCOPES = ("org", "branch", "department", "doctor", "user")
SCOPE_RANK = {s: i for i, s in enumerate(SCOPES)}
FIELD_PROPS = ("visible", "required", "readonly", "editable", "hidden", "label", "default", "mask", "order", "section")
BOOL_PROPS = {"visible", "required", "readonly", "editable", "hidden", "mask"}


async def user_scope_ids(ctx) -> list[tuple[str, str]]:
    """[(scope, scope_id)] that apply to the acting user, least specific first (cached per request)."""
    cached = ctx.__dict__.get("_scope_ids")
    if cached is not None:
        return cached
    out: list[tuple[str, str]] = [("org", ""), ("branch", getattr(ctx, "branch", None) or settings.branch_id)]
    emp = ctx.user.get("employee_id")
    if emp:
        dept = (await ctx.conn.execute(sa.select(employees.c.department_id).where(employees.c.id == emp))).scalar()
        if dept:
            out.append(("department", str(dept)))
        out.append(("doctor", str(emp)))
    uid = ctx.user.get("id")
    if uid and str(uid) not in ("system", "public", "anonymous") and not str(uid).startswith("patient:"):
        out.append(("user", str(uid)))
    ctx.__dict__["_scope_ids"] = out
    return out


async def user_department(ctx) -> str | None:
    return next((sid for s, sid in await user_scope_ids(ctx) if s == "department"), None)


async def load_layers(ctx, kind: str, namespaces: list[str] | None = None,
                      scopes: list[tuple[str, str]] | None = None) -> dict[str, list[tuple[str, str, dict]]]:
    """{namespace: [(scope, scope_id, value), ...]} ordered least → most specific."""
    scopes = scopes if scopes is not None else await user_scope_ids(ctx)
    if not scopes:
        return {}
    t = config_entries
    conds = [t.c.kind == kind, sa.or_(*[sa.and_(t.c.scope == s, t.c.scope_id == sid) for s, sid in scopes])]
    if namespaces is not None:
        if not namespaces:
            return {}
        conds.append(t.c.namespace.in_(namespaces))
    rows = (await ctx.conn.execute(sa.select(t.c.namespace, t.c.scope, t.c.scope_id, t.c.value).where(*conds))).all()
    out: dict[str, list[tuple[str, str, dict]]] = {}
    for r in sorted(rows, key=lambda r: SCOPE_RANK.get(r.scope, 99)):
        out.setdefault(r.namespace, []).append((r.scope, r.scope_id, r.value or {}))
    return out


def merge_values(layers: list[tuple[str, str, dict]]) -> tuple[dict, str | None]:
    values: dict[str, Any] = {}
    scope = None
    for s, _sid, v in layers:
        if isinstance(v, dict) and v:
            values.update(v)
            scope = s
    return values, scope


def merge_fields(layers: list[tuple[str, str, dict]]) -> tuple[dict[str, dict], str | None]:
    """Property-level merge of field overrides; a None value means 'inherit'."""
    fields: dict[str, dict] = {}
    scope = None
    for s, _sid, v in layers:
        fs = (v or {}).get("fields") or {}
        if fs:
            scope = s
        for key, props in fs.items():
            if not isinstance(props, dict):
                continue
            cur = fields.setdefault(key, {})
            for p, val in props.items():
                if p in FIELD_PROPS and val is not None:
                    cur[p] = val
    return fields, scope


def normalize_props(props: dict) -> dict:
    """Keep known properties with sane types. `hidden` is the inverse of `visible`."""
    out: dict[str, Any] = {}
    for p, v in (props or {}).items():
        if p not in FIELD_PROPS:
            continue
        if v is None:
            out[p] = None
        elif p in BOOL_PROPS:
            out[p] = bool(v)
        elif p == "order":
            try:
                out[p] = int(v)
            except (TypeError, ValueError):
                continue
        elif p == "label":
            s = str(v).strip()[:120]
            out[p] = s or None
        elif p == "section":
            out[p] = str(v)[:60]
        else:  # default: any JSON scalar/list
            out[p] = v if not isinstance(v, str) else v[:1000]
    if "hidden" in out and out["hidden"] is not None and "visible" not in out:
        out["visible"] = not out["hidden"]
    out.pop("hidden", None)
    return out


async def effective_fields(ctx, namespace: str) -> tuple[dict[str, dict], str | None]:
    layers = await load_layers(ctx, "fieldconfig", [namespace])
    return merge_fields(layers.get(namespace, []))


async def effective_fields_all(ctx) -> dict[str, dict[str, dict]]:
    layers = await load_layers(ctx, "fieldconfig")
    return {ns: merge_fields(ls)[0] for ns, ls in layers.items()}


async def get_settings(ctx, namespace: str, defaults: dict | None = None) -> dict:
    """Merged settings for the acting user (engines: `await get_settings(ctx, "billing", {...})`)."""
    layers = await load_layers(ctx, "settings", [namespace])
    values, _ = merge_values(layers.get(namespace, []))
    return {**(defaults or {}), **values}


# ------------------------------------------------------------------ raw layer access (admin editors)

async def get_layer(conn, kind: str, namespace: str, scope: str, scope_id: str) -> dict | None:
    t = config_entries
    row = (await conn.execute(sa.select(t.c.value, t.c.updated_at, t.c.updated_by).where(
        t.c.kind == kind, t.c.namespace == namespace, t.c.scope == scope, t.c.scope_id == scope_id))).first()
    return dict(row._mapping) if row else None


async def put_layer(conn, kind: str, namespace: str, scope: str, scope_id: str, value: dict, user_id: str) -> None:
    t = config_entries
    stmt = insert(t).values(id=new_id(), kind=kind, namespace=namespace, scope=scope, scope_id=scope_id,
                            value=value, updated_by=user_id, updated_at=now())
    stmt = stmt.on_conflict_do_update(constraint="uq_config_entries_key",
                                      set_={"value": stmt.excluded.value, "updated_by": user_id, "updated_at": now()})
    await conn.execute(stmt)


async def delete_layer(conn, kind: str, namespace: str, scope: str, scope_id: str) -> int:
    t = config_entries
    res = await conn.execute(t.delete().where(t.c.kind == kind, t.c.namespace == namespace, t.c.scope == scope,
                                              t.c.scope_id == scope_id))
    return res.rowcount or 0


async def layers_for(conn, kind: str, namespace: str) -> list[dict]:
    """Every stored layer of a namespace (admin overview)."""
    t = config_entries
    rows = (await conn.execute(sa.select(t.c.scope, t.c.scope_id, t.c.updated_at, t.c.updated_by)
                               .where(t.c.kind == kind, t.c.namespace == namespace))).all()
    return [dict(r._mapping) for r in rows]


# ------------------------------------------------------------------ applying field config to entity fields

def apply_field(base: dict, cfg: dict | None) -> dict:
    """Merge an effective override into a public field dict (as sent by /api/meta).
    System-required fields stay required and visible; readonly from the definition stays readonly."""
    if not cfg:
        return base
    f = dict(base)
    sys_required = bool(base.get("required"))
    if cfg.get("label"):
        f["label"] = cfg["label"]
    if "default" in cfg and cfg["default"] not in (None, ""):
        f["default"] = cfg["default"]
    if cfg.get("required"):
        f["required"] = True
    if cfg.get("readonly"):
        f["readonly"] = True
    if cfg.get("visible") is False and not sys_required:
        f["hidden"] = True
    if cfg.get("editable") is False:
        f["editable"] = False
    if cfg.get("mask"):
        f["mask"] = True
    if "order" in cfg:
        f["order"] = cfg["order"]
    f["configured"] = True
    return f
