"""Emergency department suite.

* ER registration for known, new and unidentified patients. An unidentified patient gets a temporary
  patient record ("UHID not mapped"); "Link UHID" later merges it into the real patient through the MPI
  merge rules (registration.merge_requests → every visit, order, charge and note moves), audited.
* ER ward board (beds, occupancy, per-bed actions), the tracking board (KPIs, triage counts, filters)
  and the S-BAR handover sheet.
* The 9-step ER visit workflow — registration, triage (five colour levels with target clocks and
  re-triage history), nursing assessment, doctor assignment (least loaded first, with history), doctor
  assessment, orders / indents, treatment & reassessment, disposition (discharge, admit through the IPD
  admission rules, transfer, refer, LAMA / DAMA, death, absconded) and billing & closure.
* MLC flag with the MLC register, bed moves, clinical alerts, quick vitals and visit documents.

Phase-1 computed fields (door-to-doctor, time in ER, boarding) stay in clinical.py; this engine only
stamps workflow times and never recomputes them. Settings (optional steps, triage levels and targets,
board columns/actions, disposition rules) come from the ER settings store with DEFAULT_SETTINGS as the
fallback."""

from __future__ import annotations

import io
import math
from collections import defaultdict
from datetime import datetime, time, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit, hook
from ..core.security import CtxDep
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    day_bounds,
    is_uuid,
    minutes_between,
    not_found,
    now,
    parse_date,
    parse_dt,
    to_csv,
    to_json_value,
    today,
)
from ..schema import (
    beds,
    charges,
    employees,
    encounters,
    files,
    invoices,
    orders,
    patients,
    payments,
    records,
    services,
)
from ._common import E, create, find, first, get, has, transition, update

router = APIRouter(prefix="/api/er", tags=["er"])

VISIT, TRIAGE, NURSING, DOCTOR_A = "er.visits", "er.triage_scores", "er.nursing_assessments", "er.doctor_assessments"
TREAT, HANDOVER, MLC = "er.treatments", "er.handovers", "er.mlc_cases"
PFQN, MERGE, BED, ADM = "registration.patients", "registration.merge_requests", "ipd.beds", "ipd.admissions"
VITALS, ALLERGIES, INDENT, WARDS, DEPTS = "emr.vitals", "emr.allergies", "pharmacy.indents", "mdm.wards", "mdm.departments"
ROSTER, SHIFTS = "roster.rosters", "roster.shifts"

ACTIVE = ("Waiting", "In Treatment", "Observation")
DONE = ("Disposed", "Closed")
CLINICIANS = ("doctor", "nurse")
DESK = ("billing", "front_office")

STEPS: list[tuple[str, str]] = [
    ("registration", "ER Registration"), ("triage", "Triage"), ("nursing_assessment", "Nursing Assessment"),
    ("doctor_assignment", "Doctor Assignment"), ("doctor_assessment", "Doctor Assessment"), ("orders", "Orders / Indents"),
    ("treatment", "Treatment & Reassessment"), ("disposition", "Disposition"), ("billing", "Billing & Closure"),
]
STEP_LABEL = dict(STEPS)

OUTCOME = {
    "Discharged": "Discharged home", "Admitted": "Admitted to ward", "Transferred": "Transferred out", "Referred": "Referred",
    "LAMA": "Left against medical advice", "DAMA": "Discharged against medical advice", "Expired": "Expired in ER",
    "Brought dead": "Brought dead", "Absconded": "Absconded", "Shifted to OT": "Shifted to OT",
}
PAYER_TO_IP = {"Self-pay": "Cash", "Insurance": "Insurance", "Corporate": "Corporate", "Government scheme": "Government Scheme"}
PAYER_TO_BILL = {"Self-pay": "Self", "Insurance": "Insurance", "Corporate": "Corporate", "Government scheme": "Government Scheme"}
MLC_BROUGHT_BY = {"Police": "Police", "Relatives": "Relatives", "108 ambulance": "108 ambulance", "Good Samaritan": "Good Samaritan",
                  "Self": "Self"}
O2_TO_EMR = {"Ventilator / BVM": "Ventilator"}
LEGACY_TRIAGE = {"blue (non-urgent)": "green"}

DEFAULT_SETTINGS: dict[str, Any] = {
    "flow": {
        "optional_steps": ["orders", "treatment"],
        "auto_assign_doctor": True,
        "doctor_departments": ["EMED", "GMED"],
        "los_target_minutes": 240,
        "carry_charges_to_admission": True,
        "auto_close_on_admission": True,
        "observation_charge_code": "ER-OBS",
        "observation_block_hours": 6,
        "specialist_visit_charge_code": "CONS-IPD-VISIT",
    },
    "triage": {
        "system": "5-level colour (MTS-based)",
        "levels": [
            {"key": "red", "value": "Red (Immediate)", "label": "Red — Immediate", "priority": "P1", "target_minutes": 0,
             "color": "red", "enabled": True},
            {"key": "orange", "value": "Orange (Very urgent)", "label": "Orange — Very urgent", "priority": "P2", "target_minutes": 10,
             "color": "orange", "enabled": True},
            {"key": "yellow", "value": "Yellow (Urgent)", "label": "Yellow — Urgent", "priority": "P3", "target_minutes": 60,
             "color": "yellow", "enabled": True},
            {"key": "green", "value": "Green (Standard)", "label": "Green — Non-urgent", "priority": "P4", "target_minutes": 120,
             "color": "green", "enabled": True},
            {"key": "black", "value": "Black (Brought dead / expectant)", "label": "Black — Brought dead / expectant",
             "priority": None, "target_minutes": None, "color": "black", "enabled": True},
        ],
    },
    "board": {
        "refresh_seconds": 60,
        "actions": ["assessment", "discharge_summary", "lab_reports", "pacs", "admission_notes", "add_details", "order_medicine",
                    "investigations", "patient_movement", "doctor_visit", "initial_assessment", "documents"],
        "columns": ["sno", "bed", "er_no", "bill_no", "patient", "age_sex", "arrived", "time_in_er", "triage", "doctor",
                    "current_step", "mlc", "status"],
    },
    "registration": {
        "default_arrival_mode": "Walk-in",
        "default_payer": "Self-pay",
        "mlc_arrival_modes": ["Police"],
        "require_bed": False,
    },
    "disposition": {
        "types": {
            "Discharged": {"enabled": True, "required": ["condition_at_disposition", "disposition_notes"]},
            "Admitted": {"enabled": True, "required": []},
            "Transferred": {"enabled": True, "required": ["referred_to", "transfer_reason", "transport_mode", "condition_at_disposition"]},
            "Referred": {"enabled": True, "required": ["referred_to", "transfer_reason"]},
            "LAMA": {"enabled": True, "required": ["lama_reason", "consent_by", "risks_explained"]},
            "DAMA": {"enabled": True, "required": ["lama_reason", "consent_by", "risks_explained"]},
            "Expired": {"enabled": True, "required": ["time_of_death", "cause_of_death"]},
            "Brought dead": {"enabled": True, "required": ["time_of_death"]},
            "Absconded": {"enabled": True, "required": ["absconded_noticed_at", "security_informed"]},
            "Shifted to OT": {"enabled": True, "required": ["disposition_notes"]},
        },
    },
    "documents": {"categories": ["Uncategorised", "Referral letter", "Previous records", "Investigation report", "Consent form",
                                 "MLC / police papers", "ID proof", "Insurance / scheme", "Clinical photo", "Other"]},
    "alerts": ["Violent / aggressive", "Suicide risk", "Isolation — airborne", "Isolation — droplet", "Isolation — contact",
               "Pregnant", "DNR / limitation of treatment", "High fall risk", "Language / hearing barrier", "Police custody", "VIP"],
    "handover": {"shifts": [{"key": "Morning", "start": "08:00"}, {"key": "Evening", "start": "14:00"}, {"key": "Night", "start": "20:00"}]},
}

# ================================================================== helpers

ER_PAGES = ("er-board", "er-tracking", "er-register", "er-billing")


def _levels(ctx) -> tuple[str, dict[str, str]]:
    """Roles & permissions matrix levels for ER visits and the ER workspaces (none · view · edit)."""
    cached = ctx.__dict__.get("_er_levels")
    if cached is not None:
        return cached
    try:
        from ..core.permissions import entity_level, page_level
    except ImportError:  # matrix not installed: role lists on the definitions decide
        lv = "edit" if ctx.role in ("admin", *CLINICIANS, "front_office") else "view" if ctx.role in ("management", "quality") else "none"
        out = (lv, {p: lv for p in ER_PAGES})
    else:
        out = (entity_level(ctx.user, E(VISIT)), {p: page_level(ctx.user, "er", p) for p in ER_PAGES})
    ctx.__dict__["_er_levels"] = out
    return out


def role_perms(ctx) -> dict:
    """What this user may do in the ER suite — the matrix level AND the clinical role must allow it.
    The web renders only these features; every endpoint checks the same flags."""
    r = ctx.role
    adm = r == "admin"
    vlevel, pages = _levels(ctx)
    read, edit = vlevel in ("view", "edit"), vlevel == "edit"
    clin = edit and (adm or r in CLINICIANS)
    desk_role = adm or r in DESK
    staff = edit and (adm or r in (*CLINICIANS, "front_office"))
    bill = desk_role and pages["er-billing"] == "edit"
    return {
        "read": read, "board": read and pages["er-board"] != "none", "tracking": read and pages["er-tracking"] != "none",
        "register": staff and pages["er-register"] == "edit",
        "view_clinical": read and (adm or r in (*CLINICIANS, "management", "quality")),
        "view_billing": desk_role and pages["er-billing"] != "none",
        "triage": clin, "nursing": clin, "doctor": edit and (adm or r == "doctor"), "assign": clin, "orders": clin, "treatment": clin,
        "vitals": clin, "status": clin, "dispose": edit and (adm or r == "doctor"), "abscond": clin, "mlc": clin, "alerts": clin,
        "handover": clin, "move_bed": staff, "details": staff, "link": staff, "documents": staff,
        "bill": bill, "close": bill, "override_close": bill and (adm or r == "billing"), "settings": adm,
    }


_DENIED = {
    "read": "ER visits are not available to your role", "view_clinical": "Clinical details of ER visits are not available to your role",
    "view_billing": "ER billing is not available to your role", "board": "The ER ward board is not available to your role",
    "tracking": "The ER tracking board is not available to your role", "register": "ER registration is not available to your role",
}


def _need(ctx, perm: str) -> None:
    if not role_perms(ctx).get(perm):
        raise ApiError(403, _DENIED.get(perm, "Your role cannot perform this action in the ER"))


def _need_clinical(ctx) -> None:
    _need(ctx, "view_clinical")


def _stamp() -> str:
    return now().isoformat(timespec="seconds")


def _name(first_name: str | None, last_name: str | None) -> str:
    return " ".join(x for x in (first_name, last_name) if x) or "—"


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def _iso(v: Any) -> str | None:
    return to_json_value(v) if v is not None else None


def _earliest(*vals: Any) -> str | None:
    xs = [str(x) for x in vals if x]
    return min(xs, key=lambda s: parse_dt(s)) if xs else None


def _label(fqn: str, key: str) -> str:
    f = E(fqn).field_map.get(key)
    return f.label if f else key


async def er_settings(ctx) -> dict:
    """ER settings (namespace `er` in the settings store, edited from the ER settings screen) deep-merged over
    DEFAULT_SETTINGS, cached per request."""
    cached = ctx.__dict__.get("_er_settings")
    if cached is not None:
        return cached
    from ..core.config_store import get_settings

    stored = await get_settings(ctx, "er")
    cfg = _merge(DEFAULT_SETTINGS, stored if isinstance(stored, dict) else {})
    ctx.__dict__["_er_settings"] = cfg
    return cfg


def triage_info(cfg: dict, value: str | None) -> dict | None:
    """Triage level by stored value, key or label (legacy values map onto the current scheme)."""
    if not value:
        return None
    s = str(value).strip().lower()
    key = LEGACY_TRIAGE.get(s)
    for lv in cfg["triage"]["levels"]:
        if key == lv["key"] or s in (lv["key"], str(lv.get("value", "")).lower(), str(lv.get("label", "")).lower()):
            return lv
    return None


def _triage_brief(lv: dict | None) -> dict | None:
    if not lv:
        return None
    label = f"{lv['label']} ({lv['priority']})" if lv.get("priority") else lv["label"]
    return {"key": lv["key"], "value": lv["value"], "label": label, "priority": lv.get("priority"), "color": lv.get("color"),
            "target_minutes": lv.get("target_minutes")}


def state_of(v: dict) -> str:
    """Active · Awaiting billing · Closed. Visits disposed before closure existed (no disposed_at) count as closed."""
    st = v.get("status")
    if st in ACTIVE:
        return "Active"
    if st == "Closed" or (st == "Disposed" and not v.get("disposed_at")):
        return "Closed"
    return "Awaiting billing"


def _clock(started: datetime | None, seen: Any, target: int | None, ts: datetime) -> dict:
    """Time-to-doctor against the triage target."""
    if target is None or started is None:
        return {"state": "none", "target_minutes": target}
    due = started + timedelta(minutes=target)
    if seen:
        wait = minutes_between(started, seen) or 0
        return {"state": "met" if wait <= target else "missed", "wait_minutes": max(0, wait), "target_minutes": target, "due_at": _iso(due)}
    wait = minutes_between(started, ts) or 0
    state = "breached" if wait > target else "near" if wait >= 0.75 * target else "ok"
    return {"state": state, "wait_minutes": max(0, wait), "target_minutes": target, "due_at": _iso(due)}


