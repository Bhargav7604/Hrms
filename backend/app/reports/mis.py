"""MIS & reconciliation and revenue reports."""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

import sqlalchemy as sa

from ..core.util import is_uuid, today
from ..schema import (
    appointments,
    charges,
    employees,
    encounters,
    invoices,
    patients,
    payments,
    records,
    services,
    users,
)
from . import Col, F, Params, Result, buckets, category, comparison_window, report
from ._sql import (
    bucket,
    date_between,
    day,
    dept,
    f,
    jnum,
    jts,
    payer_expr,
    payer_filter,
    pct,
    rec_live,
    rows,
    share,
    stream_expr,
    ts_between,
)

MIS = category("MIS & Reconciliation", "Daily MIS for management — billed vs collected vs deposited, and the reconciliations.",
               "ClipboardList", 1)
REV = category("Revenue", "Where the money comes from — departments, doctors, services, streams and payers.", "IndianRupee", 3)
BILLS = ("billing.invoices", "billing.payments")
OP_SEEN = ("Checked-in", "In Consultation", "Completed")
CAT_LABEL = {
    "CONSULT": "Consultation", "LAB": "Laboratory", "RAD": "Radiology", "PROC": "Procedures", "ROOM": "Room & bed",
    "NURSING": "Nursing", "PHARM": "Pharmacy", "OT": "OT & anaesthesia", "ICU": "ICU care", "PACKAGE": "Packages",
    "DIALYSIS": "Dialysis", "PHYSIO": "Physiotherapy", "BLOOD": "Blood bank", "AMBULANCE": "Ambulance", "DIET": "Dietetics",
    "DENTAL": "Dental", "MISC": "Miscellaneous", "OTHER": "Other",
}


def _span(p: Params, default_days: int = 30):
    end = p.d_to or today()
    start = p.d_from or end - timedelta(days=default_days - 1)
    return start, end


def _live_inv():
    return [invoices.c.deleted_at.is_(None), invoices.c.status.notin_(["Cancelled", "Draft"])]


async def _grouped(ctx, stmt) -> dict:
    return {k: v for k, v in (await ctx.conn.execute(stmt)).all()}


async def flash(ctx, p: Params, view: str) -> list[dict]:
    """One row per day / month: volumes, revenue by stream and collections (shared by MIS-01/02)."""
    start, end = _span(p, 31 if view == "Day" else 365)
    from . import Params as P

    q = P(p.period, start, end, None, {})
    a, en, inv, pay = appointments, encounters, invoices, payments
    ab = bucket(a.c.appt_date, view, is_date=True)
    op = await _grouped(ctx, sa.select(ab, sa.func.count()).where(a.c.deleted_at.is_(None), a.c.status.in_(OP_SEEN),
                                                                   *date_between(a.c.appt_date, q)).group_by(ab))
    new = await _grouped(ctx, sa.select(ab, sa.func.count()).where(a.c.deleted_at.is_(None), a.c.status.in_(OP_SEEN),
                                                                    a.c.type == "New", *date_between(a.c.appt_date, q)).group_by(ab))
    pb = bucket(patients.c.created_at, view)
    regs = await _grouped(ctx, sa.select(pb, sa.func.count()).where(patients.c.deleted_at.is_(None),
                                                                     *ts_between(patients.c.created_at, q)).group_by(pb))
    sb, eb = bucket(en.c.started_at, view), bucket(en.c.ended_at, view)
    adm = await _grouped(ctx, sa.select(sb, sa.func.count()).where(en.c.type == "IPD", en.c.deleted_at.is_(None), en.c.status != "Cancelled",
                                                                    *ts_between(en.c.started_at, q)).group_by(sb))
    dis = await _grouped(ctx, sa.select(eb, sa.func.count()).where(en.c.type == "IPD", en.c.status == "Discharged",
                                                                    *ts_between(en.c.ended_at, q)).group_by(eb))
    er = await _grouped(ctx, sa.select(sb, sa.func.count()).where(en.c.type == "ER", en.c.deleted_at.is_(None),
                                                                   *ts_between(en.c.started_at, q)).group_by(sb))
    ib = bucket(inv.c.billed_at, view)
    rev: dict = defaultdict(dict)
    for b, typ, net in (await ctx.conn.execute(sa.select(ib, inv.c.type, sa.func.sum(inv.c.net)).where(
            *_live_inv(), *ts_between(inv.c.billed_at, q)).group_by(ib, inv.c.type))).all():
        rev[b][typ or "OTHER"] = f(net)
    yb = bucket(pay.c.paid_at, view)
    coll: dict = defaultdict(dict)
    for b, kind, amt in (await ctx.conn.execute(sa.select(yb, pay.c.kind, sa.func.sum(pay.c.amount)).where(
            pay.c.deleted_at.is_(None), pay.c.status == "Success", *ts_between(pay.c.paid_at, q)).group_by(yb, pay.c.kind))).all():
        coll[b][kind] = f(amt)
    r = records
    dt = jts(r.c.data["dispensed_at"].astext)
    db = bucket(dt, view)
    disp = await _grouped(ctx, sa.select(db, sa.func.sum(jnum(r.c.data["total"].astext))).where(
        *rec_live("pharmacy", "dispenses"), r.c.status != "Cancelled", r.c.data["invoice"].astext.is_(None),
        *ts_between(dt, q)).group_by(db))
    out = []
    for key, label in buckets(start, end, view):
        rv, cl = rev.get(key, {}), coll.get(key, {})
        pharm = rv.get("PHARMACY", 0.0) + f(disp.get(key))
        other = sum(v for k, v in rv.items() if k not in ("OP", "IP", "PHARMACY"))
        row = {"period": key if view == "Day" else label, "op_visits": int(op.get(key) or 0), "new_visits": int(new.get(key) or 0),
               "registrations": int(regs.get(key) or 0), "admissions": int(adm.get(key) or 0), "discharges": int(dis.get(key) or 0),
               "er_visits": int(er.get(key) or 0), "op_revenue": rv.get("OP", 0.0), "ip_revenue": rv.get("IP", 0.0),
               "pharmacy_revenue": pharm, "other_revenue": other}
        row["total_revenue"] = row["op_revenue"] + row["ip_revenue"] + pharm + other
        row["collections"] = cl.get("PAYMENT", 0.0) + cl.get("DEPOSIT", 0.0) - cl.get("REFUND", 0.0)
        out.append(row)
    return out


