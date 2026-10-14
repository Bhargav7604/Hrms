"""Patient portal & app API: OTP login by UHID or mobile, profile and family / delegate switching,
appointments (booked and cancelled through the appointments engine), verified reports, bills and
receipts, prescriptions, e-consent signing, teleconsult join, feedback and contact updates.

Every patient endpoint resolves the profile it acts on with `subject()`. A login may act for:
  · the patient who logged in;
  · other active patients registered on the same OTP-verified mobile (one household phone);
  · patients who granted this patient portal access (registration.family_links.delegate_portal_access);
  · patients with an active portal delegate record naming this patient (limited to its access scope).
Nothing outside that set is ever read or written. Staff adoption statistics live under /admin."""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit
from ..core.security import CtxDep, PatientCtxDep, PublicCtxDep, sign_token
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    is_uuid,
    not_found,
    now,
    parse_date,
    parse_dt,
    to_json_value,
    today,
)
from ..redis import otp_issue, otp_verify, rate_limited, revoke_token
from ..schema import audit_log, charges, employees, invoices, orders, patients, payments, records, services
from ._common import E, create, find, get, has, transition, update
from .appointments import BookIn, all_schedules, book, consulting_doctors, slot_grid
from .notify import _digits10, mask_phone

log = logging.getLogger("vlack.portal")
router = APIRouter(prefix="/api/portal", tags=["portal"])
public_router = APIRouter(prefix="/api/public/portal", tags=["public"])

APPT = "appointments.appointments"
FULL = "Full access"
S_APPT, S_REPORTS, S_BILLS, S_RX = "Appointments", "Lab & radiology reports", "Bills & payments", "Prescriptions"
S_CONSENT, S_TELE = "E-consent", "Teleconsult"
INACTIVE_PATIENT = ("Merged", "Deceased", "Inactive")
SIGNER_RELATION = {"Spouse": "Spouse", "Parent": "Parent", "Child": "Child", "Sibling": "Sibling", "Guardian": "Guardian"}


# ------------------------------------------------------------------ login (public)

async def _patient_by_uhid(ctx, uhid: str):
    return (await ctx.conn.execute(sa.select(patients).where(
        sa.func.upper(patients.c.code) == uhid.strip().upper(), patients.c.deleted_at.is_(None)))).first()


async def _resolve_login(ctx, uhid: str | None, mobile: str | None) -> tuple[Any, str]:
    """(patient row, verified-mobile subject) for a UHID or a registered mobile number."""
    if uhid and uhid.strip():
        row = await _patient_by_uhid(ctx, uhid)
        if not row:
            raise not_found("We could not find a patient with this UHID")
        if row.status in INACTIVE_PATIENT:
            raise conflict("This UHID is not active — please contact the registration desk")
        phone = _digits10(row.phone)
        if len(phone) != 10:
            raise bad_request("No mobile number is registered for this UHID — please update it at the registration desk")
        if mobile and _digits10(mobile) != phone:
            raise bad_request("This mobile number does not match our records for the UHID")
        return row, phone
    phone = _digits10(mobile)
    if len(phone) != 10:
        raise bad_request("Enter your UHID or a 10-digit mobile number")
    rows = (await ctx.conn.execute(sa.select(patients).where(
        patients.c.phone == phone, patients.c.deleted_at.is_(None), patients.c.status == "Active").order_by(patients.c.created_at.asc()))).all()
    if not rows:
        raise not_found("This mobile number is not registered with the hospital")
    acct_ids = {a.get("patient_id") for a in await find(ctx, "portal.accounts", status="Active", mobile=phone, limit=20)}
    return next((r for r in rows if str(r.id) in acct_ids), rows[0]), phone


class OtpIn(BaseModel):
    uhid: str | None = Field(default=None, max_length=30)
    mobile: str | None = Field(default=None, max_length=20)


@public_router.post("/otp")
async def request_otp(body: OtpIn, ctx: PublicCtxDep):
    if await rate_limited(f"otp-ip:{ctx.ip}", 20, 3600):
        raise ApiError(429, "Too many requests from this device. Try again later.")
    row, phone = await _resolve_login(ctx, body.uhid, body.mobile)
    if await rate_limited(f"otp:{phone}", 5, 3600):
        raise ApiError(429, "Too many OTP requests for this number. Try again in an hour.")
    code = await otp_issue("portal", phone)
    await emit("otp.requested", ctx, {"phone": phone, "otp": code, "purpose": "portal-login", "patient_id": str(row.id)})
    await audit(ctx, "portal.otp", module="portal", entity="accounts", record={"patient_id": str(row.id)}, note=mask_phone(phone))
    out: dict[str, Any] = {"sent": True, "to": mask_phone(phone)}
    if settings.env == "development":
        out["dev_otp"] = code  # development only — production delivers it by SMS / WhatsApp
    return out


class LoginIn(OtpIn):
    otp: str = Field(min_length=4, max_length=8)
    consent: bool = False
    platform: Literal["Web", "Android", "iOS"] = "Web"


