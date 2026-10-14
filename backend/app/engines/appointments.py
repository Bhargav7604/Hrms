"""Appointments / OPD: the slot engine (schedules − unavailability − bookings), doctor-wise and
unit-wise day boards, booking with double-booking guards and daily tokens, rescheduling, and the
check-in chain: OPD encounter → doctor queue token → consultation charge.

Rules live in entity hooks so the generic forms, the booking desk and the patient portal all
behave the same way."""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core import records as rs
from ..core.hooks import emit, hook
from ..core.security import CtxDep
from ..core.util import ApiError, age_from, bad_request, conflict, is_uuid, not_found, now, parse_date, today
from ..schema import appointments, charges, employees, patients, records
from ._common import E, create, find, get, has, require_role, transition, update
from .billing import post_charge
from .queue import act as queue_act
from .queue import doctor_queue, issue_token, resolve_target, token_label

log = logging.getLogger("vlack.appointments")
router = APIRouter(prefix="/api/appointments", tags=["appointments"])

FQN = "appointments.appointments"
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
INACTIVE = ("Cancelled", "No-show")  # these free their slot


# ------------------------------------------------------------------ small helpers

def _mins(hhmm: str) -> int:
    h, m = str(hhmm)[:5].split(":")
    return int(h) * 60 + int(m)


def _hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def _now_mins() -> int:
    n = now()
    return n.hour * 60 + n.minute


def _is_system(ctx) -> bool:
    """Seeds, imports and background jobs run as the system user and bypass booking guards."""
    return ctx.user.get("id") == "system"


async def _lock(ctx, doctor_id: str, d: date) -> None:
    await ctx.conn.execute(sa.text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"appt:{doctor_id}:{d}"})


async def _titles(ctx, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(records.c.id, records.c.title).where(records.c.id.in_(ids)))).all()
    return {str(r.id): r.title for r in rows}


async def doctor_info(ctx, doctor_id: str) -> dict:
    if not doctor_id or not is_uuid(doctor_id):
        raise bad_request("Choose a doctor")
    row = (await ctx.conn.execute(sa.select(employees).where(employees.c.id == doctor_id, employees.c.deleted_at.is_(None)))).first()
    if not row:
        raise not_found("Doctor not found")
    d = rs.to_record(row)
    if d.get("category") != "Doctor":
        raise bad_request(f"{d.get('name')} is not a doctor")
    if d.get("status") not in (None, "Active"):
        raise conflict(f"{d.get('name')} is not active ({d.get('status')})")
    depts = await _titles(ctx, {d.get("department_id")})
    return {"id": d["id"], "name": d.get("name"), "code": d.get("code"), "department_id": d.get("department_id"),
            "department": depts.get(d.get("department_id") or ""), "consult_fee": d.get("consult_fee"),
            "specialization": d.get("specialization"), "qualification": d.get("qualification")}


# ------------------------------------------------------------------ schedules, leaves, bookings

def _valid_on(s: dict, d: date) -> bool:
    if WEEKDAYS[d.weekday()] not in (s.get("weekdays") or []):
        return False
    vf, vt = parse_date(s.get("valid_from")), parse_date(s.get("valid_to"))
    return not ((vf and d < vf) or (vt and d > vt))


async def all_schedules(ctx) -> list[dict]:
    rows = await find(ctx, "appointments.schedules", status="Active", limit=2000)
    for r in rows:
        r.pop("_refs", None)
    return rows


async def schedules_for(ctx, doctor_id: str, d: date) -> tuple[list[dict], bool]:
    """Sessions of this doctor on `d`, and whether the doctor has any schedule at all."""
    rows = await find(ctx, "appointments.schedules", status="Active", doctor=doctor_id, limit=50)
    sessions = sorted((s for s in rows if _valid_on(s, d) and s.get("start_time") and s.get("end_time")),
                      key=lambda s: s["start_time"])
    return sessions, bool(rows)


def session_times(s: dict) -> list[str]:
    start, end, step = _mins(s["start_time"]), _mins(s["end_time"]), max(5, int(s.get("slot_minutes") or 15))
    return [_hhmm(m) for m in range(start, end - step + 1, step)]