FLASH_COLS = [
    Col("op_visits", "OP visits", "number", total=True), Col("new_visits", "New OP", "number", total=True),
    Col("registrations", "Registrations", "number", total=True), Col("admissions", "Admissions", "number", total=True),
    Col("discharges", "Discharges", "number", total=True), Col("er_visits", "ER visits", "number", total=True),
    Col("op_revenue", "OP revenue", "money", total=True), Col("ip_revenue", "IP revenue", "money", total=True),
    Col("pharmacy_revenue", "Pharmacy", "money", total=True), Col("other_revenue", "Other", "money", False, total=True),
    Col("total_revenue", "Total revenue", "money", total=True), Col("collections", "Net collections", "money", total=True),
]


def _flash_summary(rs_: list[dict]) -> list[dict]:
    return [{"label": "OP visits", "value": sum(r["op_visits"] for r in rs_), "format": "number"},
            {"label": "Admissions", "value": sum(r["admissions"] for r in rs_), "format": "number"},
            {"label": "Discharges", "value": sum(r["discharges"] for r in rs_), "format": "number"},
            {"label": "Total revenue", "value": sum(r["total_revenue"] for r in rs_), "format": "money"},
            {"label": "Net collections", "value": sum(r["collections"] for r in rs_), "format": "money"}]


@report("MIS-01", "Daily Flash Report", MIS,
        "One row per day: OP visits and new OP patients, registrations, admissions, discharges, ER visits, OP / IP / pharmacy "
        "revenue and their total, and net collections (receipts and deposits less refunds).",
        [Col("period", "Date", "date"), *FLASH_COLS], access=BILLS, finance=True, popular=True, icon="Zap",
        chart={"type": "bar", "x": "period", "y": ["op_revenue", "ip_revenue", "pharmacy_revenue"], "stacked": True})
async def mis_flash(ctx, p: Params) -> Result:
    out = await flash(ctx, p, "Day")
    return Result(out, _flash_summary(out))


@report("MIS-02", "Monthly MIS Summary", MIS,
        "The flash report by month (default: this financial year): volumes, revenue lines and collections per month.",
        [Col("period", "Month"), *FLASH_COLS], access=BILLS, finance=True, icon="CalendarRange", default_period="this_fy",
        chart={"type": "bar", "x": "period", "y": ["total_revenue", "collections"]})
async def mis_monthly(ctx, p: Params) -> Result:
    out = await flash(ctx, p, "Month")
    return Result(out, _flash_summary(out))


@report("MIS-03", "Billing vs Collection Reconciliation", MIS,
        "Per day: what was billed (OP, IP and other bills) against what was collected — bill payments, advances / deposits and "
        "refunds — with the gap between the two.",
        [Col("period", "Date", "date"), Col("billed_op", "OP billed", "money", total=True), Col("billed_ip", "IP billed", "money", total=True),
         Col("billed_other", "Other billed", "money", total=True), Col("billed", "Total billed", "money", total=True),
         Col("bill_payments", "Bill payments", "money", total=True), Col("deposits", "Deposits", "money", total=True),
         Col("refunds", "Refunds", "money", total=True), Col("collected", "Net collected", "money", total=True),
         Col("gap", "Collected − billed", "money", total=True)],
        filters=[F.period, F.view(["Day", "Month"])], access=BILLS, finance=True, icon="Scale",
        chart={"type": "line", "x": "period", "y": ["billed", "collected"]})