@public_router.post("/login")
async def login(body: LoginIn, ctx: PublicCtxDep):
    row, phone = await _resolve_login(ctx, body.uhid, body.mobile)
    pid = str(row.id)
    if await rate_limited(f"portal-login:{phone}", 10, 900):
        raise ApiError(429, "Too many attempts. Request a new OTP after 15 minutes.")
    accts = await find(ctx, "portal.accounts", patient_id=pid, limit=1)
    acct = accts[0] if accts else None
    if acct and acct.get("status") == "Blocked":
        raise ApiError(403, "Portal access for this patient is blocked. Please contact the hospital help desk.")
    if not acct and not body.consent:  # checked before the OTP so the code is not used up
        raise ApiError(400, "Please accept the consent for processing your health data to continue", code="CONSENT_REQUIRED")
    if not await otp_verify("portal", phone, body.otp):
        # the request rolls back, so brute force is bounded by the Redis attempt limit above, not a DB counter
        raise bad_request("The OTP is incorrect or has expired")
    ts = now().isoformat(timespec="seconds")
    if not acct:
        acct = await create(ctx, "portal.accounts", {
            "patient_id": pid, "mobile": phone, "email": row.email, "login_method": "Mobile OTP", "app_platform": [body.platform],
            "dpdp_consent": True, "dpdp_consent_at": ts, "last_login": ts, "failed_otp_attempts": 0, "login_count": 1, "status": "Active",
        })
    else:
        platforms = sorted({*(acct.get("app_platform") or []), body.platform})
        acct = await update(ctx, "portal.accounts", acct["id"], {
            "last_login": ts, "failed_otp_attempts": 0, "login_count": int(acct.get("login_count") or 0) + 1, "app_platform": platforms,
            **({"dpdp_consent": True, "dpdp_consent_at": ts} if body.consent and not acct.get("dpdp_consent") else {}),
        })
    token, claims = sign_token(pid, "patient", "patient", row.title or row.code)
    await audit(ctx, "portal.login", module="portal", entity="accounts", record={"id": acct["id"], "code": acct.get("code"), "patient_id": pid},
                note=body.platform)
    return {"token": token, "expires_at": datetime.fromtimestamp(claims["exp"], settings.tz).isoformat(),
            "patient": {"id": pid, "name": row.title, "uhid": row.code}}


# ------------------------------------------------------------------ profiles & access

def _scope_ok(prof: dict, scope: str | None) -> bool:
    return not scope or FULL in prof["scopes"] or scope in prof["scopes"]


async def profiles(ctx) -> list[dict]:
    """Profiles this login may act for (cached per request)."""
    if "_portal_profiles" in ctx.__dict__:
        return ctx.__dict__["_portal_profiles"]
    me = ctx.user["patient_id"]
    p = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == me, patients.c.deleted_at.is_(None)))).first()
    if not p or p.status in ("Merged", "Deceased"):
        raise ApiError(401, "This patient record is no longer active — please sign in again")
    acct = await find(ctx, "portal.accounts", patient_id=me, limit=1)
    if acct and acct[0].get("status") == "Blocked":
        raise ApiError(401, "Portal access for this patient is blocked. Please contact the hospital.")
    grants: dict[str, dict] = {me: {"relation": "Self", "scopes": [FULL], "can_sign": True, "can_pay": True}}
    if p.phone and settings.portal_shared_mobile_access:
        for r in (await ctx.conn.execute(sa.select(patients.c.id).where(
                patients.c.phone == p.phone, patients.c.status == "Active", patients.c.deleted_at.is_(None), patients.c.id != me))).all():
            grants.setdefault(str(r.id), {"relation": "Registered on your mobile", "scopes": [FULL], "can_sign": False, "can_pay": True})
    for link in await find(ctx, "registration.family_links", related_patient=me, delegate_portal_access=True, limit=50):
        grants.setdefault(link["patient_id"], {"relation": f"Family ({link.get('relationship') or 'linked'})", "scopes": [FULL],
                                               "can_sign": False, "can_pay": bool(link.get("is_guarantor"))})
    d0 = today()
    for dl in await find(ctx, "portal.delegates", status="Active", delegate_patient=me, limit=50):
        vf, vu = parse_date(dl.get("valid_from")), parse_date(dl.get("valid_until"))
        if (vf and vf > d0) or (vu and vu < d0):
            continue
        grants.setdefault(dl["patient_id"], {"relation": dl.get("relation") or "Delegate", "scopes": dl.get("access_scope") or [],
                                             "can_sign": bool(dl.get("can_sign_consent")), "can_pay": bool(dl.get("can_pay_bills")),
                                             "delegate_id": dl["id"]})
    rows = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.title, patients.c.code, patients.c.dob, patients.c.gender, patients.c.status)
                                   .where(patients.c.id.in_(list(grants))))).all()
    out = []
    for r in rows:
        pid = str(r.id)
        if pid != me and r.status in ("Merged", "Deceased"):
            continue
        out.append({"id": pid, "name": r.title, "uhid": r.code, "age": age_from(r.dob), "gender": r.gender, "self": pid == me, **grants[pid]})
    out.sort(key=lambda x: (not x["self"], x["name"] or ""))
    ctx.__dict__["_portal_profiles"] = out
    return out


