"""Clinical forms engine — the form library, entries with sign-off and amendment audit, scored results, the
intake/output flowsheet, the OT booklet and narrative helpers (text templates, field history, import).

* Definitions: ``app/forms`` (declarative, validated at startup). Access is per definition:
  ``view_roles`` may read entries, ``roles`` may fill drafts, ``sign_roles`` may sign and amend.
* Entries: ``emr.clinical_forms`` (engine-managed). Answers are validated and scored server-side from the
  definition; the stored score / risk band is authoritative.
* Signing runs effects: nursing tasks for high-risk bands (Morse, Braden, MEWS …), deterioration alerts,
  mirrors into vitals / incidents / bundle audits / the OT WHO checklist, and the ``form.signed`` event.
* I/O flowsheet: ``emr.io_entries`` rows; balance per clinical day (08:00 → 08:00) or any window, urine output
  in mL/kg/h from the last charted weight and the cumulative balance since admission.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit, audit_trail
from ..core.hooks import emit, hook
from ..core.registry import get_entity
from ..core.security import CtxDep
from ..core.util import ApiError, bad_request, conflict, forbidden, is_uuid, not_found, now, parse_dt, to_json_value
from ..forms import SUITES, all_forms, form_public, form_summary, get_form, load_errors, load_forms
from ..forms.logic import band_public, empty, evaluate, summary_line, validate_answers
from ..forms.spec import SUITE_NAMES, FormDef, FormField
from ..schema import beds, employees, encounters, patients, records, users
from ._common import E, create, find, get, has, live, transition, update

router = APIRouter(prefix="/api/forms", tags=["forms"])

ENTRIES = "emr.clinical_forms"
TEMPLATES = "emr.text_templates"
IO = "emr.io_entries"
VITALS = "emr.vitals"
TASKS = "nursing.tasks"
LEGACY_IO = "nursing.io_charts"
BOOKINGS = "ot.bookings"
CHECKLISTS = "ot.checklists"
INCIDENTS = "safety.incidents"
BUNDLE_AUDITS = "infection.bundle_audits"
FAV_KEY = "forms.favourites"
TS = sa.DateTime(timezone=True)
LIVE = ["Draft", "Signed", "Amended"]
DONE = ["Signed", "Amended"]
CLINICAL_DAY_HOUR = 8
SHIFTS = [("Morning", 8, 14), ("Evening", 14, 20), ("Night", 20, 32)]  # night runs to 08:00 next day
TEMPLATE_ROLES = {"doctor", "nurse", "quality", "support"}
IO_ROLES = ("nurse", "doctor")

log = logging.getLogger("vlack.forms")
load_forms(strict=False)  # validate the library at startup; a broken definition is logged, not fatal
for _err in load_errors():
    log.warning("clinical form definition problem: %s", _err)


# ================================================================== helpers

def _form(key: str) -> FormDef:
    fd = get_form(key)
    if not fd:
        raise not_found(f"Unknown form {key}")
    return fd


async def _require_view(ctx, fd: FormDef) -> None:
    if not fd.can_view(ctx.role):
        raise forbidden(f"Your role cannot open {fd.title}")
    if fd.restricted and not fd.can_write(ctx.role) and not fd.can_sign(ctx.role) and ctx.role != "admin":
        if not ctx.break_glass:
            raise forbidden("This is a restricted record. Provide a reason to break the glass.", code="BREAK_GLASS_REQUIRED")
        key = f"bg:forms:{fd.key}"
        seen = ctx.__dict__.setdefault("_bg_logged", set())
        if key not in seen:
            seen.add(key)
            await audit(ctx, "break_glass", module="emr", entity="clinical_forms", note=f"{fd.key}: {ctx.break_glass}")


def _restricted_for(ctx, fd: FormDef | None) -> bool:
    return bool(fd and fd.restricted and not fd.can_write(ctx.role) and not fd.can_sign(ctx.role) and ctx.role != "admin")


def _viewable(ctx) -> list[FormDef]:
    return [fd for fd in all_forms() if fd.can_view(ctx.role)]


def _emp(ctx) -> str | None:
    return ctx.user.get("employee_id")


def _iso(v: Any) -> str | None:
    return to_json_value(v) if v is not None else None


def _dt_or_none(v: Any) -> datetime | None:
    if empty(v):
        return None
    try:
        return parse_dt(v)
    except (TypeError, ValueError):
        return None


async def _patient(ctx, pid: str) -> dict:
    from .pharmacy import patient_or_404

    return await patient_or_404(ctx, pid)


async def _admission(ctx, eid: str | None, pid: str | None = None) -> dict:
    """Encounter (any type) with bed, ward and doctor. Falls back to the patient's current encounter."""
    if not eid:
        if not pid:
            return {}
        from .clinical import patient_location

        loc = await patient_location(ctx, pid)
        eid = loc.get("encounter_id")
        if not eid:
            return {}
    if not is_uuid(eid):
        raise bad_request("Invalid encounter")
    e, b = encounters, beds
    w = records.alias("w")
    emp = employees.alias("doc")
    row = (await ctx.conn.execute(
        sa.select(e.c.id, e.c.code, e.c.type, e.c.status, e.c.patient_id, e.c.doctor_id, e.c.department_id, e.c.started_at,
                  e.c.ended_at, e.c.bed_id, e.c.data, b.c.bed_no, b.c.ward_id, w.c.title.label("ward"), emp.c.title.label("doctor_name"))
        .select_from(e.outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id).outerjoin(emp, emp.c.id == e.c.doctor_id))
        .where(e.c.id == eid, e.c.deleted_at.is_(None)))).first()
    if not row:
        raise not_found("Admission / visit not found")
    if pid and str(row.patient_id) != str(pid):
        raise bad_request("That admission belongs to another patient")
    data = row.data or {}
    where = " · ".join(x for x in (row.ward, f"Bed {row.bed_no}" if row.bed_no else None) if x)
    return {
        "id": str(row.id), "code": row.code, "type": row.type, "status": row.status, "patient_id": str(row.patient_id),
        "doctor_id": str(row.doctor_id) if row.doctor_id else None, "doctor_name": row.doctor_name,
        "department_id": str(row.department_id) if row.department_id else None, "started_at": _iso(row.started_at),
        "ended_at": _iso(row.ended_at), "bed_id": str(row.bed_id) if row.bed_id else None, "bed_no": row.bed_no,
        "ward_id": str(row.ward_id) if row.ward_id else None, "ward": row.ward, "location": where or None,
        "diagnosis": data.get("diagnosis") or data.get("chief_complaint"), "attendant_name": data.get("attendant_name"),
        "attendant_phone": data.get("attendant_phone"),
    }


async def _booking(ctx, bid: str | None, pid: str) -> dict | None:
    if not bid:
        return None
    b = await get(ctx, BOOKINGS, bid)
    if not b:
        raise not_found("OT booking not found")
    if b.get("patient_id") != pid:
        raise bad_request("That OT booking belongs to another patient")
    return b


async def _names(ctx, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = await ctx.conn.execute(sa.select(employees.c.id, employees.c.title).where(employees.c.id.in_(list(ids))))
    return {str(r.id): r.title for r in rows}


def _ref_targets(fd: FormDef, answers: dict) -> dict[str, set[str]]:
    want: dict[str, set[str]] = {}

    def add(f: FormField, v: Any) -> None:
        if f.type == "ref" and f.ref and isinstance(v, str) and is_uuid(v):
            want.setdefault(f.ref, set()).add(v)

    for f in fd.fields():
        v = answers.get(f.key)
        if f.type == "lines" and isinstance(v, list):
            for row in v:
                for s in f.fields or []:
                    add(s, (row or {}).get(s.key))
        else:
            add(f, v)
    return want


async def _ref_labels(ctx, fd: FormDef, answers: dict) -> dict[str, str]:
    labels: dict[str, str] = {}
    for ref, ids in _ref_targets(fd, answers).items():
        ent = get_entity(ref)
        if not ent:
            continue
        t = ent.table
        for r in await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.title).where(t.c.id.in_(list(ids)))):
            labels[str(r.id)] = r.title or r.code or ""
    return labels


def _fmt(f: FormField | None, v: Any, refs: dict[str, str] | None = None) -> str:
    """Human text for an answer (used by import, field history and summaries)."""
    if empty(v):
        return ""
    refs = refs or {}
    if f is None:
        return str(v)
    if f.type == "lines" and isinstance(v, list):
        out = []
        for row in v:
            cells = [_fmt(s, (row or {}).get(s.key), refs) for s in f.fields or []]
            out.append(" · ".join(c for c in cells if c))
        return "\n".join(x for x in out if x)
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    if f.type == "ref":
        return refs.get(str(v), str(v))
    if f.type == "boolean":
        return "Yes" if v else "No"
    if f.type == "choice":
        o = f.option(v)
        return (o.label or o.value) if o else str(v)
    if f.unit and isinstance(v, (int, float)):
        return f"{v:g} {f.unit}"
    return str(v)


def _band_of(rec: dict) -> dict | None:
    return rec.get("band") if isinstance(rec.get("band"), dict) else None


