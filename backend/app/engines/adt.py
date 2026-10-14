"""ADT & bed management: admission / transfer / discharge rules, bed requests and reservations,
housekeeping bed turnaround, transport TAT, the live bed board and the discharge board
(checklist, billing clearance, pharmacy returns and discharge TAT)."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

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
    forbidden,
    is_uuid,
    minutes_between,
    not_found,
    now,
    parse_dt,
    to_json_value,
    today,
)
from ..schema import beds, employees, encounters, orders, patients, records
from ._common import E, count, create, find, first, get, has, live, require_role, transition, update
from .billing import clearance

router = APIRouter(prefix="/api/adt", tags=["adt"])

ADM, BED, TRF, BRQ = "ipd.admissions", "ipd.beds", "ipd.transfers", "ipd.bed_requests"
CHK, SUMMARY, HKR = "discharge.checklists", "discharge.summaries", "housekeeping.requests"
RETURNS, ALLERGIES, TRANSPORT = "pharmacy.returns", "emr.allergies", "transport.requests"

OPEN = ("Admitted", "Discharge Initiated")
OFF_LINE = ("Blocked", "Maintenance")
BED_STATUSES = ("Vacant", "Occupied", "Reserved", "Cleaning", "Blocked", "Maintenance")
TURNAROUND = "Bed turnaround"
DISCHARGE_TAT_TARGET = 180  # NABH: discharge order → patient leaves the ward within 3 hours

# Who may sign off each discharge checklist item (admin may sign any).
ITEM_ROLES: dict[str, set[str]] = {
    "summary_ready": {"doctor", "nurse"},
    "medications_reconciled": {"doctor", "nurse", "pharmacist"},
    "pharmacy_returns_done": {"pharmacist", "nurse"},
    "billing_cleared": {"billing"},
    "nursing_clearance": {"nurse"},
    "belongings_returned": {"nurse"},
    "follow_up_booked": {"nurse", "doctor"},
    "education_given": {"nurse", "doctor"},
}
DEFAULT_ITEM_ROLES = {"doctor", "nurse"}
# Items that cannot apply to these discharge types.
NOT_APPLICABLE: dict[str, set[str]] = {
    "Death": {"follow_up_booked", "education_given"},
    "Absconded": {"follow_up_booked", "education_given"},
}
_RESERVATION_KEYS = ("reserved_for", "reserved_request", "reserved_ref", "reserved_reason")


def _stamp() -> str:
    return now().isoformat(timespec="seconds")


@contextmanager
def _engine_write(ctx) -> Iterator[None]:
    """Marks writes made by this engine so the manual-edit guards let them through."""
    d = ctx.__dict__
    d["_adt_depth"] = d.get("_adt_depth", 0) + 1
    try:
        yield
    finally:
        d["_adt_depth"] -= 1


def _by_engine(ctx) -> bool:
    return ctx.__dict__.get("_adt_depth", 0) > 0


def _name(first_name: str | None, last_name: str | None) -> str:
    return " ".join(x for x in (first_name, last_name) if x) or "—"


# ================================================================== beds

def _bed_label(b: dict) -> str:
    return b.get("bed_no") or b.get("code") or "?"


async def _bed(ctx, bed_id: str | None) -> dict:
    b = await get(ctx, BED, bed_id) if bed_id else None
    if not b:
        raise not_found("Bed not found")
    return b


def _check_available(b: dict, patient_id: str | None, field: str) -> None:
    st = b.get("status")
    if st == "Vacant" or (st == "Reserved" and b.get("reserved_for") in (None, patient_id)):
        return
    why = "reserved for another patient" if st == "Reserved" else str(st).lower()
    raise ApiError(409, f"Bed {_bed_label(b)} is {why} — choose a vacant bed", {"fields": {field: f"Bed is {st}"}})


async def _set_bed(ctx, bed_id: str, status: str, **data: Any) -> dict:
    with _engine_write(ctx):
        return await update(ctx, BED, bed_id, {"status": status, **data})


async def _release(ctx, bed_id: str | None, holder_id: str) -> None:
    """Free a bed that was reserved for a bed request / transfer that no longer needs it."""
    b = await get(ctx, BED, bed_id) if bed_id else None
    if b and b.get("status") == "Reserved" and b.get("reserved_request") == holder_id:
        await _set_bed(ctx, b["id"], "Vacant")


async def _reserve(ctx, bed_id: str, *, patient_id: str, holder: dict, reason: str) -> None:
    await _set_bed(ctx, bed_id, "Reserved", reserved_for=patient_id, reserved_request=holder["id"],
                   reserved_ref=holder.get("code"), reserved_reason=reason)


async def _holds_bed(ctx, enc_id: str | None, bed_id: str) -> bool:
    if not enc_id or not is_uuid(enc_id):
        return False
    e = encounters
    row = (await ctx.conn.execute(sa.select(e.c.id).where(
        e.c.id == enc_id, e.c.bed_id == bed_id, e.c.status.in_(OPEN), e.c.deleted_at.is_(None)))).first()
    return row is not None


@hook(BED, "before_update")
async def _bed_rules(ctx, nxt: dict, prev: dict) -> None:
    old, new = prev.get("status"), nxt.get("status")
    if old == new:
        return
    if new == "Occupied" and not nxt.get("current_encounter"):
        raise conflict("A bed becomes Occupied only through an admission or a transfer")
    if old == "Occupied" and await _holds_bed(ctx, prev.get("current_encounter"), prev["id"]):
        raise conflict(f"Bed {_bed_label(prev)} has an active admission — transfer or discharge the patient first")
    if old == "Reserved" and prev.get("reserved_request") and not _by_engine(ctx):
        raise conflict(f"Bed {_bed_label(prev)} is held for {prev.get('reserved_ref') or 'a request'} — cancel that request to release it")
    if nxt.get("status_since") == prev.get("status_since"):
        nxt["status_since"] = _stamp()
    if new != "Occupied":
        nxt["current_patient"] = nxt["current_encounter"] = None
    if new != "Reserved":
        for k in _RESERVATION_KEYS:
            nxt.pop(k, None)
    if new not in OFF_LINE:
        nxt.pop("block_reason", None)


@hook(BED, "after_update")
async def _bed_changed(ctx, rec: dict, prev: dict) -> None:
    if rec.get("status") != prev.get("status"):
        live(ctx, "beds", {"bed_id": rec["id"], "bed_no": rec.get("bed_no"), "ward_id": rec.get("ward_id"),
                           "status": rec.get("status"), "previous": prev.get("status"), "patient_id": rec.get("current_patient")})


# ================================================================== admissions

async def _open_admission(ctx, patient_id: str) -> dict | None:
    return await first(ctx, ADM, patient_id=patient_id, status=list(OPEN))


@hook(ADM, "before_create")
async def _before_admit(ctx, draft: dict) -> None:
    pid = draft.get("patient_id")
    p = (await ctx.conn.execute(sa.select(patients.c.status, patients.c.title).where(
        patients.c.id == pid, patients.c.deleted_at.is_(None)))).first()
    if not p:
        raise not_found("Patient not found")
    if p.status in ("Merged", "Deceased"):
        raise conflict(f"Cannot admit: this patient record is marked {p.status.lower()}")
    # Seeded / migrated history may contain overlapping stays; every live admission is checked.
    if ctx.user_id != "system":
        cur = await _open_admission(ctx, pid)
        if cur:
            raise ApiError(409, f"{p.title} is already admitted ({cur['code']}) — use a transfer to change the bed",
                           {"admission_id": cur["id"]}, code="ALREADY_ADMITTED")
    _check_available(await _bed(ctx, draft.get("bed_id")), pid, "bed_id")
    draft["started_at"] = draft.get("started_at") or _stamp()


@hook(ADM, "after_create")
async def _after_admit(ctx, rec: dict) -> None:
    await _set_bed(ctx, rec["bed_id"], "Occupied", current_patient=rec["patient_id"], current_encounter=rec["id"],
                   status_since=rec.get("started_at") or _stamp())
    for r in await find(ctx, BRQ, patient_id=rec["patient_id"], status=["Pending", "Allocated"], limit=20):
        with _engine_write(ctx):
            await update(ctx, BRQ, r["id"], {"status": "Fulfilled", "admission": rec["id"], "fulfilled_at": _stamp()})
        if r.get("allocated_bed") and r["allocated_bed"] != rec["bed_id"]:
            await _release(ctx, r["allocated_bed"], r["id"])


@hook(ADM, "before_update")
async def _guard_admission_edit(ctx, nxt: dict, prev: dict) -> None:
    if nxt.get("bed_id") != prev.get("bed_id") and not _by_engine(ctx):
        raise ApiError(409, "Use a transfer to move the patient to another bed", {"fields": {"bed_id": "Change beds through a transfer"}})


@hook("ipd.encounters", "before_transition")
async def _guard_encounter_status(ctx, nxt: dict, prev: dict) -> None:
    if prev.get("type") == "IPD":
        raise conflict("Change an inpatient's status from Admissions (discharge checks and bed release run there)")


@hook(ADM, "before_transition")
async def _before_admission_transition(ctx, nxt: dict, prev: dict) -> None:
    to = nxt["status"]
    if to == "Discharge Initiated":
        nxt.update(discharge_initiated_at=_stamp(), discharge_initiated_by=ctx.user.get("name"))
    elif to == "Admitted":
        nxt.update(discharge_initiated_at=None, discharge_revoked_at=_stamp())
    elif to == "Discharged":
        r = await readiness(ctx, nxt)
        if not r["ready"]:
            raise ApiError(409, "Discharge blocked — " + "; ".join(r["pending"]), {"pending": r["pending"]}, code="DISCHARGE_NOT_READY")
        chk = r["checklist"]
        if chk and chk["status"] != "Complete":
            with _engine_write(ctx):
                await transition(ctx, CHK, chk["id"], "Complete", note="Cleared at discharge")
        ended = now()
        nxt["ended_at"] = ended.isoformat(timespec="seconds")
        nxt["discharge_tat_minutes"] = minutes_between(r["initiated_at"], ended) if r["initiated_at"] else None
    elif to == "Cancelled":
        nxt["ended_at"] = _stamp()


@hook(ADM, "after_transition")
async def _after_admission_transition(ctx, rec: dict, prev: dict) -> None:
    to = rec["status"]
    if to == "Discharge Initiated":
        chk = await ensure_checklist(ctx, rec)
        await emit("discharge.initiated", ctx, {"encounter": rec, "checklist": chk})
    elif to == "Discharged":
        hk = await _vacate(ctx, rec, reason="Discharge")
        await emit("discharge.done", ctx, {"encounter": rec, "housekeeping_request": hk})
    elif to == "Cancelled":
        b = await get(ctx, BED, rec.get("bed_id")) if rec.get("bed_id") else None
        if b and b.get("status") == "Occupied" and b.get("current_encounter") in (None, rec["id"]):
            await _set_bed(ctx, b["id"], "Vacant")


async def _vacate(ctx, enc: dict, *, reason: str, bed_id: str | None = None) -> dict | None:
    """Patient left the bed: bed → Cleaning and a housekeeping turnaround request is raised."""
    bid = bed_id or enc.get("bed_id")
    b = await get(ctx, BED, bid) if bid else None
    if not b or b.get("status") != "Occupied" or b.get("current_encounter") not in (None, enc["id"]):
        return None
    await _set_bed(ctx, b["id"], "Cleaning")
    iso = enc.get("isolation") if enc.get("isolation") not in (None, "", "None") else (
        "Contact" if b.get("category") == "Isolation" else "None")
    waiting = await count(ctx, BRQ, status="Pending")
    room = f", room {b['room_no']}" if b.get("room_no") else ""
    return await create(ctx, HKR, {
        "request_type": TURNAROUND, "ward": b.get("ward_id"), "bed": b["id"], "location": f"Bed {_bed_label(b)}{room}",
        "priority": "Urgent" if waiting else "Routine", "isolation_precautions": iso, "requested_at": _stamp(),
        "remarks": f"{reason} of {enc.get('code')}" + ("; terminal cleaning (isolation)" if iso != "None" else ""),
        "source_encounter": enc["id"], "status": "Open",
    })


# ================================================================== discharge checklist & readiness

def _items() -> list[tuple[str, str]]:
    return [(f.key, f.label) for f in E(CHK).fields if f.type == "boolean"]


def _not_applicable(chk: dict | None, discharge_type: str | None = None) -> set[str]:
    return NOT_APPLICABLE.get((chk or {}).get("discharge_type") or discharge_type or "", set())


async def ensure_checklist(ctx, enc: dict) -> dict:
    """The encounter's discharge checklist, created (or re-opened) with the discharge order time."""
    payload = {"discharge_ordered_at": enc.get("discharge_initiated_at") or _stamp(),
               "discharge_type": enc.get("discharge_type") or "Routine"}
    chk = await first(ctx, CHK, encounter_id=enc["id"], sort="-created_at")
    with _engine_write(ctx):
        if not chk:
            return await create(ctx, CHK, {"patient_id": enc["patient_id"], "encounter_id": enc["id"], "delay_reason": "None",
                                           "status": "Open", **payload})
        if chk.get("status") == "Complete":
            payload.update(status="Open", cleared_at=None, tat_minutes=None)
        return await update(ctx, CHK, chk["id"], payload)