async def leaves_on(ctx, d: date, doctor_id: str | None = None) -> dict[str, dict]:
    t = records
    conds = [t.c.module == "appointments", t.c.entity == "leaves", t.c.deleted_at.is_(None),
             t.c.data["from_date"].astext <= d.isoformat(), t.c.data["to_date"].astext >= d.isoformat()]
    if doctor_id:
        conds.append(t.c.data["doctor"].astext == doctor_id)
    out = {}
    for r in (await ctx.conn.execute(sa.select(t).where(*conds))).all():
        rec = rs.to_record(r)
        out[rec.get("doctor")] = {"id": rec["id"], "code": rec["code"], "reason": rec.get("reason"),
                                  "from_date": rec.get("from_date"), "to_date": rec.get("to_date")}
    return out


async def bookings(ctx, d: date, *, doctor_id: str | None = None, department_id: str | None = None,
                   include_inactive: bool = True) -> list[dict]:
    """Appointments of a day with the patient's name/UHID/age (staff views)."""
    a, p = appointments, patients
    conds = [a.c.deleted_at.is_(None), a.c.appt_date == d]
    if doctor_id:
        conds.append(a.c.doctor_id == doctor_id)
    if department_id:
        conds.append(a.c.department_id == department_id)
    if not include_inactive:
        conds.append(a.c.status.notin_(INACTIVE))
    rows = (await ctx.conn.execute(
        sa.select(a, p.c.title.label("p_name"), p.c.code.label("p_uhid"), p.c.dob.label("p_dob"), p.c.gender.label("p_gender"),
                  p.c.phone.label("p_phone"))
        .select_from(a.outerjoin(p, p.c.id == a.c.patient_id)).where(*conds)
        .order_by(a.c.token_no.asc().nulls_last(), a.c.slot.asc()))).all()
    out = []
    for r in rows:
        m = dict(r._mapping)
        extra = {k: m.pop(k) for k in ("p_name", "p_uhid", "p_dob", "p_gender", "p_phone")}
        rec = rs.to_record(m)
        rec.update(patient=extra["p_name"], uhid=extra["p_uhid"], age=age_from(extra["p_dob"]), gender=extra["p_gender"],
                   phone=extra["p_phone"])
        out.append(rec)
    return out


def _brief(a: dict, with_patient: bool) -> dict:
    keys = ["id", "code", "token_no", "slot", "status", "type", "booking_source", "appt_date"]
    if with_patient:
        keys += ["patient_id", "patient", "uhid", "age", "gender", "reason", "checked_in_at", "encounter_id", "queue_token",
                 "rescheduled_from", "overbooked"]
    return {k: a.get(k) for k in keys}


async def slot_grid(ctx, doctor_id: str, d: date, *, with_patients: bool = True) -> dict:
    """Every slot of the doctor's sessions on `d`: free / booked / past / full / leave."""
    doc = await doctor_info(ctx, doctor_id)
    sessions, has_schedule = await schedules_for(ctx, doctor_id, d)
    leave = (await leaves_on(ctx, d, doctor_id)).get(doctor_id)
    booked = await bookings(ctx, d, doctor_id=doctor_id, include_inactive=False)
    by_slot: dict[str, list[dict]] = defaultdict(list)
    for b in booked:
        by_slot[b.get("slot") or ""].append(b)
    t0, nowm = today(), _now_mins()
    slots, seen = [], set()
    capacity = 0
    for s in sessions:
        step = max(5, int(s.get("slot_minutes") or 15))
        times = session_times(s)
        cap = int(s.get("max_patients") or len(times))
        capacity += min(cap, len(times))
        in_session = sum(len(by_slot.get(t, [])) for t in times)
        label = f"{s['start_time']}–{s['end_time']}"
        for t in times:
            seen.add(t)
            apps = by_slot.get(t, [])
            if apps:
                st = "booked"
            elif leave:
                st = "leave"
            elif d < t0 or (d == t0 and _mins(t) + step <= nowm):
                st = "past"
            elif in_session >= cap:
                st = "full"
            else:
                st = "free"
            slots.append({"time": t, "status": st, "session": label, "room": s.get("room"),
                          "appointments": [_brief(a, with_patients) for a in apps] if with_patients else []})
    for t, apps in sorted(by_slot.items()):  # overbooked / off-schedule bookings
        if t not in seen:
            slots.append({"time": t, "status": "booked", "session": "Extra", "room": None, "off_grid": True,
                          "appointments": [_brief(a, with_patients) for a in apps] if with_patients else []})
    slots.sort(key=lambda x: x["time"])
    first = sessions[0] if sessions else {}
    return {
        "doctor": doc, "date": d.isoformat(), "weekday": WEEKDAYS[d.weekday()], "has_schedule": has_schedule,
        "on_leave": leave, "room": first.get("room"), "mode": first.get("mode"),
        "consult_fee": doc.get("consult_fee") or first.get("consult_fee"),
        "sessions": [{"start": s["start_time"], "end": s["end_time"], "slot_minutes": s.get("slot_minutes"),
                      "room": s.get("room"), "max_patients": s.get("max_patients"), "mode": s.get("mode")} for s in sessions],
        "slots": slots, "capacity": capacity, "booked": len(booked),
        "free": sum(1 for x in slots if x["status"] == "free"),
    }


