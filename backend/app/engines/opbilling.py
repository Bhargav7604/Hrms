"""Unified OP / ER billing counter (and posting to an IP account), built on billing.charges,
billing.invoices and billing.payments so totals match the rest of the system.

Lifecycle of a counter bill (one `billing.invoices` row, type OP):

* Draft — created as soon as a patient is picked (auto-numbered), autosaved on every edit. Lines,
  sponsor split, discounts and planned payments live in the draft's data; `billed_at` stays empty
  so drafts never count as revenue. Discarding sets it Cancelled (discarded).
* Save & Confirm (F9) — every line becomes a billing charge (existing unbilled charges such as the
  consultation captured at check-in are linked, not duplicated), the bill gets its money columns and
  `billed_at`, payments are recorded (split tender, deposit adjustment) and the status follows the
  billing engine (Final / Partially Paid / Paid). A discount above the policy limit holds the bill
  as Draft behind the `billing.discount` approval flow; payments are taken after approval.
* Afterwards — refunds (billing.refund approvals) and audited payment-mode corrections.

Money: line discount (% or ₹) → bill discount (% or ₹, pre-tax, pro-rata on GST) → net; a sponsor
(corporate / insurer / scheme) co-pay split decides the patient-payable part collected now.
"""

from __future__ import annotations

import csv
import io
import logging
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit
from ..core.security import CtxDep
from ..core.util import (
    age_from,
    bad_request,
    conflict,
    day_bounds,
    is_uuid,
    new_id,
    not_found,
    now,
    parse_date,
    to_json_value,
    today,
)
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
from ._common import E, create, find, get, require_role, update
from .billing import PaymentIn, _recalc, collect, deposit_balance, post_charge
from .workflow import on_decided, request_approval

log = logging.getLogger("vlack.opbilling")
router = APIRouter(prefix="/api/opbilling", tags=["opbilling"])

INV = "billing.invoices"
CHG = "billing.charges"
PAY = "billing.payments"
COUNTER_ROLES = ("billing", "front_office")
PAY_MODES = ["CASH", "CARD", "UPI", "WALLET", "BANK", "CHEQUE", "DEPOSIT"]
REF_MODES = {"CARD", "UPI", "WALLET", "BANK", "CHEQUE"}
LEAD_SOURCES = ["Walk-in", "Doctor referral", "Internal referral", "Corporate", "Insurance / TPA", "Health camp", "Website / online",
                "Social media", "Newspaper / TV", "Friend / family", "Employee referral", "Repeat patient", "Other"]
PAYERS = ["Self", "Corporate", "Insurance", "Government Scheme"]
ZERO = Decimal("0")
HUNDRED = Decimal("100")
OPBILLING_DEFAULTS: dict[str, Any] = {
    "discount_approval_percent": None,  # None → settings.discount_approval_percent
    "lead_sources": LEAD_SOURCES,
    "follow_up_days": 7,  # consultation within N days of the last one with the same doctor = follow-up fee
    "mode_correction_days": 0,  # same-day corrections apply directly; older ones need approval
    "require_lead_source": False,
    "allow_line_discount": True,
    "print_on_save": True,
    "default_payment_mode": "CASH",
}


def D(v: Any) -> Decimal:
    try:
        return Decimal(str(v)) if v not in (None, "") else ZERO
    except (ArithmeticError, ValueError):
        return ZERO


def q2(v: Decimal) -> Decimal:
    return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


async def ob_settings(ctx) -> dict:
    """defaults ← settings namespace "opbilling" ← Field Configuration › OP Billing screen settings."""
    s = dict(OPBILLING_DEFAULTS)
    try:
        from ..core.config_store import get_settings

        async with ctx.conn.begin_nested():
            s.update(await get_settings(ctx, "opbilling", {}))
    except Exception:  # noqa: BLE001 - optional configuration
        log.exception("opbilling settings unavailable")
    from .registration2 import screen_config

    scr = (await screen_config(ctx, "op.billing")).get("settings") or {}
    if scr.get("max_discount_percent") is not None:
        s["discount_approval_percent"] = scr["max_discount_percent"]
    for k in ("allow_line_discount", "print_on_save", "default_payment_mode"):
        if scr.get(k) is not None:
            s[k] = scr[k]
    if s.get("discount_approval_percent") in (None, ""):
        s["discount_approval_percent"] = settings.discount_approval_percent
    return s


def _counter(ctx) -> None:
    require_role(ctx, *COUNTER_ROLES)


# ------------------------------------------------------------------ the money

class Line(BaseModel):
    key: str = Field(default_factory=new_id, max_length=64)
    kind: Literal["service", "consultation", "package", "charge"] = "service"
    service_id: str | None = None
    package_id: str | None = None
    charge_id: str | None = None
    code: str | None = Field(default=None, max_length=40)
    name: str = Field(default="", max_length=300)
    category: str | None = None
    consultant_id: str | None = None
    consultant_name: str | None = Field(default=None, max_length=120)
    qty: float = Field(default=1, gt=0, le=1000)
    rate: float = Field(default=0, ge=0, le=10_000_000)
    disc_type: Literal["%", "₹"] = "%"
    disc_value: float = Field(default=0, ge=0)
    tax_percent: float = Field(default=0, ge=0, le=28)
    rate_editable: bool = False
    follow_up: bool = False


class PayLine(BaseModel):
    mode: Literal["CASH", "CARD", "UPI", "WALLET", "BANK", "CHEQUE", "DEPOSIT"]
    amount: float = Field(gt=0)
    reference: str | None = Field(default=None, max_length=80)


class DraftState(BaseModel):
    lines: list[Line] = Field(default_factory=list, max_length=100)
    payer: Literal["Self", "Corporate", "Insurance", "Government Scheme"] = "Self"
    category: str | None = Field(default=None, max_length=40)
    sponsor_id: str | None = None
    sponsor_name: str | None = Field(default=None, max_length=160)
    camp_id: str | None = None
    patient_share_type: Literal["%", "₹"] = "%"
    patient_share_value: float = Field(default=100, ge=0)
    bill_disc_type: Literal["%", "₹"] = "%"
    bill_disc_value: float = Field(default=0, ge=0)
    discount_remarks: str | None = Field(default=None, max_length=300)
    prescribed_by: str | None = None
    lead_source: str | None = Field(default=None, max_length=60)
    pay_lines: list[PayLine] = Field(default_factory=list, max_length=8)
    coupon_code: str | None = Field(default=None, max_length=40)
    referral: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=1000)


def compute(state: DraftState) -> dict:
    lines_out, gross, item_disc, tax_pre = [], ZERO, ZERO, ZERO
    for ln in state.lines:
        g = q2(D(ln.qty) * D(ln.rate))
        dv = D(ln.disc_value)
        disc = q2(g * dv / HUNDRED) if ln.disc_type == "%" else q2(dv)
        disc = min(disc, g)
        taxable = g - disc
        tax = q2(taxable * D(ln.tax_percent) / HUNDRED)
        gross += g
        item_disc += disc
        tax_pre += tax
        lines_out.append({"key": ln.key, "gross": float(g), "discount": float(disc), "tax": float(tax), "net": float(taxable + tax)})
    sub = gross - item_disc
    bv = D(state.bill_disc_value)
    bill_disc = min(q2(sub * bv / HUNDRED) if state.bill_disc_type == "%" else q2(bv), sub)
    tax = q2(tax_pre * (sub - bill_disc) / sub) if sub > 0 else ZERO
    net = q2(sub - bill_disc + tax)
    if state.payer == "Self":
        patient = net
    else:
        sv = D(state.patient_share_value)
        patient = min(q2(net * sv / HUNDRED) if state.patient_share_type == "%" else q2(sv), net)
    sponsor = net - patient
    paid_now = q2(sum((D(p.amount) for p in state.pay_lines), ZERO))
    discount = item_disc + bill_disc
    return {
        "lines": lines_out, "gross": float(gross), "item_discount": float(item_disc), "bill_discount": float(bill_disc),
        "discount": float(discount), "tax": float(tax), "net": float(net), "patient_payable": float(patient),
        "sponsor_amount": float(sponsor), "paid_now": float(paid_now), "balance": float(patient - paid_now), "saved": float(discount),
        "discount_percent": float(round(discount / gross * HUNDRED, 2)) if gross else 0.0, "items": len(state.lines),
    }


# ------------------------------------------------------------------ patients (unified OP / IP / ER lookup)

async def _active_encounters(ctx, pids: list[str]) -> dict[str, dict]:
    if not pids:
        return {}
    e = encounters
    rows = (await ctx.conn.execute(sa.select(e.c.id, e.c.patient_id, e.c.code, e.c.type, e.c.status, e.c.started_at, e.c.doctor_id).where(
        e.c.patient_id.in_(pids), e.c.deleted_at.is_(None),
        sa.or_(sa.and_(e.c.type.in_(["IPD", "DAYCARE"]), e.c.status.in_(["Admitted", "Discharge Initiated"])),
               sa.and_(e.c.type == "ER", e.c.status.in_(["Waiting", "In Treatment", "Observation"])),
               sa.and_(e.c.type.in_(["OPD", "TELE"]), e.c.status == "Open", e.c.started_at >= day_bounds(today())[0])))
        .order_by(e.c.started_at.desc()))).all()
    rank = {"IPD": 0, "DAYCARE": 0, "ER": 1, "OPD": 2, "TELE": 2}
    out: dict[str, dict] = {}
    for r in sorted(rows, key=lambda r: rank.get(r.type, 9)):
        pid = str(r.patient_id)
        if pid in out:
            continue
        kind = "IP" if r.type in ("IPD", "DAYCARE") else "ER" if r.type == "ER" else "OP"
        out[pid] = {"id": str(r.id), "code": r.code, "type": r.type, "kind": kind, "status": r.status,
                    "started_at": to_json_value(r.started_at), "doctor_id": str(r.doctor_id) if r.doctor_id else None}
    return out


def _patient_row(r, enc: dict | None, sponsor: str | None) -> dict:
    d = r.data or {}
    return {"id": str(r.id), "uhid": r.code, "name": r.title, "age": age_from(r.dob), "gender": r.gender, "phone": r.phone,
            "aadhaar": r.id_number, "registered_at": to_json_value(r.created_at), "category": d.get("category") or "General",
            "payer_type": d.get("payer_type") or "Cash", "sponsor_id": d.get("sponsor"), "sponsor": sponsor, "status": r.status,
            "encounter": enc}