def steps_of(v: dict, facts: dict, cfg: dict) -> dict:
    """The 9-step tracker. Steps may finish out of order; `current` is the first pending required step."""
    def fact(k: str) -> str | None:
        return _iso((facts.get(k) or (None, 0))[0])

    st, state = v.get("status"), state_of(v)
    ended = v.get("disposed_at") or v.get("ended_at") or v.get("started_at")
    done = {
        "registration": v.get("started_at"),
        "triage": v.get("triaged_at") or fact("triage_scores") or (v.get("started_at") if v.get("triage_level") else None),
        "nursing_assessment": v.get("nursing_assessed_at") or fact("nursing_assessments"),
        "doctor_assignment": v.get("doctor_assigned_at") or (v.get("started_at") if v.get("doctor_id") else None),
        "doctor_assessment": v.get("doctor_assessed_at") or fact("doctor_assessments") or v.get("doctor_seen_at"),
        "orders": _earliest(fact("orders"), fact("indents")),
        "treatment": fact("treatments"),
        "disposition": ended if st in DONE else None,
        "billing": v.get("closed_at") or (ended if state == "Closed" else None),
    }
    optional = set(cfg["flow"].get("optional_steps") or [])
    current = None
    if state == "Awaiting billing":
        current = "billing"
    elif state == "Active":
        current = next((k for k, _ in STEPS if not done.get(k) and k not in optional), None)
    out = [{"key": k, "label": label, "done_at": done.get(k), "optional": k in optional, "current": k == current} for k, label in STEPS]
    if state == "Closed":
        cur_label = OUTCOME.get(v.get("disposition") or "", "Closed")
    else:
        cur_label = STEP_LABEL.get(current or "", "—")
    return {"steps": out, "done": sum(1 for s in out if s["done_at"]), "total": len(out), "current": current, "current_label": cur_label}


async def _step_facts(ctx, ids: list[str]) -> dict[str, dict]:
    """First time each workflow artefact was recorded for these visits (3 grouped queries)."""
    facts: dict[str, dict] = defaultdict(dict)
    if not ids:
        return facts
    r, o = records, orders
    rows = (await ctx.conn.execute(
        sa.select(r.c.entity, r.c.encounter_id, sa.func.min(r.c.created_at), sa.func.count())
        .where(r.c.module == "er", r.c.entity.in_(["triage_scores", "nursing_assessments", "doctor_assessments", "treatments"]),
               r.c.encounter_id.in_(ids), r.c.deleted_at.is_(None))
        .group_by(r.c.entity, r.c.encounter_id))).all()
    for ent, eid, at, n in rows:
        facts[str(eid)][ent] = (at, n)
    for eid, at, n in (await ctx.conn.execute(
            sa.select(o.c.encounter_id, sa.func.min(o.c.ordered_at), sa.func.count())
            .where(o.c.encounter_id.in_(ids), o.c.deleted_at.is_(None), o.c.status != "Cancelled").group_by(o.c.encounter_id))).all():
        facts[str(eid)]["orders"] = (at, n)
    ev = r.c.data["er_visit"].astext
    for eid, at, n in (await ctx.conn.execute(
            sa.select(ev, sa.func.min(r.c.created_at), sa.func.count())
            .where(r.c.module == "pharmacy", r.c.entity == "indents", ev.in_(ids), r.c.deleted_at.is_(None),
                   r.c.status != "Cancelled").group_by(ev))).all():
        facts[str(eid)]["indents"] = (at, n)
    return facts


async def _bills(ctx, ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    i = invoices
    rows = (await ctx.conn.execute(
        sa.select(i.c.id, i.c.code, i.c.status, i.c.net, i.c.balance, i.c.encounter_id)
        .where(i.c.encounter_id.in_(ids), i.c.deleted_at.is_(None), i.c.status != "Cancelled").order_by(i.c.billed_at.asc()))).all()
    return {str(r.encounter_id): {"id": str(r.id), "code": r.code, "status": r.status, "net": _iso(r.net), "balance": _iso(r.balance)}
            for r in rows}


def _visit_query():
    e, p, d, b = encounters, patients, employees, beds
    w = records.alias("w")
    return (sa.select(e.c.id, e.c.code, e.c.status, e.c.patient_id, e.c.doctor_id, e.c.bed_id, e.c.started_at, e.c.ended_at, e.c.data,
                      p.c.code.label("uhid"), p.c.first_name, p.c.last_name, p.c.gender, p.c.dob, p.c.phone, p.c.data.label("pdata"),
                      d.c.name.label("doctor"), b.c.bed_no, b.c.ward_id, w.c.title.label("ward"))
            .select_from(e.join(p, p.c.id == e.c.patient_id).outerjoin(d, d.c.id == e.c.doctor_id)
                         .outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id))
            .where(e.c.type == "ER", e.c.deleted_at.is_(None)))


def _row_visit(r) -> dict:
    v = dict(r.data or {})
    v.update(id=str(r.id), code=r.code, status=r.status, patient_id=str(r.patient_id),
             doctor_id=str(r.doctor_id) if r.doctor_id else None, bed_id=str(r.bed_id) if r.bed_id else None,
             started_at=_iso(r.started_at), ended_at=_iso(r.ended_at))
    return v


def _summary(r, facts: dict, cfg: dict, ts: datetime, bill: dict | None = None, flags: list[str] | None = None) -> dict:
    v = _row_visit(r)
    pd = r.pdata or {}
    lv = triage_info(cfg, v.get("triage_level"))
    state = state_of(v)
    started = r.started_at.astimezone(settings.tz) if r.started_at else None
    if state == "Active":
        mins = minutes_between(started, ts) if started else None
    else:
        mins = v.get("er_los_minutes")
        if mins is None and started:
            mins = minutes_between(started, v.get("disposed_at") or v.get("ended_at") or ts)
    mins = max(0, mins) if mins is not None else None
    los_target = int(cfg["flow"].get("los_target_minutes") or 240)
    los_state = "done" if state != "Active" else ("breached" if (mins or 0) >= los_target else "near" if (mins or 0) >= 0.75 * los_target else "ok")
    seen = v.get("doctor_assessed_at") or v.get("doctor_seen_at")
    clock = _clock(started, seen, lv.get("target_minutes") if lv else None, ts)
    steps = steps_of(v, facts, cfg)
    temporary = bool(pd.get("er_temporary"))
    fl = list(flags or [])
    if v.get("mlc"):
        fl.append("mlc")
    if temporary:
        fl.append("unmapped")
    if state == "Active" and clock["state"] == "breached":
        fl.append("breach")
    return {
        "id": v["id"], "code": v["code"], "status": v["status"], "state": state,
        "arrived_at": v.get("started_at"), "minutes_in_er": mins, "los_state": los_state, "los_target_minutes": los_target,
        "patient": {"id": v["patient_id"], "name": _name(r.first_name, r.last_name), "uhid": r.uhid, "age": age_from(r.dob),
                    "gender": r.gender, "phone": r.phone, "temporary": temporary},
        "bed": {"id": v["bed_id"], "bed_no": r.bed_no, "ward_id": str(r.ward_id) if r.ward_id else None, "ward": r.ward} if v.get("bed_id") else None,
        "doctor": {"id": v["doctor_id"], "name": r.doctor} if v.get("doctor_id") else None,
        "triage": _triage_brief(lv), "triaged_at": v.get("triaged_at"), "triage_clock": clock,
        "chief_complaint": v.get("chief_complaint"), "arrival_mode": v.get("arrival_mode"), "payer": v.get("payer") or "Self-pay",
        "mlc": bool(v.get("mlc")), "mlc_no": v.get("mlc_no"), "disposition": v.get("disposition"),
        "outcome": OUTCOME.get(v.get("disposition") or ""), "provisional_diagnosis": v.get("provisional_diagnosis"),
        "current_step": {"key": steps["current"], "label": steps["current_label"]},
        "progress": {"done": steps["done"], "total": steps["total"]},
        "bill": bill, "flags": fl, "alerts": v.get("alerts") or [],
    }


async def _flags(ctx, pids: list[str], pdata: dict[str, dict]) -> dict[str, list[str]]:
    from .adt import _board_flags

    crit, allergies, _ = await _board_flags(ctx, pids, [])
    out: dict[str, list[str]] = {}
    for pid in pids:
        f = []
        if allergies.get(pid) or (pdata.get(pid) or {}).get("allergies"):
            f.append("allergy")
        if crit.get(pid):
            f.append("critical")
        out[pid] = f
    return out


async def _summaries(ctx, rows, cfg: dict, ts: datetime, *, with_flags: bool = False) -> list[dict]:
    ids = [str(r.id) for r in rows]
    facts = await _step_facts(ctx, ids)
    bills = await _bills(ctx, ids)
    flags: dict[str, list[str]] = {}
    if with_flags and rows:
        flags = await _flags(ctx, list({str(r.patient_id) for r in rows}), {str(r.patient_id): r.pdata or {} for r in rows})
    return [_summary(r, facts.get(str(r.id), {}), cfg, ts, bills.get(str(r.id)), flags.get(str(r.patient_id))) for r in rows]


async def _visit(ctx, vid: str) -> dict:
    v = await get(ctx, VISIT, vid)
    if not v:
        raise not_found("ER visit not found")
    return v


def _active_only(v: dict, what: str = "This") -> None:
    if v.get("status") not in ACTIVE:
        raise conflict(f"{what} is not possible — the ER visit is {state_of(v).lower()}")


async def _patient(ctx, pid: str | None) -> dict:
    if not pid or not is_uuid(pid):
        raise bad_request("Choose a patient", {"fields": {"patient_id": "Required"}})
    row = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid, patients.c.deleted_at.is_(None)))).first()
    if not row:
        raise not_found("Patient not found")
    return rs.to_record(row)


async def _active_visit_for(ctx, pid: str, exclude: str | None = None):
    e = encounters
    conds = [e.c.patient_id == pid, e.c.type == "ER", e.c.status.in_(ACTIVE), e.c.deleted_at.is_(None)]
    if exclude:
        conds.append(e.c.id != exclude)
    return (await ctx.conn.execute(sa.select(e.c.id, e.c.code).where(*conds).limit(1))).first()


async def _er_wards(ctx) -> list[dict]:
    ent = E(WARDS)
    t = ent.table
    er_ward_ids = [str(x) for (x,) in (await ctx.conn.execute(
        sa.select(beds.c.ward_id).where(beds.c.category == "ER", beds.c.deleted_at.is_(None)).distinct())).all() if x]
    cond = t.c.data["ward_type"].astext == "Emergency"
    if er_ward_ids:
        cond = sa.or_(cond, t.c.id.in_(er_ward_ids))
    rows = (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.title).where(*rs.base_where(ent), cond).order_by(t.c.code))).all()
    return [{"id": str(r.id), "code": r.code, "name": r.title or r.code} for r in rows]


async def _er_department(ctx) -> str | None:
    if not has(DEPTS):
        return None
    ent = E(DEPTS)
    row = (await ctx.conn.execute(sa.select(ent.table.c.id).where(*rs.base_where(ent), ent.table.c.code == "EMED").limit(1))).first()
    return str(row.id) if row else None


async def _er_bed(ctx, bed_id: str, wards: list[dict]) -> dict:
    b = await get(ctx, BED, bed_id) if is_uuid(bed_id) else None
    if not b:
        raise not_found("Bed not found")
    if b.get("category") != "ER" and b.get("ward_id") not in {w["id"] for w in wards}:
        raise bad_request("Choose a bed in an emergency ward", {"fields": {"bed_id": "Not an ER bed"}})
    if b.get("status") != "Vacant":
        raise ApiError(409, f"Bed {b.get('bed_no')} is {str(b.get('status')).lower()} — choose a vacant bed", {"fields": {"bed_id": "Not vacant"}})
    return b


async def _occupy(ctx, bed_id: str, visit: dict) -> None:
    await update(ctx, BED, bed_id, {"status": "Occupied", "current_patient": visit["patient_id"], "current_encounter": visit["id"],
                                    "status_since": _stamp()})


async def _release_bed(ctx, visit: dict, reason: str, bed_id: str | None = None) -> None:
    """Patient left the ER bed: bed → Cleaning with a housekeeping turnaround request (IPD rules)."""
    bid = bed_id or visit.get("bed_id")
    if not bid:
        return
    from .adt import _vacate

    await _vacate(ctx, {"id": visit["id"], "code": visit.get("code"), "bed_id": bid, "isolation": None}, reason=reason, bed_id=bid)


async def _employee(ctx, eid: str | None, *, doctor: bool = False) -> dict:
    row = (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name, employees.c.category, employees.c.status,
                                            employees.c.department_id).where(employees.c.id == eid, employees.c.deleted_at.is_(None)))).first() \
        if eid and is_uuid(eid) else None
    if not row:
        raise not_found("Staff member not found")
    if doctor and row.category != "Doctor":
        raise bad_request(f"{row.name} is not a doctor")
    if row.status not in (None, "Active"):
        raise conflict(f"{row.name} is not active ({row.status})")
    return {"id": str(row.id), "name": row.name, "department_id": str(row.department_id) if row.department_id else None}


def _dob_from_age(years: int) -> str:
    d = today()
    try:
        return d.replace(year=d.year - years).isoformat()
    except ValueError:  # 29 Feb
        return d.replace(year=d.year - years, day=28).isoformat()


def _vitals_line(d: dict) -> str | None:
    parts = []
    if d.get("bp_systolic"):
        parts.append(f"BP {d['bp_systolic']:g}" + (f"/{d['bp_diastolic']:g}" if d.get("bp_diastolic") else ""))
    for key, label, unit in (("pulse", "HR", ""), ("resp_rate", "RR", ""), ("spo2", "SpO2", "%"), ("temperature", "T", "°F"),
                             ("gcs", "GCS", ""), ("pain_score", "pain", "/10"), ("rbs", "RBS", ""), ("grbs", "GRBS", "")):
        if d.get(key) is not None:
            parts.append(f"{label} {d[key]:g}{unit}")
    return ", ".join(parts) or None


def _merge_refs(*groups) -> dict:
    refs: dict = {}
    for rows in groups:
        for r in rows or []:
            if r:
                refs.update(r.pop("_refs", None) or {})
    return refs


# ================================================================== hooks

@hook(VISIT, "before_create")
async def _visit_defaults(ctx, draft: dict) -> None:
    if draft.get("doctor_id") and not draft.get("doctor_assigned_at"):
        draft["doctor_assigned_at"] = draft.get("started_at") or _stamp()
    draft.setdefault("uhid_mapped", True)


@hook(VISIT, "before_transition")
async def _visit_stamps(ctx, nxt: dict, prev: dict) -> None:
    to = nxt["status"]
    if prev.get("status") == "Observation" and to != "Observation" and prev.get("observation_started_at"):
        spent = minutes_between(prev["observation_started_at"], now()) or 0
        nxt["observation_minutes"] = (prev.get("observation_minutes") or 0) + max(0, spent)
    if to == "Disposed":
        nxt["ended_at"] = nxt.get("ended_at") or nxt.get("disposed_at") or _stamp()
    elif to == "Closed":
        nxt["closed_by"] = ctx.user.get("name")


