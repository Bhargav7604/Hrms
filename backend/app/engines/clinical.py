"""Clinical workspaces and computed clinical values.

* Computed on save: BMI and NEWS2 (RCP 2017) on vitals with deterioration escalation, ER
  door-to-doctor / time-in-ER / boarding, Code Blue response time, ICU P/F ratio and MAP, I/O balance.
* EMR patient chart, the doctor workbench (OPD queue → consultation → e-prescription → follow-up)
  and the nursing station (ward census, MAR with barcode-verified administration, MAR scheduling)."""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import hook
from ..core.security import CtxDep
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    day_bounds,
    forbidden,
    is_uuid,
    not_found,
    now,
    parse_date,
    parse_dt,
    to_json_value,
    today,
)
from ..schema import appointments, beds, employees, encounters, orders, patients, records
from ._common import E, create, find, get, has, live, require_role, transition, update
from .inventory import item_label, items_by_id
from .pharmacy import active_medications, patient_allergies, patient_or_404, safety_check

router = APIRouter(prefix="/api/clinical", tags=["clinical"])

TS = sa.DateTime(timezone=True)
VITALS = "emr.vitals"
NOTES = "emr.notes"
MAR = "nursing.mar"
TASKS = "nursing.tasks"
APPT = "appointments.appointments"
CONSULT = "opd.consultations"
RX = "opd.prescriptions"
ACTIVE_ADMISSION = ["Admitted", "Discharge Initiated"]
ACTIVE_ENCOUNTER = ["Admitted", "Discharge Initiated", "Waiting", "In Treatment", "Observation", "Open"]
VITALS_DUE_HOURS = 6
MAR_WINDOW_MIN = 60  # a dose is "on time" within ±60 min of the scheduled time
FREQ_TIMES: dict[str, list[str]] = {
    "OD": ["09:00"], "BD": ["09:00", "21:00"], "TDS": ["08:00", "14:00", "20:00"], "QID": ["06:00", "12:00", "18:00", "24:00"],
    "HS": ["22:00"], "Q4H": ["02:00", "06:00", "10:00", "14:00", "18:00", "22:00"], "Q6H": ["06:00", "12:00", "18:00", "24:00"],
    "Q8H": ["06:00", "14:00", "22:00"], "Weekly": ["09:00"],
}


def _f(v: Any) -> float | None:
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def _mins(a: Any, b: Any, digits: int = 0) -> float | None:
    da, db = parse_dt(a) if a else None, parse_dt(b) if b else None
    if not da or not db:
        return None
    v = round((db - da).total_seconds() / 60, digits)
    return int(v) if digits == 0 else v


def _iso(v: Any) -> str | None:
    return to_json_value(v) if v is not None else None


def _merge_refs(*groups: list[dict]) -> dict:
    refs: dict = {}
    for rows in groups:
        for r in rows:
            refs.update(r.pop("_refs", None) or {})
    return refs


async def _rows(ctx, fqn: str, *conds, order=None, limit: int = 500) -> list[dict]:
    ent = E(fqn)
    stmt = sa.select(ent.table).where(*rs.base_where(ent), *conds)
    if order is not None:
        stmt = stmt.order_by(*(order if isinstance(order, (list, tuple)) else [order]))
    return [rs.to_record(r) for r in (await ctx.conn.execute(stmt.limit(limit))).all()]


def _dcol(fqn: str, key: str):
    return sa.cast(E(fqn).table.c.data[key].astext, TS)


def _emp(ctx) -> str | None:
    return ctx.user.get("employee_id")


# ================================================================== NEWS2 & BMI

def f_to_c(f: float) -> float:
    return round((f - 32) * 5 / 9, 1)


def news2(v: dict) -> dict | None:
    """National Early Warning Score 2 (Royal College of Physicians, 2017), SpO2 scale 1.
    Needs respiration, SpO2, systolic BP and pulse; temperature and consciousness score 0 when absent
    (listed in `missing`). Consciousness: GCS < 15 is treated as new confusion / V / P / U."""
    rr, spo2, sbp, hr = (_f(v.get(k)) for k in ("resp_rate", "spo2", "bp_systolic", "pulse"))
    if None in (rr, spo2, sbp, hr):
        return None
    p: dict[str, int] = {
        "resp_rate": 3 if rr <= 8 else 1 if rr <= 11 else 0 if rr <= 20 else 2 if rr <= 24 else 3,
        "spo2": 3 if spo2 <= 91 else 2 if spo2 <= 93 else 1 if spo2 <= 95 else 0,
        "oxygen": 2 if v.get("o2_support") and v.get("o2_support") != "Room air" else 0,
        "bp_systolic": 3 if sbp <= 90 else 2 if sbp <= 100 else 1 if sbp <= 110 else 0 if sbp <= 219 else 3,
        "pulse": 3 if hr <= 40 else 1 if hr <= 50 else 0 if hr <= 90 else 1 if hr <= 110 else 2 if hr <= 130 else 3,
    }
    missing = []
    gcs = _f(v.get("gcs"))
    p["consciousness"] = 3 if gcs is not None and gcs < 15 else 0
    if gcs is None:
        missing.append("consciousness")
    t = _f(v.get("temperature"))
    temp_c = None
    if t is not None:
        temp_c = f_to_c(t)
        p["temperature"] = 3 if temp_c <= 35.0 else 1 if temp_c <= 36.0 else 0 if temp_c <= 38.0 else 1 if temp_c <= 39.0 else 2
    else:
        missing.append("temperature")
    score = sum(p.values())
    single3 = any(x == 3 for x in p.values())
    risk = "High" if score >= 7 else "Medium" if score >= 5 else "Low-medium" if single3 else "Low"
    return {"score": score, "parts": p, "risk": risk, "single3": single3, "missing": missing, "temperature_c": temp_c}


async def _last_height(ctx, pid: str) -> float | None:
    ent = E(VITALS)
    t = ent.table
    row = (await ctx.conn.execute(sa.select(t.c.data["height"].astext).where(
        *rs.base_where(ent), t.c.patient_id == pid, t.c.data["height"].astext.isnot(None),
        sa.func.coalesce(t.c.status, "") != "Entered in Error", t.c.created_at >= now() - timedelta(days=365),
    ).order_by(t.c.created_at.desc()).limit(1))).first()
    return _f(row[0]) if row else None


@hook(VITALS, "before_create")
@hook(VITALS, "before_update")
async def _vitals_compute(ctx, nxt, prev=None):
    w, h = _f(nxt.get("weight")), _f(nxt.get("height"))
    if w and not h and nxt.get("patient_id"):
        h = await _last_height(ctx, nxt["patient_id"])
    nxt["bmi"] = round(w / (h / 100) ** 2, 1) if w and h and h > 30 else None
    n = news2(nxt)
    nxt["news2"] = n["score"] if n else None
    nxt["news2_risk"] = n["risk"] if n else None
    nxt["news2_parts"] = n["parts"] if n else None
    nxt["news2_missing"] = n["missing"] if n else None
    if _f(nxt.get("temperature")) is not None:
        nxt["temperature_c"] = f_to_c(_f(nxt["temperature"]))