async def _sponsor_names(ctx, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(records.c.id, records.c.title).where(records.c.id.in_(ids)))).all()
    return {str(i): t for i, t in rows}


@router.get("/patients")
async def search_patients(ctx: CtxDep, uhid: str | None = None, name: str | None = None, aadhaar: str | None = None,
                          mobile: str | None = None, q: str | None = None, kind: Literal["OP", "IP", "ER"] | None = None, limit: int = 15):
    """Find a patient by UHID / name / Aadhaar / mobile (numbers: at least 5 digits) — OP, IP and ER alike.
    `kind` alone lists the patients currently in that setting (e.g. everyone in the ER now)."""
    _counter(ctx)
    if kind and not any((uhid, name, aadhaar, mobile, q)):
        e = encounters
        types = {"IP": ["IPD", "DAYCARE"], "ER": ["ER"], "OP": ["OPD", "TELE"]}[kind]
        sts = {"IP": ["Admitted", "Discharge Initiated"], "ER": ["Waiting", "In Treatment", "Observation"], "OP": ["Open"]}[kind]
        ids = [str(i) for i in (await ctx.conn.execute(sa.select(e.c.patient_id).where(
            e.c.type.in_(types), e.c.status.in_(sts), e.c.deleted_at.is_(None)).order_by(e.c.started_at.desc()).limit(60))).scalars().all()]
        if not ids:
            return []
        rows = (await ctx.conn.execute(sa.select(patients).where(patients.c.id.in_(ids)))).all()
        encs = await _active_encounters(ctx, ids)
        spons = await _sponsor_names(ctx, {(r.data or {}).get("sponsor") for r in rows})
        out = [_patient_row(r, encs.get(str(r.id)), spons.get((r.data or {}).get("sponsor") or "")) for r in rows]
        return [x for x in out if (x["encounter"] or {}).get("kind") == kind][:max(1, min(limit, 60))]
    from .registration2 import aadhaar_hash, digits, valid_aadhaar

    t = patients
    conds = [t.c.deleted_at.is_(None), sa.func.coalesce(t.c.status, "Active") != "Merged"]
    used = False

    def num(v: str | None) -> str:
        return digits(v)

    if uhid and len(uhid.strip()) >= 5:
        conds.append(t.c.code.ilike(f"%{uhid.strip()}%"))
        used = True
    if name and len(name.strip()) >= 2:
        for part in name.strip().split()[:3]:
            conds.append(t.c.title.ilike(f"%{part}%"))
        used = True
    if mobile and len(num(mobile)) >= 5:
        conds.append(t.c.phone.like(f"%{num(mobile)}%"))
        used = True
    if aadhaar and len(num(aadhaar)) >= 4:
        a = num(aadhaar)
        if len(a) == 12 and valid_aadhaar(a):
            conds.append(sa.or_(t.c.data["aadhaar_hash"].astext == aadhaar_hash(a), t.c.id_number.like(f"%{a[-4:]}")))
        else:
            conds.append(t.c.id_number.like(f"%{a[-4:]}"))
        used = True
    if q and q.strip():
        term = q.strip()
        d = num(term)
        if len(d) >= 5:
            conds.append(sa.or_(t.c.phone.like(f"%{d}%"), t.c.code.ilike(f"%{term}%")))
        elif len(term) >= 2:
            conds.append(sa.or_(t.c.title.ilike(f"%{term}%"), t.c.code.ilike(f"%{term}%")))
        else:
            return []
        used = True
    if not used:
        return []
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(t.c.created_at.desc()).limit(max(1, min(limit, 30))))).all()
    pids = [str(r.id) for r in rows]
    encs = await _active_encounters(ctx, pids)
    spons = await _sponsor_names(ctx, {(r.data or {}).get("sponsor") for r in rows})
    out = [_patient_row(r, encs.get(str(r.id)), spons.get((r.data or {}).get("sponsor") or "")) for r in rows]
    return [x for x in out if (x["encounter"] or {}).get("kind") == kind] if kind else out


async def _patient(ctx, pid: str) -> dict:
    if not is_uuid(pid):
        raise not_found("Patient not found")
    r = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid, patients.c.deleted_at.is_(None)))).first()
    if not r:
        raise not_found("Patient not found")
    if r.status == "Merged":
        raise conflict("This UHID was merged into another record — bill the surviving UHID")
    encs = await _active_encounters(ctx, [pid])
    spons = await _sponsor_names(ctx, {(r.data or {}).get("sponsor")})
    return _patient_row(r, encs.get(pid), spons.get((r.data or {}).get("sponsor") or ""))


async def _visit(ctx, pid: str) -> dict | None:
    """Today's OP visit (latest appointment) for the banner: doctor, visit type, reason."""
    a = appointments
    r = (await ctx.conn.execute(sa.select(a.c.id, a.c.code, a.c.doctor_id, a.c.type, a.c.status, a.c.encounter_id, a.c.data, employees.c.name)
                                .select_from(a.outerjoin(employees, employees.c.id == a.c.doctor_id))
                                .where(a.c.patient_id == pid, a.c.appt_date == today(), a.c.deleted_at.is_(None),
                                       a.c.status.notin_(["Cancelled", "No-show"]))
                                .order_by(a.c.created_at.desc()).limit(1))).first()
    if not r:
        return None
    d = r.data or {}
    return {"appointment_id": str(r.id), "code": r.code, "doctor_id": str(r.doctor_id) if r.doctor_id else None, "doctor": r.name,
            "visit_type": r.type, "status": r.status, "reason": d.get("reason"), "priority": d.get("visit_priority") or "Normal",
            "encounter_id": str(r.encounter_id) if r.encounter_id else None}


async def _unbilled_op(ctx, pid: str) -> list[dict]:
    """Unbilled charges that belong on an OP bill (not on an IP admission's account)."""
    c, e = charges, encounters
    rows = (await ctx.conn.execute(
        sa.select(c, services.c.code.label("svc_code"), services.c.category.label("svc_cat"))
        .select_from(c.outerjoin(e, e.c.id == c.c.encounter_id).outerjoin(services, services.c.id == c.c.service_id))
        .where(c.c.patient_id == pid, c.c.status == "Unbilled", c.c.deleted_at.is_(None),
               sa.or_(c.c.encounter_id.is_(None), e.c.type.notin_(["IPD", "DAYCARE"])))
        .order_by(c.c.charged_at.asc()).limit(100))).all()
    out = []
    for r in rows:
        m = dict(r._mapping)
        code, cat = m.pop("svc_code"), m.pop("svc_cat")
        rec = rs.to_record(m)
        out.append({"id": rec["id"], "code": code or rec.get("code"), "description": rec.get("description"), "category": cat,
                    "service_id": rec.get("service_id"), "qty": rec.get("qty"), "rate": rec.get("rate"), "amount": rec.get("amount"),
                    "source": rec.get("source"), "source_id": rec.get("source_id"), "encounter_id": rec.get("encounter_id"),
                    "charged_at": rec.get("charged_at"), "tax_percent": rec.get("tax_percent") or 0})
    return out


async def _consultant_of(ctx, ch: dict) -> tuple[str | None, str | None]:
    if ch.get("source") == "appointments.appointments" and ch.get("source_id"):
        r = (await ctx.conn.execute(sa.select(appointments.c.doctor_id, employees.c.name).select_from(
            appointments.outerjoin(employees, employees.c.id == appointments.c.doctor_id)).where(appointments.c.id == ch["source_id"]))).first()
        if r and r.doctor_id:
            return str(r.doctor_id), r.name
    return None, None


async def _line_from_charge(ctx, ch: dict) -> dict:
    cid, cname = await _consultant_of(ctx, ch)
    return Line(kind="charge", charge_id=ch["id"], service_id=ch.get("service_id"), code=ch.get("code"),
                name=(ch.get("description") or "Charge")[:300], category=ch.get("category"), consultant_id=cid, consultant_name=cname,
                qty=float(ch.get("qty") or 1), rate=float(ch.get("rate") or 0), tax_percent=float(ch.get("tax_percent") or 0)).model_dump()


# ------------------------------------------------------------------ catalogue: services, consultations, packages

def _rate_for(svc: dict, category: str | None) -> float:
    if category == "International" and svc.get("rate_international"):
        return float(svc["rate_international"])
    return float(svc.get("rate") or 0)


@router.get("/catalog")
async def catalog(ctx: CtxDep, tab: Literal["services", "consultation", "packages"] = "services", q: str = "", category: str | None = None,
                  patient_id: str | None = None, limit: int = 25):
    _counter(ctx)
    term = q.strip()
    lim = max(1, min(limit, 60))
    if tab == "consultation":
        return await _doctors(ctx, term, patient_id, lim)
    s = services
    conds = [s.c.deleted_at.is_(None), sa.func.coalesce(s.c.status, "Active") == "Active"]
    if tab == "packages":  # health checks, profiles and panels (IP surgical packages are billed on the IP account)
        conds.append(sa.or_(s.c.category == "PACKAGE", sa.and_(s.c.category == "LAB", sa.or_(s.c.title.ilike("%profile%"),
                                                                                                s.c.title.ilike("%panel%")))))
        conds.append(sa.not_(s.c.title.op("~*")("delivery|caesarean|section package|ivf")))
    else:
        conds.append(s.c.category.notin_(["PACKAGE", "ROOM", "ICU", "NURSING"]))
        if category:
            conds.append(s.c.category == category.upper())
    if term:
        conds.append(sa.or_(s.c.title.ilike(f"%{term}%"), s.c.code.ilike(f"%{term}%")))
    rows = (await ctx.conn.execute(sa.select(s).where(*conds).order_by(s.c.title).limit(lim))).all()
    pat_cat = None
    if patient_id and is_uuid(patient_id):
        pat_cat = (await ctx.conn.execute(sa.select(patients.c.data["category"].astext).where(patients.c.id == patient_id))).scalar()
    out = []
    for r in rows:
        rec = rs.to_record(r)
        out.append({"kind": "package" if tab == "packages" else "service", "service_id": rec["id"], "code": rec.get("code"),
                    "name": rec.get("name") or rec.get("title"), "category": rec.get("category"), "rate": _rate_for(rec, pat_cat),
                    "tax_percent": float(rec.get("tax_percent") or 0), "tat_minutes": rec.get("tat_minutes"),
                    "rate_editable": float(rec.get("rate") or 0) == 0 or rec.get("category") == "MISC"})
    if tab == "packages":
        for p in await find(ctx, "billing.packages", status="Active", q=term or None, limit=lim):
            if p.get("los_days") or p.get("room_category"):
                continue  # in-patient package
            inc = []
            for ln in p.get("inclusions") or []:
                inc.append(p.get("_refs", {}).get(ln.get("service"), "Service"))
            out.append({"kind": "package", "package_id": p["id"], "code": p.get("code"), "name": p.get("name"), "category": "PACKAGE",
                        "rate": float(p.get("price") or 0), "tax_percent": 0, "inclusions": inc, "specialty": p.get("specialty"),
                        "rate_editable": False})
    return out


