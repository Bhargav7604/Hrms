"""OPD clinic flow: nurse worklist (OP vitals + nursing assessment), My Clinic (doctor's day view) and
the OP EMR encounter (structured clinical note in the department's format, prescribing with safety
checks, investigations, diagnosis / advice / follow-up, close or cancel).

Visit status shown on every OPD screen:
    Not arrived (Booked) → Awaiting vitals (checked in) → Waiting (vitals done) → With doctor → Seen
The appointment stays the source of truth; vitals live in emr.vitals, the nursing assessment in
opd.nursing_assessments and the consultation in opd.consultations, all tied to the OPD encounter.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core import records as rs
from ..core.audit import audit
from ..core.security import CtxDep
from ..core.util import (
    age_from,
    bad_request,
    conflict,
    forbidden,
    is_uuid,
    not_found,
    now,
    parse_date,
    parse_dt,
    to_json_value,
    today,
)
from ..schema import appointments, charges, employees, files, invoices, orders, patients, records, services
from ._common import E, create, find, get, has, require_role, transition, update

log = logging.getLogger("vlack.opd")
router = APIRouter(prefix="/api/opd", tags=["opd"])

APPT = "appointments.appointments"
CONSULT = "opd.consultations"
RX = "opd.prescriptions"
VITALS = "emr.vitals"
NA = "opd.nursing_assessments"
ENC = "ipd.encounters"
INACTIVE = ("Cancelled", "No-show")
CLINIC_VIEW_ROLES = ("doctor", "nurse")
STAGES = ["Not arrived", "Awaiting vitals", "Waiting", "With doctor", "Seen"]

# 13 OP clinical-note formats; the structured section of each is the clinical form "op.note.<key>" (forms engine).
NOTE_FORMATS: list[dict[str, Any]] = [
    {"key": "general_medicine", "label": "General medicine", "departments": ["GMED", "GAST", "NEPH", "NEUR", "ONCO", "UROL", "GSUR", "EMED", "CRIT"]},
    {"key": "obgyn", "label": "Obstetrics & gynaecology", "departments": ["OBGY"]},
    {"key": "paediatrics", "label": "Paediatrics & growth", "departments": ["PAED"]},
    {"key": "dermatology", "label": "Dermatology", "departments": ["DERM"]},
    {"key": "physiotherapy", "label": "Physiotherapy & pain", "departments": ["PHYS"]},
    {"key": "cardiology", "label": "Cardiology", "departments": ["CARD"]},
    {"key": "ophthalmology", "label": "Ophthalmology", "departments": ["OPHT"]},
    {"key": "ent", "label": "ENT", "departments": ["ENT"]},
    {"key": "orthopaedics", "label": "Orthopaedics", "departments": ["ORTH"]},
    {"key": "psychiatry", "label": "Psychiatry", "departments": ["PSYC"]},
    {"key": "pulmonology", "label": "Pulmonology", "departments": ["PULM"]},
    {"key": "dental", "label": "Dental", "departments": ["DENT"]},
    {"key": "rehabilitation", "label": "Rehabilitation", "departments": []},
]
FORMAT_KEYS = {f["key"] for f in NOTE_FORMATS}
# general clinical-note fields (rendered through the doctor's consultation format, screen op.clinical_note)
NOTE_KEYS = ("chief_complaint", "hpi", "examination", "assessment", "plan", "past_history", "family_history", "social_history",
             "ros", "allergies_note", "current_medications", "provisional_diagnosis", "differential_diagnosis",
             "investigations_advised", "advice")
CONSULT_COLUMNS = {"chief_complaint", "hpi", "examination", "diagnosis", "icd_code", "plan", "advice", "follow_up_date",
                   "follow_up_at", "review_with_reports", "referred_to", "visit_type"}


def _emp(ctx) -> str | None:
    return ctx.user.get("employee_id")


def _view(ctx) -> None:
    require_role(ctx, *CLINIC_VIEW_ROLES, "management")


def _f(v: Any) -> float | None:
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


async def _titles(ctx, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    return {str(i): t for i, t in (await ctx.conn.execute(sa.select(records.c.id, records.c.title).where(records.c.id.in_(ids)))).all()}


# ------------------------------------------------------------------ visits of a day (shared by the worklist and My Clinic)

def _stage(status: str, vitals: bool) -> str:
    if status == "Booked":
        return "Not arrived"
    if status == "Checked-in":
        return "Waiting" if vitals else "Awaiting vitals"
    if status == "In Consultation":
        return "With doctor"
    if status == "Completed":
        return "Seen"
    return status


async def _vitals_today(ctx, pids: list[str], d_from: date, d_to: date) -> dict[str, dict]:
    """Latest vitals per patient recorded within the window."""
    if not pids:
        return {}
    ent = E(VITALS)
    t = ent.table
    at = t.c.data["recorded_at"].astext
    rows = (await ctx.conn.execute(
        sa.select(t.c.id, t.c.patient_id, t.c.encounter_id, t.c.data).where(
            *rs.base_where(ent), t.c.patient_id.in_(pids), sa.func.coalesce(t.c.status, "") != "Entered in Error",
            at >= d_from.isoformat(), at < (d_to + timedelta(days=1)).isoformat())
        .order_by(t.c.patient_id, at.desc()))).all()
    out: dict[str, dict] = {}
    for r in rows:
        out.setdefault(str(r.patient_id), {"id": str(r.id), "encounter_id": str(r.encounter_id) if r.encounter_id else None, **(r.data or {})})
    return out


async def _allergy_flags(ctx, pids: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    if not pids:
        return out
    for pid, tags in (await ctx.conn.execute(sa.select(patients.c.id, patients.c.data["allergies"]).where(patients.c.id.in_(pids)))).all():
        if isinstance(tags, list) and tags:
            out[str(pid)] = [str(x) for x in tags]
    if has("emr.allergies"):
        ent = E("emr.allergies")
        t = ent.table
        for pid, allergen in (await ctx.conn.execute(sa.select(t.c.patient_id, t.c.data["allergen"].astext).where(
                *rs.base_where(ent), t.c.patient_id.in_(pids), t.c.status == "Active",
                sa.func.coalesce(t.c.data["verification"].astext, "") != "Refuted"))).all():
            lst = out.setdefault(str(pid), [])
            if allergen and allergen not in lst:
                lst.append(allergen)
    return out


async def _consult_bills(ctx, appt_ids: list[str]) -> dict[str, dict]:
    """Bill number of each visit's consultation charge (if billed)."""
    if not appt_ids:
        return {}
    c, i = charges, invoices
    rows = (await ctx.conn.execute(sa.select(c.c.source_id, c.c.status, c.c.amount, i.c.code, i.c.status.label("inv_status"))
                                   .select_from(c.outerjoin(i, i.c.id == c.c.invoice_id))
                                   .where(c.c.source_id.in_(appt_ids), c.c.deleted_at.is_(None), c.c.status != "Cancelled"))).all()
    return {str(r.source_id): {"charge_status": r.status, "amount": float(r.amount or 0), "bill": r.code, "bill_status": r.inv_status} for r in rows}


