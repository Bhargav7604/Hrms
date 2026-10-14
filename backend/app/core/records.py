"""Generic record service — CRUD, validation, numbering, status workflows, audit,
auto charge capture and realtime change events for every module entity.

Engines call these functions with `trusted=True` to set system-managed fields."""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import sqlalchemy as sa

from ..config import settings
from ..redis import publish
from ..schema import ENTITY_TABLES
from .audit import audit, diff
from .branches import branch_info
from .config_store import effective_fields
from .hooks import run_hooks
from .rbac import check_access
from .registry import Entity, get_entity
from .sequences import next_code, next_pattern_code
from .spec import FieldDef
from .util import (
    ApiError,
    bad_request,
    conflict,
    day_bounds,
    forbidden,
    is_uuid,
    new_id,
    not_found,
    now,
    parse_date,
    parse_dt,
    to_json_value,
    today,
)

NON_DATA = {"id", "code", "status", "title", "created_at", "created_by", "updated_at", "updated_by",
            "deleted_at", "search", "branch_id", "data", "module", "entity"}
TEXTY = {"text", "textarea", "select", "multiselect", "phone", "email", "tags"}
PHONE_RE = re.compile(r"^\+?[0-9][0-9\s-]{6,17}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


# ---------------------------------------------------------------- access

def ensure_access(ctx, ent: Entity, mode: str = "read") -> None:
    acc = check_access(ctx.user, ent.module, ent, mode, ctx.break_glass)
    if not acc.ok:
        if acc.reason == "BREAK_GLASS_REQUIRED":
            raise forbidden("This is a restricted record. Provide a reason to break the glass.", code="BREAK_GLASS_REQUIRED")
        raise forbidden(acc.reason or "No access")
    if acc.break_glass:
        key = f"bg:{ent.fqn}"
        if key not in getattr(ctx, "_bg_logged", set()):
            ctx.__dict__.setdefault("_bg_logged", set()).add(key)
            ctx.on_commit(lambda: publish("alerts", {"type": "break_glass", "fqn": ent.fqn, "user": ctx.user.get("name")}))
            ctx.__dict__.setdefault("_pending_bg", []).append((ent, ctx.break_glass))


async def _flush_break_glass(ctx) -> None:
    for ent, reason in ctx.__dict__.pop("_pending_bg", []):
        await audit(ctx, "break_glass", module=ent.module_id, entity=ent.key, note=reason)


# ---------------------------------------------------------------- value conversion

def to_db(col: sa.Column, v: Any) -> Any:
    if v is None or v == "":
        return None
    t = col.type
    if isinstance(t, sa.Uuid):
        if not is_uuid(v):
            raise bad_request(f"Invalid reference for {col.name}")
        return str(v)
    if isinstance(t, sa.DateTime):
        return parse_dt(v)
    if isinstance(t, sa.Date):
        return parse_date(v)
    if isinstance(t, sa.Numeric):
        return Decimal(str(v))
    if isinstance(t, sa.Integer):
        return int(v)
    if isinstance(t, sa.Boolean):
        return bool(v) if not isinstance(v, str) else v.lower() in ("1", "true", "yes", "on")
    return v


def to_record(row) -> dict:
    d = dict(row._mapping if hasattr(row, "_mapping") else row)
    data = d.pop("data", None) or {}
    for k in ("search", "deleted_at", "module", "entity"):
        d.pop(k, None)
    out = dict(data)
    for k, v in d.items():
        out[k] = to_json_value(v)
    return out


def _coerce(ctx, f: FieldDef, v: Any, errors: dict, path: str) -> Any:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    t = f.type
    try:
        if t in ("number", "currency", "percent", "rating"):
            n = float(v)
            if f.min is not None and n < f.min:
                errors[path] = f"{f.label} must be at least {f.min:g}"
            if f.max is not None and n > f.max:
                errors[path] = f"{f.label} must be at most {f.max:g}"
            if t == "currency":
                n = round(n, 2)
            return int(n) if n.is_integer() and t != "currency" else n
        if t == "boolean":
            return v is True or str(v).lower() in ("1", "true", "yes", "on")
        if t == "date":
            return parse_date(v).isoformat()
        if t == "datetime":
            return parse_dt(v).isoformat()
        if t == "time":
            s = str(v)[:5]
            if not TIME_RE.match(s):
                raise ValueError
            return s
        if t == "select":
            s = str(v)
            if s not in (f.options or []):
                errors[path] = f"{f.label}: choose one of the listed options"
            return s
        if t in ("multiselect", "tags"):
            items = [str(x) for x in (v if isinstance(v, list) else str(v).split(",")) if str(x).strip()]
            if t == "multiselect":
                bad = [x for x in items if x not in (f.options or [])]
                if bad:
                    errors[path] = f"{f.label}: invalid options {bad}"
            return items or None
        if t == "email":
            s = str(v).strip()
            if not EMAIL_RE.match(s):
                errors[path] = "Enter a valid email address"
            return s
        if t == "phone":
            s = str(v).strip()
            if not PHONE_RE.match(s):
                errors[path] = "Enter a valid phone number"
            return s
        if t in ("ref", "file"):
            if not is_uuid(v):
                raise ValueError
            return str(v)
        if t == "lines":
            if not isinstance(v, list):
                raise ValueError
            rows = []
            for i, line in enumerate(v):
                if not isinstance(line, dict):
                    continue
                row = {}
                for sf in f.fields or []:
                    if sf.key in line:
                        row[sf.key] = _coerce(ctx, sf, line[sf.key], errors, f"{path}.{i}.{sf.key}")
                if any(x not in (None, "", []) for x in row.values()):
                    for sf in f.fields or []:
                        if sf.required and row.get(sf.key) in (None, "", []):
                            errors[f"{path}.{i}.{sf.key}"] = f"{sf.label} is required"
                    rows.append(row)
            return rows
        if t == "signature":
            s = str(v)
            if not s.startswith("data:image/") or len(s) > 800_000:
                raise ValueError
            return s
        s = str(v)
        limit = 20000 if t == "textarea" else 1000
        return s[:limit]
    except (ValueError, TypeError, ArithmeticError):
        errors[path] = f"Invalid value for {f.label}"
        return None


def _default(ctx, f: FieldDef, d: Any = None) -> Any:
    d = f.default if d is None else d
    if d == "today":
        return today().isoformat()
    if d == "now":
        return now().isoformat(timespec="minutes")
    if d == "me":
        return ctx.user.get("employee_id")
    return d


def _locked(f: FieldDef, cfg: dict) -> bool:
    """Field configuration: read-only or not shown on the form → the user cannot set it.
    System-required fields can never be hidden."""
    return bool(cfg.get("readonly")) or (cfg.get("visible") is False and not f.required)


def validate(ctx, ent: Entity, payload: dict, *, partial: bool, prev: dict | None = None, trusted: bool = False,
             fc: dict[str, dict] | None = None) -> dict:
    """Coerce and check a payload. `fc` = effective field configuration for untrusted (user) writes:
    configured defaults fill new records, hidden / read-only fields ignore user input, fields that are
    not editable after creation keep their value on update, and configured required fields must be filled."""
    out: dict[str, Any] = {}
    errors: dict[str, str] = {}
    fc = {} if trusted else (fc or {})
    for f in ent.fields:
        if f.readonly and not trusted:
            continue
        cfg = fc.get(f.key) or {}
        cfg_default = cfg.get("default") if cfg.get("default") not in (None, "") else None
        if cfg and (_locked(f, cfg) or (partial and cfg.get("editable") is False)):
            if not partial:
                dv = _default(ctx, f, cfg_default)
                if dv is not None:
                    out[f.key] = _coerce(ctx, f, dv, errors, f.key)
            continue
        if f.key not in payload:
            if not partial:
                dv = _default(ctx, f, cfg_default)
                if dv is not None:
                    out[f.key] = dv if cfg_default is None else _coerce(ctx, f, dv, errors, f.key)
            continue
        out[f.key] = _coerce(ctx, f, payload[f.key], errors, f.key)
    for f in ent.fields:
        cfg = fc.get(f.key) or {}
        required = f.required or (bool(cfg.get("required")) and not _locked(f, cfg))
        if not required or (f.readonly and not trusted):
            continue
        if partial and f.key not in out:
            continue
        val = out.get(f.key) if f.key in out else (prev or {}).get(f.key)
        if val in (None, "", []):
            errors[f.key] = f"{cfg.get('label') or f.label} is required"
    if errors:
        raise bad_request("Please fix the highlighted fields", {"fields": errors})
    return out


# ---------------------------------------------------------------- helpers

class _Safe(dict):
    def __missing__(self, k):
        return ""


def compute_title(ent: Entity, rec: dict) -> str | None:
    if ent.title_template:
        t = ent.title_template.format_map(_Safe({k: ("" if v is None else v) for k, v in rec.items()}))
        t = " ".join(t.split())
        if t.strip(" -·"):
            return t
    if ent.title_field and rec.get(ent.title_field) not in (None, ""):
        return str(rec[ent.title_field])
    if rec.get("title"):
        return str(rec["title"])
    for f in ent.fields:
        if f.type in ("text", "select") and rec.get(f.key):
            return str(rec[f.key])
    return None


def search_text(ent: Entity, code: str | None, title: str | None, rec: dict) -> str:
    parts = [code or "", title or ""]
    for f in ent.fields:
        v = rec.get(f.key)
        if v and f.type in TEXTY:
            parts.append(" ".join(v) if isinstance(v, list) else str(v))
    return " ".join(p for p in parts if p).lower()[:4000]


def split(ent: Entity, rec: dict) -> tuple[dict, dict]:
    cols, data = {}, {}
    for k, v in rec.items():
        if k in NON_DATA or k.startswith("_"):
            continue
        if k in ent.physical:
            cols[k] = to_db(ent.table.c[k], v)
        else:
            data[k] = v
    return cols, data


def col_expr(ent: Entity, key: str):
    if key in ent.physical:
        return ent.table.c[key]
    return ent.table.c.data[key].astext


def eq_cond(ent: Entity, key: str, value: Any):
    if key in ent.physical:
        col = ent.table.c[key]
        if isinstance(value, (list, tuple)):
            return col.in_([to_db(col, v) for v in value])
        return col == to_db(col, value)
    if isinstance(value, bool):
        value = "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return ent.table.c.data[key].astext.in_([str(v) for v in value])
    return ent.table.c.data[key].astext == str(value)


def base_where(ent: Entity) -> list:
    t = ent.table
    conds = [t.c.deleted_at.is_(None)]
    if t.name == "records":
        conds += [t.c.module == ent.module_id, t.c.entity == ent.key]
    for k, v in ent.scope.items():
        conds.append(eq_cond(ent, k, v))
    return conds


def branch_cond(ctx, ent: Entity):
    """Operational entities are listed per active branch; shared masters and system contexts
    (jobs, seeds, portal) see every branch. Rows without a branch stay visible everywhere."""
    branch = getattr(ctx, "branch", None)
    if not branch or ent.shared:
        return None
    col = ent.table.c.branch_id
    return sa.or_(col == branch, col.is_(None))


def scoped_where(ctx, ent: Entity) -> list:
    """`base_where` plus the active-branch filter (use for worklists, counts and KPIs)."""
    conds = base_where(ent)
    bc = branch_cond(ctx, ent)
    if bc is not None:
        conds.append(bc)
    return conds


def _escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _label(table: str, code: str | None, title: str | None) -> str:
    if table in ("patients", "encounters") and code and title:
        return f"{title} · {code}"
    return title or code or ""


def _notify(ctx, ent: Entity, rec: dict, action: str) -> None:
    payload = {"fqn": ent.fqn, "module": ent.module_id, "entity": ent.key, "id": rec.get("id"),
               "action": action, "status": rec.get("status"), "patient_id": rec.get("patient_id")}
    ctx.on_commit(lambda: publish("changes", payload))


# ---------------------------------------------------------------- reads

async def fetch(ctx, ent: Entity, rid: str) -> dict | None:
    if not is_uuid(rid):
        return None
    row = (await ctx.conn.execute(sa.select(ent.table).where(ent.table.c.id == rid, *base_where(ent)))).first()
    return to_record(row) if row else None


async def resolve_refs(ctx, ent: Entity, recs: list[dict]) -> dict[str, str]:
    want: dict[str, set[str]] = defaultdict(set)

    def add(ref: str | None, val: Any) -> None:
        target = get_entity(ref) if ref else None
        if target and val and is_uuid(val):
            want[target.table.name].add(str(val))

    for r in recs:
        for col, table in (("patient_id", "patients"), ("employee_id", "employees"), ("encounter_id", "encounters")):
            if r.get(col) and is_uuid(r[col]):
                want[table].add(str(r[col]))
        for f in ent.fields:
            if f.type == "ref":
                add(f.ref, r.get(f.key))
            elif f.type == "lines":
                for line in r.get(f.key) or []:
                    for sf in f.fields or []:
                        if sf.type == "ref":
                            add(sf.ref, line.get(sf.key))
    labels: dict[str, str] = {}
    for tname, ids in want.items():
        t = ENTITY_TABLES[tname]
        res = await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.title).where(t.c.id.in_(list(ids))))
        for row in res:
            labels[str(row.id)] = _label(tname, row.code, row.title)
    return labels


