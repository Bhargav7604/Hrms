"""Insight layer: Reports & Analytics (module 51), the management Command Layer (module 52) and
the Finance console (module 50).

Builds on engines/metrics.py (shared definitions of revenue, occupancy, TAT…) and adds the
slices management asks for: department / sponsor / service-category / doctor revenue, volume
trends by day-week-month, live numbers versus the same time last week, threshold alerts from
`command.alert_rules`, collections by mode and branch, P&L against `finance.expenses` and revenue
targets versus achievement.

Money is accrual-based where a slice needs a department or category (charges at the point of
service), and bill-based for revenue totals (invoices) — the same definitions as the executive
dashboard so every screen shows the same number.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter, Query

from ..config import settings
from ..core import records as rs
from ..core.registry import get_entity
from ..core.security import CtxDep
from ..core.util import bad_request, now, parse_date, parse_dt, today
from ..redis import cached
from ..schema import (
    appointments,
    beds,
    charges,
    employees,
    encounters,
    invoices,
    orders,
    patients,
    payments,
    records,
    services,
    stock,
)
from . import metrics
from ._common import E, create, find, live, update

log = logging.getLogger("vlack.insights")
router = APIRouter(prefix="/api/insights", tags=["insights"])

GROUPS = ("day", "week", "month")
CATEGORY_LABELS = {
    "CONSULT": "Consultation", "LAB": "Laboratory", "RAD": "Radiology", "PROC": "Procedures", "ROOM": "Room & bed",
    "NURSING": "Nursing", "PHARM": "Pharmacy", "OT": "OT & anaesthesia", "ICU": "ICU care", "PACKAGE": "Packages",
    "DIALYSIS": "Dialysis", "PHYSIO": "Physiotherapy", "BLOOD": "Blood bank", "AMBULANCE": "Ambulance", "DIET": "Dietetics",
    "DENTAL": "Dental", "MISC": "Miscellaneous", "OTHER": "Other",
}
CRITICAL_CARE = ("ICU", "HDU", "NICU", "PICU")


def _f(v: Any) -> float:
    return float(v or 0)


def _range(d_from: str | None, d_to: str | None, default_days: int, max_days: int = 366) -> tuple[date, date]:
    try:
        end = parse_date(d_to) or today()
        start = parse_date(d_from) or end - timedelta(days=default_days - 1)
    except ValueError as e:
        raise bad_request("Dates must be YYYY-MM-DD") from e
    if start > end:
        raise bad_request("'from' must be on or before 'to'")
    if (end - start).days >= max_days:
        raise bad_request(f"Choose a range of at most {max_days} days")
    return start, end


def _local(col):
    return sa.func.timezone(settings.timezone, col)


def _bucket(col, group: str, is_date: bool = False):
    expr = col if is_date else _local(col)
    return sa.cast(sa.func.date_trunc(group, expr), sa.Date)


def _buckets(start: date, end: date, group: str) -> list[date]:
    if group == "day":
        first = start
    elif group == "week":
        first = start - timedelta(days=start.weekday())
    else:
        first = start.replace(day=1)
    out, d = [], first
    while d <= end:
        out.append(d)
        if group == "day":
            d += timedelta(days=1)
        elif group == "week":
            d += timedelta(days=7)
        else:
            d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return out


async def _grouped(ctx, stmt) -> dict:
    return {k: v for k, v in (await ctx.conn.execute(stmt)).all()}


# ====================================================================== analytics

async def analytics(ctx, start: date, end: date, group: str) -> dict:
    s, e = metrics._rng(start, end)
    days = (end - start).days + 1
    ps, pe = start - timedelta(days=days), start - timedelta(days=1)
    a, en, inv, pay, o, ch, sv = appointments, encounters, invoices, payments, orders, charges, services
    dept = records.alias("dept")

    op_live = [a.c.deleted_at.is_(None), a.c.status != "Cancelled"]
    op_b = _bucket(a.c.appt_date, group, is_date=True)
    op = await _grouped(ctx, sa.select(op_b, sa.func.count()).where(*op_live, a.c.appt_date >= start, a.c.appt_date <= end).group_by(op_b))
    seen = await _grouped(ctx, sa.select(op_b, sa.func.count()).where(*op_live, a.c.appt_date >= start, a.c.appt_date <= end,
                                                                     a.c.status.in_(["Completed", "In Consultation"])).group_by(op_b))
    en_b = _bucket(en.c.started_at, group)
    ip = await _grouped(ctx, sa.select(en_b, sa.func.count()).where(en.c.type == "IPD", en.c.started_at >= s, en.c.started_at < e,
                                                                    en.c.deleted_at.is_(None), en.c.status != "Cancelled").group_by(en_b))
    er = await _grouped(ctx, sa.select(en_b, sa.func.count()).where(en.c.type == "ER", en.c.started_at >= s, en.c.started_at < e,
                                                                    en.c.deleted_at.is_(None)).group_by(en_b))
    inv_live = [inv.c.status != "Cancelled", inv.c.deleted_at.is_(None)]
    inv_b = _bucket(inv.c.billed_at, group)
    rev = await _grouped(ctx, sa.select(inv_b, sa.func.sum(inv.c.net)).where(*inv_live, inv.c.billed_at >= s, inv.c.billed_at < e).group_by(inv_b))
    pharm_inv = await _grouped(ctx, sa.select(inv_b, sa.func.sum(inv.c.net)).where(*inv_live, inv.c.type == "PHARMACY",
                                                                                   inv.c.billed_at >= s, inv.c.billed_at < e).group_by(inv_b))
    pay_b = _bucket(pay.c.paid_at, group)
    pay_live = [pay.c.status == "Success", pay.c.deleted_at.is_(None)]
    coll = await _grouped(ctx, sa.select(pay_b, sa.func.sum(pay.c.amount)).where(*pay_live, pay.c.kind.in_(["PAYMENT", "DEPOSIT"]),
                                                                                 pay.c.paid_at >= s, pay.c.paid_at < e).group_by(pay_b))
    refunds = await _grouped(ctx, sa.select(pay_b, sa.func.sum(pay.c.amount)).where(*pay_live, pay.c.kind == "REFUND",
                                                                                    pay.c.paid_at >= s, pay.c.paid_at < e).group_by(pay_b))
    # pharmacy dispensing (records) — counter sales without a pharmacy bill still count as sales
    disp = defaultdict(float)
    dent = get_entity("pharmacy.dispenses")
    if dent:
        dt = records.c.data["dispensed_at"].astext
        rows = (await ctx.conn.execute(sa.select(dt, records.c.data["total"].astext).where(
            *rs.base_where(dent), dt >= start.isoformat(), dt < (end + timedelta(days=1)).isoformat()))).all()
        for when, total in rows:
            d = parse_dt(when)
            if d:
                b = _buckets(d.astimezone(settings.tz).date(), d.astimezone(settings.tz).date(), group)[0]
                disp[b] += _f(total)
    o_b = _bucket(o.c.ordered_at, group)
    done = sa.func.coalesce(o.c.verified_at, o.c.resulted_at)
    tat = sa.extract("epoch", done - o.c.ordered_at) / 60
    lab = {k: (n, t) for k, n, t in (await ctx.conn.execute(sa.select(o_b, sa.func.count(), sa.func.avg(tat).filter(done.isnot(None))).where(
        o.c.category == "LAB", o.c.ordered_at >= s, o.c.ordered_at < e, o.c.deleted_at.is_(None), o.c.status != "Cancelled").group_by(o_b))).all()}
    rad = {k: (n, t) for k, n, t in (await ctx.conn.execute(sa.select(o_b, sa.func.count(), sa.func.avg(tat).filter(done.isnot(None))).where(
        o.c.category == "RAD", o.c.ordered_at >= s, o.c.ordered_at < e, o.c.deleted_at.is_(None), o.c.status != "Cancelled").group_by(o_b))).all()}

    series = []
    for b in _buckets(start, end, group):
        series.append({
            "period": b.isoformat(), "op": int(op.get(b) or 0), "op_seen": int(seen.get(b) or 0), "ip": int(ip.get(b) or 0),
            "er": int(er.get(b) or 0), "revenue": _f(rev.get(b)), "collections": _f(coll.get(b)), "refunds": _f(refunds.get(b)),
            "pharmacy": _f(pharm_inv.get(b)) + disp.get(b, 0.0), "lab_orders": int((lab.get(b) or (0, None))[0]),
            "lab_tat": round(_f((lab.get(b) or (0, None))[1]), 0) if (lab.get(b) or (0, None))[1] is not None else None,
            "rad_orders": int((rad.get(b) or (0, None))[0]),
            "rad_tat": round(_f((rad.get(b) or (0, None))[1]), 0) if (rad.get(b) or (0, None))[1] is not None else None,
        })

    # revenue (accrual, charges) by department and service category
    ch_live = [ch.c.status != "Cancelled", ch.c.deleted_at.is_(None), ch.c.charged_at >= s, ch.c.charged_at < e]
    dept_id = sa.func.coalesce(sv.c.department_id, en.c.department_id)
    j = ch.outerjoin(sv, sv.c.id == ch.c.service_id).outerjoin(en, en.c.id == ch.c.encounter_id)
    by_dept_rows = (await ctx.conn.execute(
        sa.select(dept.c.title, sa.func.sum(ch.c.amount), sa.func.count())
        .select_from(j.outerjoin(dept, dept.c.id == dept_id)).where(*ch_live).group_by(dept.c.title)
        .order_by(sa.func.sum(ch.c.amount).desc()))).all()
    by_dept = [{"name": t or "Unassigned", "revenue": _f(v), "lines": n} for t, v, n in by_dept_rows]
    if len(by_dept) > 12:
        rest = by_dept[11:]
        by_dept = by_dept[:11] + [{"name": f"Other ({len(rest)})", "revenue": sum(x["revenue"] for x in rest), "lines": sum(x["lines"] for x in rest)}]
    cat_expr = sa.func.coalesce(sv.c.category, sa.case((ch.c.source.like("ipd.daily%"), "ROOM"), else_="OTHER"))
    by_cat_rows = (await ctx.conn.execute(sa.select(cat_expr, sa.func.sum(ch.c.amount), sa.func.count()).select_from(j)
                                          .where(*ch_live).group_by(cat_expr).order_by(sa.func.sum(ch.c.amount).desc()))).all()
    by_category = [{"name": CATEGORY_LABELS.get(c, c.title()), "code": c, "revenue": _f(v), "lines": n} for c, v, n in by_cat_rows]

    # sponsor (payer) and patient category from bills
    p = patients
    sponsor = sa.case((sa.and_(inv.c.payer.isnot(None), inv.c.payer != "Self"), inv.c.payer),
                      else_=sa.func.coalesce(p.c.data["payer_type"].astext, "Cash"))
    by_sp = (await ctx.conn.execute(sa.select(sponsor, sa.func.sum(inv.c.net), sa.func.count()).select_from(inv.outerjoin(p, p.c.id == inv.c.patient_id))
                                    .where(*inv_live, inv.c.billed_at >= s, inv.c.billed_at < e).group_by(sa.text("1"))
                                    .order_by(sa.func.sum(inv.c.net).desc()))).all()
    by_sponsor = [{"name": "Self / Cash" if (k or "Cash") in ("Cash", "Self") else k, "revenue": _f(v), "bills": n} for k, v, n in by_sp]
    pcat = sa.func.coalesce(p.c.data["category"].astext, "General")
    by_pc = (await ctx.conn.execute(sa.select(pcat, sa.func.sum(inv.c.net), sa.func.count()).select_from(inv.outerjoin(p, p.c.id == inv.c.patient_id))
                                    .where(*inv_live, inv.c.billed_at >= s, inv.c.billed_at < e).group_by(sa.text("1"))
                                    .order_by(sa.func.sum(inv.c.net).desc()))).all()
    by_patient_category = [{"name": k, "revenue": _f(v), "bills": n} for k, v, n in by_pc]

    # doctor-wise OP volume and revenue
    doc_rows = (await ctx.conn.execute(
        sa.select(a.c.doctor_id, employees.c.name, dept.c.title, sa.func.count(),
                  sa.func.count().filter(a.c.status.in_(["Completed", "In Consultation"])), sa.func.count().filter(a.c.status == "No-show"))
        .select_from(a.outerjoin(employees, employees.c.id == a.c.doctor_id).outerjoin(dept, dept.c.id == a.c.department_id))
        .where(*op_live, a.c.appt_date >= start, a.c.appt_date <= end)
        .group_by(a.c.doctor_id, employees.c.name, dept.c.title))).all()
    consult_rev = await _grouped(ctx, sa.select(a.c.doctor_id, sa.func.sum(ch.c.amount)).select_from(ch.join(a, a.c.id == ch.c.source_id))
                                 .where(*ch_live, ch.c.source == "appointments.appointments").group_by(a.c.doctor_id))
    ip_rev = await _grouped(ctx, sa.select(en.c.doctor_id, sa.func.sum(ch.c.amount)).select_from(ch.join(en, en.c.id == ch.c.encounter_id))
                            .where(*ch_live, en.c.type == "IPD").group_by(en.c.doctor_id))
    doctors = sorted([{"doctor_id": str(d) if d else None, "name": nm or "Unassigned", "department": dp, "booked": b, "seen": sn,
                       "no_show": ns, "op_revenue": _f(consult_rev.get(d)), "ip_revenue": _f(ip_rev.get(d))}
                      for d, nm, dp, b, sn, ns in doc_rows], key=lambda x: -x["seen"])

    # top admission diagnoses
    dx = en.c.data["diagnosis"].astext
    top_dx = (await ctx.conn.execute(sa.select(dx, sa.func.count()).where(
        en.c.type == "IPD", en.c.started_at >= s, en.c.started_at < e, en.c.deleted_at.is_(None), dx.isnot(None), dx != "")
        .group_by(sa.text("1")).order_by(sa.func.count().desc()).limit(10))).all()

    async def totals(d1: date, d2: date) -> dict:
        r = await metrics.revenue(ctx, d1, d2)
        opv = await metrics.op_visits(ctx, d1, d2)
        ipv = await metrics.admissions(ctx, d1, d2)
        return {"revenue": r["billed"], "collections": r["collected"], "bills": r["bills"], "op": opv["booked"] - opv["by_status"].get("Cancelled", 0),
                "op_seen": opv["seen"], "ip": ipv["admitted"], "er": ipv["er_visits"], "discharges": ipv["discharged"], "alos_days": ipv["alos_days"]}

    cur, prev = await totals(start, end), await totals(ps, pe)
    lab_all = await metrics.lab_tat(ctx, start, end, "LAB")
    rad_all = await metrics.lab_tat(ctx, start, end, "RAD")
    census = await metrics.bed_census(ctx)
    kpis = {**cur, "lab_tat_min": lab_all["avg_tat_min"], "rad_tat_min": rad_all["avg_tat_min"], "lab_orders": lab_all["orders"],
            "rad_orders": rad_all["orders"], "occupancy_pct": census["occupancy_pct"],
            "pharmacy": sum(x["pharmacy"] for x in series),
            "arpob": round(cur["revenue"] / max(1, census["occupied"]) / days, 0) if census["occupied"] else None}
    return {"range": {"from": start.isoformat(), "to": end.isoformat(), "group": group, "days": days,
                      "previous": {"from": ps.isoformat(), "to": pe.isoformat()}},
            "kpis": kpis, "previous": prev, "series": series, "by_department": by_dept, "by_category": by_category,
            "by_sponsor": by_sponsor, "by_patient_category": by_patient_category, "doctors": doctors[:40],
            "top_diagnoses": [{"diagnosis": d, "admissions": n} for d, n in top_dx]}


@router.get("/analytics")
async def analytics_api(ctx: CtxDep, group: str = "day", date_from: str | None = Query(None, alias="from"),
                        date_to: str | None = Query(None, alias="to")):
    rs.ensure_access(ctx, E("analytics.saved_reports"), "read")
    if group not in GROUPS:
        raise bad_request("group must be day, week or month")
    start, end = _range(date_from, date_to, 14)
    return await cached(f"insights:analytics:{start}:{end}:{group}", 120, lambda: analytics(ctx, start, end, group))


# ====================================================================== command layer

async def _until(ctx, col, amount, conds, d: date, until: time | None) -> float:
    s, e = metrics._rng(d, d)
    stmt = sa.select(sa.func.coalesce(sa.func.sum(amount), 0)).where(col >= s, col < e, *conds)
    if until is not None:
        stmt = stmt.where(sa.cast(_local(col), sa.Time) <= until)
    return _f((await ctx.conn.execute(stmt)).scalar_one())


async def _pharmacy_sales(ctx, d: date, until: time | None) -> float:
    inv = invoices
    total = await _until(ctx, inv.c.billed_at, inv.c.net, [inv.c.type == "PHARMACY", inv.c.status != "Cancelled", inv.c.deleted_at.is_(None)], d, until)
    dent = get_entity("pharmacy.dispenses")
    if dent:
        dt = records.c.data["dispensed_at"].astext
        rows = (await ctx.conn.execute(sa.select(dt, records.c.data["total"].astext, records.c.data["invoice"].astext).where(
            *rs.base_where(dent), records.c.status != "Cancelled", dt >= d.isoformat(), dt < (d + timedelta(days=1)).isoformat()))).all()
        for when, amt, billed in rows:
            w = parse_dt(when)
            if billed or not w or (until and w.astimezone(settings.tz).time() > until):
                continue  # dispenses already on a pharmacy bill are counted through the bill
            total += _f(amt)
    return total


def _delta(cur: float, prev: float) -> float | None:
    return round((cur - prev) / prev * 100, 1) if prev else None


async def occupancy_by_type(ctx) -> list[dict]:
    w = records
    wt = sa.func.coalesce(w.c.data["ward_type"].astext, beds.c.category, "Other")
    usable = beds.c.status.notin_(["Blocked", "Maintenance"])
    rows = (await ctx.conn.execute(
        sa.select(wt, sa.func.count().filter(usable), sa.func.count().filter(beds.c.status == "Occupied"))
        .select_from(beds.outerjoin(w, w.c.id == beds.c.ward_id)).where(beds.c.deleted_at.is_(None))
        .group_by(sa.text("1")))).all()
    out = [{"type": t, "total": n, "occupied": o, "pct": round(o / n * 100, 1) if n else 0.0} for t, n, o in rows]
    return sorted(out, key=lambda x: -x["total"])


async def live_numbers(ctx) -> dict:
    """Everything the command layer shows, also used to evaluate alert rules and to snapshot."""
    t_now = now()
    d, lw = today(), today() - timedelta(days=7)
    tod = t_now.timetz().replace(tzinfo=None)
    inv, pay, en = invoices, payments, encounters
    inv_c = [inv.c.status != "Cancelled", inv.c.deleted_at.is_(None)]
    pay_c = [pay.c.status == "Success", pay.c.deleted_at.is_(None), pay.c.kind.in_(["PAYMENT", "DEPOSIT"])]
    rev = await metrics.revenue(ctx, d, d)
    billed_lw = await _until(ctx, inv.c.billed_at, inv.c.net, inv_c, lw, tod)
    coll_lw = await _until(ctx, pay.c.paid_at, pay.c.amount, pay_c, lw, tod)
    op, op_lw = await metrics.op_visits(ctx, d, d), await metrics.op_visits(ctx, lw, lw)
    ip, ip_lw = await metrics.admissions(ctx, d, d), await metrics.admissions(ctx, lw, lw)
    census = await metrics.bed_census(ctx)
    by_type = await occupancy_by_type(ctx)
    cc = [x for x in by_type if x["type"] in CRITICAL_CARE]
    icu_total, icu_occ = sum(x["total"] for x in cc), sum(x["occupied"] for x in cc)
    er_rows = dict((await ctx.conn.execute(sa.select(en.c.status, sa.func.count()).where(
        en.c.type == "ER", en.c.deleted_at.is_(None), en.c.status.in_(["Waiting", "In Treatment", "Observation"])).group_by(en.c.status))).all())
    lab, rad = await metrics.lab_tat(ctx, d, d, "LAB"), await metrics.lab_tat(ctx, d, d, "RAD")
    ph, ph_lw = await _pharmacy_sales(ctx, d, None), await _pharmacy_sales(ctx, lw, tod)
    chk = [c for c in await find(ctx, "discharge.checklists", date_from=d.isoformat(), limit=500) if c.get("tat_minutes") is not None]
    cleaning = (await ctx.conn.execute(sa.select(beds.c.data["status_since"].astext).where(beds.c.status == "Cleaning", beds.c.deleted_at.is_(None)))).scalars().all()
    turn = [(t_now - parse_dt(x)).total_seconds() / 60 for x in cleaning if x]
    pharm_store = stock.c.store.ilike("%pharmacy%")
    item = records.alias("item")
    stockouts = (await ctx.conn.execute(
        sa.select(sa.func.count()).select_from(
            sa.select(item.c.id).select_from(item.outerjoin(stock, sa.and_(stock.c.item_id == item.c.id, pharm_store, stock.c.deleted_at.is_(None))))
            .where(item.c.module == "mdm", item.c.entity == "items", item.c.deleted_at.is_(None), item.c.status == "Active",
                   item.c.data["type"].astext == "Drug")
            .group_by(item.c.id).having(sa.func.coalesce(sa.func.sum(stock.c.qty), 0) <= 0).subquery()))).scalar_one()
    return {
        "as_of": t_now.isoformat(timespec="seconds"),
        "revenue": {"today": rev["billed"], "last_week_same_time": billed_lw, "delta_pct": _delta(rev["billed"], billed_lw),
                    "collected": rev["collected"], "collected_last_week": coll_lw, "collected_delta_pct": _delta(rev["collected"], coll_lw),
                    "bills": rev["bills"], "by_mode": rev["by_mode"]},
        "op": {"today": op["booked"], "seen": op["seen"], "waiting": op["waiting"], "no_show": op["no_show"],
               "last_week": op_lw["booked"], "delta_pct": _delta(op["booked"], op_lw["booked"]), "wait_min": await metrics.opd_wait(ctx, d)},
        "ip": {"census": ip["census"], "admitted_today": ip["admitted"], "discharged_today": ip["discharged"],
               "admitted_last_week": ip_lw["admitted"], "delta_pct": _delta(ip["admitted"], ip_lw["admitted"]),
               "discharge_pending": ip["discharge_pending"], "alos_days": ip["alos_days"],
               "discharge_tat_min": round(sum(float(c["tat_minutes"]) for c in chk) / len(chk)) if chk else None},
        "occupancy": {"pct": census["occupancy_pct"], "occupied": census["occupied"], "vacant": census["vacant"], "total": census["total"],
                      "cleaning": census["by_status"].get("Cleaning", 0), "icu_pct": round(icu_occ / icu_total * 100, 1) if icu_total else None,
                      "by_type": by_type, "bed_turnaround_min": round(sum(turn) / len(turn)) if turn else None},
        "er": {"now": sum(er_rows.values()), "waiting": er_rows.get("Waiting", 0), "in_treatment": er_rows.get("In Treatment", 0),
               "observation": er_rows.get("Observation", 0), "visits_today": ip["er_visits"],
               "door_to_doctor_min": await metrics.er_door_to_doctor(ctx, d, d)},
        "billing": {"unbilled": rev["unbilled"], "outstanding": rev["outstanding"], "pending_refunds": rev["pending_refunds"],
                    "refunds_today": rev["refunds"]},
        "pharmacy": {"sales_today": ph, "last_week_same_time": ph_lw, "delta_pct": _delta(ph, ph_lw), "stockouts": stockouts},
        "lab": {"orders_today": lab["orders"], "pending": lab["pending"], "tat_min": lab["avg_tat_min"], "critical_unack": lab["critical_unack"]},
        "radiology": {"orders_today": rad["orders"], "pending": rad["pending"], "tat_min": rad["avg_tat_min"]},
    }


def metric_value(snap: dict, metric: str, ward_title: str | None = None) -> float | None:
    if metric == "Occupancy %" and ward_title:
        return None  # resolved per ward by the caller
    return {
        "Occupancy %": snap["occupancy"]["pct"], "ICU occupancy %": snap["occupancy"]["icu_pct"], "ER waiting": snap["er"]["waiting"],
        "OP waiting time (min)": snap["op"]["wait_min"], "Lab TAT (min)": snap["lab"]["tat_min"], "Radiology TAT (min)": snap["radiology"]["tat_min"],
        "Unbilled amount": snap["billing"]["unbilled"], "Critical results unacknowledged": snap["lab"]["critical_unack"],
        "Discharges pending": snap["ip"]["discharge_pending"], "Discharge TAT (min)": snap["ip"]["discharge_tat_min"],
        "Revenue today": snap["revenue"]["today"], "Collections today": snap["revenue"]["collected"],
        "Pharmacy stock-outs": snap["pharmacy"]["stockouts"], "Bed turnaround (min)": snap["occupancy"]["bed_turnaround_min"],
    }.get(metric)


_CMP = {">": lambda a, b: a > b, ">=": lambda a, b: a >= b, "<": lambda a, b: a < b, "<=": lambda a, b: a <= b}


def _in_hours(window: str | None, t: time) -> bool:
    if window == "Day (08:00-20:00)":
        return time(8) <= t < time(20)
    if window == "Night (20:00-08:00)":
        return t >= time(20) or t < time(8)
    return True


async def evaluate_alerts(ctx, snap: dict) -> list[dict]:
    """Evaluate active alert rules against live numbers; raise at most one alert per rule per day."""
    if not get_entity("command.alert_rules"):
        return []
    t_now = now()
    d = today()
    rules = await find(ctx, "command.alert_rules", status="Active", limit=200)
    open_alerts = await find(ctx, "command.alerts", status=["Open", "Acknowledged"], limit=500)
    todays = {a.get("rule") for a in await find(ctx, "command.alerts", date_from=d.isoformat(), limit=500)}
    wards = {w["ward"]: w for w in await metrics.occupancy_by_ward(ctx)}
    raised = []
    for r in rules:
        ward_title = (r.get("_refs") or {}).get(r.get("ward")) if r.get("ward") else None
        val = metric_value(snap, r.get("metric"), ward_title)
        if r.get("metric") == "Occupancy %" and ward_title:
            w = wards.get(ward_title)
            val = round(w["occupied"] / w["total"] * 100, 1) if w and w["total"] else None
        cmp, thr = _CMP.get(r.get("comparator") or ">"), r.get("threshold")
        if val is None or cmp is None or thr is None or not _in_hours(r.get("active_hours"), t_now.time()):
            continue
        breach = cmp(float(val), float(thr))
        sustain = float(r.get("sustained_minutes") or 0)
        if not breach:
            if r.get("breach_since"):
                await update(ctx, "command.alert_rules", r["id"], {"breach_since": None})
            continue
        if sustain > 0:
            since = parse_dt(r["breach_since"]) if r.get("breach_since") else None
            if not since:
                await update(ctx, "command.alert_rules", r["id"], {"breach_since": t_now.isoformat(timespec="seconds")})
                continue
            if (t_now - since).total_seconds() / 60 < sustain:
                continue
        if r["id"] in todays:
            continue
        where = f" in {ward_title}" if ward_title else ""
        msg = f"{r.get('name')}: {r.get('metric')}{where} is {val:,.1f} ({r.get('comparator')} {float(thr):,.1f})"
        alert = await create(ctx, "command.alerts", {
            "rule": r["id"], "metric": r.get("metric"), "message": msg[:300], "severity": r.get("severity") or "Warning",
            "observed_value": float(val), "threshold": float(thr), "department": r.get("department"), "ward": r.get("ward"),
            "triggered_at": t_now.isoformat(timespec="seconds"), "notified_roles": r.get("notify_roles"), "channel": r.get("channel"),
            "status": "Open",
        })
        await update(ctx, "command.alert_rules", r["id"], {"last_triggered_at": t_now.isoformat(timespec="seconds")})
        live(ctx, "alerts", {"type": "command_alert", "message": msg, "severity": alert.get("severity"), "roles": r.get("notify_roles")})
        todays.add(r["id"])
        raised.append(alert)
    by_rule = {r["id"]: r for r in rules}
    for a in open_alerts:
        rule = by_rule.get(a.get("rule"))
        esc = (rule or {}).get("escalate_after_minutes")
        if a.get("status") != "Open" or a.get("escalated") or not esc:
            continue
        trig = parse_dt(a.get("triggered_at")) if a.get("triggered_at") else None
        if trig and (t_now - trig).total_seconds() / 60 >= float(esc):
            await update(ctx, "command.alerts", a["id"], {"escalated": True, "escalated_to": rule.get("escalate_to_roles")})
            live(ctx, "alerts", {"type": "command_alert", "message": f"Escalated: {a.get('message')}", "roles": rule.get("escalate_to_roles")})
    return raised


async def capture_snapshot(ctx, snap: dict, *, min_gap_minutes: int = 10) -> dict | None:
    """Persist the live numbers for trend history (the mobile app reads the latest one)."""
    if not get_entity("command.snapshots"):
        return None
    last = await find(ctx, "command.snapshots", limit=1, sort="-captured_at")
    if last and last[0].get("captured_at") and (now() - parse_dt(last[0]["captured_at"])).total_seconds() < min_gap_minutes * 60:
        return None
    return await create(ctx, "command.snapshots", {
        "captured_at": snap["as_of"], "revenue_today": snap["revenue"]["today"], "collections_today": snap["revenue"]["collected"],
        "unbilled_amount": snap["billing"]["unbilled"], "op_count": snap["op"]["today"], "ip_census": snap["ip"]["census"],
        "admissions_today": snap["ip"]["admitted_today"], "discharges_today": snap["ip"]["discharged_today"],
        "discharges_pending": snap["ip"]["discharge_pending"], "occupancy_percent": snap["occupancy"]["pct"],
        "icu_occupancy_percent": snap["occupancy"]["icu_pct"], "er_waiting": snap["er"]["waiting"],
        "avg_op_wait_minutes": snap["op"]["wait_min"], "pharmacy_sales_today": snap["pharmacy"]["sales_today"],
        "lab_tests_today": snap["lab"]["orders_today"], "lab_tat_minutes": snap["lab"]["tat_min"],
        "radiology_studies_today": snap["radiology"]["orders_today"], "radiology_tat_minutes": snap["radiology"]["tat_min"],
        "critical_results_pending": snap["lab"]["critical_unack"],
    })


@router.get("/command")
async def command_api(ctx: CtxDep):
    rs.ensure_access(ctx, E("command.alerts"), "read")
    snap = await cached(f"insights:command:{today()}", 20, lambda: live_numbers(ctx))
    new = await evaluate_alerts(ctx, snap)
    await capture_snapshot(ctx, snap)
    alerts = await find(ctx, "command.alerts", status=["Open", "Acknowledged"], limit=30, sort="-triggered_at")
    snap["alerts"] = [{k: a.get(k) for k in ("id", "code", "message", "severity", "metric", "observed_value", "threshold", "triggered_at",
                                             "status", "escalated")} for a in alerts]
    snap["new_alerts"] = len(new)
    return snap


async def cron_command(_arq_ctx) -> None:
    """Every 15 minutes: evaluate alert rules even when nobody has the Command Center open."""
    from ..db import system_ctx

    async with system_ctx() as ctx:
        snap = await live_numbers(ctx)
        await evaluate_alerts(ctx, snap)
        await capture_snapshot(ctx, snap, min_gap_minutes=5)


CRON = [(cron_command, {"minute": {0, 15, 30, 45}})]


# ====================================================================== finance console

STREAM_FILTERS = ("Overall", "OP", "IP", "Pharmacy", "Laboratory", "Radiology", "OT / procedures", "Packages", "Health checks",
                  "International patients")


def _stream_cond(stream: str):
    ch, sv, en, p = charges, services, encounters, patients
    return {
        "Overall": sa.true(),
        "OP": sa.or_(ch.c.encounter_id.is_(None), en.c.type.notin_(["IPD", "DAYCARE"])),
        "IP": en.c.type.in_(["IPD", "DAYCARE"]),
        "Pharmacy": sa.or_(sv.c.category == "PHARM", ch.c.source.like("pharmacy%")),
        "Laboratory": sv.c.category == "LAB",
        "Radiology": sv.c.category == "RAD",
        "OT / procedures": sv.c.category.in_(["OT", "PROC"]),
        "Packages": sv.c.category == "PACKAGE",
        "Health checks": sa.or_(sv.c.code.like("HC-%"), sv.c.title.ilike("%health check%")),
        "International patients": p.c.data["category"].astext == "International",
    }.get(stream, sa.true())


async def achieved(ctx, month: str, stream: str, department_id: str | None) -> float:
    y, m = (int(x) for x in month.split("-"))
    start = date(y, m, 1)
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    s, e = metrics._rng(start, end)
    ch, sv, en, p = charges, services, encounters, patients
    j = ch.outerjoin(sv, sv.c.id == ch.c.service_id).outerjoin(en, en.c.id == ch.c.encounter_id).outerjoin(p, p.c.id == ch.c.patient_id)
    conds = [ch.c.status != "Cancelled", ch.c.deleted_at.is_(None), ch.c.charged_at >= s, ch.c.charged_at < e, _stream_cond(stream)]
    if department_id:
        conds.append(sa.func.coalesce(sv.c.department_id, en.c.department_id) == department_id)
    return _f((await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(ch.c.amount), 0)).select_from(j).where(*conds))).scalar_one())


async def refresh_targets(ctx, month: str) -> list[dict]:
    out = []
    for t in await find(ctx, "finance.revenue_targets", period=month, limit=200):
        got = await achieved(ctx, month, t.get("revenue_stream") or "Overall", t.get("department"))
        target = float(t.get("target_amount") or 0)
        pct = round(got / target * 100, 1) if target else None
        if abs(float(t.get("achieved_amount") or 0) - got) >= 0.01 or t.get("achievement_percent") != pct:
            t = {**t, **await update(ctx, "finance.revenue_targets", t["id"], {"achieved_amount": round(got, 2), "achievement_percent": pct})}
        out.append({k: t.get(k) for k in ("id", "code", "period", "revenue_stream", "department", "target_amount", "achieved_amount",
                                          "achievement_percent", "status")} | {"department_name": (t.get("_refs") or {}).get(t.get("department"))})
    return out


async def finance(ctx, start: date, end: date) -> dict:
    s, e = metrics._rng(start, end)
    rev = await metrics.revenue(ctx, start, end)
    pay, inv, ch, en = payments, invoices, charges, encounters
    pay_live = [pay.c.status == "Success", pay.c.deleted_at.is_(None), pay.c.paid_at >= s, pay.c.paid_at < e]
    by_branch_mode = (await ctx.conn.execute(sa.select(pay.c.branch_id, pay.c.mode, pay.c.kind, sa.func.sum(pay.c.amount), sa.func.count())
                                             .where(*pay_live).group_by(pay.c.branch_id, pay.c.mode, pay.c.kind))).all()
    branches: dict[str, dict] = defaultdict(lambda: {"collected": 0.0, "refunds": 0.0, "by_mode": defaultdict(float), "receipts": 0})
    for br, mode, kind, amt, n in by_branch_mode:
        b = branches[br or settings.branch_id]
        if kind in ("PAYMENT", "DEPOSIT"):
            b["collected"] += _f(amt)
            b["by_mode"][mode or "OTHER"] += _f(amt)
            b["receipts"] += n
        elif kind == "REFUND":
            b["refunds"] += _f(amt)
    day = sa.func.date(_local(pay.c.paid_at))
    daily = (await ctx.conn.execute(sa.select(day, pay.c.mode, sa.func.sum(pay.c.amount)).where(
        *pay_live, pay.c.kind.in_(["PAYMENT", "DEPOSIT"])).group_by(day, pay.c.mode))).all()
    days: dict[date, dict] = {}
    for d, mode, amt in daily:
        days.setdefault(d, {"date": d.isoformat()})[mode or "OTHER"] = _f(amt)
    inv_live = [inv.c.status != "Cancelled", inv.c.deleted_at.is_(None), inv.c.billed_at >= s, inv.c.billed_at < e]
    by_type = (await ctx.conn.execute(sa.select(inv.c.type, sa.func.sum(inv.c.gross), sa.func.sum(inv.c.discount), sa.func.sum(inv.c.net),
                                                sa.func.count()).where(*inv_live).group_by(inv.c.type))).all()
    streams = [{"stream": t or "Other", "gross": _f(g), "discount": _f(dc), "net": _f(n), "bills": c} for t, g, dc, n, c in by_type]
    # IP accrual by department vs expenses by cost centre
    dept = records.alias("dept")
    ip_dept = (await ctx.conn.execute(sa.select(en.c.department_id, dept.c.title, sa.func.sum(ch.c.amount)).select_from(
        ch.join(en, en.c.id == ch.c.encounter_id).outerjoin(dept, dept.c.id == en.c.department_id)).where(
        ch.c.status != "Cancelled", ch.c.deleted_at.is_(None), ch.c.charged_at >= s, ch.c.charged_at < e, en.c.type.in_(["IPD", "DAYCARE"]))
        .group_by(en.c.department_id, dept.c.title))).all()
    expenses = await find(ctx, "finance.expenses", date_from=start.isoformat(), date_to=end.isoformat(), limit=500)
    booked = [x for x in expenses if x.get("status") in ("Approved", "Paid")]
    pending_exp = [x for x in expenses if x.get("status") == "Recorded"]
    by_head: dict[str, float] = defaultdict(float)
    by_cc: dict[str | None, float] = defaultdict(float)
    for x in booked:
        by_head[x.get("expense_head") or "Miscellaneous"] += _f(x.get("amount"))
        by_cc[x.get("department")] += _f(x.get("amount"))
    refs = {}
    for x in expenses:
        refs.update(x.get("_refs") or {})
    cc_rows: dict[str, dict] = {}
    for did, title, amt in ip_dept:
        key = str(did) if did else "-"
        cc_rows[key] = {"department": title or "Unassigned", "ip_revenue": _f(amt), "expenses": 0.0}
    for did, amt in by_cc.items():
        key = did or "-"
        cc_rows.setdefault(key, {"department": refs.get(did) or ("Hospital-wide" if not did else "—"), "ip_revenue": 0.0, "expenses": 0.0})
        cc_rows[key]["expenses"] += amt
    cost_centres = sorted(({**v, "margin": v["ip_revenue"] - v["expenses"]} for v in cc_rows.values()), key=lambda x: -x["ip_revenue"])
    ip_revenue_accrued = sum(_f(a) for _, _, a in ip_dept)
    total_exp = sum(by_head.values())
    revenue_net = sum(x["net"] for x in streams)
    refund_reqs = await find(ctx, "finance.refunds", status=["Requested", "Approved"], limit=500)
    pnl = {"revenue": streams, "revenue_total": revenue_net, "expenses": sorted(({"head": h, "amount": a} for h, a in by_head.items()),
                                                                               key=lambda x: -x["amount"]),
           "expenses_total": total_exp, "surplus": revenue_net - total_exp,
           "margin_pct": round((revenue_net - total_exp) / revenue_net * 100, 1) if revenue_net else None}
    return {
        "range": {"from": start.isoformat(), "to": end.isoformat()},
        "collections": {"total": rev["collected"], "refunds": rev["refunds"], "net": rev["net_collection"], "by_mode": rev["by_mode"],
                        "by_branch": [{"branch": k, "collected": v["collected"], "refunds": v["refunds"], "receipts": v["receipts"],
                                       "by_mode": dict(v["by_mode"])} for k, v in branches.items()],
                        "daily": [days[k] for k in sorted(days)]},
        "ip": {"billed": next((x["net"] for x in streams if x["stream"] == "IP"), 0.0), "accrued": ip_revenue_accrued,
               "expenses": total_exp, "cost_centres": cost_centres},
        "receivables": {"unbilled": rev["unbilled"], "outstanding": rev["outstanding"],
                        "pending_refunds": rev["pending_refunds"] + sum(_f(r.get("amount")) for r in refund_reqs),
                        "refund_requests": len(refund_reqs), "expenses_awaiting_approval": sum(_f(x.get("amount")) for x in pending_exp)},
        "pnl": pnl,
    }


@router.get("/finance")
async def finance_api(ctx: CtxDep, date_from: str | None = Query(None, alias="from"), date_to: str | None = Query(None, alias="to"),
                      month: str | None = None):
    rs.ensure_access(ctx, E("finance.expenses"), "read")
    start, end = _range(date_from, date_to, today().day, max_days=366)
    if not date_from and not date_to:
        start = today().replace(day=1)
    out = await cached(f"insights:finance:{start}:{end}", 60, lambda: finance(ctx, start, end))
    mon = month or end.strftime("%Y-%m")
    try:
        datetime.strptime(mon, "%Y-%m")
    except ValueError as e:
        raise bad_request("month must be YYYY-MM") from e
    out["targets"] = {"month": mon, "rows": await refresh_targets(ctx, mon)}
    return out


__all__ = ["router", "CRON", "analytics", "live_numbers", "evaluate_alerts", "capture_snapshot", "finance", "achieved"]