async def day_visits(ctx, d_from: date, d_to: date, *, doctor_id: str | None = None, department_id: str | None = None,
                     q: str | None = None, include_booked: bool = True) -> list[dict]:
    a, p, e = appointments, patients, employees
    conds = [a.c.deleted_at.is_(None), a.c.appt_date >= d_from, a.c.appt_date <= d_to, a.c.status.notin_(INACTIVE)]
    if not include_booked:
        conds.append(a.c.status != "Booked")
    if doctor_id:
        conds.append(a.c.doctor_id == doctor_id)
    if department_id:
        conds.append(a.c.department_id == department_id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        conds.append(sa.or_(p.c.title.ilike(like), p.c.code.ilike(like), p.c.phone.like(like), a.c.code.ilike(like)))
    rows = (await ctx.conn.execute(
        sa.select(a, p.c.title.label("p_name"), p.c.code.label("p_uhid"), p.c.dob.label("p_dob"), p.c.gender.label("p_gender"),
                  p.c.phone.label("p_phone"), e.c.name.label("doc_name"), e.c.code.label("doc_code"))
        .select_from(a.join(p, p.c.id == a.c.patient_id).outerjoin(e, e.c.id == a.c.doctor_id))
        .where(*conds).order_by(a.c.appt_date, a.c.token_no.asc().nulls_last(), a.c.slot).limit(1500))).all()
    recs = []
    for r in rows:
        m = dict(r._mapping)
        extra = {k: m.pop(k) for k in ("p_name", "p_uhid", "p_dob", "p_gender", "p_phone", "doc_name", "doc_code")}
        rec = rs.to_record(m)
        rec.update(extra)
        recs.append(rec)
    pids = list({r["patient_id"] for r in recs})
    vit = await _vitals_today(ctx, pids, d_from, d_to)
    allergies = await _allergy_flags(ctx, pids)
    bills = await _consult_bills(ctx, [r["id"] for r in recs])
    depts = await _titles(ctx, {r.get("department_id") for r in recs})
    ts = now()
    out = []
    for r in recs:
        v = vit.get(r["patient_id"])
        has_vitals = bool(r.get("vitals_id")) or bool(v and (not r.get("encounter_id") or v.get("encounter_id") in (None, r.get("encounter_id"))))
        stage = _stage(r["status"], has_vitals)
        cin, cout = parse_dt(r.get("checked_in_at")), parse_dt(r.get("completed_at"))
        started = parse_dt(r.get("consult_started_at"))
        wait = None
        if cin and r["status"] == "Checked-in":
            wait = max(0, round((ts - cin).total_seconds() / 60))
        elif cin and started:
            wait = max(0, round((started - cin).total_seconds() / 60))
        b = bills.get(r["id"]) or {}
        out.append({
            "id": r["id"], "code": r.get("code"), "date": r.get("appt_date"), "slot": r.get("slot"), "token_no": r.get("token_no"),
            "type": r.get("type"), "status": r["status"], "stage": stage, "priority": r.get("visit_priority") or "Normal",
            "patient_id": r["patient_id"], "patient": r["p_name"], "uhid": r["p_uhid"], "age": age_from(r["p_dob"]), "gender": r["p_gender"],
            "phone": r["p_phone"], "doctor_id": r.get("doctor_id"), "doctor": r["doc_name"], "department_id": r.get("department_id"),
            "department": depts.get(r.get("department_id") or ""), "reason": r.get("reason"), "encounter_id": r.get("encounter_id"),
            "allergies": allergies.get(r["patient_id"], []), "vitals_done": has_vitals, "vitals_at": (v or {}).get("recorded_at") if has_vitals else None,
            "in_at": r.get("checked_in_at"), "out_at": r.get("completed_at"),
            "duration_min": max(0, round((cout - cin).total_seconds() / 60)) if cin and cout else None, "wait_min": wait,
            "bill": b.get("bill"), "bill_status": b.get("bill_status"), "charge_status": b.get("charge_status"),
            "consult_fee": b.get("amount"),
        })
    return out


# ------------------------------------------------------------------ nurse worklist

@router.get("/worklist")
async def worklist(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None, doctor_id: str | None = None,
                   department_id: str | None = None, q: str | None = None, stage: str | None = None):
    _view(ctx)
    d_from = parse_date(date_from) or today()
    d_to = parse_date(date_to) or d_from
    if d_to < d_from or (d_to - d_from).days > 31:
        raise bad_request("Choose a range of up to 31 days")
    rows = await day_visits(ctx, d_from, d_to, doctor_id=doctor_id if is_uuid(doctor_id) else None,
                            department_id=department_id if is_uuid(department_id) else None, q=q)
    consults = [r for r in rows if r["status"] != "Booked"]
    kpis = {"consultations": len(consults), "patients": len({r["patient_id"] for r in consults}),
            "vitals_done": sum(1 for r in consults if r["vitals_done"]),
            "awaiting_vitals": sum(1 for r in consults if r["stage"] == "Awaiting vitals"),
            "not_arrived": sum(1 for r in rows if r["stage"] == "Not arrived")}
    if stage:
        rows = [r for r in rows if r["stage"] == stage]
    order = {"Awaiting vitals": 0, "Waiting": 1, "With doctor": 2, "Not arrived": 3, "Seen": 4}
    rows.sort(key=lambda r: (r["date"] or "", order.get(r["stage"], 9), r["token_no"] or 9999))
    return {"rows": rows, "kpis": kpis, "doctors": _doctor_options(rows)}


def _doctor_options(rows: list[dict]) -> list[dict]:
    seen: dict[str, dict] = {}
    for r in rows:
        if r.get("doctor_id") and r["doctor_id"] not in seen:
            seen[r["doctor_id"]] = {"id": r["doctor_id"], "name": r.get("doctor"), "department": r.get("department")}
    return sorted(seen.values(), key=lambda x: x["name"] or "")


async def _appt(ctx, appt_id: str) -> dict:
    appt = await get(ctx, APPT, appt_id)
    if not appt:
        raise not_found("Visit not found")
    return appt


@router.post("/visits/{appt_id}/check-in")
async def check_in(appt_id: str, ctx: CtxDep):
    """Mark the patient as arrived (creates the OPD encounter, doctor token and consultation charge)."""
    require_role(ctx, "nurse", "front_office", "doctor")
    appt = await _appt(ctx, appt_id)
    if appt.get("status") != "Booked":
        raise conflict(f"The visit is already {appt.get('status')}")
    rec = await transition(ctx, APPT, appt_id, "Checked-in", note="Checked in at the OPD nursing station")
    return {"id": rec["id"], "status": rec["status"], "encounter_id": rec.get("encounter_id")}


async def ensure_encounter(ctx, appt: dict) -> str:
    """OPD encounter for a visit — visits checked in before encounters existed get one on first use."""
    if appt.get("encounter_id"):
        return appt["encounter_id"]
    if appt.get("status") in ("Booked", *INACTIVE):
        raise conflict("The patient has not checked in yet")
    started = appt.get("checked_in_at") or now().isoformat(timespec="seconds")
    enc = await create(ctx, ENC, {"patient_id": appt["patient_id"], "type": "OPD", "status": "Open", "doctor_id": appt.get("doctor_id"),
                                  "department_id": appt.get("department_id"), "started_at": started, "appointment": appt["id"]})
    await update(ctx, APPT, appt["id"], {"encounter_id": enc["id"]})
    appt["encounter_id"] = enc["id"]
    return enc["id"]


class VitalsIn(BaseModel):
    height: float | None = Field(default=None, ge=20, le=250, description="cm")
    weight: float | None = Field(default=None, ge=0.3, le=400, description="kg")
    bp_systolic: int | None = Field(default=None, ge=40, le=300)
    bp_diastolic: int | None = Field(default=None, ge=20, le=200)
    standing_bp_systolic: int | None = Field(default=None, ge=40, le=300)
    standing_bp_diastolic: int | None = Field(default=None, ge=20, le=200)
    pulse: int | None = Field(default=None, ge=20, le=250)
    resp_rate: int | None = Field(default=None, ge=4, le=80)
    spo2: int | None = Field(default=None, ge=40, le=100)
    o2_support: str | None = "Room air"
    temperature: float | None = Field(default=None, ge=90, le=110, description="°F")
    pain_score: int | None = Field(default=None, ge=0, le=10)
    blood_sugar: float | None = Field(default=None, ge=10, le=900, description="RBS mg/dL")
    head_circumference: float | None = Field(default=None, ge=20, le=70)
    waist: float | None = Field(default=None, ge=30, le=250, description="waist circumference, cm")
    muac: float | None = Field(default=None, ge=5, le=60)
    gcs: int | None = Field(default=None, ge=3, le=15)
    lmp: date | None = None
    blood_group: Literal["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] | None = None
    remarks: str | None = Field(default=None, max_length=500)


class AssessmentIn(BaseModel):
    chief_complaint: str | None = Field(default=None, max_length=1000)
    pain_location: str | None = Field(default=None, max_length=200)
    allergies_reviewed: bool | None = None
    fall_risk: Literal["Low", "Moderate", "High"] | None = None
    nutrition_risk: Literal["Not at risk", "At risk", "Malnourished"] | None = None
    mobility: Literal["Independent", "Assisted", "Wheelchair", "Stretcher"] | None = None
    lmp: str | None = None
    pregnancy_status: Literal["Not applicable", "Not pregnant", "Pregnant", "Unknown"] | None = None
    smoking: Literal["Never", "Former", "Current"] | None = None
    current_medications: str | None = Field(default=None, max_length=2000)
    observations: str | None = Field(default=None, max_length=3000)


class VisitVitalsIn(BaseModel):
    vitals: VitalsIn
    assessment: AssessmentIn | None = None


@router.get("/visits/{appt_id}/vitals")
async def visit_vitals(appt_id: str, ctx: CtxDep):
    _view(ctx)
    appt = await _appt(ctx, appt_id)
    vit = await get(ctx, VITALS, appt["vitals_id"]) if appt.get("vitals_id") else None
    na = await get(ctx, NA, appt["assessment_id"]) if appt.get("assessment_id") else None
    prev = [v for v in await find(ctx, VITALS, patient_id=appt["patient_id"], sort="-recorded_at", limit=6)
            if v.get("status") != "Entered in Error" and (not vit or v["id"] != vit["id"])]
    from .pharmacy import patient_allergies, patient_or_404

    p = await patient_or_404(ctx, appt["patient_id"])
    return {"appointment": {k: appt.get(k) for k in ("id", "code", "status", "type", "reason", "token_no", "encounter_id", "doctor_id")},
            "patient": {k: p.get(k) for k in ("id", "code", "title", "age", "gender", "dob", "blood_group", "phone")},
            "allergies": await patient_allergies(ctx, appt["patient_id"], p),
            "vitals": _vital_view(vit) if vit else None, "assessment": {k: v for k, v in (na or {}).items() if not k.startswith("_")} or None,
            "previous": [_vital_view(v) for v in prev[:5]]}


def _vital_view(v: dict) -> dict:
    keys = ("id", "code", "recorded_at", "height", "weight", "bmi", "bp_systolic", "bp_diastolic", "standing_bp_systolic",
            "standing_bp_diastolic", "pulse", "resp_rate", "spo2", "o2_support", "temperature", "pain_score", "blood_sugar",
            "head_circumference", "waist", "muac", "gcs", "lmp", "news2", "news2_risk", "remarks", "recorded_by", "status")
    return {k: v.get(k) for k in keys}


@router.post("/visits/{appt_id}/vitals", status_code=201)
async def save_visit_vitals(appt_id: str, body: VisitVitalsIn, ctx: CtxDep):
    """Capture (or correct) the OP vitals and nursing assessment of a visit."""
    require_role(ctx, "nurse", "doctor")
    appt = await _appt(ctx, appt_id)
    if appt.get("status") in INACTIVE or appt.get("status") == "Booked":
        raise conflict("Check the patient in before recording vitals")
    if appt.get("status") == "Completed" and appt.get("appt_date") != today().isoformat():
        raise conflict("This visit is closed")
    v = body.vitals.model_dump(exclude_none=True, mode="json")
    bg = v.pop("blood_group", None)
    if not {k for k in v if k not in ("o2_support", "remarks")}:
        raise bad_request("Enter at least one vital sign")
    if (v.get("bp_systolic") is None) != (v.get("bp_diastolic") is None):
        raise bad_request("Enter both systolic and diastolic BP", {"fields": {"bp_diastolic": "Required with systolic"}})
    if v.get("bp_systolic") and v.get("bp_diastolic") and v["bp_diastolic"] >= v["bp_systolic"]:
        raise bad_request("Diastolic BP must be lower than systolic", {"fields": {"bp_diastolic": "Check the value"}})
    eid = await ensure_encounter(ctx, appt)
    payload = {**v, "patient_id": appt["patient_id"], "encounter_id": eid, "recorded_by": _emp(ctx), "source": "OP nurse worklist",
               "appointment": appt_id}
    existing = await get(ctx, VITALS, appt["vitals_id"]) if appt.get("vitals_id") else None
    if existing and existing.get("status") == "Recorded":
        vit = await update(ctx, VITALS, existing["id"], payload)
    else:
        vit = await create(ctx, VITALS, {**payload, "recorded_at": now().isoformat(timespec="minutes"), "status": "Recorded"})
    na = None
    if body.assessment:
        a = body.assessment.model_dump(exclude_none=True)
        if a:
            data = {**a, "patient_id": appt["patient_id"], "encounter_id": eid, "appointment": appt_id, "vitals": vit["id"],
                    "assessed_by": _emp(ctx)}
            old = await get(ctx, NA, appt["assessment_id"]) if appt.get("assessment_id") else None
            na = await update(ctx, NA, old["id"], data) if old else await create(ctx, NA, {**data, "assessed_at": now().isoformat(timespec="minutes")})
    upd: dict[str, Any] = {"vitals_id": vit["id"], "vitals_at": now().isoformat(timespec="seconds"), "vitals_by": ctx.user.get("name")}
    if na:
        upd["assessment_id"] = na["id"]
        if a.get("chief_complaint") and not appt.get("reason"):
            upd["reason"] = a["chief_complaint"][:300]
    await update(ctx, APPT, appt_id, upd)
    if bg:
        cur = (await ctx.conn.execute(sa.select(patients.c.blood_group).where(patients.c.id == appt["patient_id"]))).scalar()
        if not cur or cur == "Unknown":
            await update(ctx, "registration.patients", appt["patient_id"], {"blood_group": bg})
    return {"vitals": _vital_view(vit), "assessment_id": na["id"] if na else None, "encounter_id": eid}


# ------------------------------------------------------------------ My Clinic

@router.get("/my-clinic")
async def my_clinic(ctx: CtxDep, date: str | None = None, doctor_id: str | None = None, department_id: str | None = None,
                    stage: str | None = None, q: str | None = None):
    """The doctor's day: booked → awaiting vitals → waiting → with doctor → seen, one click into the EMR.
    Doctors see their own clinic; nurses / admins / management may choose any doctor or all."""
    _view(ctx)
    d = parse_date(date) or today()
    me = _emp(ctx)
    if ctx.role == "doctor":
        doctor_id = me
        if not me:
            raise bad_request("Your login is not linked to a doctor profile — ask the administrator to link your employee record")
    rows = await day_visits(ctx, d, d, doctor_id=doctor_id if is_uuid(doctor_id) else None,
                            department_id=department_id if is_uuid(department_id) else None, q=q)
    counts = {s: sum(1 for r in rows if r["stage"] == s) for s in STAGES}
    kpis = {"booked": len(rows), "waiting": counts["Awaiting vitals"] + counts["Waiting"], "awaiting_vitals": counts["Awaiting vitals"],
            "with_doctor": counts["With doctor"], "seen": counts["Seen"], "not_arrived": counts["Not arrived"]}
    if stage:
        rows = [r for r in rows if r["stage"] == stage]
    order = {"With doctor": 0, "Waiting": 1, "Awaiting vitals": 2, "Not arrived": 3, "Seen": 4}
    rows.sort(key=lambda r: (order.get(r["stage"], 9), r["token_no"] or 9999))
    doctor = None
    if doctor_id and is_uuid(doctor_id):
        e = (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name, employees.c.department_id).where(employees.c.id == doctor_id))).first()
        if e:
            doctor = {"id": str(e.id), "name": e.name, "department": (await _titles(ctx, {str(e.department_id)})).get(str(e.department_id))}
    return {"date": d.isoformat(), "doctor": doctor, "rows": rows, "kpis": kpis, "updated_at": now().isoformat(timespec="seconds"),
            "can_choose_doctor": ctx.role != "doctor"}