# ------------------------------------------------------------------ booking rules (hooks)

async def _validate_booking(ctx, draft: dict, d: date) -> None:
    doctor_id, slot, pid = draft.get("doctor_id"), draft.get("slot"), draft.get("patient_id")
    doc = await doctor_info(ctx, doctor_id)
    overbook = bool(draft.get("overbooked"))
    t0 = today()
    if d < t0:
        raise bad_request("Appointments cannot be booked for a past date")
    if d > t0 + timedelta(days=90):
        raise bad_request("Appointments can be booked up to 90 days ahead")
    leave = (await leaves_on(ctx, d, doctor_id)).get(doctor_id)
    if leave:
        raise conflict(f"{doc['name']} is unavailable on {d:%d %b %Y}" + (f" ({leave['reason']})" if leave.get("reason") else ""))
    sessions, has_schedule = await schedules_for(ctx, doctor_id, d)
    if has_schedule and not sessions:
        raise conflict(f"{doc['name']} has no OPD on {WEEKDAYS[d.weekday()]} {d:%d %b}")
    if not overbook and sessions:
        sess = next((s for s in sessions if slot in session_times(s)), None)
        if not sess:
            windows = ", ".join(f"{s['start_time']}–{s['end_time']} every {s.get('slot_minutes') or 15} min" for s in sessions)
            raise bad_request(f"{slot} is not a slot of {doc['name']} ({windows})")
        step = max(5, int(sess.get("slot_minutes") or 15))
        if d == t0 and _mins(slot) + step <= _now_mins():
            raise bad_request(f"The {slot} slot has already passed — choose a later slot or book as an extra (overbook)")
    a = appointments
    active = [a.c.deleted_at.is_(None), a.c.appt_date == d, a.c.doctor_id == doctor_id, a.c.status.notin_(INACTIVE)]
    if pid:
        dup = (await ctx.conn.execute(sa.select(a.c.token_no, a.c.slot).where(*active, a.c.patient_id == pid).limit(1))).first()
        if dup:
            raise conflict(f"This patient already has an appointment with {doc['name']} on {d:%d %b} (token {dup.token_no}, {dup.slot})")
    if overbook:
        return
    taken = (await ctx.conn.execute(sa.select(a.c.token_no).where(*active, a.c.slot == slot).limit(1))).first()
    if taken:
        raise conflict(f"{slot} with {doc['name']} is already booked (token {taken.token_no}). Pick another slot.")
    if sessions:
        sess = next(s for s in sessions if slot in session_times(s))
        cap = sess.get("max_patients")
        if cap:
            times = session_times(sess)
            n = (await ctx.conn.execute(sa.select(sa.func.count()).where(*active, a.c.slot.in_(times)))).scalar_one()
            if n >= int(cap):
                raise conflict(f"The {sess['start_time']}–{sess['end_time']} session is full ({cap} patients)")