@hook(CHK, "before_update")
async def _checklist_signoff(ctx, nxt: dict, prev: dict) -> None:
    changed = [(k, label) for k, label in _items() if bool(nxt.get(k)) != bool(prev.get(k))]
    if not changed:
        return
    if not _by_engine(ctx):
        if prev.get("status") == "Complete":
            raise conflict("This checklist is already cleared for discharge")
        if ctx.role != "admin":
            denied = [label for k, label in changed if ctx.role not in ITEM_ROLES.get(k, DEFAULT_ITEM_ROLES)]
            if denied:
                raise forbidden(f"Your role cannot sign off: {', '.join(denied)}")
    signoffs = dict(prev.get("signoffs") or {})
    for k, _ in changed:
        if nxt.get(k):
            signoffs[k] = {"by": ctx.user.get("name"), "role": ctx.role, "at": _stamp()}
        else:
            signoffs.pop(k, None)
    nxt["signoffs"] = signoffs


@hook(CHK, "before_transition")
async def _checklist_complete(ctx, nxt: dict, prev: dict) -> None:
    if nxt["status"] != "Complete":
        return
    na = _not_applicable(nxt)
    missing = [label for k, label in _items() if k not in na and not nxt.get(k)]
    if missing:
        raise ApiError(409, "Pending checklist items: " + ", ".join(missing), {"pending": missing})
    if nxt.get("discharge_ordered_at"):
        nxt["tat_minutes"] = minutes_between(nxt["discharge_ordered_at"], nxt.get("cleared_at") or _stamp())