@router.get("/doctors")
async def clinic_doctors(ctx: CtxDep, date: str | None = None):
    """Doctors with OP visits on a day (filters on the worklist / My Clinic)."""
    _view(ctx)
    d = parse_date(date) or today()
    a, e = appointments, employees
    rows = (await ctx.conn.execute(sa.select(e.c.id, e.c.name, e.c.department_id, sa.func.count()).select_from(a.join(e, e.c.id == a.c.doctor_id))
                                   .where(a.c.appt_date == d, a.c.deleted_at.is_(None), a.c.status.notin_(INACTIVE))
                                   .group_by(e.c.id, e.c.name, e.c.department_id).order_by(e.c.name))).all()
    depts = await _titles(ctx, {str(r.department_id) for r in rows if r.department_id})
    return [{"id": str(r.id), "name": r.name, "department_id": str(r.department_id) if r.department_id else None,
             "department": depts.get(str(r.department_id) or ""), "visits": r[3]} for r in rows]


# ------------------------------------------------------------------ OP EMR encounter

def _can_write(ctx, enc: dict) -> bool:
    if ctx.role == "admin":
        return True
    return ctx.role == "doctor" and (not enc.get("doctor_id") or enc.get("doctor_id") == _emp(ctx))


def _write(ctx, enc: dict) -> None:
    if ctx.role not in ("doctor", "admin"):
        raise forbidden("Only the consulting doctor can write the OP EMR")
    if not _can_write(ctx, enc):
        raise forbidden("This encounter belongs to another doctor")
    if enc.get("status") != "Open":
        raise conflict(f"Encounter {enc.get('code')} is {enc.get('status', '').lower()} — it can no longer be edited")