async def mis_recon(ctx, p: Params) -> Result:
    view = p.get("view", "Day")
    start, end = _span(p)
    inv, pay = invoices, payments
    ib, yb = bucket(inv.c.billed_at, view), bucket(pay.c.paid_at, view)
    billed: dict = defaultdict(dict)
    for b, typ, net in (await ctx.conn.execute(sa.select(ib, inv.c.type, sa.func.sum(inv.c.net)).where(
            *_live_inv(), *ts_between(inv.c.billed_at, p)).group_by(ib, inv.c.type))).all():
        billed[b][typ] = f(net)
    coll: dict = defaultdict(dict)
    for b, kind, amt in (await ctx.conn.execute(sa.select(yb, pay.c.kind, sa.func.sum(pay.c.amount)).where(
            pay.c.deleted_at.is_(None), pay.c.status == "Success", *ts_between(pay.c.paid_at, p)).group_by(yb, pay.c.kind))).all():
        coll[b][kind] = f(amt)
    out = []
    for key, label in buckets(start, end, view):
        bl, cl = billed.get(key, {}), coll.get(key, {})
        row = {"period": key if view == "Day" else label, "billed_op": bl.get("OP", 0.0), "billed_ip": bl.get("IP", 0.0),
               "billed_other": sum(v for k, v in bl.items() if k not in ("OP", "IP")), "bill_payments": cl.get("PAYMENT", 0.0),
               "deposits": cl.get("DEPOSIT", 0.0), "refunds": cl.get("REFUND", 0.0)}
        row["billed"] = row["billed_op"] + row["billed_ip"] + row["billed_other"]
        row["collected"] = row["bill_payments"] + row["deposits"] - row["refunds"]
        row["gap"] = row["collected"] - row["billed"]
        out.append(row)
    tb, tc = sum(r["billed"] for r in out), sum(r["collected"] for r in out)
    return Result(out, [{"label": "Billed", "value": tb, "format": "money"}, {"label": "Net collected", "value": tc, "format": "money"},
                        {"label": "Deposits", "value": sum(r["deposits"] for r in out), "format": "money"},
                        {"label": "Refunds", "value": sum(r["refunds"] for r in out), "format": "money"},
                        {"label": "Collected − billed", "value": tc - tb, "format": "money"}])


MODES = ["CASH", "CARD", "UPI", "BANK", "WALLET", "INSURANCE"]
MODE_COLS = [Col(m.lower(), m.title() if m != "UPI" else "UPI", "money", total=True) for m in MODES]


@report("MIS-04", "Daily Collection by Payment Mode", MIS,
        "OP, IP and ER receipts net of refunds, pivoted by payment mode — Cash / Card / UPI / Net banking / Wallet / Insurance — per day or month.",
        [Col("period", "Date"), *MODE_COLS, Col("gross", "Gross receipts", "money", total=True), Col("refunds", "Refunds", "money", total=True),
         Col("net", "Net collection", "money", total=True)],
        filters=[F.period, F.view(["Day", "Month"])], access=BILLS, finance=True, popular=True, icon="Banknote",
        chart={"type": "bar", "x": "period", "y": ["cash", "card", "upi", "insurance"], "stacked": True})
async def mis_modes(ctx, p: Params) -> Result:
    view = p.get("view", "Day")
    start, end = _span(p)
    pay = payments
    yb = bucket(pay.c.paid_at, view)
    data: dict = defaultdict(lambda: defaultdict(float))
    for b, kind, mode, amt in (await ctx.conn.execute(sa.select(yb, pay.c.kind, pay.c.mode, sa.func.sum(pay.c.amount)).where(
            pay.c.deleted_at.is_(None), pay.c.status == "Success", *ts_between(pay.c.paid_at, p)).group_by(yb, pay.c.kind, pay.c.mode))).all():
        if kind == "REFUND":
            data[b]["refunds"] += f(amt)
        elif kind in ("PAYMENT", "DEPOSIT"):
            data[b][(mode or "CASH").lower()] += f(amt)
    out = []
    for key, label in buckets(start, end, view):
        d = data.get(key, {})
        row = {"period": label, **{m.lower(): d.get(m.lower(), 0.0) for m in MODES}, "refunds": d.get("refunds", 0.0)}
        row["gross"] = sum(row[m.lower()] for m in MODES)
        row["net"] = row["gross"] - row["refunds"]
        out.append(row)
    tiles = [{"label": "Net collection", "value": sum(r["net"] for r in out), "format": "money"}]
    tiles += [{"label": m.title() if m != "UPI" else "UPI", "value": sum(r[m.lower()] for r in out), "format": "money"} for m in ("CASH", "CARD", "UPI", "INSURANCE")]
    tiles.append({"label": "Refunds", "value": sum(r["refunds"] for r in out), "format": "money"})
    return Result(out, tiles)


def _user_join(col):
    return users, sa.cast(users.c.id, sa.Text) == col


@report("MIS-05", "Collection by User (Cashier)", MIS,
        "Receipts and refunds per cashier for the period, split by payment mode — the basis of the cashier hand-over.",
        [Col("user", "Cashier / user"), Col("role", "Role", default=False), Col("receipts", "Receipts", "number", total=True),
         Col("cash", "Cash", "money", total=True), Col("card", "Card", "money", total=True), Col("upi", "UPI", "money", total=True),
         Col("other", "Other modes", "money", total=True), Col("refunds", "Refunds", "money", total=True),
         Col("net", "Net collected", "money", total=True)],
        filters=[F.period, F.mode], access=BILLS, finance=True, icon="UserCheck",
        chart={"type": "bar", "x": "user", "y": ["net"], "horizontal": True})