async def patient_location(ctx, pid: str) -> dict:
    """Current encounter (IPD / day care / ER) with bed and ward, if any."""
    e, b = encounters, beds
    w = records.alias("w")
    row = (await ctx.conn.execute(
        sa.select(e.c.id, e.c.code, e.c.type, e.c.status, e.c.doctor_id, e.c.started_at, e.c.bed_id, e.c.data,
                  b.c.bed_no, b.c.ward_id, w.c.title.label("ward"))
        .select_from(e.outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id))
        .where(e.c.patient_id == pid, e.c.deleted_at.is_(None), e.c.status.in_(ACTIVE_ENCOUNTER))
        .order_by(sa.case((e.c.type.in_(["IPD", "DAYCARE"]), 0), else_=1), e.c.started_at.desc().nulls_last()).limit(1))).first()
    if not row:
        return {}
    return {"encounter_id": str(row.id), "encounter_code": row.code, "type": row.type, "status": row.status,
            "doctor_id": str(row.doctor_id) if row.doctor_id else None, "started_at": _iso(row.started_at),
            "bed_id": str(row.bed_id) if row.bed_id else None, "bed_no": row.bed_no,
            "ward_id": str(row.ward_id) if row.ward_id else None, "ward": row.ward,
            "diagnosis": (row.data or {}).get("diagnosis") or (row.data or {}).get("chief_complaint")}


@hook(VITALS, "after_create")
async def _vitals_escalate(ctx, rec):
    score, risk = rec.get("news2"), rec.get("news2_risk")
    if score is None:
        return
    single3 = any(v == 3 for v in (rec.get("news2_parts") or {}).values())
    if score < 5 and not single3:
        return
    pid = rec["patient_id"]
    p = await patient_or_404(ctx, pid)
    loc = await patient_location(ctx, pid)
    priority = "STAT" if score >= 7 or single3 else "Urgent"
    where = " · ".join(x for x in (loc.get("ward"), f"bed {loc['bed_no']}" if loc.get("bed_no") else None) if x)
    response = ("Emergency response: inform the treating doctor and call the rapid response team now; continuous monitoring"
                if score >= 7 else "Urgent bedside review by the treating doctor; observations at least hourly"
                if score >= 5 else "Urgent ward-based review (single parameter scored 3); observations at least hourly")
    pending = [t for t in await find(ctx, TASKS, patient_id=pid, status="Pending", limit=50) if t.get("trigger") == "news2"]
    if not any(t.get("priority") == "STAT" or t.get("priority") == priority for t in pending):
        assigned = _emp(ctx) if ctx.role == "nurse" else None
        await create(ctx, TASKS, {
            "patient_id": pid, "encounter_id": rec.get("encounter_id") or loc.get("encounter_id"),
            "task": f"NEWS2 {score} ({risk}) — {response}", "category": "Vitals", "ward": loc.get("ward_id"),
            "due_at": now().isoformat(timespec="minutes"), "assigned_to": assigned, "priority": priority, "source": "Protocol",
            "trigger": "news2", "vitals_id": rec["id"], "status": "Pending",
        })
    if score >= 7 or single3:
        live(ctx, "alerts", {
            "type": "deterioration", "patient_id": pid, "patient": p.get("title"), "uhid": p.get("code"), "news2": score, "risk": risk,
            "ward_id": loc.get("ward_id"), "ward": loc.get("ward"), "bed": loc.get("bed_no"), "vitals_id": rec["id"],
            "message": f"Deterioration: NEWS2 {score} ({risk}) — {p.get('title')} {p.get('code')}{' · ' + where if where else ''}",
        })


# ================================================================== ER, Code Blue, ICU, I/O

@hook("er.visits", "before_create")
async def _er_arrival(ctx, draft):
    draft["started_at"] = draft.get("started_at") or now().isoformat(timespec="seconds")


@hook("er.visits", "before_transition")
async def _er_times(ctx, nxt, prev):
    st = nxt["status"]
    if st == "In Treatment":
        nxt["doctor_seen_at"] = nxt.get("doctor_seen_at") or now().isoformat(timespec="seconds")
        d2d = _mins(nxt.get("started_at"), nxt["doctor_seen_at"])
        nxt["door_to_doctor_minutes"] = max(0, d2d) if d2d is not None else None
        if not nxt.get("doctor_id") and ctx.role == "doctor":
            nxt["doctor_id"] = _emp(ctx)
    elif st == "Disposed":
        disposed = nxt.get("disposed_at") or now().isoformat(timespec="seconds")
        nxt["er_los_minutes"] = _mins(nxt.get("started_at"), disposed)
        if nxt.get("disposition") in ("Admitted", "Shifted to OT"):
            tr = await _er_transfer(ctx, nxt)
            if tr:
                nxt["boarding_minutes"] = max(0, _mins(tr.get("requested_at"), tr.get("shifted_at") or disposed) or 0)
                nxt["er_transfer"] = tr["id"]


async def _er_transfer(ctx, visit: dict) -> dict | None:
    started = parse_dt(visit.get("started_at"))
    for tr in await find(ctx, "er.transfers", patient_id=visit["patient_id"], sort="-requested_at", limit=10):
        if tr.get("status") == "Cancelled":
            continue
        if tr.get("encounter_id") == visit.get("id") or (started and tr.get("requested_at") and parse_dt(tr["requested_at"]) >= started):
            return tr
    return None


@hook("er.transfers", "before_transition")
async def _er_transfer_shifted(ctx, nxt, prev):
    if nxt["status"] != "Shifted":
        return
    nxt["boarding_minutes"] = max(0, _mins(nxt.get("requested_at") or prev.get("created_at"), nxt.get("shifted_at")) or 0)
    visits = [v for v in await find(ctx, "er.visits", patient_id=nxt["patient_id"], sort="-started_at", limit=3)
              if v.get("id") == nxt.get("encounter_id") or (v.get("started_at") and nxt.get("requested_at")
                                                             and parse_dt(v["started_at"]) <= parse_dt(nxt["requested_at"]))]
    if visits and visits[0].get("status") == "Disposed" and visits[0].get("disposition") in ("Admitted", "Shifted to OT"):
        await update(ctx, "er.visits", visits[0]["id"], {"boarding_minutes": nxt["boarding_minutes"], "er_transfer": prev["id"]})


@hook("codeblue.events", "before_transition")
async def _code_response(ctx, nxt, prev):
    if nxt["status"] == "Team Arrived" or (nxt["status"] == "Concluded" and not nxt.get("response_minutes") and nxt.get("team_arrived_at")):
        nxt["response_minutes"] = _mins(nxt.get("activated_at"), nxt.get("team_arrived_at"), 1)