@hook(SUMMARY, "after_transition")
async def _summary_issued(ctx, rec: dict, prev: dict) -> None:
    if rec.get("status") != "Issued" or not rec.get("encounter_id"):
        return
    chk = await first(ctx, CHK, encounter_id=rec["encounter_id"], status="Open")
    if chk and not chk.get("summary_ready"):
        with _engine_write(ctx):
            await update(ctx, CHK, chk["id"], {"summary_ready": True})


def _item_states(chk: dict | None, discharge_type: str | None) -> list[dict]:
    na = _not_applicable(chk, discharge_type)
    signoffs = (chk or {}).get("signoffs") or {}
    return [{"key": k, "label": label, "done": bool(chk and chk.get(k)), "applicable": k not in na,
             "roles": sorted(ITEM_ROLES.get(k, DEFAULT_ITEM_ROLES)), "signoff": signoffs.get(k)} for k, label in _items()]


def _pending(chk: dict | None, items: list[dict], bill: dict | None, returns: list[dict]) -> list[str]:
    out: list[str] = []
    if not chk:
        out.append("Discharge checklist not started")
    else:
        out += [f"Checklist: {i['label']}" for i in items if i["applicable"] and not i["done"]]
    if bill and not bill["cleared"]:
        parts = []
        if bill.get("unbilled_count"):
            parts.append(f"{bill['unbilled_count']} unbilled charge(s) ₹{float(bill.get('unbilled_amount') or 0):,.2f}")
        if float(bill.get("balance_due") or 0) > 0:
            parts.append(f"balance due ₹{float(bill['balance_due']):,.2f}")
        out.append("Billing: " + (", ".join(parts) or "not cleared"))
    if returns:
        out.append(f"Pharmacy: {len(returns)} return(s) awaiting acceptance ({', '.join(r['code'] for r in returns[:3])})")
    return out