async def _next_token(ctx, doctor_id: str, d: date) -> int:
    a = appointments
    n = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.max(a.c.token_no), 0)).where(
        a.c.doctor_id == doctor_id, a.c.appt_date == d, a.c.deleted_at.is_(None)))).scalar_one()
    return int(n) + 1


@hook(FQN, "before_create")
async def _before_create(ctx, draft: dict):
    d = parse_date(draft.get("appt_date"))
    doctor_id = draft.get("doctor_id")
    if not d or not doctor_id or not draft.get("slot"):
        raise bad_request("Doctor, date and slot are required")
    await _lock(ctx, doctor_id, d)
    if not _is_system(ctx):
        await _validate_booking(ctx, draft, d)
    if not draft.get("token_no"):
        draft["token_no"] = await _next_token(ctx, doctor_id, d)
    if not draft.get("department_id"):
        sessions, _ = await schedules_for(ctx, doctor_id, d)
        dept = next((s.get("department") for s in sessions if s.get("department")), None)
        if not dept:
            dept = (await ctx.conn.execute(sa.select(employees.c.department_id).where(employees.c.id == doctor_id))).scalar()
        draft["department_id"] = str(dept) if dept else None
    draft.setdefault("booked_at", now().isoformat(timespec="seconds"))


@hook(FQN, "before_update")
async def _before_update(ctx, nxt: dict, prev: dict):
    if _is_system(ctx):
        return
    moved = any(str(nxt.get(k) or "") != str(prev.get(k) or "") for k in ("doctor_id", "appt_date", "slot"))
    if moved:
        raise conflict("Use Reschedule to change the doctor, date or slot — the original booking is kept for the audit trail")


@hook(FQN, "after_create")
async def _after_create(ctx, rec: dict):
    if rec.get("type") == "Teleconsult" and has("telemedicine.teleconsults"):
        await _create_teleconsult(ctx, rec)
    if rec.get("status") == "Booked" and (parse_date(rec.get("appt_date")) or today()) >= today():
        await emit("appointment.booked", ctx, {"appointment": rec})


async def _create_teleconsult(ctx, appt: dict) -> None:
    doc = await doctor_info(ctx, appt["doctor_id"])
    tc = await create(ctx, "telemedicine.teleconsults", {
        "patient_id": appt["patient_id"], "doctor": appt["doctor_id"], "department": appt.get("department_id"),
        "scheduled_at": f"{appt['appt_date']}T{appt['slot']}:00", "consult_type": "Follow-up" if appt.get("type") == "Follow-up" else "First consultation",
        "mode": "Video", "appointment": appt["id"], "fee": doc.get("consult_fee"), "payment_status": "Pending",
        "chief_complaint": appt.get("reason"), "status": "Scheduled",
    })
    await update(ctx, FQN, appt["id"], {"teleconsult": tc["id"]})


# ------------------------------------------------------------------ status chain (check-in → consult → complete)

@hook(FQN, "before_transition")
async def _before_transition(ctx, nxt: dict, prev: dict):
    to, frm = nxt.get("status"), prev.get("status")
    if to == "Checked-in" and frm == "Booked":
        if parse_date(nxt.get("appt_date")) != today():
            raise conflict("Only today's appointments can be checked in")
        await _check_in(ctx, nxt)
    elif to == "In Consultation":
        await _token(ctx, nxt, "serve")
    elif to == "Completed":
        await _close_encounter(ctx, nxt, "Closed")
        await _token(ctx, nxt, "done")
    elif to in INACTIVE:
        await _undo_check_in(ctx, nxt, prev)


@hook(FQN, "after_transition")
async def _after_transition(ctx, rec: dict, prev: dict):
    if rec.get("status") == "Checked-in" and prev.get("status") == "Booked":
        token = await get(ctx, "queue.tokens", rec["queue_token"]) if rec.get("queue_token") else None
        await emit("appointment.checked_in", ctx, {"appointment": rec, "token": token,
                                                    "label": token_label(token["queue"], token.get("token_no")) if token else None})