@hook("codeblue.events", "after_create")
async def _code_activate(ctx, rec):
    live(ctx, "alerts", {"type": "code_blue", "id": rec["id"], "code_type": rec.get("code_type"), "location": rec.get("location"),
                         "ward_id": rec.get("ward"), "patient_id": rec.get("patient_id"),
                         "message": f"{rec.get('code_type')} — {rec.get('location')}"})


@hook("icu.ventilator", "before_create")
@hook("icu.ventilator", "before_update")
async def _pf_ratio(ctx, nxt, prev=None):
    pao2, fio2 = _f(nxt.get("abg_pao2")), _f(nxt.get("fio2"))
    nxt["pf_ratio"] = round(pao2 / (fio2 / 100)) if pao2 and fio2 and fio2 >= 21 else None
    if nxt["pf_ratio"] is not None:
        # Berlin definition (on PEEP ≥ 5): ≤300 mild, ≤200 moderate, ≤100 severe ARDS range
        pf = nxt["pf_ratio"]
        nxt["pf_category"] = "Severe (≤100)" if pf <= 100 else "Moderate (101–200)" if pf <= 200 else "Mild (201–300)" if pf <= 300 else "Normal (>300)"


@hook("icu.flowsheets", "before_create")
@hook("icu.flowsheets", "before_update")
async def _map(ctx, nxt, prev=None):
    sbp, dbp = _f(nxt.get("bp_systolic")), _f(nxt.get("bp_diastolic"))
    if sbp and dbp and (nxt.get("map") in (None, "") or nxt.get("map_computed")):
        nxt["map"] = round((sbp + 2 * dbp) / 3)
        nxt["map_computed"] = True


IN_KEYS = ("intake_oral", "intake_iv", "intake_ryles", "intake_blood")
OUT_KEYS = ("output_urine", "output_drain", "output_ng", "output_vomitus")


@hook("nursing.io_charts", "before_create")
@hook("nursing.io_charts", "before_update")
async def _io_totals(ctx, nxt, prev=None):
    tin = sum(_f(nxt.get(k)) or 0 for k in IN_KEYS)
    tout = sum(_f(nxt.get(k)) or 0 for k in OUT_KEYS)
    nxt.update(total_intake=round(tin), total_output=round(tout), balance=round(tin - tout))


# ================================================================== EMR patient chart

async def _vitals_series(ctx, pid: str, hours: int) -> tuple[list[dict], dict | None]:
    at = _dcol(VITALS, "recorded_at")
    ok = sa.func.coalesce(E(VITALS).table.c.status, "") != "Entered in Error"
    pc = E(VITALS).table.c.patient_id == pid
    series = await _rows(ctx, VITALS, pc, ok, at >= now() - timedelta(hours=hours), order=[at.asc(), E(VITALS).table.c.created_at.asc()], limit=400)
    latest = series[-1] if series else next(iter(await _rows(ctx, VITALS, pc, ok, order=[at.desc().nulls_last(), E(VITALS).table.c.created_at.desc()], limit=1)), None)
    return series, latest


def _io_sum(rows: list[dict]) -> dict:
    tin = sum(_f(r.get("total_intake")) or 0 for r in rows)
    tout = sum(_f(r.get("total_output")) or 0 for r in rows)
    return {"intake": round(tin), "output": round(tout), "balance": round(tin - tout), "entries": len(rows)}


@router.get("/patients/{pid}/chart")
async def chart(pid: str, ctx: CtxDep, hours: int = 72):
    rs.ensure_access(ctx, E(VITALS), "read")
    p = await patient_or_404(ctx, pid)
    hours = max(6, min(hours, 24 * 14))
    await audit(ctx, "emr.chart.view", module="emr", entity="patients", record={"id": pid, "code": p.get("code")})
    loc = await patient_location(ctx, pid)
    series, latest = await _vitals_series(ctx, pid, hours)

    nt = E(NOTES).table
    noted = _dcol(NOTES, "noted_at")
    signed = await _rows(ctx, NOTES, nt.c.patient_id == pid, nt.c.status.in_(["Signed", "Amended"]), order=noted.desc().nulls_last(), limit=60)
    mine = [nt.c.created_by == ctx.user_id] + ([nt.c.data["author"].astext == _emp(ctx)] if _emp(ctx) else [])
    drafts = await _rows(ctx, NOTES, nt.c.patient_id == pid, nt.c.status == "Draft", sa.or_(*mine), order=noted.desc().nulls_last(), limit=20)

    problems = await find(ctx, "emr.problems", patient_id=pid, limit=60, sort="-onset_date")
    history = await find(ctx, "emr.history", patient_id=pid, limit=1, sort="-reviewed_on")
    allergies = await patient_allergies(ctx, pid, p)

    meds = await active_medications(ctx, pid)
    items = await items_by_id(ctx, [m["item_id"] for m in meds])
    med_refs = _merge_refs(meds)
    for m in meds:
        it = items.get(m["item_id"]) or {}
        m.update(name=item_label(it), generic=it.get("generic_name"), high_alert=bool(it.get("high_alert")), schedule=it.get("schedule"))
    mar_today: list[dict] = []
    if loc.get("type") in ("IPD", "DAYCARE"):
        s, e = day_bounds(today())
        sched = _dcol(MAR, "scheduled_at")
        mar_today = await _rows(ctx, MAR, E(MAR).table.c.patient_id == pid, sched >= s, sched < e + timedelta(hours=1), order=sched.asc(), limit=200)
        mar_items = await items_by_id(ctx, [m.get("drug") for m in mar_today])
        for m in mar_today:
            m["drug_name"] = item_label(mar_items.get(m.get("drug")))

    s, e = day_bounds(today())
    rec_at = _dcol("nursing.io_charts", "recorded_at")
    io_rows = await _rows(ctx, "nursing.io_charts", E("nursing.io_charts").table.c.patient_id == pid, rec_at >= s, rec_at < e, limit=200)
    refs = _merge_refs(problems, history)
    refs.update(med_refs)
    refs.update(await rs.resolve_refs(ctx, E(NOTES), signed + drafts))
    refs.update(await rs.resolve_refs(ctx, E(VITALS), series[-50:] + ([latest] if latest else [])))
    if loc.get("doctor_id"):
        refs.update(await rs.resolve_refs(ctx, E("ipd.admissions"), [{"doctor_id": loc["doctor_id"]}]))
    return {
        "patient": {k: p.get(k) for k in ("id", "code", "title", "first_name", "last_name", "gender", "dob", "age", "blood_group", "phone",
                                          "payer_type", "abha_id", "status")},
        "encounter": loc or None, "allergies": allergies,
        "vitals": {"hours": hours, "series": [_vital_point(v) for v in series], "latest": _vital_point(latest) if latest else None},
        "notes": drafts + signed,
        "problems": [x for x in problems if x.get("status") == "Active"], "resolved_problems": [x for x in problems if x.get("status") != "Active"][:15],
        "medications": meds, "mar_today": mar_today, "io_today": _io_sum(io_rows), "history": history[0] if history else None,
        "refs": refs,
    }