def _checklist_brief(chk: dict | None) -> dict | None:
    if not chk:
        return None
    keys = ("id", "code", "status", "discharge_type", "discharge_ordered_at", "expected_discharge_at", "delay_reason",
            "cleared_at", "tat_minutes", "remarks")
    return {k: chk.get(k) for k in keys}


def _summary_brief(s: dict | None) -> dict | None:
    return {k: s.get(k) for k in ("id", "code", "status", "final_diagnosis", "ai_drafted")} if s else None


async def _pending_returns(ctx, patient_ids: list[str]) -> dict[str, list[dict]]:
    ids = [p for p in patient_ids if p and is_uuid(p)]
    if not ids or not has(RETURNS):
        return {}
    ent = E(RETURNS)
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.patient_id).where(
        *rs.base_where(ent), t.c.status == "Requested", t.c.patient_id.in_(ids)))).all()
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[str(r.patient_id)].append({"id": str(r.id), "code": r.code})
    return out


async def readiness(ctx, enc: dict) -> dict:
    chk = await first(ctx, CHK, encounter_id=enc["id"], sort="-created_at")
    items = _item_states(chk, enc.get("discharge_type"))
    bill = await clearance(ctx, enc["id"])
    returns = (await _pending_returns(ctx, [enc["patient_id"]])).get(enc["patient_id"], [])
    summary = await first(ctx, SUMMARY, encounter_id=enc["id"], sort="-created_at") if has(SUMMARY) else None
    pending = _pending(chk, items, bill, returns)
    initiated = enc.get("discharge_initiated_at") or (chk or {}).get("discharge_ordered_at")
    end = enc.get("ended_at") if enc.get("status") == "Discharged" and enc.get("ended_at") else now()
    return {"ready": not pending, "pending": pending, "checklist": _checklist_brief(chk), "items": items, "billing": bill,
            "pharmacy_returns": returns, "summary": _summary_brief(summary), "initiated_at": initiated,
            "tat_minutes": minutes_between(initiated, end) if initiated else None, "target_minutes": DISCHARGE_TAT_TARGET}


async def _admission(ctx, eid: str) -> dict:
    enc = await get(ctx, ADM, eid)
    if not enc:
        raise not_found("Admission not found")
    return enc


@router.get("/encounters/{eid}/discharge-readiness")
async def discharge_readiness(eid: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(ADM), "read")
    enc = await _admission(ctx, eid)
    p = (await ctx.conn.execute(sa.select(patients.c.code, patients.c.first_name, patients.c.last_name, patients.c.gender,
                                          patients.c.dob).where(patients.c.id == enc["patient_id"]))).first()
    b = await get(ctx, BED, enc.get("bed_id")) if enc.get("bed_id") else None
    return {
        "encounter": {k: enc.get(k) for k in ("id", "code", "status", "patient_id", "started_at", "ended_at", "discharge_type",
                                              "discharge_initiated_at", "discharge_tat_minutes", "doctor_id", "payer")},
        "patient": {"id": enc["patient_id"], "uhid": p.code, "name": _name(p.first_name, p.last_name), "gender": p.gender,
                    "age": age_from(p.dob)} if p else None,
        "bed": {"id": b["id"], "bed_no": b.get("bed_no"), "status": b.get("status")} if b else None,
        **await readiness(ctx, enc),
    }


@router.post("/encounters/{eid}/checklist")
async def start_checklist(eid: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(CHK), "write")
    enc = await _admission(ctx, eid)
    if enc["status"] not in OPEN:
        raise conflict(f"Admission is {enc['status']}")
    existing = await first(ctx, CHK, encounter_id=eid, sort="-created_at")
    return existing if existing and existing.get("status") == "Open" else await ensure_checklist(ctx, enc)


class DischargeIn(BaseModel):
    note: str | None = Field(default=None, max_length=500)


@router.post("/encounters/{eid}/discharge")
async def discharge(eid: str, body: DischargeIn, ctx: CtxDep):
    """One-click discharge from the discharge board: verifies readiness, clears the checklist,
    discharges the admission and starts the bed turnaround — all in one transaction."""
    rs.ensure_access(ctx, E(ADM), "write")
    enc = await _admission(ctx, eid)
    if enc["status"] != "Discharge Initiated":
        raise conflict(f"Initiate discharge first (admission is {enc['status']})")
    rec = await transition(ctx, ADM, eid, "Discharged", note=body.note)
    hk = await first(ctx, HKR, source_encounter=eid, sort="-created_at") if rec.get("bed_id") else None
    return {"admission": rec, "turnaround_request": {"id": hk["id"], "code": hk["code"]} if hk else None}


# ================================================================== transfers

@hook(TRF, "before_create")
async def _before_transfer(ctx, draft: dict) -> None:
    adm = await get(ctx, ADM, draft.get("encounter_id")) if draft.get("encounter_id") else None
    if not adm or adm["status"] not in OPEN:
        raise conflict("Only an active admission can be transferred")
    if adm["patient_id"] != draft.get("patient_id"):
        raise bad_request("This admission belongs to another patient", {"fields": {"encounter_id": "Wrong patient"}})
    pending = await first(ctx, TRF, encounter_id=adm["id"], status="Requested")
    if pending:
        raise conflict(f"Transfer {pending['code']} is already pending for this admission")
    draft["from_bed"] = adm.get("bed_id")
    if draft.get("to_bed") == draft["from_bed"]:
        raise bad_request("The patient is already in this bed", {"fields": {"to_bed": "Choose a different bed"}})
    _check_available(await _bed(ctx, draft.get("to_bed")), adm["patient_id"], "to_bed")