async def subject(ctx, pid: str | None, scope: str | None = None) -> dict:
    target = pid or ctx.user["patient_id"]
    prof = next((x for x in await profiles(ctx) if x["id"] == target), None)
    if not prof:
        raise ApiError(403, "You do not have access to this profile")
    if not _scope_ok(prof, scope):
        raise ApiError(403, f"Your access to {prof['name']} does not include {scope.lower()}")
    return prof


async def _names(ctx, table, ids: set) -> dict[str, str]:
    ids = {str(i) for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(table.c.id, table.c.title if table is not employees else table.c.name).where(table.c.id.in_(ids)))).all()
    return {str(a): b for a, b in rows}


@router.get("/me")
async def me(ctx: PatientCtxDep):
    profs = await profiles(ctx)
    p = rs.to_record((await ctx.conn.execute(sa.select(patients).where(patients.c.id == ctx.user["patient_id"]))).first())
    acct = await find(ctx, "portal.accounts", patient_id=p["id"], limit=1)
    keys = ("id", "code", "title", "first_name", "last_name", "gender", "dob", "blood_group", "phone", "email", "address", "city", "state",
            "pincode", "abha_id", "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relation", "allergies", "payer_type")
    a = acct[0] if acct else {}
    return {"patient": {**{k: p.get(k) for k in keys}, "age": age_from(p.get("dob"))},
            "account": {k: a.get(k) for k in ("code", "mobile", "email", "preferred_language", "notification_prefs", "last_login", "dpdp_consent_at")},
            "profiles": profs, "hospital": {"name": settings.hospital_name}}


@router.post("/logout")
async def logout(ctx: PatientCtxDep):
    await revoke_token(ctx.user["jti"], int(ctx.user["exp"] - now().timestamp()))
    return {"ok": True}


# ------------------------------------------------------------------ appointments

def _appt_out(a: dict, docs: dict, depts: dict) -> dict:
    d = parse_date(a.get("appt_date"))
    upcoming = bool(d and d >= today())
    return {"id": a["id"], "code": a.get("code"), "date": a.get("appt_date"), "slot": a.get("slot"), "token_no": a.get("token_no"),
            "status": a.get("status"), "type": a.get("type"), "reason": a.get("reason"), "doctor": docs.get(a.get("doctor_id") or ""),
            "doctor_id": a.get("doctor_id"), "department": depts.get(a.get("department_id") or ""),
            "can_cancel": upcoming and a.get("status") == "Booked", "teleconsult": a.get("teleconsult")}


async def _appointments(ctx, pid: str, limit: int = 100) -> list[dict]:
    rows = await find(ctx, APPT, patient_id=pid, sort="-appt_date", limit=limit)
    docs = await _names(ctx, employees, {r.get("doctor_id") for r in rows})
    depts = await _names(ctx, records, {r.get("department_id") for r in rows})
    return [_appt_out(r, docs, depts) for r in rows]


@router.get("/appointments")
async def my_appointments(ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_APPT)
    rows = await _appointments(ctx, prof["id"])
    t0 = today().isoformat()
    upcoming = sorted([r for r in rows if (r["date"] or "") >= t0 and r["status"] in ("Booked", "Checked-in", "In Consultation")],
                      key=lambda r: (r["date"], r["slot"] or ""))
    return {"upcoming": upcoming, "past": [r for r in rows if r not in upcoming]}


@router.get("/departments")
async def departments(ctx: PatientCtxDep):
    deps = await find(ctx, "mdm.departments", status="Active", limit=200)
    with_opd = {s.get("department") for s in await all_schedules(ctx)}
    return [{"id": d["id"], "name": d.get("name")} for d in sorted(deps, key=lambda x: x.get("name") or "")
            if d.get("opd_enabled", True) and d["id"] in with_opd]


@router.get("/doctors")
async def doctors(ctx: PatientCtxDep, date: str | None = None, department_id: str | None = None):
    await profiles(ctx)
    d = parse_date(date) or today()
    return [{k: x.get(k) for k in ("id", "name", "specialization", "department_id", "department", "sessions", "mode", "consult_fee")}
            | {"on_leave": bool(x.get("on_leave"))} for x in await consulting_doctors(ctx, d, department_id)]


@router.get("/slots")
async def slots(ctx: PatientCtxDep, doctor_id: str, date: str):
    await profiles(ctx)
    d = parse_date(date)
    if not d or d < today() or d > today() + timedelta(days=60):
        raise bad_request("Choose a date within the next 60 days")
    g = await slot_grid(ctx, doctor_id, d, with_patients=False)
    return {"date": g["date"], "doctor": {k: g["doctor"].get(k) for k in ("id", "name", "department", "specialization")},
            "on_leave": bool(g["on_leave"]), "consult_fee": g["consult_fee"], "room": g["room"],
            "sessions": [{"start": s["start"], "end": s["end"]} for s in g["sessions"]],
            "slots": [{"time": s["time"], "status": "taken" if s["status"] == "booked" else s["status"]} for s in g["slots"] if not s.get("off_grid")]}


class PortalBookIn(BaseModel):
    doctor_id: str
    date: str
    slot: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    type: Literal["New", "Follow-up", "Review with reports", "Teleconsult"] = "New"
    reason: str | None = Field(default=None, max_length=300)