def _vital_point(v: dict) -> dict:
    return {k: v.get(k) for k in ("id", "code", "recorded_at", "temperature", "temperature_c", "pulse", "resp_rate", "bp_systolic", "bp_diastolic",
                                  "spo2", "o2_support", "pain_score", "gcs", "blood_sugar", "weight", "height", "bmi", "news2", "news2_risk",
                                  "news2_parts", "news2_missing", "recorded_by", "remarks", "status")}


# ================================================================== doctor workbench

def _doctor(ctx, doctor_id: str | None = None) -> str:
    if ctx.role in ("admin", "management") and doctor_id:
        if not is_uuid(doctor_id):
            raise bad_request("Invalid doctor")
        return doctor_id
    require_role(ctx, "doctor")
    me = _emp(ctx)
    if not me:
        if ctx.role == "admin":
            raise bad_request("Choose the doctor whose workbench to open (doctor_id)")
        raise bad_request("Your login is not linked to a doctor profile — ask the administrator to link your employee record")
    return me


def _own(ctx, doctor_id: str | None, what: str) -> None:
    if ctx.role != "admin" and doctor_id and doctor_id != _emp(ctx):
        raise forbidden(f"This {what} belongs to another doctor")


async def _latest_news2(ctx, pids: list[str]) -> dict[str, dict]:
    if not pids:
        return {}
    ent = E(VITALS)
    t = ent.table
    at = _dcol(VITALS, "recorded_at")
    rows = (await ctx.conn.execute(
        sa.select(t.c.patient_id, t.c.data["news2"].astext, t.c.data["news2_risk"].astext, t.c.data["recorded_at"].astext)
        .where(*rs.base_where(ent), t.c.patient_id.in_(pids), sa.func.coalesce(t.c.status, "") != "Entered in Error")
        .distinct(t.c.patient_id).order_by(t.c.patient_id, at.desc().nulls_last(), t.c.created_at.desc()))).all()
    return {str(r[0]): {"news2": _f(r[1]), "risk": r[2], "at": r[3]} for r in rows}


async def _admissions(ctx, *, doctor_id: str | None = None, ward_id: str | None = None) -> list[dict]:
    e, b, p = encounters, beds, patients
    w = records.alias("w")
    stmt = (sa.select(e.c.id, e.c.code, e.c.patient_id, e.c.doctor_id, e.c.bed_id, e.c.started_at, e.c.status, e.c.type,
                      e.c.data["diagnosis"].astext.label("diagnosis"), b.c.bed_no, b.c.ward_id, w.c.title.label("ward"),
                      p.c.title.label("patient"), p.c.code.label("uhid"), p.c.dob, p.c.gender, p.c.data["allergies"].label("allergies"))
            .select_from(e.join(p, p.c.id == e.c.patient_id).outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id))
            .where(e.c.deleted_at.is_(None), e.c.type.in_(["IPD", "DAYCARE"]), e.c.status.in_(ACTIVE_ADMISSION)))
    if doctor_id:
        stmt = stmt.where(e.c.doctor_id == doctor_id)
    if ward_id:
        stmt = stmt.where(b.c.ward_id == ward_id)
    rows = (await ctx.conn.execute(stmt.order_by(b.c.bed_no.asc().nulls_last(), e.c.started_at))).all()
    ts = now()
    out = []
    for r in rows:
        started = r.started_at
        out.append({"encounter_id": str(r.id), "admission_code": r.code, "patient_id": str(r.patient_id), "patient": r.patient, "uhid": r.uhid,
                    "age": age_from(r.dob), "gender": r.gender, "allergies": r.allergies or [], "doctor_id": str(r.doctor_id) if r.doctor_id else None,
                    "bed_id": str(r.bed_id) if r.bed_id else None, "bed_no": r.bed_no, "ward_id": str(r.ward_id) if r.ward_id else None,
                    "ward": r.ward, "diagnosis": r.diagnosis, "status": r.status, "type": r.type, "admitted_at": _iso(started),
                    "los_days": (ts - started).days if started else None})
    return out


async def _names(ctx, ids) -> dict[str, str]:
    ids = [i for i in {str(x) for x in ids if x} if is_uuid(i)]
    if not ids:
        return {}
    return {str(i): n for i, n in (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name).where(employees.c.id.in_(ids)))).all()}