def _row(ctx, rec: dict, names: dict[str, str]) -> dict:
    fd = get_form(rec.get("form_key") or "")
    restricted = _restricted_for(ctx, fd)
    band = _band_of(rec)
    out = {
        "id": rec["id"], "code": rec.get("code"), "form_key": rec.get("form_key"), "form_title": rec.get("form_title"),
        "short": fd.short if fd else None, "suite": fd.suite if fd else None, "group": fd.group if fd else None,
        "status": rec.get("status"), "noted_at": rec.get("noted_at"), "patient_id": rec.get("patient_id"),
        "encounter_id": rec.get("encounter_id"), "ot_booking": rec.get("ot_booking"),
        "score": None if restricted else rec.get("score"), "score_label": rec.get("score_label"),
        "risk_band": None if restricted else rec.get("risk_band"), "risk_tone": None if restricted else (band or {}).get("tone"),
        "summary": "Restricted — break the glass to read" if restricted else rec.get("summary"),
        "author": rec.get("author"), "author_name": names.get(rec.get("author") or ""),
        "signed_by": rec.get("signed_by"), "signed_by_name": names.get(rec.get("signed_by") or ""), "signed_at": rec.get("signed_at"),
        "amended_at": rec.get("amended_at"), "next_due_at": rec.get("next_due_at"), "updated_at": rec.get("updated_at"),
        "created_at": rec.get("created_at"), "restricted": restricted,
    }
    due = _dt_or_none(rec.get("next_due_at"))
    out["overdue"] = bool(due and due < now() and rec.get("status") in DONE)
    return out


def _entries_q(ctx, *, pid: str | None = None, eid: str | None = None, keys: list[str] | None = None,
               status: list[str] | None = None, booking: str | None = None, since: datetime | None = None):
    ent = E(ENTRIES)
    t = ent.table
    conds = rs.base_where(ent)
    if pid:
        conds.append(t.c.patient_id == pid)
    if eid:
        conds.append(t.c.encounter_id == eid)
    if keys is not None:
        conds.append(t.c.data["form_key"].astext.in_(keys or ["-"]))
    if status:
        conds.append(t.c.status.in_(status))
    if booking:
        conds.append(t.c.data["ot_booking"].astext == booking)
    if since:
        conds.append(t.c.created_at >= since)
    order = sa.cast(t.c.data["noted_at"].astext, TS).desc().nulls_last()
    return ent, conds, order


async def _entries(ctx, *, limit: int = 200, **kw: Any) -> list[dict]:
    ent, conds, order = _entries_q(ctx, **kw)
    rows = (await ctx.conn.execute(sa.select(ent.table).where(*conds).order_by(order, ent.table.c.created_at.desc()).limit(limit))).all()
    return [rs.to_record(r) for r in rows]


async def _entry_or_404(ctx, rid: str) -> dict:
    rec = await get(ctx, ENTRIES, rid)
    if not rec:
        raise not_found("Form entry not found")
    return rec


def _check_fresh(rec: dict, base: str | None) -> None:
    if not base:
        return
    a, b = _dt_or_none(rec.get("updated_at")), _dt_or_none(base)
    if a and b and abs((a - b).total_seconds()) > 0.001:
        raise conflict("This form was changed by someone else since you opened it — reload to see the latest version",
                       {"updated_at": rec.get("updated_at")})


def _reassess(fd: FormDef, ev: dict, at: datetime) -> str | None:
    band = ev.get("band")
    hours = (band.reassess_hours if band and band.reassess_hours is not None else None) or fd.reassess_hours
    return (at + timedelta(hours=hours)).isoformat(timespec="minutes") if hours else None


def _score_fields(fd: FormDef, ev: dict, values: dict, noted: datetime) -> dict:
    band = ev.get("band") if ev.get("complete") else None  # a partial score never assigns a risk band
    return {
        "score": ev.get("score"), "score_label": fd.score.label if fd.score else None, "score_complete": ev.get("complete"),
        "risk_band": band.label if band else None, "band": band_public(band), "score_items": ev.get("items") or None,
        "summary": summary_line(fd, values, ev), "next_due_at": _reassess(fd, ev, noted) if band or fd.reassess_hours else None,
    }


def _noted(values: dict) -> datetime:
    return _dt_or_none(values.get("noted_at")) or now()


# ================================================================== definitions & library

@router.get("/defs")
async def list_defs(ctx: CtxDep, suite: str | None = None, q: str | None = None, patient_id: str | None = None,
                    encounter_id: str | None = None, booking_id: str | None = None):
    forms = _viewable(ctx)
    if q:
        ql = q.strip().lower()
        forms = [f for f in forms if ql in f.title.lower() or ql in (f.short or "").lower() or ql in (f.description or "").lower()
                 or ql in f.key]
    counts: dict[str, int] = {}
    for f in forms:
        for s in f.suites():
            counts[s] = counts.get(s, 0) + 1
    if suite:
        forms = [f for f in forms if suite in f.suites()]
    state: dict[str, dict] = {}
    if patient_id:
        if not is_uuid(patient_id):
            raise bad_request("Invalid patient")
        for rec in await _entries(ctx, pid=patient_id, eid=encounter_id if encounter_id and is_uuid(encounter_id) else None,
                                  status=LIVE, limit=2000):
            k = rec.get("form_key")
            st = state.setdefault(k, {"count": 0, "draft": None, "latest": None})
            st["count"] += 1
            if rec.get("status") == "Draft":
                if not st["draft"]:
                    st["draft"] = {"id": rec["id"], "updated_at": rec.get("updated_at"), "noted_at": rec.get("noted_at")}
            elif not st["latest"]:
                fd = get_form(k)
                hidden = _restricted_for(ctx, fd)
                st["latest"] = {"id": rec["id"], "status": rec.get("status"), "noted_at": rec.get("noted_at"),
                                "score": None if hidden else rec.get("score"), "risk_band": None if hidden else rec.get("risk_band"),
                                "risk_tone": None if hidden else (_band_of(rec) or {}).get("tone"), "next_due_at": rec.get("next_due_at")}
    prefs = (await ctx.conn.execute(sa.select(users.c.data).where(users.c.id == ctx.user_id))).scalar() or {}
    favs = [k for k in ((prefs.get("prefs") or {}).get(FAV_KEY) or []) if get_form(k) and get_form(k).can_view(ctx.role)]
    recent: list[str] = []
    ent = E(ENTRIES)
    t = ent.table
    rows = await ctx.conn.execute(
        sa.select(t.c.data["form_key"].astext.label("k"), sa.func.max(t.c.updated_at).label("at"))
        .where(*rs.base_where(ent), t.c.updated_by == ctx.user_id, t.c.updated_at >= now() - timedelta(days=60))
        .group_by(sa.text("k")).order_by(sa.desc("at")).limit(12))
    for r in rows:
        fd = get_form(r.k or "")
        if fd and fd.can_view(ctx.role):
            recent.append(fd.key)
    out = []
    for f in forms:
        d = form_summary(f)
        d["access"] = f.access(ctx.role)
        if patient_id:
            d["state"] = state.get(f.key) or {"count": 0, "draft": None, "latest": None}
        out.append(d)
    suites = [{**s, "count": counts.get(s["id"], 0)} for s in SUITES if counts.get(s["id"])]
    return {"suites": suites, "forms": out, "favourites": favs, "recent": recent[:8]}


@router.get("/defs/{key}")
async def get_def(key: str, ctx: CtxDep):
    fd = _form(key)
    await _require_view(ctx, fd)
    return {**form_public(fd), "access": fd.access(ctx.role)}


class FavIn(BaseModel):
    on: bool | None = None


@router.post("/favourites/{key}")
async def toggle_favourite(key: str, body: FavIn, ctx: CtxDep):
    fd = _form(key)
    if not fd.can_view(ctx.role):
        raise forbidden("Your role cannot use this form")
    from .settings import PrefIn, write_pref

    prefs = (await ctx.conn.execute(sa.select(users.c.data).where(users.c.id == ctx.user_id))).scalar() or {}
    favs = [k for k in ((prefs.get("prefs") or {}).get(FAV_KEY) or []) if get_form(k)]
    on = (key not in favs) if body.on is None else body.on
    favs = [k for k in favs if k != key] + ([key] if on else [])
    await write_pref(FAV_KEY, PrefIn(value=favs[-60:]), ctx)
    return {"favourites": favs, "on": on}


@router.get("/op-format")
async def op_format(ctx: CtxDep, department_id: str | None = None, department: str | None = None):
    """Specialty clinical-note format for a department (OP EMR)."""
    name = (department or "").lower()
    if department_id and is_uuid(department_id):
        rec = await get(ctx, "mdm.departments", department_id)
        name = ((rec or {}).get("title") or (rec or {}).get("name") or "").lower()
    notes = sorted([f for f in all_forms() if f.suite == "op"], key=lambda f: f.order)
    best: tuple[int, FormDef] | None = None
    for f in notes:  # the longest matching keyword wins ("physical medicine" → rehab over "medicine")
        for m in f.match:
            if name and re.search(rf"\b{re.escape(m)}", name) and (best is None or len(m) > best[0]):
                best = (len(m), f)
    chosen = best[1] if best else get_form("op.note.general_medicine")
    return {"form_key": chosen.key if chosen else None, "department": name or None, "matched": best is not None,
            "formats": [{"key": f.key, "title": f.short} for f in notes]}


# ================================================================== prefill / import / field history