@router.post("/appointments", status_code=201)
async def book_appointment(body: PortalBookIn, ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_APPT)
    d = parse_date(body.date)
    if not d or d > today() + timedelta(days=60):
        raise bad_request("Choose a date within the next 60 days")
    a = E(APPT).table
    open_n = (await ctx.conn.execute(sa.select(sa.func.count()).where(
        a.c.patient_id == prof["id"], a.c.status == "Booked", a.c.appt_date >= today(), a.c.deleted_at.is_(None)))).scalar_one()
    if open_n >= 5:
        raise conflict("You already have 5 upcoming appointments — cancel one or call the hospital to book more")
    rec = await book(ctx, BookIn(patient_id=prof["id"], doctor_id=body.doctor_id, appt_date=d.isoformat(), slot=body.slot, type=body.type,
                                 booking_source="Patient Portal", reason=body.reason), source="Patient Portal",
                     extra={"booked_by_portal": ctx.user["patient_id"]})
    docs = await _names(ctx, employees, {rec.get("doctor_id")})
    depts = await _names(ctx, records, {rec.get("department_id")})
    return _appt_out(rec, docs, depts)


class CancelIn(BaseModel):
    reason: str | None = Field(default=None, max_length=300)


@router.post("/appointments/{appt_id}/cancel")
async def cancel_appointment(appt_id: str, body: CancelIn, ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_APPT)
    a = await get(ctx, APPT, appt_id)
    if not a or a.get("patient_id") != prof["id"]:
        raise not_found("Appointment not found")
    if a.get("status") != "Booked" or (parse_date(a.get("appt_date")) or today()) < today():
        raise conflict("Only upcoming booked appointments can be cancelled online — please call the hospital")
    rec = await transition(ctx, APPT, appt_id, "Cancelled", values={"cancel_reason": "Patient request"},
                           note=f"Cancelled in patient portal{f': {body.reason}' if body.reason else ''}")
    docs = await _names(ctx, employees, {rec.get("doctor_id")})
    depts = await _names(ctx, records, {rec.get("department_id")})
    return _appt_out(rec, docs, depts)


# ------------------------------------------------------------------ reports

def _flags(values: list[dict] | None) -> int:
    return sum(1 for v in values or [] if (v.get("flag") or "Normal") != "Normal")


async def _reports(ctx, pid: str, limit: int = 100) -> list[dict]:
    o = orders
    rows = (await ctx.conn.execute(sa.select(o, services.c.title.label("test")).select_from(o.outerjoin(services, services.c.id == o.c.service_id))
                                   .where(o.c.patient_id == pid, o.c.deleted_at.is_(None), o.c.status == "Verified", o.c.category.in_(["LAB", "RAD"]))
                                   .order_by(o.c.verified_at.desc().nulls_last()).limit(limit))).all()
    out = []
    for r in rows:
        m = dict(r._mapping)
        test = m.pop("test")
        rec = rs.to_record(m)
        out.append({"id": rec["id"], "code": rec.get("code"), "test": test or "Investigation", "category": rec.get("category"),
                    "ordered_at": rec.get("ordered_at"), "verified_at": rec.get("verified_at"), "critical": bool(rec.get("critical")),
                    "abnormal": _flags(rec.get("result_values"))})
    return out


@router.get("/reports")
async def reports(ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_REPORTS)
    return await _reports(ctx, prof["id"])


@router.get("/reports/{order_id}")
async def report(order_id: str, ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_REPORTS)
    o = await get(ctx, "orders.orders", order_id)
    if not o or o.get("patient_id") != prof["id"] or o.get("status") != "Verified":
        raise not_found("Report not found")
    svc = (await ctx.conn.execute(sa.select(services.c.title, services.c.category).where(services.c.id == o.get("service_id")))).first() if o.get("service_id") else None
    p = rs.to_record((await ctx.conn.execute(sa.select(patients).where(patients.c.id == prof["id"]))).first())
    doctor = (await _names(ctx, employees, {o.get("ordering_doctor")})).get(o.get("ordering_doctor") or "")
    await audit(ctx, "portal.report.view", module="orders", entity="orders", record=o)
    return {"hospital": settings.hospital_name, "test": svc.title if svc else "Investigation", "category": o.get("category"),
            "order": {k: o.get(k) for k in ("id", "code", "ordered_at", "collected_at", "resulted_at", "verified_at", "critical", "priority",
                                            "result", "result_values", "impression", "sample_barcode")},
            "doctor": doctor, "patient": {"name": p.get("title"), "uhid": p.get("code"), "age": age_from(p.get("dob")), "gender": p.get("gender")}}


# ------------------------------------------------------------------ bills & receipts