async def mis_by_user(ctx, p: Params) -> Result:
    pay = payments
    u, on = _user_join(pay.c.created_by)
    conds = [pay.c.deleted_at.is_(None), pay.c.status == "Success", *ts_between(pay.c.paid_at, p)]
    if p.get("mode"):
        conds.append(pay.c.mode == p.get("mode"))
    data: dict = defaultdict(lambda: defaultdict(float))
    stmt = (sa.select(sa.func.coalesce(u.c.name, pay.c.data["received_by"].astext, "System"), u.c.role, pay.c.kind, pay.c.mode,
                      sa.func.sum(pay.c.amount), sa.func.count())
            .select_from(pay.outerjoin(u, on)).where(*conds).group_by(sa.text("1"), u.c.role, pay.c.kind, pay.c.mode))
    for name, role, kind, mode, amt, n in (await ctx.conn.execute(stmt)).all():
        d = data[(name, role)]
        if kind == "REFUND":
            d["refunds"] += f(amt)
            continue
        d["receipts"] += n
        key = (mode or "").lower()
        d[key if key in ("cash", "card", "upi") else "other"] += f(amt)
    out = []
    for (name, role), d in data.items():
        row = {"user": name, "role": role, "receipts": int(d["receipts"]), "cash": d["cash"], "card": d["card"], "upi": d["upi"],
               "other": d["other"], "refunds": d["refunds"]}
        row["net"] = row["cash"] + row["card"] + row["upi"] + row["other"] - row["refunds"]
        out.append(row)
    out.sort(key=lambda r: -r["net"])
    return Result(out)


@report("MIS-06", "Cash Closure / Day Reconciliation", MIS,
        "Per cashier per day: cash received (bills and deposits), cash refunded and the net cash that should be in the drawer, "
        "plus non-cash receipts for the hand-over sheet.",
        [Col("date", "Date", "date"), Col("user", "Cashier / user"), Col("cash_in", "Cash received", "money", total=True),
         Col("cash_out", "Cash refunded", "money", total=True), Col("cash_net", "Cash in drawer", "money", total=True),
         Col("non_cash", "Non-cash receipts", "money", total=True), Col("receipts", "Receipts", "number", total=True),
         Col("first_at", "First receipt", "datetime", False), Col("last_at", "Last receipt", "datetime", False)],
        filters=[F.period, F.search("Cashier name…")], access=BILLS, finance=True, icon="Vault", default_period="today")
async def mis_cash_closure(ctx, p: Params) -> Result:
    pay = payments
    u, on = _user_join(pay.c.created_by)
    d = day(pay.c.paid_at)
    name = sa.func.coalesce(u.c.name, pay.c.data["received_by"].astext, "System")
    cash = pay.c.mode == "CASH"
    recv = pay.c.kind.in_(["PAYMENT", "DEPOSIT"])
    stmt = (sa.select(d.label("date"), name.label("user"),
                      sa.func.coalesce(sa.func.sum(pay.c.amount).filter(cash, recv), 0).label("cash_in"),
                      sa.func.coalesce(sa.func.sum(pay.c.amount).filter(cash, pay.c.kind == "REFUND"), 0).label("cash_out"),
                      sa.func.coalesce(sa.func.sum(pay.c.amount).filter(sa.not_(cash), recv), 0).label("non_cash"),
                      sa.func.count().filter(recv).label("receipts"), sa.func.min(pay.c.paid_at).label("first_at"),
                      sa.func.max(pay.c.paid_at).label("last_at"))
            .select_from(pay.outerjoin(u, on))
            .where(pay.c.deleted_at.is_(None), pay.c.status == "Success", *ts_between(pay.c.paid_at, p))
            .group_by(d, name).order_by(d.desc(), name))
    out = await rows(ctx, stmt)
    for r in out:
        r["cash_net"] = f(r["cash_in"]) - f(r["cash_out"])
    if p.q:
        out = [r for r in out if p.q.lower() in (r["user"] or "").lower()]
    return Result(out, [{"label": "Cash received", "value": sum(f(r["cash_in"]) for r in out), "format": "money"},
                        {"label": "Cash refunded", "value": sum(f(r["cash_out"]) for r in out), "format": "money"},
                        {"label": "Cash in drawer", "value": sum(r["cash_net"] for r in out), "format": "money"},
                        {"label": "Non-cash", "value": sum(f(r["non_cash"]) for r in out), "format": "money"}])


@report("MIS-07", "Pending / Unbilled IP Bills", MIS,
        "In-patients still in a bed with their running bill — unbilled charges, interim bills, deposits — and the deposit shortfall "
        "(running bill not covered by advances or payments).",
        [Col("ip_no", "IP no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"), Col("admitted_at", "Admitted", "datetime"),
         Col("los_days", "LOS (days)", "number"), Col("ward", "Ward"), Col("bed", "Bed", default=False), Col("consultant", "Consultant"),
         Col("payer", "Payer"), Col("unbilled", "Unbilled charges", "money", total=True), Col("billed", "Interim bills", "money", total=True),
         Col("deposits", "Deposits", "money", total=True), Col("paid", "Paid on bills", "money", total=True),
         Col("shortfall", "Deposit shortfall", "money", total=True), Col("status", "Status", "status")],
        filters=[F.search("IP no / patient…"), F.payer, F.doctor, F.department, F.ward], access=("billing.charges",), finance=True,
        icon="Hourglass", default_period="all", handles_q=True)