async def list_records(ctx, ent: Entity, *, q: str | None = None, status: str | None = None,
                       patient_id: str | None = None, encounter_id: str | None = None, employee_id: str | None = None,
                       filters: dict | None = None, date_from: str | None = None, date_to: str | None = None,
                       sort: str | None = None, page: int = 1, limit: int = 25, check: bool = True,
                       max_limit: int = 500) -> dict:
    if check:
        ensure_access(ctx, ent, "read")
        await _flush_break_glass(ctx)
    t = ent.table
    conds = base_where(ent)
    # Patient- and visit-centric views show the whole record across branches (continuity of care).
    if not (patient_id or encounter_id):
        bc = branch_cond(ctx, ent)
        if bc is not None:
            conds.append(bc)
    if q:
        conds.append(t.c.search.ilike(f"%{_escape_like(q.strip().lower())}%", escape="\\"))
    if status:
        conds.append(t.c.status.in_([s for s in status.split(",") if s]))
    for col, val in (("patient_id", patient_id), ("encounter_id", encounter_id), ("employee_id", employee_id)):
        if val:
            if not is_uuid(val):
                raise bad_request(f"Invalid {col}")
            conds.append(t.c[col] == val)
    for k, v in (filters or {}).items():
        if k in ent.field_map or k in ent.physical:
            conds.append(eq_cond(ent, k, v))
    dfield = ent.date_field or "created_at"
    if date_from or date_to:
        if dfield in ent.physical:
            col = t.c[dfield]
            if isinstance(col.type, sa.DateTime):
                if date_from:
                    conds.append(col >= day_bounds(parse_date(date_from))[0])
                if date_to:
                    conds.append(col < day_bounds(parse_date(date_to))[1])
            else:
                if date_from:
                    conds.append(col >= parse_date(date_from))
                if date_to:
                    conds.append(col <= parse_date(date_to))
        else:
            col = t.c.data[dfield].astext
            if date_from:
                conds.append(col >= str(date_from))
            if date_to:
                conds.append(col <= f"{date_to}T23:59:59")
    key = sort or ent.sort or "-created_at"
    desc = key.startswith("-")
    name = key.lstrip("-")
    if name in ent.physical:
        scol = t.c[name]
    elif name in ent.field_map:
        scol = t.c.data[name].astext
    else:
        scol, desc = t.c.created_at, True
    order = scol.desc().nulls_last() if desc else scol.asc().nulls_last()
    limit = max(1, min(limit, max_limit))
    page = max(1, page)
    rows = (await ctx.conn.execute(
        sa.select(t).where(*conds).order_by(order, t.c.created_at.desc()).limit(limit).offset((page - 1) * limit)
    )).all()
    total = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(t).where(*conds))).scalar_one()
    recs = [to_record(r) for r in rows]
    return {"rows": recs, "total": total, "page": page, "limit": limit, "refs": await resolve_refs(ctx, ent, recs)}