@router.post("/visits/{appt_id}/open")
async def open_visit(appt_id: str, ctx: CtxDep):
    """Open the EMR for a visit. The consulting doctor starts the consultation (With doctor); others only view."""
    _view(ctx)
    appt = await _appt(ctx, appt_id)
    if appt.get("status") in INACTIVE:
        raise conflict(f"The visit is {appt.get('status', '').lower()}")
    if appt.get("status") == "Booked":
        raise conflict("The patient has not checked in yet")
    eid = await ensure_encounter(ctx, appt)
    enc = await get(ctx, ENC, eid)
    if ctx.role in ("doctor", "admin") and _can_write(ctx, enc):
        if appt.get("status") == "Checked-in":
            appt = await transition(ctx, APPT, appt_id, "In Consultation", note="Opened in the OP EMR")
        await _consultation(ctx, appt, enc, create_if_missing=enc.get("status") == "Open")
    return {"encounter_id": eid, "appointment_id": appt_id}


async def _consultation(ctx, appt: dict | None, enc: dict, *, create_if_missing: bool) -> dict | None:
    rows = await find(ctx, CONSULT, encounter_id=enc["id"], limit=5, sort="-consulted_at")
    if not rows and appt:
        rows = await find(ctx, CONSULT, appointment=appt["id"], limit=5, sort="-consulted_at")
    cons = next((c for c in rows if c.get("status") != "Cancelled"), rows[0] if rows else None)
    if cons or not create_if_missing:
        return cons
    from .clinical import VISIT_TYPES

    return await create(ctx, CONSULT, {
        "patient_id": enc["patient_id"], "encounter_id": enc["id"], "appointment": (appt or {}).get("id"),
        "doctor": enc.get("doctor_id") or _emp(ctx), "department": enc.get("department_id"),
        "visit_type": VISIT_TYPES.get((appt or {}).get("type") or "", "New"), "consulted_at": now().isoformat(timespec="minutes"),
        "chief_complaint": (appt or {}).get("reason"), "note_format": None, "status": "Open",
    })


async def _enc(ctx, eid: str) -> dict:
    enc = await get(ctx, ENC, eid)
    if not enc or enc.get("type") not in ("OPD", "TELE"):
        raise not_found("OP encounter not found")
    return enc


async def _dept_format(ctx, department_id: str | None) -> str:
    if not department_id or not is_uuid(department_id):
        return "general_medicine"
    code = (await ctx.conn.execute(sa.select(records.c.code).where(records.c.id == department_id))).scalar()
    for f in NOTE_FORMATS:
        if code in f["departments"]:
            return f["key"]
    return "general_medicine"


async def _rx_view(ctx, rx: dict | None) -> dict | None:
    if not rx:
        return None
    from .inventory import item_label, items_by_id

    items = await items_by_id(ctx, [ln.get("drug") for ln in rx.get("items") or [] if ln.get("drug")])
    lines = []
    for ln in rx.get("items") or []:
        it = items.get(ln.get("drug") or "")
        lines.append({**{k: ln.get(k) for k in ("drug", "drug_name", "dose", "route", "frequency", "duration_days", "qty", "instructions")},
                      "name": item_label(it) if it else ln.get("drug_name"), "strength": (it or {}).get("strength"),
                      "form": (it or {}).get("form"), "schedule": (it or {}).get("schedule"), "high_alert": bool((it or {}).get("high_alert"))})
    return {k: rx.get(k) for k in ("id", "code", "status", "prescribed_at", "diagnosis", "notes", "valid_till", "alerts_at_prescribing")} | {"items": lines}


