"""Master Patient Index: registration with duplicate detection, ID masking, merge,
QR / OTP pre-registration and the patient 360° summary + longitudinal timeline."""

from __future__ import annotations

import re
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit, hook
from ..core.registry import all_entities, get_entity
from ..core.security import CtxDep, PublicCtxDep
from ..core.util import ApiError, age_from, bad_request, is_uuid, mask_id, not_found, now, parse_date, to_json_value
from ..redis import otp_issue, otp_verify, rate_limited
from ..schema import ENTITY_TABLES, charges, encounters, invoices, orders, patients
from ._common import E, create, find, transition

router = APIRouter(prefix="/api/patients", tags=["patients"])
public_router = APIRouter(prefix="/api/public", tags=["public"])

PFQN = "registration.patients"


def _digits(s: Any) -> str:
    return re.sub(r"\D", "", str(s or ""))


# ------------------------------------------------------------------ hooks

@hook(PFQN, "before_create")
@hook(PFQN, "before_update")
async def _normalise(ctx, nxt, prev=None):
    if nxt.get("id_number"):
        raw = str(nxt["id_number"])
        if not raw.startswith("X") and len(_digits(raw)) > 4:
            nxt["id_number"] = mask_id(raw)
    if nxt.get("phone"):
        d = _digits(nxt["phone"])
        nxt["phone"] = d[-10:] if len(d) >= 10 and d.startswith("91") and len(d) == 12 else d
    if nxt.get("abha_id"):
        nxt["abha_id"] = _digits(nxt["abha_id"])[:14] or None
    for k in ("first_name", "last_name"):
        if nxt.get(k):
            nxt[k] = " ".join(str(nxt[k]).split()).title()


@hook("registration.merge_requests", "before_transition")
async def _merge(ctx, nxt, prev):
    if nxt["status"] != "Merged":
        return
    primary, dup = nxt.get("primary_patient"), nxt.get("duplicate_patient")
    if not primary or not dup or primary == dup:
        raise bad_request("Choose two different patients to merge")
    moved = {}
    for name, t in ENTITY_TABLES.items():
        if name == "patients" or "patient_id" not in t.c:
            continue
        res = await ctx.conn.execute(t.update().where(t.c.patient_id == dup).values(patient_id=primary))
        if res.rowcount:
            moved[str(name)] = res.rowcount
    await ctx.conn.execute(patients.update().where(patients.c.id == dup).values(status="Merged", merged_into=primary, updated_at=now()))
    nxt["moved"] = moved
    await audit(ctx, "patient.merge", module="registration", entity="patients", record={"id": primary},
                after={"duplicate": dup, "moved": moved})


# ------------------------------------------------------------------ duplicate detection

class DupIn(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    phone: str | None = None
    dob: str | None = None
    id_number: str | None = None
    abha_id: str | None = None


async def find_duplicates(ctx, body: DupIn) -> list[dict]:
    t = patients
    conds = []
    phone = _digits(body.phone)[-10:] if body.phone else None
    if phone:
        conds.append(t.c.phone == phone)
    if body.abha_id and _digits(body.abha_id):
        conds.append(t.c.abha_id == _digits(body.abha_id))
    if body.id_number and len(_digits(body.id_number)) >= 4:
        conds.append(t.c.id_number.like(f"%{_digits(body.id_number)[-4:]}"))
    if body.first_name and body.dob:
        conds.append(sa.and_(sa.func.lower(t.c.first_name) == body.first_name.strip().lower(), t.c.dob == parse_date(body.dob)))
    if not conds:
        return []
    rows = (await ctx.conn.execute(
        sa.select(t).where(sa.or_(*conds), t.c.deleted_at.is_(None), t.c.status != "Merged").limit(10)
    )).all()
    out = []
    for r in rows:
        rec = rs.to_record(r)
        reasons, score = [], 0
        if phone and rec.get("phone") == phone:
            reasons.append("same mobile")
            score += 35
        if body.abha_id and rec.get("abha_id") == _digits(body.abha_id):
            reasons.append("same ABHA")
            score += 60
        if body.id_number and rec.get("id_number", "").endswith(_digits(body.id_number)[-4:]):
            reasons.append("ID ends with same 4 digits")
            score += 20
        if body.first_name and (rec.get("first_name") or "").lower() == body.first_name.strip().lower():
            reasons.append("same first name")
            score += 20
        if body.last_name and (rec.get("last_name") or "").lower() == body.last_name.strip().lower():
            score += 10
        if body.dob and rec.get("dob") == body.dob:
            reasons.append("same date of birth")
            score += 25
        out.append({"id": rec["id"], "code": rec["code"], "title": rec["title"], "phone": rec.get("phone"), "dob": rec.get("dob"),
                    "gender": rec.get("gender"), "reasons": reasons, "score": min(score, 100)})
    return sorted(out, key=lambda x: -x["score"])


@router.post("/check-duplicates")
async def check_duplicates(body: DupIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "read")
    return await find_duplicates(ctx, body)


class RegisterIn(BaseModel):
    patient: dict[str, Any]
    force: bool = False
    pre_registration_id: str | None = None


@router.post("/register", status_code=201)
async def register(body: RegisterIn, ctx: CtxDep):
    ent = E(PFQN)
    rs.ensure_access(ctx, ent, "write")
    p = body.patient
    if not body.force:
        dups = await find_duplicates(ctx, DupIn(**{k: p.get(k) for k in DupIn.model_fields}))
        strong = [d for d in dups if d["score"] >= 55]
        if strong:
            raise ApiError(409, "Possible duplicate patient found", {"duplicates": strong}, code="DUPLICATE")
    rec = await rs.create_record(ctx, ent, {**p, "status": "Active"})
    if body.pre_registration_id and get_entity("registration.pre_registrations"):
        try:
            await rs.update_record(ctx, E("registration.pre_registrations"), body.pre_registration_id,
                                   {"status": "Converted", "converted_patient": rec["id"]}, check=False, trusted=True)
        except ApiError:
            pass
    await emit("patient.registered", ctx, {"patient": rec})
    return rec


# ------------------------------------------------------------------ 360 summary

async def _patient(ctx, pid: str) -> dict:
    if not is_uuid(pid):
        raise not_found("Patient not found")
    row = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid, patients.c.deleted_at.is_(None)))).first()
    if not row:
        raise not_found("Patient not found")
    rec = rs.to_record(row)
    rec["age"] = age_from(rec.get("dob"))
    return rec