async def _check_in(ctx, appt: dict) -> None:
    doc = await doctor_info(ctx, appt["doctor_id"])
    tele = appt.get("type") == "Teleconsult"
    if not appt.get("encounter_id"):
        enc = await create(ctx, "ipd.encounters", {
            "patient_id": appt["patient_id"], "type": "TELE" if tele else "OPD", "status": "Open",
            "doctor_id": appt["doctor_id"], "department_id": appt.get("department_id") or doc.get("department_id"),
            "started_at": now().isoformat(timespec="seconds"), "appointment": appt["id"],
        })
        appt["encounter_id"] = enc["id"]
    if tele:  # the teleconsult is charged by telemedicine on completion and has no cabin queue
        return
    tok = await issue_token(ctx, queue=doctor_queue(doc["code"]), patient_id=appt["patient_id"], appointment_id=appt["id"],
                            token_no=appt.get("token_no"), source="Appointment")
    appt["queue_token"] = tok["id"]
    appt["queue_label"] = token_label(tok["queue"], tok.get("token_no"))
    await _post_consult_charge(ctx, appt, doc)


async def _post_consult_charge(ctx, appt: dict, doc: dict) -> None:
    exists = (await ctx.conn.execute(sa.select(charges.c.id).where(
        charges.c.source_id == appt["id"], charges.c.status != "Cancelled", charges.c.deleted_at.is_(None)).limit(1))).first()
    if exists:
        return
    follow_up = appt.get("type") == "Follow-up"
    rate: Any = None
    if not follow_up:  # new consults at the doctor's fee; follow-ups at the CONS-FOLLOWUP tariff
        rate = doc.get("consult_fee")
        if rate in (None, "", 0):
            sessions, _ = await schedules_for(ctx, appt["doctor_id"], today())
            rate = next((s.get("consult_fee") for s in sessions if s.get("consult_fee")), None)
    ch = await post_charge(ctx, patient_id=appt["patient_id"], encounter_id=appt.get("encounter_id"),
                           service_code="CONS-FOLLOWUP" if follow_up else "CONS-OPD", rate=rate,
                           description=f"{'Follow-up' if follow_up else 'OPD'} consultation — {doc['name']}",
                           source=FQN, source_id=appt["id"])
    appt["charge_id"] = ch["id"]


async def _token(ctx, appt: dict, action: str) -> None:
    tid = appt.get("queue_token")
    if not tid:
        return
    tok = await get(ctx, "queue.tokens", tid)
    if not tok:
        return
    st = tok.get("status")
    if action == "serve":
        if st in ("Waiting", "Skipped"):
            await queue_act(ctx, tid, "call", await resolve_target(ctx, None, tok["queue"]))
            st = "Called"
        if st == "Called":
            await queue_act(ctx, tid, "serve")
    elif action == "done" and st in ("Called", "Serving"):
        await queue_act(ctx, tid, "done")
    elif action == "skip" and st in ("Waiting", "Called"):
        await queue_act(ctx, tid, "skip")


async def _close_encounter(ctx, appt: dict, status: str) -> None:
    eid = appt.get("encounter_id")
    enc = await get(ctx, "ipd.encounters", eid) if eid else None
    if enc and enc.get("status") == "Open":
        await update(ctx, "ipd.encounters", eid, {"status": status, "ended_at": now().isoformat(timespec="seconds")})


async def _undo_check_in(ctx, appt: dict, prev: dict) -> None:
    """Cancelled / no-show: nothing is billed — reverse an unbilled consultation charge."""
    if prev.get("status") != "Checked-in":
        return
    await _close_encounter(ctx, appt, "Cancelled")
    await _token(ctx, appt, "skip")
    rows = (await ctx.conn.execute(sa.select(charges.c.id, charges.c.status).where(
        charges.c.source_id == appt["id"], charges.c.deleted_at.is_(None), charges.c.status != "Cancelled"))).all()
    for r in rows:
        if r.status == "Unbilled":
            await update(ctx, "billing.charges", str(r.id), {"status": "Cancelled", "cancel_reason": f"Appointment {appt.get('code')} {appt['status'].lower()}"})
        else:
            appt["refund_due"] = True
            log.warning("appointment %s %s after billing — consultation charge %s needs a refund", appt.get("code"), appt["status"], r.id)


