"""Hospital metrics shared by the executive dashboard, finance console, analytics and the
management command layer. All functions are read-only and accept a date range."""

from __future__ import annotations

from datetime import date, timedelta

import sqlalchemy as sa
from fastapi import APIRouter

from ..core.security import CtxDep, require_roles
from ..core.util import day_bounds, to_json_value, today
from ..redis import cached
from ..schema import appointments, beds, charges, encounters, invoices, orders, payments, queue_tokens, records

router = APIRouter(prefix="/api/metrics", tags=["metrics"])

LIVE = [beds.c.deleted_at.is_(None)]
FINANCE_ROLES = ("admin", "management", "billing", "quality")


def _rng(d_from: date, d_to: date):
    return day_bounds(d_from)[0], day_bounds(d_to)[1]


def _f(v) -> float:
    return float(to_json_value(v) or 0)


async def bed_census(ctx) -> dict:
    rows = (await ctx.conn.execute(sa.select(beds.c.status, sa.func.count()).where(*LIVE).group_by(beds.c.status))).all()
    by = {s or "Unknown": n for s, n in rows}
    total = sum(by.values())
    usable = total - by.get("Blocked", 0) - by.get("Maintenance", 0)
    occ = by.get("Occupied", 0)
    return {"total": total, "by_status": by, "occupied": occ, "vacant": by.get("Vacant", 0),
            "occupancy_pct": round(occ / usable * 100, 1) if usable else 0.0}


async def occupancy_by_ward(ctx) -> list[dict]:
    w = records
    rows = (await ctx.conn.execute(
        sa.select(beds.c.ward_id, w.c.title, sa.func.count(), sa.func.count().filter(beds.c.status == "Occupied"))
        .select_from(beds.outerjoin(w, w.c.id == beds.c.ward_id)).where(*LIVE).group_by(beds.c.ward_id, w.c.title)
    )).all()
    return sorted([{"ward": t or "Unassigned", "total": n, "occupied": o} for _, t, n, o in rows], key=lambda x: x["ward"])


async def op_visits(ctx, d_from: date, d_to: date) -> dict:
    t = appointments
    base = [t.c.deleted_at.is_(None), t.c.appt_date >= d_from, t.c.appt_date <= d_to]
    rows = (await ctx.conn.execute(sa.select(t.c.status, sa.func.count()).where(*base).group_by(t.c.status))).all()
    by = {s: n for s, n in rows}
    return {"booked": sum(by.values()), "by_status": by,
            "seen": by.get("Completed", 0) + by.get("In Consultation", 0),
            "waiting": by.get("Checked-in", 0), "no_show": by.get("No-show", 0)}


async def admissions(ctx, d_from: date, d_to: date) -> dict:
    s, e = _rng(d_from, d_to)
    t = encounters
    adm = (await ctx.conn.execute(sa.select(sa.func.count()).where(t.c.type == "IPD", t.c.started_at >= s, t.c.started_at < e, t.c.deleted_at.is_(None)))).scalar_one()
    dis = (await ctx.conn.execute(sa.select(sa.func.count()).where(t.c.type == "IPD", t.c.ended_at >= s, t.c.ended_at < e, t.c.status == "Discharged"))).scalar_one()
    census = (await ctx.conn.execute(sa.select(sa.func.count()).where(t.c.type == "IPD", t.c.status.in_(["Admitted", "Discharge Initiated"]), t.c.deleted_at.is_(None)))).scalar_one()
    pending = (await ctx.conn.execute(sa.select(sa.func.count()).where(t.c.type == "IPD", t.c.status == "Discharge Initiated", t.c.deleted_at.is_(None)))).scalar_one()
    alos = (await ctx.conn.execute(sa.select(sa.func.avg(sa.extract("epoch", t.c.ended_at - t.c.started_at) / 86400)).where(
        t.c.type == "IPD", t.c.status == "Discharged", t.c.ended_at >= s - timedelta(days=30), t.c.ended_at < e))).scalar_one()
    er = (await ctx.conn.execute(sa.select(sa.func.count()).where(t.c.type == "ER", t.c.started_at >= s, t.c.started_at < e, t.c.deleted_at.is_(None)))).scalar_one()
    return {"admitted": adm, "discharged": dis, "census": census, "discharge_pending": pending,
            "alos_days": round(float(alos), 1) if alos else None, "er_visits": er}


