"""Full audit trail on every create, edit, status change, override, print and break-glass."""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from ..schema import audit_log
from .util import new_id, now

_SKIP = {"updated_at", "updated_by", "search", "_refs"}


def diff(before: dict | None, after: dict | None) -> tuple[dict, dict]:
    before, after = before or {}, after or {}
    b, a = {}, {}
    for k in set(before) | set(after):
        if k in _SKIP:
            continue
        if json.dumps(before.get(k), default=str, sort_keys=True) != json.dumps(after.get(k), default=str, sort_keys=True):
            b[k], a[k] = before.get(k), after.get(k)
    return b, a


def _clean(v: Any) -> Any:
    return json.loads(json.dumps(v, default=str)) if v is not None else None


async def audit(ctx, action: str, *, module: str | None = None, entity: str | None = None,
                record: dict | None = None, before: Any = None, after: Any = None, note: str | None = None) -> None:
    rec = record or {}
    patient_id = rec.get("patient_id") or (rec.get("id") if entity == "patients" else None)
    await ctx.conn.execute(
        audit_log.insert().values(
            id=new_id(), at=now(), user_id=str(ctx.user.get("id")), user_name=ctx.user.get("name"),
            role=ctx.user.get("role"), action=action, module=module, entity=entity,
            record_id=str(rec["id"]) if rec.get("id") else None, record_code=rec.get("code"),
            patient_id=str(patient_id) if patient_id else None,
            before=_clean(before), after=_clean(after), note=note, ip=ctx.ip,
        )
    )


async def audit_trail(conn, *, record_id=None, patient_id=None, module=None, action=None, user_id=None,
                      date_from=None, date_to=None, limit=100, offset=0) -> dict:
    t = audit_log
    conds = []
    if record_id:
        conds.append(t.c.record_id == str(record_id))
    if patient_id:
        conds.append(t.c.patient_id == str(patient_id))
    if module:
        conds.append(t.c.module == module)
    if action:
        conds.append(t.c.action.like(f"{action}%"))
    if user_id:
        conds.append(t.c.user_id == user_id)
    if date_from:
        conds.append(t.c.at >= date_from)
    if date_to:
        conds.append(t.c.at <= date_to)
    where = sa.and_(*conds) if conds else sa.true()
    rows = (await conn.execute(sa.select(t).where(where).order_by(t.c.at.desc()).limit(limit).offset(offset))).mappings().all()
    total = (await conn.execute(sa.select(sa.func.count()).select_from(t).where(where))).scalar_one()
    from .util import to_json_value

    return {"rows": [{k: to_json_value(v) for k, v in r.items()} for r in rows], "total": total}