async def _bills(ctx, pid: str) -> dict:
    inv = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(invoices).where(
        invoices.c.patient_id == pid, invoices.c.deleted_at.is_(None), invoices.c.status != "Cancelled")
        .order_by(invoices.c.billed_at.desc().nulls_last()).limit(100))).all()]
    codes = {i["id"]: i.get("code") for i in inv}
    pays = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(payments).where(
        payments.c.patient_id == pid, payments.c.deleted_at.is_(None), payments.c.status == "Success",
        payments.c.kind.in_(["PAYMENT", "DEPOSIT", "REFUND"])).order_by(payments.c.paid_at.desc().nulls_last()).limit(100))).all()]
    outstanding = sum(Decimal(str(i.get("balance") or 0)) for i in inv if i.get("status") in ("Final", "Partially Paid"))
    return {
        "invoices": [{k: i.get(k) for k in ("id", "code", "type", "billed_at", "gross", "discount", "tax", "net", "paid", "balance", "payer", "status")}
                     for i in inv],
        "receipts": [{**{k: p.get(k) for k in ("id", "code", "kind", "mode", "amount", "paid_at", "reference")},
                      "invoice": codes.get(p.get("invoice_id") or "")} for p in pays],
        "outstanding": float(outstanding),
    }


@router.get("/bills")
async def bills(ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_BILLS)
    return await _bills(ctx, prof["id"])


@router.get("/bills/{invoice_id}")
async def bill(invoice_id: str, ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_BILLS)
    inv = await get(ctx, "billing.invoices", invoice_id)
    if not inv or inv.get("patient_id") != prof["id"] or inv.get("status") == "Cancelled":
        raise not_found("Bill not found")
    lines = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(charges).where(
        charges.c.invoice_id == invoice_id, charges.c.deleted_at.is_(None)).order_by(charges.c.charged_at.asc()))).all()]
    pays = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(payments).where(
        payments.c.invoice_id == invoice_id, payments.c.deleted_at.is_(None), payments.c.status == "Success").order_by(payments.c.paid_at.asc()))).all()]
    p = rs.to_record((await ctx.conn.execute(sa.select(patients).where(patients.c.id == prof["id"]))).first())
    await audit(ctx, "portal.bill.view", module="billing", entity="invoices", record=inv)
    return {"hospital": settings.hospital_name, "patient": {"name": p.get("title"), "uhid": p.get("code")},
            "invoice": {k: inv.get(k) for k in ("id", "code", "type", "billed_at", "gross", "discount", "tax", "net", "paid", "balance", "payer", "status")},
            "lines": [{k: c.get(k) for k in ("description", "qty", "rate", "amount", "charged_at", "tax_percent")} for c in lines],
            "payments": [{k: x.get(k) for k in ("code", "kind", "mode", "amount", "paid_at", "reference")} for x in pays]}


# ------------------------------------------------------------------ prescriptions

async def _rx(ctx, pid: str) -> list[dict]:
    out: list[dict] = []
    sources = [("opd.prescriptions", "OPD", "items", "prescribed_at", "notes"),
               ("telemedicine.eprescriptions", "Teleconsult", "medicines", "signed_at", "advice")]
    groups = []
    for fqn, label, lines_key, date_key, note_key in sources:
        if not has(fqn):
            continue
        rows = await find(ctx, fqn, patient_id=pid, limit=60)
        if fqn == "telemedicine.eprescriptions":
            rows = [r for r in rows if r.get("status") in ("Signed", "Sent")]
        groups.append((rows, label, lines_key, date_key, note_key))
    drug_ids = {ln.get("drug") for rows, _label, lines_key, _d, _n in groups for r in rows for ln in r.get(lines_key) or []}
    doc_ids = {r.get("doctor") for g in groups for r in g[0]}
    drugs = await _names(ctx, records, drug_ids)
    docs = await _names(ctx, employees, doc_ids)
    for rows, label, lines_key, date_key, note_key in groups:
        for r in rows:
            if r.get("status") == "Cancelled":
                continue
            out.append({"id": r["id"], "code": r.get("code"), "source": label, "date": r.get(date_key) or r.get("created_at"),
                        "doctor": docs.get(r.get("doctor") or ""), "diagnosis": r.get("diagnosis"), "status": r.get("status"),
                        "notes": r.get(note_key), "valid_till": r.get("valid_till") or r.get("valid_until"),
                        "items": [{"drug": drugs.get(ln.get("drug") or "", "Medicine"), **{k: ln.get(k) for k in
                                   ("dose", "frequency", "route", "duration_days", "qty", "instructions")}} for ln in r.get(lines_key) or []]})
    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return out


@router.get("/prescriptions")
async def prescriptions(ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_RX)
    return await _rx(ctx, prof["id"])


# ------------------------------------------------------------------ e-consent

class _Safe(dict):
    def __missing__(self, k):
        return "{" + k + "}"


async def _consent_text(ctx, c: dict, patient: dict, language: str | None) -> tuple[str, str]:
    tpl = await get(ctx, "consents.templates", c.get("template")) if c.get("template") else None
    if not tpl:
        return c.get("risks_explained") or "", "English"
    body, lang = tpl.get("body") or "", "English"
    want = language or c.get("language")
    for tr in tpl.get("translations") or []:
        if tr.get("language") == want and tr.get("text"):
            body, lang = tr["text"], want
    doctor = (await _names(ctx, employees, {c.get("explained_by")})).get(c.get("explained_by") or "", "")
    vals = {"patient_name": patient.get("title") or "", "uhid": patient.get("code") or "", "procedure": c.get("procedure_name") or "",
            "doctor": doctor, "date": c.get("planned_date") or today().isoformat()}
    try:
        text = body.format_map(_Safe(vals))
    except (ValueError, IndexError):
        text = body
    if c.get("risks_explained"):
        text += f"\n\nSpecific risks, benefits and alternatives explained to me:\n{c['risks_explained']}"
    return text, lang