@hook(TRF, "after_create")
async def _hold_transfer_bed(ctx, rec: dict) -> None:
    b = await _bed(ctx, rec["to_bed"])
    if b.get("status") == "Vacant":
        await _reserve(ctx, b["id"], patient_id=rec["patient_id"], holder=rec, reason="Transfer")


@hook(TRF, "before_transition")
async def _before_transfer_transition(ctx, nxt: dict, prev: dict) -> None:
    if nxt["status"] != "Completed":
        return
    adm = await get(ctx, ADM, nxt.get("encounter_id"))
    if not adm or adm["status"] not in OPEN:
        raise conflict("The admission is no longer active")
    if adm.get("bed_id") != nxt.get("from_bed"):
        raise conflict("The patient has moved since this transfer was requested — raise a new transfer")
    _check_available(await _bed(ctx, nxt.get("to_bed")), adm["patient_id"], "to_bed")
    nxt["completed_at"] = _stamp()


@hook(TRF, "after_transition")
async def _after_transfer_transition(ctx, rec: dict, prev: dict) -> None:
    if rec["status"] == "Cancelled":
        await _release(ctx, rec.get("to_bed"), rec["id"])
        return
    if rec["status"] != "Completed":
        return
    with _engine_write(ctx):
        adm = await update(ctx, ADM, rec["encounter_id"], {"bed_id": rec["to_bed"]})
    await _vacate(ctx, adm, reason=f"Transfer {rec.get('code')}", bed_id=rec.get("from_bed"))
    await _set_bed(ctx, rec["to_bed"], "Occupied", current_patient=adm["patient_id"], current_encounter=adm["id"])


# ================================================================== bed requests

@hook(BRQ, "before_transition")
async def _before_allocate(ctx, nxt: dict, prev: dict) -> None:
    if nxt["status"] == "Allocated":
        _check_available(await _bed(ctx, nxt.get("allocated_bed")), nxt.get("patient_id"), "allocated_bed")


@hook(BRQ, "after_transition")
async def _after_bed_request(ctx, rec: dict, prev: dict) -> None:
    if rec["status"] == "Allocated":
        b = await _bed(ctx, rec["allocated_bed"])
        if b.get("status") == "Vacant":
            await _reserve(ctx, b["id"], patient_id=rec["patient_id"], holder=rec, reason="Bed request")
    elif rec["status"] == "Cancelled" and prev.get("status") == "Allocated":
        await _release(ctx, rec.get("allocated_bed"), rec["id"])


# ================================================================== housekeeping turnaround

def _is_turnaround(rec: dict) -> bool:
    return rec.get("request_type") == TURNAROUND and bool(rec.get("bed"))


@hook(HKR, "before_transition")
async def _turnaround_time(ctx, nxt: dict, prev: dict) -> None:
    # Recomputed at every "Done" (rework moves done_at); verification only fills a missing value.
    if _is_turnaround(nxt) and (nxt["status"] == "Done" or (nxt["status"] == "Verified" and nxt.get("turnaround_minutes") is None)):
        nxt["turnaround_minutes"] = minutes_between(nxt.get("requested_at") or prev.get("created_at"), nxt.get("done_at") or _stamp())


@hook(HKR, "after_transition")
async def _turnaround_bed(ctx, rec: dict, prev: dict) -> None:
    if not _is_turnaround(rec):
        return
    b = await get(ctx, BED, rec["bed"])
    if not b:
        return
    if rec["status"] in ("Done", "Verified") and b.get("status") == "Cleaning":
        await _set_bed(ctx, b["id"], "Vacant", last_cleaned_at=_stamp(), last_turnaround_minutes=rec.get("turnaround_minutes"))
    elif rec["status"] == "In Progress" and prev.get("status") == "Done" and b.get("status") == "Vacant":
        await _set_bed(ctx, b["id"], "Cleaning")  # sent back for rework before anyone was admitted


# ================================================================== transport TAT

@hook(TRANSPORT, "before_transition")
async def _transport_tat(ctx, nxt: dict, prev: dict) -> None:
    if nxt["status"] != "Completed":
        return
    # Clock starts when the request was raised, or at the "needed at" time for a booked trip.
    asked = max((t for t in (parse_dt(prev.get("created_at")), parse_dt(nxt.get("requested_for"))) if t), default=None)
    if asked and nxt.get("delivered_at"):
        nxt["tat_minutes"] = max(0, minutes_between(asked, nxt["delivered_at"]) or 0)


# ================================================================== bed actions

class BedStatusIn(BaseModel):
    status: Literal["Vacant", "Blocked", "Maintenance"]
    reason: str | None = Field(default=None, max_length=300)


@router.post("/beds/{bid}/status")
async def set_bed_status(bid: str, body: BedStatusIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(BED), "write")
    b = await _bed(ctx, bid)
    cur = b.get("status")
    if body.status in OFF_LINE:
        if cur not in ("Vacant", "Cleaning", *OFF_LINE):
            raise conflict(f"Bed {_bed_label(b)} is {cur}; only vacant or cleaning beds can be taken out of service")
        if not (body.reason or "").strip():
            raise bad_request("Give a reason for taking the bed out of service", {"fields": {"reason": "Required"}})
        return await update(ctx, BED, bid, {"status": body.status, "block_reason": body.reason.strip()})
    if cur not in OFF_LINE:
        raise conflict(f"Only blocked or maintenance beds can be released here (bed is {cur})")
    return await update(ctx, BED, bid, {"status": "Vacant"})


class CleanIn(BaseModel):
    disinfectant: str | None = None
    remarks: str | None = Field(default=None, max_length=500)


