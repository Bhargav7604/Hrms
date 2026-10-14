"""Finance, insurance / TPA, packages and GST reports."""

from __future__ import annotations

from collections import defaultdict

import sqlalchemy as sa

from ..core.util import is_uuid, today
from ..schema import (
    UUID,
    appointments,
    approvals,
    audit_log,
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
from . import Col, F, Params, Result, category, report
from ._sql import (
    dept,
    f,
    jnum,
    jts,
    patient_cols,
    payer_expr,
    payer_filter,
    pct,
    rec_live,
    rows,
    share,
    text_between,
    ts_between,
)

FIN = category("Finance", "Hospital billing, collections, deposits, refunds, discounts and outstanding dues.", "Wallet", 2)
INS = category("Insurance & TPA", "Pre-authorisations, claims, settlements, disallowances and sponsor ageing.", "ShieldCheck", 4)
PKG = category("Packages & Health Checks", "Surgical / medical package utilisation and health check-up programmes.", "Package", 5)
GST = category("GST", "Outward supplies for GSTR-1 — HSN / SAC summary, rate-wise and invoice-wise registers.", "Percent", 15)

BILL_STATUSES = ["Final", "Partially Paid", "Paid", "Draft", "Cancelled"]


def _bill_status(inv, p: Params) -> list:
    st = p.get("status")
    if st:
        return [inv.c.status == st]
    return [inv.c.status.notin_(["Cancelled", "Draft"])]


def _appt_sub(p: Params, typ: str = "OP"):
    """Per invoice: the consulting doctor / department / visit type from its consultation lines."""
    ch, a, inv = charges, appointments, invoices
    return (sa.select(ch.c.invoice_id.label("iid"), sa.func.min(sa.cast(a.c.doctor_id, sa.Text)).label("doctor_id"),
                      sa.func.min(sa.cast(a.c.department_id, sa.Text)).label("department_id"), sa.func.min(a.c.type).label("visit_type"),
                      sa.func.count(ch.c.id).label("lines"))
            .select_from(ch.join(inv, inv.c.id == ch.c.invoice_id)
                         .outerjoin(a, sa.and_(ch.c.source == "appointments.appointments", a.c.id == ch.c.source_id)))
            .where(ch.c.deleted_at.is_(None), inv.c.type == typ, *ts_between(inv.c.billed_at, p))
            .group_by(ch.c.invoice_id).subquery())


def _ref_filters(p: Params, doctor_col, dept_col) -> list:
    out = []
    if p.get("doctor") and is_uuid(p.get("doctor")):
        out.append(doctor_col == p.get("doctor"))
    if p.get("department") and is_uuid(p.get("department")):
        out.append(dept_col == p.get("department"))
    return out


def _search(p: Params, *cols) -> list:
    if not p.q:
        return []
    like = f"%{p.q}%"
    return [sa.or_(*[c.ilike(like) for c in cols])]


BILL_TILES = ("bills", "gross", "discount", "net", "paid", "due")


def _bill_summary(out: list[dict]) -> list[dict]:
    return [{"label": "Rows", "value": len(out), "format": "number"},
            {"label": "Bills", "value": len({r.get("bill_no") for r in out}), "format": "number"},
            {"label": "Gross", "value": sum(f(r.get("gross")) for r in out), "format": "money"},
            {"label": "Discount", "value": sum(f(r.get("discount")) for r in out), "format": "money"},
            {"label": "Net", "value": sum(f(r.get("net")) for r in out), "format": "money"},
            {"label": "Collected", "value": sum(f(r.get("paid")) for r in out), "format": "money"},
            {"label": "Due", "value": sum(f(r.get("due")) for r in out), "format": "money"}]


u_by = users.alias("u_by")


@report("FIN-01", "OP Billing Register", FIN,
        "Every confirmed OP bill in the window — gross, discount, tax, net, collected and due, with the payer, doctor, patient and "
        "UHID. Cancelled and draft bills are excluded unless chosen in Status (see FIN-09 Cancelled Bills).",
        [Col("bill_date", "Bill date", "datetime"), Col("bill_no", "Bill no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("gender", "Gender", default=False), Col("age", "Age", "number", False), Col("mobile", "Mobile", default=False),
         Col("city", "City", default=False), Col("patient_category", "Patient category", default=False),
         Col("visit_type", "Visit type", default=False), Col("doctor", "Doctor"), Col("doctor_code", "Doctor code", "code", False),
         Col("department", "Department"), Col("cash_credit", "Cash / credit"), Col("payer", "Payer"), Col("lines", "Lines", "number", False),
         Col("gross", "Gross", "money", total=True), Col("discount", "Discount", "money", total=True),
         Col("discount_pct", "Discount %", "percent", False), Col("discount_reason", "Discount reason", default=False),
         Col("tax", "Tax", "money", total=True), Col("net", "Net", "money", total=True), Col("paid", "Collected", "money", total=True),
         Col("due", "Due", "money", total=True), Col("billed_by", "Billed by", default=False), Col("status", "Status", "status")],
        filters=[F.period, F.search("Bill no / UHID / name…"), F.doctor, F.department, F.payer, F.status(BILL_STATUSES)],
        access=("billing.invoices",), finance=True, popular=True, icon="ReceiptText", handles_q=True, default_sort="-bill_date")
async def fin_op_bills(ctx, p: Params) -> Result:
    inv, pat, en = invoices, patients, encounters
    sub = _appt_sub(p)
    doc_id = sa.func.coalesce(en.c.doctor_id, sa.cast(sub.c.doctor_id, UUID))
    dep_id = sa.func.coalesce(en.c.department_id, sa.cast(sub.c.department_id, UUID))
    pe = payer_expr()
    stmt = (sa.select(inv.c.billed_at.label("bill_date"), inv.c.code.label("bill_no"), *patient_cols(), sub.c.visit_type,
                      employees.c.name.label("doctor"), employees.c.code.label("doctor_code"), dept.c.title.label("department"),
                      sa.case((pe == "Self / Cash", "Cash"), else_="Credit").label("cash_credit"), pe.label("payer"), sub.c.lines,
                      inv.c.gross, inv.c.discount, inv.c.data["discount_reason"].astext.label("discount_reason"), inv.c.tax, inv.c.net,
                      inv.c.paid, inv.c.balance.label("due"), u_by.c.name.label("billed_by"), inv.c.status, inv.c.id.label("_id"))
            .select_from(inv.join(pat, pat.c.id == inv.c.patient_id).outerjoin(en, en.c.id == inv.c.encounter_id)
                         .outerjoin(sub, sub.c.iid == inv.c.id).outerjoin(employees, employees.c.id == doc_id)
                         .outerjoin(dept, dept.c.id == dep_id).outerjoin(u_by, sa.cast(u_by.c.id, sa.Text) == inv.c.created_by))
            .where(inv.c.deleted_at.is_(None), inv.c.type == "OP", *_bill_status(inv, p), *ts_between(inv.c.billed_at, p),
                   *payer_filter(pe, p), *_ref_filters(p, doc_id, dep_id), *_search(p, inv.c.code, pat.c.code, pat.c.title))
            .order_by(inv.c.billed_at.desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["discount_pct"] = pct(r["discount"], r["gross"])
        r["_link"] = f"/m/billing/invoices?r={r.pop('_id')}"
    return Result(out, _bill_summary(out))


@report("FIN-02", "OP Bill Item Register", FIN,
        "Line-wise OP billing — service, category, doctor, quantity, rate, gross, discount and net — on confirmed bills only.",
        [Col("bill_date", "Bill date", "datetime"), Col("bill_no", "Bill no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("service_code", "Service code", "code"), Col("service", "Service"), Col("category", "Category"), Col("doctor", "Doctor"),
         Col("department", "Department"), Col("qty", "Qty", "number", total=True), Col("rate", "Rate", "money"),
         Col("amount", "Gross", "money", total=True), Col("discount", "Discount", "money", total=True), Col("net", "Net", "money", total=True),
         Col("payer", "Payer", default=False)],
        filters=[F.period, F.search("Bill no / service / patient…"), F.doctor, F.department, F.payer,
                 F.select("category", "Category", ["CONSULT", "LAB", "RAD", "PROC", "PHARM", "MISC"])],
        access=("billing.charges",), finance=True, icon="ListOrdered", handles_q=True)
async def fin_op_items(ctx, p: Params) -> Result:
    ch, inv, pat, sv, a, en = charges, invoices, patients, services, appointments, encounters
    doc_id = a.c.doctor_id
    dep_id = sa.func.coalesce(sv.c.department_id, a.c.department_id)
    pe = payer_expr()
    conds = [ch.c.deleted_at.is_(None), ch.c.status != "Cancelled", inv.c.type == "OP", inv.c.status.notin_(["Cancelled", "Draft"]),
             *ts_between(inv.c.billed_at, p), *payer_filter(pe, p), *_ref_filters(p, doc_id, dep_id),
             *_search(p, inv.c.code, sv.c.title, pat.c.title, pat.c.code)]
    if p.get("category"):
        conds.append(sv.c.category == p.get("category"))
    stmt = (sa.select(inv.c.billed_at.label("bill_date"), inv.c.code.label("bill_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      sv.c.code.label("service_code"), sa.func.coalesce(sv.c.title, ch.c.data["description"].astext).label("service"),
                      sv.c.category, employees.c.name.label("doctor"), dept.c.title.label("department"), ch.c.qty, ch.c.rate,
                      ch.c.amount, sa.func.coalesce(ch.c.discount, 0).label("discount"),
                      (ch.c.amount - sa.func.coalesce(ch.c.discount, 0)).label("net"), pe.label("payer"))
            .select_from(ch.join(inv, inv.c.id == ch.c.invoice_id).join(pat, pat.c.id == inv.c.patient_id)
                         .outerjoin(sv, sv.c.id == ch.c.service_id).outerjoin(en, en.c.id == inv.c.encounter_id)
                         .outerjoin(a, sa.and_(ch.c.source == "appointments.appointments", a.c.id == ch.c.source_id))
                         .outerjoin(employees, employees.c.id == doc_id).outerjoin(dept, dept.c.id == dep_id))
            .where(*conds).order_by(inv.c.billed_at.desc(), inv.c.code))
    out = await rows(ctx, stmt)
    return Result(out, [{"label": "Lines", "value": len(out), "format": "number"},
                        {"label": "Bills", "value": len({r["bill_no"] for r in out}), "format": "number"},
                        {"label": "Gross", "value": sum(f(r["amount"]) for r in out), "format": "money"},
                        {"label": "Discount", "value": sum(f(r["discount"]) for r in out), "format": "money"},
                        {"label": "Net", "value": sum(f(r["net"]) for r in out), "format": "money"}])


@report("FIN-03", "IP Billing Register", FIN,
        "In-patient bills — final (dated by discharge) and interim — with admission no, ward, consultant, payer, gross, discount, "
        "net, advances, collected and due.",
        [Col("bill_date", "Bill date", "datetime"), Col("bill_no", "Bill no", "code"), Col("ip_no", "IP no", "code"),
         Col("uhid", "UHID", "code"), Col("patient", "Patient"), Col("admitted_at", "Admitted", "datetime", False),
         Col("discharged_at", "Discharged", "datetime", False), Col("ward", "Ward"), Col("consultant", "Consultant"),
         Col("department", "Department"), Col("payer", "Payer"), Col("gross", "Gross", "money", total=True),
         Col("discount", "Discount", "money", total=True), Col("tax", "Tax", "money", False, total=True), Col("net", "Net", "money", total=True),
         Col("paid", "Collected", "money", total=True), Col("due", "Due", "money", total=True), Col("status", "Status", "status")],
        filters=[F.period, F.search("Bill / IP no / patient…"), F.doctor, F.department, F.payer, F.status(BILL_STATUSES)],
        access=("billing.invoices",), finance=True, popular=True, icon="BedDouble", handles_q=True)
async def fin_ip_bills(ctx, p: Params) -> Result:
    from ..schema import beds

    inv, pat, en = invoices, patients, encounters
    w = records.alias("w")
    pe = payer_expr()
    stmt = (sa.select(inv.c.billed_at.label("bill_date"), inv.c.code.label("bill_no"), en.c.code.label("ip_no"), pat.c.code.label("uhid"),
                      pat.c.title.label("patient"), en.c.started_at.label("admitted_at"), en.c.ended_at.label("discharged_at"),
                      w.c.title.label("ward"), employees.c.name.label("consultant"), dept.c.title.label("department"), pe.label("payer"),
                      inv.c.gross, inv.c.discount, inv.c.tax, inv.c.net, inv.c.paid, inv.c.balance.label("due"), inv.c.status,
                      inv.c.id.label("_id"))
            .select_from(inv.join(pat, pat.c.id == inv.c.patient_id).outerjoin(en, en.c.id == inv.c.encounter_id)
                         .outerjoin(beds, beds.c.id == en.c.bed_id).outerjoin(w, w.c.id == beds.c.ward_id)
                         .outerjoin(employees, employees.c.id == en.c.doctor_id).outerjoin(dept, dept.c.id == en.c.department_id))
            .where(inv.c.deleted_at.is_(None), inv.c.type == "IP", *_bill_status(inv, p), *ts_between(inv.c.billed_at, p),
                   *payer_filter(pe, p), *_ref_filters(p, en.c.doctor_id, en.c.department_id),
                   *_search(p, inv.c.code, en.c.code, pat.c.code, pat.c.title))
            .order_by(inv.c.billed_at.desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["_link"] = f"/m/billing/invoices?r={r.pop('_id')}"
    return Result(out, _bill_summary(out))


@report("FIN-04", "Collection Register (receipt-wise)", FIN,
        "Every OP, IP and ER receipt, advance and refund in the window — receipt no, patient, mode, amount, reference and the bill it settled.",
        [Col("paid_at", "Date & time", "datetime"), Col("receipt_no", "Receipt no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("kind", "Type"), Col("mode", "Mode"), Col("amount", "Amount", "money", total=True), Col("signed", "Net effect", "money", False, total=True),
         Col("reference", "Reference", default=False), Col("bill_no", "Bill no", "code"), Col("bill_type", "Bill type", default=False),
         Col("received_by", "Received by"), Col("status", "Status", "status")],
        filters=[F.period, F.search("Receipt / bill / patient…"), F.mode, F.select("kind", "Type", ["PAYMENT", "DEPOSIT", "REFUND", "ADJUSTMENT"]),
                 F.status(["Success", "Pending", "Failed", "Reversed"])],
        access=("billing.payments",), finance=True, popular=True, icon="Coins", handles_q=True)
async def fin_collections(ctx, p: Params) -> Result:
    pay, pat, inv = payments, patients, invoices
    conds = [pay.c.deleted_at.is_(None), *ts_between(pay.c.paid_at, p), *_search(p, pay.c.code, inv.c.code, pat.c.code, pat.c.title)]
    for k, col in (("mode", pay.c.mode), ("kind", pay.c.kind), ("status", pay.c.status)):
        if p.get(k):
            conds.append(col == p.get(k))
    if not p.get("status"):
        conds.append(pay.c.status == "Success")
    stmt = (sa.select(pay.c.paid_at, pay.c.code.label("receipt_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"), pay.c.kind,
                      pay.c.mode, pay.c.amount, pay.c.data["reference"].astext.label("reference"), inv.c.code.label("bill_no"),
                      inv.c.type.label("bill_type"), sa.func.coalesce(users.c.name, pay.c.data["received_by"].astext).label("received_by"),
                      pay.c.status)
            .select_from(pay.outerjoin(pat, pat.c.id == pay.c.patient_id).outerjoin(inv, inv.c.id == pay.c.invoice_id)
                         .outerjoin(users, sa.cast(users.c.id, sa.Text) == pay.c.created_by))
            .where(*conds).order_by(pay.c.paid_at.desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["signed"] = -f(r["amount"]) if r["kind"] == "REFUND" else f(r["amount"])
    by = defaultdict(float)
    for r in out:
        if r["kind"] != "REFUND":
            by[r["mode"] or "OTHER"] += f(r["amount"])
    tiles = [{"label": "Receipts", "value": sum(1 for r in out if r["kind"] != "REFUND"), "format": "number"},
             {"label": "Net collected", "value": sum(r["signed"] for r in out), "format": "money"}]
    tiles += [{"label": m.title() if m != "UPI" else "UPI", "value": v, "format": "money"} for m, v in sorted(by.items(), key=lambda x: -x[1])[:4]]
    return Result(out, tiles)


@report("FIN-05", "Sponsor / Credit Outstanding (Ageing)", FIN,
        "Unpaid bill balances by payer with ageing buckets — 0–30, 31–60, 61–90 and over 90 days from the bill date.",
        [Col("payer", "Payer / sponsor"), Col("bills", "Bills", "number", total=True), Col("outstanding", "Outstanding", "money", total=True),
         Col("b0_30", "0–30 days", "money", total=True), Col("b31_60", "31–60 days", "money", total=True),
         Col("b61_90", "61–90 days", "money", total=True), Col("b90", "Over 90 days", "money", total=True),
         Col("oldest", "Oldest bill", "date", False)],
        filters=[F.period, F.select("type", "Bill type", ["OP", "IP", "PHARMACY", "PACKAGE"])], access=("billing.invoices",), finance=True,
        popular=True, icon="CalendarClock", default_period="all",
        chart={"type": "bar", "x": "payer", "y": ["b0_30", "b31_60", "b61_90", "b90"], "stacked": True, "horizontal": True})
async def fin_ageing(ctx, p: Params) -> Result:
    inv, en, pat = invoices, encounters, patients
    pe = payer_expr()
    age = sa.func.date_part("day", sa.func.now() - inv.c.billed_at)
    conds = [inv.c.deleted_at.is_(None), inv.c.status.in_(["Final", "Partially Paid"]), inv.c.balance > 0, *ts_between(inv.c.billed_at, p)]
    if p.get("type"):
        conds.append(inv.c.type == p.get("type"))

    def b(lo, hi=None):
        c = [age >= lo] + ([age <= hi] if hi is not None else [])
        return sa.func.coalesce(sa.func.sum(inv.c.balance).filter(*c), 0)

    stmt = (sa.select(pe.label("payer"), sa.func.count().label("bills"), sa.func.sum(inv.c.balance).label("outstanding"), b(0, 30).label("b0_30"),
                      b(31, 60).label("b31_60"), b(61, 90).label("b61_90"), b(91).label("b90"),
                      sa.func.min(sa.func.date(inv.c.billed_at)).label("oldest"))
            .select_from(inv.outerjoin(en, en.c.id == inv.c.encounter_id).outerjoin(pat, pat.c.id == inv.c.patient_id))
            .where(*conds).group_by(pe).order_by(sa.func.sum(inv.c.balance).desc()))
    out = await rows(ctx, stmt)
    # TPA claims submitted but not settled are receivables too
    r, py = records, records.alias("py")
    claim = (sa.select(sa.func.coalesce(py.c.title, "Insurance claims").label("payer"), sa.func.count().label("bills"),
                       sa.func.sum(jnum(r.c.data["claimed_amount"].astext)).label("outstanding"),
                       sa.func.min(sa.func.date(jts(r.c.data["submitted_at"].astext))).label("oldest"))
             .select_from(r.outerjoin(py, sa.cast(py.c.id, sa.Text) == r.c.data["payer"].astext))
             .where(*rec_live("insurance", "claims"), r.c.status.in_(["Submitted", "Query", "Approved"])).group_by(py.c.title))
    for c in await rows(ctx, claim):
        out.append({**c, "payer": f"{c['payer']} (claims)", "b0_30": None, "b31_60": None, "b61_90": None, "b90": None})
    return Result(out, [{"label": "Outstanding", "value": sum(f(x["outstanding"]) for x in out), "format": "money"},
                        {"label": "0–30 days", "value": sum(f(x["b0_30"]) for x in out), "format": "money"},
                        {"label": "31–60 days", "value": sum(f(x["b31_60"]) for x in out), "format": "money"},
                        {"label": "61–90 days", "value": sum(f(x["b61_90"]) for x in out), "format": "money"},
                        {"label": "Over 90 days", "value": sum(f(x["b90"]) for x in out), "format": "money"}])


@report("FIN-06", "IP Advance / Deposit Register", FIN,
        "Advances and deposits received against admissions — receipt, patient, admission, mode and amount.",
        [Col("paid_at", "Date & time", "datetime"), Col("receipt_no", "Receipt no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("ip_no", "IP no", "code"), Col("mode", "Mode"), Col("amount", "Amount", "money", total=True), Col("reference", "Reference", default=False),
         Col("received_by", "Received by")],
        filters=[F.period, F.search("Receipt / patient…"), F.mode], access=("billing.payments",), finance=True, icon="PiggyBank", handles_q=True)
async def fin_deposits(ctx, p: Params) -> Result:
    pay, pat, en = payments, patients, encounters
    ip = (sa.select(en.c.code).where(en.c.patient_id == pay.c.patient_id, en.c.type == "IPD", en.c.started_at <= pay.c.paid_at + sa.text("interval '1 day'"))
          .order_by(en.c.started_at.desc()).limit(1).correlate(pay).scalar_subquery())
    conds = [pay.c.deleted_at.is_(None), pay.c.kind == "DEPOSIT", pay.c.status == "Success", *ts_between(pay.c.paid_at, p),
             *_search(p, pay.c.code, pat.c.code, pat.c.title)]
    if p.get("mode"):
        conds.append(pay.c.mode == p.get("mode"))
    stmt = (sa.select(pay.c.paid_at, pay.c.code.label("receipt_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"), ip.label("ip_no"),
                      pay.c.mode, pay.c.amount, pay.c.data["reference"].astext.label("reference"),
                      sa.func.coalesce(users.c.name, pay.c.data["received_by"].astext).label("received_by"))
            .select_from(pay.outerjoin(pat, pat.c.id == pay.c.patient_id).outerjoin(users, sa.cast(users.c.id, sa.Text) == pay.c.created_by))
            .where(*conds).order_by(pay.c.paid_at.desc()))
    return Result(await rows(ctx, stmt))


@report("FIN-07", "Refund Register (OP + IP + ER)", FIN,
        "Refunds paid out and refund requests in the workflow — bill, patient, type, mode, amount, reason and who raised it.",
        [Col("date", "Date", "datetime"), Col("ref_no", "Ref no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("bill_no", "Bill no", "code"), Col("bill_type", "Bill type"), Col("refund_type", "Refund type"), Col("mode", "Mode"),
         Col("amount", "Amount", "money", total=True), Col("reason", "Reason"), Col("by", "Raised / paid by"), Col("status", "Status", "status")],
        filters=[F.period, F.search("Ref / bill / patient…"), F.status(["Success", "Requested", "Approved", "Paid", "Rejected"])],
        access=("billing.payments", "finance.refunds"), finance=True, icon="Undo2", handles_q=True)
async def fin_refunds(ctx, p: Params) -> Result:
    pay, pat, inv = payments, patients, invoices
    paid = (sa.select(pay.c.paid_at.label("date"), pay.c.code.label("ref_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      inv.c.code.label("bill_no"), inv.c.type.label("bill_type"), sa.literal("Refund paid").label("refund_type"), pay.c.mode,
                      pay.c.amount, pay.c.data["reference"].astext.label("reason"), users.c.name.label("by"), pay.c.status)
            .select_from(pay.outerjoin(pat, pat.c.id == pay.c.patient_id).outerjoin(inv, inv.c.id == pay.c.invoice_id)
                         .outerjoin(users, sa.cast(users.c.id, sa.Text) == pay.c.created_by))
            .where(pay.c.deleted_at.is_(None), pay.c.kind == "REFUND", *ts_between(pay.c.paid_at, p),
                   *_search(p, pay.c.code, inv.c.code, pat.c.title, pat.c.code)))
    r = records
    req = (sa.select(r.c.created_at.label("date"), r.c.code.label("ref_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"),
                     inv.c.code.label("bill_no"), inv.c.type.label("bill_type"), r.c.data["refund_type"].astext.label("refund_type"),
                     r.c.data["refund_mode"].astext.label("mode"), jnum(r.c.data["amount"].astext).label("amount"),
                     r.c.data["reason"].astext.label("reason"), employees.c.name.label("by"), r.c.status)
           .select_from(r.outerjoin(pat, pat.c.id == r.c.patient_id).outerjoin(inv, sa.cast(inv.c.id, sa.Text) == r.c.data["invoice"].astext)
                        .outerjoin(employees, sa.cast(employees.c.id, sa.Text) == r.c.data["requested_by"].astext))
           .where(*rec_live("finance", "refunds"), *ts_between(r.c.created_at, p), *_search(p, r.c.code, inv.c.code, pat.c.title, pat.c.code)))
    out = await rows(ctx, paid) + await rows(ctx, req)
    if p.get("status"):
        out = [x for x in out if x["status"] == p.get("status")]
    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return Result(out, [{"label": "Refunds paid", "value": sum(f(x["amount"]) for x in out if x["refund_type"] == "Refund paid"), "format": "money"},
                        {"label": "Requests open", "value": sum(1 for x in out if x["status"] in ("Requested", "Approved")), "format": "number"},
                        {"label": "Requested amount", "value": sum(f(x["amount"]) for x in out if x["status"] in ("Requested", "Approved")),
                         "format": "money"}])


@report("FIN-08", "Discount Register", FIN,
        "Bills with a discount — gross, discount, % of the bill, the reason, the approval decision and who billed it.",
        [Col("bill_date", "Bill date", "datetime"), Col("bill_no", "Bill no", "code"), Col("type", "Type"), Col("uhid", "UHID", "code"),
         Col("patient", "Patient"), Col("gross", "Gross", "money", total=True), Col("discount", "Discount", "money", total=True),
         Col("discount_pct", "Discount %", "percent"), Col("reason", "Reason"), Col("approval", "Approval", "status"),
         Col("approved_by", "Approved by"), Col("billed_by", "Billed by"), Col("net", "Net", "money", False, total=True)],
        filters=[F.period, F.search("Bill / patient…"), F.select("type", "Bill type", ["OP", "IP", "PHARMACY", "PACKAGE"])],
        access=("billing.invoices",), finance=True, icon="BadgePercent", handles_q=True)
async def fin_discounts(ctx, p: Params) -> Result:
    inv, pat, ap = invoices, patients, approvals
    conds = [inv.c.deleted_at.is_(None), inv.c.discount > 0, inv.c.status != "Cancelled", *ts_between(inv.c.billed_at, p),
             *_search(p, inv.c.code, pat.c.code, pat.c.title)]
    if p.get("type"):
        conds.append(inv.c.type == p.get("type"))
    stmt = (sa.select(inv.c.billed_at.label("bill_date"), inv.c.code.label("bill_no"), inv.c.type, pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      inv.c.gross, inv.c.discount, inv.c.data["discount_reason"].astext.label("reason"),
                      sa.func.coalesce(ap.c.status, "Within limit").label("approval"), ap.c.decided_by.label("approved_by"),
                      u_by.c.name.label("billed_by"), inv.c.net)
            .select_from(inv.join(pat, pat.c.id == inv.c.patient_id)
                         .outerjoin(ap, sa.cast(ap.c.id, sa.Text) == inv.c.data["discount_approval"].astext)
                         .outerjoin(u_by, sa.cast(u_by.c.id, sa.Text) == inv.c.created_by))
            .where(*conds).order_by(inv.c.billed_at.desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["discount_pct"] = pct(r["discount"], r["gross"])
    return Result(out, [{"label": "Bills", "value": len(out), "format": "number"},
                        {"label": "Discount", "value": sum(f(r["discount"]) for r in out), "format": "money"},
                        {"label": "Avg discount %", "value": round(sum(r["discount_pct"] or 0 for r in out) / len(out), 1) if out else 0,
                         "format": "percent"},
                        {"label": "Needed approval", "value": sum(1 for r in out if r["approval"] != "Within limit"), "format": "number"}])


@report("FIN-09", "Cancelled Bills Register", FIN,
        "Bills cancelled in the window with the amount, who cancelled them, when and the reason from the audit trail.",
        [Col("bill_date", "Bill date", "datetime"), Col("bill_no", "Bill no", "code"), Col("type", "Type"), Col("uhid", "UHID", "code"),
         Col("patient", "Patient"), Col("net", "Net", "money", total=True), Col("cancelled_at", "Cancelled at", "datetime"),
         Col("cancelled_by", "Cancelled by"), Col("reason", "Reason")],
        filters=[F.period, F.search("Bill / patient…")], access=("billing.invoices",), finance=True, icon="FileX2", handles_q=True)
async def fin_cancelled(ctx, p: Params) -> Result:
    inv, pat, al = invoices, patients, audit_log
    last = (sa.select(al.c.record_id, sa.func.max(al.c.at).label("at")).where(al.c.action == "bill.cancel").group_by(al.c.record_id).subquery())
    al2 = al.alias("al2")
    stmt = (sa.select(inv.c.billed_at.label("bill_date"), inv.c.code.label("bill_no"), inv.c.type, pat.c.code.label("uhid"),
                      pat.c.title.label("patient"), inv.c.net, sa.func.coalesce(al2.c.at, inv.c.updated_at).label("cancelled_at"),
                      al2.c.user_name.label("cancelled_by"), al2.c.note.label("reason"))
            .select_from(inv.join(pat, pat.c.id == inv.c.patient_id).outerjoin(last, last.c.record_id == sa.cast(inv.c.id, sa.Text))
                         .outerjoin(al2, sa.and_(al2.c.record_id == last.c.record_id, al2.c.at == last.c.at, al2.c.action == "bill.cancel")))
            .where(inv.c.deleted_at.is_(None), inv.c.status == "Cancelled", *ts_between(inv.c.billed_at, p),
                   *_search(p, inv.c.code, pat.c.code, pat.c.title))
            .order_by(inv.c.billed_at.desc()))
    return Result(await rows(ctx, stmt))


@report("FIN-10", "Patient Due Register", FIN,
        "Patients with unpaid bill balances — bills, net billed, paid, due and the age of the oldest unpaid bill.",
        [Col("uhid", "UHID", "code"), Col("patient", "Patient"), Col("mobile", "Mobile"), Col("bills", "Bills", "number", total=True),
         Col("net", "Net billed", "money", total=True), Col("paid", "Paid", "money", total=True), Col("due", "Due", "money", total=True),
         Col("oldest", "Oldest unpaid", "date"), Col("age_days", "Age (days)", "number")],
        filters=[F.period, F.search("UHID / name / mobile…"), F.payer], access=("billing.invoices",), finance=True, icon="UserRoundX",
        default_period="all", handles_q=True)
async def fin_patient_due(ctx, p: Params) -> Result:
    inv, pat, en = invoices, patients, encounters
    pe = payer_expr()
    stmt = (sa.select(pat.c.code.label("uhid"), pat.c.title.label("patient"), pat.c.phone.label("mobile"), sa.func.count().label("bills"),
                      sa.func.sum(inv.c.net).label("net"), sa.func.sum(inv.c.paid).label("paid"), sa.func.sum(inv.c.balance).label("due"),
                      sa.func.min(sa.func.date(inv.c.billed_at)).label("oldest"),
                      sa.func.max(sa.func.date_part("day", sa.func.now() - inv.c.billed_at)).label("age_days"), pat.c.id.label("_pid"))
            .select_from(inv.join(pat, pat.c.id == inv.c.patient_id).outerjoin(en, en.c.id == inv.c.encounter_id))
            .where(inv.c.deleted_at.is_(None), inv.c.status.in_(["Final", "Partially Paid"]), inv.c.balance > 0, *ts_between(inv.c.billed_at, p),
                   *payer_filter(pe, p), *_search(p, pat.c.code, pat.c.title, pat.c.phone))
            .group_by(pat.c.id, pat.c.code, pat.c.title, pat.c.phone).order_by(sa.func.sum(inv.c.balance).desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["_link"] = f"/patients/{r.pop('_pid')}"
    return Result(out)


@report("FIN-11", "Expenses by Head", FIN,
        "Expenses booked in the window by expense head — count, amount, GST, TDS, paid and awaiting approval.",
        [Col("head", "Expense head"), Col("entries", "Entries", "number", total=True), Col("amount", "Amount", "money", total=True),
         Col("gst", "GST", "money", total=True), Col("tds", "TDS", "money", total=True), Col("paid", "Paid", "money", total=True),
         Col("pending", "Awaiting approval", "money", total=True), Col("share", "Share %", "percent")],
        filters=[F.period, F.department], access=("finance.expenses",), finance=True, icon="ReceiptIndianRupee",
        chart={"type": "bar", "x": "head", "y": ["amount"], "horizontal": True})
async def fin_expenses(ctx, p: Params) -> Result:
    r = records
    amt = jnum(r.c.data["amount"].astext)
    conds = [*rec_live("finance", "expenses"), *text_between(r.c.data["expense_date"].astext, p)]
    if p.get("department") and is_uuid(p.get("department")):
        conds.append(r.c.data["department"].astext == p.get("department"))
    head = sa.func.coalesce(r.c.data["expense_head"].astext, "Miscellaneous")
    stmt = (sa.select(head.label("head"), sa.func.count().label("entries"), sa.func.sum(amt).label("amount"),
                      sa.func.sum(jnum(r.c.data["gst_amount"].astext)).label("gst"), sa.func.sum(jnum(r.c.data["tds_amount"].astext)).label("tds"),
                      sa.func.coalesce(sa.func.sum(amt).filter(r.c.status == "Paid"), 0).label("paid"),
                      sa.func.coalesce(sa.func.sum(amt).filter(r.c.status == "Recorded"), 0).label("pending"))
            .where(*conds).group_by(head).order_by(sa.func.sum(amt).desc()))
    return Result(share(await rows(ctx, stmt), "amount"))


# ====================================================================== insurance / TPA

def _payer_join(r):
    py = records.alias("py")
    return py, sa.cast(py.c.id, sa.Text) == r.c.data["payer"].astext


CLAIM_OPEN = ["Draft", "Submitted", "Query", "Approved"]


@report("INS-01", "Claims Ageing", INS,
        "Claims not yet settled or rejected, aged from submission — 0–30, 31–60, 61–90, over 90 days — with the amount at stake.",
        [Col("claim", "Claim", "code"), Col("claim_no", "Payer claim no", default=False), Col("payer", "Payer / TPA"), Col("uhid", "UHID", "code"),
         Col("patient", "Patient"), Col("submitted_at", "Submitted", "datetime"), Col("age_days", "Age (days)", "number"), Col("bucket", "Bucket"),
         Col("claimed", "Claimed", "money", total=True), Col("approved", "Approved", "money", total=True), Col("status", "Status", "status")],
        filters=[F.period, F.search("Claim / patient…"), F.status(CLAIM_OPEN)], access=("insurance.claims",), finance=True, popular=True,
        icon="Timer", default_period="all", handles_q=True,
        chart={"type": "donut", "x": "bucket", "y": ["claimed"]})
async def ins_ageing(ctx, p: Params) -> Result:
    r, pat = records, patients
    py, on = _payer_join(r)
    sub = jts(r.c.data["submitted_at"].astext)
    age = sa.func.date_part("day", sa.func.now() - sa.func.coalesce(sub, r.c.created_at))
    conds = [*rec_live("insurance", "claims"), r.c.status.in_([p.get("status")] if p.get("status") else CLAIM_OPEN),
             *ts_between(sa.func.coalesce(sub, r.c.created_at), p), *_search(p, r.c.code, pat.c.title, pat.c.code)]
    stmt = (sa.select(r.c.code.label("claim"), r.c.data["claim_no"].astext.label("claim_no"), py.c.title.label("payer"), pat.c.code.label("uhid"),
                      pat.c.title.label("patient"), sub.label("submitted_at"), age.label("age_days"),
                      jnum(r.c.data["claimed_amount"].astext).label("claimed"), jnum(r.c.data["approved_amount"].astext).label("approved"),
                      r.c.status, r.c.id.label("_id"))
            .select_from(r.outerjoin(py, on).outerjoin(pat, pat.c.id == r.c.patient_id)).where(*conds).order_by(age.desc()))
    out = await rows(ctx, stmt)
    for x in out:
        a = f(x["age_days"])
        x["bucket"] = "0–30 days" if a <= 30 else "31–60 days" if a <= 60 else "61–90 days" if a <= 90 else "Over 90 days"
        x["_link"] = f"/m/insurance/claims?r={x.pop('_id')}"
    tiles = [{"label": "Open claims", "value": len(out), "format": "number"},
             {"label": "At stake", "value": sum(f(x["claimed"]) for x in out), "format": "money"}]
    for bkt in ("0–30 days", "31–60 days", "61–90 days", "Over 90 days"):
        tiles.append({"label": bkt, "value": sum(f(x["claimed"]) for x in out if x["bucket"] == bkt), "format": "money"})
    return Result(out, tiles)


@report("INS-02", "Pre-authorisation Status", INS,
        "Cashless pre-auth requests by status — requested vs approved amount, query / enhancement, and turnaround from submission to approval.",
        [Col("preauth", "Pre-auth", "code"), Col("submitted_at", "Submitted", "datetime"), Col("payer", "Payer / TPA"), Col("uhid", "UHID", "code"),
         Col("patient", "Patient"), Col("policy_no", "Policy no", default=False), Col("diagnosis", "Diagnosis", default=False),
         Col("requested", "Requested", "money", total=True), Col("approved", "Approved", "money", total=True),
         Col("approval_pct", "Approved %", "percent"), Col("tat_hours", "TAT (hours)", "number"), Col("status", "Status", "status")],
        filters=[F.period, F.search("Pre-auth / patient / policy…"),
                 F.status(["Draft", "Submitted", "Query", "Approved", "Enhancement Requested", "Rejected", "Closed"])],
        access=("insurance.preauths",), finance=True, icon="FileCheck2", handles_q=True,
        chart={"type": "donut", "x": "status", "y": ["requested"]})
async def ins_preauth(ctx, p: Params) -> Result:
    r, pat = records, patients
    py, on = _payer_join(r)
    sub, appr = jts(r.c.data["submitted_at"].astext), jts(r.c.data["approved_at"].astext)
    conds = [*rec_live("insurance", "preauths"), *ts_between(sa.func.coalesce(sub, r.c.created_at), p),
             *_search(p, r.c.code, pat.c.title, pat.c.code, r.c.data["policy_no"].astext)]
    if p.get("status"):
        conds.append(r.c.status == p.get("status"))
    stmt = (sa.select(r.c.code.label("preauth"), sub.label("submitted_at"), py.c.title.label("payer"), pat.c.code.label("uhid"),
                      pat.c.title.label("patient"), r.c.data["policy_no"].astext.label("policy_no"), r.c.data["diagnosis"].astext.label("diagnosis"),
                      jnum(r.c.data["requested_amount"].astext).label("requested"), jnum(r.c.data["approved_amount"].astext).label("approved"),
                      sa.func.round(sa.cast(sa.extract("epoch", appr - sub) / 3600, sa.Numeric), 1).label("tat_hours"), r.c.status)
            .select_from(r.outerjoin(py, on).outerjoin(pat, pat.c.id == r.c.patient_id)).where(*conds)
            .order_by(sa.func.coalesce(sub, r.c.created_at).desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["approval_pct"] = pct(x["approved"], x["requested"])
    decided = [x for x in out if x["status"] in ("Approved", "Rejected", "Closed")]
    tats = sorted(f(x["tat_hours"]) for x in out if x["tat_hours"] is not None)
    return Result(out, [{"label": "Pre-auths", "value": len(out), "format": "number"},
                        {"label": "Pending", "value": sum(1 for x in out if x["status"] in ("Submitted", "Query", "Enhancement Requested")),
                         "format": "number"},
                        {"label": "Approval rate", "value": pct(sum(1 for x in decided if x["status"] != "Rejected"), len(decided)), "format": "percent"},
                        {"label": "Median TAT (h)", "value": tats[len(tats) // 2] if tats else None, "format": "number"},
                        {"label": "Approved amount", "value": sum(f(x["approved"]) for x in out), "format": "money"}])


@report("INS-03", "Claim Disallowances", INS,
        "Claims where the payer disallowed part of the bill — claimed, approved, settled, disallowed amount and % with the reason.",
        [Col("claim", "Claim", "code"), Col("payer", "Payer / TPA"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("claimed", "Claimed", "money", total=True), Col("approved", "Approved", "money", total=True), Col("settled", "Settled", "money", total=True),
         Col("disallowance", "Disallowed", "money", total=True), Col("disallowed_pct", "Disallowed %", "percent"), Col("reason", "Reason"),
         Col("status", "Status", "status")],
        filters=[F.period, F.search("Claim / patient…")], access=("insurance.claims",), finance=True, icon="CircleSlash", handles_q=True,
        chart={"type": "bar", "x": "payer", "y": ["disallowance"], "horizontal": True})
async def ins_disallow(ctx, p: Params) -> Result:
    r, pat = records, patients
    py, on = _payer_join(r)
    dis = jnum(r.c.data["disallowance"].astext)
    stmt = (sa.select(r.c.code.label("claim"), py.c.title.label("payer"), pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      jnum(r.c.data["claimed_amount"].astext).label("claimed"), jnum(r.c.data["approved_amount"].astext).label("approved"),
                      jnum(r.c.data["settled_amount"].astext).label("settled"), dis.label("disallowance"),
                      r.c.data["disallowance_reason"].astext.label("reason"), r.c.status)
            .select_from(r.outerjoin(py, on).outerjoin(pat, pat.c.id == r.c.patient_id))
            .where(*rec_live("insurance", "claims"), dis > 0, *ts_between(r.c.created_at, p), *_search(p, r.c.code, pat.c.title, pat.c.code))
            .order_by(dis.desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["disallowed_pct"] = pct(x["disallowance"], x["claimed"])
    return Result(out)


@report("INS-04", "Payer-wise Claim Summary", INS,
        "Per insurer / TPA: claims raised, settled, rejected, under query; claimed vs settled amounts, disallowance, settlement ratio and days to settle.",
        [Col("payer", "Payer / TPA"), Col("claims", "Claims", "number", total=True), Col("settled_n", "Settled", "number", total=True),
         Col("rejected_n", "Rejected", "number", total=True), Col("open_n", "Open", "number", total=True), Col("claimed", "Claimed", "money", total=True),
         Col("settled", "Settled amount", "money", total=True), Col("tds", "TDS", "money", False, total=True),
         Col("disallowance", "Disallowed", "money", total=True), Col("settlement_ratio", "Settlement %", "percent"),
         Col("avg_days", "Avg days to settle", "number")],
        filters=[F.period], access=("insurance.claims",), finance=True, icon="Building",
        chart={"type": "bar", "x": "payer", "y": ["claimed", "settled"], "horizontal": True})
async def ins_payers(ctx, p: Params) -> Result:
    r = records
    py, on = _payer_join(r)
    sub, settled_at = jts(r.c.data["submitted_at"].astext), jts(r.c.data["settled_at"].astext)
    stmt = (sa.select(sa.func.coalesce(py.c.title, "Unassigned").label("payer"), sa.func.count().label("claims"),
                      sa.func.count().filter(r.c.status == "Settled").label("settled_n"), sa.func.count().filter(r.c.status == "Rejected").label("rejected_n"),
                      sa.func.count().filter(r.c.status.in_(CLAIM_OPEN)).label("open_n"),
                      sa.func.sum(jnum(r.c.data["claimed_amount"].astext)).label("claimed"),
                      sa.func.sum(jnum(r.c.data["settled_amount"].astext)).label("settled"), sa.func.sum(jnum(r.c.data["tds_amount"].astext)).label("tds"),
                      sa.func.sum(jnum(r.c.data["disallowance"].astext)).label("disallowance"),
                      sa.func.avg(sa.extract("epoch", settled_at - sub) / 86400).label("avg_days"))
            .select_from(r.outerjoin(py, on)).where(*rec_live("insurance", "claims"), *ts_between(r.c.created_at, p))
            .group_by(py.c.title).order_by(sa.func.count().desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["settlement_ratio"] = pct(x["settled"], x["claimed"])
        x["avg_days"] = round(f(x["avg_days"]), 1) if x["avg_days"] is not None else None
    return Result(out)


@report("INS-05", "Claim Settlement Register", INS,
        "Settled claims with the settlement date, amount, TDS deducted, disallowance and the UTR of the bank credit.",
        [Col("settled_on", "Settled on", "date"), Col("claim", "Claim", "code"), Col("claim_no", "Payer claim no"), Col("payer", "Payer / TPA"),
         Col("patient", "Patient"), Col("claimed", "Claimed", "money", total=True), Col("settled", "Settled", "money", total=True),
         Col("tds", "TDS", "money", total=True), Col("disallowance", "Disallowed", "money", total=True), Col("utr", "UTR no")],
        filters=[F.period, F.search("Claim / UTR…")], access=("insurance.claims",), finance=True, icon="Landmark", handles_q=True)
async def ins_settlements(ctx, p: Params) -> Result:
    r, pat = records, patients
    py, on = _payer_join(r)
    so = r.c.data["settled_on"].astext
    stmt = (sa.select(so.label("settled_on"), r.c.code.label("claim"), r.c.data["claim_no"].astext.label("claim_no"), py.c.title.label("payer"),
                      pat.c.title.label("patient"), jnum(r.c.data["claimed_amount"].astext).label("claimed"),
                      jnum(r.c.data["settled_amount"].astext).label("settled"), jnum(r.c.data["tds_amount"].astext).label("tds"),
                      jnum(r.c.data["disallowance"].astext).label("disallowance"), r.c.data["utr_no"].astext.label("utr"))
            .select_from(r.outerjoin(py, on).outerjoin(pat, pat.c.id == r.c.patient_id))
            .where(*rec_live("insurance", "claims"), r.c.status == "Settled", *text_between(so, p),
                   *_search(p, r.c.code, r.c.data["utr_no"].astext, pat.c.title))
            .order_by(so.desc()))
    return Result(await rows(ctx, stmt))


# ====================================================================== packages

@report("PKG-01", "Package Utilisation", PKG,
        "Admissions on a fixed-price package — package price against the actual charges posted, LOS against the package LOS, and the variance.",
        [Col("package", "Package"), Col("admissions", "Admissions", "number", total=True), Col("discharged", "Discharged", "number", total=True),
         Col("package_price", "Package price", "money"), Col("package_value", "Package value", "money", total=True),
         Col("actual", "Actual charges", "money", total=True), Col("variance", "Variance", "money", total=True),
         Col("los_days", "Package LOS", "number"), Col("alos", "Actual ALOS", "number")],
        filters=[F.period], access=("billing.packages", "ipd.admissions"), finance=True, icon="Package")
async def pkg_util(ctx, p: Params) -> Result:
    en, ch = encounters, charges
    pk = records.alias("pk")
    act = sa.select(ch.c.encounter_id, sa.func.sum(ch.c.amount).label("amt")).where(
        ch.c.deleted_at.is_(None), ch.c.status != "Cancelled").group_by(ch.c.encounter_id).subquery()
    los = sa.extract("epoch", sa.func.coalesce(en.c.ended_at, sa.func.now()) - en.c.started_at) / 86400
    price = jnum(pk.c.data["price"].astext)
    stmt = (sa.select(pk.c.title.label("package"), sa.func.count().label("admissions"),
                      sa.func.count().filter(en.c.status == "Discharged").label("discharged"), sa.func.max(price).label("package_price"),
                      sa.func.sum(price).label("package_value"), sa.func.coalesce(sa.func.sum(act.c.amt), 0).label("actual"),
                      sa.func.max(jnum(pk.c.data["los_days"].astext)).label("los_days"), sa.func.round(sa.cast(sa.func.avg(los), sa.Numeric), 1).label("alos"))
            .select_from(en.join(pk, sa.cast(pk.c.id, sa.Text) == en.c.data["package"].astext).outerjoin(act, act.c.encounter_id == en.c.id))
            .where(en.c.type == "IPD", en.c.deleted_at.is_(None), en.c.status != "Cancelled", *ts_between(en.c.started_at, p))
            .group_by(pk.c.title).order_by(sa.func.count().desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["variance"] = f(x["package_value"]) - f(x["actual"])
    return Result(out, note="Variance = package value − actual charges posted (positive means the package covered more than was consumed).")


@report("PKG-02", "Health Check-up Programme", PKG,
        "Health check-up bookings by package — booked, completed, no-show and cancelled, revenue realised and abnormal findings referred.",
        [Col("package", "Package"), Col("booked", "Booked", "number", total=True), Col("completed", "Completed", "number", total=True),
         Col("no_show", "No-show", "number", total=True), Col("cancelled", "Cancelled", "number", total=True),
         Col("abnormal", "Abnormal findings", "number", total=True), Col("revenue", "Revenue", "money", total=True),
         Col("completion_pct", "Completion %", "percent")],
        filters=[F.period, F.select("source", "Source", ["Walk-in", "Corporate", "Online", "Camp", "Referral", "Insurance"])],
        access=("crm.hc_bookings",), finance=True, icon="HeartPulse")
async def pkg_hc(ctx, p: Params) -> Result:
    r = records
    pk = records.alias("pk")
    conds = [*rec_live("crm", "hc_bookings"), *text_between(r.c.data["scheduled_date"].astext, p)]
    if p.get("source"):
        conds.append(r.c.data["source"].astext == p.get("source"))
    done = r.c.status.in_(["Completed", "Report Ready"])
    stmt = (sa.select(sa.func.coalesce(pk.c.title, "Unspecified").label("package"), sa.func.count().label("booked"),
                      sa.func.count().filter(done).label("completed"), sa.func.count().filter(r.c.status == "No-show").label("no_show"),
                      sa.func.count().filter(r.c.status == "Cancelled").label("cancelled"),
                      sa.func.count().filter(r.c.data["abnormal_findings"].astext == "true").label("abnormal"),
                      sa.func.coalesce(sa.func.sum(jnum(r.c.data["price"].astext)).filter(done), 0).label("revenue"))
            .select_from(r.outerjoin(pk, sa.cast(pk.c.id, sa.Text) == r.c.data["package"].astext)).where(*conds).group_by(pk.c.title))
    out = await rows(ctx, stmt)
    for x in out:
        x["completion_pct"] = pct(x["completed"], x["booked"])
    return Result(out)


# ====================================================================== GST

HEALTH_SAC = "999311"


def _gst_base(p: Params):
    ch, sv, inv = charges, services, invoices
    rate = sa.func.coalesce(jnum(ch.c.data["tax_percent"].astext), jnum(sv.c.data["tax_percent"].astext), 0)
    hsn = sa.func.coalesce(sa.func.nullif(sv.c.data["hsn_sac"].astext, ""),
                           sa.case((sv.c.category == "PHARM", "3004"), else_=HEALTH_SAC))
    taxable = ch.c.amount - sa.func.coalesce(ch.c.discount, 0)
    j = ch.join(inv, inv.c.id == ch.c.invoice_id).outerjoin(sv, sv.c.id == ch.c.service_id)
    conds = [ch.c.deleted_at.is_(None), ch.c.status == "Billed", inv.c.deleted_at.is_(None), inv.c.status.notin_(["Cancelled", "Draft"]),
             *ts_between(inv.c.billed_at, p)]
    return j, conds, rate, hsn, taxable


@report("GST-01", "GSTR-1 HSN / SAC Summary", GST,
        "Outward supplies for GSTR-1 table 12 — HSN / SAC, description, UQC, quantity, taxable value and CGST / SGST / IGST by rate. "
        "Healthcare services by a clinical establishment (SAC 9993) are exempt and appear at 0%.",
        [Col("hsn", "HSN / SAC", "code"), Col("description", "Description"), Col("uqc", "UQC"), Col("qty", "Total quantity", "number", total=True),
         Col("rate", "Rate %", "percent"), Col("taxable", "Taxable value", "money", total=True), Col("cgst", "CGST", "money", total=True),
         Col("sgst", "SGST / UTGST", "money", total=True), Col("igst", "IGST", "money", total=True), Col("cess", "Cess", "money", False, total=True),
         Col("total", "Total value", "money", total=True)],
        filters=[F.period], access=("billing.invoices",), finance=True, popular=True, icon="FileSpreadsheet", default_period="last_month")
async def gst_hsn(ctx, p: Params) -> Result:
    ch, sv = charges, services
    j, conds, rate, hsn, taxable = _gst_base(p)
    desc = sa.func.coalesce(sv.c.category, sa.case((ch.c.source.like("ipd.daily%"), "ROOM"), else_="OTHER"))
    stmt = (sa.select(hsn.label("hsn"), sa.func.min(desc).label("description"), sa.func.sum(ch.c.qty).label("qty"), rate.label("rate"),
                      sa.func.sum(taxable).label("taxable"))
            .select_from(j).where(*conds).group_by(hsn, rate).order_by(hsn, rate))
    from .mis import CAT_LABEL

    out = await rows(ctx, stmt)
    for x in out:
        tax = round(f(x["taxable"]) * f(x["rate"]) / 100, 2)
        x.update(description=("Health care services" if x["hsn"] == HEALTH_SAC else CAT_LABEL.get(x["description"], x["description"])),
                 uqc="NOS" if x["hsn"] == "3004" else "OTH", cgst=round(tax / 2, 2), sgst=round(tax / 2, 2), igst=0.0, cess=0.0,
                 total=round(f(x["taxable"]) + tax, 2))
    return Result(out, [{"label": "Taxable value", "value": sum(f(x["taxable"]) for x in out), "format": "money"},
                        {"label": "CGST", "value": sum(x["cgst"] for x in out), "format": "money"},
                        {"label": "SGST", "value": sum(x["sgst"] for x in out), "format": "money"},
                        {"label": "Exempt supplies", "value": sum(f(x["taxable"]) for x in out if not f(x["rate"])), "format": "money"}],
                  note="Intra-state supplies (place of supply = the hospital's state): tax split equally between CGST and SGST.")


@report("GST-02", "GST Rate-wise Summary", GST,
        "Outward supplies by GST rate — nil-rated / exempt health care, and taxable supplies (pharmacy, consumables, non-ICU room rent) — for GSTR-1 / 3B.",
        [Col("rate", "Rate %", "percent"), Col("nature", "Nature"), Col("lines", "Lines", "number", total=True),
         Col("taxable", "Taxable value", "money", total=True), Col("cgst", "CGST", "money", total=True), Col("sgst", "SGST", "money", total=True),
         Col("total", "Total value", "money", total=True)],
        filters=[F.period], access=("billing.invoices",), finance=True, icon="Percent", default_period="last_month")
async def gst_rates(ctx, p: Params) -> Result:
    j, conds, rate, hsn, taxable = _gst_base(p)
    stmt = sa.select(rate.label("rate"), sa.func.count().label("lines"), sa.func.sum(taxable).label("taxable")).select_from(j).where(
        *conds).group_by(rate).order_by(rate)
    out = await rows(ctx, stmt)
    for x in out:
        tax = round(f(x["taxable"]) * f(x["rate"]) / 100, 2)
        x.update(nature="Exempt / nil-rated" if not f(x["rate"]) else "Taxable", cgst=round(tax / 2, 2), sgst=round(tax / 2, 2),
                 total=round(f(x["taxable"]) + tax, 2))
    return Result(out)


@report("GST-03", "B2C Outward Invoice Register", GST,
        "Invoice-wise outward supplies — bill no, date, patient, taxable value, CGST and SGST and the invoice value — for GSTR-1 B2C.",
        [Col("bill_date", "Invoice date", "datetime"), Col("bill_no", "Invoice no", "code"), Col("type", "Type"), Col("patient", "Recipient"),
         Col("state", "Place of supply", default=False), Col("taxable", "Taxable value", "money", total=True), Col("cgst", "CGST", "money", total=True),
         Col("sgst", "SGST", "money", total=True), Col("invoice_value", "Invoice value", "money", total=True)],
        filters=[F.period, F.search("Invoice / patient…"), F.select("type", "Type", ["OP", "IP", "PHARMACY", "PACKAGE"])],
        access=("billing.invoices",), finance=True, icon="Receipt", default_period="last_month", handles_q=True)
async def gst_b2c(ctx, p: Params) -> Result:
    inv, pat = invoices, patients
    conds = [inv.c.deleted_at.is_(None), inv.c.status.notin_(["Cancelled", "Draft"]), *ts_between(inv.c.billed_at, p),
             *_search(p, inv.c.code, pat.c.title)]
    if p.get("type"):
        conds.append(inv.c.type == p.get("type"))
    tax = sa.func.coalesce(inv.c.tax, 0)
    stmt = (sa.select(inv.c.billed_at.label("bill_date"), inv.c.code.label("bill_no"), inv.c.type, pat.c.title.label("patient"),
                      pat.c.data["state"].astext.label("state"), (inv.c.net - tax).label("taxable"), sa.func.round(tax / 2, 2).label("cgst"),
                      sa.func.round(tax / 2, 2).label("sgst"), inv.c.net.label("invoice_value"))
            .select_from(inv.join(pat, pat.c.id == inv.c.patient_id)).where(*conds).order_by(inv.c.billed_at))
    return Result(await rows(ctx, stmt))


__all__ = ["today"]