async def get_record(ctx, ent: Entity, rid: str, *, check: bool = True) -> dict:
    if check:
        ensure_access(ctx, ent, "read")
        await _flush_break_glass(ctx)
    rec = await fetch(ctx, ent, rid)
    if not rec:
        raise not_found(f"{ent.singular} not found")
    rec["_refs"] = await resolve_refs(ctx, ent, [rec])
    return rec


# ---------------------------------------------------------------- writes

async def _insert(ctx, ent: Entity, draft: dict) -> dict:
    t = ent.table
    rid = draft.pop("id", None) or new_id()
    branch = getattr(ctx, "branch", None) or settings.branch_id
    code = draft.pop("code", None)
    if not code and ent.code_pattern:
        info = await branch_info(ctx.conn, branch)
        code = await next_pattern_code(ctx.conn, ent.code_pattern, prefix=ent.prefix, branch_no=info["no"], at=now())
    if not code:
        code = await next_code(ctx.conn, ent.prefix, ent.code_digits, ent.code_sep)
    for k, v in ent.scope.items():
        draft[k] = v
    title = compute_title(ent, draft)
    cols, data = split(ent, draft)
    ts = now()
    row = dict(id=rid, code=code, status=draft.get("status"), title=title, data=data,
               search=search_text(ent, code, title, draft), branch_id=branch,
               created_by=ctx.user_id, created_at=ts, updated_by=ctx.user_id, updated_at=ts, **cols)
    if t.name == "records":
        row.update(module=ent.module_id, entity=ent.key)
    await ctx.conn.execute(t.insert().values(**row))
    return await fetch(ctx, ent, rid)