@router.post("/beds/{bid}/mark-clean")
async def mark_clean(bid: str, body: CleanIn, ctx: CtxDep):
    require_role(ctx, "support", "nurse", "front_office")
    b = await _bed(ctx, bid)
    if b.get("status") != "Cleaning":
        raise conflict(f"Bed {_bed_label(b)} is {b.get('status')}, not awaiting cleaning")
    reqs = await find(ctx, HKR, bed=bid, request_type=TURNAROUND, status=["Open", "In Progress"], limit=10)
    me = ctx.user.get("employee_id")
    done = []
    for r in reqs:
        if r["status"] == "Open":
            who = r.get("assigned_to") or me
            await transition(ctx, HKR, r["id"], "In Progress", values={"assigned_to": who} if who else None)
        values = {k: v for k, v in body.model_dump().items() if v}
        done.append(await transition(ctx, HKR, r["id"], "Done", values=values or None))
    if not reqs:
        await _set_bed(ctx, bid, "Vacant", last_cleaned_at=_stamp())
        await audit(ctx, "bed.cleaned", module="ipd", entity="beds", record=b, note=body.remarks)
    return {"bed": await get(ctx, BED, bid), "requests": [{"id": r["id"], "code": r["code"], "turnaround_minutes": r.get("turnaround_minutes")} for r in done]}


# ================================================================== bed board

def _floor_key(w: dict) -> tuple:
    f = str(w.get("floor") or "")
    return (int(f) if f.isdigit() else -1 if f.upper() == "G" else 99, str(w.get("block") or ""), w.get("code") or "")


async def _wards(ctx) -> list[dict]:
    ent = E("mdm.wards")
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.title, t.c.status, t.c.data).where(*rs.base_where(ent)))).all()
    out = [{"id": str(r.id), "code": r.code, "name": r.title or r.code, "status": r.status, "floor": (r.data or {}).get("floor"),
            "block": (r.data or {}).get("block"), "ward_type": (r.data or {}).get("ward_type")} for r in rows]
    return sorted(out, key=_floor_key)


async def _patient_names(ctx, ids: set[str]) -> dict[str, dict]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.code, patients.c.first_name, patients.c.last_name)
                                   .where(patients.c.id.in_(ids)))).all()
    return {str(r.id): {"id": str(r.id), "uhid": r.code, "name": _name(r.first_name, r.last_name)} for r in rows}


async def _board_flags(ctx, pids: list[str], enc_ids: list[str]) -> tuple[dict, dict, dict]:
    """Critical results awaiting acknowledgement, active allergies and pending transfers — one query each."""
    crit: dict[str, int] = {}
    allergies: dict[str, list[str]] = defaultdict(list)
    transfers: dict[str, dict] = {}
    if pids:
        o = orders
        crit = {str(pid): n for pid, n in (await ctx.conn.execute(
            sa.select(o.c.patient_id, sa.func.count()).where(
                o.c.patient_id.in_(pids), o.c.critical.is_(True), o.c.acknowledged_at.is_(None), o.c.deleted_at.is_(None),
                o.c.status != "Cancelled").group_by(o.c.patient_id))).all()}
        if has(ALLERGIES):
            ent = E(ALLERGIES)
            for pid, title in (await ctx.conn.execute(sa.select(ent.table.c.patient_id, ent.table.c.title).where(
                    *rs.base_where(ent), ent.table.c.status == "Active", ent.table.c.patient_id.in_(pids)))).all():
                if title:
                    allergies[str(pid)].append(title)
    if enc_ids:
        ent = E(TRF)
        t = ent.table
        for r in (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.encounter_id, t.c.data).where(
                *rs.base_where(ent), t.c.status == "Requested", t.c.encounter_id.in_(enc_ids)))).all():
            transfers[str(r.encounter_id)] = {"id": str(r.id), "code": r.code, "to_bed": (r.data or {}).get("to_bed"),
                                              "type": (r.data or {}).get("transfer_type")}
    return crit, allergies, transfers


async def _open_turnarounds(ctx, bed_ids: list[str]) -> dict[str, dict]:
    if not bed_ids or not has(HKR):
        return {}
    ent = E(HKR)
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.status, t.c.data).where(
        *rs.base_where(ent), t.c.status.in_(["Open", "In Progress"]), t.c.data["request_type"].astext == TURNAROUND,
        t.c.data["bed"].astext.in_(bed_ids)))).all()
    return {(r.data or {}).get("bed"): {"id": str(r.id), "code": r.code, "status": r.status,
                                        "priority": (r.data or {}).get("priority")} for r in rows}


def _mins_since(ts: Any, ref: datetime) -> int | None:
    m = minutes_between(ts, ref) if ts else None
    return max(0, m) if m is not None else None