@hook(VISIT, "after_transition")
async def _visit_after(ctx, rec: dict, prev: dict) -> None:
    if rec["status"] == "Disposed" and prev.get("status") != "Disposed":
        await _release_bed(ctx, rec, reason=f"ER disposition ({rec.get('disposition') or '—'})")
        await _observation_charge(ctx, rec)


@hook("billing.charges", "before_create")
async def _charge_to_er_visit(ctx, draft: dict) -> None:
    """Charges posted without a visit (ER consult, ward indents, manual services) attach to the patient's active ER visit."""
    pid = draft.get("patient_id")
    if draft.get("encounter_id") or not pid or not is_uuid(pid):
        return
    e = encounters
    row = (await ctx.conn.execute(sa.select(e.c.id).where(
        e.c.patient_id == pid, e.c.type == "ER", e.c.status.in_(ACTIVE), e.c.deleted_at.is_(None))
        .order_by(e.c.started_at.desc().nulls_last()).limit(1))).first()
    if row:
        draft["encounter_id"] = str(row.id)


async def _observation_charge(ctx, v: dict) -> None:
    cfg = await er_settings(ctx)
    code = cfg["flow"].get("observation_charge_code")
    if not code or v.get("observation_minutes") is None:  # never in observation
        return
    spent = v.get("observation_minutes") or 0
    exists = (await ctx.conn.execute(sa.select(charges.c.id).where(
        charges.c.source == "er.observation", charges.c.source_id == v["id"], charges.c.deleted_at.is_(None)).limit(1))).first()
    if exists:
        return
    block = max(1, int(cfg["flow"].get("observation_block_hours") or 6))
    units = max(1, math.ceil(spent / 60 / block))
    from .billing import post_charge

    await post_charge(ctx, patient_id=v["patient_id"], encounter_id=v["id"], service_code=code, qty=units,
                      description=f"ER observation — {units} × {block} h", source="er.observation", source_id=v["id"],
                      ref_code=v.get("code"))


# ================================================================== settings & reference data

@router.get("/settings/defaults")
async def settings_defaults(ctx: CtxDep):
    if not (role_perms(ctx)["read"] or role_perms(ctx)["view_billing"]):
        _need(ctx, "read")
    return DEFAULT_SETTINGS


@router.get("/settings/effective")
async def settings_effective(ctx: CtxDep):
    if not (role_perms(ctx)["read"] or role_perms(ctx)["view_billing"]):
        _need(ctx, "read")
    return await er_settings(ctx)


# ================================================================== doctors (least loaded first)

async def _on_duty(ctx, dept_ids: list[str], ward_ids: list[str]) -> set[str] | None:
    """Doctors rostered in the ER right now; None when the ER has no roster for today."""
    if not has(ROSTER) or not (dept_ids or ward_ids):
        return None
    ent = E(ROSTER)
    t = ent.table
    d0 = today()
    rows = (await ctx.conn.execute(sa.select(t.c.employee_id, t.c.data).where(
        *rs.base_where(ent), t.c.status.in_(["Planned", "Published", "Swapped"]),
        t.c.data["roster_date"].astext.in_([d0.isoformat(), (d0 - timedelta(days=1)).isoformat()]),
        sa.or_(t.c.data["department"].astext.in_(dept_ids or ["-"]), t.c.data["ward"].astext.in_(ward_ids or ["-"]))))).all()
    if not rows:
        return None
    shift_ids = list({(r.data or {}).get("shift") for r in rows if (r.data or {}).get("shift")})
    shifts = {s["id"]: s for s in await find(ctx, SHIFTS, limit=100)} if shift_ids else {}
    ts, on = now(), set()
    for r in rows:
        d = r.data or {}
        sh = shifts.get(d.get("shift") or "")
        if not sh or not r.employee_id:
            continue
        try:
            day = parse_date(d["roster_date"])
            start = datetime.combine(day, time.fromisoformat(sh["start_time"]), settings.tz)
            end = datetime.combine(day, time.fromisoformat(sh["end_time"]), settings.tz)
        except (KeyError, TypeError, ValueError):
            continue
        if end <= start:
            end += timedelta(days=1)
        if start <= ts < end:
            on.add(str(r.employee_id))
    return on


async def _loads(ctx) -> dict[str, int]:
    e = encounters
    return {str(d): n for d, n in (await ctx.conn.execute(sa.select(e.c.doctor_id, sa.func.count()).where(
        e.c.type == "ER", e.c.status.in_(ACTIVE), e.c.deleted_at.is_(None), e.c.doctor_id.isnot(None)).group_by(e.c.doctor_id))).all()}


async def doctor_pool(ctx, cfg: dict, include: str | None = None) -> list[dict]:
    codes = cfg["flow"].get("doctor_departments") or ["EMED"]
    dent = E(DEPTS)
    dt = dent.table
    depts = {str(i): (c, t) for i, c, t in (await ctx.conn.execute(
        sa.select(dt.c.id, dt.c.code, dt.c.title).where(*rs.base_where(dent)))).all()}
    pool_depts = [i for i, (c, _) in depts.items() if c in codes]
    wards = [w["id"] for w in await _er_wards(ctx)]
    rostered = await _on_duty(ctx, pool_depts, wards)
    d = employees
    conds = [d.c.category == "Doctor", d.c.deleted_at.is_(None), sa.func.coalesce(d.c.status, "Active") == "Active"]
    who = [d.c.department_id.in_(pool_depts or ["00000000-0000-0000-0000-000000000000"])]
    if rostered:
        who.append(d.c.id.in_(list(rostered)))
    if include and is_uuid(include):
        who.append(d.c.id == include)
    rows = (await ctx.conn.execute(sa.select(d.c.id, d.c.name, d.c.designation, d.c.department_id).where(*conds, sa.or_(*who)))).all()
    loads = await _loads(ctx)
    er_code = codes[0] if codes else "EMED"
    out = []
    for r in rows:
        did = str(r.id)
        code, dname = depts.get(str(r.department_id), (None, None))
        on_duty = (did in rostered) if rostered is not None else None
        primary = on_duty if rostered is not None else code == er_code
        out.append({"id": did, "name": r.name, "designation": r.designation, "department": dname, "department_code": code,
                    "active": loads.get(did, 0), "on_duty": on_duty, "primary": bool(primary)})
    out.sort(key=lambda x: (x["active"], not x["primary"], x["name"] or ""))
    return out


def _pick(pool: list[dict]) -> dict | None:
    prim = [d for d in pool if d["primary"]]
    return (prim or pool or [None])[0]


@router.get("/doctors")
async def doctors(ctx: CtxDep):
    _need(ctx, "read")
    cfg = await er_settings(ctx)
    pool = await doctor_pool(ctx, cfg)
    return {"doctors": pool, "suggested": (_pick(pool) or {}).get("id"), "roster_based": any(d["on_duty"] is not None for d in pool)}


# ================================================================== registration

class UnknownIn(BaseModel):
    gender: str = "Other"
    approx_age: int | None = Field(default=None, ge=0, le=120)
    identification_marks: str | None = Field(default=None, max_length=1000)
    found_at: str | None = Field(default=None, max_length=300)


class NewPatientIn(BaseModel):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    gender: str
    dob: str | None = None
    age_years: int | None = Field(default=None, ge=0, le=120)
    phone: str = Field(min_length=10, max_length=15)
    address: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=100)
    force: bool = False


class RegisterIn(BaseModel):
    mode: Literal["existing", "new", "unidentified"]
    patient_id: str | None = None
    patient: NewPatientIn | None = None
    unknown: UnknownIn | None = None
    arrival_mode: str = "Walk-in"
    arrived_at: str | None = None
    chief_complaint: str = Field(min_length=2, max_length=500)
    brought_by_type: str | None = None
    brought_by: str | None = Field(default=None, max_length=200)
    attendant_phone: str | None = None
    police_station: str | None = Field(default=None, max_length=200)
    police_officer: str | None = Field(default=None, max_length=200)
    payer: str = "Self-pay"
    bed_id: str | None = None
    doctor_id: str | None = None
    auto_assign: bool = True
    triage_level: str | None = None
    mlc: bool = False
    mlc_no: str | None = Field(default=None, max_length=60)
    mlc_case_type: str | None = None


def _gender(value: str | None) -> str:
    opts = E(PFQN).field_map["gender"].options or ["Male", "Female", "Other"]
    v = (value or "").strip().title()
    if v not in opts:
        raise bad_request(f"Gender: choose one of {', '.join(opts)}", {"fields": {"gender": "Invalid"}})
    return v


async def _temp_patient(ctx, u: UnknownIn) -> dict:
    """Temporary MPI record for an unidentified patient — system generated, so the registration
    form's required identity fields (mobile, name) are not enforced; linked or completed later."""
    ent = E(PFQN)
    g = _gender(u.gender)
    word = {"Male": "male", "Female": "female"}.get(g, "person")
    payload = {"first_name": "Unknown", "last_name": f"{word} ~{u.approx_age}y" if u.approx_age is not None else word, "gender": g,
               "category": "General"}
    if u.approx_age is not None:
        payload["dob"] = _dob_from_age(u.approx_age)
    draft = rs.validate(ctx, ent, payload, partial=True, trusted=True)
    draft.update(status="Active", er_temporary=True, dob_estimated=u.approx_age is not None, registered_via="ER — unidentified",
                 identification_marks=u.identification_marks, found_at=u.found_at)
    rec = await rs._insert(ctx, ent, draft)
    await audit(ctx, "create", module="registration", entity="patients", record=rec, after=rec,
                note="Temporary record for an unidentified ER patient (UHID not mapped)")
    rs._notify(ctx, ent, rec, "created")
    return rec


async def _register_patient(ctx, np: NewPatientIn) -> dict:
    from .patients import DupIn, find_duplicates

    dob = np.dob or (_dob_from_age(np.age_years) if np.age_years is not None else None)
    if not np.force:
        dups = [d for d in await find_duplicates(ctx, DupIn(first_name=np.first_name, last_name=np.last_name, phone=np.phone, dob=dob))
                if d["score"] >= 55]
        if dups:
            raise ApiError(409, "Possible duplicate patient — pick the existing UHID or confirm a new registration",
                           {"duplicates": dups}, code="DUPLICATE")
    rec = await create(ctx, PFQN, {"first_name": np.first_name, "last_name": np.last_name, "gender": _gender(np.gender), "dob": dob,
                                   "phone": np.phone, "address": np.address, "city": np.city, "status": "Active",
                                   "registered_via": "ER", "dob_estimated": bool(dob and not np.dob)})
    await emit("patient.registered", ctx, {"patient": rec})
    return rec


@router.post("/register", status_code=201)
async def register(body: RegisterIn, ctx: CtxDep):
    _need(ctx, "register")
    cfg = await er_settings(ctx)
    wards = await _er_wards(ctx)
    lv = None
    if body.triage_level:
        lv = triage_info(cfg, body.triage_level)
        if not lv or not lv.get("enabled", True):
            raise bad_request("Unknown triage level", {"fields": {"triage_level": "Invalid"}})
    if body.bed_id:
        await _er_bed(ctx, body.bed_id, wards)
    elif cfg["registration"].get("require_bed"):
        raise bad_request("Choose an ER bed", {"fields": {"bed_id": "Required"}})
    doctor = await _employee(ctx, body.doctor_id, doctor=True) if body.doctor_id else None
    arrival = _stamp()
    if body.arrived_at:
        at = parse_dt(body.arrived_at)
        if at > now() + timedelta(minutes=5) or at < now() - timedelta(hours=24):
            raise bad_request("Arrival time must be within the last 24 hours", {"fields": {"arrived_at": "Out of range"}})
        arrival = at.isoformat(timespec="seconds")

    # ---- patient
    if body.mode == "existing":
        p = await _patient(ctx, body.patient_id)
        if p.get("status") in ("Merged", "Deceased"):
            raise conflict(f"This patient record is marked {str(p['status']).lower()}")
        temporary = bool(p.get("er_temporary"))
    elif body.mode == "new":
        if not body.patient:
            raise bad_request("Enter the patient's details")
        p = await _register_patient(ctx, body.patient)
        temporary = False
    else:
        p = await _temp_patient(ctx, body.unknown or UnknownIn())
        temporary = True
    cur = await _active_visit_for(ctx, p["id"])
    if cur:
        raise ApiError(409, f"{p.get('title') or 'This patient'} already has an active ER visit ({cur.code})",
                       {"visit_id": str(cur.id), "code": cur.code}, code="ER_ACTIVE_VISIT")

    # ---- doctor (explicit, else least loaded)
    reason = "Assigned at registration"
    if not doctor and body.auto_assign and cfg["flow"].get("auto_assign_doctor", True):
        pick = _pick(await doctor_pool(ctx, cfg))
        if pick:
            doctor, reason = {"id": pick["id"], "name": pick["name"]}, "Auto-assigned at registration (least loaded)"
    assignments = [{"doctor_id": doctor["id"], "doctor": doctor["name"], "at": _stamp(), "by": ctx.user.get("name"), "reason": reason}] \
        if doctor else []
    u = body.unknown if body.mode == "unidentified" else None
    visit = await create(ctx, VISIT, {
        "patient_id": p["id"], "arrival_mode": body.arrival_mode, "chief_complaint": body.chief_complaint.strip(), "payer": body.payer,
        "doctor_id": doctor["id"] if doctor else None, "department_id": await _er_department(ctx), "bed_id": body.bed_id,
        "started_at": arrival, "brought_by_type": body.brought_by_type, "brought_by": body.brought_by,
        "attendant_phone": body.attendant_phone, "police_station": body.police_station, "police_officer": body.police_officer,
        "unidentified": body.mode == "unidentified", "uhid_mapped": not temporary,
        "approx_age": u.approx_age if u else None, "identification_marks": u.identification_marks if u else None,
        "doctor_assigned_at": _stamp() if doctor else None, "assignments": assignments, "registered_by": ctx.user.get("name"),
        "status": "Waiting",
    })
    if body.bed_id:
        await _occupy(ctx, body.bed_id, visit)
    if lv:
        visit = await _record_triage(ctx, visit, TriageIn(level=lv["value"]), cfg)
    if body.mlc:
        visit = await _ensure_mlc(ctx, visit, body.mlc_no, body.mlc_case_type)
    await audit(ctx, "er.register", module="er", entity="visits", record=visit,
                after={"mode": body.mode, "arrival_mode": body.arrival_mode, "bed": body.bed_id, "doctor": doctor and doctor["name"]})
    return {"visit": {"id": visit["id"], "code": visit["code"]},
            "patient": {"id": p["id"], "code": p.get("code"), "title": p.get("title"), "temporary": temporary}}