@router.get("/consents")
async def consents(ctx: PatientCtxDep, pid: str | None = None, language: str | None = None):
    prof = await subject(ctx, pid, S_CONSENT)
    if not has("consents.consents"):
        return []
    p = rs.to_record((await ctx.conn.execute(sa.select(patients).where(patients.c.id == prof["id"]))).first())
    rows = await find(ctx, "consents.consents", patient_id=prof["id"], limit=50)
    docs = await _names(ctx, employees, {r.get("explained_by") for r in rows})
    out = []
    for c in rows:
        if c.get("status") not in ("Pending", "Signed"):
            continue
        text, lang = await _consent_text(ctx, c, p, language)
        out.append({"id": c["id"], "code": c.get("code"), "consent_type": c.get("consent_type"), "procedure": c.get("procedure_name"),
                    "planned_date": c.get("planned_date"), "status": c.get("status"), "doctor": docs.get(c.get("explained_by") or ""),
                    "text": text, "language": lang, "signed_at": c.get("signed_at"), "signer_name": c.get("signer_name"),
                    "signer_relationship": c.get("signer_relationship"), "can_sign": c.get("status") == "Pending" and prof["can_sign"]})
    out.sort(key=lambda x: (x["status"] != "Pending", x["signed_at"] or ""))
    return out


class SignIn(BaseModel):
    signature: str = Field(min_length=30, max_length=800_000)
    agree: bool
    signer_name: str | None = Field(default=None, max_length=120)


@router.post("/consents/{consent_id}/sign")
async def sign_consent(consent_id: str, body: SignIn, ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_CONSENT)
    if not prof["can_sign"]:
        raise ApiError(403, "Only the patient or an authorised representative can sign this consent")
    if not body.agree:
        raise bad_request("Please confirm that you have read and understood the consent")
    c = await get(ctx, "consents.consents", consent_id)
    if not c or c.get("patient_id") != prof["id"]:
        raise not_found("Consent not found")
    if c.get("status") != "Pending":
        raise conflict(f"This consent is already {c.get('status', '').lower()}")
    me_row = (await ctx.conn.execute(sa.select(patients.c.title, patients.c.phone).where(patients.c.id == ctx.user["patient_id"]))).first()
    relation = "Self" if prof["self"] else SIGNER_RELATION.get(prof.get("relation") or "", "Legal Representative")
    rec = await rs.transition_record(ctx, E("consents.consents"), consent_id, "Signed", check=False,
                                     note="Signed in the patient portal (OTP-verified login)",
                                     values={"signature": body.signature, "signer_name": (body.signer_name or me_row.title or "")[:120],
                                             "signer_relationship": relation, "signer_phone": me_row.phone,
                                             "consent_mode": "Patient portal e-consent"})
    return {"id": rec["id"], "code": rec.get("code"), "status": rec.get("status"), "signed_at": rec.get("signed_at")}


# ------------------------------------------------------------------ teleconsults

def _join_window(scheduled: Any) -> tuple[bool, str | None]:
    at = parse_dt(scheduled) if scheduled else None
    if not at:
        return False, None
    n = now()
    if n < at - timedelta(minutes=30):
        return False, "Opens 30 minutes before your slot"
    if n > at + timedelta(hours=2):
        return False, "This consultation window has passed"
    return True, None


@router.get("/teleconsults")
async def teleconsults(ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_TELE)
    if not has("telemedicine.teleconsults"):
        return []
    rows = await find(ctx, "telemedicine.teleconsults", patient_id=prof["id"], sort="-scheduled_at", limit=50)
    docs = await _names(ctx, employees, {r.get("doctor") for r in rows})
    out = []
    for r in rows:
        ok, why = _join_window(r.get("scheduled_at")) if r.get("status") in ("Scheduled", "Waiting") else (False, None)
        out.append({"id": r["id"], "code": r.get("code"), "scheduled_at": r.get("scheduled_at"), "doctor": docs.get(r.get("doctor") or ""),
                    "mode": r.get("mode"), "consult_type": r.get("consult_type"), "status": r.get("status"), "fee": r.get("fee"),
                    "payment_status": r.get("payment_status"), "can_join": ok, "join_hint": why, "advice": r.get("advice"),
                    "follow_up_date": r.get("follow_up_date")})
    return out


@router.post("/teleconsults/{tc_id}/join")
async def join_teleconsult(tc_id: str, ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid, S_TELE)
    tc = await get(ctx, "telemedicine.teleconsults", tc_id)
    if not tc or tc.get("patient_id") != prof["id"]:
        raise not_found("Teleconsultation not found")
    if tc.get("status") not in ("Scheduled", "Waiting", "In Call"):
        raise conflict(f"This teleconsultation is {tc.get('status', '').lower()}")
    ok, why = _join_window(tc.get("scheduled_at"))
    if not ok and tc.get("status") != "In Call":
        raise conflict(why or "Not open yet")
    if not tc.get("meeting_link"):
        from .frontoffice import meeting_link

        tc = await update(ctx, "telemedicine.teleconsults", tc_id, {"meeting_link": meeting_link()})
    if tc.get("status") == "Scheduled":
        tc = await transition(ctx, "telemedicine.teleconsults", tc_id, "Waiting", note="Patient joined from the portal")
    return {"meeting_link": tc["meeting_link"], "status": tc.get("status")}