@router.get("/workbench")
async def workbench(ctx: CtxDep, doctor_id: str | None = None):
    me = _doctor(ctx, doctor_id)
    ts = now()
    a, p = appointments, patients
    rows = (await ctx.conn.execute(
        sa.select(a, p.c.title.label("patient"), p.c.code.label("uhid"), p.c.dob, p.c.gender, p.c.phone, p.c.data["allergies"].label("allergies"))
        .select_from(a.join(p, p.c.id == a.c.patient_id))
        .where(a.c.deleted_at.is_(None), a.c.doctor_id == me, a.c.appt_date == today())
        .order_by(a.c.token_no.asc().nulls_last(), a.c.slot))).all()
    appt_ids = [str(r.id) for r in rows]
    cons_by_appt: dict[str, dict] = {}
    if appt_ids:
        ct = E(CONSULT).table
        for c in await _rows(ctx, CONSULT, ct.c.data["appointment"].astext.in_(appt_ids), limit=500):
            cons_by_appt[c["appointment"]] = {"id": c["id"], "code": c.get("code"), "status": c.get("status"), "diagnosis": c.get("diagnosis")}
    queue, by_status, waits = [], {}, []
    for r in rows:
        d = r.data or {}
        slot_at = datetime.combine(r.appt_date, time.fromisoformat(r.slot), tzinfo=settings.tz) if r.slot else None
        checked = parse_dt(d.get("checked_in_at")) or (slot_at if r.status in ("Checked-in", "In Consultation", "Completed") else None)
        started = parse_dt(d.get("consult_started_at"))
        wait = None
        if r.status == "Checked-in" and checked:
            wait = max(0, _mins(checked, ts))
            waits.append(wait)
        elif r.status in ("In Consultation", "Completed") and checked and started:
            wait = max(0, _mins(checked, started))
        by_status[r.status] = by_status.get(r.status, 0) + 1
        queue.append({
            "id": str(r.id), "code": r.code, "token_no": r.token_no, "slot": r.slot, "type": r.type, "status": r.status,
            "patient_id": str(r.patient_id), "patient": r.patient, "uhid": r.uhid, "age": age_from(r.dob), "gender": r.gender, "phone": r.phone,
            "allergies": r.allergies or [], "reason": d.get("reason"), "encounter_id": str(r.encounter_id) if r.encounter_id else None,
            "checked_in_at": _iso(checked), "consult_started_at": d.get("consult_started_at"), "completed_at": d.get("completed_at"),
            "wait_minutes": wait, "in_consult_minutes": max(0, _mins(started, ts)) if r.status == "In Consultation" and started else None,
            "consultation": cons_by_appt.get(str(r.id)),
        })

    inpatients = await _admissions(ctx, doctor_id=me)
    pids = [x["patient_id"] for x in inpatients]
    n2 = await _latest_news2(ctx, pids)
    results: dict[str, dict] = {}
    if pids:
        o = orders
        done_at = sa.func.coalesce(o.c.verified_at, o.c.resulted_at)
        for pid_, n_new, n_crit in (await ctx.conn.execute(
            sa.select(o.c.patient_id, sa.func.count().filter(done_at >= ts - timedelta(hours=24)),
                      sa.func.count().filter(o.c.critical.is_(True), o.c.acknowledged_at.is_(None)))
            .where(o.c.patient_id.in_(pids), o.c.deleted_at.is_(None), o.c.status.in_(["Resulted", "Verified"])).group_by(o.c.patient_id))).all():
            results[str(pid_)] = {"new_results": n_new, "critical_unack": n_crit}
    for x in inpatients:
        x.update(n2.get(x["patient_id"], {}), **results.get(x["patient_id"], {"new_results": 0, "critical_unack": 0}))

    emp = (await ctx.conn.execute(sa.select(employees.c.department_id, employees.c.name).where(employees.c.id == me))).first()
    consults: list[dict] = []
    ce = E("caremgmt.consults") if has("caremgmt.consults") else None
    if ce is not None:
        t = ce.table
        mine = [t.c.data["to_doctor"].astext == me]
        if emp and emp.department_id:
            mine.append(sa.and_(sa.func.coalesce(t.c.data["to_doctor"].astext, "") == "", t.c.data["to_department"].astext == str(emp.department_id)))
        consults = await _rows(ctx, "caremgmt.consults", t.c.status.in_(["Requested", "Acknowledged"]), sa.or_(*mine),
                               order=t.c.created_at.asc(), limit=50)
    nt = E(NOTES).table
    unsigned = await _rows(ctx, NOTES, nt.c.status == "Draft", sa.or_(nt.c.data["author"].astext == me, nt.c.created_by == ctx.user_id),
                           order=nt.c.created_at.desc(), limit=50)
    fu = E("opd.follow_ups").table
    follow_ups_due = await _rows(ctx, "opd.follow_ups", fu.c.status == "Due", fu.c.data["doctor"].astext == me,
                                 fu.c.data["due_date"].astext <= today().isoformat(), limit=100)
    refs = await rs.resolve_refs(ctx, E("caremgmt.consults"), consults) if consults else {}
    refs.update(await rs.resolve_refs(ctx, E(NOTES), unsigned))
    seen = by_status.get("Completed", 0)
    return {
        "doctor": {"id": me, "name": emp.name if emp else None, "department_id": str(emp.department_id) if emp and emp.department_id else None},
        "date": today().isoformat(), "queue": queue, "by_status": by_status,
        "kpis": {"appointments": len(queue), "seen": seen, "waiting": by_status.get("Checked-in", 0),
                 "in_consultation": by_status.get("In Consultation", 0), "booked": by_status.get("Booked", 0),
                 "avg_wait_minutes": round(sum(waits) / len(waits)) if waits else None, "inpatients": len(inpatients),
                 "consults_pending": len(consults), "unsigned_notes": len(unsigned), "follow_ups_due": len(follow_ups_due)},
        "inpatients": inpatients, "consults": consults, "unsigned_notes": unsigned, "refs": refs,
    }


class StartIn(BaseModel):
    appointment_id: str


async def _consult_for(ctx, appt_id: str) -> dict | None:
    rows = await find(ctx, CONSULT, appointment=appt_id, limit=1, sort="-consulted_at")
    return rows[0] if rows else None


VISIT_TYPES = {"New": "New", "Follow-up": "Follow-up", "Review with reports": "Review with reports", "Teleconsult": "Teleconsult"}


@router.post("/workbench/start")
async def start_consultation(body: StartIn, ctx: CtxDep):
    _doctor(ctx)
    appt = await get(ctx, APPT, body.appointment_id)
    if not appt:
        raise not_found("Appointment not found")
    _own(ctx, appt.get("doctor_id"), "appointment")
    if appt.get("status") == "Booked":
        raise conflict("The patient has not checked in at the front desk yet")
    if appt.get("status") == "Checked-in":
        appt = await transition(ctx, APPT, appt["id"], "In Consultation", note="Started from the doctor workbench")
    elif appt.get("status") != "In Consultation":
        raise conflict(f"Appointment is {appt.get('status')} — it cannot be started")
    cons = await _consult_for(ctx, appt["id"])
    if not cons:
        cons = await create(ctx, CONSULT, {
            "patient_id": appt["patient_id"], "encounter_id": appt.get("encounter_id"), "appointment": appt["id"],
            "doctor": appt.get("doctor_id") or _emp(ctx), "department": appt.get("department_id"),
            "visit_type": VISIT_TYPES.get(appt.get("type") or "", "New"), "consulted_at": now().isoformat(timespec="minutes"),
            "chief_complaint": appt.get("reason"), "status": "Open",
        })
    return {"appointment": appt, "consultation": cons}


CONSULT_KEYS = {"chief_complaint", "hpi", "examination", "diagnosis", "icd_code", "plan", "advice", "follow_up_date",
                "review_with_reports", "referred_to", "template", "visit_type", "department"}


class RxIn(BaseModel):
    id: str | None = None
    items: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    notes: str | None = None
    valid_till: str | None = None
    diagnosis: str | None = None


class SaveIn(BaseModel):
    patient_id: str
    consultation_id: str | None = None
    appointment_id: str | None = None
    encounter_id: str | None = None
    consultation: dict[str, Any] | None = None
    prescription: RxIn | None = None


async def _rx_editable(ctx, rx: dict) -> None:
    if rx.get("status") != "Active":
        raise conflict(f"Prescription {rx.get('code')} is {rx.get('status')} — cancel it and write a new one to change medicines")
    from .pharmacy import dispensed_by_rx

    if (await dispensed_by_rx(ctx, [rx["id"]])).get(rx["id"]):
        raise conflict(f"Pharmacy has started dispensing {rx.get('code')} — cancel it and write a new one")


