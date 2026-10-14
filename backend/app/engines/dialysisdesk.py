"""Dialysis desk: billing first, then check-in → session record → check-out.

* Only patients billed for a dialysis service can be picked: an OP bill line for a DIALYSIS tariff
  service is one session entitlement (consumed by the session that uses it), and an admitted
  patient (IP number) is billed per session on the IP account at check-out.
* Machine allocation respects viral-status segregation (HBsAg / HCV / HIV dedicated machines) and
  machine state (In Use → Disinfection → Available).
* Hooks on dialysis.sessions keep the generic record screens to the same rules.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core import records as rs
from ..core.hooks import hook
from ..core.security import CtxDep
from ..core.util import (
    age_from,
    bad_request,
    conflict,
    day_bounds,
    is_uuid,
    not_found,
    now,
    parse_dt,
    to_json_value,
    today,
)
from ..schema import beds, charges, encounters, invoices, patients, records, services
from ._common import E, create, find, get, require_role, transition, update

log = logging.getLogger("vlack.dialysis")
router = APIRouter(prefix="/api/dialysis", tags=["dialysis"])

SES = "dialysis.sessions"
MAC = "dialysis.machines"
PLAN = "dialysis.plans"
OPEN = ("Scheduled", "Checked In", "In Progress")
USED = ("Scheduled", "Checked In", "In Progress", "Completed")
DESK_ROLES = ("nurse", "doctor")
SEGREGATION = {"HBsAg reactive": "Dedicated HBsAg", "Anti-HCV reactive": "Dedicated HCV", "HIV reactive": "Dedicated HIV"}
DEDICATED = set(SEGREGATION.values())
MODALITY_CODE = {"HD": "DIAL-HD", "HDF": "DIAL-HD", "SLED": "DIAL-HD", "Isolated UF": "DIAL-HD"}


def _desk(ctx) -> None:
    require_role(ctx, *DESK_ROLES)


def _view(ctx) -> None:
    require_role(ctx, *DESK_ROLES, "management", "billing")


# ------------------------------------------------------------------ eligibility: billed dialysis patients

async def _entitlements(ctx, *, patient_ids: list[str] | None = None, days: int = 45, q: str | None = None) -> list[dict]:
    """Dialysis lines on OP bills (and their use by sessions) in the window."""
    c, s, i, p = charges, services, invoices, patients
    since = day_bounds(today() - timedelta(days=days))[0]
    conds = [c.c.deleted_at.is_(None), c.c.status == "Billed", s.c.category == "DIALYSIS", c.c.charged_at >= since,
             i.c.status.in_(["Final", "Partially Paid", "Paid"])]
    if patient_ids is not None:
        conds.append(c.c.patient_id.in_(patient_ids))
    if q and q.strip():
        like = f"%{q.strip()}%"
        conds.append(sa.or_(p.c.title.ilike(like), p.c.code.ilike(like), i.c.code.ilike(like), p.c.phone.like(like)))
    rows = (await ctx.conn.execute(
        sa.select(c.c.id, c.c.code, c.c.patient_id, c.c.qty, c.c.charged_at, c.c.data["description"].astext.label("desc"),
                  s.c.code.label("svc"), i.c.id.label("inv_id"), i.c.code.label("bill"), i.c.billed_at)
        .select_from(c.join(s, s.c.id == c.c.service_id).join(i, i.c.id == c.c.invoice_id).join(p, p.c.id == c.c.patient_id))
        .where(*conds).order_by(c.c.charged_at.desc()).limit(500))).all()
    ids = [str(r.id) for r in rows]
    used: dict[str, list[dict]] = {}
    if ids:
        ent = E(SES)
        t = ent.table
        for sid, code, st, ch in (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.status, t.c.data["charge"].astext).where(
                *rs.base_where(ent), t.c.data["charge"].astext.in_(ids), t.c.status.in_(USED)))).all():
            used.setdefault(ch, []).append({"id": str(sid), "code": code, "status": st})
    out = []
    for r in rows:
        u = used.get(str(r.id), [])
        sessions = int(float(r.qty or 1))
        out.append({"charge_id": str(r.id), "charge_code": r.code, "patient_id": str(r.patient_id), "service": r.desc, "service_code": r.svc,
                    "bill_id": str(r.inv_id), "bill": r.bill, "billed_at": to_json_value(r.billed_at), "sessions": sessions,
                    "used": len(u), "available": max(0, sessions - len(u)), "used_by": u})
    return out


async def _admitted(ctx, *, patient_ids: list[str] | None = None, q: str | None = None) -> dict[str, dict]:
    """Admitted patients on dialysis (active dialysis prescription), keyed by patient."""
    e, b, p = encounters, beds, patients
    w = records.alias("w")
    ent = E(PLAN)
    pt = ent.table
    plan_pids = sa.select(pt.c.patient_id).where(*rs.base_where(ent), pt.c.status == "Active")
    conds = [e.c.deleted_at.is_(None), e.c.type.in_(["IPD", "DAYCARE"]), e.c.status.in_(["Admitted", "Discharge Initiated"]),
             e.c.patient_id.in_(plan_pids)]
    if patient_ids is not None:
        conds.append(e.c.patient_id.in_(patient_ids))
    if q and q.strip():
        like = f"%{q.strip()}%"
        conds.append(sa.or_(p.c.title.ilike(like), p.c.code.ilike(like), e.c.code.ilike(like)))
    rows = (await ctx.conn.execute(sa.select(e.c.id, e.c.code, e.c.patient_id, e.c.started_at, b.c.bed_no, w.c.title.label("ward"))
                                   .select_from(e.join(p, p.c.id == e.c.patient_id).outerjoin(b, b.c.id == e.c.bed_id)
                                                .outerjoin(w, w.c.id == b.c.ward_id)).where(*conds).limit(300))).all()
    return {str(r.patient_id): {"encounter_id": str(r.id), "ip_no": r.code, "admitted_at": to_json_value(r.started_at), "bed": r.bed_no,
                                "ward": r.ward} for r in rows}


async def _patients_brief(ctx, pids: list[str]) -> dict[str, dict]:
    if not pids:
        return {}
    rows = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.code, patients.c.title, patients.c.dob, patients.c.gender,
                                             patients.c.phone).where(patients.c.id.in_(pids)))).all()
    return {str(r.id): {"id": str(r.id), "uhid": r.code, "name": r.title, "age": age_from(r.dob), "gender": r.gender, "phone": r.phone}
            for r in rows}


async def _open_sessions(ctx, pids: list[str]) -> dict[str, dict]:
    if not pids:
        return {}
    ent = E(SES)
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t).where(*rs.base_where(ent), t.c.patient_id.in_(pids), t.c.status.in_(OPEN))
                                   .order_by(t.c.created_at.desc()))).all()
    out: dict[str, dict] = {}
    for r in rows:
        rec = rs.to_record(r)
        out.setdefault(rec["patient_id"], {k: rec.get(k) for k in ("id", "code", "status", "machine", "checked_in_at", "started_at")})
    return out


@router.get("/desk/patients")
async def desk_patients(ctx: CtxDep, q: str | None = None, days: int = 45):
    """Patients who can be dialysed now: billed on an OP bill (unused session) or admitted with an active
    dialysis prescription. Search by UHID / patient / bill no / IP no."""
    _view(ctx)
    ents = await _entitlements(ctx, days=max(1, min(days, 120)), q=q)
    adm = await _admitted(ctx, q=q)
    by_pid: dict[str, dict] = {}
    for e in ents:
        x = by_pid.setdefault(e["patient_id"], {"bills": [], "ip": None})
        x["bills"].append(e)
    for pid, a in adm.items():
        by_pid.setdefault(pid, {"bills": [], "ip": None})["ip"] = a
    pids = list(by_pid)
    briefs = await _patients_brief(ctx, pids)
    opens = await _open_sessions(ctx, pids)
    rows = []
    for pid, x in by_pid.items():
        avail = sum(b["available"] for b in x["bills"])
        rows.append({**briefs.get(pid, {"id": pid}), "bills": x["bills"][:5], "available_sessions": avail, "ip": x["ip"],
                     "open_session": opens.get(pid), "eligible": bool(avail or x["ip"] or opens.get(pid)),
                     "last_billed_at": max((b["billed_at"] or "" for b in x["bills"]), default=None)})
    rows.sort(key=lambda r: (not r.get("open_session"), not r["eligible"], r.get("name") or ""))
    total = len(rows)
    return {"rows": rows[:200], "total": total, "showing": min(total, 200)}


# ------------------------------------------------------------------ the patient's dialysis record

def _compatible(viral: str | None, segregation: str | None) -> tuple[bool, str | None]:
    seg = segregation or "General (non-reactive)"
    need = SEGREGATION.get(viral or "")
    if need:
        return seg == need, None if seg == need else f"{viral} patients need a {need} machine"
    if viral == "Non-reactive":
        return seg in ("General (non-reactive)", "Isolation / AKI"), None if seg in ("General (non-reactive)", "Isolation / AKI") \
            else f"{seg} machines are reserved for reactive patients"
    # awaiting report / not on file: isolation preferred, general allowed with a warning, never dedicated
    if seg in DEDICATED:
        return False, f"{seg} machines are reserved for reactive patients"
    return True, None if seg == "Isolation / AKI" else "Viral status not confirmed — prefer an isolation / AKI machine"


async def _plan(ctx, pid: str) -> dict | None:
    rows = await find(ctx, PLAN, patient_id=pid, status="Active", sort="-start_date", limit=1)
    return rows[0] if rows else None


@router.get("/desk/patients/{pid}")
async def desk_record(pid: str, ctx: CtxDep):
    _view(ctx)
    p = await _patients_brief(ctx, [pid]) if is_uuid(pid) else {}
    if not p:
        raise not_found("Patient not found")
    plan = await _plan(ctx, pid)
    ents = await _entitlements(ctx, patient_ids=[pid], days=120)
    adm = (await _admitted(ctx, patient_ids=[pid])).get(pid)
    sessions = await find(ctx, SES, patient_id=pid, sort="-scheduled_at", limit=12)
    refs: dict[str, str] = {}
    for s in sessions:
        refs.update(s.pop("_refs", None) or {})
    access = await find(ctx, "dialysis.vascular_access", patient_id=pid, limit=5)
    machines = []
    viral = (plan or {}).get("viral_status")
    for m in await find(ctx, MAC, limit=200, sort="title"):
        ok, why = _compatible(viral, m.get("segregation"))
        machines.append({k: m.get(k) for k in ("id", "code", "name", "station", "make", "model", "segregation", "status",
                                               "last_disinfection", "hdf_capable")} | {"compatible": ok, "warning": why})
    open_s = next((s for s in sessions if s.get("status") in OPEN), None)
    for s in sessions:
        s["machine_name"] = refs.get(s.get("machine") or "")
    return {
        "patient": p[pid], "plan": {k: v for k, v in (plan or {}).items() if not k.startswith("_")} or None,
        "access": [{k: a.get(k) for k in ("id", "code", "access_type", "site", "status", "thrill_bruit", "complication")} for a in access],
        "entitlements": ents, "available_sessions": sum(e["available"] for e in ents), "ip": adm,
        "open_session": open_s, "sessions": sessions, "machines": machines,
        "can_operate": ctx.role in DESK_ROLES or ctx.role == "admin",
    }


# ------------------------------------------------------------------ check-in → start → chart → check-out

class CheckInIn(BaseModel):
    patient_id: str
    charge_id: str | None = None
    modality: Literal["HD", "HDF", "SLED", "Isolated UF"] = "HD"
    pre_weight: float | None = Field(default=None, ge=2, le=300)
    pre_bp: str | None = Field(default=None, pattern=r"^\d{2,3}/\d{2,3}$")
    pre_pulse: int | None = Field(default=None, ge=20, le=250)
    pre_temperature: float | None = Field(default=None, ge=90, le=110)
    access_used: str | None = None
    notes: str | None = Field(default=None, max_length=1000)


@router.post("/desk/check-in", status_code=201)
async def check_in(body: CheckInIn, ctx: CtxDep):
    _desk(ctx)
    pid = body.patient_id
    if not is_uuid(pid):
        raise bad_request("Choose a patient")
    opens = await _open_sessions(ctx, [pid])
    if opens.get(pid):
        raise conflict(f"Session {opens[pid]['code']} is already open for this patient")
    plan = await _plan(ctx, pid)
    adm = (await _admitted(ctx, patient_ids=[pid])).get(pid)
    billing_ref, charge_id, encounter_id = None, None, None
    if body.charge_id:
        ent = next((e for e in await _entitlements(ctx, patient_ids=[pid], days=120) if e["charge_id"] == body.charge_id), None)
        if not ent:
            raise bad_request("That bill line is not a dialysis charge of this patient")
        if ent["available"] <= 0:
            raise conflict(f"Bill {ent['bill']} has no unused dialysis session")
        billing_ref, charge_id = f"OP bill {ent['bill']}", ent["charge_id"]
    elif adm:
        billing_ref, encounter_id = f"IP {adm['ip_no']}", adm["encounter_id"]
    else:
        avail = [e for e in await _entitlements(ctx, patient_ids=[pid], days=120) if e["available"] > 0]
        if not avail:
            raise conflict("Bill the dialysis session at the OP counter first (or admit the patient)")
        billing_ref, charge_id = f"OP bill {avail[-1]['bill']}", avail[-1]["charge_id"]
    if body.access_used and body.access_used not in (E(SES).field_map["access_used"].options or []):
        raise bad_request("Unknown vascular access type")
    s = await create(ctx, SES, {
        "patient_id": pid, "encounter_id": encounter_id, "plan": (plan or {}).get("id"), "modality": body.modality,
        "scheduled_at": now().isoformat(timespec="minutes"), "pre_weight": body.pre_weight, "pre_bp": body.pre_bp,
        "pre_pulse": body.pre_pulse, "pre_temperature": body.pre_temperature,
        "access_used": body.access_used or (plan or {}).get("vascular_access"), "notes": body.notes, "nurse": ctx.user.get("employee_id"),
        "billing_ref": billing_ref, "charge": charge_id, "prebilled": bool(charge_id), "status": "Scheduled",
        "blood_flow_rate": (plan or {}).get("blood_flow_rate"),
    })
    s = await transition(ctx, SES, s["id"], "Checked In", note=f"Checked in at the dialysis desk ({billing_ref})")
    return s


class StartIn(BaseModel):
    machine: str
    pre_weight: float | None = Field(default=None, ge=2, le=300)
    pre_bp: str | None = Field(default=None, pattern=r"^\d{2,3}/\d{2,3}$")
    uf_goal_ml: float | None = Field(default=None, ge=0, le=8000)
    blood_flow_rate: float | None = Field(default=None, ge=50, le=600)
    heparin_units: float | None = Field(default=None, ge=0, le=20000)
    dialyser_use_no: int | None = Field(default=None, ge=1, le=30)


async def _session(ctx, sid: str) -> dict:
    s = await get(ctx, SES, sid)
    if not s:
        raise not_found("Session not found")
    return s


@router.post("/desk/sessions/{sid}/start")
async def start(sid: str, body: StartIn, ctx: CtxDep):
    _desk(ctx)
    s = await _session(ctx, sid)
    if s.get("status") not in ("Scheduled", "Checked In"):
        raise conflict(f"Session is {s.get('status')}")
    vals = {k: v for k, v in body.model_dump().items() if v is not None}
    if not (vals.get("pre_weight") or s.get("pre_weight")):
        raise bad_request("Record the pre-dialysis weight", {"fields": {"pre_weight": "Required"}})
    s = await transition(ctx, SES, sid, "In Progress", values={k: vals[k] for k in ("machine", "pre_weight", "pre_bp", "uf_goal_ml") if k in vals})
    extra = {k: vals[k] for k in ("blood_flow_rate", "heparin_units", "dialyser_use_no") if k in vals}
    if extra:
        s = await update(ctx, SES, sid, extra)
    return s


class ChartIn(BaseModel):
    time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    bp: str | None = Field(default=None, pattern=r"^\d{2,3}/\d{2,3}$")
    pulse: int | None = Field(default=None, ge=20, le=250)
    qb: float | None = Field(default=None, ge=0, le=600)
    venous_pressure: float | None = Field(default=None, ge=-300, le=500)
    tmp: float | None = Field(default=None, ge=-200, le=600)
    uf_volume: float | None = Field(default=None, ge=0, le=10000)
    remarks: str | None = Field(default=None, max_length=200)


@router.post("/desk/sessions/{sid}/chart")
async def chart(sid: str, body: ChartIn, ctx: CtxDep):
    _desk(ctx)
    s = await _session(ctx, sid)
    if s.get("status") != "In Progress":
        raise conflict("Intradialytic observations are charted while the session is running")
    row = {k: v for k, v in body.model_dump().items() if v not in (None, "")}
    t = now()
    row.setdefault("time", f"{t.hour:02d}:{t.minute:02d}")
    if len(row) <= 1:
        raise bad_request("Enter at least one observation")
    return await update(ctx, SES, sid, {"hourly_chart": [*(s.get("hourly_chart") or []), row]})


EVENTS = ["None", "Hypotension", "Cramps", "Nausea / vomiting", "Headache", "Chest pain", "Fever / rigors", "Access bleed", "Circuit clotting",
          "Arrhythmia", "Hypoglycaemia"]


class CheckOutIn(BaseModel):
    post_weight: float = Field(ge=2, le=300)
    post_bp: str | None = Field(default=None, pattern=r"^\d{2,3}/\d{2,3}$")
    post_pulse: int | None = Field(default=None, ge=20, le=250)
    uf_achieved_ml: float | None = Field(default=None, ge=0, le=10000)
    duration_minutes: int | None = Field(default=None, ge=0, le=900)
    intradialytic_events: list[str] = Field(default_factory=list)
    complications: str | None = Field(default=None, max_length=1000)
    drugs_given: str | None = Field(default=None, max_length=300)
    ktv: float | None = Field(default=None, ge=0, le=4)
    notes: str | None = Field(default=None, max_length=1000)


@router.post("/desk/sessions/{sid}/check-out")
async def check_out(sid: str, body: CheckOutIn, ctx: CtxDep):
    _desk(ctx)
    s = await _session(ctx, sid)
    if s.get("status") != "In Progress":
        raise conflict("Only a running session can be checked out")
    bad = [e for e in body.intradialytic_events if e not in EVENTS]
    if bad:
        raise bad_request(f"Unknown events {bad}")
    if [e for e in body.intradialytic_events if e != "None"] and not (body.complications or "").strip():
        raise bad_request("Describe the complications and how they were managed", {"fields": {"complications": "Required"}})
    vals: dict[str, Any] = {"post_weight": body.post_weight, "post_bp": body.post_bp,
                            "intradialytic_events": body.intradialytic_events or ["None"]}
    uf = body.uf_achieved_ml
    if uf is None and s.get("pre_weight"):
        uf = max(0.0, round((float(s["pre_weight"]) - body.post_weight) * 1000))
    vals["uf_achieved_ml"] = uf
    s = await transition(ctx, SES, sid, "Completed", values=vals)
    started, ended = parse_dt(s.get("started_at")), parse_dt(s.get("ended_at"))
    extra = {"post_pulse": body.post_pulse, "complications": body.complications, "drugs_given": body.drugs_given, "ktv": body.ktv,
             "checked_out_at": s.get("ended_at"),
             "duration_minutes": body.duration_minutes if body.duration_minutes is not None else (
                 round((ended - started).total_seconds() / 60) if started and ended else None)}
    if body.notes:
        extra["notes"] = f"{s['notes']}\n{body.notes}" if s.get("notes") else body.notes
    return await update(ctx, SES, sid, {k: v for k, v in extra.items() if v is not None})


class CancelIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/desk/sessions/{sid}/cancel")
async def cancel(sid: str, body: CancelIn, ctx: CtxDep):
    _desk(ctx)
    s = await _session(ctx, sid)
    if s.get("status") not in OPEN:
        raise conflict(f"Session is {s.get('status')}")
    rec = await transition(ctx, SES, sid, "Cancelled", note=body.reason)
    return await update(ctx, SES, sid, {"notes": f"{rec['notes']}\nCancelled: {body.reason}" if rec.get("notes") else f"Cancelled: {body.reason}"})


@router.post("/desk/machines/{mid}/ready")
async def machine_ready(mid: str, ctx: CtxDep):
    """Disinfection finished — the machine is available again."""
    _desk(ctx)
    m = await get(ctx, MAC, mid)
    if not m:
        raise not_found("Machine not found")
    if m.get("status") not in ("Disinfection", "In Use"):
        raise conflict(f"{m.get('name')} is {m.get('status')}")
    busy = await find(ctx, SES, machine=mid, status="In Progress", limit=1)
    if busy:
        raise conflict(f"{m.get('name')} is running session {busy[0].get('code')}")
    return await update(ctx, MAC, mid, {"status": "Available", "last_disinfection": now().isoformat(timespec="minutes")})


@router.get("/desk/today")
async def today_board(ctx: CtxDep):
    """Today's sessions and machine states for the desk header."""
    _view(ctx)
    s0, s1 = day_bounds(today())
    sessions = [x for x in await find(ctx, SES, sort="-scheduled_at", limit=300,
                                       date_from=today().isoformat(), date_to=today().isoformat())]
    pats = await _patients_brief(ctx, list({x["patient_id"] for x in sessions}))
    refs: dict[str, str] = {}
    for x in sessions:
        refs.update(x.pop("_refs", None) or {})
    machines = await find(ctx, MAC, limit=200, sort="title")
    by_status: dict[str, int] = {}
    for x in sessions:
        by_status[x.get("status") or "—"] = by_status.get(x.get("status") or "—", 0) + 1
    return {"sessions": [{**{k: x.get(k) for k in ("id", "code", "status", "modality", "checked_in_at", "started_at", "ended_at", "billing_ref")},
                          "patient": pats.get(x["patient_id"]), "machine": refs.get(x.get("machine") or "")} for x in sessions],
            "by_status": by_status,
            "machines": [{k: m.get(k) for k in ("id", "code", "name", "station", "segregation", "status")} for m in machines],
            "window": [to_json_value(s0), to_json_value(s1)]}