@hook(FQN, "after_transition")
async def _cancel_teleconsult(ctx, rec: dict, prev: dict):
    if rec.get("status") not in INACTIVE or not rec.get("teleconsult") or not has("telemedicine.teleconsults"):
        return
    tc = await get(ctx, "telemedicine.teleconsults", rec["teleconsult"])
    if tc and tc.get("status") in ("Scheduled", "Waiting"):
        if rec["status"] == "No-show":
            await transition(ctx, "telemedicine.teleconsults", tc["id"], "No-show")
        else:
            reason = rec.get("cancel_reason") if rec.get("cancel_reason") in ("Patient request", "Doctor unavailable") else "Other"
            await transition(ctx, "telemedicine.teleconsults", tc["id"], "Cancelled", values={"cancel_reason": reason},
                             note=f"Appointment {rec.get('code')} {rec['status'].lower()}")


# ------------------------------------------------------------------ doctor unavailability

@hook("appointments.leaves", "before_create")
@hook("appointments.leaves", "before_update")
async def _leave_dates(ctx, nxt: dict, prev: dict | None = None):
    f, t = parse_date(nxt.get("from_date")), parse_date(nxt.get("to_date"))
    if f and t and t < f:
        raise bad_request("'To date' must be on or after 'From date'")


@hook("appointments.leaves", "after_create")
async def _leave_created(ctx, rec: dict):
    a = appointments
    rows = (await ctx.conn.execute(sa.select(a).where(
        a.c.doctor_id == rec.get("doctor"), a.c.deleted_at.is_(None), a.c.status == "Booked",
        a.c.appt_date >= parse_date(rec["from_date"]), a.c.appt_date <= parse_date(rec["to_date"])))).all()
    affected = [rs.to_record(r) for r in rows]
    if rec.get("notify_patients", True):
        for appt in affected:
            await emit("appointment.doctor_unavailable", ctx, {"appointment": appt, "leave": rec})
    await update(ctx, "appointments.leaves", rec["id"], {"affected_bookings": len(affected),
                                                         "affected_ids": [x["id"] for x in affected][:500]})


# ------------------------------------------------------------------ API

class BookIn(BaseModel):
    patient_id: str
    doctor_id: str
    appt_date: str
    slot: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    type: Literal["New", "Follow-up", "Review with reports", "Teleconsult", "Procedure"] = "New"
    booking_source: str = "Walk-in"
    department_id: str | None = None
    reason: str | None = Field(default=None, max_length=300)
    notes: str | None = Field(default=None, max_length=2000)
    overbook: bool = False


async def book(ctx, body: BookIn, *, source: str | None = None, extra: dict | None = None) -> dict:
    """Create a booking (validation, token and department are applied by the hooks)."""
    if not is_uuid(body.patient_id):
        raise bad_request("Choose a patient")
    pat = (await ctx.conn.execute(sa.select(patients.c.status).where(patients.c.id == body.patient_id, patients.c.deleted_at.is_(None)))).first()
    if not pat:
        raise not_found("Patient not found")
    if pat.status in ("Merged", "Deceased", "Inactive"):
        raise conflict(f"Patient record is {pat.status.lower()} — use the active UHID")
    data = {k: v for k, v in body.model_dump(exclude={"overbook"}).items() if v not in (None, "")}
    data.update(booking_source=source or body.booking_source, status="Booked", **(extra or {}))
    if body.overbook:
        data["overbooked"] = True
    rec = await create(ctx, FQN, data)
    return await get(ctx, FQN, rec["id"]) if rec.get("type") == "Teleconsult" else rec  # picks up the linked teleconsult


@router.get("/slots")
async def slots_api(ctx: CtxDep, doctor_id: str, date: str | None = None):
    rs.ensure_access(ctx, E(FQN), "read")
    return await slot_grid(ctx, doctor_id, parse_date(date) or today())


@router.post("/book", status_code=201)
async def book_api(body: BookIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(FQN), "write")
    if body.overbook:
        require_role(ctx, "front_office")
    rec = await book(ctx, body)
    rec["_refs"] = await rs.resolve_refs(ctx, E(FQN), [rec])
    return rec