async def _last_consult(ctx, pid: str | None, doctor_ids: list[str]) -> dict[str, date]:
    if not pid or not is_uuid(pid) or not doctor_ids:
        return {}
    a = appointments
    rows = (await ctx.conn.execute(sa.select(a.c.doctor_id, sa.func.max(a.c.appt_date)).where(
        a.c.patient_id == pid, a.c.doctor_id.in_(doctor_ids), a.c.status.in_(["Completed", "In Consultation", "Checked-in"]),
        a.c.appt_date < today(), a.c.deleted_at.is_(None)).group_by(a.c.doctor_id))).all()
    return {str(d): v for d, v in rows}


async def _doctors(ctx, term: str, patient_id: str | None, lim: int) -> list[dict]:
    e = employees
    conds = [e.c.deleted_at.is_(None), e.c.category == "Doctor", sa.func.coalesce(e.c.status, "Active") == "Active"]
    if term:
        conds.append(sa.or_(e.c.name.ilike(f"%{term}%"), e.c.code.ilike(f"%{term}%"), e.c.data["specialization"].astext.ilike(f"%{term}%")))
    rows = (await ctx.conn.execute(sa.select(e.c.id, e.c.code, e.c.name, e.c.department_id, e.c.data).where(*conds).order_by(e.c.name).limit(lim))).all()
    depts = await _sponsor_names(ctx, {str(r.department_id) for r in rows if r.department_id})
    tariff = {r.code: float(r.rate or 0) for r in (await ctx.conn.execute(sa.select(services.c.code, services.c.rate).where(
        services.c.code.in_(["CONS-OPD", "CONS-FOLLOWUP"])))).all()}
    s = await ob_settings(ctx)
    last = await _last_consult(ctx, patient_id, [str(r.id) for r in rows])
    out = []
    for r in rows:
        d = r.data or {}
        fee = float(d.get("consult_fee") or 0) or tariff.get("CONS-OPD", 0)
        prev = last.get(str(r.id))
        follow = bool(prev and (today() - prev).days <= int(s.get("follow_up_days") or 0))
        follow_fee = tariff.get("CONS-FOLLOWUP", 0) if d.get("follow_up_fee") in (None, "") else float(d["follow_up_fee"])
        out.append({"kind": "consultation", "consultant_id": str(r.id), "code": r.code, "name": r.name,
                    "department": depts.get(str(r.department_id) or ""), "specialization": d.get("specialization"),
                    "rate": follow_fee if follow else fee, "new_fee": fee, "follow_up_fee": follow_fee, "follow_up": follow,
                    "last_visit": prev.isoformat() if prev else None, "tax_percent": 0, "rate_editable": False})
    return out


@router.get("/price-check")
async def price_check(ctx: CtxDep, q: str = "", limit: int = 30):
    """Tariff look-up without billing: every rate a service carries."""
    _counter(ctx)
    term = q.strip()
    if len(term) < 2:
        return []
    s = services
    rows = (await ctx.conn.execute(sa.select(s).where(s.c.deleted_at.is_(None), sa.or_(s.c.title.ilike(f"%{term}%"), s.c.code.ilike(f"%{term}%")))
                                   .order_by(s.c.title).limit(max(1, min(limit, 60))))).all()
    out = []
    for r in rows:
        rec = rs.to_record(r)
        out.append({k: rec.get(k) for k in ("id", "code", "name", "category", "rate", "rate_private", "rate_icu", "rate_international",
                                            "tax_percent", "hsn_sac", "tat_minutes", "status")})
    return out


# ------------------------------------------------------------------ drafts

def _state_of(inv: dict) -> DraftState:
    raw = inv.get("bill") or {}
    try:
        return DraftState.model_validate(raw)
    except Exception:  # noqa: BLE001 - a draft written by an older client: keep what validates
        return DraftState(lines=[Line.model_validate(x) for x in raw.get("lines") or [] if isinstance(x, dict)])


async def _bill_out(ctx, inv: dict, *, with_patient: bool = True) -> dict:
    state = _state_of(inv)
    totals = compute(state)
    out = {k: inv.get(k) for k in ("id", "code", "status", "type", "patient_id", "encounter_id", "payer", "gross", "discount", "tax", "net",
                                    "paid", "balance", "billed_at", "created_at", "updated_at", "counter", "visit", "discount_approval",
                                    "discarded", "discard_reason", "confirmed_by", "created_by_name")}
    out["state"] = state.model_dump()
    out["totals"] = totals
    out["label"] = _status_label(inv)
    if with_patient and inv.get("patient_id"):
        out["patient"] = await _patient(ctx, inv["patient_id"])
        out["deposit_balance"] = float(await deposit_balance(ctx, inv["patient_id"]))
    if inv.get("discount_approval"):
        appr = await get(ctx, "workflow.approvals", inv["discount_approval"])
        out["approval"] = {k: appr.get(k) for k in ("id", "code", "status", "approver_role", "summary", "comments", "decided_by")} if appr else None
    return out


def _status_label(inv: dict) -> dict:
    st = inv.get("status")
    if st == "Cancelled":
        return {"status": "DISCARDED" if inv.get("discarded") else "CANCELLED", "sub": None}
    if st == "Draft":
        if inv.get("billed_at"):
            return {"status": "PENDING APPROVAL", "sub": "DISCOUNT"}
        return {"status": "DRAFT", "sub": "PENDING"}
    patient_due = float(inv.get("patient_due") if inv.get("patient_due") is not None else inv.get("balance") or 0)
    return {"status": "CONFIRMED", "sub": "PAID" if patient_due <= 0.009 else "DUE"}


async def _load_draft(ctx, bill_id: str, *, lock: bool = False) -> dict:
    if not is_uuid(bill_id):
        raise not_found("Bill not found")
    if lock:
        await ctx.conn.execute(sa.select(invoices.c.id).where(invoices.c.id == bill_id).with_for_update())
    inv = await get(ctx, INV, bill_id)
    if not inv or inv.get("type") not in ("OP", None):
        raise not_found("Bill not found")
    return inv


def _editable(inv: dict) -> None:
    if inv.get("status") != "Draft" or inv.get("billed_at"):
        raise conflict(f"Bill {inv.get('code')} is {_status_label(inv)['status'].lower()} — it can no longer be edited")


class NewDraftIn(BaseModel):
    patient_id: str
    charge_ids: list[str] = Field(default_factory=list, max_length=50)
    include_unbilled: bool = False
    counter: Literal["OP", "ER"] | None = None


@router.post("/drafts", status_code=201)
async def new_draft(body: NewDraftIn, ctx: CtxDep):
    """Start (or resume) the counter bill for a patient — auto-numbered and saved as a draft."""
    _counter(ctx)
    p = await _patient(ctx, body.patient_id)
    enc = p.get("encounter") or {}
    t = invoices
    existing = (await ctx.conn.execute(sa.select(t.c.id).where(
        t.c.patient_id == body.patient_id, t.c.status == "Draft", t.c.billed_at.is_(None), t.c.deleted_at.is_(None),
        t.c.created_by == ctx.user_id, t.c.data["source"].astext == "opbilling",
        t.c.created_at >= day_bounds(today())[0]).order_by(t.c.created_at.desc()).limit(1))).first()
    unbilled = await _unbilled_op(ctx, body.patient_id)
    pick = set(body.charge_ids)
    wanted = [c for c in unbilled if c["id"] in pick or body.include_unbilled]
    if existing:
        inv = await get(ctx, INV, str(existing.id))
        state = _state_of(inv)
        have = {ln.charge_id for ln in state.lines if ln.charge_id}
        add = [Line.model_validate(await _line_from_charge(ctx, c)) for c in wanted if c["id"] not in have]
        if add:
            state.lines.extend(add)
            inv = await update(ctx, INV, inv["id"], {"bill": state.model_dump(), "totals": compute(state)})
        return await _with_unbilled(ctx, inv)
    visit = await _visit(ctx, body.patient_id)
    payer = {"Insurance": "Insurance", "Corporate": "Corporate", "Government Scheme": "Government Scheme"}.get(p.get("payer_type") or "", "Self")
    state = DraftState(
        lines=[Line.model_validate(await _line_from_charge(ctx, c)) for c in wanted], payer=payer, category=p.get("category"),
        sponsor_id=p.get("sponsor_id") if payer != "Self" else None, sponsor_name=p.get("sponsor") if payer != "Self" else None,
        patient_share_value=100 if payer == "Self" else 0, prescribed_by=(visit or {}).get("doctor_id"),
        lead_source="Walk-in" if visit else None,
    )
    counter = body.counter or ("ER" if enc.get("kind") == "ER" else "OP")
    inv = await create(ctx, INV, {
        "patient_id": body.patient_id, "encounter_id": enc.get("id") if enc.get("kind") in ("OP", "ER") else (visit or {}).get("encounter_id"),
        "type": "OP", "payer": payer, "gross": 0, "discount": 0, "tax": 0, "net": 0, "paid": 0, "balance": 0, "status": "Draft",
        "source": "opbilling", "counter": counter, "visit": visit, "bill": state.model_dump(), "totals": compute(state),
        "created_by_name": ctx.user.get("name"),
    })
    return await _with_unbilled(ctx, inv)


async def _with_unbilled(ctx, inv: dict) -> dict:
    out = await _bill_out(ctx, inv)
    if inv.get("status") == "Draft" and not inv.get("billed_at"):
        have = {ln["charge_id"] for ln in out["state"]["lines"] if ln.get("charge_id")}
        out["unbilled"] = [c for c in await _unbilled_op(ctx, inv["patient_id"]) if c["id"] not in have]
    return out