async def _write(ctx, ent: Entity, rec: dict) -> None:
    t = ent.table
    title = compute_title(ent, rec)
    cols, data = split(ent, rec)
    await ctx.conn.execute(
        t.update().where(t.c.id == rec["id"]).values(
            code=rec.get("code"), status=rec.get("status"), title=title, data=data,
            search=search_text(ent, rec.get("code"), title, rec), updated_by=ctx.user_id, updated_at=now(), **cols,
        )
    )


def _trusted_extras(ent: Entity, payload: dict) -> dict:
    """Engines may set physical columns / extra data keys that are not declared fields."""
    return {k: v for k, v in payload.items() if k not in ent.field_map and k not in NON_DATA - {"code", "id"} and not k.startswith("_")}


async def create_record(ctx, ent: Entity, payload: dict, *, check: bool = True, trusted: bool = False) -> dict:
    if check:
        ensure_access(ctx, ent, "write")
        if ent.readonly and not trusted:
            raise forbidden(f"{ent.label} are created by the system workflow, not directly")
    fc = None if trusted else (await effective_fields(ctx, ent.fqn))[0]
    draft = validate(ctx, ent, payload, partial=False, trusted=trusted, fc=fc)
    if trusted:
        draft.update(_trusted_extras(ent, payload))
    elif ent.code_editable and payload.get("code"):
        draft["code"] = str(payload["code"]).strip()[:40]
    if ent.statuses:
        s = payload.get("status")
        draft["status"] = s if s in ent.statuses and (trusted or not ent.transitions) else ent.statuses[0]
    await run_hooks(ent.fqn, "before_create", ctx, draft)
    rec = await _insert(ctx, ent, draft)
    await audit(ctx, "create", module=ent.module_id, entity=ent.key, record=rec, after=rec)
    await run_hooks(ent.fqn, "after_create", ctx, rec)
    await capture_charge(ctx, ent, rec, None, "create")
    _notify(ctx, ent, rec, "created")
    return rec