class RescheduleIn(BaseModel):
    appt_date: str
    slot: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    doctor_id: str | None = None
    reason: str | None = Field(default=None, max_length=300)
    overbook: bool = False


@router.post("/{appt_id}/reschedule", status_code=201)
async def reschedule_api(appt_id: str, body: RescheduleIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(FQN), "write")
    if body.overbook:
        require_role(ctx, "front_office")
    return await reschedule(ctx, appt_id, body)


async def reschedule(ctx, appt_id: str, body: RescheduleIn) -> dict:
    old = await get(ctx, FQN, appt_id)
    if not old:
        raise not_found("Appointment not found")
    if old.get("status") != "Booked":
        raise conflict(f"Only booked appointments can be rescheduled (this one is {old.get('status')})")
    await transition(ctx, FQN, appt_id, "Cancelled", values={"cancel_reason": "Rescheduled"},
                     note=body.reason or "Rescheduled")
    new = await book(ctx, BookIn(
        patient_id=old["patient_id"], doctor_id=body.doctor_id or old["doctor_id"], appt_date=body.appt_date, slot=body.slot,
        type=old.get("type") or "New", booking_source=old.get("booking_source") or "Walk-in",
        department_id=None if body.doctor_id and body.doctor_id != old["doctor_id"] else old.get("department_id"),
        reason=old.get("reason"), notes=old.get("notes"), overbook=body.overbook,
    ), extra={"rescheduled_from": old["id"]})
    await update(ctx, FQN, appt_id, {"rescheduled_to": new["id"]})
    return new


@router.get("/board")
async def board_api(ctx: CtxDep, date: str | None = None, department_id: str | None = None, doctor_id: str | None = None):
    """Doctor-wise list with tokens and statuses, plus the department (unit) roll-up."""
    rs.ensure_access(ctx, E(FQN), "read")
    d = parse_date(date) or today()
    rows = await bookings(ctx, d, doctor_id=doctor_id, department_id=department_id)
    scheds = [s for s in await all_schedules(ctx) if _valid_on(s, d)]
    if department_id:
        scheds = [s for s in scheds if s.get("department") == department_id]
    if doctor_id:
        scheds = [s for s in scheds if s.get("doctor") == doctor_id]
    doc_ids = {s.get("doctor") for s in scheds} | {r.get("doctor_id") for r in rows}
    doc_ids = {i for i in doc_ids if i and is_uuid(i)}
    docs = {str(r.id): r for r in (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name, employees.c.code, employees.c.department_id)
                                                          .where(employees.c.id.in_(doc_ids)))).all()} if doc_ids else {}
    leaves = await leaves_on(ctx, d)
    dept_ids = {s.get("department") for s in scheds} | {r.get("department_id") for r in rows} | {str(x.department_id) for x in docs.values() if x.department_id}
    depts = await _titles(ctx, dept_ids)
    by_doc: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_doc[r.get("doctor_id")].append(r)
    out = []
    for did in doc_ids:
        e = docs.get(did)
        mine = [s for s in scheds if s.get("doctor") == did]
        appts = by_doc.get(did, [])
        dept = (mine[0].get("department") if mine else None) or (appts[0].get("department_id") if appts else None) or (str(e.department_id) if e and e.department_id else None)
        counts: dict[str, int] = defaultdict(int)
        for a in appts:
            counts[a.get("status") or "—"] += 1
        cap = sum(min(int(s.get("max_patients") or 999), len(session_times(s))) for s in mine if s.get("start_time") and s.get("end_time"))
        out.append({
            "doctor_id": did, "name": e.name if e else "Unknown doctor", "code": e.code if e else None,
            "queue": doctor_queue(e.code) if e and e.code else None,
            "department_id": dept, "department": depts.get(dept or ""), "room": next((s.get("room") for s in mine if s.get("room")), None),
            "sessions": [f"{s['start_time']}–{s['end_time']}" for s in mine if s.get("start_time")],
            "on_leave": leaves.get(did), "capacity": cap, "counts": dict(counts),
            "active": sum(v for k, v in counts.items() if k not in INACTIVE),
            "appointments": [_brief(a, True) for a in appts],
        })
    out.sort(key=lambda x: (x["department"] or "~", x["name"] or ""))
    units: dict[str, dict] = {}
    for doc in out:
        u = units.setdefault(doc["department_id"] or "-", {"department_id": doc["department_id"], "name": doc["department"] or "Unassigned",
                                                          "doctors": 0, "capacity": 0, "total": 0, "by_status": defaultdict(int)})
        u["doctors"] += 1
        u["capacity"] += doc["capacity"]
        for k, v in doc["counts"].items():
            u["by_status"][k] += v
            u["total"] += v
    totals: dict[str, int] = defaultdict(int)
    for r in rows:
        totals[r.get("status") or "—"] += 1
    return {"date": d.isoformat(), "weekday": WEEKDAYS[d.weekday()], "doctors": out,
            "units": sorted(({**u, "by_status": dict(u["by_status"])} for u in units.values()), key=lambda x: x["name"]),
            "totals": dict(totals), "total": len(rows)}


