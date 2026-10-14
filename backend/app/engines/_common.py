"""Helpers shared by engines."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from ..core import records as rs
from ..core.registry import Entity, get_entity
from ..core.util import ApiError, day_bounds, is_uuid, today
from ..redis import publish


def E(fqn: str) -> Entity:
    """Entity by fully-qualified name; 503 if that module is not installed."""
    ent = get_entity(fqn)
    if not ent:
        raise ApiError(503, f"Module entity {fqn} is not installed")
    return ent


def has(fqn: str) -> bool:
    return get_entity(fqn) is not None


async def find(ctx, fqn: str, *, limit: int = 200, sort: str | None = None, status: str | list[str] | None = None,
               patient_id: str | None = None, employee_id: str | None = None, encounter_id: str | None = None,
               date_from: str | None = None, date_to: str | None = None, q: str | None = None, **filters: Any) -> list[dict]:
    """List records of any entity without access checks (engines enforce their own)."""
    ent = get_entity(fqn)
    if not ent:
        return []
    st = ",".join(status) if isinstance(status, list) else status
    res = await rs.list_records(ctx, ent, q=q, status=st, patient_id=patient_id, employee_id=employee_id,
                                encounter_id=encounter_id, filters=filters or None, date_from=date_from,
                                date_to=date_to, sort=sort, limit=limit, check=False)
    rows = res["rows"]
    for r in rows:
        r["_refs"] = res["refs"]
    return rows


async def first(ctx, fqn: str, **kw: Any) -> dict | None:
    rows = await find(ctx, fqn, limit=1, **kw)
    return rows[0] if rows else None


async def get(ctx, fqn: str, rid: str) -> dict | None:
    ent = get_entity(fqn)
    if not ent or not rid or not is_uuid(rid):
        return None
    return await rs.fetch(ctx, ent, rid)


async def create(ctx, fqn: str, data: dict) -> dict:
    return await rs.create_record(ctx, E(fqn), data, check=False, trusted=True)


async def update(ctx, fqn: str, rid: str, data: dict) -> dict:
    return await rs.update_record(ctx, E(fqn), rid, data, check=False, trusted=True)


async def transition(ctx, fqn: str, rid: str, to: str, note: str | None = None, values: dict | None = None) -> dict:
    return await rs.transition_record(ctx, E(fqn), rid, to, note=note, values=values, check=False)


async def count(ctx, fqn: str, *, today_only: bool = False, status: str | list[str] | None = None, **filters: Any) -> int:
    ent = get_entity(fqn)
    if not ent:
        return 0
    t = ent.table
    conds = rs.base_where(ent)
    if status:
        conds.append(t.c.status.in_(status if isinstance(status, list) else [status]))
    for k, v in filters.items():
        conds.append(rs.eq_cond(ent, k, v))
    if today_only:
        start, end = day_bounds(today())
        dfield = ent.date_field or "created_at"
        if dfield in ent.physical:
            col = t.c[dfield]
            if isinstance(col.type, sa.DateTime):
                conds += [col >= start, col < end]
            else:
                conds.append(col == today())
        else:
            conds.append(t.c.data[dfield].astext.like(f"{today().isoformat()}%"))
    return (await ctx.conn.execute(sa.select(sa.func.count()).select_from(t).where(*conds))).scalar_one()


def live(ctx, channel: str, payload: dict) -> None:
    """Publish to realtime subscribers after the transaction commits."""
    ctx.on_commit(lambda: publish(channel, payload))


def require_role(ctx, *roles: str) -> None:
    if ctx.role != "admin" and ctx.role not in roles:
        raise ApiError(403, "Your role cannot perform this action")