async def _last_weight(ctx, pid: str, before: datetime | None = None) -> dict | None:
    best: dict | None = None
    if has(VITALS):
        ent = E(VITALS)
        t = ent.table
        at = sa.cast(t.c.data["recorded_at"].astext, TS)
        conds = [*rs.base_where(ent), t.c.patient_id == pid, t.c.data["weight"].astext.isnot(None),
                 sa.func.coalesce(t.c.status, "") != "Entered in Error"]
        if before:
            conds.append(at <= before)
        r = (await ctx.conn.execute(sa.select(t.c.data["weight"].astext, at).where(*conds).order_by(at.desc().nulls_last()).limit(1))).first()
        if r and r[0]:
            try:
                best = {"value": float(r[0]), "at": _iso(r[1]), "source": "Vitals"}
            except ValueError:
                best = None
    ent = E(ENTRIES)
    t = ent.table
    at = sa.cast(t.c.data["noted_at"].astext, TS)
    conds = [*rs.base_where(ent), t.c.patient_id == pid, t.c.status.in_(DONE), t.c.data["answers"]["weight"].astext.isnot(None)]
    if before:
        conds.append(at <= before)
    r = (await ctx.conn.execute(sa.select(t.c.data["answers"]["weight"].astext, at, t.c.data["form_title"].astext)
                                .where(*conds).order_by(at.desc().nulls_last()).limit(1))).first()
    if r and r[0]:
        try:
            cand = {"value": float(r[0]), "at": _iso(r[1]), "source": r[2]}
        except ValueError:
            cand = None
        if cand and (not best or (cand["at"] or "") > (best["at"] or "")):
            best = cand
    return best


async def _latest_vital(ctx, pid: str, key: str) -> Any:
    if not has(VITALS):
        return None
    ent = E(VITALS)
    t = ent.table
    at = sa.cast(t.c.data["recorded_at"].astext, TS)
    r = (await ctx.conn.execute(sa.select(t.c.data[key]).where(
        *rs.base_where(ent), t.c.patient_id == pid, t.c.data[key].astext.isnot(None),
        sa.func.coalesce(t.c.status, "") != "Entered in Error").order_by(at.desc().nulls_last()).limit(1))).first()
    return r[0] if r else None


async def _latest_entry(ctx, form_key: str, pid: str, eid: str | None, statuses: list[str] = DONE) -> dict | None:
    if eid:
        rows = await _entries(ctx, pid=pid, eid=eid, keys=[form_key], status=statuses, limit=1)
        if rows:
            return rows[0]
    rows = await _entries(ctx, pid=pid, keys=[form_key], status=statuses, limit=1)
    return rows[0] if rows else None


def _fits(f: FormField, v: Any) -> bool:
    if empty(v):
        return False
    if f.type in ("select", "choice", "yesno"):
        return str(v) in f.option_values()
    if f.type in ("number", "scale", "currency", "percent"):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return False
        return (f.min is None or n >= f.min) and (f.max is None or n <= f.max)
    return True


@router.get("/prefill")
async def prefill(ctx: CtxDep, form_key: str, patient_id: str, encounter_id: str | None = None, booking_id: str | None = None):
    fd = _form(form_key)
    await _require_view(ctx, fd)
    p = await _patient(ctx, patient_id)
    cache: dict[str, Any] = {}

    async def adm() -> dict:
        if "adm" not in cache:
            cache["adm"] = await _admission(ctx, encounter_id, patient_id)
        return cache["adm"]

    async def booking() -> dict:
        if "bk" not in cache:
            cache["bk"] = await _booking(ctx, booking_id, patient_id) if booking_id else {}
        return cache["bk"] or {}

    out: dict[str, Any] = {}
    sources: dict[str, str] = {}
    for f in fd.fields():
        src = f.prefill
        if not src:
            continue
        v: Any = None
        label = src
        if src.startswith("patient."):
            k = src.split(".", 1)[1]
            if k == "allergies":
                from .pharmacy import patient_allergies

                al = await patient_allergies(ctx, patient_id, p)
                v = ", ".join(a["allergen"] + (f" ({a['reaction']})" if a.get("reaction") else "") for a in al) or None
                label = "Allergy list"
            elif k == "name":
                v = p.get("title")
            else:
                v = p.get(k)
            label = label if label != src else "Registration"
        elif src.startswith("admission."):
            v = (await adm()).get(src.split(".", 1)[1])
            label = f"Admission {(await adm()).get('code') or ''}".strip()
        elif src.startswith("booking."):
            b = await booking()
            k = src.split(".", 1)[1]
            v = (f"{b['est_duration_min']} min" if b.get("est_duration_min") else None) if k == "duration" else b.get(k)
            label = f"OT booking {b.get('code') or ''}".strip()
        elif src.startswith("vitals."):
            v = await _latest_vital(ctx, patient_id, src.split(".", 1)[1])
            label = "Last vitals"
        elif src == "weight":
            w = await _last_weight(ctx, patient_id)
            v = w["value"] if w else None
            label = f"Last charted weight ({w['source']})" if w else src
        elif src.startswith("form:"):
            fk, _, fld = src[5:].rpartition(".")
            e = await _latest_entry(ctx, fk, patient_id, encounter_id)
            if e:
                v = (e.get("answers") or {}).get(fld, e.get(fld))
                label = e.get("form_title") or fk
        elif src.startswith("score:"):
            e = await _latest_entry(ctx, src[6:], patient_id, encounter_id)
            if e:
                v = e.get("score")
                label = f"Last {e.get('score_label') or 'score'}"
        elif src == "me":
            v = _emp(ctx)
        if f.type == "datetime" and isinstance(v, str):
            v = v[:16]
        if _fits(f, v):
            out[f.key] = v
            sources[f.key] = label
    return {"answers": out, "sources": sources}


def _compose(fd_src: FormDef, answers: dict, spec: str, refs: dict[str, str]) -> str | None:
    keys = [k.strip() for k in spec.split(",") if k.strip()]
    fmap = fd_src.field_map()
    if len(keys) == 1:
        v = _fmt(fmap.get(keys[0]), answers.get(keys[0]), refs)
        return v or None
    parts = []
    for k in keys:
        v = _fmt(fmap.get(k), answers.get(k), refs)
        if v:
            parts.append(f"{fmap[k].label if k in fmap else k}: {v}")
    return "\n".join(parts) or None


@router.get("/import")
async def import_answers(ctx: CtxDep, form_key: str, patient_id: str, encounter_id: str | None = None):
    """Answers mapped from the definition's `import_from` sources (e.g. discharge summary ← admission H&P)."""
    fd = _form(form_key)
    await _require_view(ctx, fd)
    out = []
    for imp in fd.import_from:
        src = get_form(imp.form)
        if not src or not src.can_view(ctx.role):
            continue
        e = await _latest_entry(ctx, imp.form, patient_id, encounter_id)
        if not e:
            out.append({"form_key": imp.form, "label": imp.label or src.title, "entry": None, "answers": {}})
            continue
        ans = e.get("answers") or {}
        refs = await _ref_labels(ctx, src, ans)
        mapped = {}
        tmap = fd.field_map()
        for tgt, spec in imp.map.items():
            v = _compose(src, ans, spec, refs)
            if v and tmap[tgt].type not in ("textarea", "text"):
                continue
            if v:
                mapped[tgt] = v
        out.append({"form_key": imp.form, "label": imp.label or src.title, "answers": mapped,
                    "entry": {"id": e["id"], "code": e.get("code"), "noted_at": e.get("noted_at"), "status": e.get("status")}})
    return {"sources": out}


@router.get("/field-history")
async def field_history(ctx: CtxDep, patient_id: str, form_key: str, field: str, encounter_id: str | None = None, limit: int = 15):
    """Earlier values of a field for this patient (same form) plus the field's `copy_from` sources."""
    fd = _form(form_key)
    await _require_view(ctx, fd)
    f = fd.field_map().get(field)
    if not f:
        raise not_found("Unknown field")
    pairs: list[tuple[FormDef, str]] = [(fd, field)]
    for src in f.copy_from or []:
        fk, _, fld = src.rpartition(".")
        sfd = get_form(fk)
        if sfd and sfd.can_view(ctx.role) and not _restricted_for(ctx, sfd):
            pairs.append((sfd, fld))
    keys = list({p[0].key for p in pairs})
    rows = await _entries(ctx, pid=patient_id, keys=keys, status=DONE, limit=200)
    names = await _names(ctx, {r.get("signed_by") or r.get("author") or "" for r in rows})
    out = []
    for r in rows:
        for sfd, fld in pairs:
            if r.get("form_key") != sfd.key:
                continue
            v = (r.get("answers") or {}).get(fld)
            if empty(v):
                continue
            sf = sfd.field_map().get(fld)
            refs = await _ref_labels(ctx, sfd, {fld: v}) if sf and sf.type in ("ref", "lines") else {}
            out.append({"entry_id": r["id"], "code": r.get("code"), "form_key": sfd.key, "form_title": sfd.title,
                        "field": fld, "field_label": sf.label if sf else fld, "value": v, "text": _fmt(sf, v, refs),
                        "at": r.get("noted_at"), "by": names.get(r.get("signed_by") or r.get("author") or ""),
                        "status": r.get("status"), "same_encounter": bool(encounter_id) and r.get("encounter_id") == encounter_id})
    return {"rows": out[: max(1, min(limit, 50))]}