@router.get("/board")
async def board(ctx: CtxDep, ward: str | None = None, category: str | None = None):
    rs.ensure_access(ctx, E(BED), "read")
    ts, d0 = now(), today()
    wards = await _wards(ctx)
    if ward and not is_uuid(ward):
        ward = next((w["id"] for w in wards if (w["code"] or "").lower() == ward.lower()), None)
        if not ward:
            raise not_found("Ward not found")
    b = beds
    conds = [b.c.deleted_at.is_(None)]
    if ward:
        conds.append(b.c.ward_id == ward)
    if category:
        conds.append(b.c.category == category)
    bed_rows = (await ctx.conn.execute(sa.select(b.c.id, b.c.code, b.c.bed_no, b.c.ward_id, b.c.category, b.c.rate, b.c.status, b.c.data)
                                       .where(*conds).order_by(b.c.bed_no))).all()
    bed_ids = [str(r.id) for r in bed_rows]

    e, p, doc = encounters, patients, employees
    stmt = (sa.select(e.c.id, e.c.code, e.c.status, e.c.patient_id, e.c.bed_id, e.c.started_at, e.c.data,
                      p.c.code.label("uhid"), p.c.first_name, p.c.last_name, p.c.gender, p.c.dob,
                      p.c.data["allergies"].label("known_allergies"), doc.c.name.label("doctor"))
            .select_from(e.join(p, p.c.id == e.c.patient_id).outerjoin(doc, doc.c.id == e.c.doctor_id))
            .where(e.c.type == "IPD", e.c.status.in_(OPEN), e.c.deleted_at.is_(None)))
    if ward or category:
        stmt = stmt.where(e.c.bed_id.in_(bed_ids))
    adms = (await ctx.conn.execute(stmt)).all()
    by_id = {str(a.id): a for a in adms}
    by_bed: dict[str, Any] = {}
    for a in sorted(adms, key=lambda a: a.started_at or ts):
        if a.bed_id:
            by_bed[str(a.bed_id)] = a  # latest admission wins if legacy data has overlaps
    crit, alg, transfers = await _board_flags(ctx, list({str(a.patient_id) for a in adms}), list(by_id))
    reserved = await _patient_names(ctx, {(r.data or {}).get("reserved_for") for r in bed_rows if r.status == "Reserved"})
    hk = await _open_turnarounds(ctx, [str(r.id) for r in bed_rows if r.status == "Cleaning"])
    bed_no = {str(r.id): r.bed_no for r in bed_rows}
    missing = {t["to_bed"] for t in transfers.values() if t.get("to_bed") and t["to_bed"] not in bed_no}
    if missing:
        bed_no.update({str(i): n for i, n in (await ctx.conn.execute(sa.select(b.c.id, b.c.bed_no).where(b.c.id.in_(missing)))).all()})

    grouped: dict[str, list[dict]] = defaultdict(list)
    by_status: dict[str, int] = defaultdict(int)
    cleaning_mins: list[int] = []
    for r in bed_rows:
        bd = r.data or {}
        bid = str(r.id)
        a = by_id.get(bd.get("current_encounter") or "") or (by_bed.get(bid) if r.status == "Occupied" else None)
        since = _mins_since(bd.get("status_since"), ts)
        tile: dict[str, Any] = {
            "id": bid, "bed_no": r.bed_no or r.code, "room": bd.get("room_no"), "category": r.category,
            "rate": to_json_value(r.rate), "status": r.status, "status_since": bd.get("status_since"), "minutes": since,
            "patient": None, "admission": None, "flags": [], "allergies": [],
        }
        if a is not None:
            ad = a.data or {}
            pid = str(a.patient_id)
            allergy_list = list(dict.fromkeys([*(a.known_allergies or []), *alg.get(pid, [])]))
            trf = transfers.get(str(a.id))
            flags = [f for f, on in (
                ("discharge", a.status == "Discharge Initiated"), ("mlc", bool(ad.get("mlc"))),
                ("isolation", ad.get("isolation") not in (None, "", "None") or r.category == "Isolation"),
                ("allergy", bool(allergy_list)), ("critical", bool(crit.get(pid))), ("transfer", bool(trf))) if on]
            tile.update(
                patient={"id": pid, "name": _name(a.first_name, a.last_name), "uhid": a.uhid, "age": age_from(a.dob), "gender": a.gender},
                admission={"id": str(a.id), "code": a.code, "status": a.status, "started_at": to_json_value(a.started_at),
                           "los_days": (d0 - a.started_at.astimezone(ts.tzinfo).date()).days if a.started_at else None,
                           "doctor": a.doctor, "payer": ad.get("payer"), "diagnosis": ad.get("diagnosis"),
                           "isolation": ad.get("isolation"), "expected_los": ad.get("expected_los"), "critical_results": crit.get(pid, 0)},
                flags=flags, allergies=allergy_list,
                transfer={**trf, "to_bed_no": bed_no.get(trf.get("to_bed") or "")} if trf else None,
            )
        if r.status == "Reserved":
            tile["reserved_for"] = reserved.get(bd.get("reserved_for") or "")
            tile["reserved_ref"] = bd.get("reserved_ref")
            tile["reserved_reason"] = bd.get("reserved_reason")
        elif r.status == "Cleaning":
            tile["turnaround"] = hk.get(bid)
            if since is not None:
                cleaning_mins.append(since)
        elif r.status in OFF_LINE:
            tile["block_reason"] = bd.get("block_reason")
        by_status[r.status or "Unknown"] += 1
        grouped[str(r.ward_id) if r.ward_id else ""].append(tile)

    out_wards = []
    for w in [*wards, {"id": "", "code": "—", "name": "Unassigned", "floor": None, "block": None, "ward_type": None}]:
        tiles = grouped.get(w["id"])
        if not tiles:
            continue
        counts: dict[str, int] = defaultdict(int)
        for t in tiles:
            counts[t["status"]] += 1
        usable = len(tiles) - sum(counts.get(s, 0) for s in OFF_LINE)
        out_wards.append({**w, "beds": tiles, "counts": counts,
                          "occupancy_pct": round(counts.get("Occupied", 0) / usable * 100, 1) if usable else 0.0})
    total = len(bed_rows)
    usable = total - sum(by_status.get(s, 0) for s in OFF_LINE)
    categories = [c for (c,) in (await ctx.conn.execute(sa.select(b.c.category).where(b.c.deleted_at.is_(None))
                                                         .distinct().order_by(b.c.category))).all() if c]
    return {
        "generated_at": ts.isoformat(timespec="seconds"),
        "wards": out_wards,
        "totals": {"beds": total, "by_status": {s: by_status.get(s, 0) for s in BED_STATUSES}, "usable": usable,
                   "occupied": by_status.get("Occupied", 0), "vacant": by_status.get("Vacant", 0),
                   "occupancy_pct": round(by_status.get("Occupied", 0) / usable * 100, 1) if usable else 0.0,
                   "discharges_pending": sum(1 for a in adms if a.status == "Discharge Initiated"),
                   "bed_requests_pending": await count(ctx, BRQ, status="Pending"),
                   "avg_cleaning_minutes": round(sum(cleaning_mins) / len(cleaning_mins)) if cleaning_mins else None},
        "filters": {"wards": [{"id": w["id"], "code": w["code"], "name": w["name"]} for w in wards], "categories": categories},
    }