@router.post("/workbench/save")
async def save_consultation(body: SaveIn, ctx: CtxDep):
    _doctor(ctx)
    await patient_or_404(ctx, body.patient_id)
    cons = None
    if body.consultation_id:
        cons = await get(ctx, CONSULT, body.consultation_id)
        if not cons or cons.get("patient_id") != body.patient_id:
            raise not_found("Consultation not found for this patient")
        _own(ctx, cons.get("doctor"), "consultation")
    elif body.appointment_id:
        cons = await _consult_for(ctx, body.appointment_id)
    fields = {k: v for k, v in (body.consultation or {}).items() if k in CONSULT_KEYS}
    if cons:
        if cons.get("status") != "Open" and fields:
            raise conflict("This consultation is completed — add a clinical note instead of editing it")
        if fields:
            cons = await update(ctx, CONSULT, cons["id"], fields)
    elif body.consultation is not None:
        appt = await get(ctx, APPT, body.appointment_id) if body.appointment_id else None
        if appt and appt.get("patient_id") != body.patient_id:
            raise bad_request("The appointment belongs to another patient")
        cons = await create(ctx, CONSULT, {
            **fields, "patient_id": body.patient_id, "encounter_id": body.encounter_id or (appt or {}).get("encounter_id"),
            "appointment": (appt or {}).get("id"), "doctor": _emp(ctx), "department": fields.get("department") or (appt or {}).get("department_id"),
            "consulted_at": now().isoformat(timespec="minutes"), "status": "Open",
        })

    rx, alerts = None, []
    if body.prescription is not None:
        lines = [{k: ln.get(k) for k in ("drug", "dose", "route", "frequency", "duration_days", "qty", "instructions")}
                 for ln in body.prescription.items if ln.get("drug")]
        existing = await get(ctx, RX, body.prescription.id) if body.prescription.id else None
        if not existing and cons:
            existing = next((r for r in await find(ctx, RX, consultation=cons["id"], limit=5) if r.get("status") != "Cancelled"), None)
        if existing:
            if existing.get("patient_id") != body.patient_id:
                raise bad_request("The prescription belongs to another patient")
            _own(ctx, existing.get("doctor"), "prescription")
        if lines:
            for i, ln in enumerate(lines, 1):
                if not ln.get("qty") or float(ln["qty"]) <= 0:
                    raise bad_request(f"Medicine {i}: enter the quantity to dispense", {"fields": {f"items.{i - 1}.qty": "Required"}})
            payload = {"items": lines, "notes": body.prescription.notes, "valid_till": body.prescription.valid_till,
                       "diagnosis": body.prescription.diagnosis or (cons or {}).get("diagnosis")}
            if existing:
                await _rx_editable(ctx, existing)
                rx = await update(ctx, RX, existing["id"], payload)
            else:
                rx = await create(ctx, RX, {**payload, "patient_id": body.patient_id, "doctor": _emp(ctx),
                                            "encounter_id": body.encounter_id or (cons or {}).get("encounter_id"),
                                            "consultation": (cons or {}).get("id"), "prescribed_at": now().isoformat(timespec="minutes"),
                                            "status": "Active"})
            check = await safety_check(ctx, patient_id=body.patient_id, purpose="prescribe", prescription=rx,
                                       lines=[{"item_id": ln["drug"], "qty": ln.get("qty") or 0} for ln in lines])
            alerts = check["alerts"]
            severe = [a for a in alerts if a["severity"] in ("Major", "Contraindicated")]
            if severe:
                rx = await update(ctx, RX, rx["id"], {"alerts_at_prescribing": [{k: a[k] for k in ("type", "severity", "item", "with", "message")}
                                                                                for a in severe]})
                await audit(ctx, "rx.alerts_acknowledged", module="opd", entity="prescriptions", record=rx,
                            after={"alerts": [a["message"] for a in severe]}, note="Prescribed despite drug-safety alerts")
        elif existing:
            await _rx_editable(ctx, existing)
            rx = await transition(ctx, RX, existing["id"], "Cancelled", values={"cancel_reason": "Therapy changed"},
                                  note="All medicines removed in the workbench")
    return {"consultation": cons, "prescription": rx, "alerts": alerts, "orders_url": f"/m/orders/cpoe?patient={body.patient_id}"}


class CompleteIn(BaseModel):
    consultation_id: str


@router.post("/workbench/complete")
async def complete_consultation(body: CompleteIn, ctx: CtxDep):
    _doctor(ctx)
    cons = await get(ctx, CONSULT, body.consultation_id)
    if not cons:
        raise not_found("Consultation not found")
    _own(ctx, cons.get("doctor"), "consultation")
    if cons.get("status") == "Open":
        if not (cons.get("diagnosis") or "").strip():
            raise bad_request("Record the diagnosis before completing the consultation", {"fields": {"diagnosis": "Required"}})
        cons = await transition(ctx, CONSULT, cons["id"], "Completed")
    appt = await get(ctx, APPT, cons["appointment"]) if cons.get("appointment") else None
    if appt and appt.get("status") == "Checked-in":
        appt = await transition(ctx, APPT, appt["id"], "In Consultation")
    if appt and appt.get("status") == "In Consultation":
        appt = await transition(ctx, APPT, appt["id"], "Completed", note=f"Consultation {cons.get('code')} completed")
    follow_up = None
    if cons.get("follow_up_date"):
        existing = await find(ctx, "opd.follow_ups", consultation=cons["id"], limit=1)
        follow_up = existing[0] if existing else await create(ctx, "opd.follow_ups", {
            "patient_id": cons["patient_id"], "consultation": cons["id"], "doctor": cons.get("doctor"), "due_date": cons["follow_up_date"],
            "reason": "Review with reports" if cons.get("review_with_reports") else "Routine review", "status": "Due",
        })
    return {"consultation": cons, "appointment": appt, "follow_up": follow_up}


# ================================================================== nursing station

async def _wards(ctx) -> list[dict]:
    w = records
    rows = (await ctx.conn.execute(
        sa.select(w.c.id, w.c.code, w.c.title, w.c.data["ward_type"].astext, sa.func.count(beds.c.id),
                  sa.func.count(beds.c.id).filter(beds.c.status == "Occupied"))
        .select_from(w.outerjoin(beds, sa.and_(beds.c.ward_id == w.c.id, beds.c.deleted_at.is_(None))))
        .where(w.c.module == "mdm", w.c.entity == "wards", w.c.deleted_at.is_(None), sa.func.coalesce(w.c.status, "Active") == "Active")
        .group_by(w.c.id, w.c.code, w.c.title, w.c.data["ward_type"].astext).order_by(w.c.title))).all()
    return [{"id": str(r[0]), "code": r[1], "name": r[2], "ward_type": r[3], "beds": r[4], "occupied": r[5]} for r in rows]


PRIORITY_RANK = {"STAT": 0, "Urgent": 1, "Routine": 2}