async def revenue(ctx, d_from: date, d_to: date) -> dict:
    s, e = _rng(d_from, d_to)
    inv = invoices
    billed = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(inv.c.net), 0), sa.func.count()).where(
        inv.c.billed_at >= s, inv.c.billed_at < e, inv.c.status != "Cancelled", inv.c.deleted_at.is_(None)))).one()
    by_type = (await ctx.conn.execute(sa.select(inv.c.type, sa.func.coalesce(sa.func.sum(inv.c.net), 0)).where(
        inv.c.billed_at >= s, inv.c.billed_at < e, inv.c.status != "Cancelled", inv.c.deleted_at.is_(None)).group_by(inv.c.type))).all()
    p = payments
    pay_base = [p.c.paid_at >= s, p.c.paid_at < e, p.c.status == "Success", p.c.deleted_at.is_(None)]
    modes = (await ctx.conn.execute(sa.select(p.c.mode, sa.func.coalesce(sa.func.sum(p.c.amount), 0)).where(
        *pay_base, p.c.kind.in_(["PAYMENT", "DEPOSIT"])).group_by(p.c.mode))).all()
    refunds = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(p.c.amount), 0)).where(*pay_base, p.c.kind == "REFUND"))).scalar_one()
    unbilled = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(charges.c.amount), 0)).where(
        charges.c.status == "Unbilled", charges.c.deleted_at.is_(None)))).scalar_one()
    outstanding = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(inv.c.balance), 0)).where(
        inv.c.status.in_(["Final", "Partially Paid"]), inv.c.deleted_at.is_(None)))).scalar_one()
    pending_refunds = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(p.c.amount), 0)).where(
        p.c.kind == "REFUND", p.c.status == "Pending", p.c.deleted_at.is_(None)))).scalar_one()
    collected = sum(_f(v) for _, v in modes)
    return {"billed": _f(billed[0]), "bills": billed[1], "by_type": {k or "Other": _f(v) for k, v in by_type},
            "collected": collected, "by_mode": {k or "Other": _f(v) for k, v in modes}, "refunds": _f(refunds),
            "net_collection": collected - _f(refunds), "unbilled": _f(unbilled), "outstanding": _f(outstanding),
            "pending_refunds": _f(pending_refunds)}


async def lab_tat(ctx, d_from: date, d_to: date, category: str = "LAB") -> dict:
    s, e = _rng(d_from, d_to)
    o = orders
    base = [o.c.category == category, o.c.ordered_at >= s, o.c.ordered_at < e, o.c.deleted_at.is_(None)]
    avg = (await ctx.conn.execute(sa.select(sa.func.avg(sa.extract("epoch", sa.func.coalesce(o.c.verified_at, o.c.resulted_at) - o.c.ordered_at) / 60)).where(
        *base, sa.func.coalesce(o.c.verified_at, o.c.resulted_at).isnot(None)))).scalar_one()
    rows = (await ctx.conn.execute(sa.select(o.c.status, sa.func.count()).where(*base).group_by(o.c.status))).all()
    by = {k: n for k, n in rows}
    crit = (await ctx.conn.execute(sa.select(sa.func.count()).where(o.c.critical.is_(True), o.c.acknowledged_at.is_(None), o.c.deleted_at.is_(None)))).scalar_one()
    return {"orders": sum(by.values()), "by_status": by, "avg_tat_min": round(float(avg), 0) if avg else None,
            "pending": by.get("Ordered", 0) + by.get("Collected", 0) + by.get("In Progress", 0), "critical_unack": crit}


async def er_door_to_doctor(ctx, d_from: date, d_to: date) -> float | None:
    s, e = _rng(d_from, d_to)
    t = encounters
    seen = sa.cast(t.c.data["doctor_seen_at"].astext, sa.DateTime(timezone=True))
    v = (await ctx.conn.execute(sa.select(sa.func.avg(sa.extract("epoch", seen - t.c.started_at) / 60)).where(
        t.c.type == "ER", t.c.started_at >= s, t.c.started_at < e, t.c.data["doctor_seen_at"].astext.isnot(None)))).scalar_one()
    return round(float(v), 0) if v else None


async def opd_wait(ctx, d: date) -> float | None:
    t = queue_tokens
    v = (await ctx.conn.execute(sa.select(sa.func.avg(sa.extract("epoch", t.c.called_at - t.c.created_at) / 60)).where(
        t.c.token_date == d, t.c.called_at.isnot(None)))).scalar_one()
    return round(float(v), 0) if v else None