# ================================================================== boards

@router.get("/board")
async def board(ctx: CtxDep, ward: str | None = None):
    """ER ward board: beds of one emergency ward with the patient on each, plus patients without a bed."""
    _need(ctx, "board")
    cfg = await er_settings(ctx)
    ts = now()
    wards = await _er_wards(ctx)
    wid = ward if ward in {w["id"] for w in wards} else (wards[0]["id"] if wards else None)
    b = beds
    bed_rows = (await ctx.conn.execute(sa.select(b.c.id, b.c.bed_no, b.c.code, b.c.category, b.c.status, b.c.data)
                                       .where(b.c.ward_id == wid, b.c.deleted_at.is_(None)).order_by(b.c.bed_no))).all() if wid else []
    e = encounters
    rows = (await ctx.conn.execute(_visit_query().where(e.c.status.in_(ACTIVE)).order_by(e.c.started_at.asc()))).all()
    summaries = await _summaries(ctx, rows, cfg, ts, with_flags=True)
    by_bed = {s["bed"]["id"]: s for s in summaries if s["bed"]}
    tiles, counts = [], defaultdict(int)
    for r in bed_rows:
        d = r.data or {}
        bid = str(r.id)
        occupant = by_bed.get(bid)
        since = minutes_between(d.get("status_since"), ts) if d.get("status_since") else None
        tiles.append({"id": bid, "bed_no": r.bed_no or r.code, "category": r.category, "status": r.status,
                      "status_since": d.get("status_since"), "minutes": max(0, since) if since is not None else None,
                      "block_reason": d.get("block_reason"), "visit": occupant})
        counts[r.status or "Unknown"] += 1
    unbedded = [s for s in summaries if not s["bed"]]
    return {
        "generated_at": ts.isoformat(timespec="seconds"), "wards": wards, "ward_id": wid, "beds": tiles, "unbedded": unbedded,
        "permissions": role_perms(ctx),
        "counts": {"occupied": counts.get("Occupied", 0), "vacant": counts.get("Vacant", 0), "cleaning": counts.get("Cleaning", 0),
                   "reserved": counts.get("Reserved", 0), "blocked": counts.get("Blocked", 0) + counts.get("Maintenance", 0),
                   "total": len(tiles), "active_visits": len(summaries), "waiting_for_bed": len(unbedded)},
    }


def _bool_filter(col, value: str | None):
    if value in (None, "", "all"):
        return None
    return col == "true" if value in ("yes", "true", "1") else sa.func.coalesce(col, "false") != "true"


@router.get("/visits")
async def tracking(ctx: CtxDep, state: str | None = None, triage: str | None = None, doctor: str | None = None,
                   mlc: str | None = None, mapped: str | None = None, outcome: str | None = None,
                   date_from: str | None = None, date_to: str | None = None, q: str | None = None, limit: int = 500):
    """Tracking board. Without a date range: every open visit plus today's arrivals and closures."""
    _need(ctx, "tracking")
    cfg = await er_settings(ctx)
    ts = now()
    e, p = encounters, patients
    d0 = today()
    closed_at = e.c.data["closed_at"].astext
    awaiting = sa.and_(e.c.status == "Disposed", e.c.data["disposed_at"].astext.isnot(None))
    closed = sa.or_(e.c.status == "Closed", sa.and_(e.c.status == "Disposed", e.c.data["disposed_at"].astext.is_(None)))
    closed_today = sa.and_(e.c.status == "Closed", closed_at >= d0.isoformat(), closed_at < (d0 + timedelta(days=1)).isoformat())
    stmt = _visit_query()
    try:
        if date_from:
            stmt = stmt.where(e.c.started_at >= day_bounds(parse_date(date_from))[0])
        if date_to:
            stmt = stmt.where(e.c.started_at < day_bounds(parse_date(date_to))[1])
    except ValueError as err:
        raise bad_request("Invalid date") from err
    if not (date_from or date_to):
        stmt = stmt.where(sa.or_(e.c.status.in_(ACTIVE), awaiting, e.c.started_at >= day_bounds(d0)[0], closed_today))
    if state == "Active":
        stmt = stmt.where(e.c.status.in_(ACTIVE))
    elif state == "Awaiting billing":
        stmt = stmt.where(awaiting)
    elif state == "Closed":
        stmt = stmt.where(closed)
    if triage == "none":
        stmt = stmt.where(e.c.data["triage_level"].astext.is_(None))
    elif triage:
        lv = triage_info(cfg, triage)
        stmt = stmt.where(e.c.data["triage_level"].astext == (lv["value"] if lv else triage))
    if doctor and is_uuid(doctor):
        stmt = stmt.where(e.c.doctor_id == doctor)
    for cond in (_bool_filter(e.c.data["mlc"].astext, mlc),
                 _bool_filter(p.c.data["er_temporary"].astext, {"yes": "no", "no": "yes"}.get(mapped or "", mapped))):
        if cond is not None:
            stmt = stmt.where(cond)
    if outcome:
        stmt = stmt.where(e.c.data["disposition"].astext == outcome)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(sa.or_(sa.func.lower(e.c.code).like(like), sa.func.lower(p.c.code).like(like), p.c.phone.like(like),
                                 sa.func.lower(sa.func.concat(p.c.first_name, " ", p.c.last_name)).like(like)))
    rows = (await ctx.conn.execute(stmt.order_by(e.c.started_at.desc()).limit(max(1, min(limit, 1000))))).all()
    out = await _summaries(ctx, rows, cfg, ts)

    base = [e.c.type == "ER", e.c.deleted_at.is_(None)]
    n_active, n_awaiting, n_closed = [
        (await ctx.conn.execute(sa.select(sa.func.count()).select_from(e).where(*base, c))).scalar_one()
        for c in (e.c.status.in_(ACTIVE), awaiting, closed_today)]
    active_rows = (await ctx.conn.execute(sa.select(e.c.data["triage_level"].astext, e.c.started_at, e.c.data).where(*base, e.c.status.in_(ACTIVE)))).all()
    by_level: dict[str, int] = defaultdict(int)
    breached = 0
    for lvl, started, data in active_rows:
        lv = triage_info(cfg, lvl)
        by_level[lv["key"] if lv else "none"] += 1
        seen = (data or {}).get("doctor_assessed_at") or (data or {}).get("doctor_seen_at")
        if lv and _clock(started, seen, lv.get("target_minutes"), ts)["state"] == "breached":
            breached += 1
    doctors_seen = {s["doctor"]["id"]: s["doctor"]["name"] for s in out if s["doctor"]}
    return {
        "generated_at": ts.isoformat(timespec="seconds"),
        "kpis": {"active": n_active, "awaiting_billing": n_awaiting, "closed_today": n_closed, "breached": breached},
        "triage_counts": [{**_triage_brief(lv), "count": by_level.get(lv["key"], 0)} for lv in cfg["triage"]["levels"] if lv.get("enabled", True)],
        "not_triaged": by_level.get("none", 0),
        "rows": out, "total": len(out),
        "doctors": [{"id": k, "name": v} for k, v in sorted(doctors_seen.items(), key=lambda kv: kv[1] or "")],
        "outcomes": [{"value": k, "label": v} for k, v in OUTCOME.items()],
        "permissions": role_perms(ctx),
    }


EXPORT_COLUMNS = [
    ("sno", "S.No"), ("bed", "Bed"), ("er_no", "ER no"), ("bill_no", "Bill no"), ("patient", "Patient"), ("uhid", "UHID"),
    ("uhid_mapped", "UHID mapped"), ("age_sex", "Age / sex"), ("arrived", "Arrived"), ("time_in_er", "Time in ER"),
    ("triage", "Triage"), ("doctor", "Doctor"), ("current_step", "Current step"), ("mlc", "MLC"), ("status", "Status"),
    ("outcome", "Outcome"), ("chief_complaint", "Presenting complaint"),
]


def _hm(mins: int | None) -> str:
    if mins is None:
        return ""
    d, rem = divmod(int(mins), 1440)
    h, m = divmod(rem, 60)
    return f"{d}d {h}h" if d else f"{h}h {m:02d}m" if h else f"{m}m"


def _flat(i: int, s: dict) -> dict:
    p = s["patient"]
    return {
        "sno": i, "bed": (s.get("bed") or {}).get("bed_no") or "", "er_no": s["code"], "bill_no": (s.get("bill") or {}).get("code") or "",
        "patient": p["name"], "uhid": p.get("uhid"), "uhid_mapped": "No" if p.get("temporary") else "Yes",
        "age_sex": "/".join(x for x in (f"{p['age']}Y" if p.get("age") is not None else "", (p.get("gender") or "").upper()) if x),
        "arrived": s.get("arrived_at"), "time_in_er": _hm(s.get("minutes_in_er")), "triage": (s.get("triage") or {}).get("label") or "Not triaged",
        "doctor": (s.get("doctor") or {}).get("name") or "", "current_step": s["current_step"]["label"],
        "mlc": s.get("mlc_no") or ("Yes" if s.get("mlc") else ""), "status": s["state"], "outcome": s.get("outcome") or "",
        "chief_complaint": s.get("chief_complaint") or "",
    }


async def _export(ctx, request: Request) -> tuple[list[dict], list[tuple[str, str]], int]:
    qp = request.query_params
    data = await tracking(ctx, **{k: qp.get(k) for k in ("state", "triage", "doctor", "mlc", "mapped", "outcome", "date_from", "date_to", "q")},
                          limit=1000)
    cols = EXPORT_COLUMNS
    if qp.get("cols"):
        want = [c for c in qp["cols"].split(",") if c]
        cols = [c for c in EXPORT_COLUMNS if c[0] in want] or EXPORT_COLUMNS
    return [_flat(i, s) for i, s in enumerate(data["rows"], start=1)], cols, data["total"]


@router.get("/visits/export.csv", response_class=PlainTextResponse)
async def export_csv(request: Request, ctx: CtxDep):
    rows, cols, total = await _export(ctx, request)
    await audit(ctx, "export", module="er", entity="visits", note=f"Tracking board CSV · {total} rows")
    return PlainTextResponse("\ufeff" + to_csv(rows, cols), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="er-tracking-{now():%Y%m%d}.csv"'})


@router.get("/visits/export.json")
async def export_json(request: Request, ctx: CtxDep):
    rows, cols, total = await _export(ctx, request)
    await audit(ctx, "export", module="er", entity="visits", note=f"Tracking board JSON · {total} rows")
    body = {"entity": VISIT, "label": "ER Tracking Board", "exported_at": now().isoformat(timespec="seconds"), "total": total,
            "columns": [{"key": k, "label": label} for k, label in cols], "rows": [{k: r.get(k) for k, _ in cols} for r in rows]}
    disposition = "inline" if request.query_params.get("inline") else "attachment"
    return JSONResponse(body, headers={"Content-Disposition": f'{disposition}; filename="er-tracking-{now():%Y%m%d}.json"'})


@router.get("/visits/export.xlsx")
async def export_xlsx(request: Request, ctx: CtxDep):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    rows, cols, total = await _export(ctx, request)
    wb = Workbook()
    ws = wb.active
    ws.title = "ER Tracking Board"
    ws.append([label for _, label in cols])
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="0F4C5C")
    for r in rows:
        ws.append([r.get(k) for k, _ in cols])
    for i, (k, label) in enumerate(cols, start=1):
        width = max([len(label)] + [len(str(r.get(k) or "")) for r in rows[:200]])
        ws.column_dimensions[get_column_letter(i)].width = min(max(8, width + 2), 50)
    ws.freeze_panes = "A2"
    buf = io.BytesIO()
    wb.save(buf)
    await audit(ctx, "export", module="er", entity="visits", note=f"Tracking board Excel · {total} rows")
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="er-tracking-{now():%Y%m%d}.xlsx"'})


@router.get("/handover")
async def handover_sheet(ctx: CtxDep):
    """S-BAR shift handover sheet: every patient in the ER with the latest handover and pending steps."""
    _need(ctx, "board")
    _need_clinical(ctx)
    cfg = await er_settings(ctx)
    ts = now()
    e = encounters
    rows = (await ctx.conn.execute(_visit_query().where(e.c.status.in_(ACTIVE)).order_by(e.c.started_at.asc()))).all()
    out = await _summaries(ctx, rows, cfg, ts, with_flags=True)
    ids = [s["id"] for s in out]
    latest: dict[str, dict] = {}
    if ids:
        ent = E(HANDOVER)
        t = ent.table
        for r in (await ctx.conn.execute(sa.select(t).where(*rs.base_where(ent), t.c.encounter_id.in_(ids))
                                         .order_by(t.c.created_at.asc()))).all():
            rec = rs.to_record(r)
            latest[rec["encounter_id"]] = {k: rec.get(k) for k in ("id", "code", "shift", "handover_at", "situation", "background",
                                                                   "assessment", "recommendation", "status")}
    for s in out:
        s["last_handover"] = latest.get(s["id"])
    return {"generated_at": ts.isoformat(timespec="seconds"), "rows": out}


# ================================================================== visit chart

def _perms(ctx, v: dict, temporary: bool) -> dict:
    """What this user may do on this visit — the chart renders only these controls (endpoints enforce the same)."""
    rp = role_perms(ctx)
    active = v.get("status") in ACTIVE
    out = {k: rp[k] and active for k in ("triage", "nursing", "doctor", "assign", "orders", "treatment", "vitals", "status", "dispose",
                                         "abscond", "move_bed", "handover", "alerts")}
    out.update(view_clinical=rp["view_clinical"], mlc=rp["mlc"], details=rp["details"], link=rp["link"] and temporary,
               documents=rp["documents"], view_billing=rp["view_billing"], bill=rp["bill"],
               close=rp["close"] and v.get("status") == "Disposed", override_close=rp["override_close"], print_mlc=rp["mlc"],
               board=rp["board"], tracking=rp["tracking"], register=rp["register"])
    return out