@router.get("/nursing")
async def nursing_station(ctx: CtxDep, ward: str | None = None):
    rs.ensure_access(ctx, E(MAR), "read")
    wards = await _wards(ctx)
    if not ward:
        return {"wards": wards, "ward": None}
    w = next((x for x in wards if x["id"] == ward), None)
    if not w:
        raise not_found("Ward not found")
    ts = now()
    bed_rows = (await ctx.conn.execute(sa.select(beds.c.id, beds.c.code, beds.c.bed_no, beds.c.status, beds.c.category, beds.c.data)
                                       .where(beds.c.ward_id == ward, beds.c.deleted_at.is_(None)).order_by(beds.c.bed_no))).all()
    adm = await _admissions(ctx, ward_id=ward)
    pids = [a["patient_id"] for a in adm]
    n2 = await _latest_news2(ctx, pids)
    doctors = await _names(ctx, [a["doctor_id"] for a in adm])

    mar: list[dict] = []
    if pids:
        sched = _dcol(MAR, "scheduled_at")
        mar = await _rows(ctx, MAR, E(MAR).table.c.patient_id.in_(pids), E(MAR).table.c.status == "Scheduled",
                          sched >= ts - timedelta(hours=24), sched <= ts + timedelta(hours=4), order=sched.asc(), limit=1000)
    items = await items_by_id(ctx, [m.get("drug") for m in mar])
    by_pid = {a["patient_id"]: a for a in adm}
    late = ts - timedelta(minutes=MAR_WINDOW_MIN)
    mar_out = []
    for m in mar:
        it = items.get(m.get("drug")) or {}
        a = by_pid.get(m["patient_id"], {})
        at = parse_dt(m.get("scheduled_at"))
        mar_out.append({"id": m["id"], "code": m.get("code"), "patient_id": m["patient_id"], "patient": a.get("patient"), "uhid": a.get("uhid"),
                        "bed_no": a.get("bed_no"), "drug_id": m.get("drug"), "drug": item_label(it), "generic": it.get("generic_name"),
                        "drug_code": it.get("code"), "drug_barcode": it.get("barcode"),
                        "dose": m.get("dose"), "route": m.get("route"), "scheduled_at": m.get("scheduled_at"),
                        "high_alert": bool(m.get("high_alert") or it.get("high_alert")), "overdue": bool(at and at < late),
                        "due_in_minutes": _mins(ts, at), "prescription": m.get("prescription"), "status": m.get("status"),
                        "encounter_id": m.get("encounter_id")})

    tt = E(TASKS).table
    task_conds = [tt.c.data["ward"].astext == ward] + ([tt.c.patient_id.in_(pids)] if pids else [])
    tasks = await _rows(ctx, TASKS, tt.c.status == "Pending", sa.or_(*task_conds), order=tt.c.created_at.asc(), limit=300)
    tasks.sort(key=lambda t: (PRIORITY_RANK.get(t.get("priority") or "Routine", 3), t.get("due_at") or "9999"))
    ht = E("nursing.handovers").table
    handovers = await _rows(ctx, "nursing.handovers", ht.c.data["ward"].astext == ward, order=ht.c.created_at.desc(), limit=6)
    refs = await rs.resolve_refs(ctx, E(TASKS), tasks)
    refs.update(await rs.resolve_refs(ctx, E("nursing.handovers"), handovers))

    patients_out = []
    for a in adm:
        v = n2.get(a["patient_id"], {})
        last = parse_dt(v.get("at")) if v.get("at") else None
        mine = [m for m in mar_out if m["patient_id"] == a["patient_id"]]
        patients_out.append({
            **a, "doctor": doctors.get(a["doctor_id"] or ""), "news2": v.get("news2"), "news2_risk": v.get("risk"), "last_vitals_at": v.get("at"),
            "vitals_due": not last or last < ts - timedelta(hours=VITALS_DUE_HOURS),
            "meds_due": sum(1 for m in mine if not m["overdue"]), "meds_overdue": sum(1 for m in mine if m["overdue"]),
            "tasks": sum(1 for t in tasks if t.get("patient_id") == a["patient_id"]),
        })
    occupant = {a["bed_id"]: a for a in patients_out if a.get("bed_id")}
    bed_status: dict[str, int] = {}
    beds_out = []
    for b in bed_rows:
        bed_status[b.status or "Unknown"] = bed_status.get(b.status or "Unknown", 0) + 1
        beds_out.append({"id": str(b.id), "bed_no": b.bed_no or b.code, "status": b.status, "category": b.category,
                         "patient_id": (occupant.get(str(b.id)) or {}).get("patient_id")})
    return {
        "wards": wards, "ward": w, "as_of": ts.isoformat(), "beds": beds_out, "patients": patients_out, "mar": mar_out, "tasks": tasks,
        "handovers": handovers, "refs": refs,
        "census": {"beds": len(bed_rows), "by_status": bed_status, "patients": len(adm),
                   "high_news2": sum(1 for p in patients_out if (p["news2"] or 0) >= 5 or p["news2_risk"] == "Low-medium"),
                   "vitals_due": sum(1 for p in patients_out if p["vitals_due"]),
                   "meds_due": sum(1 for m in mar_out if not m["overdue"]), "meds_overdue": sum(1 for m in mar_out if m["overdue"]),
                   "tasks": len(tasks), "stat_tasks": sum(1 for t in tasks if t.get("priority") == "STAT"),
                   "discharges_pending": sum(1 for a in adm if a["status"] == "Discharge Initiated")},
    }


# ------------------------------------------------------------------ MAR: barcode-verified administration

class AdministerIn(BaseModel):
    barcode: str | None = Field(default=None, max_length=400)
    patient_barcode: str | None = Field(default=None, max_length=100)
    drug_barcode: str | None = Field(default=None, max_length=100)
    witness: str | None = None
    site: str | None = Field(default=None, max_length=200)
    remarks: str | None = Field(default=None, max_length=500)


def _norm(s: Any) -> str:
    return re.sub(r"\s+", "", str(s or "")).upper()