# ------------------------------------------------------------------ feedback & profile

class FeedbackIn(BaseModel):
    visit_type: Literal["OP", "IP", "ER", "Day Care"] = "OP"
    rating: int = Field(ge=1, le=5)
    nps: int | None = Field(default=None, ge=0, le=10)
    rating_doctor: int | None = Field(default=None, ge=1, le=5)
    rating_nursing: int | None = Field(default=None, ge=1, le=5)
    rating_front_office: int | None = Field(default=None, ge=1, le=5)
    rating_billing: int | None = Field(default=None, ge=1, le=5)
    rating_cleanliness: int | None = Field(default=None, ge=1, le=5)
    comments: str | None = Field(default=None, max_length=3000)
    callback_requested: bool = False
    department_id: str | None = None


@router.post("/feedback", status_code=201)
async def feedback(body: FeedbackIn, ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid)
    if await rate_limited(f"portal-feedback:{ctx.user['patient_id']}", 10, 86400):
        raise ApiError(429, "Thank you — you have already sent a lot of feedback today")
    data = body.model_dump(exclude={"department_id"}, exclude_none=True)
    if has("feedback.feedback"):
        rec = await create(ctx, "feedback.feedback", {**data, "patient_id": prof["id"], "channel": "Portal", "department": body.department_id,
                                                      "submitted_at": now().isoformat(timespec="seconds"), "status": "New"})
    else:
        vt = {"OP": "OPD", "IP": "IPD", "ER": "Emergency", "Day Care": "Day care"}[body.visit_type]
        rec = await create(ctx, "portal.feedback", {"patient_id": prof["id"], "channel": "Web portal", "visit_type": vt, "overall_rating": body.rating,
                                                    "nps": body.nps, "comments": body.comments, "department": body.department_id, "status": "New"})
    return {"code": rec.get("code"), "message": "Thank you for your feedback."}


class ProfileIn(BaseModel):
    email: str | None = Field(default=None, max_length=200)
    address: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=80)
    state: str | None = Field(default=None, max_length=80)
    pincode: str | None = Field(default=None, pattern=r"^\d{6}$")
    emergency_contact_name: str | None = Field(default=None, max_length=120)
    emergency_contact_phone: str | None = Field(default=None, max_length=20)
    emergency_contact_relation: str | None = None
    preferred_language: str | None = None
    notification_prefs: list[Literal["SMS", "WhatsApp", "Email", "Push"]] | None = None


@router.put("/profile")
async def update_profile(body: ProfileIn, ctx: PatientCtxDep):
    me_id = ctx.user["patient_id"]
    await profiles(ctx)
    patch = body.model_dump(exclude_unset=True, exclude={"preferred_language", "notification_prefs"})
    if patch:
        await rs.update_record(ctx, E("registration.patients"), me_id, patch, check=False)
    acct = await find(ctx, "portal.accounts", patient_id=me_id, limit=1)
    acct_patch = body.model_dump(exclude_unset=True, include={"preferred_language", "notification_prefs"})
    if "email" in patch:
        acct_patch["email"] = patch["email"]
    if acct and acct_patch:
        await rs.update_record(ctx, E("portal.accounts"), acct[0]["id"], acct_patch, check=False)
    return await me(ctx)


class MobileIn(BaseModel):
    mobile: str
    otp: str | None = None


@router.post("/profile/mobile")
async def change_mobile(body: MobileIn, ctx: PatientCtxDep):
    """Two steps: without `otp` an OTP is sent to the new number; with it, the number is changed."""
    me_id = ctx.user["patient_id"]
    await profiles(ctx)
    new = _digits10(body.mobile)
    if len(new) != 10 or new[0] not in "6789":
        raise bad_request("Enter a valid 10-digit Indian mobile number")
    key = f"{me_id}:{new}"
    if not body.otp:
        if await rate_limited(f"otp:{new}", 5, 3600):
            raise ApiError(429, "Too many OTP requests for this number. Try again later.")
        code = await otp_issue("portal-mobile", key)
        await emit("otp.requested", ctx, {"phone": new, "otp": code, "purpose": "portal-mobile-change", "patient_id": me_id})
        out: dict[str, Any] = {"sent": True, "to": mask_phone(new)}
        if settings.env == "development":
            out["dev_otp"] = code
        return out
    if not await otp_verify("portal-mobile", key, body.otp):
        raise bad_request("The OTP is incorrect or has expired")
    await rs.update_record(ctx, E("registration.patients"), me_id, {"phone": new}, check=False)
    acct = await find(ctx, "portal.accounts", patient_id=me_id, limit=1)
    if acct:
        await rs.update_record(ctx, E("portal.accounts"), acct[0]["id"], {"mobile": new}, check=False)
    await audit(ctx, "portal.mobile.change", module="registration", entity="patients", record={"id": me_id, "patient_id": me_id},
                note=f"Mobile changed to {mask_phone(new)} after OTP verification")
    return await me(ctx)