@router.get("/patient-header")
async def patient_header(ctx: CtxDep, patient_id: str, encounter_id: str | None = None):
    """Patient banner for printed forms, the OT booklet and the I/O chart."""
    if not _viewable(ctx):
        raise forbidden("Your role does not use clinical forms")
    p = await _patient(ctx, patient_id)
    adm = await _admission(ctx, encounter_id, patient_id) if encounter_id else await _admission(ctx, None, patient_id)
    return {"id": p["id"], "name": p.get("title"), "uhid": p.get("code"), "gender": p.get("gender"), "dob": p.get("dob"), "age": p.get("age"),
            "phone": p.get("phone"), "blood_group": p.get("blood_group"),
            "admission": {k: adm.get(k) for k in ("id", "code", "type", "status", "started_at", "location", "doctor_name", "diagnosis")} if adm else None}


# ================================================================== entries

class EntryIn(BaseModel):
    form_key: str
    patient_id: str
    encounter_id: str | None = None
    ot_booking: str | None = None
    answers: dict = Field(default_factory=dict)
    sign: bool = False


class DraftIn(BaseModel):
    answers: dict = Field(default_factory=dict)
    ot_booking: str | None = None
    base_updated_at: str | None = None


class SignIn(BaseModel):
    answers: dict | None = None
    base_updated_at: str | None = None


class AmendIn(BaseModel):
    answers: dict
    reason: str = Field(min_length=5, max_length=1000)
    base_updated_at: str | None = None


def _errors(errs: dict[str, str], final: bool) -> None:
    if errs:
        raise bad_request("Please complete the highlighted fields" if final else "Some answers are not valid", {"fields": errs})


@router.get("/entries")
async def list_entries(ctx: CtxDep, patient_id: str | None = None, encounter_id: str | None = None, form_key: str | None = None,
                       suite: str | None = None, status: str | None = None, booking_id: str | None = None, mine: bool = False,
                       days: int | None = None, limit: int = 50):
    for v in (patient_id, encounter_id, booking_id):
        if v and not is_uuid(v):
            raise bad_request("Invalid id")
    if not patient_id and not encounter_id and not booking_id and not mine and not days:
        raise bad_request("Choose a patient, admission or period")
    visible = _viewable(ctx)
    keys = [f.key for f in visible if (not form_key or f.key == form_key) and (not suite or suite in f.suites())]
    sts = [s for s in (status or "").split(",") if s in LIVE] or None
    since = now() - timedelta(days=max(1, min(days, 90))) if days else None
    rows = await _entries(ctx, pid=patient_id, eid=encounter_id, keys=keys, status=sts, booking=booking_id, since=since,
                          limit=max(1, min(limit, 500)))
    if mine:
        rows = [r for r in rows if r.get("created_by") == ctx.user_id or r.get("updated_by") == ctx.user_id]
    names = await _names(ctx, {r.get("author") or "" for r in rows} | {r.get("signed_by") or "" for r in rows})
    pids = list({r["patient_id"] for r in rows if r.get("patient_id")})
    pts = {str(x.id): (x.title, x.code) for x in await ctx.conn.execute(
        sa.select(patients.c.id, patients.c.title, patients.c.code).where(patients.c.id.in_(pids or ["00000000-0000-0000-0000-000000000000"])))}
    out = []
    for r in rows:
        row = _row(ctx, r, names)
        row["patient_name"], row["uhid"] = pts.get(r.get("patient_id") or "", (None, None))
        out.append(row)
    return {"rows": out}


@router.get("/scores")
async def latest_scores(ctx: CtxDep, patient_id: str, encounter_id: str | None = None):
    """Latest signed score per scored form (chart widgets)."""
    scored = [f for f in _viewable(ctx) if f.score and not _restricted_for(ctx, f)]
    rows = await _entries(ctx, pid=patient_id, eid=encounter_id, keys=[f.key for f in scored], status=DONE, limit=1000)
    seen: dict[str, dict] = {}
    for r in rows:
        k = r.get("form_key")
        if k in seen or r.get("score") is None:
            continue
        seen[k] = r
    names = await _names(ctx, {r.get("signed_by") or "" for r in seen.values()})
    out = []
    for k, r in seen.items():
        fd = get_form(k)
        row = _row(ctx, r, names)
        row["band"] = _band_of(r)
        row["lower_is_worse"] = bool(fd and fd.score and fd.score.lower_is_worse)
        row["score_max"] = fd.score.max if fd and fd.score else None
        out.append(row)
    out.sort(key=lambda x: x.get("noted_at") or "", reverse=True)
    return {"rows": out}


@router.get("/entries/{rid}")
async def get_entry(rid: str, ctx: CtxDep):
    rec = await _entry_or_404(ctx, rid)
    fd = _form(rec["form_key"])
    await _require_view(ctx, fd)
    ans = rec.get("answers") or {}
    refs = await _ref_labels(ctx, fd, ans)
    names = await _names(ctx, {rec.get("author") or "", rec.get("signed_by") or ""}
                         | {a.get("by") or "" for a in rec.get("amendments") or []})
    refs.update(names)
    if rec.get("ot_booking"):
        b = await get(ctx, BOOKINGS, rec["ot_booking"])
        if b:
            refs[rec["ot_booking"]] = f"{b.get('code')} · {b.get('procedure') or ''}".strip(" ·")
    out = {k: v for k, v in rec.items() if k not in ("search",)}
    out.update(_row(ctx, rec, names))
    out["answers"] = ans
    out["refs"] = refs
    out["band"] = _band_of(rec)
    out["access"] = fd.access(ctx.role)
    out["amendments"] = [{**a, "by_name": names.get(a.get("by") or "", a.get("by_name"))} for a in rec.get("amendments") or []]
    return out


@router.get("/entries/{rid}/audit")
async def entry_audit(rid: str, ctx: CtxDep):
    rec = await _entry_or_404(ctx, rid)
    await _require_view(ctx, _form(rec["form_key"]))
    return await audit_trail(ctx.conn, record_id=rid, limit=200)


@router.post("/entries/{rid}/print")
async def entry_print(rid: str, ctx: CtxDep):
    rec = await _entry_or_404(ctx, rid)
    await _require_view(ctx, _form(rec["form_key"]))
    await audit(ctx, "print", module="emr", entity="clinical_forms", record=rec)
    return {"ok": True}


class EvalIn(BaseModel):
    form_key: str
    answers: dict = Field(default_factory=dict)
    final: bool = False


@router.post("/evaluate")
async def evaluate_answers(body: EvalIn, ctx: CtxDep):
    """Score a set of answers without saving (the runner computes live; this is the authoritative check)."""
    fd = _form(body.form_key)
    await _require_view(ctx, fd)
    values, errs = validate_answers(ctx, fd, body.answers, final=body.final)
    ev = evaluate(fd, values)
    return {"values": ev["values"], "score": ev["score"], "band": band_public(ev["band"]), "complete": ev["complete"],
            "items": ev["items"], "errors": errs, "summary": summary_line(fd, values, ev)}


@router.post("/entries", status_code=201)
async def create_entry(body: EntryIn, ctx: CtxDep):
    fd = _form(body.form_key)
    if fd.component:
        raise bad_request(f"{fd.title} is charted in its own flowsheet")
    if not fd.can_write(ctx.role) and not (body.sign and fd.can_sign(ctx.role)):
        raise forbidden(f"Your role cannot fill {fd.title}")
    if body.sign and not fd.can_sign(ctx.role):
        raise forbidden(f"Your role cannot sign {fd.title}")
    await _require_view(ctx, fd)
    await _patient(ctx, body.patient_id)
    adm = await _admission(ctx, body.encounter_id, body.patient_id) if body.encounter_id else {}
    if fd.one_per_admission:
        if not adm:
            raise bad_request(f"{fd.title} is recorded once per admission — open it from the patient's admission")
        existing = await _entries(ctx, pid=body.patient_id, eid=adm["id"], keys=[fd.key], status=LIVE, limit=1)
        if existing:
            e = existing[0]
            msg = ("A draft already exists for this admission — continue it" if e.get("status") == "Draft"
                   else f"{fd.title} is already recorded for this admission — amend it instead")
            raise conflict(msg, {"entry_id": e["id"], "status": e.get("status")})
    bk = await _booking(ctx, body.ot_booking, body.patient_id)
    values, errs = validate_answers(ctx, fd, body.answers, final=body.sign)
    _errors(errs, body.sign)
    ev = evaluate(fd, values)
    noted = _noted(values)
    rec = await create(ctx, ENTRIES, {
        "patient_id": body.patient_id, "encounter_id": adm.get("id"), "form_key": fd.key, "form_title": fd.title,
        "suite": SUITE_NAMES[fd.suite], "noted_at": noted.isoformat(timespec="minutes"), "ot_booking": bk["id"] if bk else None,
        "author": _emp(ctx), "status": "Draft", "answers": values, "form_version": fd.version,
        "last_edited_by": ctx.user.get("name"), **_score_fields(fd, ev, values, noted),
    })
    if body.sign:
        rec = await _sign(ctx, fd, rec, values, ev)
    return await get_entry(rec["id"], ctx)