@router.get("/visits/{vid}")
async def visit_detail(vid: str, ctx: CtxDep):
    _need(ctx, "read")
    if not is_uuid(vid):
        raise not_found("ER visit not found")
    cfg = await er_settings(ctx)
    ts = now()
    row = (await ctx.conn.execute(_visit_query().where(encounters.c.id == vid))).first()
    if not row:
        raise not_found("ER visit not found")
    summary = (await _summaries(ctx, [row], cfg, ts, with_flags=True))[0]
    facts = (await _step_facts(ctx, [vid])).get(vid, {})
    v = await _visit(ctx, vid)
    pid = v["patient_id"]
    p = await _patient(ctx, pid)
    p["age"] = age_from(p.get("dob"))
    clinical = role_perms(ctx)["view_clinical"]
    triage_hist = await find(ctx, TRIAGE, encounter_id=vid, sort="-triaged_at", limit=50) if clinical else []
    nursing = await first(ctx, NURSING, encounter_id=vid, sort="-assessed_at") if clinical else None
    doc_a = await first(ctx, DOCTOR_A, encounter_id=vid, sort="-assessed_at") if clinical else None
    treatments = await find(ctx, TREAT, encounter_id=vid, sort="-recorded_at", limit=100) if clinical else []
    handovers = await find(ctx, HANDOVER, encounter_id=vid, sort="-handover_at", limit=50) if clinical else []
    allergy_rows = await find(ctx, ALLERGIES, patient_id=pid, status="Active", limit=50) if has(ALLERGIES) else []
    known = list(p.get("allergies") or [])
    allergies = [{"id": a["id"], "allergen": a.get("allergen"), "type": a.get("allergen_type"), "severity": a.get("severity"),
                  "reaction": a.get("reaction")} for a in allergy_rows]
    allergies += [{"id": None, "allergen": k, "type": None, "severity": None, "reaction": None}
                  for k in known if k not in {a["allergen"] for a in allergies}]
    if allergies:
        allergy_status = "recorded"
    elif nursing and nursing.get("medication_allergy") == "No" and nursing.get("food_allergy") == "No" and not nursing.get("other_allergies"):
        allergy_status = "nka"
    else:
        allergy_status = "not_recorded"
    from .clinical import _vital_point, _vitals_series

    _, latest = await _vitals_series(ctx, pid, 24) if clinical else ([], None)
    mlc_case = None
    if v.get("mlc_case"):
        mc = await get(ctx, MLC, v["mlc_case"])
        if mc:
            mlc_case = {k: mc.get(k) for k in ("id", "code", "mlc_no", "case_type", "status", "police_station", "intimation_sent_at")}
    admission = None
    if v.get("admission"):
        a = await get(ctx, ADM, v["admission"])
        if a:
            admission = {k: a.get(k) for k in ("id", "code", "status", "started_at", "bed_id", "doctor_id", "diagnosis")}
    refs = _merge_refs(triage_hist, [nursing], [doc_a], treatments, handovers, allergy_rows)
    refs.update(await rs.resolve_refs(ctx, E(VISIT), [v]))
    if admission:
        refs.update(await rs.resolve_refs(ctx, E(ADM), [admission]))
    if not clinical:  # desk roles see the visit header, identity and billing — not clinical notes
        for k in ("vitals_summary", "provisional_diagnosis", "disposition_notes", "cause_of_death", "identification_marks"):
            v.pop(k, None)
    await audit(ctx, "er.visit.view", module="er", entity="visits", record=v)
    return {
        "visit": v, "summary": summary,
        "steps": steps_of(v, facts, cfg),
        "patient": {k: p.get(k) for k in ("id", "code", "title", "first_name", "last_name", "gender", "dob", "age", "phone", "blood_group",
                                          "category", "payer_type", "address", "city", "abha_id", "status", "er_temporary",
                                          "identification_marks", "dob_estimated", "emergency_contact_name", "emergency_contact_phone")},
        "temporary": bool(p.get("er_temporary")),
        "triage_history": triage_hist, "nursing": nursing, "doctor_assessment": doc_a, "treatments": treatments, "handovers": handovers,
        "allergies": allergies, "allergy_status": allergy_status,
        "latest_vitals": _vital_point(latest) if latest else None,
        "mlc_case": mlc_case, "admission": admission,
        "assignments": v.get("assignments") or ([{"doctor_id": v.get("doctor_id"), "doctor": summary["doctor"]["name"] if summary["doctor"] else None,
                                                 "at": v.get("started_at"), "by": v.get("registered_by"), "reason": "Assigned at enrolment"}]
                                               if v.get("doctor_id") else []),
        "documents": v.get("documents") or [],
        "permissions": _perms(ctx, v, bool(p.get("er_temporary"))),
        "refs": refs,
    }


@router.get("/visits/{vid}/vitals")
async def visit_vitals(vid: str, ctx: CtxDep, hours: int = 24):
    _need_clinical(ctx)
    v = await _visit(ctx, vid)
    from .clinical import _vital_point, _vitals_series

    hours = max(6, min(hours, 24 * 30))
    series, latest = await _vitals_series(ctx, v["patient_id"], hours)
    return {"hours": hours, "series": [_vital_point(x) for x in series], "latest": _vital_point(latest) if latest else None}


class VitalsIn(BaseModel):
    temperature: float | None = Field(default=None, ge=90, le=110)
    pulse: float | None = Field(default=None, ge=0, le=300)
    resp_rate: float | None = Field(default=None, ge=0, le=80)
    bp_systolic: float | None = Field(default=None, ge=0, le=300)
    bp_diastolic: float | None = Field(default=None, ge=0, le=200)
    spo2: float | None = Field(default=None, ge=0, le=100)
    o2_support: str | None = None
    pain_score: float | None = Field(default=None, ge=0, le=10)
    gcs: float | None = Field(default=None, ge=3, le=15)
    blood_sugar: float | None = Field(default=None, ge=0, le=1500)
    weight: float | None = Field(default=None, ge=0, le=400)
    height: float | None = Field(default=None, ge=0, le=250)
    remarks: str | None = Field(default=None, max_length=300)


@router.post("/visits/{vid}/vitals", status_code=201)
async def record_vitals(vid: str, body: VitalsIn, ctx: CtxDep):
    _need(ctx, "vitals")
    v = await _visit(ctx, vid)
    _active_only(v, "Recording vitals")
    vals = body.model_dump(exclude_none=True)
    if not any(k in vals for k in ("temperature", "pulse", "resp_rate", "bp_systolic", "spo2", "gcs", "blood_sugar", "pain_score")):
        raise bad_request("Enter at least one observation")
    return await create(ctx, VITALS, {**vals, "patient_id": v["patient_id"], "encounter_id": vid, "recorded_at": _stamp(),
                                      "recorded_by": ctx.user.get("employee_id"), "remarks": vals.get("remarks") or f"ER {v.get('code')}"})


# ================================================================== triage

class TriageIn(BaseModel):
    level: str
    red_flags: list[str] = []
    pulse: float | None = Field(default=None, ge=0, le=300)
    bp_systolic: float | None = Field(default=None, ge=0, le=300)
    spo2: float | None = Field(default=None, ge=0, le=100)
    resp_rate: float | None = Field(default=None, ge=0, le=80)
    gcs: float | None = Field(default=None, ge=3, le=15)
    pain_score: float | None = Field(default=None, ge=0, le=10)
    rbs: float | None = Field(default=None, ge=0, le=1500)
    notes: str | None = Field(default=None, max_length=1000)
    retriage_reason: str | None = Field(default=None, max_length=300)


async def _record_triage(ctx, v: dict, body: TriageIn, cfg: dict) -> dict:
    lv = triage_info(cfg, body.level)
    if not lv or not lv.get("enabled", True):
        raise bad_request("Unknown triage level", {"fields": {"level": "Invalid"}})
    retriage = bool(v.get("triaged_at"))
    if retriage and not (body.retriage_reason or "").strip():
        raise bad_request("Give the reason for re-triage", {"fields": {"retriage_reason": "Required"}})
    vit = body.model_dump(include={"pulse", "bp_systolic", "spo2", "resp_rate", "gcs", "pain_score", "rbs"}, exclude_none=True)
    rec = await create(ctx, TRIAGE, {
        "patient_id": v["patient_id"], "encounter_id": v["id"], "triaged_at": _stamp(), "triage_level": lv["value"],
        "triage_system": cfg["triage"].get("system") or "5-level colour (MTS-based)", "red_flags": body.red_flags or None, **vit,
        "notes": body.notes, "retriage": retriage, "retriage_reason": body.retriage_reason, "target_minutes": lv.get("target_minutes"),
        "triage_nurse": ctx.user.get("employee_id"),
    })
    patch: dict[str, Any] = {"triage_level": lv["value"], "triage_target_minutes": lv.get("target_minutes"),
                             "last_triaged_at": rec["triaged_at"], "retriage_count": (v.get("retriage_count") or 0) + (1 if retriage else 0)}
    if not retriage:
        patch["triaged_at"] = rec["triaged_at"]
    line = _vitals_line(vit)
    if line:
        patch["vitals_summary"] = line
    return await update(ctx, VISIT, v["id"], patch)


@router.post("/visits/{vid}/triage", status_code=201)
async def triage(vid: str, body: TriageIn, ctx: CtxDep):
    _need(ctx, "triage")
    v = await _visit(ctx, vid)
    _active_only(v, "Triage")
    return await _record_triage(ctx, v, body, await er_settings(ctx))


# ================================================================== nursing & doctor assessment, treatment

class NursingIn(BaseModel):
    assessed_at: str | None = None
    avpu: str | None = None
    airway: str | None = None
    breathing: str | None = None
    circulation: str | None = None
    fall_risk: str | None = None
    skin: str | None = Field(default=None, max_length=500)
    bp_systolic: float | None = None
    bp_diastolic: float | None = None
    pulse: float | None = None
    resp_rate: float | None = None
    temperature: float | None = None
    spo2: float | None = None
    spo2_on: str | None = None
    grbs: float | None = None
    gcs_e: int | None = Field(default=None, ge=1, le=4)
    gcs_v: int | None = Field(default=None, ge=1, le=5)
    gcs_m: int | None = Field(default=None, ge=1, le=6)
    pain_score: int | None = Field(default=None, ge=0, le=10)
    medication_allergy: str | None = None
    food_allergy: str | None = None
    other_allergies: str | None = Field(default=None, max_length=500)
    pain_location: str | None = Field(default=None, max_length=200)
    pain_character: str | None = Field(default=None, max_length=200)
    pain_type: str | None = None
    pain_duration: str | None = Field(default=None, max_length=100)
    notes: str | None = Field(default=None, max_length=5000)


VITAL_KEYS = ("bp_systolic", "bp_diastolic", "pulse", "resp_rate", "temperature", "spo2", "grbs", "pain_score")


@router.post("/visits/{vid}/nursing-assessment")
async def nursing_assessment(vid: str, body: NursingIn, ctx: CtxDep):
    _need(ctx, "nursing")
    v = await _visit(ctx, vid)
    _active_only(v, "Nursing assessment")
    data = body.model_dump()
    data["assessed_at"] = data.get("assessed_at") or _stamp()
    gcs = [data.get(k) for k in ("gcs_e", "gcs_v", "gcs_m")]
    data["gcs_total"] = sum(gcs) if all(x is not None for x in gcs) else None
    existing = await first(ctx, NURSING, encounter_id=vid, sort="-assessed_at")
    vit = {k: data[k] for k in VITAL_KEYS if data.get(k) is not None}
    vitals_payload = None
    if vit:
        vitals_payload = {
            "temperature": vit.get("temperature"), "pulse": vit.get("pulse"), "resp_rate": vit.get("resp_rate"),
            "bp_systolic": vit.get("bp_systolic"), "bp_diastolic": vit.get("bp_diastolic"), "spo2": vit.get("spo2"),
            "o2_support": O2_TO_EMR.get(data.get("spo2_on") or "", data.get("spo2_on")) if data.get("spo2_on") else None,
            "pain_score": vit.get("pain_score"), "gcs": data["gcs_total"], "blood_sugar": vit.get("grbs"),
        }
    if existing:
        rec = await update(ctx, NURSING, existing["id"], {**data, "assessed_by": existing.get("assessed_by") or ctx.user.get("employee_id")})
        if vitals_payload:
            if existing.get("vitals_entry") and await get(ctx, VITALS, existing["vitals_entry"]):
                await update(ctx, VITALS, existing["vitals_entry"], vitals_payload)
            else:
                vr = await create(ctx, VITALS, {**vitals_payload, "patient_id": v["patient_id"], "encounter_id": vid,
                                                "recorded_at": data["assessed_at"], "recorded_by": ctx.user.get("employee_id"),
                                                "remarks": f"ER nursing assessment {rec['code']}"})
                rec = await update(ctx, NURSING, rec["id"], {"vitals_entry": vr["id"]})
    else:
        rec = await create(ctx, NURSING, {**data, "patient_id": v["patient_id"], "encounter_id": vid,
                                          "assessed_by": ctx.user.get("employee_id")})
        if vitals_payload:
            vr = await create(ctx, VITALS, {**vitals_payload, "patient_id": v["patient_id"], "encounter_id": vid,
                                            "recorded_at": data["assessed_at"], "recorded_by": ctx.user.get("employee_id"),
                                            "remarks": f"ER nursing assessment {rec['code']}"})
            rec = await update(ctx, NURSING, rec["id"], {"vitals_entry": vr["id"]})
        await update(ctx, VISIT, vid, {"nursing_assessed_at": rec["assessed_at"]})
    return rec