@router.post("/mar/{mid}/administer")
async def administer(mid: str, body: AdministerIn, ctx: CtxDep):
    """Bedside BCMA: the scans must include the patient's wristband (UHID) and the medicine's barcode
    (or item code when the item has no barcode); any mismatch stops the administration with 409."""
    require_role(ctx, "nurse")
    m = await get(ctx, MAR, mid)
    if not m:
        raise not_found("MAR entry not found")
    if m.get("status") != "Scheduled":
        raise conflict(f"This dose is already {m.get('status')}")
    p = await patient_or_404(ctx, m["patient_id"])
    it = (await items_by_id(ctx, [m.get("drug")])).get(m.get("drug")) or {}
    scans = [_norm(t) for t in re.split(r"[\s|,;]+", body.barcode or "") if t.strip()]
    scans += [_norm(x) for x in (body.patient_barcode, body.drug_barcode) if x and x.strip()]
    if not scans:
        raise bad_request("Scan the patient's wristband and the medicine barcode")
    uhid = _norm(p.get("code"))
    drug_codes = {c for c in (_norm(it.get("barcode")), _norm(it.get("code"))) if c}
    patient_ok, drug_ok = uhid in scans, bool(drug_codes & set(scans))
    other = [s for s in scans if s != uhid and s not in drug_codes]
    if not patient_ok:
        raise ApiError(409, f"Wrong patient — wristband {other[0] if other else 'not scanned'} does not match {p.get('title')} ({p.get('code')})",
                       {"patient_ok": False, "drug_ok": drug_ok}, code="BCMA_PATIENT_MISMATCH")
    if not drug_ok:
        raise ApiError(409, f"Wrong medicine — scanned {other[0] if other else 'nothing'} but this dose is {item_label(it)} ({it.get('code')})",
                       {"patient_ok": True, "drug_ok": False}, code="BCMA_DRUG_MISMATCH")
    at = parse_dt(m.get("scheduled_at"))
    if at and at - now() > timedelta(minutes=MAR_WINDOW_MIN) and not (body.remarks or "").strip():
        raise bad_request(f"This dose is not due until {at.astimezone(settings.tz):%H:%M} — give a reason to administer it early",
                          {"fields": {"remarks": "Reason required"}})
    ctx.__dict__["_bcma_verified"] = mid
    values = {k: v for k, v in {"witness": body.witness, "site": body.site, "remarks": body.remarks}.items() if v}
    return await transition(ctx, MAR, mid, "Given", values=values or None, note="Barcode verified (patient wristband + medicine)")


@hook(MAR, "before_create")
async def _mar_defaults(ctx, draft):
    it = (await items_by_id(ctx, [draft.get("drug")])).get(draft.get("drug")) or {}
    draft["high_alert"] = bool(it.get("high_alert"))


@hook(MAR, "before_transition")
async def _mar_given(ctx, nxt, prev):
    if nxt["status"] != "Given":
        return
    nxt["administered_by"] = _emp(ctx)
    nxt["barcode_verified"] = ctx.__dict__.get("_bcma_verified") == prev["id"]
    if nxt.get("high_alert"):
        if not nxt.get("witness"):
            raise bad_request("High-alert medication: record the second nurse who independently double-checked the dose",
                              {"fields": {"witness": "Required for high-alert medicines"}})
        if nxt["witness"] == _emp(ctx):
            raise bad_request("The double-check must be done by a different nurse", {"fields": {"witness": "Choose another nurse"}})


# ------------------------------------------------------------------ MAR schedule generation

class MarGenIn(BaseModel):
    encounter_id: str | None = None
    ward_id: str | None = None
    date: str | None = None


def dose_times(freq: str | None, day: date) -> list[datetime]:
    out = []
    for hhmm in FREQ_TIMES.get(freq or "", []):
        h, mi = (int(x) for x in hhmm.split(":"))
        base = datetime.combine(day, time(0, 0), tzinfo=settings.tz)
        out.append(base + timedelta(hours=h, minutes=mi))
    return out


async def _generate_for(ctx, enc: dict, day: date) -> tuple[list[dict], int]:
    pid = enc["patient_id"]
    started = parse_dt(enc.get("started_at") or enc.get("admitted_at"))
    rxs = [r for r in await find(ctx, RX, patient_id=pid, status=["Active", "Partially Dispensed", "Dispensed"], limit=100)
           if r.get("encounter_id") == enc["encounter_id"]
           or (not r.get("encounter_id") and started and parse_dt(r.get("prescribed_at") or r["created_at"]) >= started)]
    if not rxs:
        return [], 0
    s, _ = day_bounds(day)
    sched = _dcol(MAR, "scheduled_at")
    existing = await _rows(ctx, MAR, E(MAR).table.c.patient_id == pid, sched >= s - timedelta(days=1), sched < s + timedelta(days=2), limit=2000)
    have = {(m.get("prescription"), m.get("drug"), parse_dt(m["scheduled_at"]).isoformat()) for m in existing if m.get("scheduled_at")}
    ever = {(m.get("prescription"), m.get("drug")) for m in existing}
    created, skipped = [], 0
    ts = now()
    for rx in rxs:
        start = parse_dt(rx.get("prescribed_at") or rx["created_at"])
        for ln in rx.get("items") or []:
            freq, drug = ln.get("frequency"), ln.get("drug")
            if not drug:
                continue
            end = start + timedelta(days=float(ln["duration_days"])) if ln.get("duration_days") else None
            if freq == "STAT":
                slots = [max(ts, start)] if (rx["id"], drug) not in ever else []
            elif freq == "Weekly":
                slots = [t for t in dose_times(freq, day) if day.weekday() == start.astimezone(settings.tz).weekday()]
            else:
                slots = dose_times(freq, day)
            for at in slots:
                if at < start or (end and at > end):
                    continue
                if (rx["id"], drug, at.isoformat()) in have:
                    skipped += 1
                    continue
                created.append(await create(ctx, MAR, {
                    "patient_id": pid, "encounter_id": enc["encounter_id"], "drug": drug, "dose": ln.get("dose"), "route": ln.get("route"),
                    "scheduled_at": at.isoformat(), "prescription": rx["id"], "status": "Scheduled", "frequency": freq,
                }))
                have.add((rx["id"], drug, at.isoformat()))
    return created, skipped


@router.post("/mar/generate")
async def mar_generate(body: MarGenIn, ctx: CtxDep):
    """Today's (or `date`'s) MAR from active inpatient prescriptions: OD 09:00, BD 09/21, TDS 08/14/20,
    QID & Q6H 06/12/18/24, Q8H 06/14/22, Q4H every 4 h from 02:00, HS 22:00, STAT once now, SOS on demand only.
    Idempotent — doses already on the MAR are skipped."""
    require_role(ctx, "nurse", "doctor")
    day = parse_date(body.date) if body.date else today()
    if body.encounter_id:
        encs = [a for a in await _admissions(ctx) if a["encounter_id"] == body.encounter_id] if is_uuid(body.encounter_id) else []
        if not encs:
            raise conflict("MAR can only be generated for a current inpatient admission")
    elif body.ward_id:
        encs = await _admissions(ctx, ward_id=body.ward_id)
    else:
        raise bad_request("Choose an admission or a ward")
    created, skipped = [], 0
    for enc in encs:
        c, s = await _generate_for(ctx, enc, day)
        created += c
        skipped += s
    return {"date": day.isoformat(), "admissions": len(encs), "created": len(created), "skipped": skipped,
            "entries": [{"id": m["id"], "code": m.get("code"), "patient_id": m["patient_id"], "drug": m.get("drug"),
                         "scheduled_at": m.get("scheduled_at")} for m in created[:200]]}


__all__ = ["router", "news2", "patient_location", "dose_times"]