async def update_record(ctx, ent: Entity, rid: str, payload: dict, *, check: bool = True, trusted: bool = False) -> dict:
    if check:
        ensure_access(ctx, ent, "write")
        if ent.readonly and not trusted:
            raise forbidden(f"{ent.label} are maintained by the system workflow")
    prev = await fetch(ctx, ent, rid)
    if not prev:
        raise not_found(f"{ent.singular} not found")
    fc = None if trusted else (await effective_fields(ctx, ent.fqn))[0]
    values = validate(ctx, ent, payload, partial=True, prev=prev, trusted=trusted, fc=fc)
    nxt = {**prev, **values}
    if trusted:
        nxt.update(_trusted_extras(ent, payload))
    s = payload.get("status")
    if s and ent.statuses and s in ent.statuses and (trusted or not ent.transitions):
        nxt["status"] = s
    await run_hooks(ent.fqn, "before_update", ctx, nxt, prev)
    await _write(ctx, ent, nxt)
    rec = await fetch(ctx, ent, rid)
    b, a = diff(prev, rec)
    if a:
        await audit(ctx, "update", module=ent.module_id, entity=ent.key, record=rec, before=b, after=a)
    await run_hooks(ent.fqn, "after_update", ctx, rec, prev)
    if prev.get("status") != rec.get("status"):
        await capture_charge(ctx, ent, rec, prev.get("status"), "status")
    _notify(ctx, ent, rec, "updated")
    return rec