class DoctorAssessmentIn(BaseModel):
    presenting_complaints: str | None = Field(default=None, max_length=5000)
    history: str | None = Field(default=None, max_length=10000)
    past_history: str | None = Field(default=None, max_length=5000)
    general_examination: str | None = Field(default=None, max_length=5000)
    cvs: str | None = Field(default=None, max_length=500)
    rs: str | None = Field(default=None, max_length=500)
    cns: str | None = Field(default=None, max_length=500)
    abdomen: str | None = Field(default=None, max_length=500)
    local_examination: str | None = Field(default=None, max_length=5000)
    provisional_diagnosis: str = Field(min_length=2, max_length=500)
    differential_diagnosis: str | None = Field(default=None, max_length=500)
    plan: str | None = Field(default=None, max_length=10000)


@router.post("/visits/{vid}/doctor-assessment")
async def doctor_assessment(vid: str, body: DoctorAssessmentIn, ctx: CtxDep):
    """Saves the ER doctor's assessment; the first one marks the patient seen (door-to-doctor, ER consult charge)."""
    _need(ctx, "doctor")
    v = await _visit(ctx, vid)
    _active_only(v, "Doctor assessment")
    me = ctx.user.get("employee_id")
    existing = await first(ctx, DOCTOR_A, encounter_id=vid, sort="-assessed_at")
    data = body.model_dump()
    if existing:
        rec = await update(ctx, DOCTOR_A, existing["id"], data)
    else:
        rec = await create(ctx, DOCTOR_A, {**data, "patient_id": v["patient_id"], "encounter_id": vid, "assessed_at": _stamp(), "doctor": me})
    patch: dict[str, Any] = {"provisional_diagnosis": body.provisional_diagnosis}
    if not v.get("doctor_assessed_at"):
        patch["doctor_assessed_at"] = rec["assessed_at"]
    if not v.get("doctor_id") and me:
        emp = await _employee(ctx, me, doctor=True)
        patch.update(doctor_id=me, doctor_assigned_at=_stamp(), assignments=[
            *(v.get("assignments") or []), {"doctor_id": me, "doctor": emp["name"], "at": _stamp(), "by": ctx.user.get("name"),
                                            "reason": "Took over at assessment"}])
    await update(ctx, VISIT, vid, patch)
    if v["status"] == "Waiting":
        await transition(ctx, VISIT, vid, "In Treatment", note="Doctor assessment")
    return rec


class TreatmentIn(BaseModel):
    entry_type: str = "Treatment given"
    details: str = Field(min_length=2, max_length=5000)
    response: str | None = None
    vitals_summary: str | None = Field(default=None, max_length=300)
    consultant: str | None = None
    chargeable: bool = False
    next_review_at: str | None = None


@router.post("/visits/{vid}/treatments", status_code=201)
async def add_treatment(vid: str, body: TreatmentIn, ctx: CtxDep):
    _need(ctx, "treatment")
    v = await _visit(ctx, vid)
    _active_only(v, "Treatment entry")
    if body.chargeable and not body.consultant:
        raise bad_request("Choose the visiting doctor to bill the visit", {"fields": {"consultant": "Required"}})
    rec = await create(ctx, TREAT, {**body.model_dump(), "patient_id": v["patient_id"], "encounter_id": vid, "recorded_at": _stamp(),
                                    "recorded_by": ctx.user.get("employee_id")})
    if body.chargeable and body.entry_type in ("Doctor visit", "Specialist consult"):
        cfg = await er_settings(ctx)
        code = cfg["flow"].get("specialist_visit_charge_code")
        if code:
            from .billing import post_charge

            doc = await _employee(ctx, body.consultant, doctor=True)
            await post_charge(ctx, patient_id=v["patient_id"], encounter_id=vid, service_code=code,
                              description=f"{body.entry_type} — {doc['name']}", source=TREAT, source_id=rec["id"], ref_code=v.get("code"))
    return rec


class StatusIn(BaseModel):
    to: Literal["In Treatment", "Observation"]


@router.post("/visits/{vid}/status")
async def change_status(vid: str, body: StatusIn, ctx: CtxDep):
    _need(ctx, "status")
    v = await _visit(ctx, vid)
    _active_only(v, "Changing the ER status")
    if v["status"] == body.to:
        raise conflict(f"The visit is already {body.to}")
    if v["status"] == "Waiting" and body.to == "Observation":
        raise conflict("A doctor must see the patient before observation")
    return await transition(ctx, VISIT, vid, body.to)


# ================================================================== doctor assignment

class AssignIn(BaseModel):
    doctor_id: str
    reason: str | None = Field(default=None, max_length=300)


@router.get("/visits/{vid}/doctors")
async def visit_doctors(vid: str, ctx: CtxDep):
    _need_clinical(ctx)
    v = await _visit(ctx, vid)
    cfg = await er_settings(ctx)
    pool = await doctor_pool(ctx, cfg, include=v.get("doctor_id"))
    return {"current": v.get("doctor_id"), "doctors": pool, "roster_based": any(d["on_duty"] is not None for d in pool)}


@router.post("/visits/{vid}/assign-doctor")
async def assign_doctor(vid: str, body: AssignIn, ctx: CtxDep):
    _need(ctx, "assign")
    v = await _visit(ctx, vid)
    _active_only(v, "Re-assigning the doctor")
    if body.doctor_id == v.get("doctor_id"):
        raise conflict("This doctor is already assigned")
    doc = await _employee(ctx, body.doctor_id, doctor=True)
    prev_name = None
    if v.get("doctor_id"):
        prev = (await ctx.conn.execute(sa.select(employees.c.name).where(employees.c.id == v["doctor_id"]))).first()
        prev_name = prev.name if prev else None
    hist = list(v.get("assignments") or [])
    if not hist and v.get("doctor_id"):
        hist.append({"doctor_id": v["doctor_id"], "doctor": prev_name, "at": v.get("started_at"), "by": v.get("registered_by"),
                     "reason": "Assigned at enrolment"})
    hist.append({"doctor_id": doc["id"], "doctor": doc["name"], "at": _stamp(), "by": ctx.user.get("name"),
                 "reason": (body.reason or "").strip() or ("Re-assigned" if v.get("doctor_id") else "Assigned")})
    patch: dict[str, Any] = {"doctor_id": doc["id"], "assignments": hist}
    if not v.get("doctor_assigned_at"):
        patch["doctor_assigned_at"] = _stamp()
    rec = await update(ctx, VISIT, vid, patch)
    await audit(ctx, "er.assign_doctor", module="er", entity="visits", record=rec, before={"doctor": prev_name},
                after={"doctor": doc["name"]}, note=body.reason)
    return rec


# ================================================================== MLC, alerts, bed moves

async def _ensure_mlc(ctx, v: dict, mlc_no: str | None, case_type: str | None) -> dict:
    case = await get(ctx, MLC, v["mlc_case"]) if v.get("mlc_case") else None
    mlc_no = (mlc_no or "").strip() or None
    if case:
        if mlc_no and mlc_no != case.get("mlc_no"):
            await update(ctx, MLC, case["id"], {"mlc_no": mlc_no})
    else:
        case = await create(ctx, MLC, {
            "patient_id": v["patient_id"], "encounter_id": v["id"], "mlc_no": mlc_no, "case_type": case_type or "Unknown cause",
            "incident_at": v.get("started_at"), "brought_by": MLC_BROUGHT_BY.get(v.get("brought_by_type") or ""),
            "brought_by_name": v.get("brought_by"), "brought_by_phone": v.get("attendant_phone"),
            "identification_marks": v.get("identification_marks"), "police_station": v.get("police_station"),
            "police_officer": v.get("police_officer"), "examining_doctor": v.get("doctor_id"), "status": "Open",
        })
    return await update(ctx, VISIT, v["id"], {"mlc": True, "mlc_no": mlc_no or v.get("mlc_no") or case.get("mlc_no"), "mlc_case": case["id"]})


class MlcIn(BaseModel):
    mlc: bool
    mlc_no: str | None = Field(default=None, max_length=60)
    case_type: str | None = None
    reason: str | None = Field(default=None, max_length=300)


@router.post("/visits/{vid}/mlc")
async def set_mlc(vid: str, body: MlcIn, ctx: CtxDep):
    _need(ctx, "mlc")
    v = await _visit(ctx, vid)
    if body.mlc:
        rec = await _ensure_mlc(ctx, v, body.mlc_no, body.case_type)
        await audit(ctx, "er.mlc_mark", module="er", entity="visits", record=rec, after={"mlc_no": rec.get("mlc_no")})
        return rec
    if not v.get("mlc"):
        raise conflict("This visit is not marked medico-legal")
    if len((body.reason or "").strip()) < 5:
        raise bad_request("Give the reason for removing the MLC flag", {"fields": {"reason": "Required"}})
    case = await get(ctx, MLC, v["mlc_case"]) if v.get("mlc_case") else None
    if case and case.get("status") != "Open":
        raise conflict(f"MLC case {case.get('code')} is already {str(case.get('status')).lower()} — it cannot be withdrawn here")
    if case:
        await rs.delete_record(ctx, E(MLC), case["id"], reason=body.reason, check=False)
    rec = await update(ctx, VISIT, vid, {"mlc": False, "mlc_no": None, "mlc_case": None})
    await audit(ctx, "er.mlc_unmark", module="er", entity="visits", record=rec, before={"mlc_no": v.get("mlc_no")}, note=body.reason)
    return rec


class AlertsIn(BaseModel):
    alerts: list[str] = Field(default=[], max_length=20)


@router.post("/visits/{vid}/alerts")
async def set_alerts(vid: str, body: AlertsIn, ctx: CtxDep):
    _need(ctx, "alerts")
    v = await _visit(ctx, vid)
    clean = list(dict.fromkeys(a.strip()[:80] for a in body.alerts if a and a.strip()))
    return await update(ctx, VISIT, v["id"], {"alerts": clean})


class MoveBedIn(BaseModel):
    bed_id: str
    reason: str | None = Field(default=None, max_length=300)


@router.post("/visits/{vid}/move-bed")
async def move_bed(vid: str, body: MoveBedIn, ctx: CtxDep):
    _need(ctx, "move_bed")
    v = await _visit(ctx, vid)
    _active_only(v, "Moving the bed")
    if body.bed_id == v.get("bed_id"):
        raise bad_request("The patient is already on this bed")
    new = await _er_bed(ctx, body.bed_id, await _er_wards(ctx))
    old = v.get("bed_id")
    if old:
        await _release_bed(ctx, v, reason=f"ER bed move of {v.get('code')}")
    moves = [*(v.get("bed_moves") or []), {"from": old, "to": new["id"], "to_bed_no": new.get("bed_no"), "at": _stamp(),
                                           "by": ctx.user.get("name"), "reason": body.reason}]
    rec = await update(ctx, VISIT, vid, {"bed_id": new["id"], "bed_moves": moves})
    await _occupy(ctx, new["id"], rec)
    await audit(ctx, "er.move_bed", module="er", entity="visits", record=rec, after={"bed": new.get("bed_no")}, note=body.reason)
    return rec


# ================================================================== patient identity: details & UHID linking

class DetailsIn(BaseModel):
    first_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    gender: str | None = None
    dob: str | None = None
    age_years: int | None = Field(default=None, ge=0, le=120)
    phone: str | None = Field(default=None, max_length=15)
    address: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=100)
    emergency_contact_name: str | None = Field(default=None, max_length=200)
    emergency_contact_phone: str | None = Field(default=None, max_length=15)
    brought_by_type: str | None = None
    brought_by: str | None = Field(default=None, max_length=200)
    attendant_phone: str | None = None
    police_station: str | None = Field(default=None, max_length=200)
    police_officer: str | None = Field(default=None, max_length=200)
    identification_marks: str | None = Field(default=None, max_length=1000)
    payer: str | None = None
    register_uhid: bool = False
    force: bool = False


@router.post("/visits/{vid}/patient-details")
async def patient_details(vid: str, body: DetailsIn, ctx: CtxDep):
    """Attendant / police details on the visit; identity on a temporary record (optionally made a permanent UHID)."""
    _need(ctx, "details")
    v = await _visit(ctx, vid)
    p = await _patient(ctx, v["patient_id"])
    temporary = bool(p.get("er_temporary"))
    vals = body.model_dump(exclude_unset=True)
    visit_keys = ("brought_by_type", "brought_by", "attendant_phone", "police_station", "police_officer", "identification_marks", "payer")
    vpatch = {k: vals[k] for k in visit_keys if k in vals}
    if vpatch:
        v = await update(ctx, VISIT, vid, vpatch)
    contact = {k: vals[k] for k in ("address", "city", "emergency_contact_name", "emergency_contact_phone") if k in vals}
    identity = {k: vals[k] for k in ("first_name", "last_name", "phone", "dob") if vals.get(k) not in (None, "")}
    if "gender" in vals and vals["gender"]:
        identity["gender"] = _gender(vals["gender"])
    if vals.get("age_years") is not None and not identity.get("dob"):
        identity.update(dob=_dob_from_age(vals["age_years"]), dob_estimated=True)
    if identity and not temporary:
        raise conflict("This visit is mapped to a registered UHID — change identity details from Registration")
    if body.register_uhid:
        if not temporary:
            raise conflict("The patient already has a registered UHID")
        merged = {**p, **identity}
        missing = [k for k in ("first_name", "gender", "phone") if not merged.get(k) or (k == "first_name" and merged[k] == "Unknown")]
        if missing:
            raise bad_request("Name, gender and mobile are needed to register the UHID", {"fields": {k: "Required" for k in missing}})
        if not body.force:
            from .patients import DupIn, find_duplicates

            dups = [d for d in await find_duplicates(ctx, DupIn(first_name=merged.get("first_name"), last_name=merged.get("last_name"),
                                                                phone=merged.get("phone"), dob=merged.get("dob")))
                    if d["score"] >= 55 and d["id"] != p["id"]]
            if dups:
                raise ApiError(409, "This patient may already have a UHID — link the visit to it instead",
                               {"duplicates": dups}, code="DUPLICATE")
        if identity.get("first_name") is None and merged.get("first_name") == "Unknown":
            raise bad_request("Enter the patient's name", {"fields": {"first_name": "Required"}})
    patch = {**contact, **identity}
    if body.register_uhid:
        patch.update(er_temporary=False, registered_via="ER", uhid_registered_at=_stamp())
    if patch:
        p = await update(ctx, PFQN, p["id"], patch)
    if body.register_uhid:
        v = await update(ctx, VISIT, vid, {"uhid_mapped": True, "uhid_registered_at": _stamp()})
        await audit(ctx, "er.register_uhid", module="er", entity="visits", record=v, after={"uhid": p.get("code"), "name": p.get("title")})
        await emit("patient.registered", ctx, {"patient": p})
    return {"visit": {"id": v["id"], "code": v.get("code")},
            "patient": {"id": p["id"], "code": p.get("code"), "title": p.get("title"), "temporary": bool(p.get("er_temporary"))}}