# ------------------------------------------------------------------ home

@router.get("/home")
async def home(ctx: PatientCtxDep, pid: str | None = None):
    prof = await subject(ctx, pid)
    out: dict[str, Any] = {"profile": prof, "hospital": settings.hospital_name}
    if _scope_ok(prof, S_APPT):
        appts = await my_appointments(ctx, prof["id"])
        out["upcoming"] = appts["upcoming"][:3]
    if _scope_ok(prof, S_REPORTS):
        out["reports"] = (await _reports(ctx, prof["id"], 5))
    if _scope_ok(prof, S_BILLS):
        b = await _bills(ctx, prof["id"])
        out["dues"] = {"outstanding": b["outstanding"], "open_bills": sum(1 for i in b["invoices"] if i["status"] in ("Final", "Partially Paid"))}
    if _scope_ok(prof, S_CONSENT) and has("consents.consents"):
        out["consents_pending"] = len(await find(ctx, "consents.consents", patient_id=prof["id"], status="Pending", limit=50))
    if _scope_ok(prof, S_TELE):
        out["teleconsults"] = [t for t in await teleconsults(ctx, prof["id"]) if t["status"] in ("Scheduled", "Waiting", "In Call")][:3]
    return out


# ------------------------------------------------------------------ staff: adoption statistics

@router.get("/admin/stats")
async def admin_stats(ctx: CtxDep):
    rs.ensure_access(ctx, E("portal.accounts"), "read")
    t, al = records, audit_log
    base = [t.c.module == "portal", t.c.entity == "accounts", t.c.deleted_at.is_(None)]
    by_status = dict((await ctx.conn.execute(sa.select(t.c.status, sa.func.count()).where(*base).group_by(t.c.status))).all())
    since30 = now() - timedelta(days=30)
    start_today = datetime.combine(today(), datetime.min.time(), settings.tz)
    new30 = (await ctx.conn.execute(sa.select(sa.func.count()).where(*base, t.c.created_at >= since30))).scalar_one()
    platform = sa.func.jsonb_array_elements_text(t.c.data["app_platform"]).table_valued("value").alias("pl")
    platforms = dict((await ctx.conn.execute(sa.select(platform.c.value, sa.func.count()).select_from(t).join(platform, sa.true())
                                             .where(*base).group_by(platform.c.value))).all())

    async def audit_counts(action: str) -> dict:
        q = [al.c.action == action, al.c.at >= since30]
        total = (await ctx.conn.execute(sa.select(sa.func.count()).where(*q))).scalar_one()
        today_n = (await ctx.conn.execute(sa.select(sa.func.count()).where(al.c.action == action, al.c.at >= start_today))).scalar_one()
        uniq = (await ctx.conn.execute(sa.select(sa.func.count(sa.distinct(al.c.patient_id))).where(*q))).scalar_one()
        day = sa.func.date(sa.func.timezone(settings.timezone, al.c.at))
        series = dict((await ctx.conn.execute(sa.select(day, sa.func.count()).where(al.c.action == action, al.c.at >= now() - timedelta(days=14))
                                              .group_by(day))).all())
        return {"today": today_n, "d30": total, "unique_30d": uniq, "series": series}

    logins, otps = await audit_counts("portal.login"), await audit_counts("portal.otp")
    patients_total = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(patients).where(
        patients.c.deleted_at.is_(None), patients.c.status == "Active"))).scalar_one()
    accounts = sum(by_status.values())
    series = []
    for i in range(13, -1, -1):
        d: date = today() - timedelta(days=i)
        series.append({"date": d.isoformat(), "logins": int(logins["series"].get(d, 0)), "otps": int(otps["series"].get(d, 0))})
    fb = {"d30": 0, "avg_rating": None}
    if has("feedback.feedback"):
        f = records
        fbase = [f.c.module == "feedback", f.c.entity == "feedback", f.c.deleted_at.is_(None), f.c.data["channel"].astext == "Portal",
                 f.c.created_at >= since30]
        n, avg = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.avg(sa.cast(f.c.data["rating"].astext, sa.Numeric))).where(*fbase))).one()
        fb = {"d30": n, "avg_rating": round(float(avg), 2) if avg is not None else None}
    portal_bookings = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(E(APPT).table).where(
        E(APPT).table.c.data["booking_source"].astext == "Patient Portal", E(APPT).table.c.created_at >= since30))).scalar_one()
    return {
        "accounts": accounts, "active": by_status.get("Active", 0), "blocked": by_status.get("Blocked", 0), "new_30d": new30,
        "platforms": platforms, "patients": patients_total, "adoption_pct": round(accounts / patients_total * 100, 1) if patients_total else 0,
        "logins": {k: v for k, v in logins.items() if k != "series"}, "otps": {k: v for k, v in otps.items() if k != "series"},
        "series": series, "feedback": fb, "portal_bookings_30d": portal_bookings, "portal_path": "/portal",
    }


__all__ = ["router", "public_router", "profiles", "subject", "to_json_value"]