def allowed_transitions(ent: Entity, rec: dict, role: str) -> list[dict]:
    out = []
    for t in ent.transitions:
        if t.from_ != "*" and rec.get("status") not in t.from_:
            continue
        if t.from_ == "*" and rec.get("status") == t.to:
            continue
        if t.roles and role not in t.roles and role != "admin":
            continue
        out.append(t.model_dump(by_alias=True, exclude_none=True))
    return out


async def transition_record(ctx, ent: Entity, rid: str, to: str, *, note: str | None = None,
                            values: dict | None = None, check: bool = True) -> dict:
    if check:
        ensure_access(ctx, ent, "write")
    prev = await fetch(ctx, ent, rid)
    if not prev:
        raise not_found(f"{ent.singular} not found")
    tr = next((t for t in ent.transitions if t.to == to and (t.from_ == "*" or prev.get("status") in t.from_)), None)
    if tr is None:
        if not (not ent.transitions and ent.statuses and to in ent.statuses):
            raise conflict(f"{ent.singular} cannot move from {prev.get('status')} to {to}")
    elif check and tr.roles and ctx.role not in tr.roles and ctx.role != "admin":
        raise forbidden(f"Only {', '.join(tr.roles)} can {tr.label.lower()}")
    extra = validate(ctx, ent, values or {}, partial=True, prev=prev) if values else {}
    nxt = {**prev, **extra, "status": to}
    if tr and tr.require:
        missing = [ent.field_map[k].label for k in tr.require if nxt.get(k) in (None, "", [])]
        if missing:
            raise bad_request(f"Fill {', '.join(missing)} before '{tr.label}'", {"fields": {k: "Required" for k in tr.require if nxt.get(k) in (None, '', [])}})
    if tr and tr.stamp:
        nxt[tr.stamp] = now().isoformat(timespec="seconds")
    await run_hooks(ent.fqn, "before_transition", ctx, nxt, prev)
    await _write(ctx, ent, nxt)
    rec = await fetch(ctx, ent, rid)
    await audit(ctx, "status", module=ent.module_id, entity=ent.key, record=rec,
                before={"status": prev.get("status")}, after={"status": to, **extra}, note=note)
    await run_hooks(ent.fqn, "after_transition", ctx, rec, prev)
    await capture_charge(ctx, ent, rec, prev.get("status"), "status")
    _notify(ctx, ent, rec, "status")
    return rec


async def delete_record(ctx, ent: Entity, rid: str, *, reason: str | None = None, check: bool = True) -> None:
    if check:
        ensure_access(ctx, ent, "write")
        if ent.readonly:
            raise forbidden(f"{ent.label} cannot be deleted; use the workflow to cancel")
    prev = await fetch(ctx, ent, rid)
    if not prev:
        raise not_found(f"{ent.singular} not found")
    await ctx.conn.execute(ent.table.update().where(ent.table.c.id == rid).values(deleted_at=now(), updated_by=ctx.user_id))
    await audit(ctx, "delete", module=ent.module_id, entity=ent.key, record=prev, before=prev, note=reason)
    _notify(ctx, ent, prev, "deleted")


async def capture_charge(ctx, ent: Entity, rec: dict, prev_status: str | None, trigger: str) -> None:
    """Charge capture at the point of service: entities with `charge` post to billing."""
    ch = ent.charge
    if not ch or not rec.get("patient_id"):
        return
    if ch.on == "create":
        if trigger != "create":
            return
    elif rec.get("status") != ch.on or prev_status == ch.on:
        return
    qty = rec.get(ch.qty_field) if ch.qty_field else ch.qty
    payload = {
        "patient_id": rec["patient_id"], "encounter_id": rec.get("encounter_id"),
        "service_id": rec.get(ch.service_field) if ch.service_field else None, "service_code": ch.code,
        "qty": float(qty or 1), "rate": rec.get(ch.rate_field) if ch.rate_field else None,
        "description": ch.label, "ref_code": rec.get("code"), "fallback": f"{ent.singular} {rec.get('code')}",
        "source": ent.fqn, "source_id": rec["id"],
    }
    await run_hooks("charge", "capture", ctx, payload)


