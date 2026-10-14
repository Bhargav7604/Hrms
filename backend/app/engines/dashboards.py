"""Dashboards engine (modules 51 / 52): the role-aware Command Centre, the widget / metric library,
the dashboards catalogue (built-in + designed) and Dashboard Designer storage.

Visibility is strict and role-based (roles & permissions matrix): a metric, queue, chart or
dashboard is returned only when the role can read its source records; money only for
finance-facing roles; deep links only to pages / reports the role can open.

Periods: preset (today · yesterday · this_week · this_month · last_month · this_fy · …) or
from/to, compared with the previous period of equal length, the same dates last year, or nothing —
the exact comparison window is returned so screens can state it.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .. import reports as R
from ..config import settings
from ..core.permissions import page_level, user_perm_role
from ..core.rbac import check_access
from ..core.registry import get_entity, get_module
from ..core.security import CtxDep
from ..core.util import bad_request, forbidden, is_uuid, not_found, now, today
from ..redis import cached
from ..reports._sql import TZ, f, jnum, jts, minutes, pct, pctile, rec_live
from ..schema import (
    appointments,
    approvals,
    beds,
    charges,
    employees,
    encounters,
    invoices,
    orders,
    patients,
    payments,
    queue_tokens,
    records,
    services,
    stock,
    users,
)
from ._common import create, find, get, update
from .reports import execute, prefs, push_recent, toggle_pref

log = logging.getLogger("vlack.dashboards")
router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])

FINANCE_ROLES = R.FINANCE_ROLES
DASH = "analytics.dashboards"
METRIC_DEFS = "analytics.metric_definitions"
OP_SEEN = ("Checked-in", "In Consultation", "Completed")
PRESETS = {"today", "yesterday", "this_week", "last_7", "this_month", "last_month", "last_30", "this_quarter", "this_fy", "last_fy", "custom"}


# ====================================================================== access helpers

def can_read(ctx, *fqns: str) -> bool:
    if ctx.role == "admin":
        return True
    for fqn in fqns:
        ent = get_entity(fqn)
        if ent and check_access(ctx.user, ent.module, ent, "read").ok:
            return True
    return False


def can_page(ctx, module_id: str, page: str) -> bool:
    if ctx.role == "admin":
        return bool(get_module(module_id))
    return get_module(module_id) is not None and page_level(ctx.user, module_id, page) != "none"


def is_finance(ctx) -> bool:
    return ctx.role in FINANCE_ROLES


def report_link(ctx, code: str, **params: str) -> str | None:
    rep = R.get_report(code)
    if not rep or not R.can_view(ctx.user, rep):
        return None
    qs = "&".join(f"{k}={v}" for k, v in params.items() if v)
    return f"/reports/{code}" + (f"?{qs}" if qs else "")


def page_link(ctx, module_id: str, page: str) -> str | None:
    return f"/m/{module_id}/{page}" if can_page(ctx, module_id, page) else None


def entity_link(ctx, fqn: str) -> str | None:
    mid, key = fqn.split(".")
    return f"/m/{mid}/{key}" if can_read(ctx, fqn) else None


# ====================================================================== periods

@dataclass
class Window:
    preset: str
    start: date
    end: date
    compare: str
    cmp: tuple[date, date] | None

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def out(self) -> dict:
        def lbl(a: date, b: date) -> str:
            if a == b:
                return f"{a:%d %b %Y}"
            if a.year == b.year and a.month == b.month:
                return f"{a.day} – {b:%d %b %Y}"
            if a.year == b.year:
                return f"{a:%d %b} – {b:%d %b %Y}"
            return f"{a:%d %b %Y} – {b:%d %b %Y}"
        return {"range": {"preset": self.preset, "from": self.start.isoformat(), "to": self.end.isoformat(), "days": self.days,
                          "label": lbl(self.start, self.end)},
                "compare": {"mode": self.compare, "from": self.cmp[0].isoformat(), "to": self.cmp[1].isoformat(), "label": lbl(*self.cmp)}
                if self.cmp else None}


def window(preset: str | None, d_from: str | None, d_to: str | None, compare: str | None) -> Window:
    p = preset if preset in PRESETS else ("custom" if d_from or d_to else "this_month")
    a, b = R.resolve_period(p, d_from, d_to)
    if not a or not b:
        a, b = R.resolve_period("this_month")
    if a > b:
        raise bad_request("'From' must be on or before 'To'")
    if (b - a).days > 400:
        raise bad_request("Choose a range of at most 400 days")
    mode = compare if compare in ("previous", "last_year", "none") else "previous"
    return Window(p, a, b, mode, R.comparison_window(a, b, mode) if mode != "none" else None)


def bounds(a: date, b: date):
    from ..core.util import day_bounds

    return day_bounds(a)[0], day_bounds(b)[1]


def day_of(col):
    return sa.func.date(sa.func.timezone(TZ, col))


# ====================================================================== metric library

@dataclass
class Metric:
    key: str
    label: str
    fmt: str = "number"                       # number | money | percent | minutes | days
    good: str | None = "up"                   # which direction is good (None = neutral)
    access: tuple[str, ...] = ()
    finance: bool = False
    point: bool = False                       # point-in-time (no comparison)
    icon: str = "Activity"
    tone: str = "s1"
    group: str = "Operations"
    sub: str = ""
    link: tuple[str, ...] = ()                # ("report", code, params…) | ("page", module, page) | ("entity", fqn)
    # period metric = (agg expr, time column, is_date, extra conds, from clause)
    spec: Callable[[], tuple] | None = None
    fn: Callable[[Any, date, date], Awaitable[float | None]] | None = None


METRICS: dict[str, Metric] = {}


def metric(**kw) -> Metric:
    m = Metric(**kw)
    METRICS[m.key] = m
    return m


def _inv(*extra):
    inv = invoices
    return lambda: (sa.func.coalesce(sa.func.sum(inv.c.net), 0), inv.c.billed_at, False,
                    [inv.c.deleted_at.is_(None), inv.c.status.notin_(["Cancelled", "Draft"]), *[e() for e in extra]], inv)


def _count(table, col, *conds, is_date=False):
    return lambda: (sa.func.count(), col, is_date, [table.c.deleted_at.is_(None), *[c() for c in conds]], table)


def _rec_count(module, entity, date_key, *conds):
    r = records
    return lambda: (sa.func.count(), jts(r.c.data[date_key].astext), False, [*rec_live(module, entity), *[c() for c in conds]], r)


inv, pay, en, a, o = invoices, payments, encounters, appointments, orders

metric(key="revenue_total", label="Total revenue", fmt="money", finance=True, access=("billing.invoices",), icon="IndianRupee", tone="s3",
       group="Money", sub="OP + IP + pharmacy bills", link=("report", "REV-06"), spec=_inv())
metric(key="op_revenue", label="OP revenue", fmt="money", finance=True, access=("billing.invoices",), icon="ReceiptText", tone="s3",
       group="Money", link=("report", "FIN-01"), spec=_inv(lambda: inv.c.type == "OP"))
metric(key="ip_revenue", label="IP revenue", fmt="money", finance=True, access=("billing.invoices",), icon="BedDouble", tone="s1",
       group="Money", link=("report", "FIN-03"), spec=_inv(lambda: inv.c.type == "IP"))
metric(key="pharmacy_revenue", label="Pharmacy sales", fmt="money", finance=True, access=("billing.invoices",), icon="Pill", tone="s6",
       group="Money", link=("report", "PHM-02"), spec=_inv(lambda: inv.c.type == "PHARMACY"))
metric(key="collections_net", label="Collections", fmt="money", finance=True, access=("billing.payments",), icon="Wallet", tone="s3",
       group="Money", sub="Receipts, net of refunds", link=("report", "MIS-04"),
       spec=lambda: (sa.func.coalesce(sa.func.sum(sa.case((pay.c.kind == "REFUND", -pay.c.amount), else_=pay.c.amount)), 0), pay.c.paid_at, False,
                     [pay.c.deleted_at.is_(None), pay.c.status == "Success", pay.c.kind.in_(["PAYMENT", "DEPOSIT", "REFUND"])], pay))
metric(key="refunds", label="Refunds", fmt="money", good="down", finance=True, access=("billing.payments",), icon="Undo2", tone="s2",
       group="Money", link=("report", "FIN-07"),
       spec=lambda: (sa.func.coalesce(sa.func.sum(pay.c.amount), 0), pay.c.paid_at, False,
                     [pay.c.deleted_at.is_(None), pay.c.status == "Success", pay.c.kind == "REFUND"], pay))
metric(key="discounts", label="Discounts given", fmt="money", good="down", finance=True, access=("billing.invoices",), icon="BadgePercent",
       tone="s4", group="Money", link=("report", "FIN-08"),
       spec=lambda: (sa.func.coalesce(sa.func.sum(inv.c.discount), 0), inv.c.billed_at, False,
                     [inv.c.deleted_at.is_(None), inv.c.status != "Cancelled"], inv))
metric(key="op_visits", label="OP visits", access=("appointments.appointments",), icon="Stethoscope", tone="s1", group="Patients",
       link=("report", "OPD-01"), spec=_count(a, a.c.appt_date, lambda: a.c.status.in_(OP_SEEN), is_date=True))
metric(key="new_op_patients", label="New OP patients", access=("appointments.appointments",), icon="UserPlus", tone="s1", group="Patients",
       link=("report", "OPD-02"), spec=_count(a, a.c.appt_date, lambda: a.c.status.in_(OP_SEEN), lambda: a.c.type == "New", is_date=True))
metric(key="no_shows", label="OP no-shows", good="down", access=("appointments.appointments",), icon="CalendarX2", tone="s2", group="Patients",
       link=("report", "OPD-03"), spec=_count(a, a.c.appt_date, lambda: a.c.status == "No-show", is_date=True))
metric(key="registrations", label="New registrations", access=("registration.patients",), icon="IdCard", tone="s5", group="Patients",
       link=("report", "REG-UH"), spec=_count(patients, patients.c.created_at))
metric(key="admissions", label="Admissions", access=("ipd.admissions",), icon="LogIn", tone="s5", group="Beds & IP", link=("report", "IPD-01"),
       spec=_count(en, en.c.started_at, lambda: en.c.type == "IPD", lambda: en.c.status != "Cancelled"))
metric(key="discharges", label="Discharges", access=("ipd.admissions",), icon="LogOut", tone="s5", group="Beds & IP", link=("report", "IPD-02"),
       spec=_count(en, en.c.ended_at, lambda: en.c.type == "IPD", lambda: en.c.status == "Discharged"))
metric(key="er_visits", label="ER visits", access=("er.visits",), icon="Siren", tone="s2", group="Patients", link=("report", "ER-01"),
       spec=_count(en, en.c.started_at, lambda: en.c.type == "ER"))
metric(key="lab_tests", label="Lab tests", access=("lab.lab_orders", "orders.orders"), icon="FlaskConical", tone="s4", group="Diagnostics",
       link=("report", "LAB-01"), spec=_count(o, o.c.ordered_at, lambda: o.c.category == "LAB", lambda: o.c.status != "Cancelled"))
metric(key="rad_studies", label="Radiology studies", access=("radiology.rad_orders", "orders.orders"), icon="ScanLine", tone="s4",
       group="Diagnostics", link=("report", "RAD-01"),
       spec=_count(o, o.c.ordered_at, lambda: o.c.category == "RAD", lambda: o.c.status != "Cancelled"))
metric(key="surgeries", label="Surgeries done", access=("ot.bookings",), icon="Scissors", tone="s1", group="Beds & IP", link=("report", "OT-02"),
       spec=_rec_count("ot", "bookings", "scheduled_at", lambda: records.c.status.in_(["Surgery Completed", "Shifted Out"])))
metric(key="incidents", label="Incidents reported", good="down", access=("safety.incidents",), icon="ShieldAlert", tone="s2", group="Quality",
       link=("report", "NABH-03"), spec=_rec_count("safety", "incidents", "occurred_at"))


async def _alos(ctx, d1: date, d2: date) -> float | None:
    s, e = bounds(d1, d2)
    v = (await ctx.conn.execute(sa.select(sa.func.avg(sa.extract("epoch", en.c.ended_at - en.c.started_at) / 86400)).where(
        en.c.type == "IPD", en.c.status == "Discharged", en.c.ended_at >= s, en.c.ended_at < e))).scalar()
    return round(float(v), 1) if v is not None else None


async def _mortality(ctx, d1: date, d2: date) -> float | None:
    s, e = bounds(d1, d2)
    n, d = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.count().filter(en.c.data["discharge_type"].astext.in_(["Death", "Expired"])))
                                   .where(en.c.type == "IPD", en.c.status == "Discharged", en.c.ended_at >= s, en.c.ended_at < e))).one()
    return pct(d, n, 2) if n else None


def _tat_metric(kind: str) -> Callable[[Any, date, date], Awaitable[float | None]]:
    async def fn(ctx, d1: date, d2: date) -> float | None:
        st = await tat_stats(ctx, d1, d2)
        v = st.get(kind, {}).get("median")
        return round(v, 1) if v is not None else None
    return fn


metric(key="alos", label="Avg length of stay", fmt="days", good="down", access=("ipd.admissions",), icon="CalendarDays", tone="s4",
       group="Beds & IP", sub="This period's discharges", link=("report", "IPD-04"), fn=_alos)
metric(key="mortality_rate", label="Gross mortality", fmt="percent", good="down", access=("ipd.admissions",), icon="HeartCrack", tone="s2",
       group="Quality", link=("report", "MRD-02"), fn=_mortality)
metric(key="lab_tat", label="Lab TAT (median)", fmt="minutes", good="down", access=("lab.lab_orders", "orders.orders"), icon="Timer",
       tone="s4", group="Diagnostics", sub="Collection → release", link=("report", "LAB-02"), fn=_tat_metric("lab"))
metric(key="rad_tat", label="Radiology TAT (median)", fmt="minutes", good="down", access=("radiology.rad_orders", "orders.orders"),
       icon="Timer", tone="s4", group="Diagnostics", sub="Order → report", link=("report", "RAD-02"), fn=_tat_metric("rad"))
metric(key="op_wait", label="OP waiting (median)", fmt="minutes", good="down", access=("appointments.appointments",), icon="Clock",
       tone="s1", group="Patients", sub="Check-in → seen", link=("report", "OPD-04"), fn=_tat_metric("op_wait"))
metric(key="discharge_tat", label="Discharge TAT (median)", fmt="minutes", good="down", access=("ipd.admissions",), icon="TimerReset",
       tone="s5", group="Beds & IP", sub="Decision → bed free", link=("report", "IPD-05"), fn=_tat_metric("discharge"))
metric(key="er_d2d", label="ER door-to-doctor (median)", fmt="minutes", good="down", access=("er.visits",), icon="Siren", tone="s2",
       group="Patients", sub="Arrival → doctor", link=("report", "ER-02"), fn=_tat_metric("er_d2d"))


# ---- point-in-time metrics

async def _census(ctx, *_):
    return (await ctx.conn.execute(sa.select(sa.func.count()).where(
        en.c.type == "IPD", en.c.status.in_(["Admitted", "Discharge Initiated"]), en.c.deleted_at.is_(None)))).scalar_one()


async def _beds(ctx) -> tuple[int, int]:
    total, occ = (await ctx.conn.execute(sa.select(sa.func.count().filter(beds.c.status.notin_(["Blocked", "Maintenance"])),
                                                   sa.func.count().filter(beds.c.status == "Occupied")).where(beds.c.deleted_at.is_(None)))).one()
    return total, occ


async def _occupancy(ctx, *_):
    total, occ = await _beds(ctx)
    return pct(occ, total)


async def _sum_scalar(ctx, stmt) -> float:
    return f((await ctx.conn.execute(stmt)).scalar())


async def _outstanding(ctx, *_):
    return await _sum_scalar(ctx, sa.select(sa.func.sum(inv.c.balance)).where(inv.c.deleted_at.is_(None), inv.c.status.in_(["Final", "Partially Paid"])))


async def _unbilled(ctx, *_):
    return await _sum_scalar(ctx, sa.select(sa.func.sum(charges.c.amount)).where(charges.c.deleted_at.is_(None), charges.c.status == "Unbilled"))


async def _sponsor_outstanding(ctx, *_):
    from ..reports._sql import payer_expr

    pe = payer_expr()
    billed = await _sum_scalar(ctx, sa.select(sa.func.sum(inv.c.balance)).select_from(
        inv.outerjoin(en, en.c.id == inv.c.encounter_id).outerjoin(patients, patients.c.id == inv.c.patient_id)).where(
        inv.c.deleted_at.is_(None), inv.c.status.in_(["Final", "Partially Paid"]), pe != "Self / Cash"))
    r = records
    claims = await _sum_scalar(ctx, sa.select(sa.func.sum(jnum(r.c.data["claimed_amount"].astext))).where(
        *rec_live("insurance", "claims"), r.c.status.in_(["Submitted", "Query", "Approved"])))
    return billed + claims


async def _critical_unack(ctx, *_):
    return (await ctx.conn.execute(sa.select(sa.func.count()).where(o.c.critical.is_(True), o.c.acknowledged_at.is_(None),
                                                                    o.c.deleted_at.is_(None), o.c.status != "Cancelled"))).scalar_one()


async def _stock_value(ctx, *_):
    return await _sum_scalar(ctx, sa.select(sa.func.sum(stock.c.qty * sa.func.coalesce(stock.c.rate, 0))).where(stock.c.deleted_at.is_(None), stock.c.qty > 0))


async def _expiring(ctx, *_):
    return (await ctx.conn.execute(sa.select(sa.func.count()).where(stock.c.deleted_at.is_(None), stock.c.qty > 0, stock.c.expiry.isnot(None),
                                                                    stock.c.expiry <= today() + timedelta(days=30)))).scalar_one()


async def _approvals(ctx, *_):
    return (await ctx.conn.execute(sa.select(sa.func.count()).where(approvals.c.status == "Pending", approvals.c.deleted_at.is_(None)))).scalar_one()


async def _headcount(ctx, *_):
    return (await ctx.conn.execute(sa.select(sa.func.count()).where(employees.c.deleted_at.is_(None),
                                                                    employees.c.status.in_(["Active", "On Notice"])))).scalar_one()


async def _rec_status_count(ctx, module: str, entity: str, statuses: list[str]) -> int:
    r = records
    return (await ctx.conn.execute(sa.select(sa.func.count()).select_from(r).where(*rec_live(module, entity), r.c.status.in_(statuses)))).scalar_one()


async def _below_reorder(ctx, *_):
    from ..reports.supply import inv_reorder

    res = await inv_reorder(ctx, R.Params("all", None, None, None, {}))
    return len(res.rows)


metric(key="inpatients_now", label="In-patients now", point=True, access=("ipd.admissions",), icon="BedDouble", tone="s5", group="Beds & IP",
       link=("page", "ipd", "bed-board"), fn=_census)
metric(key="occupancy_pct", label="Bed occupancy", fmt="percent", point=True, access=("ipd.beds",), icon="Bed", tone="s5", group="Beds & IP",
       sub="Occupied ÷ operational beds", link=("report", "IPD-06"), fn=_occupancy)
metric(key="outstanding", label="Outstanding bills", fmt="money", good="down", point=True, finance=True, access=("billing.invoices",),
       icon="Hourglass", tone="s2", group="Money", link=("report", "FIN-10"), fn=_outstanding)
metric(key="unbilled", label="Unbilled charges", fmt="money", point=True, good=None, finance=True, access=("billing.charges",),
       icon="FileClock", tone="s4", group="Money", sub="IP running bills + open OP", link=("report", "MIS-07"), fn=_unbilled)
metric(key="sponsor_outstanding", label="Sponsor outstanding", fmt="money", good="down", point=True, finance=True,
       access=("billing.invoices",), icon="ShieldCheck", tone="s1", group="Money", sub="TPA / corporate / scheme, today",
       link=("report", "FIN-05"), fn=_sponsor_outstanding)
metric(key="critical_unack", label="Critical results unacknowledged", good="down", point=True, access=("orders.orders", "lab.lab_orders"),
       icon="AlertTriangle", tone="s2", group="Diagnostics", link=("page", "orders", "result-inbox"), fn=_critical_unack)
metric(key="stock_value", label="Stock value", fmt="money", point=True, good=None, access=("inventory.stock",), icon="Warehouse", tone="s6",
       group="Supply", link=("report", "INV-01"), fn=_stock_value)
metric(key="expiring_30", label="Batches expiring ≤ 30 days", good="down", point=True, access=("inventory.stock",), icon="CalendarClock",
       tone="s2", group="Supply", link=("report", "INV-03"), fn=_expiring)
metric(key="below_reorder", label="Items below re-order level", good="down", point=True, access=("inventory.stock",), icon="PackageX",
       tone="s2", group="Supply", link=("report", "INV-08"), fn=_below_reorder)
metric(key="pending_approvals", label="Approvals waiting", good="down", point=True, access=("workflow.approvals",), icon="BadgeCheck",
       tone="s4", group="Operations", link=("page", "workflow", "approvals-inbox"), fn=_approvals)
metric(key="headcount", label="Active staff", point=True, good=None, access=("employees.employees",), icon="UsersRound", tone="s1",
       group="People", link=("report", "HR-01"), fn=_headcount)
metric(key="open_pos", label="Open purchase orders", point=True, good=None, access=("procurement.purchase_orders",), icon="FileStack",
       tone="s1", group="Supply", link=("report", "PRC-01"),
       fn=lambda ctx, *_: _rec_status_count(ctx, "procurement", "purchase_orders", ["Approved", "Sent", "Partially Received"]))
metric(key="claims_pending", label="Claims pending", point=True, good="down", finance=True, access=("insurance.claims",), icon="FileCheck2",
       tone="s4", group="Money", link=("report", "INS-01"),
       fn=lambda ctx, *_: _rec_status_count(ctx, "insurance", "claims", ["Submitted", "Query", "Approved"]))
metric(key="preauth_pending", label="Pre-auths awaiting decision", point=True, good="down", access=("insurance.preauths",), icon="FileClock",
       tone="s4", group="Money", link=("report", "INS-02"),
       fn=lambda ctx, *_: _rec_status_count(ctx, "insurance", "preauths", ["Submitted", "Query", "Enhancement Requested"]))
metric(key="open_alerts", label="Open alerts", point=True, good="down", access=("command.alerts",), icon="BellRing", tone="s2",
       group="Operations", link=("entity", "command.alerts"),
       fn=lambda ctx, *_: _rec_status_count(ctx, "command", "alerts", ["Open", "Acknowledged"]))


def metric_visible(ctx, m: Metric) -> bool:
    if m.finance and not is_finance(ctx):
        return False
    return not m.access or can_read(ctx, *m.access)


def metric_link(ctx, m: Metric) -> str | None:
    if not m.link:
        return None
    kind = m.link[0]
    if kind == "report":
        return report_link(ctx, m.link[1])
    if kind == "page":
        return page_link(ctx, m.link[1], m.link[2])
    if kind == "entity":
        return entity_link(ctx, m.link[1])
    return None


async def metric_value(ctx, m: Metric, d1: date, d2: date) -> float | None:
    if m.fn:
        v = await m.fn(ctx, d1, d2)
        return None if v is None else float(v)
    agg, col, is_date, conds, src = m.spec()
    rng = [col >= d1, col <= d2] if is_date else [col >= bounds(d1, d2)[0], col < bounds(d1, d2)[1]]
    return f((await ctx.conn.execute(sa.select(agg).select_from(src).where(*conds, *rng))).scalar())


async def metric_series(ctx, m: Metric, d1: date, d2: date) -> list[dict] | None:
    """Daily values d1..d2 (period metrics only)."""
    if not m.spec:
        return None
    agg, col, is_date, conds, src = m.spec()
    b = col if is_date else day_of(col)
    rng = [col >= d1, col <= d2] if is_date else [col >= bounds(d1, d2)[0], col < bounds(d1, d2)[1]]
    data = {k: v for k, v in (await ctx.conn.execute(sa.select(b, agg).select_from(src).where(*conds, *rng).group_by(b))).all()}
    out, d = [], d1
    while d <= d2:
        out.append({"date": d.isoformat(), "value": f(data.get(d))})
        d += timedelta(days=1)
    return out


def _delta(cur: float | None, prev: float | None) -> float | None:
    if cur is None or prev in (None, 0):
        return None
    return round((cur - prev) / abs(prev) * 100, 1)


def _verdict(m: Metric, d: float | None) -> str | None:
    if d is None or m.good is None:
        return None
    if abs(d) < 0.05:
        return "same"
    return "better" if (d > 0) == (m.good == "up") else "worse"


async def tile(ctx, m: Metric, w: Window, *, spark: bool = True, sub: str | None = None) -> dict:
    cur = await metric_value(ctx, m, w.start, w.end)
    prev = None
    if w.cmp and not m.point:
        prev = await metric_value(ctx, m, *w.cmp)
    d = _delta(cur, prev)
    out = {"key": m.key, "label": m.label, "value": cur, "format": m.fmt, "previous": prev, "delta_pct": d, "good": m.good,
           "verdict": _verdict(m, d), "point": m.point, "icon": m.icon, "tone": m.tone, "sub": sub or m.sub, "link": metric_link(ctx, m)}
    if spark and m.spec:
        s_from = w.start if w.days >= 3 else w.end - timedelta(days=6)
        ser = await metric_series(ctx, m, s_from, w.end)
        out["spark"] = [x["value"] for x in ser or []]
    return out


# ====================================================================== turnaround (TAT)

TAT_KEYS = {
    "lab": ("Lab TAT", "Collection → release", "TAT-LAB", ("lab.lab_orders", "orders.orders"), ("report", "LAB-02")),
    "rad": ("Radiology TAT", "Order → report", "TAT-RAD", ("radiology.rad_orders", "orders.orders"), ("report", "RAD-02")),
    "op_wait": ("OP waiting", "Check-in → seen", "TAT-OPWAIT", ("appointments.appointments",), ("report", "OPD-04")),
    "discharge": ("Discharge TAT", "Decision → bed free", "TAT-DISCHARGE", ("ipd.admissions",), ("report", "IPD-05")),
    "er_d2d": ("ER door-to-doctor", "Arrival → doctor", "TAT-ER-D2D", ("er.visits",), ("report", "ER-02")),
}
LAB_SLA_TARGET = "TAT-LAB-SLA"


async def tat_stats(ctx, d1: date, d2: date) -> dict:
    async def compute() -> dict:
        s, e = bounds(d1, d2)
        out: dict[str, dict] = {}

        async def one(key, expr, ok, base) -> None:
            tot, n, med, p90 = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.count().filter(ok), pctile(expr, 0.5).filter(ok),
                                                                 pctile(expr, 0.9).filter(ok)).where(*base))).one()
            out[key] = {"total": tot, "measured": n, "median": float(med) if med is not None else None,
                        "p90": float(p90) if p90 is not None else None}

        done = sa.func.coalesce(o.c.verified_at, o.c.resulted_at)
        await one("lab", minutes(o.c.collected_at, done), sa.and_(o.c.collected_at.isnot(None), done.isnot(None), done >= o.c.collected_at),
                  [o.c.category == "LAB", o.c.deleted_at.is_(None), o.c.status != "Cancelled", o.c.ordered_at >= s, o.c.ordered_at < e])
        await one("rad", minutes(o.c.ordered_at, done), done.isnot(None),
                  [o.c.category == "RAD", o.c.deleted_at.is_(None), o.c.status != "Cancelled", o.c.ordered_at >= s, o.c.ordered_at < e])
        chk, seen = jts(a.c.data["checked_in_at"].astext), jts(a.c.data["consult_started_at"].astext)
        await one("op_wait", minutes(chk, seen), sa.and_(chk.isnot(None), seen.isnot(None), seen >= chk),
                  [a.c.deleted_at.is_(None), a.c.status.in_(OP_SEEN), a.c.appt_date >= d1, a.c.appt_date <= d2])
        if not out["op_wait"]["measured"]:  # fall back to queue tokens (issued → called)
            qt = queue_tokens
            await one("op_wait_q", minutes(qt.c.created_at, qt.c.called_at), qt.c.called_at.isnot(None),
                      [qt.c.deleted_at.is_(None), qt.c.token_date >= d1, qt.c.token_date <= d2])
            if out["op_wait_q"]["measured"]:
                out["op_wait"] = {**out["op_wait_q"], "total": out["op_wait"]["total"] or out["op_wait_q"]["total"]}
            out.pop("op_wait_q")
        ini = jts(en.c.data["discharge_initiated_at"].astext)
        dtat = sa.func.coalesce(jnum(en.c.data["discharge_tat_minutes"].astext), minutes(ini, en.c.ended_at))
        await one("discharge", dtat, dtat.isnot(None), [en.c.type == "IPD", en.c.status == "Discharged", en.c.ended_at >= s, en.c.ended_at < e])
        ds = jts(en.c.data["doctor_seen_at"].astext)
        await one("er_d2d", minutes(en.c.started_at, ds), ds.isnot(None), [en.c.type == "ER", en.c.deleted_at.is_(None), en.c.started_at >= s,
                                                                           en.c.started_at < e])
        sv = services
        lab_ok = sa.and_(o.c.collected_at.isnot(None), done.isnot(None), sv.c.tat_minutes.isnot(None))
        n, within = (await ctx.conn.execute(sa.select(sa.func.count().filter(lab_ok),
                                                      sa.func.count().filter(lab_ok, minutes(o.c.collected_at, done) <= sv.c.tat_minutes))
                                            .select_from(o.outerjoin(sv, sv.c.id == o.c.service_id))
                                            .where(o.c.category == "LAB", o.c.deleted_at.is_(None), o.c.status != "Cancelled",
                                                   o.c.ordered_at >= s, o.c.ordered_at < e))).one()
        out["lab_sla"] = {"measured": n, "within": within, "pct": pct(within, n), "total": out["lab"]["total"]}
        return out

    return await cached(f"dash:tat:{d1}:{d2}", 60, compute)


async def tat_targets(ctx) -> dict[str, float | None]:
    codes = [v[2] for v in TAT_KEYS.values()] + [LAB_SLA_TARGET]
    r = records
    rows = (await ctx.conn.execute(sa.select(r.c.code, r.c.data["target"].astext).where(
        *rec_live("analytics", "metric_definitions"), r.c.status == "Active", r.c.code.in_(codes)))).all()
    return {c: (float(t) if t not in (None, "") else None) for c, t in rows}


async def tat_snapshot(ctx, w: Window) -> dict:
    st = await tat_stats(ctx, w.start, w.end)
    targets = await tat_targets(ctx)
    items = []
    for key, (label, sub, code, access, link) in TAT_KEYS.items():
        if not can_read(ctx, *access):
            continue
        x = st.get(key) or {}
        tgt = targets.get(code)
        med = x.get("median")
        items.append({"key": key, "label": label, "sub": sub, "median": med, "p90": x.get("p90"), "measured": x.get("measured", 0),
                      "total": x.get("total", 0), "coverage": pct(x.get("measured"), x.get("total")), "target": tgt, "target_code": code,
                      "on_target": None if tgt is None or med is None else med <= tgt, "link": report_link(ctx, link[1])})
    gauge = None
    if can_read(ctx, "lab.lab_orders", "orders.orders"):
        ls = st["lab_sla"]
        tgt = targets.get(LAB_SLA_TARGET)
        gauge = {"label": "Lab tests within their TAT target", "pct": ls["pct"], "measured": ls["measured"], "total": ls["total"],
                 "within": ls["within"], "target": tgt, "target_code": LAB_SLA_TARGET,
                 "on_target": None if tgt is None or ls["pct"] is None else ls["pct"] >= tgt, "link": report_link(ctx, "LAB-02")}
    return {"gauge": gauge, "items": items, "can_set_targets": ctx.role in ("admin", "management", "quality")}


class TargetIn(BaseModel):
    code: str = Field(pattern=r"^TAT-[A-Z0-9-]{2,20}$")
    target: float | None = Field(default=None, ge=0, le=100000)


@router.post("/targets")
async def set_target(body: TargetIn, ctx: CtxDep):
    if ctx.role not in ("admin", "management", "quality"):
        raise forbidden("Only management or quality can set turnaround targets")
    names = {v[2]: (v[0], v[1]) for v in TAT_KEYS.values()}
    names[LAB_SLA_TARGET] = ("Lab tests within their TAT target", "% of lab tests released within each test's SLA")
    if body.code not in names:
        raise bad_request("Unknown target")
    name, definition = names[body.code]
    r_ = records
    rid = (await ctx.conn.execute(sa.select(r_.c.id).where(*rec_live("analytics", "metric_definitions"), r_.c.code == body.code).limit(1))).scalar()
    rows = [{"id": str(rid)}] if rid else []
    unit = "%" if body.code == LAB_SLA_TARGET else "Minutes"
    data = {"name": name, "area": "Lab" if "LAB" in body.code or "RAD" in body.code else "Operations",
            "definition": f"{definition} — median for the period", "unit": unit, "target": body.target,
            "direction": "Higher is better" if body.code == LAB_SLA_TARGET else "Lower is better", "frequency": "Daily", "status": "Active"}
    if rows:
        rec = await update(ctx, METRIC_DEFS, rows[0]["id"], data)
    else:
        rec = await create(ctx, METRIC_DEFS, {**data, "code": body.code})
    from ..redis import invalidate

    ctx.on_commit(lambda: invalidate("dash:cc:"))
    return {"code": rec.get("code"), "target": rec.get("target")}


# ====================================================================== Command Centre

async def _scalar(ctx, stmt) -> int:
    return int((await ctx.conn.execute(stmt)).scalar() or 0)


async def attention(ctx) -> tuple[list[dict], list[dict]]:
    """Live work queues ("Needs attention") and the checks that are clear right now."""
    items: list[dict] = []
    t = now()
    if can_read(ctx, "workflow.approvals"):
        items.append({"key": "approvals", "label": "Approvals waiting", "sub": "Discounts, refunds, cancellations and purchase approvals",
                      "count": await _approvals(ctx), "tone": "amber", "icon": "BadgeCheck", "link": page_link(ctx, "workflow", "approvals-inbox")})
    if can_read(ctx, "billing.invoices"):
        items.append({"key": "op_drafts", "label": "OP bills pending finalisation", "sub": "Raised as drafts, never confirmed",
                      "count": await _scalar(ctx, sa.select(sa.func.count()).where(inv.c.deleted_at.is_(None), inv.c.status == "Draft")),
                      "tone": "blue", "icon": "FilePen", "link": report_link(ctx, "FIN-01", status="Draft", period="all") or entity_link(ctx, "billing.invoices")})
    if can_read(ctx, "ipd.admissions"):
        items.append({"key": "discharge_settlement", "label": "Discharges awaiting settlement", "sub": "Discharge initiated, bill not yet finalised",
                      "count": await _scalar(ctx, sa.select(sa.func.count()).where(en.c.type == "IPD", en.c.status == "Discharge Initiated",
                                                                                   en.c.deleted_at.is_(None))),
                      "tone": "blue", "icon": "LogOut", "link": page_link(ctx, "discharge", "discharge-board") or entity_link(ctx, "ipd.admissions")})
    if can_read(ctx, "orders.orders", "lab.lab_orders"):
        items.append({"key": "critical", "label": "Critical values unacknowledged", "sub": "Critical results not yet acknowledged by the team",
                      "count": await _critical_unack(ctx), "tone": "red", "icon": "AlertTriangle",
                      "link": page_link(ctx, "orders", "result-inbox") or report_link(ctx, "LAB-03", ack="Not acknowledged")})
    if can_read(ctx, "inventory.stock"):
        items.append({"key": "expiring", "label": "Stock expiring in 30 days", "sub": "Batches with stock on hand",
                      "count": await _expiring(ctx), "tone": "amber", "icon": "CalendarClock",
                      "link": report_link(ctx, "INV-03", view="Within 30 days")})
    if can_read(ctx, "ipd.admissions"):
        items.append({"key": "long_stay", "label": "Admissions open over 30 days", "sub": "Still admitted after 30 days — utilisation review",
                      "count": await _scalar(ctx, sa.select(sa.func.count()).where(en.c.type == "IPD", en.c.status.in_(["Admitted", "Discharge Initiated"]),
                                                                                   en.c.deleted_at.is_(None), en.c.started_at < t - timedelta(days=30))),
                      "tone": "amber", "icon": "Hourglass", "link": report_link(ctx, "IPD-07")})
    if can_read(ctx, "insurance.preauths"):
        items.append({"key": "preauth", "label": "Pre-auths awaiting the insurer", "sub": "Submitted, under query or enhancement",
                      "count": await _rec_status_count(ctx, "insurance", "preauths", ["Submitted", "Query", "Enhancement Requested"]),
                      "tone": "blue", "icon": "FileClock", "link": report_link(ctx, "INS-02")})
    if can_read(ctx, "command.alerts"):
        items.append({"key": "alerts", "label": "Open threshold alerts", "sub": "Raised by Command Centre alert rules",
                      "count": await _rec_status_count(ctx, "command", "alerts", ["Open", "Acknowledged"]), "tone": "red", "icon": "BellRing",
                      "link": entity_link(ctx, "command.alerts")})
    return [i for i in items if i["count"]], [i for i in items if not i["count"]]


async def wards(ctx) -> list[dict]:
    w = records.alias("w")
    blocked = beds.c.status.in_(["Blocked", "Maintenance"])
    rows = (await ctx.conn.execute(
        sa.select(sa.func.coalesce(w.c.title, "Unassigned"), sa.func.max(w.c.data["ward_type"].astext), sa.func.count(),
                  sa.func.count().filter(blocked), sa.func.count().filter(beds.c.status == "Occupied"))
        .select_from(beds.outerjoin(w, w.c.id == beds.c.ward_id)).where(beds.c.deleted_at.is_(None)).group_by(w.c.id, w.c.title))).all()
    out = []
    for name, wt, total, blk, occ in rows:
        op = total - blk
        p = round(occ / op * 100, 1) if op else 0.0
        out.append({"ward": name, "type": wt, "beds": total, "operational": op, "blocked": blk, "occupied": occ, "pct": p,
                    "band": "Full" if p >= 90 else "Busy" if p >= 75 else "Available"})
    return sorted(out, key=lambda x: (-x["pct"], x["ward"]))


async def trend(ctx, m: Metric, w: Window) -> dict:
    cur = await metric_series(ctx, m, w.start, w.end) or []
    cmp = await metric_series(ctx, m, *w.cmp) if w.cmp else None
    pts = []
    for i, c in enumerate(cur):
        p = (cmp or [])[i] if cmp and i < len(cmp) else None
        pts.append({"date": c["date"], "value": c["value"], "compare": p["value"] if p else None, "compare_date": p["date"] if p else None})
    return {"metric": m.key, "label": m.label, "format": m.fmt, "points": pts, "total": sum(x["value"] for x in cur),
            "compare_total": sum(x["value"] for x in cmp) if cmp else None, "link": metric_link(ctx, m)}


async def _report_rows(ctx, code: str, w: Window, **filters) -> dict | None:
    rep = R.get_report(code)
    if not rep or not R.can_view(ctx.user, rep):
        return None
    p, data = await execute(ctx, rep, {"from": w.start.isoformat(), "to": w.end.isoformat(), **filters})
    return {"rows": data["rows"], "summary": data["summary"], "link": report_link(ctx, code)}


def _top(rows: list[dict], name_key: str, val_key: str, n: int = 6) -> dict:
    rows = [r for r in rows if f(r.get(val_key))]
    tot = sum(f(r[val_key]) for r in rows)
    head = [{"name": r[name_key], "value": f(r[val_key]), "share": round(f(r[val_key]) / tot * 100, 1) if tot else 0} for r in rows[:n]]
    rest = rows[n:]
    others = {"value": sum(f(r[val_key]) for r in rest), "count": len(rest),
              "share": round(sum(f(r[val_key]) for r in rest) / tot * 100, 1) if tot else 0} if rest else None
    return {"rows": head, "others": others, "total": tot}


HEADLINE_FIN = ["revenue_total", "collections_net", "op_visits", "admissions", "inpatients_now", "alos"]
HEADLINE_CLIN = ["op_visits", "admissions", "inpatients_now", "alos", "er_visits", "lab_tests"]
OVERVIEW_FIN = ["op_revenue", "ip_revenue", "sponsor_outstanding", "new_op_patients", "discharges", "lab_tests"]
OVERVIEW_CLIN = ["new_op_patients", "discharges", "er_visits", "rad_studies", "surgeries", "critical_unack"]
MONEY = ["revenue_total", "collections_net", "refunds", "discounts", "outstanding", "unbilled"]
PATIENTS = ["op_visits", "new_op_patients", "no_shows", "registrations", "er_visits", "op_wait"]
BEDS = ["inpatients_now", "occupancy_pct", "admissions", "discharges", "alos", "discharge_tat"]
TATS = ["lab_tat", "rad_tat", "op_wait", "discharge_tat", "er_d2d", "critical_unack"]


async def _tiles(ctx, keys: list[str], w: Window, fallback: list[str] | None = None, n: int = 6) -> list[dict]:
    chosen = [k for k in keys if metric_visible(ctx, METRICS[k])]
    for k in fallback or []:
        if len(chosen) >= n:
            break
        if k not in chosen and metric_visible(ctx, METRICS[k]):
            chosen.append(k)
    return [await tile(ctx, METRICS[k], w) for k in chosen[:n]]


async def headline(ctx, w: Window) -> list[dict]:
    keys = HEADLINE_FIN if is_finance(ctx) else HEADLINE_CLIN
    tiles = await _tiles(ctx, keys, w, fallback=[*HEADLINE_CLIN, "rad_studies", "surgeries", "stock_value", "headcount", "pending_approvals",
                                                 "below_reorder", "open_pos", "expiring_30", "incidents"])
    for t in tiles:  # the reference sub-lines
        if t["key"] == "op_visits":
            new, rev = (await ctx.conn.execute(sa.select(sa.func.count().filter(a.c.type == "New"), sa.func.count().filter(a.c.type != "New")).where(
                a.c.deleted_at.is_(None), a.c.status.in_(OP_SEEN), a.c.appt_date >= w.start, a.c.appt_date <= w.end))).one()
            t["sub"] = f"{new:,} new · {rev:,} revisit"
        elif t["key"] == "admissions":
            dis = await metric_value(ctx, METRICS["discharges"], w.start, w.end)
            t["sub"] = f"{int(dis or 0):,} discharged"
        elif t["key"] == "inpatients_now":
            total, occ = await _beds(ctx)
            t["sub"] = f"{pct(t['value'], total) or 0:g}% of operational beds" if total else "No operational beds"
    return tiles


async def overview_tab(ctx, w: Window) -> dict:
    fin = is_finance(ctx)
    out: dict[str, Any] = {"tiles": await _tiles(ctx, OVERVIEW_FIN if fin else OVERVIEW_CLIN, w,
                                                 fallback=["op_visits", "admissions", "lab_tests", "rad_studies", "pending_approvals", "stock_value",
                                                           "headcount", "expiring_30", "below_reorder", "open_pos"])}
    tm = next((METRICS[k] for k in (["revenue_total"] if fin else []) + ["op_visits", "admissions", "lab_tests", "registrations"]
               if metric_visible(ctx, METRICS[k])), None)
    out["trend"] = await trend(ctx, tm, w) if tm else None
    need, clear = await attention(ctx)
    out["attention"], out["clear"] = need, clear
    if fin:
        st = await _report_rows(ctx, "REV-04", w)
        if st:
            out["streams"] = {"rows": [{"name": r["stream"], "value": f(r["amount"]), "share": r.get("share")} for r in st["rows"]],
                              "total": sum(f(r["amount"]) for r in st["rows"]), "link": st["link"]}
        dp = await _report_rows(ctx, "REV-01", w)
        if dp:
            out["departments"] = {**_top(dp["rows"], "department", "total"), "link": dp["link"]}
    if can_read(ctx, "ipd.beds"):
        out["wards"] = {"rows": await wards(ctx), "link": report_link(ctx, "IPD-06")}
    out["tat"] = await tat_snapshot(ctx, w)
    return out


def _chart_rows(res: dict | None, x: str, ys: list[str], n: int | None = None) -> list[dict] | None:
    if not res:
        return None
    rows = res["rows"][:n] if n else res["rows"]
    return [{x: r.get(x), **{y: f(r.get(y)) for y in ys}} for r in rows]


async def money_tab(ctx, w: Window) -> dict:
    if not is_finance(ctx):
        raise forbidden("Money figures are limited to finance-facing roles")
    out: dict[str, Any] = {"tiles": await _tiles(ctx, MONEY, w)}
    modes = await _report_rows(ctx, "MIS-04", w, view="Month" if w.days > 62 else "Day")
    if modes:
        tot: dict[str, float] = {}
        for r in modes["rows"]:
            for k in ("cash", "card", "upi", "bank", "wallet", "insurance"):
                tot[k] = tot.get(k, 0.0) + f(r.get(k))
        out["modes"] = {"rows": [{"name": k.upper() if k == "upi" else k.title(), "value": v} for k, v in sorted(tot.items(), key=lambda x: -x[1]) if v],
                        "link": modes["link"]}
    trend_ = await _report_rows(ctx, "REV-06", w, view="Month" if w.days > 62 else "Day")
    if trend_:
        out["by_type"] = {"rows": _chart_rows(trend_, "period", ["op", "ip", "pharmacy", "other", "collections"]), "link": trend_["link"]}
    payer = await _report_rows(ctx, "REV-05", w)
    if payer:
        out["payers"] = {"rows": [{"name": r["payer"], "value": f(r["net"]), "share": r.get("share"), "due": f(r.get("due"))} for r in payer["rows"]],
                         "link": payer["link"]}
    docs = await _report_rows(ctx, "REV-02", w)
    if docs:
        out["doctors"] = {**_top(docs["rows"], "doctor", "total", 8), "link": docs["link"]}
    age = await _report_rows(ctx, "FIN-05", w, period="all")
    if age:
        out["ageing"] = {"rows": [{"name": k, "value": sum(f(r.get(f_)) for r in age["rows"])} for k, f_ in
                                  (("0–30 days", "b0_30"), ("31–60 days", "b31_60"), ("61–90 days", "b61_90"), ("Over 90 days", "b90"))],
                         "link": age["link"]}
    return out


async def patients_tab(ctx, w: Window) -> dict:
    out: dict[str, Any] = {"tiles": await _tiles(ctx, PATIENTS, w)}
    if metric_visible(ctx, METRICS["op_visits"]):
        out["trend"] = await trend(ctx, METRICS["op_visits"], w)
    dep = await _report_rows(ctx, "OPD-02", w, view="By department")
    if dep:
        out["departments"] = {"rows": _chart_rows(dep, "group", ["new", "follow_up", "review"], 12), "link": dep["link"]}
        nt = sum(f(r["new"]) for r in dep["rows"])
        out["mix"] = {"rows": [{"name": "New", "value": nt}, {"name": "Follow-up", "value": sum(f(r["follow_up"]) for r in dep["rows"])},
                               {"name": "Review with reports", "value": sum(f(r["review"]) for r in dep["rows"])}]}
    docs = await _report_rows(ctx, "OPD-05", w)
    if docs:
        out["doctors"] = {**_top(docs["rows"], "doctor", "seen", 8), "link": docs["link"]}
    hourly = await _report_rows(ctx, "OPD-06", w)
    if hourly:
        out["hourly"] = {"rows": _chart_rows(hourly, "hour", ["total"]), "link": hourly["link"]}
    ns = await _report_rows(ctx, "OPD-03", w)
    if ns:
        out["no_shows"] = {"rows": [{"name": r["doctor"], "value": f(r["no_show"]) + f(r["cancelled"]), "booked": r["booked"]} for r in ns["rows"][:8]
                                    if f(r["no_show"]) + f(r["cancelled"])], "link": ns["link"]}
    return out


async def beds_tab(ctx, w: Window) -> dict:
    out: dict[str, Any] = {"tiles": await _tiles(ctx, BEDS, w)}
    if can_read(ctx, "ipd.beds"):
        out["wards"] = {"rows": await wards(ctx), "link": report_link(ctx, "IPD-06")}
    census = await _report_rows(ctx, "IPD-03", w)
    if census:
        out["census"] = {"rows": _chart_rows(census, "date", ["admissions", "discharges", "closing"]), "link": census["link"]}
    alos = await _report_rows(ctx, "IPD-04", w)
    if alos:
        out["alos"] = {"rows": _chart_rows(alos, "department", ["alos"], 12), "link": alos["link"]}
    if can_read(ctx, "ipd.admissions"):
        pend = (await ctx.conn.execute(
            sa.select(en.c.id, en.c.code, patients.c.title, en.c.data["discharge_initiated_at"].astext, en.c.started_at)
            .select_from(en.join(patients, patients.c.id == en.c.patient_id))
            .where(en.c.type == "IPD", en.c.status == "Discharge Initiated", en.c.deleted_at.is_(None))
            .order_by(en.c.data["discharge_initiated_at"].astext.asc().nulls_last()).limit(12))).all()
        out["pending_discharges"] = {"rows": [{"id": str(i), "ip_no": c, "patient": t, "initiated_at": ia, "admitted_at": s.isoformat() if s else None}
                                              for i, c, t, ia, s in pend],
                                     "link": page_link(ctx, "discharge", "discharge-board")}
        long_ = await _report_rows(ctx, "IPD-07", w, view="Over 15 days")
        if long_:
            out["long_stays"] = {"rows": [{k: r.get(k) for k in ("ip_no", "patient", "los_days", "ward", "consultant", "payer")} for r in long_["rows"][:10]],
                                 "count": len(long_["rows"]), "link": long_["link"]}
    return out


async def tat_tab(ctx, w: Window) -> dict:
    out: dict[str, Any] = {"tiles": await _tiles(ctx, TATS, w), "tat": await tat_snapshot(ctx, w)}
    lab = await _report_rows(ctx, "LAB-02", w)
    if lab:
        out["lab_breaches"] = {"rows": [{k: r.get(k) for k in ("test", "sla", "tests", "median", "p90", "breaches", "within_pct")}
                                        for r in lab["rows"][:10]], "link": lab["link"]}
    er = await _report_rows(ctx, "ER-02", w)
    if er:
        out["er_triage"] = {"rows": er["rows"], "link": er["link"]}
    back = await _report_rows(ctx, "LAB-04", w, period="all")
    if back:
        out["backlog"] = {"summary": back["summary"], "link": back["link"]}
    vol = await _report_rows(ctx, "LAB-01", w)
    if vol:
        out["lab_volumes"] = {"rows": _chart_rows(vol, "test", ["ordered"], 10), "link": vol["link"]}
    return out


async def alerts_tab(ctx, w: Window) -> dict:
    need, clear = await attention(ctx)
    out: dict[str, Any] = {"attention": need, "clear": clear}
    if can_read(ctx, "command.alerts"):
        rows = await find(ctx, "command.alerts", status=["Open", "Acknowledged"], limit=30, sort="-triggered_at")
        out["alerts"] = [{k: x.get(k) for k in ("id", "code", "message", "severity", "metric", "observed_value", "threshold", "triggered_at", "status",
                                                "escalated")} for x in rows]
        out["alerts_link"] = entity_link(ctx, "command.alerts")
    if can_read(ctx, "orders.orders", "lab.lab_orders"):
        crit = (await ctx.conn.execute(
            sa.select(o.c.id, o.c.code, patients.c.title, services.c.title, sa.func.coalesce(o.c.resulted_at, o.c.verified_at))
            .select_from(o.join(patients, patients.c.id == o.c.patient_id).outerjoin(services, services.c.id == o.c.service_id))
            .where(o.c.critical.is_(True), o.c.acknowledged_at.is_(None), o.c.deleted_at.is_(None), o.c.status != "Cancelled")
            .order_by(sa.func.coalesce(o.c.resulted_at, o.c.verified_at).desc().nulls_last()).limit(15))).all()
        out["critical"] = {"rows": [{"id": str(i), "order": c, "patient": p_, "test": t_, "resulted_at": r_.isoformat() if r_ else None}
                                    for i, c, p_, t_, r_ in crit], "link": page_link(ctx, "orders", "result-inbox")}
    return out


TABS: dict[str, Callable] = {"overview": overview_tab, "money": money_tab, "patients": patients_tab, "beds": beds_tab, "tat": tat_tab,
                             "alerts": alerts_tab}


def available_tabs(ctx) -> list[str]:
    out = ["overview"]
    if is_finance(ctx) and can_read(ctx, "billing.invoices"):
        out.append("money")
    if can_read(ctx, "appointments.appointments", "er.visits"):
        out.append("patients")
    if can_read(ctx, "ipd.admissions", "ipd.beds"):
        out.append("beds")
    if can_read(ctx, "orders.orders", "lab.lab_orders", "radiology.rad_orders", "ipd.admissions", "er.visits"):
        out.append("tat")
    if can_read(ctx, "workflow.approvals", "billing.invoices", "ipd.admissions", "orders.orders", "lab.lab_orders", "inventory.stock",
                "insurance.preauths", "command.alerts"):
        out.append("alerts")
    return out


@router.get("/command")
async def command_api(ctx: CtxDep, tab: str = "overview", preset: str | None = None, date_from: str | None = Query(None, alias="from"),
                      date_to: str | None = Query(None, alias="to"), compare: str | None = None, refresh: bool = False):
    w = window(preset, date_from, date_to, compare)
    tabs = available_tabs(ctx)
    if tab not in TABS:
        raise bad_request("Unknown tab")
    if tab not in tabs:
        raise forbidden("Your role cannot open this tab")
    key = f"dash:cc:{tab}:{user_perm_role(ctx.user)}:{getattr(ctx, 'branch', '')}:{w.start}:{w.end}:{w.compare}"

    async def compute() -> dict:
        body = {"tab": tab, "data": await TABS[tab](ctx, w), "headline": await headline(ctx, w)}
        need, _ = await attention(ctx) if tab != "alerts" else (body["data"]["attention"], None)
        body["alert_count"] = len(need)
        return body

    if refresh:  # manual refresh: recompute instead of serving the 45-second cache
        from ..redis import invalidate

        await invalidate(key)
        await invalidate(f"dash:tat:{w.start}:{w.end}")
    body = await cached(key, 45, compute)
    return {**w.out(), **body, "tabs": tabs, "finance": is_finance(ctx), "as_of": now().isoformat(timespec="seconds"),
            "hospital": settings.hospital_name, "branch": getattr(ctx, "branch", None) or settings.branch_id}


# ====================================================================== widgets (designer + dashboards)

WIDGET_TYPES = {"kpi", "line", "area", "bar", "donut", "table", "list"}


class Widget(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    type: str
    title: str = Field(default="", max_length=120)
    source: dict
    w: int = Field(default=4, ge=2, le=12)
    h: int = Field(default=2, ge=1, le=4)


def validate_widget(ctx, wd: dict) -> dict:
    try:
        w = Widget.model_validate(wd)
    except Exception as e:
        raise bad_request(f"Invalid widget: {e}") from e
    if w.type not in WIDGET_TYPES:
        raise bad_request(f"Unknown widget type {w.type}")
    src = w.source or {}
    if src.get("kind") == "metric":
        if src.get("key") not in METRICS:
            raise bad_request(f"Unknown metric {src.get('key')}")
    elif src.get("kind") == "report":
        rep = R.get_report(str(src.get("code") or ""))
        if not rep:
            raise bad_request(f"Unknown report {src.get('code')}")
        keys = {c.key for c in rep.columns}
        if src.get("x") and src["x"] not in keys:
            raise bad_request(f"{rep.code} has no column {src['x']}")
        src["y"] = [y for y in src.get("y") or [] if y in keys][:6]
        src["columns"] = [c for c in src.get("columns") or [] if c in keys][:12]
        src["filters"] = {str(k)[:40]: str(v)[:200] for k, v in (src.get("filters") or {}).items() if v not in (None, "")}
        src["limit"] = max(1, min(int(src.get("limit") or 10), 50))
    else:
        raise bad_request("A widget must be bound to a metric or a report")
    return {**w.model_dump(), "source": src}


async def widget_data(ctx, wd: dict, w: Window) -> dict:
    src = wd.get("source") or {}
    typ = wd.get("type")
    if src.get("kind") == "metric":
        m = METRICS.get(src.get("key") or "")
        if not m or not metric_visible(ctx, m):
            return {"denied": True}
        if typ == "kpi":
            return {"tile": await tile(ctx, m, w)}
        if not m.spec:
            return {"tile": await tile(ctx, m, w, spark=False)}
        return {"trend": await trend(ctx, m, w)}
    rep = R.get_report(str(src.get("code") or ""))
    if not rep or not R.can_view(ctx.user, rep):
        return {"denied": True}
    filters = {k: (ctx.user.get("employee_id") or "" if v == "$me" else v) for k, v in (src.get("filters") or {}).items()}
    q = {"from": w.start.isoformat(), "to": w.end.isoformat(), **filters}
    try:
        p, data = await execute(ctx, rep, q)
    except Exception as e:  # a widget must not break the dashboard
        from ..core.util import ApiError

        if isinstance(e, ApiError):
            return {"error": (e.detail or {}).get("message") if isinstance(e.detail, dict) else str(e.detail)}
        raise
    rows = data["rows"]
    cols = {c.key: c.public() for c in rep.columns}
    link = report_link(ctx, rep.code, **{k: v for k, v in filters.items()})
    if typ == "kpi":
        ycol = (src.get("y") or [None])[0]
        tiles = data["summary"] or []
        if ycol:
            val = sum(f(r.get(ycol)) for r in rows)
            return {"tile": {"key": rep.code, "label": wd.get("title") or cols[ycol]["label"], "value": val,
                             "format": "money" if cols[ycol]["type"] == "money" else "number", "link": link, "sub": rep.name}}
        t0 = tiles[1] if len(tiles) > 1 else (tiles[0] if tiles else {"label": "Rows", "value": len(rows), "format": "number"})
        return {"tile": {"key": rep.code, "label": wd.get("title") or t0["label"], "value": t0["value"], "format": t0.get("format", "number"),
                         "link": link, "sub": rep.name}}
    limit = int(src.get("limit") or 10)
    if typ in ("table", "list"):
        show = [cols[k] for k in (src.get("columns") or []) if k in cols] or [c for c in cols.values() if c["default"]][:6]
        return {"table": {"columns": show, "rows": [{c["key"]: r.get(c["key"]) for c in show} | {"_link": r.get("_link")} for r in rows[:limit]],
                          "total": len(rows)}, "link": link, "summary": data["summary"]}
    x = src.get("x") or (rep.chart or {}).get("x") or next(iter(cols))
    ys = src.get("y") or (rep.chart or {}).get("y") or [k for k, c in cols.items() if c["type"] in ("number", "money")][:1]
    chart_rows = rows if typ in ("line", "area") else rows[:limit]
    return {"chart": {"x": x, "y": [{"key": y, "label": cols[y]["label"], "type": cols[y]["type"]} for y in ys if y in cols],
                      "data": [{x: r.get(x), **{y: f(r.get(y)) for y in ys}} for r in chart_rows]}, "link": link}


class WidgetsIn(BaseModel):
    widgets: list[dict] = Field(default_factory=list, max_length=40)
    preset: str | None = None
    date_from: str | None = Field(default=None, alias="from")
    date_to: str | None = Field(default=None, alias="to")
    compare: str | None = None
    refresh: bool = False


@router.post("/widgets")
async def widgets_api(body: WidgetsIn, ctx: CtxDep):
    w = window(body.preset, body.date_from, body.date_to, body.compare)
    if body.refresh:
        from ..redis import invalidate

        await invalidate(f"dash:w:{user_perm_role(ctx.user)}:{getattr(ctx, 'branch', '')}:{w.start}:{w.end}:")
    out = {}
    for wd in body.widgets:
        try:
            v = validate_widget(ctx, dict(wd))
        except Exception as e:  # report each bad widget, keep the rest
            out[str(wd.get("id"))] = {"error": str(getattr(e, "detail", e))}
            continue
        key = f"dash:w:{user_perm_role(ctx.user)}:{getattr(ctx, 'branch', '')}:{w.start}:{w.end}:{w.compare}:{_hash(v)}"
        uses_me = "$me" in str(v.get("source"))
        out[v["id"]] = await widget_data(ctx, v, w) if uses_me else await cached(key, 60, lambda v=v: widget_data(ctx, v, w))
    return {**w.out(), "widgets": out, "as_of": now().isoformat(timespec="seconds")}


def _hash(v: dict) -> str:
    import hashlib

    import orjson

    return hashlib.sha1(orjson.dumps(v, option=orjson.OPT_SORT_KEYS)).hexdigest()[:16]


@router.get("/sources")
async def sources_api(ctx: CtxDep):
    """Designer palette: metrics and reports this role may bind widgets to."""
    R.load()
    ms = [{"key": m.key, "label": m.label, "format": m.fmt, "group": m.group, "point": m.point, "series": bool(m.spec), "icon": m.icon}
          for m in METRICS.values() if metric_visible(ctx, m)]
    reps = [{"code": r.code, "name": r.name, "category": r.category, "kind": r.kind, "chart": r.chart}
            for r in R.REPORTS.values() if R.can_view(ctx.user, r)]
    return {"metrics": ms, "reports": reps, "types": sorted(WIDGET_TYPES)}


# ====================================================================== catalogue (built-in + designed)

def K(key: str, **kw) -> dict:
    return {"id": key, "type": "kpi", "w": 2, "h": 1, "source": {"kind": "metric", "key": key}, **kw}


def Rw(id_: str, code: str, typ: str, title: str, w: int = 6, h: int = 2, **src) -> dict:
    return {"id": id_, "type": typ, "title": title, "w": w, "h": h, "source": {"kind": "report", "code": code, **src}}


def T(id_: str, key: str, title: str, typ: str = "area", w: int = 6, h: int = 2) -> dict:
    return {"id": id_, "type": typ, "title": title, "w": w, "h": h, "source": {"kind": "metric", "key": key}}


GROUPS = [
    ("executive", "Executive & Finance", "Money, beds and turnaround on one page — for the management team.", "Landmark"),
    ("clinical", "Clinical & Quality", "Doctors, records, NABH indicators and clinical outcomes.", "HeartPulse"),
    ("diagnostics", "Diagnostics", "Laboratory and radiology volumes and turnaround.", "FlaskConical"),
    ("patients", "Patients & Marketing", "Where patients come from, and whether they come back.", "Users"),
    ("operations", "Beds, ER & Theatres", "Bed management, emergency flow and operation theatre use.", "BedDouble"),
    ("supply", "Supply chain", "Stock, procurement, the pharmacy counter and the vendors behind them.", "Truck"),
    ("people", "People & Assets", "Staffing, payroll and equipment.", "UsersRound"),
    ("custom", "Custom", "Dashboards your team designed for itself.", "LayoutGrid"),
]


@dataclass
class Builtin:
    key: str
    name: str
    group: str
    description: str
    icon: str
    widgets: list[dict]
    access: tuple[str, ...] = ()
    finance: bool = False
    roles: tuple[str, ...] = ()
    new: bool = False
    default_preset: str = "this_month"


BUILTINS: list[Builtin] = [
    Builtin("management", "Management Dashboard", "executive", "The executive roll-up — money, beds, turnaround and quality on one page.",
            "Gauge", [K("revenue_total"), K("collections_net"), K("op_visits"), K("admissions"), K("inpatients_now"), K("alos"),
                      T("t1", "revenue_total", "Revenue trend vs comparison", "area", 8), Rw("w2", "REV-04", "donut", "Revenue by stream", 4),
                      Rw("w3", "IPD-06", "bar", "Occupancy by ward", 6, x="ward", y=["occupancy_pct"], limit=12),
                      Rw("w4", "NABH-01", "table", "Quality indicators", 6, columns=["indicator", "value", "unit", "benchmark", "status"], limit=15)],
            access=("billing.invoices",), finance=True),
    Builtin("revenue-360", "Revenue 360", "executive", "OP, IP and pharmacy income by stream, department, doctor and payer, vs the last period.",
            "IndianRupee", [K("revenue_total"), K("op_revenue"), K("ip_revenue"), K("pharmacy_revenue"), K("collections_net"), K("discounts"),
                            Rw("w1", "REV-06", "bar", "Revenue by type", 8, x="period", y=["op", "ip", "pharmacy"]),
                            Rw("w2", "REV-05", "donut", "By payer", 4, x="payer", y=["net"]),
                            Rw("w3", "REV-01", "bar", "Department-wise revenue", 6, x="department", y=["total"], limit=12),
                            Rw("w4", "REV-02", "table", "Top doctors", 6, columns=["doctor", "department", "op_revenue", "ip_revenue", "total"], limit=10)],
            access=("billing.charges",), finance=True, new=True),
    Builtin("collections", "Collections & Cash", "executive", "Receipts by mode and cashier, deposits, refunds and outstanding ageing.",
            "Banknote", [K("collections_net"), K("refunds"), K("outstanding"), K("sponsor_outstanding"), K("unbilled"), K("claims_pending"),
                         Rw("w1", "MIS-04", "bar", "Collection by mode", 8, x="period", y=["cash", "card", "upi", "insurance"]),
                         Rw("w2", "FIN-05", "bar", "Outstanding ageing by payer", 4, x="payer", y=["outstanding"]),
                         Rw("w3", "MIS-05", "table", "Collection by cashier", 12, columns=["user", "receipts", "cash", "card", "upi", "refunds", "net"])],
            access=("billing.payments",), finance=True, new=True),
    Builtin("insurance-tpa", "Insurance & TPA", "executive", "Pre-auths, claims ageing, settlements and disallowances per payer.",
            "ShieldCheck", [K("claims_pending"), K("preauth_pending"), K("sponsor_outstanding"),
                            Rw("w1", "INS-04", "bar", "Claimed vs settled by payer", 8, x="payer", y=["claimed", "settled"]),
                            Rw("w2", "INS-01", "donut", "Open claims by age", 4, x="bucket", y=["claimed"]),
                            Rw("w3", "INS-02", "table", "Pre-authorisations", 12, columns=["preauth", "payer", "patient", "requested", "approved", "status"])],
            access=("insurance.claims", "insurance.preauths"), finance=True),
    Builtin("my-clinic", "My Clinic", "clinical", "Your own day — who is waiting, who you have seen, and the rest of the week.",
            "Stethoscope", [Rw("k1", "OPD-01", "kpi", "Visits", 3, h=1, filters={"doctor": "$me"}),
                            Rw("w1", "OPD-01", "table", "My OP list", 12, h=3, filters={"doctor": "$me"},
                               columns=["appt_date", "slot", "token_no", "uhid", "patient", "type", "status"], limit=40),
                            Rw("w2", "OPD-02", "bar", "New vs revisit by day", 12, filters={"view": "By day"}, x="group", y=["new", "follow_up"])],
            access=("appointments.appointments",), roles=("doctor", "admin"), new=True, default_preset="today"),
    Builtin("quality-nabh", "Quality & NABH", "clinical", "NABH indicators — mortality, infections, returns to ICU, incidents — against target.",
            "Award", [K("mortality_rate"), K("incidents"), K("critical_unack"), K("lab_tat"),
                      Rw("w1", "NABH-01", "table", "Core quality indicators", 12, h=3,
                         columns=["chapter", "indicator", "numerator", "denominator", "value", "unit", "benchmark", "status"], limit=20),
                      Rw("w2", "NABH-03", "bar", "Incidents by type", 6, x="incident_type", y=["total"]),
                      Rw("w3", "NABH-05", "table", "Patient feedback", 6, columns=["department", "responses", "avg_rating", "nps", "grievances"])],
            access=("quality.indicators", "safety.incidents"), new=True),
    Builtin("doctor-performance", "Doctor Performance", "clinical", "Consultations, admissions, no-shows and revenue per doctor and department.",
            "UserRound", [K("op_visits"), K("new_op_patients"), K("no_shows"), K("admissions"),
                          Rw("w1", "OPD-05", "bar", "Patients seen per doctor", 6, x="doctor", y=["seen"], limit=15),
                          Rw("w2", "OPD-03", "bar", "No-shows & cancellations", 6, x="doctor", y=["no_show", "cancelled"], limit=12),
                          Rw("w3", "OPD-05", "table", "Doctor table", 12, columns=["doctor", "department", "booked", "seen", "new", "revisit", "per_day"], limit=30)],
            access=("appointments.appointments",), new=True),
    Builtin("clinical-mrd", "Clinical & MRD", "clinical", "Diagnoses, mortality, readmissions and medical-record completeness.",
            "FileHeart", [K("discharges"), K("alos"), K("mortality_rate"),
                          Rw("w1", "MRD-01", "bar", "Top diagnoses", 6, x="diagnosis", y=["cases"], limit=12),
                          Rw("w2", "MRD-02", "table", "Mortality by department", 6, columns=["department", "discharges", "deaths", "gross_rate"]),
                          Rw("w3", "MRD-03", "table", "Readmissions within 30 days", 12, columns=["uhid", "patient", "index_ip", "readmit_ip", "gap_days"], limit=15)],
            access=("ipd.admissions",), new=True),
    Builtin("mrd-reports", "MRD Reports", "clinical", "Case-file movement, coding progress and the statutory registers.",
            "FolderCheck", [Rw("w1", "MRD-04", "table", "Case-file completeness", 6, columns=["department", "files", "deficient", "complete_pct"]),
                            Rw("w2", "MRD-05", "table", "Coding progress", 6, columns=["coder", "pending", "query", "coded", "validated"]),
                            Rw("w3", "STAT-01", "kpi", "Admission register entries", 3, h=1), Rw("w4", "STAT-02", "kpi", "Discharge register entries", 3, h=1)],
            access=("mrd.case_files", "mrd.coding")),
    Builtin("lab-radiology", "Lab & Radiology", "diagnostics", "Test and study volumes, turnaround against target, critical values and backlog.",
            "FlaskConical", [K("lab_tests"), K("rad_studies"), K("lab_tat"), K("rad_tat"), K("critical_unack"),
                             T("t1", "lab_tests", "Lab tests per day", "bar", 6), Rw("w1", "LAB-01", "bar", "Top tests", 6, x="test", y=["ordered"], limit=12),
                             Rw("w2", "LAB-04", "table", "Backlog (oldest first)", 12, columns=["ordered_at", "category", "priority", "patient", "test", "age_min", "status"], limit=15)],
            access=("lab.lab_orders", "radiology.rad_orders", "orders.orders"), new=True),
    Builtin("lab-tat", "Lab TAT Detail", "diagnostics", "Per-test turnaround against each test's own SLA, with the breaches named.",
            "Timer", [K("lab_tat"), Rw("k1", "LAB-02", "kpi", "Breaches", 3, h=1, y=["breaches"]),
                      Rw("w1", "LAB-02", "bar", "Median vs p90 by test", 12, x="test", y=["median", "p90"], limit=15),
                      Rw("w2", "LAB-02", "table", "SLA compliance by test", 12, columns=["test", "sla", "tests", "median", "p90", "breaches", "within_pct"], limit=40)],
            access=("lab.lab_orders",)),
    Builtin("imaging", "Imaging Reports", "diagnostics", "Study volumes, modality load and reporting backlog.",
            "ScanLine", [K("rad_studies"), K("rad_tat"), Rw("w1", "RAD-01", "bar", "Studies", 6, x="test", y=["ordered"], limit=12),
                         Rw("w2", "RAD-02", "table", "Reporting TAT by study", 6, columns=["test", "tests", "median", "p90", "breaches"])],
            access=("radiology.rad_orders",)),
    Builtin("patients-crm", "Patients & CRM", "patients", "New vs returning patients, registrations, referral sources and camp conversion.",
            "Users", [K("registrations"), K("new_op_patients"), K("op_visits"), K("no_shows"),
                      T("t1", "registrations", "Registrations per day", "bar", 6),
                      Rw("w1", "OPD-02", "bar", "New vs revisit by department", 6, x="group", y=["new", "follow_up", "review"]),
                      Rw("w2", "IPD-08", "donut", "Admission sources", 6, x="source", y=["total"]),
                      Rw("w3", "PKG-02", "table", "Health check-ups", 6, columns=["package", "booked", "completed", "revenue"])],
            access=("registration.patients", "appointments.appointments"), new=True),
    Builtin("acquisition", "Acquisition Reports", "patients", "Where new patients came from — camps, referrers and campaigns.",
            "Megaphone", [Rw("w1", "REG-RF", "donut", "Referrals by status", 6), Rw("w2", "REG-CM", "table", "Camps", 6, limit=10)],
            access=("referrals.referrals", "camps.camps", "marketing.campaigns")),
    Builtin("bed-management", "Bed Management", "operations", "Census, occupancy by ward, admissions vs discharges and long stays.",
            "BedDouble", [K("inpatients_now"), K("occupancy_pct"), K("admissions"), K("discharges"), K("alos"), K("discharge_tat"),
                          Rw("w1", "IPD-03", "line", "Midnight census", 6, x="date", y=["closing"]),
                          Rw("w2", "IPD-06", "bar", "Occupancy by ward", 6, x="ward", y=["occupancy_pct"], limit=15),
                          Rw("w3", "IPD-07", "table", "Long stays", 12, columns=["ip_no", "patient", "los_days", "ward", "consultant", "payer"], limit=10)],
            access=("ipd.admissions", "ipd.beds")),
    Builtin("er-performance", "ER Performance", "operations", "ER volumes, triage mix, door-to-doctor time and disposition.",
            "Siren", [K("er_visits"), K("er_d2d"), T("t1", "er_visits", "ER visits per day", "bar", 6),
                      Rw("w1", "ER-03", "donut", "Disposition", 6, x="disposition", y=["visits"]),
                      Rw("w2", "ER-02", "table", "Door-to-doctor by triage", 12, columns=["triage", "visits", "median", "p90", "target", "within_pct"])],
            access=("er.visits",), new=True),
    Builtin("ot-utilisation", "OT Utilisation", "operations", "Theatre utilisation, cases, cancellations and first-case delays.",
            "Scissors", [K("surgeries"), Rw("w1", "OT-01", "bar", "Utilisation by theatre", 6, x="theatre", y=["utilisation_pct"]),
                         Rw("w2", "OT-03", "table", "Cancellations & delays", 6, columns=["date", "theatre", "procedure", "event", "reason"], limit=12),
                         Rw("w3", "OT-02", "table", "Today's list", 12, columns=["scheduled_at", "theatre", "patient", "procedure", "surgeon", "status"], limit=20)],
            access=("ot.bookings",)),
    Builtin("pharmacy-stores", "Pharmacy & Stores", "supply", "Counter sales, fast and slow movers, stock value and expiry exposure.",
            "Pill", [K("stock_value"), K("expiring_30"), K("below_reorder"),
                     Rw("w1", "INV-01", "donut", "Stock value by store", 4, x="store", y=["value"]),
                     Rw("w2", "INV-07", "donut", "Fast / slow / non-moving", 4), Rw("w3", "PHM-03", "bar", "Top drugs", 4, x="item", y=["value"], limit=10),
                     Rw("w4", "INV-03", "table", "Expiring soon", 12, columns=["item", "store", "batch", "expiry", "days_left", "value"], limit=15)],
            access=("inventory.stock", "pharmacy.dispenses"), new=True),
    Builtin("hospital-stores", "Hospital Dashboard", "supply", "This branch: stock cover, expiry exposure, indent flow and re-order needs.",
            "Building2", [K("stock_value"), K("expiring_30"), K("below_reorder"), K("open_pos"),
                          Rw("w1", "INV-08", "table", "Re-order now", 6, columns=["item", "on_hand", "reorder_level", "shortfall", "status"]),
                          Rw("w2", "PRC-04", "table", "Pending indents", 6, columns=["indent", "department", "priority", "age_days", "status"])],
            access=("inventory.stock",)),
    Builtin("vendor-scorecard", "Vendor Scorecard", "supply", "Fill rate, lead time and quality deviations per supplier.",
            "Medal", [K("open_pos"), Rw("w1", "PRC-02", "bar", "On-time % by vendor", 6, x="vendor", y=["on_time_pct"]),
                      Rw("w2", "PRC-02", "table", "Scorecard", 6, columns=["vendor", "pos", "po_value", "fill_rate", "on_time_pct", "avg_lead_days"]),
                      Rw("w3", "PRC-01", "donut", "PO value by status", 6, x="status", y=["total"])],
            access=("procurement.vendors", "procurement.purchase_orders")),
    Builtin("ai-recommendations", "AI Recommendations", "supply", "Suggestions the system has spotted — re-orders, expiries and AI insights to act on.",
            "Sparkles", [K("below_reorder"), K("expiring_30"), Rw("w1", "INV-08", "table", "Suggested re-orders", 6),
                         Rw("w2", "REG-AIN", "table", "AI insights", 6, limit=10)],
            access=("inventory.stock", "ai.insights")),
    Builtin("hr-payroll", "HR & Payroll", "people", "Headcount, attrition, attendance, payroll cost and licences due.",
            "UsersRound", [K("headcount"), Rw("w1", "HR-01", "bar", "Headcount by department", 6, x="department", y=["doctors", "nurses", "others"], limit=15),
                           Rw("w2", "HR-04", "donut", "Payroll cost by department", 6, x="department", y=["cost"]),
                           Rw("w3", "HR-05", "table", "Licences & credentials due", 12, columns=["employee", "credential", "valid_until", "days_left", "status"], limit=15)],
            access=("employees.employees",)),
    Builtin("assets", "Assets", "people", "Equipment register, breakdowns, preventive maintenance and contracts due.",
            "Wrench", [Rw("w1", "REG-AST", "donut", "Assets by status", 4), Rw("w2", "REG-ASB", "table", "Breakdowns", 8, limit=10),
                       Rw("w3", "REG-ASP", "table", "PM jobs", 6, limit=10), Rw("w4", "REG-ASC", "table", "Contracts", 6, limit=10)],
            access=("assets.assets",)),
]
BUILTIN_MAP = {b.key: b for b in BUILTINS}


def builtin_visible(ctx, b: Builtin) -> bool:
    if b.finance and not is_finance(ctx):
        return False
    if b.roles and ctx.role not in b.roles and ctx.role != "admin":
        return False
    return not b.access or can_read(ctx, *b.access)


def _custom_visible(ctx, d: dict) -> bool:
    if ctx.role == "admin" or d.get("owner_user") == ctx.user_id:
        return True
    if d.get("status") != "Published":
        return False
    return ctx.role in (d.get("visible_to_roles") or []) or (ctx.user.get("username") or "") in (d.get("shared_with_users") or [])


def _custom_out(ctx, d: dict) -> dict:
    return {"key": f"c-{d['id']}", "id": d["id"], "name": d.get("name"), "description": d.get("description") or "",
            "icon": d.get("icon") or "LayoutDashboard", "kind": "custom", "status": d.get("status"), "owner": d.get("owner_name"),
            "mine": d.get("owner_user") == ctx.user_id, "visible_to_roles": d.get("visible_to_roles") or [],
            "shared_with_users": d.get("shared_with_users") or [], "updated_at": d.get("updated_at")}


def _resolve_widget_refs(widgets: list[dict]) -> list[dict]:
    """Built-in widgets may name a register by entity prefix (REG-XXX); drop ones whose report does not exist."""
    out = []
    for wd in widgets:
        src = wd.get("source") or {}
        if src.get("kind") == "report" and not R.get_report(src.get("code") or ""):
            continue
        out.append(wd)
    return out


@router.get("")
async def catalogue_api(ctx: CtxDep):
    R.load()
    pr = await prefs(ctx) or {}
    fav = set(pr.get("favourite_dashboards") or [])
    groups = []
    for key, name, desc, icon in GROUPS:
        items = [{"key": b.key, "name": b.name, "description": b.description, "icon": b.icon, "new": b.new, "kind": "builtin",
                  "favourite": b.key in fav} for b in BUILTINS if b.group == key and builtin_visible(ctx, b)]
        if key == "custom":
            can_design = any(metric_visible(ctx, m) for m in METRICS.values()) or any(R.can_view(ctx.user, r) for r in R.REPORTS.values())
            items = [] if not can_design else [{"key": "mine", "name": "My Dashboards", "description": "Dashboards built in the designer — yours and the ones shared with you.",
                      "icon": "LayoutGrid", "kind": "link", "new": False, "favourite": False},
                     {"key": "designer", "name": "Dashboard Designer", "description": "Build a new dashboard from report widgets and share it with your team.",
                      "icon": "PencilRuler", "kind": "link", "new": False, "favourite": False}]
        if items:
            groups.append({"key": key, "name": name, "description": desc, "icon": icon, "dashboards": items})
    customs = [d for d in await find(ctx, DASH, status=["Draft", "Published"], limit=300, sort="-updated_at") if _custom_visible(ctx, d)]
    custom = [{**_custom_out(ctx, d), "favourite": f"c-{d['id']}" in fav} for d in customs]
    total = sum(len([x for x in g["dashboards"] if x["kind"] == "builtin"]) for g in groups) + len(custom)
    return {"groups": groups, "custom": custom, "favourites": [k for k in pr.get("favourite_dashboards") or []],
            "recent": pr.get("recent_dashboards") or [], "total": total}


async def _custom_or_404(ctx, did: str) -> dict:
    d = await get(ctx, DASH, did) if is_uuid(did) else None
    if not d or d.get("status") == "Retired":
        raise not_found("Dashboard not found")
    if not _custom_visible(ctx, d):
        raise forbidden("This dashboard has not been shared with you")
    return d


@router.get("/{key}")
async def dashboard_api(key: str, ctx: CtxDep):
    if key.startswith("c-"):
        d = await _custom_or_404(ctx, key[2:])
        await push_recent(ctx, "recent_dashboards", key)
        return {**_custom_out(ctx, d), "widgets": d.get("layout") or [], "default_preset": d.get("default_preset_key") or "this_month",
                "can_edit": d.get("owner_user") == ctx.user_id or ctx.role == "admin"}
    b = BUILTIN_MAP.get(key)
    if not b:
        raise not_found("Dashboard not found")
    if not builtin_visible(ctx, b):
        raise forbidden("Your role cannot open this dashboard")
    await push_recent(ctx, "recent_dashboards", key)
    pr = await prefs(ctx) or {}
    widgets = [wd for wd in _resolve_widget_refs(b.widgets)
               if (wd["source"]["kind"] == "metric" and metric_visible(ctx, METRICS[wd["source"]["key"]]))
               or (wd["source"]["kind"] == "report" and R.can_view(ctx.user, R.get_report(wd["source"]["code"])))]
    return {"key": b.key, "name": b.name, "description": b.description, "icon": b.icon, "kind": "builtin", "new": b.new,
            "widgets": widgets, "default_preset": b.default_preset, "favourite": b.key in (pr.get("favourite_dashboards") or []),
            "can_edit": False}


@router.post("/{key}/favourite")
async def favourite_api(key: str, ctx: CtxDep):
    if key.startswith("c-"):
        await _custom_or_404(ctx, key[2:])
    elif key not in BUILTIN_MAP or not builtin_visible(ctx, BUILTIN_MAP[key]):
        raise not_found("Dashboard not found")
    return {"favourite": await toggle_pref(ctx, "favourite_dashboards", key)}


# ---------------------------------------------------------------- designer storage

class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=300)
    icon: str | None = Field(default="LayoutDashboard", max_length=40)
    widgets: list[dict] = Field(default_factory=list, max_length=40)
    visible_to_roles: list[str] = Field(default_factory=list)
    shared_with_users: list[str] = Field(default_factory=list)
    publish: bool = False
    default_preset: str | None = None


CHART_NAME = {"kpi": "KPI tile", "line": "Line", "area": "Area", "bar": "Bar", "donut": "Pie", "table": "Table", "list": "Table"}


def _payload(ctx, body: DashboardIn) -> dict:
    from ..core.rbac import ROLES

    if not body.widgets:
        raise bad_request("Add at least one widget")
    widgets = [validate_widget(ctx, dict(w)) for w in body.widgets]
    ids = [w["id"] for w in widgets]
    if len(set(ids)) != len(ids):
        raise bad_request("Widget ids must be unique")
    for w in widgets:  # the designer can only bind data its role may see
        src = w["source"]
        if src["kind"] == "metric" and not metric_visible(ctx, METRICS[src["key"]]):
            raise forbidden(f"Your role cannot use the metric {METRICS[src['key']].label}")
        if src["kind"] == "report" and not R.can_view(ctx.user, R.get_report(src["code"])):
            raise forbidden(f"Your role cannot use report {src['code']}")
    roles = [r for r in body.visible_to_roles if r in ROLES]
    users_ = sorted({u.strip() for u in body.shared_with_users if re.match(r"^[a-zA-Z0-9_.@-]{2,60}$", u.strip())})
    return {"name": body.name.strip(), "description": (body.description or "").strip() or None, "icon": body.icon or "LayoutDashboard",
            "dashboard_type": "Custom", "visible_to_roles": roles, "shared_with_users": users_, "layout": widgets,
            "default_preset_key": body.default_preset if body.default_preset in PRESETS else "this_month",
            "widgets": [{"title": w.get("title") or (w["source"].get("key") or w["source"].get("code")), "metric": w["source"].get("key") or w["source"].get("code"),
                         "chart": CHART_NAME.get(w["type"], "Table"), "position": i + 1, "width": w["w"]} for i, w in enumerate(widgets)],
            "status": "Published" if body.publish else "Draft"}


@router.post("/custom", status_code=201)
async def create_dashboard(body: DashboardIn, ctx: CtxDep):
    data = _payload(ctx, body)
    rec = await create(ctx, DASH, {**data, "owner": ctx.user.get("employee_id"), "owner_user": ctx.user_id, "owner_name": ctx.user.get("name")})
    return {**_custom_out(ctx, rec), "widgets": rec.get("layout")}


@router.put("/custom/{did}")
async def update_dashboard(did: str, body: DashboardIn, ctx: CtxDep):
    d = await _custom_or_404(ctx, did)
    if d.get("owner_user") != ctx.user_id and ctx.role != "admin":
        raise forbidden("Only the owner can change this dashboard")
    rec = await update(ctx, DASH, d["id"], _payload(ctx, body))
    return {**_custom_out(ctx, rec), "widgets": rec.get("layout")}


@router.delete("/custom/{did}")
async def delete_dashboard(did: str, ctx: CtxDep):
    d = await _custom_or_404(ctx, did)
    if d.get("owner_user") != ctx.user_id and ctx.role != "admin":
        raise forbidden("Only the owner can delete this dashboard")
    await update(ctx, DASH, d["id"], {"status": "Retired"})
    return {"ok": True}


@router.get("/share/users")
async def share_users(ctx: CtxDep, q: str = ""):
    stmt = sa.select(users.c.username, users.c.name, users.c.role).where(users.c.active.is_(True)).order_by(users.c.name).limit(20)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(sa.or_(users.c.name.ilike(like), users.c.username.ilike(like)))
    return [{"username": u, "name": n, "role": r} for u, n, r in (await ctx.conn.execute(stmt)).all()]


__all__ = ["router", "METRICS", "BUILTINS", "tile", "window", "metric_value"]