@router.get("/emr/{eid}")
async def emr(eid: str, ctx: CtxDep):
    _view(ctx)
    enc = await _enc(ctx, eid)
    from .pharmacy import active_medications, patient_allergies, patient_or_404

    p = await patient_or_404(ctx, enc["patient_id"])
    await audit(ctx, "emr.op.view", module="opd", entity="consultations", record={"id": eid, "code": enc.get("code")}, note=p.get("code"))
    appt = await get(ctx, APPT, enc["appointment"]) if enc.get("appointment") else None
    if not appt:
        a = (await ctx.conn.execute(sa.select(appointments.c.id).where(appointments.c.encounter_id == eid).limit(1))).first()
        appt = await get(ctx, APPT, str(a.id)) if a else None
    cons = await _consultation(ctx, appt, enc, create_if_missing=False)
    rx = None
    if cons:
        rxs = [r for r in await find(ctx, RX, consultation=cons["id"], limit=5) if r.get("status") != "Cancelled"]
        rx = rxs[0] if rxs else None
    o, s = orders, services
    ords = (await ctx.conn.execute(sa.select(o.c.id, o.c.code, o.c.status, o.c.category, o.c.priority, o.c.ordered_at, o.c.critical,
                                             s.c.title.label("test"), s.c.code.label("test_code"), s.c.rate)
                                   .select_from(o.outerjoin(s, s.c.id == o.c.service_id))
                                   .where(o.c.encounter_id == eid, o.c.deleted_at.is_(None)).order_by(o.c.ordered_at))).all()
    names = await _titles(ctx, {enc.get("department_id")})
    doc = (await ctx.conn.execute(sa.select(employees.c.name).where(employees.c.id == enc["doctor_id"]))).scalar() if is_uuid(enc.get("doctor_id")) else None
    vit_rows = [v for v in await find(ctx, VITALS, patient_id=enc["patient_id"], sort="-recorded_at", limit=20) if v.get("status") != "Entered in Error"]
    latest = next((v for v in vit_rows if v.get("encounter_id") == eid), None) or (vit_rows[0] if vit_rows and (
        parse_date(vit_rows[0].get("recorded_at")) == today()) else None)
    na = await get(ctx, NA, appt["assessment_id"]) if appt and appt.get("assessment_id") else None
    meds = await active_medications(ctx, enc["patient_id"], exclude_rx=rx["id"] if rx else None)
    from .inventory import item_label, items_by_id

    items = await items_by_id(ctx, [m["item_id"] for m in meds])
    problems = await find(ctx, "emr.problems", patient_id=enc["patient_id"], status="Active", limit=30)
    history = await _history(ctx, enc["patient_id"], exclude=eid)
    docs = (await ctx.conn.execute(sa.select(files.c.id, files.c.name, files.c.mime, files.c.size, files.c.created_at).where(
        files.c.patient_id == enc["patient_id"], files.c.deleted_at.is_(None)).order_by(files.c.created_at.desc()).limit(30))).all()
    ai = None
    if has("ai.drafts"):
        drafts = await find(ctx, "ai.drafts", patient_id=enc["patient_id"], sort="-created_at", limit=3)
        d0 = next((d for d in drafts if d.get("draft_type") == "Patient Summary" and d.get("status") != "Rejected"), None)
        if d0:
            ai = {k: d0.get(k) for k in ("id", "code", "status", "content", "source", "model", "created_at", "confidence")}
    fmt = (cons or {}).get("note_format") or await _dept_format(ctx, enc.get("department_id"))
    return {
        "encounter": {**{k: enc.get(k) for k in ("id", "code", "type", "status", "started_at", "ended_at", "doctor_id", "department_id")},
                      "doctor": doc, "department": names.get(enc.get("department_id") or "")},
        "appointment": {k: appt.get(k) for k in ("id", "code", "type", "status", "token_no", "slot", "reason", "visit_priority", "checked_in_at")} if appt else None,
        "patient": {k: p.get(k) for k in ("id", "code", "title", "first_name", "last_name", "gender", "dob", "age", "phone", "blood_group",
                                          "category", "payer_type", "abha_id", "abha_address", "status")},
        "consultation": {k: v for k, v in (cons or {}).items() if not k.startswith("_")} or None,
        "note_format": fmt, "department_format": await _dept_format(ctx, enc.get("department_id")), "note_formats": NOTE_FORMATS,
        "prescription": await _rx_view(ctx, rx),
        "orders": [{"id": str(r.id), "code": r.code, "status": r.status, "category": r.category, "priority": r.priority, "test": r.test,
                    "test_code": r.test_code, "rate": float(r.rate or 0), "critical": bool(r.critical), "ordered_at": to_json_value(r.ordered_at)}
                   for r in ords],
        "vitals": {"latest": _vital_view(latest) if latest else None,
                   "series": [_vital_view(v) for v in reversed(vit_rows[:15])]},
        "assessment": {k: v for k, v in (na or {}).items() if not k.startswith("_")} or None,
        "allergies": await patient_allergies(ctx, enc["patient_id"], p),
        "problems": [{k: x.get(k) for k in ("id", "problem", "icd_code", "chronicity", "onset_date")} for x in problems],
        "active_meds": [{**{k: m.get(k) for k in ("item_id", "dose", "frequency", "route", "until", "prescription_code")},
                         "name": item_label(items.get(m["item_id"]))} for m in meds],
        "history": history,
        "documents": [{"id": str(r.id), "name": r.name, "mime": r.mime, "size": r.size, "created_at": to_json_value(r.created_at)} for r in docs],
        "ai_summary": ai,
        "can_edit": _can_write(ctx, enc) and enc.get("status") == "Open" and ctx.role in ("doctor", "admin"),
        "can_prescribe": ctx.role in ("doctor", "admin") and _can_write(ctx, enc),
    }


async def _history(ctx, pid: str, *, exclude: str | None = None, limit: int = 12) -> list[dict]:
    rows = [c for c in await find(ctx, CONSULT, patient_id=pid, sort="-consulted_at", limit=limit + 1)
            if c.get("encounter_id") != exclude and c.get("status") != "Cancelled"][:limit]
    refs: dict[str, str] = {}
    for r in rows:
        refs.update(r.pop("_refs", {}) or {})
    rx_by = {}
    if rows:
        t = E(RX).table
        for r in (await ctx.conn.execute(sa.select(t.c.data).where(*rs.base_where(E(RX)), t.c.data["consultation"].astext.in_([c["id"] for c in rows]),
                                                                  t.c.status != "Cancelled"))).all():
            d = r.data or {}
            rx_by[d.get("consultation")] = len(d.get("items") or [])
    return [{"id": c["id"], "code": c.get("code"), "date": c.get("consulted_at"), "doctor": refs.get(c.get("doctor") or ""),
             "department": refs.get(c.get("department") or ""), "chief_complaint": c.get("chief_complaint"), "diagnosis": c.get("diagnosis"),
             "icd_code": c.get("icd_code"), "advice": c.get("advice"), "status": c.get("status"), "encounter_id": c.get("encounter_id"),
             "medicines": rx_by.get(c["id"], 0), "follow_up": c.get("follow_up_at") or c.get("follow_up_date")} for c in rows]


class RxLineIn(BaseModel):
    drug: str | None = None
    drug_name: str | None = Field(default=None, max_length=200)
    dose: str | None = Field(default=None, max_length=60)
    route: str | None = Field(default=None, max_length=30)
    frequency: str | None = Field(default=None, max_length=20)
    duration_days: float | None = Field(default=None, ge=0, le=365)
    qty: float | None = Field(default=None, ge=0, le=10000)
    instructions: str | None = Field(default=None, max_length=200)


class RxSaveIn(BaseModel):
    items: list[RxLineIn] = Field(default_factory=list, max_length=40)
    notes: str | None = Field(default=None, max_length=1000)


class EmrSaveIn(BaseModel):
    consultation: dict[str, Any] = Field(default_factory=dict)
    note: dict[str, Any] | None = None
    note_format: str | None = None
    prescription: RxSaveIn | None = None


@router.put("/emr/{eid}")
async def save_emr(eid: str, body: EmrSaveIn, ctx: CtxDep):
    """Save the consultation (autosave-safe): general note fields, diagnosis, advice, follow-up and the prescription."""
    enc = await _enc(ctx, eid)
    _write(ctx, enc)
    appt = await get(ctx, APPT, enc["appointment"]) if enc.get("appointment") else None
    cons = await _consultation(ctx, appt, enc, create_if_missing=True)
    if cons.get("status") != "Open":
        raise conflict("This consultation is closed")
    fields = {k: v for k, v in body.consultation.items() if k in CONSULT_COLUMNS}
    for k in ("chief_complaint", "diagnosis", "icd_code"):
        if isinstance(fields.get(k), str):
            fields[k] = fields[k].strip()[:500] or None
    if fields.get("follow_up_at"):
        fu = parse_dt(fields["follow_up_at"])
        if not fu or fu.date() < today():
            raise bad_request("Follow-up must be today or later", {"fields": {"follow_up_at": "Check the date"}})
        fields["follow_up_date"] = fu.date().isoformat()
        fields["follow_up_at"] = fu.isoformat(timespec="minutes")
    if body.note is not None:
        note = {k: (str(v)[:5000] if v is not None else None) for k, v in body.note.items() if k in NOTE_KEYS}
        fields["note"] = {**(cons.get("note") or {}), **note}
        if note.get("chief_complaint") and "chief_complaint" not in fields:
            fields["chief_complaint"] = note["chief_complaint"][:500]
        if note.get("hpi") is not None:
            fields["hpi"] = note["hpi"]
        if note.get("examination") is not None:
            fields["examination"] = note["examination"]
        if note.get("plan") is not None:
            fields["plan"] = note["plan"]
        if note.get("advice") is not None and "advice" not in fields:
            fields["advice"] = note["advice"]
    if body.note_format:
        if body.note_format not in FORMAT_KEYS:
            raise bad_request("Unknown note format")
        fields["note_format"] = body.note_format
    if fields:
        cons = await update(ctx, CONSULT, cons["id"], fields)
    rx, alerts = None, []
    if body.prescription is not None:
        rx, alerts = await _save_rx(ctx, enc, cons, body.prescription)
    return {"consultation": {k: v for k, v in cons.items() if not k.startswith("_")}, "prescription": await _rx_view(ctx, rx),
            "alerts": alerts, "saved_at": now().isoformat(timespec="seconds")}