@router.get("/drafts")
async def list_drafts(ctx: CtxDep, scope: Literal["mine", "all"] = "mine", days: int = 7):
    _counter(ctx)
    t, p = invoices, patients
    conds = [t.c.status == "Draft", t.c.billed_at.is_(None), t.c.deleted_at.is_(None), t.c.data["source"].astext == "opbilling",
             t.c.created_at >= day_bounds(today() - timedelta(days=max(0, min(days, 90))))[0]]
    if scope == "mine":
        conds.append(t.c.created_by == ctx.user_id)
    rows = (await ctx.conn.execute(sa.select(t, p.c.title.label("p_name"), p.c.code.label("p_uhid"), p.c.phone.label("p_phone"))
                                   .select_from(t.join(p, p.c.id == t.c.patient_id)).where(*conds)
                                   .order_by(t.c.updated_at.desc().nulls_last()).limit(200))).all()
    out = []
    for r in rows:
        m = dict(r._mapping)
        extra = {k: m.pop(k) for k in ("p_name", "p_uhid", "p_phone")}
        inv = rs.to_record(m)
        tot = inv.get("totals") or {}
        out.append({"id": inv["id"], "code": inv["code"], "patient": extra["p_name"], "uhid": extra["p_uhid"], "phone": extra["p_phone"],
                    "items": tot.get("items", 0), "net": tot.get("net", 0), "updated_at": inv.get("updated_at"),
                    "created_by_name": inv.get("created_by_name"), "mine": inv.get("created_by") == ctx.user_id})
    return out


@router.get("/drafts/{bill_id}")
async def get_draft(bill_id: str, ctx: CtxDep):
    _counter(ctx)
    return await _with_unbilled(ctx, await _load_draft(ctx, bill_id))


async def _normalise_state(ctx, state: DraftState, patient_category: str | None) -> DraftState:
    """Server-side prices: tariff services and packages at master rates, consultations at the doctor's fee,
    captured charges at their charged rate. Only unpriced / misc services take a typed rate."""
    svc_ids = [ln.service_id for ln in state.lines if ln.service_id and is_uuid(ln.service_id) and ln.kind in ("service", "package")]
    svcs = {str(r.id): rs.to_record(r) for r in (await ctx.conn.execute(sa.select(services).where(services.c.id.in_(svc_ids)))).all()} if svc_ids else {}
    pkg_ids = [ln.package_id for ln in state.lines if ln.package_id and is_uuid(ln.package_id)]
    pkgs = {p["id"]: p for p in [await get(ctx, "billing.packages", i) for i in pkg_ids] if p}
    ch_ids = [ln.charge_id for ln in state.lines if ln.charge_id and is_uuid(ln.charge_id)]
    chs = {str(r.id): r for r in (await ctx.conn.execute(sa.select(charges.c.id, charges.c.rate, charges.c.status, charges.c.patient_id)
                                                          .where(charges.c.id.in_(ch_ids)))).all()} if ch_ids else {}
    doc_ids = [ln.consultant_id for ln in state.lines if ln.kind == "consultation" and ln.consultant_id and is_uuid(ln.consultant_id)]
    docs = {d["consultant_id"]: d for d in await _doctors_by_id(ctx, doc_ids)} if doc_ids else {}
    seen_keys: set[str] = set()
    out = []
    for ln in state.lines:
        if ln.key in seen_keys:
            ln.key = new_id()
        seen_keys.add(ln.key)
        if ln.kind in ("service", "package") and ln.service_id:
            svc = svcs.get(ln.service_id)
            if not svc:
                raise bad_request(f"Unknown service on line '{ln.name}'")
            master = _rate_for(svc, patient_category)
            editable = float(svc.get("rate") or 0) == 0 or svc.get("category") == "MISC"
            ln.rate_editable = editable
            if not editable:
                ln.rate = master
            ln.code, ln.name = svc.get("code"), svc.get("name") or svc.get("title") or ln.name
            ln.category, ln.tax_percent = svc.get("category"), float(svc.get("tax_percent") or 0)
        elif ln.kind == "package" and ln.package_id:
            pkg = pkgs.get(ln.package_id)
            if not pkg:
                raise bad_request(f"Unknown package on line '{ln.name}'")
            ln.rate, ln.name, ln.code, ln.category, ln.rate_editable = float(pkg.get("price") or 0), pkg.get("name") or ln.name, pkg.get("code"), "PACKAGE", False
        elif ln.kind == "consultation":
            doc = docs.get(ln.consultant_id or "")
            if not doc:
                raise bad_request("Choose the consulting doctor for the consultation line")
            ln.consultant_name = doc["name"]
            ln.rate = doc["follow_up_fee"] if ln.follow_up else doc["new_fee"]
            ln.name = f"{'Follow-up' if ln.follow_up else 'OP'} consultation — {doc['name']}"
            ln.code, ln.category, ln.rate_editable = "CONS-FOLLOWUP" if ln.follow_up else "CONS-OPD", "CONSULT", False
        elif ln.kind == "charge":
            ch = chs.get(ln.charge_id or "")
            if not ch:
                raise bad_request(f"Charge on line '{ln.name}' no longer exists")
            ln.rate = float(ch.rate or 0)
            ln.rate_editable = False
        else:
            raise bad_request(f"Line '{ln.name}' has no service")
        if ln.disc_type == "%" and ln.disc_value > 100:
            raise bad_request(f"Discount on '{ln.name}' cannot exceed 100%")
        out.append(ln)
    state.lines = out
    if state.bill_disc_type == "%" and state.bill_disc_value > 100:
        raise bad_request("Bill discount cannot exceed 100%")
    if state.payer != "Self" and state.patient_share_type == "%" and state.patient_share_value > 100:
        raise bad_request("Patient share cannot exceed 100%")
    if state.payer == "Self":
        state.sponsor_id, state.sponsor_name, state.patient_share_type, state.patient_share_value = None, None, "%", 100
    elif state.sponsor_id and is_uuid(state.sponsor_id) and not state.sponsor_name:
        state.sponsor_name = (await _sponsor_names(ctx, {state.sponsor_id})).get(state.sponsor_id)
    return state


async def _doctors_by_id(ctx, ids: list[str]) -> list[dict]:
    e = employees
    rows = (await ctx.conn.execute(sa.select(e.c.id, e.c.name, e.c.data).where(e.c.id.in_(ids), e.c.category == "Doctor"))).all()
    tariff = {r.code: float(r.rate or 0) for r in (await ctx.conn.execute(sa.select(services.c.code, services.c.rate).where(
        services.c.code.in_(["CONS-OPD", "CONS-FOLLOWUP"])))).all()}
    out = []
    for r in rows:
        d = r.data or {}
        out.append({"consultant_id": str(r.id), "name": r.name, "new_fee": float(d.get("consult_fee") or 0) or tariff.get("CONS-OPD", 0),
                    "follow_up_fee": float(d["follow_up_fee"]) if d.get("follow_up_fee") not in (None, "") else tariff.get("CONS-FOLLOWUP", 0)})
    return out


@router.put("/drafts/{bill_id}")
async def save_draft(bill_id: str, body: DraftState, ctx: CtxDep):
    """Autosave: the whole counter state; returns the server-computed totals."""
    _counter(ctx)
    inv = await _load_draft(ctx, bill_id, lock=True)
    _editable(inv)
    p = await _patient(ctx, inv["patient_id"])
    state = await _normalise_state(ctx, body, body.category or p.get("category"))
    totals = compute(state)
    inv = await update(ctx, INV, bill_id, {"bill": state.model_dump(), "totals": totals, "payer": state.payer})
    return {"id": inv["id"], "code": inv["code"], "state": state.model_dump(), "totals": totals, "saved_at": inv.get("updated_at"),
            "label": _status_label(inv)}


class DiscardIn(BaseModel):
    reason: str | None = Field(default=None, max_length=300)


@router.post("/drafts/{bill_id}/discard")
async def discard(bill_id: str, body: DiscardIn, ctx: CtxDep):
    _counter(ctx)
    inv = await _load_draft(ctx, bill_id, lock=True)
    _editable(inv)
    rec = await update(ctx, INV, bill_id, {"status": "Cancelled", "discarded": True, "discard_reason": body.reason or "Discarded at the counter",
                                           "balance": 0})
    await audit(ctx, "bill.discard", module="billing", entity="invoices", record=rec, note=body.reason)
    return {"id": rec["id"], "code": rec["code"], "label": _status_label(rec)}


# ------------------------------------------------------------------ confirm (F9)

class ConfirmIn(BaseModel):
    state: DraftState | None = None


async def _materialise(ctx, inv: dict, state: DraftState, totals: dict) -> list[str]:
    """Turn every line into a billing charge on this bill (existing unbilled charges are linked)."""
    by_key = {x["key"]: x for x in totals["lines"]}
    enc_id = inv.get("encounter_id")
    ids = []
    for ln in state.lines:
        t = by_key[ln.key]
        meta = {"consultant": ln.consultant_id, "consultant_name": ln.consultant_name, "line_discount_type": ln.disc_type,
                "line_discount_value": ln.disc_value, "line_net": t["net"], "line_tax": t["tax"], "bill_line_key": ln.key}
        if ln.charge_id:
            ch = await get(ctx, CHG, ln.charge_id)
            if not ch or ch.get("patient_id") != inv["patient_id"]:
                raise conflict(f"'{ln.name}' is not a charge of this patient")
            if ch.get("status") != "Unbilled":
                raise conflict(f"'{ln.name}' was billed elsewhere ({ch.get('status')}) — remove it from this bill")
            ch = await update(ctx, CHG, ch["id"], {"qty": ln.qty, "rate": ln.rate, "amount": t["gross"], "discount": t["discount"], **meta})
        else:
            ch = await post_charge(ctx, patient_id=inv["patient_id"], encounter_id=enc_id,
                                   service_id=ln.service_id if ln.kind in ("service", "package") else None,
                                   service_code=ln.code if ln.kind == "consultation" else None,
                                   qty=ln.qty, rate=ln.rate, description=ln.name, source="opbilling", source_id=inv["id"])
            ch = await update(ctx, CHG, ch["id"], {"discount": t["discount"], "tax_percent": ln.tax_percent,
                                                   **({"package": ln.package_id} if ln.package_id else {}), **meta})
        ids.append(ch["id"])
    if ids:
        await ctx.conn.execute(charges.update().where(charges.c.id.in_(ids)).values(
            status="Billed", invoice_id=inv["id"], updated_at=now(), updated_by=ctx.user_id))
    return ids