async def account_totals(ctx, pid: str) -> dict:
    unbilled = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(charges.c.amount), 0)).where(
        charges.c.patient_id == pid, charges.c.status == "Unbilled", charges.c.deleted_at.is_(None)))).scalar_one()
    outstanding = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(invoices.c.balance), 0)).where(
        invoices.c.patient_id == pid, invoices.c.status.in_(["Final", "Partially Paid"]), invoices.c.deleted_at.is_(None)))).scalar_one()
    from .billing import deposit_balance

    return {"unbilled": float(unbilled), "outstanding": float(outstanding), "deposit_balance": float(await deposit_balance(ctx, pid))}


@router.get("/{pid}/summary")
async def summary(pid: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "read")
    p = await _patient(ctx, pid)
    await audit(ctx, "patient.view", module="registration", entity="patients", record=p)
    enc = (await ctx.conn.execute(
        sa.select(encounters).where(encounters.c.patient_id == pid, encounters.c.deleted_at.is_(None))
        .order_by(encounters.c.started_at.desc().nulls_last()).limit(15))).all()
    enc_recs = [rs.to_record(e) for e in enc]
    active = next((e for e in enc_recs if e.get("status") in ("Admitted", "Discharge Initiated", "Waiting", "In Treatment", "Observation", "Open")), None)
    ords = (await ctx.conn.execute(
        sa.select(orders).where(orders.c.patient_id == pid, orders.c.deleted_at.is_(None))
        .order_by(orders.c.ordered_at.desc().nulls_last()).limit(30))).all()
    ord_recs = [rs.to_record(o) for o in ords]
    allergies = list(p.get("allergies") or [])
    for a in await find(ctx, "emr.allergies", patient_id=pid, status="Active", limit=50):
        name = a.get("allergen")
        if name and name not in allergies:
            allergies.append(name)
    problems = await find(ctx, "emr.problems", patient_id=pid, status="Active", limit=20)
    vitals = await find(ctx, "emr.vitals", patient_id=pid, sort="-recorded_at", limit=20)
    appts = await find(ctx, "appointments.appointments", patient_id=pid, sort="-appt_date", limit=10)
    rx = await find(ctx, "opd.prescriptions", patient_id=pid, limit=10)
    family = await find(ctx, "registration.family_links", patient_id=pid, limit=20)
    refs = await rs.resolve_refs(ctx, E("ipd.encounters"), enc_recs)
    refs.update(await rs.resolve_refs(ctx, E("orders.orders"), ord_recs))
    for group in (appts, rx, family, problems, vitals):
        for r in group:
            refs.update(r.pop("_refs", {}) or {})
    alerts = []
    if allergies:
        alerts.append({"tone": "red", "text": f"Allergies: {', '.join(allergies[:6])}"})
    crit = [o for o in ord_recs if o.get("critical") and not o.get("acknowledged_at")]
    if crit:
        alerts.append({"tone": "red", "text": f"{len(crit)} critical result(s) awaiting acknowledgement"})
    if active and active.get("mlc"):
        alerts.append({"tone": "amber", "text": "Medico-legal case"})
    if p.get("status") == "Deceased":
        alerts.append({"tone": "gray", "text": "Patient deceased"})
    if p.get("merged_into"):
        alerts.append({"tone": "amber", "text": "This UHID was merged into another record"})
    return {
        "patient": p, "active_encounter": active, "encounters": enc_recs, "orders": ord_recs,
        "allergies": allergies, "problems": problems, "vitals": vitals, "appointments": appts,
        "prescriptions": rx, "family": family, "account": await account_totals(ctx, pid),
        "alerts": alerts, "refs": refs,
    }