async def _save_rx(ctx, enc: dict, cons: dict, body: RxSaveIn) -> tuple[dict | None, list[dict]]:
    from .clinical import _rx_editable
    from .pharmacy import safety_check

    lines = []
    for i, ln in enumerate(body.items):
        if not ln.drug and not (ln.drug_name or "").strip():
            continue
        if ln.drug and not is_uuid(ln.drug):
            raise bad_request(f"Medicine {i + 1}: unknown drug")
        if not ln.qty or ln.qty <= 0:
            raise bad_request(f"Medicine {i + 1}: enter the quantity to dispense", {"fields": {f"items.{i}.qty": "Required"}})
        lines.append({k: v for k, v in ln.model_dump().items() if v not in (None, "")})
    existing = next((r for r in await find(ctx, RX, consultation=cons["id"], limit=5) if r.get("status") != "Cancelled"), None)
    if not lines:
        if existing:
            await _rx_editable(ctx, existing)
            await transition(ctx, RX, existing["id"], "Cancelled", values={"cancel_reason": "Therapy changed"}, note="All medicines removed in the OP EMR")
        return None, []
    payload = {"items": lines, "notes": body.notes, "diagnosis": cons.get("diagnosis")}
    if existing:
        await _rx_editable(ctx, existing)
        rx = await update(ctx, RX, existing["id"], payload)
    else:
        rx = await create(ctx, RX, {**payload, "patient_id": enc["patient_id"], "encounter_id": enc["id"], "consultation": cons["id"],
                                    "doctor": cons.get("doctor") or _emp(ctx), "prescribed_at": now().isoformat(timespec="minutes"),
                                    "status": "Active"})
    coded = [{"item_id": ln["drug"], "qty": ln.get("qty") or 0} for ln in lines if ln.get("drug")]
    alerts = []
    if coded:
        check = await safety_check(ctx, patient_id=enc["patient_id"], purpose="prescribe", prescription=rx, lines=coded)
        alerts = check["alerts"]
        severe = [a for a in alerts if a["severity"] in ("Major", "Contraindicated")]
        if severe:
            rx = await update(ctx, RX, rx["id"], {"alerts_at_prescribing": [{k: a.get(k) for k in ("type", "severity", "item", "with", "message")}
                                                                            for a in severe]})
            await audit(ctx, "rx.alerts_acknowledged", module="opd", entity="prescriptions", record=rx,
                        after={"alerts": [a["message"] for a in severe]}, note="Prescribed in the OP EMR despite drug-safety alerts")
    return rx, alerts


@router.post("/emr/{eid}/close")
async def close_emr(eid: str, ctx: CtxDep):
    """Finish the consultation: diagnosis required; visit Seen, encounter closed, follow-up scheduled."""
    enc = await _enc(ctx, eid)
    _write(ctx, enc)
    appt = await get(ctx, APPT, enc["appointment"]) if enc.get("appointment") else None
    cons = await _consultation(ctx, appt, enc, create_if_missing=False)
    if not cons or not (cons.get("diagnosis") or "").strip():
        raise bad_request("Record the diagnosis before closing the encounter", {"fields": {"diagnosis": "Required"}})
    if cons.get("status") == "Open":
        cons = await transition(ctx, CONSULT, cons["id"], "Completed")
    if appt:
        if appt.get("status") == "Checked-in":
            appt = await transition(ctx, APPT, appt["id"], "In Consultation")
        if appt.get("status") == "In Consultation":
            appt = await transition(ctx, APPT, appt["id"], "Completed", note=f"OP encounter {enc.get('code')} closed")
    enc = await get(ctx, ENC, eid)
    if enc.get("status") == "Open":
        enc = await update(ctx, ENC, eid, {"status": "Closed", "ended_at": now().isoformat(timespec="seconds")})
    follow_up = None
    if cons.get("follow_up_date"):
        existing = await find(ctx, "opd.follow_ups", consultation=cons["id"], limit=1)
        follow_up = existing[0] if existing else await create(ctx, "opd.follow_ups", {
            "patient_id": cons["patient_id"], "consultation": cons["id"], "doctor": cons.get("doctor"), "due_date": cons["follow_up_date"],
            "reason": "Review with reports" if cons.get("review_with_reports") else "Routine review", "status": "Due",
            "notes": f"Requested time {cons['follow_up_at'][11:16]}" if cons.get("follow_up_at") else None,
        })
    return {"encounter": {k: enc.get(k) for k in ("id", "code", "status", "ended_at")}, "consultation_status": cons.get("status"),
            "follow_up": {k: follow_up.get(k) for k in ("id", "code", "due_date")} if follow_up else None}


class CancelIn(BaseModel):
    reason: Literal["Entered in error", "Patient left without consultation", "Wrong patient", "Duplicate visit", "Other"]
    note: str | None = Field(default=None, max_length=300)


@router.post("/emr/{eid}/cancel")
async def cancel_emr(eid: str, body: CancelIn, ctx: CtxDep):
    """Cancel an OP encounter opened in error. Blocked once investigations are under way or medicines dispensed."""
    enc = await _enc(ctx, eid)
    _write(ctx, enc)
    started = (await ctx.conn.execute(sa.select(sa.func.count()).where(orders.c.encounter_id == eid, orders.c.deleted_at.is_(None),
                                                                       orders.c.status.notin_(["Ordered", "Cancelled"])))).scalar_one()
    if started:
        raise conflict("Investigations for this encounter are already in progress — it cannot be cancelled")
    appt = await get(ctx, APPT, enc["appointment"]) if enc.get("appointment") else None
    cons = await _consultation(ctx, appt, enc, create_if_missing=False)
    from .clinical import _rx_editable

    if cons:
        for rx in [r for r in await find(ctx, RX, consultation=cons["id"], limit=5) if r.get("status") == "Active"]:
            await _rx_editable(ctx, rx)
            await transition(ctx, RX, rx["id"], "Cancelled", values={"cancel_reason": "Other"}, note=f"OP encounter cancelled: {body.reason}")
        if cons.get("status") == "Open":
            await transition(ctx, CONSULT, cons["id"], "Cancelled", values={"cancel_reason": body.reason}, note=body.note)
    oids = [str(i) for i in (await ctx.conn.execute(sa.select(orders.c.id).where(orders.c.encounter_id == eid, orders.c.status == "Ordered",
                                                                                orders.c.deleted_at.is_(None)))).scalars().all()]
    for oid in oids:
        await update(ctx, "orders.orders", oid, {"status": "Cancelled", "cancel_reason": f"OP encounter cancelled: {body.reason}"})
    refund_due = False
    if appt and appt.get("status") not in INACTIVE:
        rows = (await ctx.conn.execute(sa.select(charges.c.id, charges.c.status).where(
            charges.c.source_id == appt["id"], charges.c.deleted_at.is_(None), charges.c.status != "Cancelled"))).all()
        for r in rows:
            if r.status == "Unbilled":
                await update(ctx, "billing.charges", str(r.id), {"status": "Cancelled", "cancel_reason": f"OP encounter cancelled: {body.reason}"})
            else:
                refund_due = True
        note = f"OP encounter cancelled — {body.reason}{': ' + body.note if body.note else ''}"
        await update(ctx, APPT, appt["id"], {"status": "Cancelled", "cancel_reason": "Other", "refund_due": refund_due or None,
                                             "notes": f"{appt['notes']}\n{note}" if appt.get("notes") else note})
        if appt.get("queue_token"):
            tok = await get(ctx, "queue.tokens", appt["queue_token"])
            if tok and tok.get("status") in ("Waiting", "Called", "Serving"):
                await update(ctx, "queue.tokens", tok["id"], {"status": "Skipped", "skipped_at": now().isoformat(timespec="seconds")})
    enc = await update(ctx, ENC, eid, {"status": "Cancelled", "ended_at": now().isoformat(timespec="seconds"), "cancel_reason": body.reason})
    await audit(ctx, "emr.op.cancel", module="opd", entity="consultations", record=enc, note=f"{body.reason}{': ' + body.note if body.note else ''}")
    return {"encounter": {k: enc.get(k) for k in ("id", "code", "status")}, "refund_due": refund_due, "orders_cancelled": len(oids)}