class LinkIn(BaseModel):
    patient_id: str
    note: str | None = Field(default=None, max_length=300)


@router.post("/visits/{vid}/link-uhid")
async def link_uhid(vid: str, body: LinkIn, ctx: CtxDep):
    """Unidentified patient identified: merge the temporary record into the real UHID (MPI merge, audited)."""
    _need(ctx, "link")
    v = await _visit(ctx, vid)
    temp = await _patient(ctx, v["patient_id"])
    if not temp.get("er_temporary"):
        raise conflict("This visit is already mapped to a registered UHID")
    target = await _patient(ctx, body.patient_id)
    if target["id"] == temp["id"]:
        raise bad_request("Choose the patient's registered UHID")
    if target.get("er_temporary"):
        raise bad_request("That record is itself a temporary ER record — choose a registered UHID")
    if target.get("status") in ("Merged", "Deceased", "Inactive") and not (target.get("status") == "Deceased" and v.get("disposition") in ("Expired", "Brought dead")):
        raise conflict(f"{target.get('title')} ({target.get('code')}) is {str(target.get('status')).lower()}")
    other = await _active_visit_for(ctx, target["id"], exclude=vid)
    if other:
        raise conflict(f"{target.get('title')} already has another active ER visit ({other.code}) — close it before linking")
    mr = await create(ctx, MERGE, {"primary_patient": target["id"], "duplicate_patient": temp["id"], "match_reason": "Manual review",
                                   "notes": f"ER {v.get('code')}: unidentified patient identified as {target.get('code')}"
                                            + (f" — {body.note}" if body.note else "")})
    # Same MPI merge rule as "Approve & merge" (moves every visit, order, charge and note; marks the record Merged).
    # Called directly because the generic transition stores table-name keys orjson cannot serialise.
    from .patients import _merge as mpi_merge

    nxt = {**mr, "status": "Merged"}
    await mpi_merge(ctx, nxt, mr)
    mr = await update(ctx, MERGE, mr["id"], {"status": "Merged", "merged_at": _stamp(), "merged_by": ctx.user.get("name"),
                                             "moved": {str(k): n for k, n in (nxt.get("moved") or {}).items()}})
    if v.get("bed_id") and v.get("status") in ACTIVE:
        b = await get(ctx, BED, v["bed_id"])
        if b and b.get("current_encounter") == vid:
            await update(ctx, BED, b["id"], {"current_patient": target["id"]})
    rec = await update(ctx, VISIT, vid, {"uhid_mapped": True, "uhid_linked_at": _stamp(), "uhid_linked_by": ctx.user.get("name"),
                                         "linked_from": {"id": temp["id"], "code": temp.get("code"), "name": temp.get("title")}})
    await audit(ctx, "er.link_uhid", module="er", entity="visits", record=rec,
                before={"patient": temp.get("code"), "name": temp.get("title")},
                after={"patient": target.get("code"), "name": target.get("title"), "merge_request": mr.get("code")}, note=body.note)
    return {"visit": {"id": vid, "code": rec.get("code")}, "patient": {"id": target["id"], "code": target.get("code"), "title": target.get("title")},
            "merge_request": {"id": mr["id"], "code": mr.get("code")}}


# ================================================================== orders & medicines

@router.get("/visits/{vid}/orders")
async def visit_orders(vid: str, ctx: CtxDep):
    _need_clinical(ctx)
    await _visit(ctx, vid)
    from .inventory import item_label, items_by_id
    from .orders import _employee_names, _order_query
    from .orders import _row as order_row

    rows = (await ctx.conn.execute(_order_query().where(orders.c.encounter_id == vid).order_by(orders.c.ordered_at.desc()).limit(300))).all()
    names = await _employee_names(ctx, rows)
    ts = now()
    items = [order_row(r, ts, ctx.user_id, names) for r in rows]
    ent = E(INDENT)
    t = ent.table
    ind = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(t).where(
        *rs.base_where(ent), t.c.data["er_visit"].astext == vid).order_by(t.c.created_at.desc()))).all()]
    drugs = await items_by_id(ctx, [ln.get("item") for i in ind for ln in i.get("items") or []])
    medicines = []
    for i in ind:
        dosing = {d.get("item"): d for d in i.get("orders") or []}
        for ln in i.get("items") or []:
            d = dosing.get(ln.get("item")) or {}
            medicines.append({"indent_id": i["id"], "indent_code": i.get("code"), "status": i.get("status"), "priority": i.get("priority"),
                              "item_id": ln.get("item"), "drug": item_label(drugs.get(ln.get("item"))), "qty": ln.get("qty"),
                              "issued_qty": ln.get("issued_qty"), "dose": d.get("dose"), "route": d.get("route"),
                              "frequency": d.get("frequency"), "instructions": d.get("instructions"), "ordered_at": i.get("created_at"),
                              "ordered_by": i.get("ordered_by")})
    return {"investigations": [x for x in items if x["category"] in ("LAB", "RAD")],
            "procedures": [x for x in items if x["category"] not in ("LAB", "RAD")], "medicines": medicines}


class MedLine(BaseModel):
    item: str
    qty: float = Field(gt=0, le=1000)
    dose: str | None = Field(default=None, max_length=100)
    route: str | None = Field(default=None, max_length=40)
    frequency: str | None = Field(default=None, max_length=40)
    instructions: str | None = Field(default=None, max_length=300)


class MedIn(BaseModel):
    items: list[MedLine] = Field(min_length=1, max_length=25)
    priority: Literal["Routine", "Urgent", "STAT"] = "STAT"
    remarks: str | None = Field(default=None, max_length=500)
    override_reason: str | None = Field(default=None, max_length=300)


@router.post("/visits/{vid}/medicines", status_code=201)
async def order_medicines(vid: str, body: MedIn, ctx: CtxDep):
    """ER medicine order → patient-specific indent to the IP pharmacy (issue posts the charges to this visit)."""
    _need(ctx, "orders")
    v = await _visit(ctx, vid)
    _active_only(v, "Ordering medicines")
    ids = [ln.item for ln in body.items]
    if len(set(ids)) != len(ids):
        raise bad_request("The same medicine is listed twice")
    from .pharmacy import safety_check

    chk = await safety_check(ctx, patient_id=v["patient_id"], lines=[{"item_id": ln.item, "qty": ln.qty} for ln in body.items],
                             purpose="prescribe", store="IP Pharmacy")
    severe = [a for a in chk["alerts"] if a["severity"] in ("Contraindicated", "Major")]
    if severe and not (body.override_reason or "").strip():
        raise ApiError(409, f"{len(severe)} drug safety alert(s) need review", {"alerts": chk["alerts"]}, code="SAFETY_ALERTS")
    ward = None
    if v.get("bed_id"):
        b = await get(ctx, BED, v["bed_id"])
        ward = b.get("ward_id") if b else None
    if not ward:
        wards = await _er_wards(ctx)
        ward = wards[0]["id"] if wards else None
    if not ward:
        raise conflict("No emergency ward is configured for pharmacy indents")
    rec = await create(ctx, INDENT, {
        "ward": ward, "patient_id": v["patient_id"], "indent_type": "Patient-specific", "priority": body.priority,
        "required_by": _stamp(), "items": [{"item": ln.item, "qty": ln.qty} for ln in body.items],
        "remarks": body.remarks or f"ER {v.get('code')}", "requested_by": ctx.user.get("employee_id"), "status": "Raised",
        "er_visit": vid, "er_code": v.get("code"), "orders": [ln.model_dump() for ln in body.items], "ordered_by": ctx.user.get("name"),
        "safety_override": (body.override_reason or "").strip() or None,
    })
    if severe:
        await audit(ctx, "er.medicine_override", module="er", entity="visits", record=v,
                    after={"indent": rec.get("code"), "alerts": [a.get("message") for a in severe]}, note=body.override_reason)
    return rec


# ================================================================== disposition & closure

class AdmitIn(BaseModel):
    bed_id: str
    doctor_id: str
    department_id: str
    diagnosis: str | None = Field(default=None, max_length=500)
    payer: str | None = None
    expected_los: int | None = Field(default=None, ge=0, le=365)
    isolation: str | None = None
    attendant_name: str | None = Field(default=None, max_length=200)
    attendant_phone: str | None = None


class DispositionIn(BaseModel):
    disposition: str
    provisional_diagnosis: str | None = Field(default=None, max_length=500)
    condition_at_disposition: str | None = None
    disposition_notes: str | None = Field(default=None, max_length=10000)
    followup_advice: str | None = Field(default=None, max_length=1000)
    referred_to: str | None = Field(default=None, max_length=300)
    transfer_reason: str | None = Field(default=None, max_length=500)
    transport_mode: str | None = None
    lama_reason: str | None = Field(default=None, max_length=500)
    consent_by: str | None = Field(default=None, max_length=200)
    risks_explained: bool | None = None
    time_of_death: str | None = None
    cause_of_death: str | None = Field(default=None, max_length=500)
    absconded_noticed_at: str | None = None
    security_informed: bool | None = None
    admit: AdmitIn | None = None


def _required_for(cfg: dict, dispo: str) -> list[str]:
    t = (cfg.get("disposition", {}).get("types") or {}).get(dispo) or {}
    return list(t.get("required") or [])


async def _carry_charges(ctx, v: dict, admission: dict) -> int:
    res = await ctx.conn.execute(charges.update().where(
        charges.c.encounter_id == v["id"], charges.c.status == "Unbilled", charges.c.deleted_at.is_(None)).values(
        encounter_id=admission["id"], updated_at=now(), updated_by=ctx.user_id))
    n = res.rowcount or 0
    if n:
        await audit(ctx, "er.charges_carried", module="er", entity="visits", record=v,
                    after={"admission": admission.get("code"), "charges": n})
    return n


async def _close(ctx, v: dict, *, note: str | None = None, override: str | None = None) -> dict:
    await update(ctx, VISIT, v["id"], {"closure_note": note, "closure_override": override})
    return await transition(ctx, VISIT, v["id"], "Closed", note=note or override)


@router.post("/visits/{vid}/disposition")
async def dispose(vid: str, body: DispositionIn, ctx: CtxDep):
    _need(ctx, "abscond" if body.disposition == "Absconded" else "dispose")
    cfg = await er_settings(ctx)
    v = await _visit(ctx, vid)
    _active_only(v, "Recording the disposition")
    types = cfg["disposition"].get("types") or {}
    if body.disposition not in (E(VISIT).field_map["disposition"].options or []) or not (types.get(body.disposition) or {}).get("enabled", True):
        raise bad_request("Choose a disposition", {"fields": {"disposition": "Invalid"}})
    vals = body.model_dump(exclude={"admit"}, exclude_none=True)
    for k in [k for k, x in vals.items() if isinstance(x, str) and not x.strip()]:
        vals.pop(k)
    missing = [k for k in _required_for(cfg, body.disposition) if vals.get(k) in (None, "", False)]
    if body.disposition == "Admitted" and not body.admit:
        missing.append("admit")
    if missing:
        labels = [_label(VISIT, k) if k != "admit" else "Admission details" for k in missing]
        raise bad_request(f"Fill {', '.join(labels)} for this disposition", {"fields": {k: "Required" for k in missing}})
    for k in ("time_of_death", "absconded_noticed_at"):
        if vals.get(k) and parse_dt(vals[k]) > now() + timedelta(minutes=5):
            raise bad_request(f"{_label(VISIT, k)} cannot be in the future", {"fields": {k: "In the future"}})
    admission = None
    if body.disposition == "Admitted" and body.admit:
        a = body.admit
        bed = await get(ctx, BED, a.bed_id) if is_uuid(a.bed_id) else None
        if not bed:
            raise not_found("Bed not found")
        if bed.get("category") == "ER":
            raise bad_request("Choose a ward / ICU bed — ER beds are not inpatient beds", {"fields": {"bed_id": "ER bed"}})
        await _employee(ctx, a.doctor_id, doctor=True)
        admission = await create(ctx, ADM, {
            "patient_id": v["patient_id"], "doctor_id": a.doctor_id, "department_id": a.department_id, "bed_id": a.bed_id,
            "admission_type": "Emergency", "admission_source": "ER",
            "diagnosis": a.diagnosis or body.provisional_diagnosis or v.get("provisional_diagnosis") or v.get("chief_complaint"),
            "payer": PAYER_TO_IP.get(a.payer or v.get("payer") or "Self-pay", "Cash"), "expected_los": a.expected_los,
            "mlc": bool(v.get("mlc")), "isolation": a.isolation or "None",
            "attendant_name": a.attendant_name or v.get("brought_by"), "attendant_phone": a.attendant_phone or v.get("attendant_phone"),
            "status": "Admitted", "er_visit": vid, "er_code": v.get("code"),
        })
        vals["admission"] = admission["id"]
    vals.update(disposition_by=ctx.user.get("name"), disposition_by_id=ctx.user.get("employee_id"))
    await update(ctx, VISIT, vid, vals)
    rec = await transition(ctx, VISIT, vid, "Disposed", note=f"Disposition: {body.disposition}")
    if body.disposition in ("Expired", "Brought dead"):
        p = await _patient(ctx, v["patient_id"])
        if p.get("status") in ("Active", "Inactive"):
            try:
                await transition(ctx, PFQN, p["id"], "Deceased", values={"date_of_death": body.time_of_death})
            except ApiError:
                await update(ctx, PFQN, p["id"], {"status": "Deceased", "date_of_death": body.time_of_death})
    carried = 0
    if admission and cfg["flow"].get("carry_charges_to_admission", True):
        carried = await _carry_charges(ctx, rec, admission)
    if admission and cfg["flow"].get("auto_close_on_admission", True):
        from .billing import clearance

        if (await clearance(ctx, vid))["cleared"]:
            rec = await _close(ctx, rec, note="Admitted — ER charges carried to the IP admission" if carried else "Admitted — nothing to bill in ER")
    await audit(ctx, "er.disposition", module="er", entity="visits", record=rec,
                after={"disposition": body.disposition, "admission": admission and admission.get("code"), "charges_carried": carried})
    return {"visit": rec, "admission": {"id": admission["id"], "code": admission.get("code")} if admission else None,
            "charges_carried": carried}