async def _take_payments(ctx, inv: dict, state: DraftState) -> list[dict]:
    done = []
    for p in state.pay_lines:
        if p.mode == "DEPOSIT":
            avail = await deposit_balance(ctx, inv["patient_id"])
            if D(p.amount) > avail + Decimal("0.01"):
                raise bad_request(f"Only ₹{q2(avail)} of the advance is unused")
            pay = await create(ctx, PAY, {"patient_id": inv["patient_id"], "invoice_id": inv["id"], "kind": "ADJUSTMENT", "mode": "DEPOSIT",
                                          "amount": float(q2(D(p.amount))), "paid_at": now().isoformat(), "reference": "Advance adjusted",
                                          "received_by": ctx.user.get("name"), "status": "Success"})
            await _recalc(ctx, inv["id"])
        else:
            pay = await collect(PaymentIn(patient_id=inv["patient_id"], invoice_id=inv["id"], kind="PAYMENT", mode=p.mode,
                                          amount=float(q2(D(p.amount))), reference=p.reference), ctx)
        done.append({k: pay.get(k) for k in ("id", "code", "mode", "amount", "reference")})
    return done


async def confirm_bill(ctx, inv: dict, state: DraftState) -> dict:
    p = await _patient(ctx, inv["patient_id"])
    state = await _normalise_state(ctx, state, state.category or p.get("category"))
    totals = compute(state)
    s = await ob_settings(ctx)
    if not state.lines:
        raise bad_request("Add at least one service before confirming the bill")
    if not s.get("allow_line_discount", True) and any(ln.disc_value for ln in state.lines):
        raise bad_request("Line discounts are switched off — use the bill discount")
    if totals["discount"] > 0 and not (state.discount_remarks or "").strip():
        raise bad_request("Give a reason for the discount", {"fields": {"discount_remarks": "Required for any discount"}})
    if s.get("require_lead_source") and not state.lead_source:
        raise bad_request("Choose the lead source", {"fields": {"lead_source": "Required"}})
    if state.payer != "Self" and not (state.sponsor_id or state.sponsor_name):
        raise bad_request("Choose the sponsor for a corporate / insurance / scheme bill", {"fields": {"sponsor_id": "Required"}})
    for i, pl in enumerate(state.pay_lines):
        if pl.mode in REF_MODES and not (pl.reference or "").strip():
            raise bad_request(f"Payment {i + 1}: enter the {pl.mode} transaction / cheque reference",
                              {"fields": {f"pay_lines.{i}.reference": "Required"}})
    if totals["paid_now"] > totals["patient_payable"] + 0.009:
        raise bad_request(f"Payments (₹{totals['paid_now']:,.2f}) exceed what the patient owes (₹{totals['patient_payable']:,.2f})")
    needs_approval = totals["discount_percent"] > float(s["discount_approval_percent"]) and totals["discount"] > 0
    if needs_approval and state.pay_lines:
        raise conflict(f"A {totals['discount_percent']:.1f}% discount needs approval (policy {s['discount_approval_percent']}%). "
                       "Remove the payment lines — collect after approval — or reduce the discount.",
                       {"code": "APPROVAL_REQUIRED"})
    await _materialise(ctx, inv, state, totals)
    cons = sorted({ln.consultant_name for ln in state.lines if ln.consultant_name})
    data = {
        "bill": state.model_dump(), "totals": totals, "payer": state.payer, "gross": totals["gross"],
        "discount": totals["discount"], "tax": totals["tax"], "net": totals["net"], "billed_at": now().isoformat(),
        "discount_reason": (state.discount_remarks or None), "patient_payable": totals["patient_payable"],
        "sponsor_amount": totals["sponsor_amount"], "sponsor": state.sponsor_id, "sponsor_name": state.sponsor_name,
        "camp": state.camp_id, "lead_source": state.lead_source, "prescribed_by": state.prescribed_by, "consultants": cons,
        "client_type": {"Self": "GENERAL", "Corporate": "CORPORATE", "Insurance": "INSURANCE", "Government Scheme": "SCHEME"}[state.payer],
        "remarks": state.notes, "confirmed_by": ctx.user.get("name"), "confirmed_at": now().isoformat(timespec="seconds"),
        "category": state.category, "status": "Draft" if needs_approval else "Final",
    }
    inv = await update(ctx, INV, inv["id"], data)
    inv = await _recalc(ctx, inv["id"])  # balance = net before any payment
    paid = []
    if needs_approval:
        appr = await request_approval(ctx, "billing.discount", subject_fqn=INV, subject_id=inv["id"], amount=totals["discount"], force=True,
                                      summary=f"Discount ₹{totals['discount']:,.2f} ({totals['discount_percent']:.1f}%) on OP bill {inv['code']}: "
                                              f"{state.discount_remarks}")
        if appr:
            inv = await update(ctx, INV, inv["id"], {"discount_approval": appr["id"]})
    else:
        paid = await _take_payments(ctx, inv, state)
    inv = await _recalc(ctx, inv["id"])
    inv = await _refresh_split(ctx, inv)
    await audit(ctx, "bill.confirm", module="billing", entity="invoices", record=inv,
                after={"net": totals["net"], "discount": totals["discount"], "patient_payable": totals["patient_payable"],
                       "sponsor": totals["sponsor_amount"], "payments": [x["mode"] for x in paid], "approval": needs_approval})
    await emit("bill.created", ctx, {"invoice": inv})
    out = await _bill_out(ctx, inv)
    out["payments"] = paid
    out["approval_required"] = needs_approval
    return out


async def _refresh_split(ctx, inv: dict) -> dict:
    """Patient / sponsor dues from the bill's current net and the payments on it."""
    net = D(inv.get("net"))
    payer = inv.get("payer") or "Self"
    state = _state_of(inv)
    if payer == "Self":
        patient_payable = net
    else:
        sv = D(state.patient_share_value)
        patient_payable = min(q2(net * sv / HUNDRED) if state.patient_share_type == "%" else q2(sv), net)
    rows = (await ctx.conn.execute(sa.select(payments.c.mode, payments.c.kind, sa.func.coalesce(sa.func.sum(payments.c.amount), 0)).where(
        payments.c.invoice_id == inv["id"], payments.c.status == "Success", payments.c.deleted_at.is_(None))
        .group_by(payments.c.mode, payments.c.kind))).all()
    pat_paid, spon_paid = ZERO, ZERO
    for mode, kind, amt in rows:
        sign = -1 if kind == "REFUND" else 1
        if mode == "INSURANCE":
            spon_paid += sign * D(amt)
        else:
            pat_paid += sign * D(amt)
    sponsor_amount = net - patient_payable
    return await update(ctx, INV, inv["id"], {
        "patient_payable": float(patient_payable), "sponsor_amount": float(sponsor_amount), "patient_paid": float(pat_paid),
        "patient_due": float(max(ZERO, patient_payable - pat_paid)), "sponsor_due": float(max(ZERO, sponsor_amount - spon_paid)),
    })


@router.post("/drafts/{bill_id}/confirm")
async def confirm(bill_id: str, body: ConfirmIn, ctx: CtxDep):
    _counter(ctx)
    inv = await _load_draft(ctx, bill_id, lock=True)
    _editable(inv)
    # an admitted patient's OP bill is allowed (e.g. an OP service before admission); the screen offers "post to IP account"
    return await confirm_bill(ctx, inv, body.state or _state_of(inv))


async def quick_bill(ctx, *, patient_id: str, charge_ids: list[str], payments: list[dict], remarks: str | None = None) -> dict:
    """Confirmed OP bill straight from captured charges (registration fee and similar desk collections)."""
    unbilled = {c["id"]: c for c in await _unbilled_op(ctx, patient_id)}
    lines = [Line.model_validate(await _line_from_charge(ctx, unbilled[c])) for c in charge_ids if c in unbilled]
    if not lines:
        raise bad_request("Nothing to bill")
    state = DraftState(lines=lines, pay_lines=[PayLine(**p) for p in payments if float(p.get("amount") or 0) > 0], notes=remarks,
                       lead_source="Walk-in")
    inv = await create(ctx, INV, {"patient_id": patient_id, "type": "OP", "payer": "Self", "gross": 0, "discount": 0, "tax": 0, "net": 0,
                                  "paid": 0, "balance": 0, "status": "Draft", "source": "opbilling", "counter": "OP",
                                  "bill": state.model_dump(), "totals": compute(state), "created_by_name": ctx.user.get("name")})
    out = await confirm_bill(ctx, inv, state)
    return {**out, "id": out["id"], "code": out["code"]}


class CollectIn(BaseModel):
    pay_lines: list[PayLine] = Field(min_length=1, max_length=8)


@router.post("/bills/{bill_id}/collect", status_code=201)
async def collect_due(bill_id: str, body: CollectIn, ctx: CtxDep):
    """Take the patient's outstanding share on a confirmed bill (e.g. after a discount approval)."""
    _counter(ctx)
    inv = await _load_draft(ctx, bill_id, lock=True)
    if inv.get("status") not in ("Final", "Partially Paid"):
        raise conflict(f"Bill {inv['code']} is {_status_label(inv)['status'].lower()} — nothing to collect")
    inv = await _refresh_split(ctx, inv)
    due = D(inv.get("patient_due"))
    total = sum((D(p.amount) for p in body.pay_lines), ZERO)
    if total > due + Decimal("0.01"):
        raise bad_request(f"The patient owes ₹{q2(due)} on this bill")
    for i, pl in enumerate(body.pay_lines):
        if pl.mode in REF_MODES and not (pl.reference or "").strip():
            raise bad_request(f"Payment {i + 1}: enter the {pl.mode} reference", {"fields": {f"pay_lines.{i}.reference": "Required"}})
    paid = await _take_payments(ctx, inv, DraftState(pay_lines=body.pay_lines))
    inv = await _refresh_split(ctx, await _recalc(ctx, bill_id))
    out = await _bill_out(ctx, inv)
    out["payments"] = paid
    return out


# ------------------------------------------------------------------ admitted patients: post to the IP account