# ---------------------------------------------------------------- lookups & stats

LIGHT_SKIP = {"lines", "signature", "textarea", "file"}


async def lookup(ctx, ent: Entity, *, q: str | None = None, filters: dict | None = None,
                 ids: list[str] | None = None, limit: int = 20) -> list[dict]:
    if ent.restricted:
        raise forbidden("Restricted records cannot be looked up")
    t = ent.table
    conds = base_where(ent)
    if ids:
        conds.append(t.c.id.in_([i for i in ids if is_uuid(i)]))
    else:
        bc = branch_cond(ctx, ent)
        if bc is not None:
            conds.append(bc)
    if q:
        conds.append(t.c.search.ilike(f"%{_escape_like(q.strip().lower())}%", escape="\\"))
    for k, v in (filters or {}).items():
        if k in ent.field_map or k in ent.physical:
            conds.append(eq_cond(ent, k, v))
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(t.c.title.asc().nulls_last()).limit(min(limit, 100)))).all()
    out = []
    for r in rows:
        rec = to_record(r)
        light = {k: v for k, v in rec.items() if not (k in ent.field_map and ent.field_map[k].type in LIGHT_SKIP)}
        light["label"] = _label(t.name, rec.get("code"), rec.get("title"))
        out.append(light)
    return out


async def entity_stats(ctx, ent: Entity) -> dict:
    t = ent.table
    conds = scoped_where(ctx, ent)
    rows = (await ctx.conn.execute(sa.select(t.c.status, sa.func.count()).where(*conds).group_by(t.c.status))).all()
    start, _ = day_bounds(today())
    n_today = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(t).where(*conds, t.c.created_at >= start))).scalar_one()
    by_status = {(s or "—"): n for s, n in rows}
    return {"total": sum(by_status.values()), "today": n_today, "by_status": by_status}


async def compute_kpis(ctx, mod) -> list[dict]:
    out = []
    for k in mod.kpis:
        ent: Entity = mod.entity_map[k.entity]
        t = ent.table
        conds = scoped_where(ctx, ent)
        for fk, fv in k.where.items():
            conds.append(eq_cond(ent, fk, fv))
        if k.period != "all":
            d = today()
            start = d.replace(day=1) if k.period == "month" else d
            end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) if k.period == "month" else d + timedelta(days=1)
            dfield = ent.date_field or "created_at"
            if dfield in ent.physical:
                col = t.c[dfield]
                if isinstance(col.type, sa.DateTime):
                    conds += [col >= day_bounds(start)[0], col < day_bounds(end)[0]]
                else:
                    conds += [col >= start, col < end]
            else:
                conds += [t.c.data[dfield].astext >= start.isoformat(), t.c.data[dfield].astext < end.isoformat()]
        if k.agg == "count":
            expr = sa.func.count()
        else:
            col = t.c[k.field] if k.field in ent.physical else sa.cast(t.c.data[k.field].astext, sa.Numeric)
            expr = sa.func.coalesce(sa.func.sum(col) if k.agg == "sum" else sa.func.avg(col), 0)
        val = (await ctx.conn.execute(sa.select(expr).select_from(t).where(*conds))).scalar_one()
        out.append({"label": k.label, "value": to_json_value(val), "format": k.format})
    return out


def entity_or_404(module_id: str, entity_key: str) -> Entity:
    ent = get_entity(f"{module_id}.{entity_key}")
    if not ent:
        raise ApiError(404, f"Unknown entity {module_id}.{entity_key}")
    return ent


__all__ = [
    "ensure_access", "validate", "list_records", "get_record", "create_record", "update_record",
    "transition_record", "delete_record", "allowed_transitions", "lookup", "entity_stats", "compute_kpis",
    "resolve_refs", "fetch", "to_record", "entity_or_404", "base_where", "eq_cond", "col_expr", "datetime",
    "branch_cond", "scoped_where",
]
