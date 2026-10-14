"""Register Framework (module 58): statutory and NABH registers generated from live data.

Each register is a read-only projection of source records for a period — nothing is typed into
a register by hand (corrections go back to the source record, see registers.corrections). The
responsible officer signs each month off (`registers.signoffs`), and every view, export and
sign-off is written to the audit trail because registers carry patient identifiers.

Access: register officers (the module's roles — quality, management — and admin) may open every
register; other readers of the module see a register only if they can read its source records
(restricted sources such as MLC cases still need a break-the-glass reason).
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.registry import get_entity
from ..core.security import CtxDep
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    minutes_between,
    not_found,
    parse_date,
    parse_dt,
    to_csv,
    today,
)
from ..schema import beds, employees, encounters, orders, patients, records, services
from . import metrics
from ._common import E, create, find, update

router = APIRouter(prefix="/api/registers", tags=["registers"])

OFFICER_ROLES = ("quality", "management")


@dataclass
class Register:
    key: str
    name: str                      # value of registers.signoffs.register
    klass: str                     # Statutory | NABH
    legal_basis: str
    authority: str
    source: str                    # primary source entity (access + availability)
    columns: list[tuple[str, str]]
    build: Callable[[Any, date, date], Awaitable[list[dict]]]
    frequency: str = "Monthly"


# ====================================================================== helpers

def _fmt_dt(v: Any) -> str:
    try:
        d = parse_dt(v) if v else None
    except (TypeError, ValueError):
        return str(v)
    return d.astimezone(settings.tz).strftime("%d-%m-%Y %H:%M") if d else ""


def _fmt_d(v: Any) -> str:
    try:
        d = parse_date(v) if v else None
    except (TypeError, ValueError):
        return str(v)
    return d.strftime("%d-%m-%Y") if d else ""


def _yn(v: Any) -> str:
    return "Yes" if v is True or str(v).lower() in ("true", "yes", "1") else "No"


async def _range_recs(ctx, fqn: str, date_key: str, start: date, end: date, *, status: list[str] | None = None,
                      where: list | None = None) -> list[dict]:
    """All records of an entity whose date field falls in [start, end] (no row cap: registers are complete)."""
    ent = get_entity(fqn)
    if not ent:
        return []
    t = ent.table
    conds = rs.base_where(ent)
    col = rs.col_expr(ent, date_key)
    if date_key in ent.physical:
        s, e = metrics._rng(start, end)
        if isinstance(t.c[date_key].type, sa.DateTime):
            conds += [col >= s, col < e]
        else:
            conds += [col >= start, col <= end]
    else:
        conds += [col >= start.isoformat(), col < (end + timedelta(days=1)).isoformat()]
    if status:
        conds.append(t.c.status.in_(status))
    conds += where or []
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(col.asc().nulls_last(), t.c.created_at.asc()))).all()
    out = [rs.to_record(r) for r in rows]
    if out:
        refs = await rs.resolve_refs(ctx, ent, out)
        for r in out:
            r["_refs"] = refs
    return out


async def _people(ctx, ids: set) -> dict[str, dict]:
    ids = {str(i) for i in ids if i}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(patients).where(patients.c.id.in_(list(ids))))).all()
    out = {}
    for r in rows:
        p = rs.to_record(r)
        age = age_from(p.get("dob"))
        out[str(p["id"])] = {"uhid": p.get("code"), "name": p.get("title") or " ".join(x for x in (p.get("first_name"), p.get("last_name")) if x),
                             "age_sex": f"{age if age is not None else '?'}/{(p.get('gender') or '?')[:1]}",
                             "address": ", ".join(x for x in (p.get("address"), p.get("city"), p.get("state"), p.get("pincode")) if x),
                             "phone": p.get("phone")}
    return out


async def _staff(ctx, ids: set) -> dict[str, str]:
    ids = [str(i) for i in ids if i]
    if not ids:
        return {}
    return {str(i): n for i, n in (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name).where(employees.c.id.in_(ids)))).all()}


def _pt(people: dict, pid: Any) -> dict:
    return people.get(str(pid), {}) if pid else {}


def _enc_select():
    w, d = records.alias("w"), records.alias("d")
    return (sa.select(encounters, beds.c.bed_no, w.c.title.label("ward"), d.c.title.label("department"), employees.c.name.label("doctor"))
            .select_from(encounters.outerjoin(beds, beds.c.id == encounters.c.bed_id).outerjoin(w, w.c.id == beds.c.ward_id)
                         .outerjoin(d, d.c.id == encounters.c.department_id).outerjoin(employees, employees.c.id == encounters.c.doctor_id)))


# ====================================================================== register builders

async def reg_admission(ctx, start: date, end: date) -> list[dict]:
    s, e = metrics._rng(start, end)
    rows = [rs.to_record(r) for r in (await ctx.conn.execute(_enc_select().where(
        encounters.c.type == "IPD", encounters.c.started_at >= s, encounters.c.started_at < e, encounters.c.deleted_at.is_(None))
        .order_by(encounters.c.started_at))).all()]
    ppl = await _people(ctx, {r["patient_id"] for r in rows})
    return [{"ip_no": r["code"], "admitted_at": _fmt_dt(r.get("started_at")), "uhid": _pt(ppl, r["patient_id"]).get("uhid"),
             "name": _pt(ppl, r["patient_id"]).get("name"), "age_sex": _pt(ppl, r["patient_id"]).get("age_sex"),
             "address": _pt(ppl, r["patient_id"]).get("address"), "department": r.get("department"), "doctor": r.get("doctor"),
             "ward_bed": " / ".join(x for x in (r.get("ward"), r.get("bed_no")) if x), "admission_type": r.get("admission_type"),
             "source": r.get("admission_source"), "diagnosis": r.get("diagnosis"), "payer": r.get("payer"), "mlc": _yn(r.get("mlc")),
             "status": r.get("status")} for r in rows]


async def _summaries(ctx, enc_ids: list[str]) -> dict[str, dict]:
    ent = get_entity("discharge.summaries")
    if not ent or not enc_ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(records).where(*rs.base_where(ent), records.c.encounter_id.in_(enc_ids)))).all()
    return {str(r.encounter_id): rs.to_record(r) for r in rows}


async def reg_discharge(ctx, start: date, end: date) -> list[dict]:
    s, e = metrics._rng(start, end)
    rows = [rs.to_record(r) for r in (await ctx.conn.execute(_enc_select().where(
        encounters.c.type == "IPD", encounters.c.status == "Discharged", encounters.c.ended_at >= s, encounters.c.ended_at < e,
        encounters.c.deleted_at.is_(None)).order_by(encounters.c.ended_at))).all()]
    ppl = await _people(ctx, {r["patient_id"] for r in rows})
    sums = await _summaries(ctx, [r["id"] for r in rows])
    out = []
    for r in rows:
        sm = sums.get(r["id"], {})
        a, b = parse_dt(r.get("started_at")) if r.get("started_at") else None, parse_dt(r.get("ended_at")) if r.get("ended_at") else None
        out.append({"ip_no": r["code"], "uhid": _pt(ppl, r["patient_id"]).get("uhid"), "name": _pt(ppl, r["patient_id"]).get("name"),
                    "age_sex": _pt(ppl, r["patient_id"]).get("age_sex"), "admitted_at": _fmt_dt(a), "discharged_at": _fmt_dt(b),
                    "los_days": round((b - a).total_seconds() / 86400, 1) if a and b else "", "department": r.get("department"),
                    "doctor": r.get("doctor"), "discharge_type": sm.get("discharge_type") or r.get("discharge_type") or "Routine",
                    "final_diagnosis": sm.get("final_diagnosis") or r.get("diagnosis"), "condition": sm.get("condition_at_discharge") or "",
                    "summary": f"{sm.get('code')} ({sm.get('status')})" if sm else "Not prepared"})
    return out


async def reg_mlc(ctx, start: date, end: date) -> list[dict]:
    cases = await _range_recs(ctx, "er.mlc_cases", "incident_at", start, end)
    s, e = metrics._rng(start, end)
    flagged = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(encounters).where(
        encounters.c.data["mlc"].astext == "true", encounters.c.started_at >= s, encounters.c.started_at < e,
        encounters.c.deleted_at.is_(None)).order_by(encounters.c.started_at))).all()]
    covered = {str(c.get("encounter_id")) for c in cases if c.get("encounter_id")} | {str(c.get("patient_id")) for c in cases}
    ppl = await _people(ctx, {c["patient_id"] for c in cases} | {f["patient_id"] for f in flagged})
    docs = await _staff(ctx, {c.get("examining_doctor") for c in cases})
    out = [{"mlc_no": c.get("mlc_no") or c.get("code"), "reported_at": _fmt_dt(c.get("incident_at") or c.get("created_at")),
            "uhid": _pt(ppl, c["patient_id"]).get("uhid"), "name": _pt(ppl, c["patient_id"]).get("name"),
            "age_sex": _pt(ppl, c["patient_id"]).get("age_sex"), "address": _pt(ppl, c["patient_id"]).get("address"),
            "case_type": c.get("case_type"), "brought_by": " — ".join(x for x in (c.get("brought_by"), c.get("brought_by_name")) if x),
            "police_station": c.get("police_station"), "intimated_at": _fmt_dt(c.get("intimation_sent_at")),
            "examining_doctor": docs.get(str(c.get("examining_doctor")), ""), "status": c.get("status")} for c in cases]
    for f in flagged:
        if str(f["id"]) in covered or str(f["patient_id"]) in covered:
            continue
        out.append({"mlc_no": f"{f['code']} (flag only)", "reported_at": _fmt_dt(f.get("started_at")), "uhid": _pt(ppl, f["patient_id"]).get("uhid"),
                    "name": _pt(ppl, f["patient_id"]).get("name"), "age_sex": _pt(ppl, f["patient_id"]).get("age_sex"),
                    "address": _pt(ppl, f["patient_id"]).get("address"), "case_type": f.get("chief_complaint") or f.get("diagnosis"),
                    "brought_by": f.get("brought_by") or f.get("arrival_mode"), "police_station": "", "intimated_at": "",
                    "examining_doctor": "", "status": "MLC case form not filed"})
    return out


async def reg_birth(ctx, start: date, end: date) -> list[dict]:
    babies = await _range_recs(ctx, "maternity.newborns", "birth_at", start, end)
    labour_ids = [b.get("labour") for b in babies if b.get("labour")]
    labour: dict[str, dict] = {}
    if labour_ids and get_entity("maternity.labour"):
        for r in (await ctx.conn.execute(sa.select(records).where(records.c.id.in_(labour_ids)))).all():
            labour[str(r.id)] = rs.to_record(r)
    ppl = await _people(ctx, {b["patient_id"] for b in babies} | {b.get("mother") for b in babies})
    docs = await _staff(ctx, {lb.get("obstetrician") for lb in labour.values()})
    return [{"birth_at": _fmt_dt(b.get("birth_at")), "baby_uhid": _pt(ppl, b["patient_id"]).get("uhid"), "sex": b.get("sex"),
             "mother_uhid": _pt(ppl, b.get("mother")).get("uhid"), "mother_name": _pt(ppl, b.get("mother")).get("name"),
             "address": _pt(ppl, b.get("mother")).get("address"), "birth_weight_g": b.get("birth_weight_g"),
             "gestation_weeks": b.get("gestation_weeks"), "birth_order": b.get("birth_order"),
             "delivery_mode": labour.get(str(b.get("labour")), {}).get("delivery_mode"),
             "apgar": "/".join(str(b.get(k)) for k in ("apgar_1", "apgar_5") if b.get(k) is not None),
             "obstetrician": docs.get(str(labour.get(str(b.get("labour")), {}).get("obstetrician")), ""),
             "reported_to_registrar": _yn(b.get("birth_reported")), "status": b.get("status")} for b in babies]


async def reg_death(ctx, start: date, end: date) -> list[dict]:
    s, e = metrics._rng(start, end)
    rows = [rs.to_record(r) for r in (await ctx.conn.execute(_enc_select().where(
        encounters.c.deleted_at.is_(None), encounters.c.ended_at >= s, encounters.c.ended_at < e,
        sa.or_(encounters.c.data["discharge_type"].astext == "Death", encounters.c.data["disposition"].astext == "Expired"))
        .order_by(encounters.c.ended_at))).all()]
    seen = {str(r["patient_id"]) for r in rows}
    dod = patients.c.data["date_of_death"].astext
    deceased = [rs.to_record(p) for p in (await ctx.conn.execute(sa.select(patients).where(
        patients.c.status == "Deceased", patients.c.deleted_at.is_(None), dod >= start.isoformat(),
        dod < (end + timedelta(days=1)).isoformat()))).all()]
    ppl = await _people(ctx, seen | {str(p["id"]) for p in deceased})
    pmap = {str(p["id"]): p for p in deceased}
    sums = await _summaries(ctx, [r["id"] for r in rows])
    out = []
    for r in rows:
        sm = sums.get(r["id"], {})
        p = pmap.get(str(r["patient_id"]), {})
        out.append({"uhid": _pt(ppl, r["patient_id"]).get("uhid"), "name": _pt(ppl, r["patient_id"]).get("name"),
                    "age_sex": _pt(ppl, r["patient_id"]).get("age_sex"), "address": _pt(ppl, r["patient_id"]).get("address"),
                    "died_at": _fmt_dt(p.get("date_of_death") or r.get("ended_at")), "encounter": f"{r['code']} ({r.get('type')})",
                    "admitted_at": _fmt_dt(r.get("started_at")), "department": r.get("department"), "doctor": r.get("doctor"),
                    "cause": sm.get("final_diagnosis") or r.get("diagnosis") or r.get("provisional_diagnosis") or "",
                    "mlc": _yn(r.get("mlc"))})
    for pid, p in pmap.items():
        if pid in seen:
            continue
        out.append({"uhid": _pt(ppl, pid).get("uhid"), "name": _pt(ppl, pid).get("name"), "age_sex": _pt(ppl, pid).get("age_sex"),
                    "address": _pt(ppl, pid).get("address"), "died_at": _fmt_dt(p.get("date_of_death")), "encounter": "—",
                    "admitted_at": "", "department": "", "doctor": "", "cause": "", "mlc": ""})
    return out


async def reg_ot(ctx, start: date, end: date) -> list[dict]:
    rows = await _range_recs(ctx, "ot.bookings", "scheduled_at", start, end)
    ppl = await _people(ctx, {r["patient_id"] for r in rows})
    docs = await _staff(ctx, {r.get(k) for r in rows for k in ("surgeon", "assistant_surgeon", "anaesthetist")})
    out = []
    for r in rows:
        dur = minutes_between(r.get("incision_at"), r.get("closure_at"))
        out.append({"date": _fmt_dt(r.get("scheduled_at")), "booking": r.get("code"), "theatre": (r.get("_refs") or {}).get(r.get("theatre"), ""),
                    "uhid": _pt(ppl, r["patient_id"]).get("uhid"), "name": _pt(ppl, r["patient_id"]).get("name"),
                    "age_sex": _pt(ppl, r["patient_id"]).get("age_sex"), "procedure": r.get("procedure"), "side": r.get("side"),
                    "surgeon": docs.get(str(r.get("surgeon")), ""), "anaesthetist": docs.get(str(r.get("anaesthetist")), ""),
                    "anaesthesia": r.get("anaesthesia_type"), "asa": r.get("asa_grade"), "surgery_type": r.get("surgery_type"),
                    "wound_class": r.get("wound_class"), "incision_closure": f"{_fmt_dt(r.get('incision_at'))[-5:]}–{_fmt_dt(r.get('closure_at'))[-5:]}"
                    if r.get("incision_at") else "", "duration_min": dur if dur is not None else "", "status": r.get("status"),
                    "remarks": r.get("cancel_reason") or ""})
    return out


async def reg_transfusion(ctx, start: date, end: date) -> list[dict]:
    reqs = await _range_recs(ctx, "bloodbank.requests", "issued_at", start, end, status=["Issued"])
    reactions = await _range_recs(ctx, "bloodbank.reactions", "reaction_at", start - timedelta(days=2), end + timedelta(days=2))
    by_req = {str(x.get("request")): x for x in reactions if x.get("request")}
    ppl = await _people(ctx, {r["patient_id"] for r in reqs})
    staff = await _staff(ctx, {r.get(k) for r in reqs for k in ("requested_by", "issued_to")})
    out = []
    for r in reqs:
        rx = by_req.get(str(r["id"]))
        out.append({"issued_at": _fmt_dt(r.get("issued_at")), "request": r.get("code"), "uhid": _pt(ppl, r["patient_id"]).get("uhid"),
                    "name": _pt(ppl, r["patient_id"]).get("name"), "age_sex": _pt(ppl, r["patient_id"]).get("age_sex"),
                    "blood_group": r.get("patient_blood_group"), "component": r.get("component"), "units": r.get("units"),
                    "bags": ", ".join(r.get("allocated_units") or []), "crossmatch": " / ".join(x for x in (r.get("crossmatch_method"), r.get("crossmatch_result")) if x),
                    "indication": r.get("indication"), "requested_by": staff.get(str(r.get("requested_by")), ""),
                    "issued_to": staff.get(str(r.get("issued_to")), ""),
                    "reaction": f"Yes — {rx.get('reaction_type') or 'type pending'} ({rx.get('severity') or '—'})" if rx else "None reported"})
    return out


async def reg_bmw(ctx, start: date, end: date) -> list[dict]:
    rows = await _range_recs(ctx, "bmw.waste_logs", "log_date", start, end)
    staff = await _staff(ctx, {r.get("logged_by") for r in rows})
    return [{"date": _fmt_d(r.get("log_date")), "log": r.get("code"), "location": " / ".join(x for x in ((r.get("_refs") or {}).get(r.get("department")),
                                                                                                    (r.get("_refs") or {}).get(r.get("ward"))) if x),
             "category": r.get("category"), "waste_type": r.get("waste_type"), "bags": r.get("bag_count"), "weight_kg": r.get("weight_kg"),
             "bag_barcode": r.get("bag_barcode"), "pre_treatment": r.get("pre_treatment"), "segregation_ok": _yn(r.get("segregation_ok")),
             "logged_by": staff.get(str(r.get("logged_by")), ""), "status": r.get("status")} for r in rows]


async def reg_narcotic(ctx, start: date, end: date) -> list[dict]:
    disp = await _range_recs(ctx, "pharmacy.dispenses", "dispensed_at", start, end, status=["Dispensed", "Partially Returned", "Returned"])
    item_ids = {ln.get("item") for d in disp for ln in d.get("items") or [] if ln.get("item")}
    sched: dict[str, dict] = {}
    if item_ids:
        for r in (await ctx.conn.execute(sa.select(records.c.id, records.c.title, records.c.data).where(records.c.id.in_(list(item_ids))))).all():
            sched[str(r.id)] = {"name": r.title, "schedule": (r.data or {}).get("schedule"), "form": (r.data or {}).get("form"),
                                "strength": (r.data or {}).get("strength")}
    rx_ids = [d.get("prescription") for d in disp if d.get("prescription")]
    prescriber: dict[str, str] = {}
    if rx_ids:
        rx = {str(r.id): (r.data or {}).get("doctor") for r in (await ctx.conn.execute(sa.select(records.c.id, records.c.data).where(records.c.id.in_(rx_ids)))).all()}
        names = await _staff(ctx, set(rx.values()))
        prescriber = {k: names.get(str(v), "") for k, v in rx.items()}
    ppl = await _people(ctx, {d["patient_id"] for d in disp})
    staff = await _staff(ctx, {d.get("pharmacist") for d in disp})
    out = []
    for d in disp:
        for ln in d.get("items") or []:
            it = sched.get(str(ln.get("item")), {})
            if it.get("schedule") not in ("Narcotic", "X"):
                continue
            out.append({"dispensed_at": _fmt_dt(d.get("dispensed_at")), "dispense": d.get("code"), "store": d.get("store"),
                        "uhid": _pt(ppl, d["patient_id"]).get("uhid"), "name": _pt(ppl, d["patient_id"]).get("name"),
                        "age_sex": _pt(ppl, d["patient_id"]).get("age_sex"), "drug": it.get("name"), "schedule": it.get("schedule"),
                        "batch": ln.get("batch"), "qty": ln.get("qty"), "prescriber": prescriber.get(str(d.get("prescription")), ""),
                        "pharmacist": staff.get(str(d.get("pharmacist")), ""), "status": d.get("status")})
    return out


async def reg_restraint(ctx, start: date, end: date) -> list[dict]:
    rows = await _range_recs(ctx, "psychiatry.restraints", "started_at", start, end)
    ppl = await _people(ctx, {r["patient_id"] for r in rows})
    staff = await _staff(ctx, {r.get("authorised_by") for r in rows})
    return [{"started_at": _fmt_dt(r.get("started_at")), "ended_at": _fmt_dt(r.get("ended_at")),
             "duration_min": minutes_between(r.get("started_at"), r.get("ended_at")) or "", "uhid": _pt(ppl, r["patient_id"]).get("uhid"),
             "name": _pt(ppl, r["patient_id"]).get("name"), "age_sex": _pt(ppl, r["patient_id"]).get("age_sex"),
             "type": r.get("restraint_type"), "reason": r.get("reason"), "less_restrictive": r.get("less_restrictive_tried"),
             "authorised_by": staff.get(str(r.get("authorised_by")), ""), "checks": len(r.get("checks") or []),
             "nr_informed": _yn(r.get("nr_informed")), "mhrb_reported": _yn(r.get("mhrb_reported")), "status": r.get("status")} for r in rows]


async def reg_critical(ctx, start: date, end: date) -> list[dict]:
    s, e = metrics._rng(start, end)
    o = orders
    rows = [rs.to_record(r) for r in (await ctx.conn.execute(
        sa.select(o, services.c.title.label("test"), encounters.c.type.label("enc_type"), beds.c.bed_no)
        .select_from(o.outerjoin(services, services.c.id == o.c.service_id).outerjoin(encounters, encounters.c.id == o.c.encounter_id)
                     .outerjoin(beds, beds.c.id == encounters.c.bed_id))
        .where(o.c.critical.is_(True), o.c.deleted_at.is_(None), sa.func.coalesce(o.c.resulted_at, o.c.verified_at) >= s,
               sa.func.coalesce(o.c.resulted_at, o.c.verified_at) < e).order_by(o.c.resulted_at))).all()]
    ppl = await _people(ctx, {r["patient_id"] for r in rows})
    out = []
    for r in rows:
        mins = minutes_between(r.get("resulted_at") or r.get("verified_at"), r.get("acknowledged_at"))
        vals = [f"{v.get('parameter')} {v.get('value')} {v.get('unit') or ''} ({v.get('flag')})".replace("  ", " ")
                for v in r.get("result_values") or [] if str(v.get("flag") or "").startswith("Critical")]
        out.append({"resulted_at": _fmt_dt(r.get("resulted_at") or r.get("verified_at")), "order": r.get("code"),
                    "uhid": _pt(ppl, r["patient_id"]).get("uhid"), "name": _pt(ppl, r["patient_id"]).get("name"),
                    "location": f"{r.get('enc_type') or 'OPD'}{(' · ' + r['bed_no']) if r.get('bed_no') else ''}", "test": r.get("test"),
                    "critical_values": "; ".join(vals) or (r.get("impression") or ""), "acknowledged_at": _fmt_dt(r.get("acknowledged_at")),
                    "acknowledged_by": r.get("acknowledged_by") or "", "minutes_to_ack": mins if mins is not None else "Pending",
                    "within_30_min": "Yes" if mins is not None and mins <= 30 else "No"})
    return out


async def reg_incident(ctx, start: date, end: date) -> list[dict]:
    rows = await _range_recs(ctx, "safety.incidents", "occurred_at", start, end)
    ppl = await _people(ctx, {r.get("patient_id") for r in rows})
    staff = await _staff(ctx, {r.get("reported_by") for r in rows if not r.get("anonymous")})
    return [{"occurred_at": _fmt_dt(r.get("occurred_at")), "incident": r.get("code"), "type": r.get("incident_type"), "severity": r.get("severity"),
             "location": " / ".join(x for x in (r.get("location"), (r.get("_refs") or {}).get(r.get("department")),
                                                (r.get("_refs") or {}).get(r.get("ward"))) if x),
             "uhid": _pt(ppl, r.get("patient_id")).get("uhid") or "", "description": (r.get("description") or "")[:300],
             "immediate_action": (r.get("immediate_action") or "")[:200], "ncc_merp": r.get("ncc_merp_category") or "",
             "reported_by": "Anonymous" if r.get("anonymous") else staff.get(str(r.get("reported_by")), ""), "status": r.get("status")} for r in rows]


def _cols(spec: str) -> list[tuple[str, str]]:
    return [tuple(x.split("=", 1)) for x in spec.split("|")]  # type: ignore[misc]


REGISTERS: dict[str, Register] = {r.key: r for r in [
    Register("admission", "Admission Register", "Statutory", "Clinical Establishments Act & Rules; NABH AAC.4", "Inspection by the registering authority",
             "ipd.admissions", _cols("ip_no=IP No|admitted_at=Admitted on|uhid=UHID|name=Patient|age_sex=Age/Sex|address=Address|department=Department"
                                     "|doctor=Admitting consultant|ward_bed=Ward / bed|admission_type=Type|source=Source|diagnosis=Provisional diagnosis"
                                     "|payer=Payer|mlc=MLC|status=Status"), reg_admission, "Daily"),
    Register("discharge", "Discharge Register", "Statutory", "Clinical Establishments Act; NABH AAC.14", "Inspection by the registering authority",
             "ipd.admissions", _cols("ip_no=IP No|uhid=UHID|name=Patient|age_sex=Age/Sex|admitted_at=Admitted|discharged_at=Discharged|los_days=LOS (days)"
                                     "|department=Department|doctor=Consultant|discharge_type=Discharge type|final_diagnosis=Final diagnosis"
                                     "|condition=Condition|summary=Discharge summary"), reg_discharge, "Daily"),
    Register("mlc", "MLC Register", "Statutory", "CrPC s.39 / BNSS s.33; State medico-legal rules", "Local Police (MLC)",
             "er.mlc_cases", _cols("mlc_no=MLC No|reported_at=Date & time|uhid=UHID|name=Patient|age_sex=Age/Sex|address=Address|case_type=Nature of case"
                                   "|brought_by=Brought by|police_station=Police station|intimated_at=Police intimated|examining_doctor=Examining doctor"
                                   "|status=Status"), reg_mlc, "Per event"),
    Register("birth", "Birth Register", "Statutory", "Registration of Births & Deaths Act 1969 (Form 1)", "Registrar of Births & Deaths",
             "maternity.newborns", _cols("birth_at=Date & time of birth|baby_uhid=Baby UHID|sex=Sex|mother_uhid=Mother UHID|mother_name=Mother"
                                         "|address=Address|birth_weight_g=Weight (g)|gestation_weeks=Gestation (wk)|birth_order=Birth order"
                                         "|delivery_mode=Mode of delivery|apgar=APGAR 1/5|obstetrician=Obstetrician"
                                         "|reported_to_registrar=Reported to registrar|status=Status"), reg_birth, "Per event"),
    Register("death", "Death Register", "Statutory", "Registration of Births & Deaths Act 1969 (Form 2, MCCD Form 4)", "Registrar of Births & Deaths",
             "ipd.admissions", _cols("uhid=UHID|name=Deceased|age_sex=Age/Sex|address=Address|died_at=Date & time of death|encounter=Encounter"
                                     "|admitted_at=Admitted|department=Department|doctor=Certifying consultant|cause=Cause / final diagnosis|mlc=MLC"),
             reg_death, "Per event"),
    Register("ot", "OT Register", "NABH", "NABH COP.15 / Surgical safety", "NABH assessment",
             "ot.bookings", _cols("date=Scheduled|booking=Booking|theatre=Theatre|uhid=UHID|name=Patient|age_sex=Age/Sex|procedure=Procedure|side=Side"
                                  "|surgeon=Surgeon|anaesthetist=Anaesthetist|anaesthesia=Anaesthesia|asa=ASA|surgery_type=Type|wound_class=Wound class"
                                  "|incision_closure=Incision–closure|duration_min=Duration (min)|status=Status|remarks=Remarks"), reg_ot, "Daily"),
    Register("blood-transfusion", "Blood Transfusion Register", "Statutory", "Drugs & Cosmetics Rules 1945 (Part XII-B); NABH COP.11",
             "Drugs Control Department", "bloodbank.requests",
             _cols("issued_at=Issued on|request=Request|uhid=UHID|name=Patient|age_sex=Age/Sex|blood_group=Group|component=Component|units=Units"
                   "|bags=Bag numbers|crossmatch=Cross-match|indication=Indication|requested_by=Requested by|issued_to=Issued to|reaction=Reaction"),
             reg_transfusion, "Daily"),
    Register("bmw", "Biomedical Waste Register", "Statutory", "Bio-Medical Waste Management Rules 2016 (Form IV records)",
             "State Pollution Control Board", "bmw.waste_logs",
             _cols("date=Date|log=Log|location=Department / ward|category=Category|waste_type=Waste type|bags=Bags|weight_kg=Weight (kg)"
                   "|bag_barcode=Bag barcode|pre_treatment=Pre-treatment|segregation_ok=Segregation OK|logged_by=Logged by|status=Status"),
             reg_bmw, "Daily"),
    Register("narcotic", "Narcotic Drugs Register", "Statutory", "NDPS Act 1985 & NDPS Rules (Form 3E/3H); Schedule X records",
             "Drugs Control Department", "pharmacy.dispenses",
             _cols("dispensed_at=Date & time|dispense=Dispense|store=Store|uhid=UHID|name=Patient|age_sex=Age/Sex|drug=Drug|schedule=Schedule"
                   "|batch=Batch|qty=Qty|prescriber=Prescriber|pharmacist=Pharmacist|status=Status"), reg_narcotic, "Daily"),
    Register("restraint", "Restraint Register", "Statutory", "Mental Healthcare Act 2017 s.97 (restraint register, monthly report to MHRB)",
             "Mental Health Review Board", "psychiatry.restraints",
             _cols("started_at=Started|ended_at=Ended|duration_min=Duration (min)|uhid=UHID|name=Patient|age_sex=Age/Sex|type=Type|reason=Reason"
                   "|less_restrictive=Less restrictive measures tried|authorised_by=Authorised by|checks=Checks recorded|nr_informed=NR informed"
                   "|mhrb_reported=MHRB reported|status=Status"), reg_restraint, "Per event"),
    Register("critical-results", "Critical Results Register", "NABH", "NABH AAC.6 (critical results communicated within defined time)",
             "NABH assessment", "orders.orders",
             _cols("resulted_at=Resulted|order=Order|uhid=UHID|name=Patient|location=Location|test=Test|critical_values=Critical values"
                   "|acknowledged_at=Acknowledged|acknowledged_by=Acknowledged by|minutes_to_ack=Minutes to ack|within_30_min=Within 30 min"),
             reg_critical, "Daily"),
    Register("incident", "Incident Register", "NABH", "NABH PSQ.3 (incident reporting, RCA & CAPA)", "NABH assessment",
             "safety.incidents", _cols("occurred_at=Occurred|incident=Incident|type=Type|severity=Severity|location=Location|uhid=UHID"
                                       "|description=Description|immediate_action=Immediate action|ncc_merp=NCC MERP|reported_by=Reported by"
                                       "|status=Status"), reg_incident, "Per event"),
]}


# ====================================================================== access & period

def _check(ctx, reg: Register, mode: str = "read") -> None:
    rs.ensure_access(ctx, E("registers.signoffs"), mode)
    if ctx.role == "admin" or ctx.role in OFFICER_ROLES:
        return
    src = get_entity(reg.source)
    if not src:
        raise _unavailable(reg)
    rs.ensure_access(ctx, src, "read")


def _unavailable(reg: Register) -> ApiError:
    return ApiError(503, f"{reg.name} needs the {reg.source.split('.')[0]} module, which is not installed")


def _get(key: str) -> Register:
    reg = REGISTERS.get(key)
    if not reg:
        raise not_found(f"Unknown register '{key}'")
    if not get_entity(reg.source):
        raise _unavailable(reg)
    return reg


PERIOD_RX = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def _month(period: str) -> tuple[date, date]:
    if not PERIOD_RX.match(period or ""):
        raise bad_request("Period must be a month as YYYY-MM")
    y, m = (int(x) for x in period.split("-"))
    start = date(y, m, 1)
    return start, (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def _bounds(d_from: str | None, d_to: str | None, period: str | None) -> tuple[date, date]:
    if period:
        return _month(period)
    try:
        end = parse_date(d_to) or today()
        start = parse_date(d_from) or end.replace(day=1)
    except ValueError as e:
        raise bad_request("Dates must be YYYY-MM-DD") from e
    if start > end:
        raise bad_request("'from' must be on or before 'to'")
    if (end - start).days > 400:
        raise bad_request("A register can cover at most 400 days at a time")
    return start, end


async def _signoff(ctx, reg: Register, period: str) -> dict | None:
    rows = await find(ctx, "registers.signoffs", register=reg.name, period=period, limit=1, sort="-created_at")
    return rows[0] if rows else None


def _meta(reg: Register, defn: dict | None = None) -> dict:
    return {"key": reg.key, "name": reg.name, "class": (defn or {}).get("register_class") or reg.klass,
            "legal_basis": (defn or {}).get("legal_basis") or reg.legal_basis, "authority": (defn or {}).get("authority") or reg.authority,
            "frequency": (defn or {}).get("frequency") or reg.frequency, "source": reg.source,
            "columns": [{"key": k, "label": lbl} for k, lbl in reg.columns], "available": get_entity(reg.source) is not None,
            "definition": (defn or {}).get("code")}


async def _definitions(ctx) -> dict[str, dict]:
    return {d.get("register"): d for d in await find(ctx, "registers.definitions", status="Active", limit=200)}


# ====================================================================== endpoints

@router.get("")
async def list_registers(ctx: CtxDep):
    rs.ensure_access(ctx, E("registers.signoffs"), "read")
    defs = await _definitions(ctx)
    month = today().strftime("%Y-%m")
    prev = (today().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    signs = await find(ctx, "registers.signoffs", limit=500, sort="-created_at")
    out = []
    for reg in REGISTERS.values():
        m = _meta(reg, defs.get(reg.name))
        try:
            _check(ctx, reg)
            m["can_view"] = True
        except ApiError:  # access refusal (incl. break-glass required) just marks the register as not viewable
            m["can_view"] = False
        mine = [s for s in signs if s.get("register") == reg.name]
        m["signoffs"] = {p: next(({"id": s["id"], "code": s["code"], "status": s["status"]} for s in mine if s.get("period") == p), None)
                         for p in (prev, month)}
        out.append(m)
    return {"registers": out, "can_sign": ctx.role == "admin" or ctx.role in OFFICER_ROLES}


async def _generate(ctx, key: str, d_from: str | None, d_to: str | None, period: str | None, action: str) -> tuple[Register, date, date, list[dict]]:
    reg = _get(key)
    _check(ctx, reg)
    start, end = _bounds(d_from, d_to, period)
    rows = await reg.build(ctx, start, end)
    await audit(ctx, action, module="registers", entity="signoffs", after={"register": reg.name, "from": start.isoformat(),
                                                                          "to": end.isoformat(), "rows": len(rows)},
                note=f"{reg.name} {start:%d-%m-%Y}–{end:%d-%m-%Y}")
    return reg, start, end, rows


@router.get("/{key}.csv", response_class=PlainTextResponse)
async def register_csv(key: str, ctx: CtxDep, date_from: str | None = Query(None, alias="from"),
                       date_to: str | None = Query(None, alias="to"), period: str | None = None):
    reg, start, end, rows = await _generate(ctx, key, date_from, date_to, period, "register.export")
    body = to_csv(rows, reg.columns)
    fname = f"{reg.key}-register_{start.isoformat()}_{end.isoformat()}.csv"
    return PlainTextResponse("﻿" + body, media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.get("/{key}")
async def register_view(key: str, ctx: CtxDep, date_from: str | None = Query(None, alias="from"),
                        date_to: str | None = Query(None, alias="to"), period: str | None = None):
    reg, start, end, rows = await _generate(ctx, key, date_from, date_to, period, "register.view")
    whole_month = start.day == 1 and end == (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    so = await _signoff(ctx, reg, start.strftime("%Y-%m")) if whole_month else None
    defs = await _definitions(ctx)
    return {"register": _meta(reg, defs.get(reg.name)), "from": start.isoformat(), "to": end.isoformat(), "count": len(rows), "rows": rows,
            "period": start.strftime("%Y-%m") if whole_month else None, "signoff": so and {k: so.get(k) for k in (
                "id", "code", "status", "entries_count", "discrepancies", "signed_by", "signed_at", "remarks")},
            "hospital": settings.hospital_name, "generated_at": datetime.now(settings.tz).isoformat(timespec="seconds")}


class SignoffIn(BaseModel):
    period: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    discrepancies: int = Field(default=0, ge=0)
    discrepancy_notes: str | None = Field(default=None, max_length=2000)


@router.post("/{key}/signoff", status_code=201)
async def register_signoff(key: str, body: SignoffIn, ctx: CtxDep):
    reg = _get(key)
    rs.ensure_access(ctx, E("registers.signoffs"), "write")
    _check(ctx, reg)
    start, end = _month(body.period)
    if start > today():
        raise bad_request("A future month cannot be signed off")
    rows = await reg.build(ctx, start, end)
    existing = await _signoff(ctx, reg, body.period)
    payload = {"entries_count": len(rows), "discrepancies": body.discrepancies, "discrepancy_notes": body.discrepancy_notes,
               "generated_at": datetime.now(settings.tz).isoformat(timespec="seconds")}
    if existing:
        if existing.get("status") == "Signed":
            raise conflict(f"{reg.name} for {body.period} is already signed ({existing['code']}); reopen it to make changes")
        rec = await update(ctx, "registers.signoffs", existing["id"], payload)
    else:
        rec = await create(ctx, "registers.signoffs", {"register": reg.name, "period": body.period, "status": "Open", **payload})
    await audit(ctx, "register.signoff", module="registers", entity="signoffs", record=rec,
                after={"register": reg.name, "period": body.period, "entries": len(rows)})
    return rec


__all__ = ["router", "REGISTERS"]