@router.post("/drafts/{bill_id}/post-to-ip")
async def post_to_ip(bill_id: str, body: ConfirmIn, ctx: CtxDep):
    """For an admitted patient: the lines go to the IP account as unbilled charges (billed on the final IP
    bill) and any payment is taken as an advance. The counter draft is closed."""
    _counter(ctx)
    inv = await _load_draft(ctx, bill_id, lock=True)
    _editable(inv)
    p = await _patient(ctx, inv["patient_id"])
    enc = p.get("encounter") or {}
    if enc.get("kind") != "IP":
        raise conflict("The patient has no active admission — confirm an OP bill instead")
    state = await _normalise_state(ctx, body.state or _state_of(inv), p.get("category"))
    if not state.lines:
        raise bad_request("Add at least one service")
    totals = compute(state)
    by_key = {x["key"]: x for x in totals["lines"]}
    posted = []
    for ln in state.lines:
        t = by_key[ln.key]
        if ln.charge_id:
            ch = await get(ctx, CHG, ln.charge_id)
            if not ch or ch.get("status") != "Unbilled" or ch.get("patient_id") != inv["patient_id"]:
                raise conflict(f"'{ln.name}' is no longer an unbilled charge of this patient")
            ch = await update(ctx, CHG, ch["id"], {"encounter_id": enc["id"], "discount": t["discount"]})
        else:
            ch = await post_charge(ctx, patient_id=inv["patient_id"], encounter_id=enc["id"],
                                   service_id=ln.service_id if ln.kind in ("service", "package") else None,
                                   service_code=ln.code if ln.kind == "consultation" else None, qty=ln.qty, rate=ln.rate,
                                   description=ln.name, source="opbilling.ip", source_id=inv["id"])
            if t["discount"]:
                ch = await update(ctx, CHG, ch["id"], {"discount": t["discount"]})
        posted.append({"id": ch["id"], "code": ch.get("code"), "description": ch.get("description"), "amount": ch.get("amount")})
    deposits = []
    for pl in state.pay_lines:
        if pl.mode == "DEPOSIT":
            continue
        dep = await collect(PaymentIn(patient_id=inv["patient_id"], kind="DEPOSIT", mode=pl.mode, amount=pl.amount, reference=pl.reference), ctx)
        deposits.append({"id": dep["id"], "code": dep.get("code"), "amount": dep.get("amount"), "mode": dep.get("mode")})
    rec = await update(ctx, INV, bill_id, {"status": "Cancelled", "discarded": True, "posted_to_ip": enc["id"], "balance": 0,
                                           "discard_reason": f"Posted to IP account {enc.get('code')}"})
    await audit(ctx, "bill.post_to_ip", module="billing", entity="invoices", record=rec,
                after={"encounter": enc.get("code"), "charges": [c["code"] for c in posted], "advance": sum(d["amount"] for d in deposits)})
    return {"encounter": enc, "charges": posted, "advances": deposits}


# ------------------------------------------------------------------ approval outcome

@on_decided("billing.discount")
async def _discount_decided(ctx, approval: dict, approved: bool):
    """The billing engine settles the bill; here the patient / sponsor split follows the final net."""
    inv = await get(ctx, INV, approval["subject_id"])
    if not inv or inv.get("source") != "opbilling":
        return
    if not approved:
        state = _state_of(inv)
        for ln in state.lines:
            ln.disc_value = 0
        state.bill_disc_value = 0
        inv = await update(ctx, INV, inv["id"], {"bill": state.model_dump(), "totals": compute(state)})
        await ctx.conn.execute(charges.update().where(charges.c.invoice_id == inv["id"]).values(discount=0, updated_at=now()))
    await _refresh_split(ctx, inv)


# ------------------------------------------------------------------ bills register and confirmed bills

def _mask(phone: str | None) -> str | None:
    return f"•••••••{phone[-3:]}" if phone and len(phone) >= 3 else phone


def _bill_conds(*, scope: str, user_id: str, d_from: date, d_to: date, status: str | None, q: str | None, search_by: str):
    t, p = invoices, patients
    when = sa.func.coalesce(t.c.billed_at, t.c.created_at)
    s, _ = day_bounds(d_from)
    _, e = day_bounds(d_to)
    conds = [t.c.type == "OP", t.c.deleted_at.is_(None), when >= s, when < e]
    if scope == "mine":
        conds.append(t.c.created_by == user_id)
    st = (status or "").upper()
    if st == "DRAFT":
        conds += [t.c.status == "Draft", t.c.billed_at.is_(None)]
    elif st == "PENDING_APPROVAL":
        conds += [t.c.status == "Draft", t.c.billed_at.isnot(None)]
    elif st == "CONFIRMED":
        conds.append(t.c.status.in_(["Final", "Partially Paid", "Paid"]))
    elif st == "PAID":
        conds.append(sa.and_(t.c.status.in_(["Final", "Partially Paid", "Paid"]),
                             sa.func.coalesce(sa.cast(t.c.data["patient_due"].astext, sa.Numeric), t.c.balance) <= 0))
    elif st == "DUE":
        conds.append(sa.and_(t.c.status.in_(["Final", "Partially Paid"]),
                             sa.func.coalesce(sa.cast(t.c.data["patient_due"].astext, sa.Numeric), t.c.balance) > 0))
    elif st == "CANCELLED":
        conds.append(t.c.status == "Cancelled")
    elif st != "ALL":
        conds.append(t.c.status != "Cancelled")
    if q and q.strip():
        term = q.strip()
        like = f"%{term}%"
        fields = {
            "bill": [t.c.code.ilike(like)],
            "invoice": [t.c.code.ilike(like), t.c.data["invoice_no"].astext.ilike(like)],
            "uhid": [p.c.code.ilike(like)],
            "mobile": [p.c.phone.like(f"%{''.join(ch for ch in term if ch.isdigit()) or term}%")],
            "patient": [p.c.title.ilike(like)],
        }
        if search_by in fields:
            conds.append(sa.or_(*fields[search_by]))
        else:
            conds.append(sa.or_(*[c for v in fields.values() for c in v]))
    return conds


@router.get("/bills")
async def bills(ctx: CtxDep, scope: Literal["mine", "all"] = "all", date_from: str | None = None, date_to: str | None = None,
                status: str | None = None, q: str | None = None, search_by: str = "all", page: int = 1, limit: int = 25,
                sort: str = "-date", format: Literal["json", "csv"] = "json"):
    """OP bills register (and the counter's Confirmed bills): drafts, confirmed, paid / due, cancelled."""
    rs.ensure_access(ctx, E(INV), "read")
    d_from = parse_date(date_from) or today()
    d_to = parse_date(date_to) or d_from
    if d_to < d_from:
        raise bad_request("'To' date is before 'From' date")
    if (d_to - d_from).days > 366:
        raise bad_request("Choose a range of at most one year")
    t, p = invoices, patients
    conds = _bill_conds(scope=scope, user_id=ctx.user_id, d_from=d_from, d_to=d_to, status=status, q=q, search_by=search_by)
    base = t.join(p, p.c.id == t.c.patient_id)
    total = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(base).where(*conds))).scalar_one()
    sums = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(t.c.net), 0), sa.func.coalesce(sa.func.sum(t.c.discount), 0),
                                             sa.func.coalesce(sa.func.sum(t.c.paid), 0), sa.func.coalesce(sa.func.sum(t.c.balance), 0))
                                   .select_from(base).where(*conds, t.c.status != "Cancelled"))).one()
    keys = {"date": sa.func.coalesce(t.c.billed_at, t.c.created_at), "bill": t.c.code, "net": t.c.net, "due": t.c.balance,
            "status": t.c.status, "patient": p.c.title}
    sk = sort.lstrip("-")
    col = keys.get(sk, keys["date"])
    order = col.desc().nulls_last() if sort.startswith("-") else col.asc().nulls_last()
    lim = 10000 if format == "csv" else max(1, min(limit, 200))
    off = 0 if format == "csv" else (max(1, page) - 1) * lim
    rows = (await ctx.conn.execute(sa.select(t, p.c.title.label("p_name"), p.c.code.label("p_uhid"), p.c.phone.label("p_phone"))
                                   .select_from(base).where(*conds).order_by(order, t.c.created_at.desc()).limit(lim).offset(off))).all()
    recs = []
    for r in rows:
        m = dict(r._mapping)
        extra = {k: m.pop(k) for k in ("p_name", "p_uhid", "p_phone")}
        recs.append((rs.to_record(m), extra))
    uids = {inv.get("created_by") for inv, _ in recs if is_uuid(inv.get("created_by"))}
    who = {}
    if uids:
        for u in (await ctx.conn.execute(sa.select(users.c.id, users.c.name, employees.c.code).select_from(
                users.outerjoin(employees, employees.c.id == users.c.employee_id)).where(users.c.id.in_(uids)))).all():
            who[str(u.id)] = {"name": u.name, "code": u.code}
    camps = await _sponsor_names(ctx, {inv.get("camp") for inv, _ in recs})
    out = []
    for i, (inv, extra) in enumerate(recs, start=off + 1):
        lab = _status_label(inv)
        u = who.get(inv.get("created_by") or "", {})
        due = inv.get("patient_due") if inv.get("patient_due") is not None else (inv.get("balance") if inv.get("status") != "Draft" else (inv.get("totals") or {}).get("balance"))
        out.append({
            "sno": i, "id": inv["id"], "bill_no": inv["code"], "patient_id": inv.get("patient_id"), "patient": extra["p_name"],
            "uhid": extra["p_uhid"], "mobile": _mask(extra["p_phone"]), "mobile_full": extra["p_phone"] if format == "csv" else None,
            "net": inv.get("net") if inv.get("billed_at") else (inv.get("totals") or {}).get("net", 0),
            "due": due, "discount": inv.get("discount") if inv.get("billed_at") else (inv.get("totals") or {}).get("discount", 0),
            "paid": inv.get("paid"), "sponsor_due": inv.get("sponsor_due"), "status": lab["status"], "sub_status": lab["sub"],
            "raw_status": inv.get("status"), "camp": camps.get(inv.get("camp") or ""), "consultant": ", ".join(inv.get("consultants") or []) or None,
            "client_type": inv.get("client_type") or {"Self": "GENERAL"}.get(inv.get("payer") or "Self", (inv.get("payer") or "GENERAL").upper()),
            "sponsor": inv.get("sponsor_name"), "lead_source": inv.get("lead_source"), "remarks": inv.get("remarks") or inv.get("discount_reason"),
            "created_by": u.get("name") or inv.get("created_by_name"), "created_by_code": u.get("code"),
            "date": inv.get("billed_at") or inv.get("created_at"), "counter": inv.get("counter") or "OP", "source": inv.get("source") or "billing",
        })
    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        cols = [("sno", "S.No"), ("bill_no", "Bill No"), ("date", "Date"), ("patient", "Patient"), ("uhid", "UHID"), ("mobile_full", "Mobile"),
                ("net", "Net"), ("discount", "Discount"), ("paid", "Paid"), ("due", "Patient due"), ("sponsor_due", "Sponsor due"),
                ("status", "Status"), ("sub_status", "Sub-status"), ("camp", "Camp"), ("consultant", "Consultant"), ("client_type", "Client type"),
                ("sponsor", "Sponsor"), ("lead_source", "Lead source"), ("remarks", "Remarks"), ("created_by", "Created by")]
        w.writerow([c[1] for c in cols])
        for r in out:
            w.writerow(["" if r.get(k) is None else r.get(k) for k, _ in cols])
        await audit(ctx, "export", module="billing", entity="invoices", note=f"OP bills register {d_from}–{d_to} ({len(out)} rows)")
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="op-bills-{d_from}-{d_to}.csv"'})
    return {"rows": out, "total": total, "page": page, "limit": lim,
            "summary": {"net": float(sums[0]), "discount": float(sums[1]), "paid": float(sums[2]), "balance": float(sums[3])}}