@router.put("/entries/{rid}")
async def save_draft(rid: str, body: DraftIn, ctx: CtxDep):
    rec = await _entry_or_404(ctx, rid)
    fd = _form(rec["form_key"])
    if not fd.can_write(ctx.role):
        raise forbidden(f"Your role cannot edit {fd.title}")
    if rec.get("status") != "Draft":
        raise conflict("Signed forms cannot be edited — amend with a reason instead")
    _check_fresh(rec, body.base_updated_at)
    values, errs = validate_answers(ctx, fd, body.answers, final=False)
    _errors(errs, False)
    ev = evaluate(fd, values)
    noted = _noted(values)
    patch = {"answers": values, "noted_at": noted.isoformat(timespec="minutes"), "last_edited_by": ctx.user.get("name"),
             **_score_fields(fd, ev, values, noted)}
    if body.ot_booking is not None:
        bk = await _booking(ctx, body.ot_booking or None, rec["patient_id"])
        patch["ot_booking"] = bk["id"] if bk else None
    await update(ctx, ENTRIES, rid, patch)
    return await get_entry(rid, ctx)


@router.delete("/entries/{rid}")
async def discard_draft(rid: str, ctx: CtxDep):
    rec = await _entry_or_404(ctx, rid)
    fd = _form(rec["form_key"])
    if rec.get("status") != "Draft":
        raise conflict("Only drafts can be discarded; signed forms stay in the record")
    if not (ctx.role == "admin" or rec.get("created_by") == ctx.user_id or fd.can_sign(ctx.role)):
        raise forbidden("Only the author or a signing clinician can discard this draft")
    await rs.delete_record(ctx, E(ENTRIES), rid, reason="Draft discarded", check=False)
    return {"ok": True}


@router.post("/entries/{rid}/sign")
async def sign_entry(rid: str, body: SignIn, ctx: CtxDep):
    rec = await _entry_or_404(ctx, rid)
    fd = _form(rec["form_key"])
    if not fd.can_sign(ctx.role):
        raise forbidden(f"Your role cannot sign {fd.title}")
    if rec.get("status") != "Draft":
        raise conflict("This form is already signed")
    _check_fresh(rec, body.base_updated_at)
    values, errs = validate_answers(ctx, fd, body.answers if body.answers is not None else rec.get("answers") or {}, final=True)
    _errors(errs, True)
    ev = evaluate(fd, values)
    rec = await _sign(ctx, fd, rec, values, ev)
    return await get_entry(rec["id"], ctx)


@router.post("/entries/{rid}/amend")
async def amend_entry(rid: str, body: AmendIn, ctx: CtxDep):
    rec = await _entry_or_404(ctx, rid)
    fd = _form(rec["form_key"])
    if not fd.can_sign(ctx.role):
        raise forbidden(f"Your role cannot amend {fd.title}")
    if rec.get("status") not in DONE:
        raise conflict("Only signed forms are amended; drafts are edited directly")
    _check_fresh(rec, body.base_updated_at)
    values, errs = validate_answers(ctx, fd, body.answers, final=True)
    _errors(errs, True)
    ev = evaluate(fd, values)
    before = rec.get("answers") or {}
    changed = sorted(k for k in set(before) | set(values) if before.get(k) != values.get(k))
    if not changed:
        raise bad_request("Nothing was changed — edit the answers before amending")
    ts = now()
    noted = _noted(values)
    amendment = {"at": ts.isoformat(timespec="seconds"), "by": _emp(ctx), "by_name": ctx.user.get("name"), "user_id": ctx.user_id,
                 "reason": body.reason.strip(), "fields": changed, "before": {k: before.get(k) for k in changed},
                 "after": {k: values.get(k) for k in changed}, "score_before": rec.get("score"), "score_after": ev.get("score"),
                 "band_before": rec.get("risk_band"), "band_after": ev["band"].label if ev.get("band") else None}
    prev_band = rec.get("risk_band")
    await update(ctx, ENTRIES, rid, {
        "status": "Amended", "answers": values, "noted_at": noted.isoformat(timespec="minutes"), "amended_at": ts.isoformat(timespec="minutes"),
        "amendment_reason": body.reason.strip(), "amended_by": _emp(ctx), "amendments": [*(rec.get("amendments") or []), amendment],
        "last_edited_by": ctx.user.get("name"), **_score_fields(fd, ev, values, noted),
    })
    rec = await _entry_or_404(ctx, rid)
    if ev.get("band") and (ev["band"].task or ev["band"].alert or ev["band"].label != prev_band):
        await _effects(ctx, fd, rec, ev, first_sign=False)
    return await get_entry(rid, ctx)


async def _sign(ctx, fd: FormDef, rec: dict, values: dict, ev: dict) -> dict:
    ts = now()
    noted = _noted(values)
    await update(ctx, ENTRIES, rec["id"], {
        "status": "Signed", "answers": values, "noted_at": noted.isoformat(timespec="minutes"), "signed_by": _emp(ctx),
        "signed_by_name": ctx.user.get("name"), "signed_at": ts.isoformat(timespec="minutes"), "last_edited_by": ctx.user.get("name"),
        **_score_fields(fd, ev, values, noted),
    })
    rec = await _entry_or_404(ctx, rec["id"])
    await _effects(ctx, fd, rec, ev, first_sign=True)
    return rec


# ================================================================== effects: tasks, alerts, mirrors

async def _effects(ctx, fd: FormDef, rec: dict, ev: dict, *, first_sign: bool) -> None:
    pid = rec["patient_id"]
    band = ev.get("band")
    linked = dict(rec.get("linked") or {})
    notes: list[str] = []
    adm = await _admission(ctx, rec.get("encounter_id"), pid) if rec.get("encounter_id") else await _admission(ctx, None, pid)
    if band and band.task and has(TASKS):
        trigger = f"form:{fd.key}"
        pending = [t for t in await find(ctx, TASKS, patient_id=pid, status="Pending", limit=100) if t.get("trigger") == trigger]
        if not pending:
            score = f"{ev.get('score')}{(' ' + fd.score.unit) if fd.score and fd.score.unit else ''}"
            task = await create(ctx, TASKS, {
                "patient_id": pid, "encounter_id": rec.get("encounter_id") or adm.get("id"),
                "task": f"{fd.short or fd.title} {score} ({band.label}) — {band.task.text}"[:900],
                "category": band.task.category, "ward": adm.get("ward_id"), "due_at": now().isoformat(timespec="minutes"),
                "assigned_to": _emp(ctx) if ctx.role == "nurse" else None, "priority": band.task.priority, "source": "Protocol",
                "trigger": trigger, "form_entry": rec["id"], "status": "Pending",
            })
            linked["nursing.tasks"] = task["id"]
        else:
            notes.append("A pending nursing task for this risk already exists")
    if band and (band.alert or (band.task and band.task.priority == "STAT")):
        p = await _patient(ctx, pid)
        live(ctx, "alerts", {
            "type": "form_risk", "patient_id": pid, "patient": p.get("title"), "uhid": p.get("code"), "form": fd.title, "score": ev.get("score"),
            "band": band.label, "ward_id": adm.get("ward_id"), "roles": ["nurse", "doctor"],
            "message": f"{fd.short or fd.title} {ev.get('score')} — {band.label}: {p.get('title')} {p.get('code')}"
                       + (f" · {adm['location']}" if adm.get("location") else ""),
        })
    if first_sign:
        for m in fd.mirror:
            if m.when and not _cond(m.when, rec.get("answers") or {}):
                continue
            try:
                res = await _mirror(ctx, fd, m.kind, m.options, rec, ev, adm)
            except ApiError as e:  # validation of the target record — keep the signed form, report why
                d = e.detail if isinstance(e.detail, dict) else {}
                notes.append(f"{m.kind}: {d.get('message', 'not posted')}")
                continue
            if isinstance(res, dict):
                linked.update(res)
            elif isinstance(res, str):
                notes.append(res)
    if linked != (rec.get("linked") or {}) or notes:
        await update(ctx, ENTRIES, rec["id"], {"linked": linked, "effect_notes": notes or None})
    await emit("form.signed", ctx, {"id": rec["id"], "form_key": fd.key, "suite": fd.suite, "patient_id": pid,
                                    "encounter_id": rec.get("encounter_id"), "score": ev.get("score"),
                                    "band": band.label if band else None, "status": "Signed" if first_sign else "Amended"})


def _cond(c: dict, values: dict) -> bool:
    from ..forms.logic import cond_ok

    return cond_ok(c, values)


def _yes(v: Any) -> bool | None:
    return True if v in ("Yes", True) else False if v in ("No", False) else None