@router.get("/{pid}/timeline")
async def timeline(pid: str, ctx: CtxDep, limit: int = 150):
    """Longitudinal record: every patient-linked record across all modules, newest first."""
    rs.ensure_access(ctx, E(PFQN), "read")
    await _patient(ctx, pid)
    readable = {}
    from ..core.rbac import check_access

    for ent in all_entities():
        if ent.d.patient and not ent.restricted and check_access(ctx.user, ent.module, ent, "read").ok:
            readable[(ent.table.name, ent.module_id, ent.key)] = ent
    events = []
    rec_t = ENTITY_TABLES["records"]
    rows = (await ctx.conn.execute(
        sa.select(rec_t.c.id, rec_t.c.code, rec_t.c.title, rec_t.c.status, rec_t.c.module, rec_t.c.entity, rec_t.c.created_at, rec_t.c.created_by)
        .where(rec_t.c.patient_id == pid, rec_t.c.deleted_at.is_(None)).order_by(rec_t.c.created_at.desc()).limit(limit))).all()
    for r in rows:
        ent = readable.get(("records", r.module, r.entity))
        if ent:
            events.append({"id": str(r.id), "code": r.code, "title": r.title, "status": r.status, "module": r.module,
                           "entity": r.entity, "label": ent.singular, "module_name": ent.module.name, "at": to_json_value(r.created_at)})
    for tname, label_ent in (("encounters", "ipd.encounters"), ("orders", "orders.orders"), ("invoices", "billing.invoices"),
                             ("payments", "billing.payments"), ("appointments", "appointments.appointments")):
        ent = get_entity(label_ent)
        if not ent or not check_access(ctx.user, ent.module, ent, "read").ok:
            continue
        t = ENTITY_TABLES[tname]
        rows = (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.title, t.c.status, t.c.created_at)
                                       .where(t.c.patient_id == pid, t.c.deleted_at.is_(None)).order_by(t.c.created_at.desc()).limit(60))).all()
        for r in rows:
            events.append({"id": str(r.id), "code": r.code, "title": r.title, "status": r.status, "module": ent.module_id,
                           "entity": ent.key, "label": ent.singular, "module_name": ent.module.name, "at": to_json_value(r.created_at)})
    events.sort(key=lambda e: e["at"] or "", reverse=True)
    return events[:limit]


# ------------------------------------------------------------------ QR pre-registration (public)

class OtpIn(BaseModel):
    phone: str


@public_router.post("/pre-register/otp")
async def pre_register_otp(body: OtpIn, ctx: PublicCtxDep):
    phone = _digits(body.phone)[-10:]
    if len(phone) != 10:
        raise bad_request("Enter a 10-digit mobile number")
    if await rate_limited(f"otp:{phone}", 5, 3600) or await rate_limited(f"otp-ip:{ctx.ip}", 20, 3600):
        raise ApiError(429, "Too many OTP requests. Try again later.")
    code = await otp_issue("prereg", phone)
    await emit("otp.requested", ctx, {"phone": phone, "otp": code, "purpose": "pre-registration"})
    out: dict[str, Any] = {"sent": True}
    if settings.env == "development":
        out["dev_otp"] = code  # development only — production sends via SMS/WhatsApp gateway
    return out


class PreRegIn(BaseModel):
    phone: str
    otp: str
    first_name: str
    last_name: str | None = None
    gender: str | None = None
    dob: str | None = None
    email: str | None = None
    preferred_department: str | None = None
    preferred_date: str | None = None


@public_router.post("/pre-register", status_code=201)
async def pre_register(body: PreRegIn, ctx: PublicCtxDep):
    phone = _digits(body.phone)[-10:]
    if not await otp_verify("prereg", phone, body.otp):
        raise bad_request("The OTP is incorrect or has expired")
    data = body.model_dump(exclude={"otp"})
    data.update(phone=phone, source="QR", otp_verified=True)
    rec = await create(ctx, "registration.pre_registrations", {k: v for k, v in data.items() if v not in (None, "")})
    return {"code": rec["code"], "message": "Pre-registration received. Show this code at the registration desk."}


@public_router.get("/hospital")
async def hospital_info(ctx: PublicCtxDep):
    deps = await find(ctx, "mdm.departments", status="Active", limit=100)
    return {"name": settings.hospital_name, "departments": [{"id": d["id"], "name": d.get("name")} for d in deps if d.get("opd_enabled", True)]}


__all__ = ["router", "public_router", "account_totals", "find_duplicates", "transition"]