# ================================================================== discharge board

async def _latest_by_encounter(ctx, fqn: str, enc_ids: list[str]) -> dict[str, dict]:
    if not enc_ids or not has(fqn):
        return {}
    ent = E(fqn)
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t).where(*rs.base_where(ent), t.c.encounter_id.in_(enc_ids))
                                   .order_by(t.c.created_at))).all()
    return {str(r.encounter_id): rs.to_record(r) for r in rows}  # ascending, so the newest wins


@router.get("/discharge-board")
async def discharge_board(ctx: CtxDep):
    rs.ensure_access(ctx, E(ADM), "read")
    ts = now()
    start, end = day_bounds(today())
    e, p, doc, b = encounters, patients, employees, beds
    w = records.alias("w")
    rows = (await ctx.conn.execute(
        sa.select(e.c.id, e.c.code, e.c.status, e.c.patient_id, e.c.bed_id, e.c.started_at, e.c.ended_at, e.c.data,
                  p.c.code.label("uhid"), p.c.first_name, p.c.last_name, p.c.gender, p.c.dob, doc.c.name.label("doctor"),
                  b.c.bed_no, w.c.title.label("ward"))
        .select_from(e.join(p, p.c.id == e.c.patient_id).outerjoin(doc, doc.c.id == e.c.doctor_id)
                     .outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id))
        .where(e.c.type == "IPD", e.c.deleted_at.is_(None), sa.or_(
            e.c.status == "Discharge Initiated",
            sa.and_(e.c.status == "Discharged", e.c.ended_at >= start, e.c.ended_at < end)))
        .order_by(e.c.ended_at.desc().nulls_last()))).all()
    enc_ids = [str(r.id) for r in rows]
    checklists = await _latest_by_encounter(ctx, CHK, enc_ids)
    summaries = await _latest_by_encounter(ctx, SUMMARY, enc_ids)
    initiated_rows = [r for r in rows if r.status == "Discharge Initiated"]
    returns = await _pending_returns(ctx, [str(r.patient_id) for r in initiated_rows])

    def base(r) -> dict:
        d = r.data or {}
        chk = checklists.get(str(r.id))
        started = d.get("discharge_initiated_at") or (chk or {}).get("discharge_ordered_at")
        return {"id": str(r.id), "code": r.code, "status": r.status, "discharge_type": d.get("discharge_type") or (chk or {}).get("discharge_type"),
                "patient": {"id": str(r.patient_id), "uhid": r.uhid, "name": _name(r.first_name, r.last_name),
                            "age": age_from(r.dob), "gender": r.gender},
                "bed": r.bed_no, "ward": r.ward, "doctor": r.doctor, "payer": d.get("payer"), "diagnosis": d.get("diagnosis"),
                "admitted_at": to_json_value(r.started_at), "initiated_at": started}

    in_progress = []
    for r in initiated_rows:
        row = base(r)
        chk = checklists.get(row["id"])
        items = _item_states(chk, row["discharge_type"])
        bill = await clearance(ctx, row["id"])
        rets = returns.get(row["patient"]["id"], [])
        pending = _pending(chk, items, bill, rets)
        tat = _mins_since(row["initiated_at"], ts)
        in_progress.append({**row, "checklist": _checklist_brief(chk), "items": items, "billing": bill, "pharmacy_returns": rets,
                            "summary": _summary_brief(summaries.get(row["id"])), "pending": pending, "ready": not pending,
                            "tat_minutes": tat, "overdue": bool(tat and tat > DISCHARGE_TAT_TARGET)})
    in_progress.sort(key=lambda x: (not x["ready"], -(x["tat_minutes"] or 0)))

    done = []
    for r in rows:
        if r.status != "Discharged":
            continue
        row = base(r)
        tat = (r.data or {}).get("discharge_tat_minutes")
        if tat is None and row["initiated_at"]:
            tat = minutes_between(row["initiated_at"], r.ended_at)
        done.append({**row, "discharged_at": to_json_value(r.ended_at), "tat_minutes": tat,
                     "within_target": tat is not None and tat <= DISCHARGE_TAT_TARGET})
    tats = [x["tat_minutes"] for x in done if x["tat_minutes"] is not None]
    return {
        "generated_at": ts.isoformat(timespec="seconds"), "target_minutes": DISCHARGE_TAT_TARGET,
        "in_progress": in_progress, "discharged_today": done,
        "stats": {"in_progress": len(in_progress), "ready": sum(1 for x in in_progress if x["ready"]),
                  "overdue": sum(1 for x in in_progress if x["overdue"]), "discharged_today": len(done),
                  "avg_tat_today": round(sum(tats) / len(tats)) if tats else None,
                  "within_target_pct": round(sum(1 for t in tats if t <= DISCHARGE_TAT_TARGET) / len(tats) * 100) if tats else None},
    }


__all__ = ["router", "readiness", "ensure_checklist", "ITEM_ROLES", "DISCHARGE_TAT_TARGET"]