async def daily_series(ctx, days: int = 14) -> list[dict]:
    end = today()
    start = end - timedelta(days=days - 1)
    s, e = _rng(start, end)
    # Inline the (ZoneInfo-validated) zone name: a bind parameter would differ between SELECT and GROUP BY.
    tz = sa.literal_column("'" + ctx_tz().replace("'", "") + "'")
    day = lambda col: sa.func.date(sa.func.timezone(tz, col))  # noqa: E731
    inv = invoices
    billed = dict((await ctx.conn.execute(sa.select(day(inv.c.billed_at), sa.func.sum(inv.c.net)).where(
        inv.c.billed_at >= s, inv.c.billed_at < e, inv.c.status != "Cancelled").group_by(day(inv.c.billed_at)))).all())
    p = payments
    coll = dict((await ctx.conn.execute(sa.select(day(p.c.paid_at), sa.func.sum(p.c.amount)).where(
        p.c.paid_at >= s, p.c.paid_at < e, p.c.status == "Success", p.c.kind.in_(["PAYMENT", "DEPOSIT"])).group_by(day(p.c.paid_at)))).all())
    a = appointments
    opd = dict((await ctx.conn.execute(sa.select(a.c.appt_date, sa.func.count()).where(
        a.c.appt_date >= start, a.c.appt_date <= end, a.c.deleted_at.is_(None), a.c.status.notin_(["Cancelled"])).group_by(a.c.appt_date))).all())
    en = encounters
    adm = dict((await ctx.conn.execute(sa.select(day(en.c.started_at), sa.func.count()).where(
        en.c.type == "IPD", en.c.started_at >= s, en.c.started_at < e).group_by(day(en.c.started_at)))).all())
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        out.append({"date": d.isoformat(), "billed": _f(billed.get(d)), "collected": _f(coll.get(d)),
                    "op_visits": int(opd.get(d) or 0), "admissions": int(adm.get(d) or 0)})
    return out


def ctx_tz() -> str:
    from ..config import settings

    return settings.timezone


async def department_op(ctx, d: date) -> list[dict]:
    a = appointments
    w = records
    rows = (await ctx.conn.execute(
        sa.select(w.c.title, sa.func.count()).select_from(a.outerjoin(w, w.c.id == a.c.department_id))
        .where(a.c.appt_date == d, a.c.deleted_at.is_(None), a.c.status != "Cancelled").group_by(w.c.title)
        .order_by(sa.func.count().desc()).limit(10))).all()
    return [{"department": t or "Unassigned", "visits": n} for t, n in rows]


async def executive(ctx, d_from: date | None = None, d_to: date | None = None) -> dict:
    d_from = d_from or today()
    d_to = d_to or d_from
    return {
        "range": {"from": d_from.isoformat(), "to": d_to.isoformat()},
        "beds": await bed_census(ctx),
        "op": await op_visits(ctx, d_from, d_to),
        "ip": await admissions(ctx, d_from, d_to),
        "revenue": await revenue(ctx, d_from, d_to),
        "lab": await lab_tat(ctx, d_from, d_to, "LAB"),
        "radiology": await lab_tat(ctx, d_from, d_to, "RAD"),
        "er_door_to_doctor_min": await er_door_to_doctor(ctx, d_from, d_to),
        "opd_wait_min": await opd_wait(ctx, d_to),
    }


@router.get("/executive")
async def executive_api(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None):
    """Clinical roles get operational numbers; revenue figures are limited to finance-facing roles."""
    d_from = date.fromisoformat(date_from) if date_from else today()
    d_to = date.fromisoformat(date_to) if date_to else d_from
    data = await cached(f"exec:{d_from}:{d_to}", 20, lambda: executive(ctx, d_from, d_to))
    if ctx.role not in FINANCE_ROLES:
        data = {k: v for k, v in data.items() if k != "revenue"}
    return data


@router.get("/series")
async def series_api(ctx: CtxDep, days: int = 14):
    require_roles(ctx, *FINANCE_ROLES)
    days = max(7, min(days, 90))
    return await cached(f"series:{today()}:{days}", 60, lambda: daily_series(ctx, days))


@router.get("/wards")
async def wards_api(ctx: CtxDep):
    return await cached("wards", 20, lambda: occupancy_by_ward(ctx))


@router.get("/departments")
async def departments_api(ctx: CtxDep):
    return await cached(f"dept:{today()}", 30, lambda: department_op(ctx, today()))