# ------------------------------------------------------------------ rules on the session record (desk and generic screens)

@hook(SES, "before_transition")
async def _session_rules(ctx, nxt: dict, prev: dict):
    to, frm = nxt.get("status"), prev.get("status")
    if to == "In Progress":
        mid = nxt.get("machine")
        if not mid:
            raise bad_request("Choose the dialysis machine", {"fields": {"machine": "Required"}})
        m = await get(ctx, MAC, mid)
        if not m:
            raise not_found("Machine not found")
        if m.get("status") != "Available":
            raise conflict(f"{m.get('name')} is {m.get('status')} — choose an available machine")
        plan = await get(ctx, PLAN, nxt["plan"]) if nxt.get("plan") else await _plan(ctx, nxt["patient_id"])
        ok, why = _compatible((plan or {}).get("viral_status"), m.get("segregation"))
        if not ok:
            raise conflict(why or "Machine not allowed for this patient")
        if why:
            nxt["machine_warning"] = why
        await update(ctx, MAC, mid, {"status": "In Use"})
    if frm == "In Progress" and to in ("Completed", "Cancelled") and prev.get("machine"):
        m = await get(ctx, MAC, prev["machine"])
        if m and m.get("status") == "In Use":
            await update(ctx, MAC, m["id"], {"status": "Disinfection"})


@hook(SES, "after_transition")
async def _session_charge(ctx, rec: dict, prev: dict):
    """Per-session billing for sessions not billed in advance (admitted patients): charge at check-out."""
    if rec.get("status") != "Completed" or prev.get("status") == "Completed" or rec.get("prebilled") or rec.get("charge"):
        return
    from .billing import post_charge

    code = MODALITY_CODE.get(rec.get("modality") or "HD", "DIAL-HD")
    ch = await post_charge(ctx, patient_id=rec["patient_id"], encounter_id=rec.get("encounter_id"), service_code=code,
                           description=f"Haemodialysis session ({rec.get('modality') or 'HD'})", ref_code=rec.get("code"),
                           source=SES, source_id=rec["id"])
    await update(ctx, SES, rec["id"], {"charge": ch["id"], "billing_ref": rec.get("billing_ref") or "Charged at check-out"})


__all__ = ["router"]