async def mis_unbilled(ctx, p: Params) -> Result:
    from ..schema import beds

    en, ch, inv, pay, pat = encounters, charges, invoices, payments, patients
    w = records.alias("w")
    unb = sa.select(ch.c.encounter_id, sa.func.sum(ch.c.amount).label("amt")).where(
        ch.c.status == "Unbilled", ch.c.deleted_at.is_(None)).group_by(ch.c.encounter_id).subquery()
    bil = sa.select(inv.c.encounter_id, sa.func.sum(inv.c.net).label("net"), sa.func.sum(inv.c.paid).label("paid")).where(
        inv.c.deleted_at.is_(None), inv.c.status.notin_(["Cancelled"])).group_by(inv.c.encounter_id).subquery()
    dep = (sa.select(en.c.id.label("eid"), sa.func.sum(pay.c.amount).label("amt"))
           .select_from(en.join(pay, sa.and_(pay.c.patient_id == en.c.patient_id, pay.c.paid_at >= en.c.started_at)))
           .where(en.c.type == "IPD", en.c.status.in_(["Admitted", "Discharge Initiated"]), pay.c.kind == "DEPOSIT",
                  pay.c.status == "Success", pay.c.deleted_at.is_(None)).group_by(en.c.id).subquery())
    payer = sa.case((en.c.data["payer"].astext.in_(["Cash", "Self"]), "Self / Cash"), else_=sa.func.coalesce(en.c.data["payer"].astext, "Self / Cash"))
    conds = [en.c.type == "IPD", en.c.status.in_(["Admitted", "Discharge Initiated"]), en.c.deleted_at.is_(None)]
    conds += payer_filter(payer, p)
    for k, col in (("doctor", en.c.doctor_id), ("department", en.c.department_id), ("ward", beds.c.ward_id)):
        if p.get(k) and is_uuid(p.get(k)):
            conds.append(col == p.get(k))
    if p.q:
        like = f"%{p.q}%"
        conds.append(sa.or_(en.c.code.ilike(like), pat.c.title.ilike(like), pat.c.code.ilike(like)))
    stmt = (sa.select(en.c.code.label("ip_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"), en.c.started_at.label("admitted_at"),
                      sa.func.date_part("day", sa.func.now() - en.c.started_at).label("los_days"), w.c.title.label("ward"),
                      beds.c.bed_no.label("bed"), employees.c.name.label("consultant"), payer.label("payer"),
                      sa.func.coalesce(unb.c.amt, 0).label("unbilled"), sa.func.coalesce(bil.c.net, 0).label("billed"),
                      sa.func.coalesce(dep.c.amt, 0).label("deposits"), sa.func.coalesce(bil.c.paid, 0).label("paid"), en.c.status,
                      en.c.id.label("_id"))
            .select_from(en.join(pat, pat.c.id == en.c.patient_id).outerjoin(beds, beds.c.id == en.c.bed_id)
                         .outerjoin(w, w.c.id == beds.c.ward_id).outerjoin(employees, employees.c.id == en.c.doctor_id)
                         .outerjoin(unb, unb.c.encounter_id == en.c.id).outerjoin(bil, bil.c.encounter_id == en.c.id)
                         .outerjoin(dep, dep.c.eid == en.c.id))
            .where(*conds).order_by(sa.func.coalesce(unb.c.amt, 0).desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["shortfall"] = max(0.0, f(r["unbilled"]) + f(r["billed"]) - f(r["deposits"]) - f(r["paid"]))
        r["_link"] = f"/m/ipd/admissions?r={r.pop('_id')}"
    return Result(out, [{"label": "In-patients", "value": len(out), "format": "number"},
                        {"label": "Unbilled", "value": sum(f(r["unbilled"]) for r in out), "format": "money"},
                        {"label": "Deposits", "value": sum(f(r["deposits"]) for r in out), "format": "money"},
                        {"label": "Shortfall", "value": sum(r["shortfall"] for r in out), "format": "money"},
                        {"label": "With shortfall", "value": sum(1 for r in out if r["shortfall"] > 0), "format": "number"}])


@report("MIS-08", "Hospital KPI Scorecard", MIS,
        "The management KPIs for the period against the previous period of equal length (or the same dates last year): OP visits, "
        "registrations, admissions, discharges, ALOS, occupancy, revenue, collections, revenue per OP visit and per admission, lab TAT.",
        [Col("kpi", "KPI"), Col("current", "This period", "number"), Col("previous", "Comparison", "number"),
         Col("change_pct", "Change %", "percent"), Col("unit", "Unit"), Col("verdict", "Verdict", "status")],
        filters=[F.period, F.view(["vs previous period", "vs same period last year"])], access=BILLS, finance=True, icon="Gauge")
async def mis_scorecard(ctx, p: Params) -> Result:
    from ..engines import metrics

    start, end = _span(p)
    cmp = comparison_window(start, end, "last_year" if p.get("view") == "vs same period last year" else "previous")
    assert cmp

    async def snap(a, b) -> dict:
        rev = await metrics.revenue(ctx, a, b)
        op = await metrics.op_visits(ctx, a, b)
        ip = await metrics.admissions(ctx, a, b)
        lab = await metrics.lab_tat(ctx, a, b, "LAB")
        s, e = metrics._rng(a, b)
        regs = (await ctx.conn.execute(sa.select(sa.func.count()).where(patients.c.created_at >= s, patients.c.created_at < e))).scalar_one()
        seen = op["seen"]
        return {"OP visits": (seen, "count", True), "New registrations": (regs, "count", True), "Admissions": (ip["admitted"], "count", True),
                "Discharges": (ip["discharged"], "count", True), "ER visits": (ip["er_visits"], "count", True),
                "Average length of stay": (ip["alos_days"], "days", False), "Revenue (billed)": (rev["billed"], "₹", True),
                "Net collections": (rev["net_collection"], "₹", True), "Refunds": (rev["refunds"], "₹", False),
                "Revenue per OP visit": (round(rev["by_type"].get("OP", 0) / seen) if seen else None, "₹", True),
                "Revenue per admission": (round(rev["by_type"].get("IP", 0) / ip["discharged"]) if ip["discharged"] else None, "₹", True),
                "Lab tests": (lab["orders"], "count", True), "Lab TAT (avg)": (lab["avg_tat_min"], "min", False),
                "No-shows": (op["no_show"], "count", False)}

    cur, prev = await snap(start, end), await snap(*cmp)
    out = []
    for k, (v, unit, up_good) in cur.items():
        pv = prev[k][0]
        ch = pct(f(v) - f(pv), pv) if v is not None and pv else None
        verdict = "No change" if not ch else ("Better" if (ch > 0) == up_good else "Worse")
        out.append({"kpi": k, "current": v, "previous": pv, "change_pct": ch, "unit": unit, "verdict": verdict})
    note = f"Compared with {cmp[0]:%d %b %Y} – {cmp[1]:%d %b %Y}."
    return Result(out, [{"label": "Better", "value": sum(1 for r in out if r["verdict"] == "Better"), "format": "number"},
                        {"label": "Worse", "value": sum(1 for r in out if r["verdict"] == "Worse"), "format": "number"}], note)


# ====================================================================== revenue

def _charge_base(p: Params):
    ch, sv, en = charges, services, encounters
    j = ch.outerjoin(sv, sv.c.id == ch.c.service_id).outerjoin(en, en.c.id == ch.c.encounter_id)
    conds = [ch.c.deleted_at.is_(None), ch.c.status != "Cancelled", *ts_between(ch.c.charged_at, p)]
    return j, conds


@report("REV-01", "Department-wise Revenue", REV,
        "Revenue earned at the point of service (charges) by department — OP and IP split, number of charge lines and the share of the total.",
        [Col("department", "Department"), Col("op", "OP", "money", total=True), Col("ip", "IP", "money", total=True),
         Col("total", "Total", "money", total=True), Col("share", "Share %", "percent"), Col("lines", "Lines", "number", False, total=True)],
        filters=[F.period, F.department], access=("billing.charges",), finance=True, popular=True, icon="Building2",
        chart={"type": "bar", "x": "department", "y": ["op", "ip"], "horizontal": True, "stacked": True})
async def rev_department(ctx, p: Params) -> Result:
    ch, sv, en = charges, services, encounters
    j, conds = _charge_base(p)
    did = sa.func.coalesce(sv.c.department_id, en.c.department_id)
    if p.get("department") and is_uuid(p.get("department")):
        conds.append(did == p.get("department"))
    ip = en.c.type.in_(["IPD", "DAYCARE"])
    stmt = (sa.select(sa.func.coalesce(dept.c.title, "Unassigned").label("department"),
                      sa.func.coalesce(sa.func.sum(ch.c.amount).filter(sa.not_(ip) | en.c.type.is_(None)), 0).label("op"),
                      sa.func.coalesce(sa.func.sum(ch.c.amount).filter(ip), 0).label("ip"), sa.func.sum(ch.c.amount).label("total"),
                      sa.func.count().label("lines"))
            .select_from(j.outerjoin(dept, dept.c.id == did)).where(*conds).group_by(dept.c.title).order_by(sa.func.sum(ch.c.amount).desc()))
    out = share(await rows(ctx, stmt), "total")
    return Result(out, [{"label": "Departments", "value": len(out), "format": "number"},
                        {"label": "OP revenue", "value": sum(f(r["op"]) for r in out), "format": "money"},
                        {"label": "IP revenue", "value": sum(f(r["ip"]) for r in out), "format": "money"},
                        {"label": "Total", "value": sum(f(r["total"]) for r in out), "format": "money"}])


@report("REV-02", "Doctor-wise Revenue", REV,
        "Consultations, OP revenue (consultation and orders raised in their OPD) and IP revenue of admissions under each consultant.",
        [Col("doctor", "Doctor"), Col("department", "Department"), Col("consultations", "Consultations", "number", total=True),
         Col("op_revenue", "OP revenue", "money", total=True), Col("ip_revenue", "IP revenue", "money", total=True),
         Col("total", "Total", "money", total=True), Col("share", "Share %", "percent")],
        filters=[F.period, F.doctor, F.department], access=("billing.charges",), finance=True, popular=True, icon="Stethoscope",
        chart={"type": "bar", "x": "doctor", "y": ["op_revenue", "ip_revenue"], "horizontal": True, "stacked": True})
async def rev_doctor(ctx, p: Params) -> Result:
    ch, en, a = charges, encounters, appointments
    did = sa.func.coalesce(a.c.doctor_id, en.c.doctor_id)
    ip = en.c.type.in_(["IPD", "DAYCARE"])
    conds = [ch.c.deleted_at.is_(None), ch.c.status != "Cancelled", *ts_between(ch.c.charged_at, p), did.isnot(None)]
    if p.get("doctor") and is_uuid(p.get("doctor")):
        conds.append(did == p.get("doctor"))
    if p.get("department") and is_uuid(p.get("department")):
        conds.append(employees.c.department_id == p.get("department"))
    stmt = (sa.select(employees.c.name.label("doctor"), dept.c.title.label("department"),
                      sa.func.count().filter(ch.c.source == "appointments.appointments").label("consultations"),
                      sa.func.coalesce(sa.func.sum(ch.c.amount).filter(sa.not_(ip) | en.c.type.is_(None)), 0).label("op_revenue"),
                      sa.func.coalesce(sa.func.sum(ch.c.amount).filter(ip), 0).label("ip_revenue"), sa.func.sum(ch.c.amount).label("total"))
            .select_from(ch.outerjoin(a, sa.and_(ch.c.source == "appointments.appointments", a.c.id == ch.c.source_id))
                         .outerjoin(en, en.c.id == ch.c.encounter_id).join(employees, employees.c.id == did)
                         .outerjoin(dept, dept.c.id == employees.c.department_id))
            .where(*conds).group_by(employees.c.name, dept.c.title).order_by(sa.func.sum(ch.c.amount).desc()))
    out = share(await rows(ctx, stmt), "total")
    return Result(out)


@report("REV-03", "Service-wise Revenue", REV,
        "Every tariff service charged in the period with quantity, gross, discount and net — the price list in action.",
        [Col("service_code", "Code", "code"), Col("service", "Service"), Col("category", "Category"), Col("department", "Department", default=False),
         Col("qty", "Qty", "number", total=True), Col("rate", "Avg rate", "money", False), Col("gross", "Gross", "money", total=True),
         Col("discount", "Discount", "money", total=True), Col("net", "Net", "money", total=True), Col("share", "Share %", "percent")],
        filters=[F.period, F.search("Service code / name…"), F.select("category", "Category", list(CAT_LABEL)), F.department],
        access=("billing.charges",), finance=True, icon="ListChecks", handles_q=True,
        chart={"type": "bar", "x": "service", "y": ["net"], "horizontal": True})
async def rev_service(ctx, p: Params) -> Result:
    ch, sv = charges, services
    j, conds = _charge_base(p)
    if p.get("category"):
        conds.append(sv.c.category == p.get("category"))
    if p.get("department") and is_uuid(p.get("department")):
        conds.append(sv.c.department_id == p.get("department"))
    if p.q:
        conds.append(sa.or_(sv.c.code.ilike(f"%{p.q}%"), sv.c.title.ilike(f"%{p.q}%"), ch.c.data["description"].astext.ilike(f"%{p.q}%")))
    name = sa.func.coalesce(sv.c.title, ch.c.data["description"].astext, "Other")
    stmt = (sa.select(sv.c.code.label("service_code"), name.label("service"), sv.c.category.label("category"), dept.c.title.label("department"),
                      sa.func.sum(ch.c.qty).label("qty"), sa.func.avg(ch.c.rate).label("rate"), sa.func.sum(ch.c.amount).label("gross"),
                      sa.func.coalesce(sa.func.sum(ch.c.discount), 0).label("discount"),
                      (sa.func.sum(ch.c.amount) - sa.func.coalesce(sa.func.sum(ch.c.discount), 0)).label("net"))
            .select_from(j.outerjoin(dept, dept.c.id == sv.c.department_id)).where(*conds)
            .group_by(sv.c.code, name, sv.c.category, dept.c.title).order_by(sa.func.sum(ch.c.amount).desc()))
    out = share(await rows(ctx, stmt), "net")
    for r in out:
        r["category"] = CAT_LABEL.get(r["category"] or "", r["category"] or "Room & bed")
    return Result(out)


@report("REV-04", "Revenue by Stream", REV,
        "Inpatient, OP consultations, OP laboratory, OP radiology, OP procedures, pharmacy and other OP services — amount and share.",
        [Col("stream", "Stream"), Col("amount", "Revenue", "money", total=True), Col("lines", "Lines", "number", False, total=True),
         Col("share", "Share %", "percent")],
        access=("billing.charges",), finance=True, icon="PieChart", chart={"type": "donut", "x": "stream", "y": ["amount"]})
async def rev_stream(ctx, p: Params) -> Result:
    ch = charges
    j, conds = _charge_base(p)
    st = stream_expr()
    stmt = sa.select(st.label("stream"), sa.func.sum(ch.c.amount).label("amount"), sa.func.count().label("lines")).select_from(j).where(
        *conds).group_by(st).order_by(sa.func.sum(ch.c.amount).desc())
    out = share(await rows(ctx, stmt), "amount")
    # counter sales not yet on a bill
    r = records
    dt = jts(r.c.data["dispensed_at"].astext)
    disp = f((await ctx.conn.execute(sa.select(sa.func.sum(jnum(r.c.data["total"].astext))).where(
        *rec_live("pharmacy", "dispenses"), r.c.status != "Cancelled", r.c.data["invoice"].astext.is_(None), *ts_between(dt, p)))).scalar())
    if disp:
        ph = next((x for x in out if x["stream"] == "Pharmacy"), None)
        if ph:
            ph["amount"] = f(ph["amount"]) + disp
        else:
            out.append({"stream": "Pharmacy", "amount": disp, "lines": 0})
        out = share(sorted(out, key=lambda x: -f(x["amount"])), "amount")
    return Result(out)


@report("REV-05", "Payer-wise Revenue", REV,
        "Bills by payer category — self / cash, insurance (TPA), government schemes and corporates — with collected and due.",
        [Col("payer", "Payer"), Col("bills", "Bills", "number", total=True), Col("gross", "Gross", "money", total=True),
         Col("discount", "Discount", "money", total=True), Col("net", "Net", "money", total=True), Col("paid", "Collected", "money", total=True),
         Col("due", "Due", "money", total=True), Col("share", "Share %", "percent")],
        filters=[F.period, F.select("type", "Bill type", ["OP", "IP", "PHARMACY", "PACKAGE"])], access=("billing.invoices",), finance=True,
        icon="Landmark", chart={"type": "donut", "x": "payer", "y": ["net"]})
async def rev_payer(ctx, p: Params) -> Result:
    inv, en, pat = invoices, encounters, patients
    pe = payer_expr()
    conds = [*_live_inv(), *ts_between(inv.c.billed_at, p)]
    if p.get("type"):
        conds.append(inv.c.type == p.get("type"))
    stmt = (sa.select(pe.label("payer"), sa.func.count().label("bills"), sa.func.sum(inv.c.gross).label("gross"),
                      sa.func.sum(inv.c.discount).label("discount"), sa.func.sum(inv.c.net).label("net"), sa.func.sum(inv.c.paid).label("paid"),
                      sa.func.sum(inv.c.balance).label("due"))
            .select_from(inv.outerjoin(en, en.c.id == inv.c.encounter_id).outerjoin(pat, pat.c.id == inv.c.patient_id))
            .where(*conds).group_by(pe).order_by(sa.func.sum(inv.c.net).desc()))
    return Result(share(await rows(ctx, stmt), "net"))


@report("REV-06", "Revenue Trend", REV,
        "Billed revenue per day, week or month split into OP, IP, pharmacy and other bills, with collections alongside.",
        [Col("period", "Period"), Col("op", "OP", "money", total=True), Col("ip", "IP", "money", total=True),
         Col("pharmacy", "Pharmacy", "money", total=True), Col("other", "Other", "money", total=True),
         Col("total", "Total billed", "money", total=True), Col("collections", "Collections", "money", total=True)],
        filters=[F.period, F.view(["Day", "Week", "Month"])], access=("billing.invoices",), finance=True, icon="TrendingUp",
        chart={"type": "area", "x": "period", "y": ["total", "collections"]})
async def rev_trend(ctx, p: Params) -> Result:
    view = p.get("view", "Day")
    start, end = _span(p)
    inv, pay = invoices, payments
    ib, yb = bucket(inv.c.billed_at, view), bucket(pay.c.paid_at, view)
    rev: dict = defaultdict(dict)
    for b, typ, net in (await ctx.conn.execute(sa.select(ib, inv.c.type, sa.func.sum(inv.c.net)).where(
            *_live_inv(), *ts_between(inv.c.billed_at, p)).group_by(ib, inv.c.type))).all():
        rev[b][typ] = f(net)
    coll = await _grouped(ctx, sa.select(yb, sa.func.sum(pay.c.amount)).where(
        pay.c.deleted_at.is_(None), pay.c.status == "Success", pay.c.kind.in_(["PAYMENT", "DEPOSIT"]), *ts_between(pay.c.paid_at, p)).group_by(yb))
    out = []
    for key, label in buckets(start, end, view):
        rv = rev.get(key, {})
        row = {"period": label, "op": rv.get("OP", 0.0), "ip": rv.get("IP", 0.0), "pharmacy": rv.get("PHARMACY", 0.0),
               "other": sum(v for k, v in rv.items() if k not in ("OP", "IP", "PHARMACY")), "collections": f(coll.get(key))}
        row["total"] = row["op"] + row["ip"] + row["pharmacy"] + row["other"]
        out.append(row)
    return Result(out)


@report("REV-07", "Service Category Revenue", REV,
        "Charges by service category — consultation, laboratory, radiology, procedures, room & bed, nursing, OT, ICU, pharmacy…",
        [Col("category", "Category"), Col("qty", "Qty", "number", total=True), Col("amount", "Revenue", "money", total=True),
         Col("share", "Share %", "percent")],
        filters=[F.period, F.select("setting", "Setting", ["OP", "IP"])], access=("billing.charges",), finance=True, icon="Shapes",
        chart={"type": "donut", "x": "category", "y": ["amount"]})
async def rev_category(ctx, p: Params) -> Result:
    ch, sv, en = charges, services, encounters
    j, conds = _charge_base(p)
    if p.get("setting") == "IP":
        conds.append(en.c.type.in_(["IPD", "DAYCARE"]))
    elif p.get("setting") == "OP":
        conds.append(sa.or_(en.c.type.is_(None), en.c.type.notin_(["IPD", "DAYCARE"])))
    cat = sa.func.coalesce(sv.c.category, sa.case((ch.c.source.like("ipd.daily%"), "ROOM"), else_="OTHER"))
    stmt = sa.select(cat.label("category"), sa.func.sum(ch.c.qty).label("qty"), sa.func.sum(ch.c.amount).label("amount")).select_from(j).where(
        *conds).group_by(cat).order_by(sa.func.sum(ch.c.amount).desc())
    out = share(await rows(ctx, stmt), "amount")
    for r in out:
        r["category"] = CAT_LABEL.get(r["category"], r["category"])
    return Result(out)