@router.get("/visits/{vid}/billing")
async def visit_billing(vid: str, ctx: CtxDep):
    _need(ctx, "view_billing")
    v = await _visit(ctx, vid)
    from .billing import clearance, deposit_balance

    c, s = charges, services
    cols = [c.c.id, c.c.code, c.c.status, c.c.qty, c.c.rate, c.c.amount, c.c.discount, c.c.charged_at, c.c.invoice_id, c.c.source,
            c.c.encounter_id, c.c.data, s.c.code.label("svc_code"), s.c.title.label("svc_name"), s.c.category.label("svc_category")]
    base = sa.select(*cols).select_from(c.outerjoin(s, s.c.id == c.c.service_id)).where(c.c.deleted_at.is_(None))
    linked = (await ctx.conn.execute(base.where(c.c.encounter_id == vid).order_by(c.c.charged_at.asc()))).all()
    unlinked = (await ctx.conn.execute(base.where(
        c.c.patient_id == v["patient_id"], c.c.encounter_id.is_(None), c.c.status == "Unbilled",
        c.c.charged_at >= parse_dt(v["started_at"])).order_by(c.c.charged_at.asc()))).all() if v.get("started_at") else []

    def line(r, attached: bool) -> dict:
        d = r.data or {}
        return {"id": str(r.id), "code": r.code, "status": r.status, "description": d.get("description"), "qty": _iso(r.qty),
                "rate": _iso(r.rate), "amount": _iso(r.amount), "discount": _iso(r.discount), "charged_at": _iso(r.charged_at),
                "invoice_id": str(r.invoice_id) if r.invoice_id else None, "source": r.source, "tax_percent": d.get("tax_percent"),
                "service": {"code": r.svc_code, "name": r.svc_name, "category": r.svc_category}, "attached": attached}

    i, pay = invoices, payments
    invs = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(i).where(
        i.c.encounter_id == vid, i.c.deleted_at.is_(None)).order_by(i.c.billed_at.asc()))).all()]
    inv_ids = [x["id"] for x in invs]
    pays = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(pay).where(
        pay.c.invoice_id.in_(inv_ids), pay.c.deleted_at.is_(None)).order_by(pay.c.paid_at.asc()))).all()] if inv_ids else []
    lines = [line(r, True) for r in linked] + [line(r, False) for r in unlinked]
    live_invs = [x for x in invs if x.get("status") != "Cancelled"]
    clr = await clearance(ctx, vid)
    unbilled = sum(float(x["amount"] or 0) for x in lines if x["status"] == "Unbilled")
    state = state_of(v)
    blockers = []
    if state == "Active":
        blockers.append("Record the disposition first")
    if unbilled:
        blockers.append("Unbilled charges — generate the ER bill")
    if float(clr.get("balance_due") or 0) > 0:
        blockers.append("Balance due on the ER bill")
    return {
        "state": state, "status": v.get("status"), "payer": v.get("payer") or "Self-pay",
        "lines": lines, "invoices": invs, "payments": pays, "clearance": clr,
        "totals": {"unbilled": round(unbilled, 2), "billed": round(sum(float(x.get("net") or 0) for x in live_invs), 2),
                   "paid": round(sum(float(x.get("paid") or 0) for x in live_invs), 2),
                   "balance": round(sum(float(x.get("balance") or 0) for x in live_invs), 2),
                   "deposit": float(await deposit_balance(ctx, v["patient_id"]))},
        "closable": state == "Awaiting billing" and not blockers, "blockers": blockers,
        "closed_at": v.get("closed_at"), "closed_by": v.get("closed_by"), "closure_note": v.get("closure_note"),
        "closure_override": v.get("closure_override"),
        "visit": await _desk_summary(ctx, vid),
        "permissions": {k: role_perms(ctx)[k] for k in ("bill", "close", "override_close")},
    }


def _desk_view(s: dict) -> dict:
    """Billing-desk view of a visit summary: identity, location, payer, outcome — no clinical detail."""
    return {k: s.get(k) for k in ("id", "code", "status", "state", "arrived_at", "minutes_in_er", "patient", "bed", "doctor", "payer",
                                  "mlc", "mlc_no", "disposition", "outcome", "bill", "current_step", "triage")}


async def _desk_summary(ctx, vid: str) -> dict | None:
    row = (await ctx.conn.execute(_visit_query().where(encounters.c.id == vid))).first()
    if not row:
        return None
    s = (await _summaries(ctx, [row], await er_settings(ctx), now()))[0]
    return s if role_perms(ctx)["view_clinical"] else _desk_view(s)


@router.get("/billing")
async def billing_worklist(ctx: CtxDep, state: str = "Awaiting billing", date_from: str | None = None, date_to: str | None = None,
                           q: str | None = None):
    """ER billing counter: visits awaiting billing (or closed / still in the ER) with their bill status."""
    _need(ctx, "view_billing")
    cfg = await er_settings(ctx)
    ts = now()
    e, p = encounters, patients
    stmt = _visit_query()
    if state == "Awaiting billing":
        stmt = stmt.where(e.c.status == "Disposed", e.c.data["disposed_at"].astext.isnot(None))
    elif state == "Closed":
        d0 = parse_date(date_from) if date_from else today()
        d1 = parse_date(date_to) if date_to else d0
        stmt = stmt.where(e.c.status == "Closed", e.c.data["closed_at"].astext >= d0.isoformat(),
                          e.c.data["closed_at"].astext < (d1 + timedelta(days=1)).isoformat())
    elif state == "Active":
        stmt = stmt.where(e.c.status.in_(ACTIVE))
    else:
        raise bad_request("Unknown state")
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(sa.or_(sa.func.lower(e.c.code).like(like), sa.func.lower(p.c.code).like(like), p.c.phone.like(like),
                                 sa.func.lower(sa.func.concat(p.c.first_name, " ", p.c.last_name)).like(like)))
    rows = (await ctx.conn.execute(stmt.order_by(e.c.started_at.desc()).limit(500))).all()
    out = [_desk_view(s) for s in await _summaries(ctx, rows, cfg, ts)]
    ids = [x["id"] for x in out]
    unbilled: dict[str, float] = {}
    if ids:
        unbilled = {str(eid): float(a or 0) for eid, a in (await ctx.conn.execute(
            sa.select(charges.c.encounter_id, sa.func.sum(charges.c.amount)).where(
                charges.c.encounter_id.in_(ids), charges.c.status == "Unbilled", charges.c.deleted_at.is_(None))
            .group_by(charges.c.encounter_id))).all()}
    for x in out:
        x["unbilled"] = unbilled.get(x["id"], 0.0)
    base = [e.c.type == "ER", e.c.deleted_at.is_(None)]
    counts = {
        "awaiting_billing": (await ctx.conn.execute(sa.select(sa.func.count()).select_from(e).where(
            *base, e.c.status == "Disposed", e.c.data["disposed_at"].astext.isnot(None)))).scalar_one(),
        "active": (await ctx.conn.execute(sa.select(sa.func.count()).select_from(e).where(*base, e.c.status.in_(ACTIVE)))).scalar_one(),
        "closed_today": (await ctx.conn.execute(sa.select(sa.func.count()).select_from(e).where(
            *base, e.c.status == "Closed", e.c.data["closed_at"].astext >= today().isoformat()))).scalar_one(),
    }
    return {"generated_at": ts.isoformat(timespec="seconds"), "rows": out, "counts": counts,
            "permissions": {k: role_perms(ctx)[k] for k in ("bill", "close", "override_close", "read")}}


class BillIn(BaseModel):
    payer: str | None = None
    discount_percent: float = Field(default=0, ge=0, le=100)
    discount_amount: float = Field(default=0, ge=0)
    discount_reason: str | None = Field(default=None, max_length=300)


@router.post("/visits/{vid}/bill", status_code=201)
async def make_bill(vid: str, body: BillIn, ctx: CtxDep):
    """ER bill from the visit's unbilled charges (charges posted without a visit since arrival are attached first)."""
    _need(ctx, "bill")
    v = await _visit(ctx, vid)
    from .billing import InvoiceIn, create_invoice

    if v.get("started_at"):
        await ctx.conn.execute(charges.update().where(
            charges.c.patient_id == v["patient_id"], charges.c.encounter_id.is_(None), charges.c.status == "Unbilled",
            charges.c.deleted_at.is_(None), charges.c.charged_at >= parse_dt(v["started_at"])).values(
            encounter_id=vid, updated_at=now(), updated_by=ctx.user_id))
    payer = PAYER_TO_BILL.get(body.payer or v.get("payer") or "Self-pay", "Self")
    inv = await create_invoice(InvoiceIn(patient_id=v["patient_id"], encounter_id=vid, type="OP", payer=payer,
                                         discount_percent=body.discount_percent, discount_amount=body.discount_amount,
                                         discount_reason=body.discount_reason), ctx)
    inv = await update(ctx, "billing.invoices", inv["id"], {"er_visit": vid, "er_code": v.get("code"), "bill_kind": "ER"})
    await update(ctx, VISIT, vid, {"bill": inv["id"]})
    return inv


class CloseIn(BaseModel):
    note: str | None = Field(default=None, max_length=500)
    override_reason: str | None = Field(default=None, max_length=300)


@router.post("/visits/{vid}/close")
async def close_visit(vid: str, body: CloseIn, ctx: CtxDep):
    _need(ctx, "close")
    v = await _visit(ctx, vid)
    if v.get("status") != "Disposed":
        raise conflict("Only a disposed ER visit (awaiting billing) can be closed")
    from .billing import clearance

    clr = await clearance(ctx, vid)
    override = (body.override_reason or "").strip() or None
    if not clr["cleared"]:
        if not override:
            raise ApiError(409, "Billing is not cleared — bill the charges and collect the balance, or give an override reason",
                           clr, code="BILLING_NOT_CLEARED")
        _need(ctx, "override_close")
    rec = await _close(ctx, v, note=body.note, override=override if not clr["cleared"] else None)
    await audit(ctx, "er.close", module="er", entity="visits", record=rec, after={"clearance": clr}, note=override or body.note)
    return rec


# ================================================================== documents, handover, print

class DocIn(BaseModel):
    file_id: str
    category: str = "Uncategorised"
    note: str | None = Field(default=None, max_length=300)


@router.post("/visits/{vid}/documents", status_code=201)
async def attach_document(vid: str, body: DocIn, ctx: CtxDep):
    _need(ctx, "documents")
    v = await _visit(ctx, vid)
    cfg = await er_settings(ctx)
    cats = cfg["documents"].get("categories") or ["Uncategorised"]
    if body.category not in cats:
        raise bad_request("Choose a document category", {"fields": {"category": "Invalid"}})
    f = (await ctx.conn.execute(sa.select(files.c.id, files.c.name, files.c.mime, files.c.size, files.c.patient_id)
                                .where(files.c.id == body.file_id, files.c.deleted_at.is_(None)))).first() if is_uuid(body.file_id) else None
    if not f:
        raise not_found("Uploaded file not found")
    if f.patient_id and str(f.patient_id) != v["patient_id"]:
        raise bad_request("This file belongs to another patient")
    docs = list(v.get("documents") or [])
    if any(d.get("file_id") == body.file_id for d in docs):
        raise conflict("This file is already attached")
    docs.append({"file_id": body.file_id, "name": f.name, "mime": f.mime, "size": f.size, "category": body.category, "note": body.note,
                 "uploaded_at": _stamp(), "uploaded_by": ctx.user.get("name")})
    return await update(ctx, VISIT, vid, {"documents": docs})


@router.delete("/visits/{vid}/documents/{fid}")
async def detach_document(vid: str, fid: str, ctx: CtxDep, reason: str | None = None):
    _need(ctx, "documents")
    v = await _visit(ctx, vid)
    docs = list(v.get("documents") or [])
    keep = [d for d in docs if d.get("file_id") != fid]
    if len(keep) == len(docs):
        raise not_found("Document not attached to this visit")
    if len((reason or "").strip()) < 3:
        raise bad_request("Give a reason for removing the document")
    rec = await update(ctx, VISIT, vid, {"documents": keep})
    await audit(ctx, "er.document_removed", module="er", entity="visits", record=rec, before={"file_id": fid}, note=reason)
    return rec


class HandoverIn(BaseModel):
    shift: str
    situation: str = Field(min_length=2, max_length=2000)
    background: str | None = Field(default=None, max_length=2000)
    assessment: str | None = Field(default=None, max_length=2000)
    recommendation: str | None = Field(default=None, max_length=2000)
    handed_over_to: str | None = None


@router.post("/visits/{vid}/handover", status_code=201)
async def add_handover(vid: str, body: HandoverIn, ctx: CtxDep):
    _need(ctx, "handover")
    v = await _visit(ctx, vid)
    _active_only(v, "Handover")
    if body.handed_over_to:
        await _employee(ctx, body.handed_over_to)
    return await create(ctx, HANDOVER, {**body.model_dump(), "patient_id": v["patient_id"], "encounter_id": vid, "handover_at": _stamp(),
                                        "handed_over_by": ctx.user.get("employee_id"), "status": "Handed Over"})


class PrintIn(BaseModel):
    document: Literal["case-sheet", "nursing", "discharge-summary", "mlc", "handover", "triage", "registration"]


@router.post("/visits/{vid}/print")
async def printed(vid: str, body: PrintIn, ctx: CtxDep):
    if not (role_perms(ctx)["read"] or role_perms(ctx)["view_billing"]):
        _need(ctx, "read")
    v = await _visit(ctx, vid)
    if body.document == "mlc":
        _need(ctx, "mlc")
    elif body.document != "registration":
        _need_clinical(ctx)
    await audit(ctx, "print", module="er", entity="visits", record=v, note=body.document)
    return {"ok": True}


__all__ = ["router", "er_settings", "triage_info", "state_of", "steps_of", "doctor_pool", "DEFAULT_SETTINGS"]