@router.get("/bills/{bill_id}")
async def bill_detail(bill_id: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(INV), "read")
    inv = await get(ctx, INV, bill_id)
    if not inv:
        raise not_found("Bill not found")
    lines = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(charges).where(
        charges.c.invoice_id == bill_id, charges.c.deleted_at.is_(None)).order_by(charges.c.charged_at))).all()]
    pays = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(payments).where(
        payments.c.invoice_id == bill_id, payments.c.deleted_at.is_(None)).order_by(payments.c.paid_at))).all()]
    out = await _bill_out(ctx, inv)
    out["charges"] = [{k: c.get(k) for k in ("id", "code", "description", "qty", "rate", "amount", "discount", "line_net", "consultant_name",
                                             "tax_percent", "status")} for c in lines]
    out["payments"] = [{k: x.get(k) for k in ("id", "code", "kind", "mode", "amount", "reference", "paid_at", "received_by", "status",
                                              "mode_corrected_from")} for x in pays]
    out["refundable"] = float(sum(D(x.get("amount")) * (-1 if x.get("kind") == "REFUND" else 1) for x in pays
                                  if x.get("status") in ("Success", "Pending") and x.get("mode") != "INSURANCE" and x.get("kind") != "ADJUSTMENT"
                                  or (x.get("kind") == "REFUND" and x.get("status") == "Pending")))
    out["patient_due"] = inv.get("patient_due")
    out["sponsor_due"] = inv.get("sponsor_due")
    return out


@router.get("/bills/{bill_id}/print")
async def bill_print(bill_id: str, ctx: CtxDep):
    out = await bill_detail(bill_id, ctx)
    inv = await get(ctx, INV, bill_id)
    await audit(ctx, "print", module="billing", entity="invoices", record=inv)
    out["hospital"] = {"name": settings.hospital_name}
    return out


# ------------------------------------------------------------------ refunds and payment-mode correction

class RefundIn(BaseModel):
    amount: float = Field(gt=0)
    mode: Literal["CASH", "CARD", "UPI", "BANK", "CHEQUE"] = "CASH"
    reason: str = Field(min_length=3, max_length=300)
    charge_ids: list[str] = Field(default_factory=list, max_length=50)


@router.post("/bills/{bill_id}/refund", status_code=201)
async def refund(bill_id: str, body: RefundIn, ctx: CtxDep):
    """Refund on an OP bill (service not rendered, excess collection …). Above the flow threshold it
    waits for approval; the bill's paid / balance follow."""
    require_role(ctx, "billing")
    inv = await get(ctx, INV, bill_id)
    if not inv or inv.get("type") != "OP":
        raise not_found("Bill not found")
    if inv.get("status") in ("Draft", "Cancelled"):
        raise conflict(f"Bill {inv['code']} is {inv.get('status')} — nothing to refund")
    pays = (await ctx.conn.execute(sa.select(payments.c.kind, payments.c.status, payments.c.mode, sa.func.coalesce(sa.func.sum(payments.c.amount), 0))
                                   .where(payments.c.invoice_id == bill_id, payments.c.deleted_at.is_(None))
                                   .group_by(payments.c.kind, payments.c.status, payments.c.mode))).all()
    paid = sum((D(a) for k, st, m, a in pays if k in ("PAYMENT",) and st == "Success" and m != "INSURANCE"), ZERO)
    refunded = sum((D(a) for k, st, m, a in pays if k == "REFUND" and st in ("Success", "Pending")), ZERO)
    if D(body.amount) > paid - refunded + Decimal("0.01"):
        raise bad_request(f"At most ₹{q2(paid - refunded)} can be refunded on this bill (patient payments less earlier refunds)")
    from .billing import RefundIn as BillingRefundIn
    from .billing import refund as billing_refund

    reason = body.reason.strip()
    if body.charge_ids:
        rows = (await ctx.conn.execute(sa.select(charges.c.code, charges.c.data["description"].astext).where(
            charges.c.id.in_([c for c in body.charge_ids if is_uuid(c)]), charges.c.invoice_id == bill_id))).all()
        if rows:
            reason = f"{reason} — {', '.join(d or c for c, d in rows)}"[:300]
    res = await billing_refund(BillingRefundIn(patient_id=inv["patient_id"], invoice_id=bill_id, amount=body.amount, mode=body.mode,
                                               reason=reason), ctx)
    await update(ctx, PAY, res["id"], {"refund_lines": [c for c in body.charge_ids if is_uuid(c)]})
    await _refresh_split(ctx, await get(ctx, INV, bill_id))
    return res


@on_decided("billing.refund")
async def _refund_decided(ctx, approval: dict, approved: bool):
    pay = await get(ctx, PAY, approval["subject_id"])
    if pay and pay.get("invoice_id"):
        inv = await get(ctx, INV, pay["invoice_id"])
        if inv and inv.get("source") == "opbilling":
            await _refresh_split(ctx, inv)


@router.get("/refunds")
async def refunds(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None, status: str | None = None):
    rs.ensure_access(ctx, E(PAY), "read")
    d_from = parse_date(date_from) or today() - timedelta(days=6)
    d_to = parse_date(date_to) or today()
    s, _ = day_bounds(d_from)
    _, e = day_bounds(d_to)
    t, i, p = payments, invoices, patients
    conds = [t.c.kind == "REFUND", t.c.deleted_at.is_(None), t.c.paid_at >= s, t.c.paid_at < e, i.c.type == "OP"]
    if status:
        conds.append(t.c.status == status)
    rows = (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.amount, t.c.mode, t.c.status, t.c.paid_at, t.c.data, i.c.id.label("inv_id"),
                                             i.c.code.label("bill"), p.c.title, p.c.code.label("uhid"))
                                   .select_from(t.join(i, i.c.id == t.c.invoice_id).join(p, p.c.id == t.c.patient_id))
                                   .where(*conds).order_by(t.c.paid_at.desc()).limit(500))).all()
    return [{"id": str(r.id), "code": r.code, "amount": float(r.amount or 0), "mode": r.mode, "status": r.status,
             "paid_at": to_json_value(r.paid_at), "reason": (r.data or {}).get("reference"), "received_by": (r.data or {}).get("received_by"),
             "bill_id": str(r.inv_id), "bill": r.bill, "patient": r.title, "uhid": r.uhid} for r in rows]


class ModeFixIn(BaseModel):
    mode: Literal["CASH", "CARD", "UPI", "WALLET", "BANK", "CHEQUE"]
    reference: str | None = Field(default=None, max_length=80)
    reason: str = Field(min_length=3, max_length=300)


@router.get("/payments")
async def counter_payments(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None, q: str | None = None, mode: str | None = None):
    """Receipts on OP bills — the list the payment-mode correction screen works from."""
    rs.ensure_access(ctx, E(PAY), "read")
    d_from = parse_date(date_from) or today()
    d_to = parse_date(date_to) or d_from
    s, _ = day_bounds(d_from)
    _, e = day_bounds(d_to)
    t, i, p = payments, invoices, patients
    conds = [t.c.kind == "PAYMENT", t.c.deleted_at.is_(None), t.c.paid_at >= s, t.c.paid_at < e, i.c.type == "OP", t.c.mode != "INSURANCE"]
    if mode:
        conds.append(t.c.mode == mode.upper())
    if q and q.strip():
        like = f"%{q.strip()}%"
        conds.append(sa.or_(t.c.code.ilike(like), i.c.code.ilike(like), p.c.code.ilike(like), p.c.title.ilike(like), p.c.phone.like(like)))
    rows = (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.amount, t.c.mode, t.c.status, t.c.paid_at, t.c.data, i.c.id.label("inv_id"),
                                             i.c.code.label("bill"), p.c.title, p.c.code.label("uhid"))
                                   .select_from(t.join(i, i.c.id == t.c.invoice_id).join(p, p.c.id == t.c.patient_id))
                                   .where(*conds).order_by(t.c.paid_at.desc()).limit(300))).all()
    return [{"id": str(r.id), "code": r.code, "amount": float(r.amount or 0), "mode": r.mode, "status": r.status,
             "paid_at": to_json_value(r.paid_at), "reference": (r.data or {}).get("reference"), "received_by": (r.data or {}).get("received_by"),
             "corrected_from": (r.data or {}).get("mode_corrected_from"), "pending_correction": (r.data or {}).get("mode_correction_pending"),
             "bill_id": str(r.inv_id), "bill": r.bill, "patient": r.title, "uhid": r.uhid} for r in rows]


async def _apply_mode_fix(ctx, pay: dict, mode: str, reference: str | None, reason: str) -> dict:
    before = {"mode": pay.get("mode"), "reference": pay.get("reference")}
    rec = await update(ctx, PAY, pay["id"], {"mode": mode, "reference": reference or pay.get("reference"), "mode_corrected_from": pay.get("mode"),
                                             "mode_corrected_at": now().isoformat(timespec="seconds"), "mode_correction_reason": reason,
                                             "mode_correction_pending": None})
    await audit(ctx, "payment.mode_correction", module="billing", entity="payments", record=rec, before=before,
                after={"mode": mode, "reference": rec.get("reference")}, note=reason)
    return rec