# ------------------------------------------------------------------ prescribing helpers

@router.get("/drugs")
async def drugs(ctx: CtxDep, q: str = "", limit: int = 20):
    """Drug search for prescribing: name / generic / strength / form, schedule, high-alert, OP stock."""
    _view(ctx)
    term = q.strip()
    if len(term) < 2:
        return []
    ent = E("mdm.items")
    t = ent.table
    like = f"%{term.lower()}%"
    rows = (await ctx.conn.execute(sa.select(t).where(*rs.base_where(ent), t.c.data["type"].astext == "Drug",
                                                      sa.func.coalesce(t.c.status, "Active") == "Active",
                                                      sa.or_(t.c.search.ilike(like), t.c.data["generic_name"].astext.ilike(like)))
                                   .order_by(t.c.title).limit(max(1, min(limit, 40))))).all()
    out = [rs.to_record(r) for r in rows]
    ids = [r["id"] for r in out]
    stock: dict[str, float] = {}
    if ids:
        from ..schema import stock as stock_t

        for item_id, qty in (await ctx.conn.execute(sa.select(stock_t.c.item_id, sa.func.coalesce(sa.func.sum(stock_t.c.qty), 0)).where(
                stock_t.c.item_id.in_(ids), stock_t.c.deleted_at.is_(None), stock_t.c.qty > 0,
                sa.or_(stock_t.c.expiry.is_(None), stock_t.c.expiry > today())).group_by(stock_t.c.item_id))).all():
            stock[str(item_id)] = float(qty)
    return [{"id": r["id"], "code": r.get("code"), "name": r.get("name"), "generic_name": r.get("generic_name"), "strength": r.get("strength"),
             "form": r.get("form"), "uom": r.get("uom"), "mrp": r.get("mrp"), "schedule": r.get("schedule"), "high_alert": bool(r.get("high_alert")),
             "drug_class": r.get("drug_class"), "in_stock": stock.get(r["id"], 0)} for r in out]


@router.get("/patients/{pid}/prescriptions")
async def previous_prescriptions(pid: str, ctx: CtxDep, limit: int = 10):
    """Earlier prescriptions (Add from previous / History)."""
    _view(ctx)
    rows = await find(ctx, RX, patient_id=pid, sort="-prescribed_at", limit=max(1, min(limit, 30)))
    refs: dict[str, str] = {}
    for r in rows:
        refs.update(r.get("_refs") or {})
    out = []
    for r in rows:
        view = await _rx_view(ctx, r)
        view["doctor"] = refs.get(r.get("doctor") or "")
        out.append(view)
    return out


@router.get("/patients/{pid}/field-history")
async def field_history(pid: str, ctx: CtxDep, key: str, limit: int = 8):
    """Previous values of one clinical-note field for this patient (the clock icon beside each field)."""
    _view(ctx)
    if key not in NOTE_KEYS and key not in CONSULT_COLUMNS:
        raise bad_request("Unknown field")
    out = []
    for c in await find(ctx, CONSULT, patient_id=pid, sort="-consulted_at", limit=40):
        val = (c.get("note") or {}).get(key) or c.get(key)
        if val and str(val).strip():
            out.append({"value": val, "date": c.get("consulted_at"), "code": c.get("code"), "doctor": (c.get("_refs") or {}).get(c.get("doctor") or "")})
        if len(out) >= max(1, min(limit, 20)):
            break
    return out


@router.get("/note-formats")
async def note_formats(ctx: CtxDep):
    _view(ctx)
    return {"formats": NOTE_FORMATS, "note_keys": list(NOTE_KEYS)}


@router.get("/icd10")
async def icd10(ctx: CtxDep, q: str = "", limit: int = 15):
    """ICD-10 look-up: the terminology master when loaded, plus the embedded common-OPD list."""
    _view(ctx)
    term = q.strip().lower()
    if len(term) < 2:
        return []
    lim = max(1, min(limit, 40))
    out: list[dict] = []
    seen: set[str] = set()
    if has("terminology.codes"):
        try:
            for r in await find(ctx, "terminology.codes", q=term, limit=lim):
                code = r.get("code_value") or r.get("icd_code") or r.get("code")
                if code and code not in seen:
                    seen.add(code)
                    out.append({"code": code, "name": r.get("title") or r.get("name") or r.get("description")})
        except Exception:  # noqa: BLE001 - terminology shape varies; the embedded list still answers
            log.debug("terminology lookup failed", exc_info=True)
    for code, name in ICD10:
        if len(out) >= lim:
            break
        if code in seen:
            continue
        if code.lower().startswith(term) or term in name.lower():
            seen.add(code)
            out.append({"code": code, "name": name})
    return out