async def _mirror(ctx, fd: FormDef, kind: str, opts: dict, rec: dict, ev: dict, adm: dict) -> dict | str | None:
    a = rec.get("answers") or {}
    pid, eid = rec["patient_id"], rec.get("encounter_id")
    base = {"patient_id": pid, "encounter_id": eid, "source_form": rec["id"]}
    if kind == "vitals":
        if not has(VITALS):
            return None
        at = rec.get("noted_at")
        if a.get("vital_date"):
            at = f"{a['vital_date']}T{a.get('vital_time') or '00:00'}"
        payload = {
            "recorded_at": at, "temperature": a.get("temperature"), "pulse": a.get("pulse") or a.get("heart_rate"),
            "resp_rate": a.get("resp_rate"), "bp_systolic": a.get("bp_sys") or a.get("bp1_sys") or a.get("bp2_sys"),
            "bp_diastolic": a.get("bp_dia") or a.get("bp1_dia") or a.get("bp2_dia"), "spo2": a.get("spo2"),
            "o2_support": a.get("o2_support") or a.get("spo2_mode"), "pain_score": a.get("pain_score", a.get("pain_points")),
            "blood_sugar": a.get("grbs"), "weight": a.get("weight"), "height": a.get("height"), "recorded_by": _emp(ctx),
            "remarks": f"From {fd.title} {rec.get('code')}", "status": "Recorded",
        }
        payload = {k: v for k, v in payload.items() if not empty(v)}
        if not any(k in payload for k in ("pulse", "bp_systolic", "spo2", "temperature", "resp_rate")):
            return "vitals: no observations to chart"
        v = await create(ctx, VITALS, {**base, **payload})
        return {VITALS: v["id"]}
    if kind == "incident":
        if not has(INCIDENTS):
            return None
        itype = opts.get("incident_type", "Other")
        harm = a.get("harm")
        merp = a.get("ncc_merp_category")
        if merp and not harm:
            c = merp[0]
            harm = "No Harm" if c in "ABCD" else "Mild" if c == "E" else "Moderate" if c == "F" else "Severe" if c in "GH" else "Sentinel Event"
        occurred = a.get(opts.get("occurred_field") or "occurred_at") or rec.get("noted_at")
        desc_parts = [f"{fd.title} ({rec.get('code')})", rec.get("summary") or ""]
        for k in ("description", "injury_details", "stage", "site", "reaction_type"):
            if a.get(k):
                desc_parts.append(f"{fd.field_map()[k].label}: {_fmt(fd.field_map()[k], a[k])}")
        if a.get("signs"):
            desc_parts.append("Signs: " + ", ".join(a["signs"]))
        informed = a.get("patient_informed") or ({"Yes": "Yes", "No": "No"}.get(a.get("family_informed")) if a.get("family_informed") else None)
        inc = await create(ctx, INCIDENTS, {
            **base, "incident_type": itype, "severity": harm or "No Harm", "occurred_at": occurred,
            "location": a.get("location") or adm.get("location") or adm.get("ward") or "In-patient ward", "ward": adm.get("ward_id"),
            "description": "\n".join(p for p in desc_parts if p)[:4000],
            "immediate_action": a.get("immediate_action") or ", ".join(a.get("actions") or []) or "See the linked clinical form",
            "drug": a.get("drug"), "med_error_stage": a.get("med_error_stage"), "ncc_merp_category": merp,
            "fall_risk_score": a.get("pre_fall_morse"), "patient_informed": informed, "reported_by": _emp(ctx), "status": "Reported",
        })
        return {INCIDENTS: inc["id"]}
    if kind == "bundle":
        if not has(BUNDLE_AUDITS):
            return None
        from ..modules.clinical.infection import BUNDLE_ELEMENTS

        bundle = opts.get("bundle") or (opts.get("map") or {}).get(a.get(opts.get("by") or ""))
        if not bundle:
            return "bundle: audit type not chosen"
        ward = a.get("ward") or adm.get("ward_id")
        if not ward:
            return "bundle: no ward — audit not posted"
        fmap = fd.field_map()
        elements = []
        for k in (fd.score.items if fd.score else []):
            v = a.get(k)
            if v not in ("Yes", "No"):
                continue
            label = fmap[k].label or k
            known = label in BUNDLE_ELEMENTS
            elements.append({"element": label if known else "Other", "compliant": v == "Yes", "remark": None if known else label})
        if not elements:
            return "bundle: no applicable elements"
        score = ev.get("score")
        audit_rec = await create(ctx, BUNDLE_AUDITS, {
            **base, "bundle": bundle, "ward": ward, "audited_at": rec.get("noted_at"), "device_day": a.get("device_day"),
            "elements": elements, "compliance_percent": score, "all_or_none": score == 100, "corrective_action": a.get("corrective_action"),
            "auditor": _emp(ctx),
        })
        return {BUNDLE_AUDITS: audit_rec["id"]}
    if kind == "who_checklist":
        if not rec.get("ot_booking") or not has(CHECKLISTS):
            return "WHO checklist: no OT booking — saved in the booklet only"
        phase = opts.get("phase")
        cl = await find(ctx, CHECKLISTS, booking=rec["ot_booking"], limit=5)
        cl = [c for c in cl if c.get("booking") == rec["ot_booking"]]
        chk = cl[0] if cl else None
        if phase == "sign_in":
            if not chk:
                chk = await create(ctx, CHECKLISTS, {"patient_id": pid, "encounter_id": eid, "booking": rec["ot_booking"],
                                                    "coordinator": a.get("coordinator") or _emp(ctx), "status": "Not Started"})
            if chk.get("status") != "Not Started":
                return f"WHO checklist already {chk.get('status')}"
            vals = {"si_identity_site_consent": _yes(a.get("si_identity_site_consent")), "si_site_marked": _yes(a.get("si_site_marked")),
                    "si_anaesthesia_check": _yes(a.get("si_anaesthesia_check")), "si_pulse_oximeter": _yes(a.get("si_pulse_oximeter")),
                    "si_known_allergy": a.get("si_known_allergy"), "si_difficult_airway": a.get("si_difficult_airway"),
                    "si_blood_loss_risk": a.get("si_blood_loss_risk")}
            to = "Signed In"
        elif phase == "time_out":
            if not chk or chk.get("status") != "Signed In":
                return f"WHO checklist is {chk.get('status') if chk else 'not started'} — complete Sign In first"
            vals = {"to_team_introduced": _yes(a.get("to_team_introduced")), "to_confirmed": _yes(a.get("to_confirmed")),
                    "to_antibiotic_prophylaxis": a.get("to_antibiotic_prophylaxis"), "to_imaging_displayed": a.get("to_imaging_displayed")}
            to = "Timed Out"
        else:
            if not chk or chk.get("status") != "Timed Out":
                return f"WHO checklist is {chk.get('status') if chk else 'not started'} — complete Time Out first"
            vals = {"so_counts_correct": _yes(a.get("so_counts_correct")), "so_specimen_labelled": a.get("so_specimen_labelled"),
                    "so_equipment_issues": a.get("so_equipment_issues"), "so_recovery_concerns": a.get("so_recovery_concerns")}
            to = "Signed Out"
        vals = {k: v for k, v in vals.items() if v is not None}
        await transition(ctx, CHECKLISTS, chk["id"], to, note=f"From OT booklet {rec.get('code')}", values=vals)
        return {CHECKLISTS: chk["id"]}
    return None


@hook(ENTRIES, "before_transition")
async def _no_generic_transition(ctx, nxt, prev):
    raise forbidden("Clinical forms are signed and amended from the form runner")


# ================================================================== OT booklet

@router.get("/ot/booklet")
async def ot_booklet(ctx: CtxDep, patient_id: str, encounter_id: str | None = None, booking_id: str | None = None):
    sheets = sorted([f for f in all_forms() if f.suite == "ot"], key=lambda f: (["Pre-op", "Intra-op", "Post-op"].index(f.group or "Pre-op"), f.order))
    if not any(f.can_view(ctx.role) for f in sheets):
        raise forbidden("Your role cannot open the OT booklet")
    await _patient(ctx, patient_id)
    adm = await _admission(ctx, encounter_id, patient_id) if encounter_id else {}
    bookings = []
    if has(BOOKINGS):
        for b in await find(ctx, BOOKINGS, patient_id=patient_id, sort="-scheduled_at", limit=50):
            if b.get("status") == "Cancelled":
                continue
            if adm and b.get("encounter_id") and b.get("encounter_id") != adm.get("id"):
                continue
            refs = b.get("_refs") or {}
            bookings.append({"id": b["id"], "code": b.get("code"), "procedure": b.get("procedure"), "scheduled_at": b.get("scheduled_at"),
                             "status": b.get("status"), "theatre": refs.get(b.get("theatre") or ""), "surgeon": refs.get(b.get("surgeon") or ""),
                             "side": b.get("side"), "anaesthesia_type": b.get("anaesthesia_type")})
    booking = next((b for b in bookings if b["id"] == booking_id), None) if booking_id else None
    if booking_id and not booking:
        raise not_found("OT booking not found for this patient")
    rows = await _entries(ctx, pid=patient_id, eid=adm.get("id") if adm else None, keys=[f.key for f in sheets], status=LIVE, limit=1000)
    if booking:
        rows = [r for r in rows if r.get("ot_booking") in (booking["id"], None)]
    else:
        rows = [r for r in rows if not r.get("ot_booking")] if bookings else rows
    names = await _names(ctx, {r.get("signed_by") or "" for r in rows} | {r.get("author") or "" for r in rows})
    by_key: dict[str, dict] = {}
    for r in rows:  # newest first; a signed sheet wins over an older or newer draft
        k = r.get("form_key")
        cur = by_key.get(k)
        if cur is None or (cur.get("status") == "Draft" and r.get("status") in DONE):
            by_key[k] = r
    out = []
    for f in sheets:
        r = by_key.get(f.key)
        status = "Pending"
        if r:
            status = "Completed" if r.get("status") in DONE else "Draft"
        out.append({"key": f.key, "title": f.title, "short": f.short, "group": f.group, "order": f.order, "icon": f.icon,
                    "status": status, "entry": _row(ctx, r, names) if r else None, "access": f.access(ctx.role)})
    done = sum(1 for s in out if s["status"] == "Completed")
    drafts = sum(1 for s in out if s["status"] == "Draft")
    return {"bookings": bookings, "booking": booking, "admission": adm or None, "sheets": out,
            "counts": {"total": len(out), "completed": done, "draft": drafts, "pending": len(out) - done - drafts}}


# ================================================================== text templates

class TemplateIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    body: str = Field(min_length=1, max_length=20000)
    scope: str = "Personal"
    field_keys: list[str] = []
    form_key: str | None = None
    shortcut: str | None = None
    department: str | None = None


def _require_templates(ctx) -> None:
    if ctx.role != "admin" and ctx.role not in TEMPLATE_ROLES:
        raise forbidden("Your role does not use clinical text templates")


async def _my_department(ctx) -> str | None:
    emp = _emp(ctx)
    if not emp:
        return None
    r = (await ctx.conn.execute(sa.select(employees.c.department_id).where(employees.c.id == emp))).first()
    return str(r[0]) if r and r[0] else None


def _template_out(t: dict, me: str) -> dict:
    return {"id": t["id"], "code": t.get("code"), "name": t.get("name"), "scope": t.get("scope"), "body": t.get("body"),
            "field_keys": t.get("field_keys") or [], "form_key": t.get("form_key"), "shortcut": t.get("shortcut"),
            "department": t.get("department"), "department_name": (t.get("_refs") or {}).get(t.get("department") or ""),
            "owner_name": (t.get("_refs") or {}).get(t.get("owner") or ""), "mine": t.get("owner_user") == me,
            "status": t.get("status")}


@router.get("/templates")
async def list_templates(ctx: CtxDep, form_key: str | None = None, field: str | None = None, q: str | None = None, all: bool = False):
    _require_templates(ctx)
    dept = await _my_department(ctx)
    rows = await find(ctx, TEMPLATES, status="Active", limit=500, sort="title")
    out = []
    for t in rows:
        scope = t.get("scope") or "Personal"
        if scope == "Personal" and t.get("owner_user") != ctx.user_id:
            continue
        if scope == "Department" and t.get("department") and t.get("department") != dept and ctx.role != "admin" \
                and t.get("owner_user") != ctx.user_id:
            continue
        if not all:
            if t.get("form_key") and form_key and t["form_key"] != form_key:
                continue
            keys = [_fkey(k) for k in t.get("field_keys") or []]
            if keys and field and _fkey(field) not in keys:
                continue
        if q:
            ql = q.lower()
            if ql not in (t.get("name") or "").lower() and ql not in (t.get("shortcut") or "").lower() and ql not in (t.get("body") or "").lower():
                continue
        out.append(_template_out(t, ctx.user_id))
    rank = {"Personal": 0, "Department": 1, "Global": 2}
    out.sort(key=lambda x: (rank.get(x["scope"], 3), (x["name"] or "").lower()))
    return {"rows": out, "department": dept}


@router.post("/templates", status_code=201)
async def create_template(body: TemplateIn, ctx: CtxDep):
    _require_templates(ctx)
    t = await create(ctx, TEMPLATES, {**body.model_dump(), "status": "Active"})
    t = await get(ctx, TEMPLATES, t["id"])
    return _template_out(t, ctx.user_id)


@router.put("/templates/{tid}")
async def update_template(tid: str, body: TemplateIn, ctx: CtxDep):
    _require_templates(ctx)
    if not await get(ctx, TEMPLATES, tid):
        raise not_found("Template not found")
    await update(ctx, TEMPLATES, tid, body.model_dump())
    return _template_out(await get(ctx, TEMPLATES, tid), ctx.user_id)


@router.delete("/templates/{tid}")
async def delete_template(tid: str, ctx: CtxDep):
    _require_templates(ctx)
    t = await get(ctx, TEMPLATES, tid)
    if not t:
        raise not_found("Template not found")
    _template_owner_check(ctx, t)
    await update(ctx, TEMPLATES, tid, {"status": "Inactive"})
    return {"ok": True}


def _fkey(v: str) -> str:
    """Field keys and labels compare alike: "Chief complaint" == "chief_complaint"."""
    return re.sub(r"[^a-z0-9]+", "_", str(v).lower()).strip("_")


def _template_owner_check(ctx, prev: dict) -> None:
    if ctx.role == "admin" or not prev.get("owner_user") or prev.get("owner_user") == ctx.user_id:
        return
    if prev.get("scope") == "Global" and ctx.role == "quality":
        return
    raise forbidden("Only the template's owner can change it")


@hook(TEMPLATES, "before_create")
async def _template_defaults(ctx, draft):
    scope = draft.get("scope") or "Personal"
    if scope not in ("Personal", "Department", "Global"):
        raise bad_request("Scope must be Personal, Department or Global")
    if scope == "Global" and ctx.role not in ("admin", "quality", "doctor"):
        raise forbidden("Hospital-wide templates are published by doctors, quality or administrators")
    draft["scope"] = scope
    draft["owner_user"] = ctx.user_id
    draft["owner"] = ctx.user.get("employee_id")
    if scope == "Department" and not draft.get("department"):
        dept = await _my_department(ctx)
        if not dept:
            raise bad_request("Choose the department for this template")
        draft["department"] = dept
    if draft.get("field_keys"):
        draft["field_keys"] = sorted({_fkey(k) for k in draft["field_keys"] if _fkey(k)})


@hook(TEMPLATES, "before_update")
async def _template_update(ctx, nxt, prev):
    _template_owner_check(ctx, prev)
    nxt["owner_user"], nxt["owner"] = prev.get("owner_user"), prev.get("owner")
    if nxt.get("scope") == "Global" and prev.get("scope") != "Global" and ctx.role not in ("admin", "quality", "doctor"):
        raise forbidden("Hospital-wide templates are published by doctors, quality or administrators")


# ================================================================== intake / output

IO_TYPES = {
    "In": ["Oral", "IV Fluid", "IV Medication", "Blood / Products", "RT / NG Feed", "TPN"],
    "Out": ["Urine", "Drain", "RT / NG Aspirate", "Vomitus", "Stool", "Bleeding"],
    "kcal": ["Oral diet", "Enteral feed", "TPN", "Supplement"],
}
LEGACY_MAP = [("intake_oral", "In", "Oral"), ("intake_iv", "In", "IV Fluid"), ("intake_ryles", "In", "RT / NG Feed"),
              ("intake_blood", "In", "Blood / Products"), ("output_urine", "Out", "Urine"), ("output_drain", "Out", "Drain"),
              ("output_ng", "Out", "RT / NG Aspirate"), ("output_vomitus", "Out", "Vomitus")]


class IoRow(BaseModel):
    kind: str
    io_type: str = Field(min_length=1, max_length=80)
    amount: float = Field(ge=0, le=20000)
    recorded_at: str | None = None
    remarks: str | None = Field(default=None, max_length=500)
    client_id: str | None = None


class IoIn(BaseModel):
    patient_id: str
    encounter_id: str | None = None
    rows: list[IoRow] = Field(min_length=1, max_length=50)


class IoPatch(BaseModel):
    kind: str | None = None
    io_type: str | None = None
    amount: float | None = Field(default=None, ge=0, le=20000)
    recorded_at: str | None = None
    remarks: str | None = None


class VoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


def _require_io(ctx, write: bool = False) -> None:
    allowed = IO_ROLES if write else (*IO_ROLES, "quality")
    if ctx.role != "admin" and ctx.role not in allowed:
        raise forbidden("Your role cannot chart intake / output")


@hook(IO, "before_create")
@hook(IO, "before_update")
async def _io_check(ctx, nxt, prev=None):
    kind = nxt.get("kind")
    if kind not in IO_TYPES:
        raise bad_request("Kind must be In, Out or kcal", {"fields": {"kind": "Choose In, Out or kcal"}})
    amt = nxt.get("amount")
    if amt is None or float(amt) <= 0:
        raise bad_request("Enter an amount greater than zero", {"fields": {"amount": "Required"}})
    if kind != "kcal" and float(amt) > 10000:
        raise bad_request("A single fluid entry cannot exceed 10,000 mL", {"fields": {"amount": "Too large"}})
    at = _dt_or_none(nxt.get("recorded_at"))
    if at and at > now() + timedelta(minutes=10):
        raise bad_request("The time cannot be in the future", {"fields": {"recorded_at": "Future time"}})
    known = {t.lower(): t for t in IO_TYPES[kind]}
    t = str(nxt.get("io_type") or "").strip()
    nxt["io_type"] = known.get(t.lower(), t[:80])
    if not nxt.get("recorded_by"):
        nxt["recorded_by"] = ctx.user.get("employee_id")


@router.post("/io", status_code=201)
async def io_add(body: IoIn, ctx: CtxDep):
    _require_io(ctx, write=True)
    await _patient(ctx, body.patient_id)
    adm = await _admission(ctx, body.encounter_id, body.patient_id) if body.encounter_id else await _admission(ctx, None, body.patient_id)
    out = []
    for r in body.rows:
        rec = await create(ctx, IO, {"patient_id": body.patient_id, "encounter_id": adm.get("id"), "kind": r.kind, "io_type": r.io_type,
                                     "amount": r.amount, "recorded_at": r.recorded_at or now().isoformat(timespec="minutes"),
                                     "remarks": r.remarks, "status": "Recorded"})
        out.append({**_io_row(rec, {}), "client_id": r.client_id})
    return {"rows": out}


@router.put("/io/{rid}")
async def io_edit(rid: str, body: IoPatch, ctx: CtxDep):
    _require_io(ctx, write=True)
    rec = await get(ctx, IO, rid)
    if not rec:
        raise not_found("Entry not found")
    if rec.get("status") != "Recorded":
        raise conflict("Struck-out entries cannot be edited")
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    rec = await update(ctx, IO, rid, patch)
    return _io_row(rec, {})