@router.post("/payments/{pay_id}/correct-mode")
async def correct_mode(pay_id: str, body: ModeFixIn, ctx: CtxDep):
    """Fix the payment mode of a receipt (e.g. recorded as cash, actually UPI). Same-day corrections apply
    immediately; older receipts go through the approval workflow. Always audited."""
    require_role(ctx, *COUNTER_ROLES)
    pay = await get(ctx, PAY, pay_id)
    if not pay or pay.get("kind") != "PAYMENT":
        raise not_found("Receipt not found")
    if pay.get("status") != "Success":
        raise conflict(f"Receipt {pay.get('code')} is {pay.get('status')}")
    if pay.get("mode") == body.mode:
        raise bad_request("That is already the payment mode")
    if pay.get("mode") in ("INSURANCE", "DEPOSIT"):
        raise conflict("Sponsor settlements and advance adjustments cannot change mode here")
    if body.mode in REF_MODES and not (body.reference or "").strip():
        raise bad_request(f"Enter the {body.mode} reference", {"fields": {"reference": "Required"}})
    if pay.get("mode_correction_pending"):
        raise conflict("A correction for this receipt is already waiting for approval")
    s = await ob_settings(ctx)
    paid_on = parse_date(pay.get("paid_at"))
    within = paid_on and (today() - paid_on).days <= int(s.get("mode_correction_days") or 0)
    if within or ctx.role == "admin":
        return {"payment": await _apply_mode_fix(ctx, pay, body.mode, body.reference, body.reason), "approval": None}
    appr = await request_approval(ctx, "billing.mode_correction", subject_fqn=PAY, subject_id=pay_id, amount=float(pay.get("amount") or 0),
                                  force=True, summary=f"Change receipt {pay.get('code')} ₹{pay.get('amount')} from {pay.get('mode')} to "
                                                      f"{body.mode}: {body.reason}")
    rec = await update(ctx, PAY, pay_id, {"mode_correction_pending": {"mode": body.mode, "reference": body.reference, "reason": body.reason,
                                                                      "approval": appr["id"] if appr else None,
                                                                      "requested_by": ctx.user.get("name")}})
    return {"payment": rec, "approval": appr}


@on_decided("billing.mode_correction")
async def _mode_decided(ctx, approval: dict, approved: bool):
    pay = await get(ctx, PAY, approval["subject_id"])
    want = (pay or {}).get("mode_correction_pending")
    if not pay or not want:
        return
    if approved:
        await _apply_mode_fix(ctx, pay, want["mode"], want.get("reference"), want.get("reason") or "Approved correction")
    else:
        await update(ctx, PAY, pay["id"], {"mode_correction_pending": None,
                                           "mode_correction_rejected": approval.get("comments") or "Rejected"})


# ------------------------------------------------------------------ counter context, history, templates

@router.get("/context")
async def context(ctx: CtxDep):
    _counter(ctx)
    s = await ob_settings(ctx)
    sponsors = await find(ctx, "insurance.payers", status="Active", limit=300)
    camps = [c for c in await find(ctx, "camps.camps", limit=200, sort="-camp_date")
             if c.get("status") not in ("Cancelled", "Closed") and (parse_date(c.get("camp_date")) or today()) >= today() - timedelta(days=60)]
    return {
        "pay_modes": PAY_MODES, "lead_sources": s.get("lead_sources") or LEAD_SOURCES, "payers": PAYERS,
        "categories": E("registration.patients").field_map["category"].options,
        "discount_approval_percent": float(s["discount_approval_percent"]), "follow_up_days": s.get("follow_up_days"),
        "require_lead_source": bool(s.get("require_lead_source")),
        "sponsors": [{"id": x["id"], "name": x.get("name"), "type": x.get("payer_type"), "discount_percent": x.get("discount_percent")} for x in sponsors],
        "camps": [{"id": c["id"], "name": c.get("name"), "date": c.get("camp_date")} for c in camps[:50]],
        "can_refund": ctx.role in ("billing", "admin"), "can_correct_mode": ctx.role in COUNTER_ROLES + ("admin",),
        "allow_line_discount": bool(s.get("allow_line_discount", True)), "print_on_save": bool(s.get("print_on_save", True)),
        "default_payment_mode": s.get("default_payment_mode") or "CASH", "user": ctx.user.get("name"),
    }


@router.get("/patients/{pid}/history")
async def history(pid: str, ctx: CtxDep):
    """Previous consultations (doctor, date, fee) and recent bills — the counter's history panel."""
    _counter(ctx)
    await _patient(ctx, pid)
    a = appointments
    visits = (await ctx.conn.execute(sa.select(a.c.id, a.c.code, a.c.appt_date, a.c.type, a.c.status, employees.c.name, a.c.department_id)
                                     .select_from(a.outerjoin(employees, employees.c.id == a.c.doctor_id))
                                     .where(a.c.patient_id == pid, a.c.deleted_at.is_(None), a.c.status.notin_(["Cancelled"]))
                                     .order_by(a.c.appt_date.desc()).limit(15))).all()
    depts = await _sponsor_names(ctx, {str(v.department_id) for v in visits if v.department_id})
    bills_ = (await ctx.conn.execute(sa.select(invoices).where(invoices.c.patient_id == pid, invoices.c.deleted_at.is_(None),
                                                               invoices.c.status != "Cancelled").order_by(
        sa.func.coalesce(invoices.c.billed_at, invoices.c.created_at).desc()).limit(10))).all()
    return {
        "consultations": [{"id": str(v.id), "code": v.code, "date": to_json_value(v.appt_date), "type": v.type, "status": v.status,
                           "doctor": v.name, "department": depts.get(str(v.department_id) or "")} for v in visits],
        "bills": [{**{k: b.get(k) for k in ("id", "code", "type", "net", "paid", "balance", "billed_at", "created_at")}, "label": _status_label(b)}
                  for b in (rs.to_record(x) for x in bills_)],
        "deposit_balance": float(await deposit_balance(ctx, pid)),
    }


class TemplateIn(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    lines: list[Line] = Field(min_length=1, max_length=50)
    personal: bool = False


@router.get("/templates")
async def templates(ctx: CtxDep):
    _counter(ctx)
    me = ctx.user.get("employee_id")
    rows = [t for t in await find(ctx, "appointments.bill_templates", status="Active", limit=200, sort="title")
            if not t.get("owner") or t.get("owner") == me]
    out = []
    for t in rows:
        refs = t.get("_refs") or {}
        out.append({"id": t["id"], "code": t.get("code"), "name": t.get("name"), "personal": bool(t.get("owner")),
                    "items": [{"service_id": ln.get("service"), "name": refs.get(ln.get("service") or "", "Service"), "qty": ln.get("qty") or 1,
                               "discount_percent": ln.get("discount_percent") or 0} for ln in t.get("items") or []]})
    return out


@router.post("/templates", status_code=201)
async def save_template(body: TemplateIn, ctx: CtxDep):
    _counter(ctx)
    items = [{"service": ln.service_id, "qty": ln.qty, "discount_percent": ln.disc_value if ln.disc_type == "%" else 0}
             for ln in body.lines if ln.service_id and ln.kind in ("service", "package")]
    if not items:
        raise bad_request("Only tariff services can be saved in a template (not consultations or captured charges)")
    return await create(ctx, "appointments.bill_templates", {"name": body.name.strip(), "items": items, "status": "Active",
                                                             "owner": ctx.user.get("employee_id") if body.personal else None})


@router.get("/templates/{tid}/lines")
async def template_lines(tid: str, ctx: CtxDep, patient_id: str | None = None):
    _counter(ctx)
    t = await get(ctx, "appointments.bill_templates", tid)
    if not t:
        raise not_found("Template not found")
    ids = [ln.get("service") for ln in t.get("items") or [] if is_uuid(ln.get("service"))]
    svcs = {str(r.id): rs.to_record(r) for r in (await ctx.conn.execute(sa.select(services).where(services.c.id.in_(ids)))).all()} if ids else {}
    cat = None
    if patient_id and is_uuid(patient_id):
        cat = (await ctx.conn.execute(sa.select(patients.c.data["category"].astext).where(patients.c.id == patient_id))).scalar()
    out = []
    for ln in t.get("items") or []:
        svc = svcs.get(ln.get("service") or "")
        if not svc:
            continue
        out.append(Line(kind="package" if svc.get("category") == "PACKAGE" else "service", service_id=svc["id"], code=svc.get("code"),
                        name=svc.get("name") or svc.get("title") or "", category=svc.get("category"), qty=float(ln.get("qty") or 1),
                        rate=_rate_for(svc, cat), disc_value=float(ln.get("discount_percent") or 0),
                        tax_percent=float(svc.get("tax_percent") or 0)).model_dump())
    return out


# ------------------------------------------------------------------ counter day summary

@router.get("/summary")
async def summary(ctx: CtxDep, scope: Literal["mine", "all"] = "mine", on: str | None = None):
    """Collections by mode for the counter user's day (shift hand-over)."""
    _counter(ctx)
    d = parse_date(on) or today()
    s, e = day_bounds(d)
    t, i = payments, invoices
    conds = [t.c.paid_at >= s, t.c.paid_at < e, t.c.deleted_at.is_(None), t.c.status == "Success", i.c.type == "OP"]
    if scope == "mine":
        conds.append(t.c.created_by == ctx.user_id)
    rows = (await ctx.conn.execute(sa.select(t.c.kind, t.c.mode, sa.func.count(), sa.func.coalesce(sa.func.sum(t.c.amount), 0))
                                   .select_from(t.join(i, i.c.id == t.c.invoice_id)).where(*conds).group_by(t.c.kind, t.c.mode))).all()
    bills_n = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.coalesce(sa.func.sum(i.c.net), 0)).where(
        i.c.type == "OP", i.c.billed_at >= s, i.c.billed_at < e, i.c.status != "Cancelled", i.c.deleted_at.is_(None),
        *([i.c.created_by == ctx.user_id] if scope == "mine" else [])))).one()
    by_mode: dict[str, float] = {}
    refunds_ = 0.0
    for kind, mode, _n, amt in rows:
        if kind == "REFUND":
            refunds_ += float(amt)
        else:
            by_mode[mode] = by_mode.get(mode, 0) + float(amt)
    return {"date": d.isoformat(), "bills": bills_n[0], "billed": float(bills_n[1]), "by_mode": by_mode, "refunds": refunds_,
            "collected": sum(by_mode.values()) - refunds_}


__all__ = ["router", "quick_bill", "compute", "DraftState", "Line", "confirm_bill"]