@router.get("/doctors")
async def doctors_api(ctx: CtxDep, date: str | None = None, department_id: str | None = None):
    """Doctors consulting on a date (for pickers): name, department, room, sessions, leave."""
    rs.ensure_access(ctx, E(FQN), "read")
    return await consulting_doctors(ctx, parse_date(date) or today(), department_id)


async def consulting_doctors(ctx, d: date, department_id: str | None = None) -> list[dict]:
    scheds = [s for s in await all_schedules(ctx) if _valid_on(s, d) and (not department_id or s.get("department") == department_id)]
    ids = {s.get("doctor") for s in scheds if s.get("doctor") and is_uuid(s.get("doctor"))}
    if not ids:
        return []
    emps = {str(r.id): r for r in (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name, employees.c.code, employees.c.department_id,
                                                                         employees.c.data["specialization"].astext.label("spec"),
                                                                         employees.c.data["consult_fee"].astext.label("fee"))
                                                          .where(employees.c.id.in_(ids), employees.c.deleted_at.is_(None)))).all()}
    leaves = await leaves_on(ctx, d)
    depts = await _titles(ctx, {s.get("department") for s in scheds})
    out = []
    for did, e in emps.items():
        mine = [s for s in scheds if s.get("doctor") == did]
        dept = next((s.get("department") for s in mine if s.get("department")), None) or (str(e.department_id) if e.department_id else None)
        out.append({"id": did, "name": e.name, "code": e.code, "specialization": e.spec, "department_id": dept,
                    "department": depts.get(dept or ""), "room": next((s.get("room") for s in mine if s.get("room")), None),
                    "sessions": [f"{s['start_time']}–{s['end_time']}" for s in mine],
                    "mode": next((s.get("mode") for s in mine if s.get("mode")), None),
                    "consult_fee": float(e.fee) if e.fee else next((s.get("consult_fee") for s in mine if s.get("consult_fee")), None),
                    "on_leave": leaves.get(did)})
    return sorted(out, key=lambda x: (x["department"] or "~", x["name"] or ""))


# ------------------------------------------------------------------ nightly housekeeping

async def mark_no_shows(arq_ctx: dict | None = None) -> int:
    """23:50 — today's bookings that never checked in become No-show (frees analytics of 'Booked')."""
    from ..db import system_ctx

    n = 0
    async with system_ctx() as ctx:
        a = appointments
        ids = (await ctx.conn.execute(sa.select(a.c.id).where(a.c.appt_date <= today(), a.c.status == "Booked", a.c.deleted_at.is_(None)))).scalars().all()
        for aid in ids:
            await transition(ctx, FQN, str(aid), "No-show", note="Auto-marked at day end")
            n += 1
    log.info("marked %s no-shows", n)
    return n


CRON = [(mark_no_shows, {"hour": 23, "minute": 50})]

__all__ = ["router", "book", "BookIn", "reschedule", "RescheduleIn", "slot_grid", "consulting_doctors", "doctor_info",
           "bookings", "CRON", "ApiError"]