ICD10: list[tuple[str, str]] = [
    ("A01.0", "Typhoid fever"), ("A09", "Infectious gastroenteritis and colitis, unspecified"), ("A15.0", "Tuberculosis of lung"),
    ("A90", "Dengue fever"), ("A91", "Dengue haemorrhagic fever"), ("A92.0", "Chikungunya virus disease"), ("B01.9", "Varicella without complication"),
    ("B05.9", "Measles without complication"), ("B19.9", "Unspecified viral hepatitis"), ("B34.9", "Viral infection, unspecified"),
    ("B35.4", "Tinea corporis"), ("B35.6", "Tinea cruris"), ("B37.0", "Candidal stomatitis"), ("B50.9", "Plasmodium falciparum malaria, unspecified"),
    ("B54", "Unspecified malaria"), ("B86", "Scabies"), ("C50.9", "Malignant neoplasm of breast, unspecified"),
    ("D50.9", "Iron deficiency anaemia, unspecified"), ("D64.9", "Anaemia, unspecified"), ("E03.9", "Hypothyroidism, unspecified"),
    ("E05.9", "Thyrotoxicosis, unspecified"), ("E10.9", "Type 1 diabetes mellitus without complications"),
    ("E11.9", "Type 2 diabetes mellitus without complications"), ("E11.65", "Type 2 diabetes mellitus with hyperglycaemia"),
    ("E11.22", "Type 2 diabetes mellitus with diabetic chronic kidney disease"), ("E11.40", "Type 2 diabetes mellitus with diabetic neuropathy"),
    ("E55.9", "Vitamin D deficiency, unspecified"), ("E66.9", "Obesity, unspecified"), ("E78.5", "Hyperlipidaemia, unspecified"),
    ("E86.0", "Dehydration"), ("E87.1", "Hypo-osmolality and hyponatraemia"), ("F10.2", "Alcohol dependence syndrome"),
    ("F20.9", "Schizophrenia, unspecified"), ("F31.9", "Bipolar affective disorder, unspecified"), ("F32.9", "Depressive episode, unspecified"),
    ("F41.1", "Generalised anxiety disorder"), ("F41.9", "Anxiety disorder, unspecified"), ("F51.0", "Nonorganic insomnia"),
    ("F90.0", "Disturbance of activity and attention (ADHD)"), ("G40.9", "Epilepsy, unspecified"), ("G43.9", "Migraine, unspecified"),
    ("G44.2", "Tension-type headache"), ("G47.3", "Sleep apnoea"), ("G51.0", "Bell's palsy"), ("G56.0", "Carpal tunnel syndrome"),
    ("G62.9", "Polyneuropathy, unspecified"), ("H10.9", "Conjunctivitis, unspecified"), ("H25.9", "Senile cataract, unspecified"),
    ("H40.9", "Glaucoma, unspecified"), ("H52.1", "Myopia"), ("H52.4", "Presbyopia"), ("H60.9", "Otitis externa, unspecified"),
    ("H61.2", "Impacted cerumen"), ("H66.9", "Otitis media, unspecified"), ("H81.1", "Benign paroxysmal vertigo"),
    ("H91.9", "Hearing loss, unspecified"), ("I10", "Essential (primary) hypertension"), ("I11.9", "Hypertensive heart disease without heart failure"),
    ("I20.9", "Angina pectoris, unspecified"), ("I21.9", "Acute myocardial infarction, unspecified"), ("I25.1", "Atherosclerotic heart disease"),
    ("I48.9", "Atrial fibrillation, unspecified"), ("I50.9", "Heart failure, unspecified"), ("I63.9", "Cerebral infarction, unspecified"),
    ("I83.9", "Varicose veins of lower extremities"), ("I84.9", "Haemorrhoids, unspecified"), ("J00", "Acute nasopharyngitis (common cold)"),
    ("J01.9", "Acute sinusitis, unspecified"), ("J02.9", "Acute pharyngitis, unspecified"), ("J03.9", "Acute tonsillitis, unspecified"),
    ("J06.9", "Acute upper respiratory infection, unspecified"), ("J11.1", "Influenza with other respiratory manifestations"),
    ("J18.9", "Pneumonia, unspecified"), ("J20.9", "Acute bronchitis, unspecified"), ("J30.4", "Allergic rhinitis, unspecified"),
    ("J32.9", "Chronic sinusitis, unspecified"), ("J34.2", "Deviated nasal septum"), ("J44.1", "COPD with acute exacerbation"),
    ("J44.9", "Chronic obstructive pulmonary disease, unspecified"), ("J45.9", "Asthma, unspecified"), ("K02.9", "Dental caries, unspecified"),
    ("K04.7", "Periapical abscess without sinus"), ("K05.1", "Chronic gingivitis"), ("K21.9", "Gastro-oesophageal reflux disease without oesophagitis"),
    ("K25.9", "Gastric ulcer, unspecified"), ("K29.7", "Gastritis, unspecified"), ("K30", "Functional dyspepsia"), ("K35.8", "Acute appendicitis, other"),
    ("K40.9", "Unilateral inguinal hernia"), ("K42.9", "Umbilical hernia"), ("K52.9", "Noninfective gastroenteritis and colitis, unspecified"),
    ("K58.9", "Irritable bowel syndrome without diarrhoea"), ("K59.0", "Constipation"), ("K60.2", "Anal fissure, unspecified"),
    ("K70.3", "Alcoholic cirrhosis of liver"), ("K76.0", "Fatty (change of) liver, not elsewhere classified"), ("K80.2", "Calculus of gallbladder without cholecystitis"),
    ("L02.9", "Cutaneous abscess, unspecified"), ("L03.9", "Cellulitis, unspecified"), ("L20.9", "Atopic dermatitis, unspecified"),
    ("L23.9", "Allergic contact dermatitis"), ("L30.9", "Dermatitis, unspecified"), ("L40.0", "Psoriasis vulgaris"), ("L50.9", "Urticaria, unspecified"),
    ("L60.0", "Ingrowing nail"), ("L63.9", "Alopecia areata, unspecified"), ("L70.0", "Acne vulgaris"), ("L80", "Vitiligo"),
    ("M06.9", "Rheumatoid arthritis, unspecified"), ("M10.9", "Gout, unspecified"), ("M17.9", "Osteoarthritis of knee, unspecified"),
    ("M19.9", "Osteoarthritis, unspecified"), ("M25.5", "Pain in joint"), ("M47.8", "Other spondylosis"), ("M50.1", "Cervical disc disorder with radiculopathy"),
    ("M51.1", "Lumbar disc disorder with radiculopathy"), ("M54.2", "Cervicalgia"), ("M54.4", "Lumbago with sciatica"), ("M54.5", "Low back pain"),
    ("M62.8", "Muscle strain / other disorders of muscle"), ("M65.3", "Trigger finger"), ("M75.0", "Adhesive capsulitis of shoulder"),
    ("M77.1", "Lateral epicondylitis"), ("M79.1", "Myalgia"), ("M79.7", "Fibromyalgia"), ("M81.0", "Postmenopausal osteoporosis"),
    ("N18.9", "Chronic kidney disease, unspecified"), ("N18.5", "Chronic kidney disease, stage 5"), ("N20.0", "Calculus of kidney"),
    ("N20.1", "Calculus of ureter"), ("N30.0", "Acute cystitis"), ("N39.0", "Urinary tract infection, site not specified"),
    ("N40", "Benign prostatic hyperplasia"), ("N76.0", "Acute vaginitis"), ("N83.2", "Other and unspecified ovarian cysts"),
    ("N92.0", "Excessive and frequent menstruation with regular cycle"), ("N94.6", "Dysmenorrhoea, unspecified"), ("N95.1", "Menopausal and female climacteric states"),
    ("N97.9", "Female infertility, unspecified"), ("E28.2", "Polycystic ovarian syndrome"), ("O21.0", "Mild hyperemesis gravidarum"),
    ("O24.4", "Gestational diabetes mellitus"), ("O13", "Gestational hypertension"), ("O80", "Single spontaneous delivery"),
    ("Z34.9", "Supervision of normal pregnancy, unspecified"), ("Z35.9", "Supervision of high-risk pregnancy, unspecified"),
    ("P59.9", "Neonatal jaundice, unspecified"), ("R05", "Cough"), ("R06.0", "Dyspnoea"), ("R07.4", "Chest pain, unspecified"),
    ("R10.4", "Other and unspecified abdominal pain"), ("R11", "Nausea and vomiting"), ("R19.7", "Diarrhoea, unspecified"),
    ("R42", "Dizziness and giddiness"), ("R50.9", "Fever, unspecified"), ("R51", "Headache"), ("R53", "Malaise and fatigue"),
    ("R55", "Syncope and collapse"), ("R63.4", "Abnormal weight loss"), ("R73.0", "Abnormal glucose tolerance (prediabetes)"),
    ("S00.9", "Superficial injury of head, unspecified"), ("S01.9", "Open wound of head, unspecified"), ("S52.5", "Fracture of lower end of radius"),
    ("S62.6", "Fracture of other finger"), ("S82.6", "Fracture of lateral malleolus"), ("S83.6", "Sprain of knee"), ("S93.4", "Sprain of ankle"),
    ("T14.9", "Injury, unspecified"), ("T63.0", "Toxic effect of snake venom"), ("T78.4", "Allergy, unspecified"),
    ("W54", "Bitten or struck by dog"), ("Z00.0", "General medical examination"), ("Z01.0", "Examination of eyes and vision"),
    ("Z09", "Follow-up examination after treatment"), ("Z23", "Need for immunisation"), ("Z30.0", "General counselling on contraception"),
    ("Z71.3", "Dietary counselling and surveillance"), ("Z76.0", "Issue of repeat prescription"), ("U07.1", "COVID-19, virus identified"),
]


__all__ = ["router", "day_visits", "ensure_encounter", "NOTE_FORMATS", "ICD10"]