@router.post("/io/{rid}/void")
async def io_void(rid: str, body: VoidIn, ctx: CtxDep):
    _require_io(ctx, write=True)
    rec = await get(ctx, IO, rid)
    if not rec:
        raise not_found("Entry not found")
    if rec.get("status") != "Recorded":
        raise conflict("Already struck out")
    rec = await transition(ctx, IO, rid, "Entered in Error", note=body.reason, values={"error_reason": body.reason})
    return _io_row(rec, {})


def _io_row(r: dict, names: dict[str, str]) -> dict:
    return {"id": r["id"], "code": r.get("code"), "kind": r.get("kind"), "io_type": r.get("io_type"), "amount": r.get("amount"),
            "recorded_at": r.get("recorded_at"), "remarks": r.get("remarks"), "status": r.get("status"), "source": "io",
            "recorded_by": r.get("recorded_by"), "recorded_by_name": names.get(r.get("recorded_by") or ""), "error_reason": r.get("error_reason")}


async def _io_rows(ctx, pid: str, eid: str | None, start: datetime | None, end: datetime) -> list[dict]:
    out: list[dict] = []
    ent = E(IO)
    t = ent.table
    at = sa.cast(t.c.data["recorded_at"].astext, TS)
    conds = [*rs.base_where(ent), t.c.patient_id == pid, at < end]
    if eid:
        conds.append(t.c.encounter_id == eid)
    if start:
        conds.append(at >= start)
    for r in (await ctx.conn.execute(sa.select(t).where(*conds).order_by(at.desc()))).all():
        out.append(rs.to_record(r))
    if has(LEGACY_IO):
        lent = E(LEGACY_IO)
        lt = lent.table
        lat = sa.cast(lt.c.data["recorded_at"].astext, TS)
        lconds = [*rs.base_where(lent), lt.c.patient_id == pid, lat < end]
        if eid:
            lconds.append(lt.c.encounter_id == eid)
        if start:
            lconds.append(lat >= start)
        for r in (await ctx.conn.execute(sa.select(lt).where(*lconds))).all():
            rec = rs.to_record(r)
            for key, kind, typ in LEGACY_MAP:
                if rec.get(key):
                    out.append({"id": f"{rec['id']}:{key}", "code": rec.get("code"), "kind": kind, "io_type": typ, "amount": rec[key],
                                "recorded_at": rec.get("recorded_at"), "remarks": rec.get("remarks"), "status": "Recorded",
                                "recorded_by": rec.get("recorded_by"), "source": "legacy"})
    return out


def _sum(rows: list[dict], kind: str, typ: str | None = None) -> float:
    return round(sum(float(r.get("amount") or 0) for r in rows if r.get("status") == "Recorded" and r.get("kind") == kind
                     and (typ is None or r.get("io_type") == typ)), 1)


def _clinical_day_start(ts: datetime) -> datetime:
    ts = ts.astimezone(settings.tz)
    start = ts.replace(hour=CLINICAL_DAY_HOUR, minute=0, second=0, microsecond=0)
    return start if ts >= start else start - timedelta(days=1)


@router.get("/io/balance")
async def io_balance(ctx: CtxDep, patient_id: str, encounter_id: str | None = None, period: str = "clinical_day",
                     start: str | None = None, end: str | None = None):
    """Fluid balance for a window. period: clinical_day | 24h | 3d | 7d | stay | custom (start/end ISO)."""
    _require_io(ctx)
    await _patient(ctx, patient_id)
    adm = await _admission(ctx, encounter_id, patient_id) if encounter_id else await _admission(ctx, None, patient_id)
    eid = adm.get("id")
    t_now = now()
    s_dt, e_dt = _dt_or_none(start), _dt_or_none(end)
    adm_start = _dt_or_none(adm.get("started_at"))
    if period == "clinical_day":
        s_dt = _clinical_day_start(s_dt or t_now)
        e_dt = s_dt + timedelta(days=1)
        label = "Clinical day"
    elif period in ("24h", "3d", "7d"):
        hours = {"24h": 24, "3d": 72, "7d": 168}[period]
        if s_dt and not e_dt:
            e_dt = s_dt + timedelta(hours=hours)
        e_dt = e_dt or t_now
        s_dt = e_dt - timedelta(hours=hours)
        label = {"24h": "24 hours", "3d": "3 days", "7d": "7 days"}[period]
    elif period == "stay":
        e_dt = _dt_or_none(adm.get("ended_at")) or t_now
        first = await _io_rows(ctx, patient_id, eid, None, e_dt) if eid else []
        earliest = min((x for r in first if (x := _dt_or_none(r.get("recorded_at")))), default=None)
        cands = [x for x in (adm_start, earliest) if x and x < e_dt]
        s_dt = min(cands) if cands else e_dt - timedelta(days=1)
        label = "Whole stay"
    elif period == "custom":
        if not s_dt or not e_dt or e_dt <= s_dt:
            raise bad_request("Choose a start and an end time")
        if (e_dt - s_dt).days > 120:
            raise bad_request("Custom windows are limited to 120 days")
        label = "Custom"
    else:
        raise bad_request("Unknown period")
    rows = await _io_rows(ctx, patient_id, eid, s_dt, e_dt)
    rows.sort(key=lambda r: r.get("recorded_at") or "", reverse=True)
    names = await _names(ctx, {r.get("recorded_by") or "" for r in rows})
    intake, output, kcal = _sum(rows, "In"), _sum(rows, "Out"), _sum(rows, "kcal")
    urine = _sum(rows, "Out", "Urine")
    elapsed_end = min(e_dt, t_now)
    hours = max(0.0, round((elapsed_end - s_dt).total_seconds() / 3600, 1))
    weight = await _last_weight(ctx, patient_id, before=e_dt) or await _last_weight(ctx, patient_id)
    rate = round(urine / weight["value"] / hours, 2) if weight and weight["value"] and hours > 0 else None
    by_type: dict[tuple[str, str], float] = {}
    for r in rows:
        if r.get("status") == "Recorded":
            k = (r.get("kind"), r.get("io_type"))
            by_type[k] = by_type.get(k, 0) + float(r.get("amount") or 0)
    shifts = []
    for name, h0, h1 in SHIFTS:
        sel_rows = []
        for r in rows:
            at = _dt_or_none(r.get("recorded_at"))
            if not at:
                continue
            h = at.astimezone(settings.tz).hour
            h = h + 24 if h < CLINICAL_DAY_HOUR else h
            if h0 <= h < h1:
                sel_rows.append(r)
        i, o = _sum(sel_rows, "In"), _sum(sel_rows, "Out")
        shifts.append({"shift": name, "hours": f"{h0 % 24:02d}:00–{h1 % 24:02d}:00", "intake": i, "output": o, "net": round(i - o, 1)})
    days = []
    if (e_dt - s_dt) > timedelta(hours=25):
        d0 = _clinical_day_start(s_dt)
        while d0 < e_dt and len(days) < 130:
            d1 = d0 + timedelta(days=1)
            dr = [r for r in rows if (x := _dt_or_none(r.get("recorded_at"))) and d0 <= x < d1]
            i, o = _sum(dr, "In"), _sum(dr, "Out")
            days.append({"day": d0.date().isoformat(), "start": d0.isoformat(), "end": d1.isoformat(), "intake": i, "output": o,
                         "net": round(i - o, 1), "urine": _sum(dr, "Out", "Urine"), "entries": len(dr)})
            d0 = d1
    # cumulative = every entry of this admission up to the window end (falls back to the window without an admission)
    cum_rows = await _io_rows(ctx, patient_id, eid, None, e_dt) if eid else rows
    ci, co = _sum(cum_rows, "In"), _sum(cum_rows, "Out")
    first_at = min((x for r in cum_rows if (x := _dt_or_none(r.get("recorded_at")))), default=None)
    since = min((x for x in (adm_start, first_at) if x), default=None)
    return {
        "window": {"period": period, "label": label, "start": s_dt.isoformat(), "end": e_dt.isoformat(), "hours": hours,
                   "length_hours": round((e_dt - s_dt).total_seconds() / 3600, 1),
                   "is_current": (s_dt <= t_now < e_dt) or (period == "stay" and not adm.get("ended_at"))},
        "admission": {"id": eid, "code": adm.get("code"), "started_at": adm.get("started_at"), "location": adm.get("location")} if eid else None,
        "intake": intake, "output": output, "net": round(intake - output, 1), "calories": kcal, "urine": urine,
        "entries_count": sum(1 for r in rows if r.get("status") == "Recorded"),
        "urine_rate": {"ml_kg_h": rate, "weight": weight["value"] if weight else None, "weight_at": weight["at"] if weight else None,
                       "weight_source": weight["source"] if weight else None, "hours": hours, "low": rate is not None and rate < 0.5,
                       "threshold": 0.5},
        "cumulative": {"intake": ci, "output": co, "net": round(ci - co, 1), "since": since.isoformat() if since else None},
        "by_type": [{"kind": k[0], "type": k[1], "amount": round(v, 1)} for k, v in sorted(by_type.items(), key=lambda x: (x[0][0], -x[1]))],
        "by_shift": shifts, "by_day": days, "types": IO_TYPES,
        "entries": [{**r, "recorded_by_name": names.get(r.get("recorded_by") or "")} for r in rows],
    }
