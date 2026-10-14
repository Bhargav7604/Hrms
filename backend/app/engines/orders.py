"""Orders & results: CPOE with order sets and duplicate checks, laboratory (barcoded collection,
receipt, result entry with automatic flagging, authorisation), radiology (scheduling, accession
number / PACS link, templated reporting), critical-result alerts and acknowledgement, TAT, and
the clinician result inbox."""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit, hook
from ..core.registry import get_entity
from ..core.security import CtxDep
from ..core.sequences import next_seq
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    day_bounds,
    is_uuid,
    minutes_between,
    new_id,
    not_found,
    now,
    parse_dt,
    to_json_value,
    today,
)
from ..schema import beds, charges, employees, encounters, orders, patients, records, services
from ._common import E, create, find, first, get, has, live, require_role, transition, update

router = APIRouter(prefix="/api/orders", tags=["orders"])

ORD = "orders.orders"
SCOPED = {"LAB": "lab.lab_orders", "RAD": "radiology.rad_orders"}
ORDER_FQNS = (ORD, *SCOPED.values())
SAMPLES, TEMPLATES, ROOMS, TRANSPORT = "lab.samples", "radiology.report_templates", "radiology.modalities", "transport.requests"

# tariff category → order category (anything else — rooms, packages, consultations — is not orderable)
SERVICE_TO_ORDER = {"LAB": "LAB", "RAD": "RAD", "PROC": "PROC", "PHYSIO": "PROC", "DIALYSIS": "PROC", "DENTAL": "PROC",
                    "DIET": "DIET", "NURSING": "NURSING"}
CATALOGUE = ("LAB", "RAD", "PROC")
ACTIVE = ("Ordered", "Collected", "In Progress", "Resulted")
OPEN_IPD = ("Admitted", "Discharge Initiated")
PRIORITY_RANK = {"STAT": 0, "Urgent": 1, "Routine": 2}
DEFAULT_TAT = {"LAB": 240, "RAD": 360, "PROC": 120}
PRIORITY_TAT_CAP = {"STAT": 60, "Urgent": 120}  # minutes, NABH-style STAT targets
FLAGS = ("Normal", "Low", "High", "Critical Low", "Critical High", "Abnormal")

RESULT_ROLES = {"LAB": ("lab", "doctor"), "RAD": ("radiology", "doctor"), "PROC": ("doctor", "nurse")}
VERIFY_ROLES = {"LAB": ("lab", "doctor"), "RAD": ("radiology", "doctor"), "PROC": ("doctor",)}
COLLECT_ROLES = ("lab", "nurse")
CLINICIANS = ("doctor", "nurse")

# Deployment-specific: the hospital PACS (e.g. OHIF / vendor web viewer) and its DICOM UID root.
PACS_VIEWER_URL = "https://pacs.vlack.local/viewer"
DICOM_UID_ROOT = "1.2.826.0.1.3680043.10.1045"  # placeholder root until the hospital registers its own

ORDER_SETS: dict[str, dict[str, Any]] = {
    "fever": {"name": "Fever panel", "description": "Acute febrile illness — dengue / malaria / sepsis screen",
              "codes": ["LAB-CBC", "LAB-ESR", "LAB-CRP", "LAB-MP", "LAB-DENGUE", "LAB-URINE", "LAB-LFT"]},
    "cardiac": {"name": "Cardiac panel", "description": "Chest pain / suspected acute coronary syndrome", "priority": "STAT",
                "codes": ["PROC-ECG", "LAB-TROP", "LAB-CBC", "LAB-ELEC", "LAB-RFT", "LAB-PT", "LAB-LIPID", "RAD-XR-CHEST"]},
    "preop": {"name": "Pre-op panel", "description": "Pre-anaesthetic work-up for elective surgery",
              "codes": ["LAB-CBC", "LAB-RBS", "LAB-RFT", "LAB-ELEC", "LAB-PT", "LAB-BGRP", "LAB-HIV", "LAB-HBSAG", "LAB-URINE",
                        "PROC-ECG", "RAD-XR-CHEST"]},
    "sepsis": {"name": "Sepsis bundle", "description": "Suspected sepsis — cultures before antibiotics", "priority": "STAT",
               "codes": ["LAB-CULT-B", "LAB-CBC", "LAB-PROCAL", "LAB-ABG", "LAB-RFT", "LAB-LFT", "LAB-PT", "LAB-CRP"]},
    "diabetes": {"name": "Diabetes review", "description": "Glycaemic control and end-organ screen",
                 "codes": ["LAB-FBS", "LAB-HBA1C", "LAB-RFT", "LAB-LIPID", "LAB-URINE"]},
}

BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {"name": "X-Ray chest PA — normal", "modality": "X-Ray", "body_part": "Chest", "template":
     "TECHNIQUE: Chest radiograph, PA view.\n\nFINDINGS:\nTrachea is central. Both lung fields are clear.\n"
     "Cardiothoracic ratio is within normal limits. Both costophrenic angles are clear.\n"
     "Hila and domes of diaphragm are normal. Bony thorax is unremarkable.\n\nIMPRESSION:\nNo active cardiopulmonary disease."},
    {"name": "USG whole abdomen — normal", "modality": "Ultrasound", "body_part": "Abdomen", "template":
     "TECHNIQUE: Real-time B-mode ultrasonography of the abdomen and pelvis.\n\nFINDINGS:\n"
     "Liver: Normal in size and echotexture. No focal lesion. IHBR not dilated.\n"
     "Gall bladder: Well distended, no calculi, wall thickness normal.\nCBD: Normal calibre.\n"
     "Pancreas and spleen: Normal.\nKidneys: Right __ cm, left __ cm; normal cortical echogenicity, no calculi or hydronephrosis.\n"
     "Urinary bladder: Well distended, normal wall.\nNo free fluid in the abdomen.\n\nIMPRESSION:\nNo significant abnormality detected."},
    {"name": "CT brain (plain) — normal", "modality": "CT", "body_part": "Brain", "template":
     "TECHNIQUE: Axial non-contrast CT of the brain.\n\nFINDINGS:\nNo intra- or extra-axial haemorrhage.\n"
     "Grey-white matter differentiation is preserved. Ventricles and sulci are normal for age.\n"
     "No midline shift or mass effect. Posterior fossa structures are normal.\nCalvarium is intact.\n\n"
     "IMPRESSION:\nNo acute intracranial abnormality."},
    {"name": "MRI lumbosacral spine", "modality": "MRI", "body_part": "Spine", "template":
     "TECHNIQUE: Multiplanar multisequence MRI of the lumbosacral spine.\n\nFINDINGS:\nAlignment: \nVertebral bodies: \n"
     "Intervertebral discs (L1-L2 to L5-S1): \nSpinal canal and neural foramina: \nConus medullaris: Ends at __ level, normal signal.\n"
     "Paraspinal soft tissues: \n\nIMPRESSION:\n"},
    {"name": "General report", "modality": None, "body_part": None, "template":
     "CLINICAL DETAILS: \n\nTECHNIQUE: \n\nFINDINGS:\n\nIMPRESSION:\n"},
]

TRANSPORT_DESTINATION = {"X-Ray": "Radiology — X-ray", "CT": "Radiology — CT", "MRI": "Radiology — MRI",
                         "Ultrasound": "Ultrasound", "PET-CT": "Radiology — CT"}


def _stamp() -> str:
    return now().isoformat(timespec="seconds")


def _name(first_name: str | None, last_name: str | None) -> str:
    return " ".join(x for x in (first_name, last_name) if x) or "—"


# ================================================================== result flagging

_NEGATIVE = re.compile(r"^\s*(neg|non[- ]?reactive|not\s+(detected|seen|isolated|found)|nil|absent|no\s+growth|sterile|normal)", re.I)
_POSITIVE = re.compile(r"^\s*(pos|reactive|detected|present|seen|isolated|growth|\+)|\b(falciparum|vivax)\b", re.I)


def _num(v: Any) -> float | None:
    s = str(v).strip().replace(",", "").lstrip("<>=≤≥ ")
    try:
        return float(s)
    except ValueError:
        return None


def flag_for(value: Any, p: dict | None) -> str | None:
    """Normal / Low / High / Critical Low / Critical High for numbers against the test's ranges;
    Normal / Abnormal for recognisable qualitative results; None when it cannot be judged."""
    if value in (None, ""):
        return None
    n = _num(value)
    if n is None:
        s = str(value)
        if _NEGATIVE.search(s):
            return "Normal"
        return "Abnormal" if _POSITIVE.search(s) else None
    if not p:
        return None
    lim = {k: (float(p[k]) if p.get(k) not in (None, "") else None) for k in ("critical_low", "critical_high", "ref_low", "ref_high")}
    if lim["critical_low"] is not None and n <= lim["critical_low"]:
        return "Critical Low"
    if lim["critical_high"] is not None and n >= lim["critical_high"]:
        return "Critical High"
    if lim["ref_low"] is not None and n < lim["ref_low"]:
        return "Low"
    if lim["ref_high"] is not None and n > lim["ref_high"]:
        return "High"
    return "Normal" if lim["ref_low"] is not None or lim["ref_high"] is not None else None


def ref_range(p: dict | None) -> str | None:
    if not p:
        return None
    lo, hi = p.get("ref_low"), p.get("ref_high")
    if lo not in (None, "") and hi not in (None, ""):
        return f"{float(lo):g}–{float(hi):g}"
    if hi not in (None, ""):
        return f"< {float(hi):g}"
    if lo not in (None, ""):
        return f"> {float(lo):g}"
    return None


def _params(svc: dict | None) -> dict[str, dict]:
    return {str(p.get("parameter") or "").strip().lower(): p for p in (svc or {}).get("parameters") or [] if p.get("parameter")}


def flag_values(svc: dict | None, values: list[dict]) -> tuple[list[dict], bool]:
    params = _params(svc)
    out, critical = [], False
    for v in values or []:
        name = str(v.get("parameter") or "").strip()
        if not name:
            continue
        p = params.get(name.lower())
        computed = flag_for(v.get("value"), p)
        flag = computed if computed is not None else (v.get("flag") if v.get("flag") in FLAGS else None)
        out.append({"parameter": name, "value": None if v.get("value") is None else str(v["value"]),
                    "unit": v.get("unit") or (p or {}).get("unit") or None, "ref_range": v.get("ref_range") or ref_range(p),
                    "flag": flag})
        critical = critical or str(flag or "").startswith("Critical")
    return out, critical


# ================================================================== lookups

async def _service(ctx, sid: str | None) -> dict | None:
    if not sid or not is_uuid(sid):
        return None
    row = (await ctx.conn.execute(sa.select(services).where(services.c.id == sid, services.c.deleted_at.is_(None)))).first()
    return rs.to_record(row) if row else None


async def _order(ctx, oid: str) -> dict:
    o = await get(ctx, ORD, oid)
    if not o:
        raise not_found("Order not found")
    return o


async def _active_encounter(ctx, pid: str) -> str | None:
    e = encounters
    row = (await ctx.conn.execute(sa.select(e.c.id).where(
        e.c.patient_id == pid, e.c.deleted_at.is_(None),
        sa.or_(sa.and_(e.c.type == "IPD", e.c.status.in_(OPEN_IPD)),
               sa.and_(e.c.type == "ER", e.c.status.in_(["Waiting", "In Treatment", "Observation"]))))
        .order_by(sa.case((e.c.type == "IPD", 0), else_=1), e.c.started_at.desc().nulls_last()).limit(1))).first()
    return str(row.id) if row else None


async def _patient_line(ctx, pid: str) -> dict:
    row = (await ctx.conn.execute(sa.select(patients.c.code, patients.c.first_name, patients.c.last_name, patients.c.gender,
                                            patients.c.dob).where(patients.c.id == pid))).first()
    if not row:
        return {"id": pid, "name": "—", "uhid": None}
    return {"id": pid, "name": _name(row.first_name, row.last_name), "uhid": row.code, "gender": row.gender, "age": age_from(row.dob)}


def section_of(svc_data: dict | None, category: str | None) -> str | None:
    d = svc_data or {}
    if category == "RAD":
        return d.get("modality")
    if category != "LAB":
        return None
    if d.get("section"):
        return d["section"]
    sample = str(d.get("sample_type") or "")
    name = str(d.get("name") or "").lower()
    if "culture" in name or sample in ("Swab", "Sputum", "CSF"):
        return "Microbiology"
    if sample == "Tissue" or "histo" in name or "fnac" in name:
        return "Histopathology"
    if "blood gas" in name or "electrolyte" in name:
        return "Biochemistry"
    if any(k in name for k in ("inr", "d-dimer", "aptt", "fibrinogen")):
        return "Haematology"
    if sample in ("Urine", "Stool", "Fluid"):
        return "Clinical Pathology"
    if sample == "Whole Blood (EDTA)":
        return "Haematology"
    if any(k in name for k in ("hiv", "hbsag", "dengue", "igm", "hcv", "vdrl")):
        return "Serology & Immunology"
    return "Biochemistry"


def _target(category: str | None, priority: str | None, tat: int | None) -> int:
    t = int(tat or DEFAULT_TAT.get(category or "", 240))
    cap = PRIORITY_TAT_CAP.get(priority or "")
    return min(t, cap) if cap else t


async def _next_code(ctx, kind: str, fmt: str) -> tuple[str, int]:
    d = now()
    key = d.strftime(fmt)
    n = await next_seq(ctx.conn, f"{kind}:{key}")
    return key, n


async def _barcode(ctx) -> str:
    day, n = await _next_code(ctx, "barcode", "%y%m%d")
    return f"{day}{n:04d}"


# ================================================================== hooks (all three order entities share them)

def _defaults_for(fqn: str):
    async def _defaults(ctx, draft: dict) -> None:
        svc = await _service(ctx, draft.get("service_id"))
        if not svc:
            raise bad_request("Choose a valid test or service", {"fields": {"service_id": "Unknown service"}})
        cat = SERVICE_TO_ORDER.get(svc.get("category") or "")
        if not cat:
            raise bad_request(f"{svc.get('name')} ({svc.get('category')}) is not an orderable test or procedure",
                              {"fields": {"service_id": "Not orderable"}})
        scoped = (get_entity(fqn).scope or {}).get("category") if get_entity(fqn) else None
        if scoped and scoped != cat:
            raise bad_request(f"{svc.get('name')} is a {cat} service, not {scoped}", {"fields": {"service_id": "Wrong department"}})
        if svc.get("status") == "Inactive":
            raise bad_request(f"{svc.get('name')} is inactive in the tariff", {"fields": {"service_id": "Inactive"}})
        draft["category"] = cat
        draft["ordered_at"] = draft.get("ordered_at") or _stamp()
        draft["ordered_by"] = draft.get("ordered_by") or ctx.user_id
        if not draft.get("encounter_id") and draft.get("patient_id"):
            draft["encounter_id"] = await _active_encounter(ctx, draft["patient_id"])
    return _defaults


async def _before_transition(ctx, nxt: dict, prev: dict) -> None:
    to = nxt["status"]
    if to == "Collected" and nxt.get("category") == "LAB" and not nxt.get("sample_barcode"):
        nxt["sample_barcode"] = await _barcode(ctx)
    elif to == "Resulted":
        if nxt.get("result_values"):
            nxt["result_values"], crit = flag_values(await _service(ctx, nxt.get("service_id")), nxt["result_values"])
            nxt["critical"] = bool(nxt.get("critical") or crit)
        if not nxt.get("result_values") and not str(nxt.get("result") or "").strip():
            raise bad_request("Enter the result values or the report before resulting", {"fields": {"result_values": "Required"}})
        nxt["resulted_by"] = ctx.user.get("name")
    elif to == "Verified":
        nxt["verified_by"] = f"{ctx.user.get('name')} ({ctx.role})"
        nxt["tat_minutes"] = minutes_between(nxt.get("ordered_at"), nxt.get("verified_at") or _stamp())
    elif to == "Cancelled":
        nxt["cancelled_by"] = ctx.user.get("name")
    if to in ("Resulted", "Verified") and nxt.get("critical") and not nxt.get("critical_notified_at"):
        nxt["critical_notified_at"] = _stamp()


async def _after_transition(ctx, rec: dict, prev: dict) -> None:
    to = rec["status"]
    if to == "Collected" and rec.get("category") == "LAB":
        await _ensure_sample(ctx, rec)
    if rec.get("critical_notified_at") and rec.get("critical_notified_at") != prev.get("critical_notified_at"):
        await _alert_critical(ctx, rec)
    if to == "Verified":
        await emit("order.verified", ctx, {"order": rec})
    elif to == "Cancelled":
        await _reverse_charges(ctx, rec)


for _fqn in ORDER_FQNS:
    hook(_fqn, "before_create")(_defaults_for(_fqn))
    hook(_fqn, "before_transition")(_before_transition)
    hook(_fqn, "after_transition")(_after_transition)


async def _ensure_sample(ctx, rec: dict) -> dict | None:
    """One lab.samples record per tube (barcode); tests sharing a tube are listed on it."""
    if not has(SAMPLES) or not rec.get("sample_barcode"):
        return None
    existing = await first(ctx, SAMPLES, barcode=rec["sample_barcode"])
    if existing:
        linked = list(existing.get("orders") or [existing.get("order")])
        if rec["id"] not in linked:
            existing = await update(ctx, SAMPLES, existing["id"], {"orders": [*linked, rec["id"]]})
        return existing
    svc = await _service(ctx, rec.get("service_id")) or {}
    sample_field = E(SAMPLES).field_map.get("sample_type")
    sample_type = svc.get("sample_type") if sample_field and svc.get("sample_type") in (sample_field.options or []) else None
    return await create(ctx, SAMPLES, {
        "patient_id": rec["patient_id"], "order": rec["id"], "orders": [rec["id"]], "barcode": rec["sample_barcode"],
        "sample_type": sample_type, "container": svc.get("container"), "collected_at": rec.get("collected_at") or _stamp(),
        "status": "Collected",
    })


async def _alert_critical(ctx, rec: dict) -> None:
    p = await _patient_line(ctx, rec["patient_id"])
    svc = await _service(ctx, rec.get("service_id")) or {}
    crit_values = [f"{v.get('parameter')} {v.get('value')}{' ' + v['unit'] if v.get('unit') else ''} ({v.get('flag')})"
                   for v in rec.get("result_values") or [] if str(v.get("flag") or "").startswith("Critical")]
    test = svc.get("name") or rec.get("code")
    detail = f"{test}: {'; '.join(crit_values[:3])}" if crit_values else test
    live(ctx, "alerts", {"type": "critical_result", "patient": f"{p['name']} ({p.get('uhid') or '—'})", "test": detail,
                         "order_id": rec["id"], "patient_id": rec["patient_id"], "category": rec.get("category")})
    await audit(ctx, "critical.notified", module="orders", entity="orders", record=rec, after={"values": crit_values or [test]})
    await emit("order.critical", ctx, {"order": rec, "patient": p, "test": test, "values": crit_values})


async def _reverse_charges(ctx, rec: dict) -> None:
    """A cancelled order must not be billed: void its unbilled charge; flag a billed one for a credit note."""
    rows = (await ctx.conn.execute(sa.select(charges.c.id, charges.c.status).where(
        charges.c.source_id == rec["id"], charges.c.deleted_at.is_(None)))).all()
    for r in rows:
        if r.status == "Unbilled":
            ch = await update(ctx, "billing.charges", str(r.id), {"status": "Cancelled"})
            await audit(ctx, "charge.cancel", module="billing", entity="charges", record=ch,
                        note=f"Order {rec.get('code')} cancelled: {rec.get('cancel_reason') or ''}".strip())
        elif r.status == "Billed":
            await audit(ctx, "charge.credit_needed", module="billing", entity="charges", record={"id": str(r.id), "patient_id": rec["patient_id"]},
                        note=f"Order {rec.get('code')} cancelled after billing — raise a credit note")


# ================================================================== row shaping (worklists, inbox, detail)

def _order_query():
    o, s, p, e, b = orders, services, patients, encounters, beds
    w = records.alias("w")
    return (sa.select(
        o.c.id, o.c.code, o.c.status, o.c.category, o.c.priority, o.c.patient_id, o.c.encounter_id, o.c.service_id, o.c.ordered_by,
        o.c.ordered_at, o.c.collected_at, o.c.resulted_at, o.c.verified_at, o.c.critical, o.c.acknowledged_at, o.c.data,
        s.c.code.label("svc_code"), s.c.title.label("svc_name"), s.c.tat_minutes.label("svc_tat"), s.c.data.label("svc_data"),
        p.c.code.label("uhid"), p.c.first_name, p.c.last_name, p.c.gender, p.c.dob,
        e.c.type.label("enc_type"), e.c.status.label("enc_status"), b.c.bed_no, w.c.title.label("ward"))
        .select_from(o.join(p, p.c.id == o.c.patient_id).outerjoin(s, s.c.id == o.c.service_id)
                     .outerjoin(e, e.c.id == o.c.encounter_id).outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id))
        .where(o.c.deleted_at.is_(None)))


def _location(r) -> str:
    if r.enc_type == "IPD" and r.enc_status in OPEN_IPD:
        return " · ".join(x for x in (r.ward, r.bed_no) if x) or "Inpatient"
    if r.enc_type == "ER":
        return "Emergency"
    return "IPD (discharged)" if r.enc_type == "IPD" else "OPD"


def _row(r, ts: datetime, uid: str | None = None, names: dict[str, str] | None = None) -> dict:
    d, sd = r.data or {}, r.svc_data or {}
    target = _target(r.category, r.priority, r.svc_tat)
    done = r.verified_at if r.status == "Verified" else None
    elapsed = round(((done or ts) - r.ordered_at).total_seconds() / 60) if r.ordered_at else None
    return {
        "id": str(r.id), "code": r.code, "status": r.status, "category": r.category, "priority": r.priority or "Routine",
        "patient": {"id": str(r.patient_id), "name": _name(r.first_name, r.last_name), "uhid": r.uhid, "gender": r.gender,
                    "age": age_from(r.dob)},
        "encounter_id": str(r.encounter_id) if r.encounter_id else None, "location": _location(r),
        "test": {"id": str(r.service_id) if r.service_id else None, "code": r.svc_code, "name": r.svc_name or r.svc_code,
                 "sample_type": sd.get("sample_type"), "container": sd.get("container"), "modality": sd.get("modality"),
                 "body_part": sd.get("body_part"), "contrast": sd.get("contrast"), "section": section_of({**sd, "name": r.svc_name}, r.category)},
        "ordered_at": to_json_value(r.ordered_at), "collected_at": to_json_value(r.collected_at),
        "resulted_at": to_json_value(r.resulted_at), "verified_at": to_json_value(r.verified_at),
        "elapsed_minutes": elapsed, "target_minutes": target,
        "due_at": to_json_value(r.ordered_at + timedelta(minutes=target)) if r.ordered_at else None,
        "overdue": bool(elapsed is not None and elapsed > target and r.status not in ("Cancelled",)),
        "critical": bool(r.critical), "acknowledged_at": to_json_value(r.acknowledged_at), "acknowledged_by": d.get("acknowledged_by"),
        "clinical_notes": d.get("clinical_notes"), "sample_barcode": d.get("sample_barcode"),
        "scheduled_at": d.get("scheduled_at"), "modality_room": d.get("modality_room"), "accession_no": d.get("accession_no"),
        "pacs_url": d.get("pacs_url"), "result_values": d.get("result_values") or [], "result": d.get("result"),
        "impression": d.get("impression"), "tat_minutes": d.get("tat_minutes"), "verified_by": d.get("verified_by"),
        "resulted_by": d.get("resulted_by"), "ordering_doctor": (names or {}).get(d.get("ordering_doctor") or ""),
        "verbal_order": bool(d.get("verbal_order")), "read": bool(uid and uid in (d.get("read_by") or [])),
    }


async def _employee_names(ctx, rows) -> dict[str, str]:
    ids = {(r.data or {}).get("ordering_doctor") for r in rows}
    ids = [i for i in ids if i and is_uuid(i)]
    if not ids:
        return {}
    return {str(i): n for i, n in (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name).where(employees.c.id.in_(ids)))).all()}


def _sort_key(x: dict) -> tuple:
    return (PRIORITY_RANK.get(x["priority"], 3), x["ordered_at"] or "")


# ================================================================== CPOE

@router.get("/catalogue")
async def catalogue(ctx: CtxDep):
    rs.ensure_access(ctx, E(ORD), "read")
    rows = (await ctx.conn.execute(sa.select(services).where(
        services.c.deleted_at.is_(None), services.c.category.in_(CATALOGUE), sa.func.coalesce(services.c.status, "Active") == "Active")
        .order_by(services.c.title))).all()
    out = []
    for r in rows:
        rec = rs.to_record(r)
        out.append({"id": rec["id"], "code": rec.get("code"), "name": rec.get("name") or rec.get("title"), "category": rec.get("category"),
                    "rate": rec.get("rate"), "tat_minutes": rec.get("tat_minutes"), "sample_type": rec.get("sample_type"),
                    "container": rec.get("container"), "modality": rec.get("modality"), "body_part": rec.get("body_part"),
                    "contrast": bool(rec.get("contrast")), "prep_instructions": rec.get("prep_instructions"),
                    "section": section_of(rec, rec.get("category"))})
    by_code = {s["code"]: s for s in out}
    sets = [{"key": k, "name": v["name"], "description": v["description"], "priority": v.get("priority", "Routine"),
             "items": [by_code[c] for c in v["codes"] if c in by_code], "missing": [c for c in v["codes"] if c not in by_code]}
            for k, v in ORDER_SETS.items()]
    return {"services": out, "order_sets": sets}


@router.get("/patient/{pid}/context")
async def patient_context(pid: str, ctx: CtxDep):
    """Everything the order-entry screen needs about the patient in one call."""
    rs.ensure_access(ctx, E(ORD), "read")
    if not is_uuid(pid):
        raise not_found("Patient not found")
    p = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid, patients.c.deleted_at.is_(None)))).first()
    if not p:
        raise not_found("Patient not found")
    pr = rs.to_record(p)
    allergies = list(pr.get("allergies") or [])
    if has("emr.allergies"):
        for a in await find(ctx, "emr.allergies", patient_id=pid, status="Active", limit=50):
            if a.get("allergen") and a["allergen"] not in allergies:
                allergies.append(a["allergen"])
    enc = None
    eid = await _active_encounter(ctx, pid)
    if eid:
        e, b, doc = encounters, beds, employees
        w = records.alias("w")
        er = (await ctx.conn.execute(sa.select(e.c.id, e.c.code, e.c.type, e.c.status, e.c.started_at, e.c.data, b.c.bed_no,
                                               w.c.title.label("ward"), doc.c.name.label("doctor"))
                                     .select_from(e.outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id)
                                                  .outerjoin(doc, doc.c.id == e.c.doctor_id)).where(e.c.id == eid))).first()
        enc = {"id": str(er.id), "code": er.code, "type": er.type, "status": er.status, "started_at": to_json_value(er.started_at),
               "bed": er.bed_no, "ward": er.ward, "doctor": er.doctor, "diagnosis": (er.data or {}).get("diagnosis")}
    ts = now()
    rows = (await ctx.conn.execute(_order_query().where(orders.c.patient_id == pid, orders.c.ordered_at >= ts - timedelta(days=30))
                                   .order_by(orders.c.ordered_at.desc()).limit(80))).all()
    names = await _employee_names(ctx, rows)
    return {"patient": {"id": pid, "uhid": pr.get("code"), "name": _name(pr.get("first_name"), pr.get("last_name")),
                        "title": pr.get("title"), "gender": pr.get("gender"), "age": age_from(pr.get("dob")), "status": pr.get("status"),
                        "blood_group": pr.get("blood_group"), "payer_type": pr.get("payer_type")},
            "allergies": allergies, "encounter": enc, "recent": [_row(r, ts, names=names) for r in rows]}


class CpoeItem(BaseModel):
    service_id: str
    priority: Literal["Routine", "Urgent", "STAT"] = "Routine"
    clinical_notes: str | None = Field(default=None, max_length=500)


class CpoeIn(BaseModel):
    patient_id: str
    encounter_id: str | None = None
    items: list[CpoeItem] = Field(min_length=1, max_length=40)
    clinical_notes: str | None = Field(default=None, max_length=500)
    ordering_doctor: str | None = None
    order_set: str | None = None
    confirm_duplicates: bool = False


async def _duplicates(ctx, pid: str, service_ids: list[str]) -> list[dict]:
    o, s = orders, services
    rows = (await ctx.conn.execute(
        sa.select(o.c.id, o.c.code, o.c.status, o.c.ordered_at, o.c.service_id, s.c.title)
        .select_from(o.outerjoin(s, s.c.id == o.c.service_id))
        .where(o.c.patient_id == pid, o.c.service_id.in_(service_ids), o.c.ordered_at >= now() - timedelta(hours=24),
               o.c.status != "Cancelled", o.c.deleted_at.is_(None)).order_by(o.c.ordered_at.desc()))).all()
    return [{"service_id": str(r.service_id), "test": r.title, "order_id": str(r.id), "code": r.code, "status": r.status,
             "ordered_at": to_json_value(r.ordered_at)} for r in rows]


@router.post("/cpoe", status_code=201)
async def cpoe(body: CpoeIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(ORD), "write")
    if not is_uuid(body.patient_id):
        raise bad_request("Choose a patient")
    p = (await ctx.conn.execute(sa.select(patients.c.status, patients.c.first_name, patients.c.last_name, patients.c.code)
                                .where(patients.c.id == body.patient_id, patients.c.deleted_at.is_(None)))).first()
    if not p:
        raise not_found("Patient not found")
    if p.status in ("Merged", "Deceased"):
        raise conflict(f"Orders cannot be placed: the patient record is {p.status.lower()}")
    enc_id = body.encounter_id
    if enc_id:
        row = (await ctx.conn.execute(sa.select(encounters.c.patient_id).where(encounters.c.id == enc_id))).first() if is_uuid(enc_id) else None
        if not row or str(row.patient_id) != body.patient_id:
            raise bad_request("The visit / admission does not belong to this patient")
    else:
        enc_id = await _active_encounter(ctx, body.patient_id)
    verbal = ctx.role != "doctor"
    doctor = ctx.user.get("employee_id") if ctx.role == "doctor" else body.ordering_doctor
    if verbal and ctx.role != "admin" and not (doctor and is_uuid(doctor)):
        raise bad_request("Select the ordering doctor for this verbal / telephone order", {"fields": {"ordering_doctor": "Required"}})
    ids = [i.service_id for i in body.items]
    if len(set(ids)) != len(ids):
        raise bad_request("The same test is listed twice in this order")
    if not all(is_uuid(i) for i in ids):
        raise bad_request("Invalid test in the order")
    svcs = {str(r.id): rs.to_record(r) for r in (await ctx.conn.execute(sa.select(services).where(
        services.c.id.in_(ids), services.c.deleted_at.is_(None)))).all()}
    bad = [i for i in ids if i not in svcs or SERVICE_TO_ORDER.get(svcs[i].get("category") or "") is None
           or svcs[i].get("status") == "Inactive"]
    if bad:
        raise bad_request("Not orderable: " + ", ".join(svcs[i].get("name", i) if i in svcs else "unknown test" for i in bad))
    warnings = await _duplicates(ctx, body.patient_id, ids)
    if warnings and not body.confirm_duplicates:
        raise ApiError(409, f"{len({w['service_id'] for w in warnings})} test(s) already ordered in the last 24 hours",
                       {"warnings": warnings}, code="DUPLICATE_ORDER")
    warned = {w["service_id"] for w in warnings}
    batch = new_id()
    pname = f"{_name(p.first_name, p.last_name)} ({p.code})"
    created = []
    for item in body.items:
        svc = svcs[item.service_id]
        rec = await create(ctx, ORD, {
            "patient_id": body.patient_id, "encounter_id": enc_id, "service_id": item.service_id,
            "category": SERVICE_TO_ORDER[svc["category"]], "priority": item.priority,
            "clinical_notes": (item.clinical_notes or body.clinical_notes or "").strip() or None,
            "ordering_doctor": doctor, "status": "Ordered", "order_batch": batch, "order_set": body.order_set,
            "verbal_order": verbal, "entered_by": ctx.user.get("name"), "duplicate_override": item.service_id in warned,
        })
        created.append(rec)
        if item.priority == "STAT":
            live(ctx, "alerts", {"type": "stat_order", "category": rec["category"], "order_id": rec["id"], "code": rec["code"],
                                 "test": svc.get("name"), "patient": pname})
    return {"orders": [{"id": r["id"], "code": r["code"], "category": r["category"], "priority": r.get("priority"),
                        "test": svcs[r["service_id"]].get("name"), "status": r["status"]} for r in created],
            "count": len(created), "amount": float(sum(float(svcs[i].get("rate") or 0) for i in ids)),
            "encounter_id": enc_id, "warnings": warnings}


# ================================================================== worklists

@router.get("/worklist")
async def worklist(ctx: CtxDep, category: Literal["LAB", "RAD", "PROC"] = "LAB", status: str | None = None,
                   section: str | None = None, q: str | None = None, limit: int = 300):
    rs.ensure_access(ctx, E(SCOPED.get(category, ORD)), "read")
    ts = now()
    start, _ = day_bounds(today())
    o = orders
    stmt = _order_query().where(o.c.category == category)
    if q and q.strip():
        term = q.strip()
        like = f"%{term.lower()}%"
        stmt = stmt.where(o.c.ordered_at >= ts - timedelta(days=30), sa.or_(
            sa.func.lower(o.c.code) == term.lower(), o.c.data["sample_barcode"].astext == term,
            o.c.data["accession_no"].astext == term, patients.c.code == term.upper(),
            sa.func.lower(sa.func.concat(patients.c.first_name, " ", patients.c.last_name)).like(like)))
    else:
        stmt = stmt.where(sa.or_(o.c.status.in_(ACTIVE), sa.and_(o.c.status == "Verified", o.c.verified_at >= start)))
    rows = (await ctx.conn.execute(stmt.order_by(o.c.ordered_at.asc()).limit(3000))).all()
    names = await _employee_names(ctx, rows)
    items = [_row(r, ts, names=names) for r in rows]
    if section:
        items = [x for x in items if x["test"]["section"] == section]
    sections = sorted({x["test"]["section"] for x in items if x["test"]["section"]})
    counts: dict[str, int] = defaultdict(int)
    for x in items:
        counts[x["status"]] += 1
    wanted = [s for s in (status or "").split(",") if s]
    if wanted:
        items = [x for x in items if x["status"] in wanted]
    items.sort(key=_sort_key)
    return {"rows": items[: max(1, min(limit, 1000))], "total": len(items), "counts": counts, "sections": sections,
            "overdue": sum(1 for x in items if x["overdue"] and x["status"] != "Verified"),
            "stat": sum(1 for x in items if x["priority"] == "STAT" and x["status"] != "Verified"),
            "generated_at": ts.isoformat(timespec="seconds")}


async def _detail(ctx, oid: str) -> dict:
    row = (await ctx.conn.execute(_order_query().where(orders.c.id == oid))).first() if is_uuid(oid) else None
    if not row:
        raise not_found("Order not found")
    x = _row(row, now(), ctx.user_id, await _employee_names(ctx, [row]))
    svc = await _service(ctx, x["test"]["id"]) or {}
    x["parameters"] = [{"parameter": p.get("parameter"), "unit": p.get("unit"), "ref_range": ref_range(p),
                        **{k: p.get(k) for k in ("ref_low", "ref_high", "critical_low", "critical_high")}}
                       for p in svc.get("parameters") or [] if p.get("parameter")]
    x["prep_instructions"] = svc.get("prep_instructions")
    x["sample"] = None
    if x["sample_barcode"] and has(SAMPLES):
        s = await first(ctx, SAMPLES, barcode=x["sample_barcode"])
        x["sample"] = {k: s.get(k) for k in ("id", "code", "status", "barcode", "sample_type", "collected_at", "received_at",
                                             "rejection_reason")} if s else None
    room = await get(ctx, ROOMS, x["modality_room"]) if x["modality_room"] and has(ROOMS) else None
    x["modality_room_name"] = room.get("name") if room else None
    x["actions"] = _actions(ctx.role, x)
    return x


def _actions(role: str, x: dict) -> list[str]:
    def can(*roles: str) -> bool:
        return role == "admin" or role in roles

    st, cat, out = x["status"], x["category"], []
    if cat == "LAB":
        if st == "Ordered" and can(*COLLECT_ROLES):
            out.append("collect")
        if st == "Collected" and can("lab"):
            out.append("receive")
        if st in ("Collected", "In Progress") and can("lab"):
            out.append("reject")
    if cat == "RAD" and st in ("Ordered", "Collected") and can("radiology"):
        out += ["schedule", "start"]
    if cat == "PROC" and st == "Ordered" and can("doctor", "nurse"):
        out.append("start")
    if (st == "In Progress" or (st == "Collected" and cat == "LAB") or (st == "Ordered" and cat == "PROC")) and can(*RESULT_ROLES.get(cat, ("doctor",))):
        out.append("result")
    if st == "Resulted":
        if can(*RESULT_ROLES.get(cat, ("doctor",))):
            out.append("amend")
        if can(*VERIFY_ROLES.get(cat, ("doctor",))):
            out.append("verify")
    if x["critical"] and not x["acknowledged_at"] and st in ("Resulted", "Verified") and can(*CLINICIANS):
        out.append("acknowledge")
    return out


@router.get("/rad-templates")
async def rad_templates(ctx: CtxDep, modality: str | None = None, body_part: str | None = None):
    rs.ensure_access(ctx, E(SCOPED["RAD"]), "read")
    out = [{"id": t["id"], "name": t.get("name"), "modality": t.get("modality"), "body_part": t.get("body_part"),
            "template": t.get("template"), "builtin": False}
           for t in await find(ctx, TEMPLATES, status="Active", limit=300) if not modality or t.get("modality") in (None, modality)]
    have = {t["name"] for t in out}
    out += [{"id": f"builtin-{i}", **t, "builtin": True} for i, t in enumerate(BUILTIN_TEMPLATES)
            if t["name"] not in have and (not modality or t["modality"] in (None, modality))]
    bp = (body_part or "").lower()
    out.sort(key=lambda t: (not (bp and bp == str(t.get("body_part") or "").lower()), t.get("modality") is None, t["builtin"], t["name"]))
    return out


@router.get("/{oid}/detail")
async def order_detail(oid: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(ORD), "read")
    return await _detail(ctx, oid)


# ================================================================== laboratory

class CollectIn(BaseModel):
    order_ids: list[str] = Field(min_length=1, max_length=30)


async def _label(ctx, recs: list[dict], svcs: dict[str, dict]) -> dict:
    first_rec = recs[0]
    p = await _patient_line(ctx, first_rec["patient_id"])
    svc0 = svcs.get(first_rec["service_id"]) or {}
    return {"barcode": first_rec["sample_barcode"], "patient": p, "tests": [(svcs.get(r["service_id"]) or {}).get("name") for r in recs],
            "order_codes": [r["code"] for r in recs], "sample_type": svc0.get("sample_type"), "container": svc0.get("container"),
            "collected_at": first_rec.get("collected_at"),
            "priority": min((r.get("priority") or "Routine" for r in recs), key=lambda x: PRIORITY_RANK.get(x, 3))}


@router.post("/collect")
async def collect(body: CollectIn, ctx: CtxDep):
    """Collect samples for one patient: tests that share a container share a tube (one barcode)."""
    require_role(ctx, *COLLECT_ROLES)
    recs = [await _order(ctx, i) for i in dict.fromkeys(body.order_ids)]
    if len({r["patient_id"] for r in recs}) > 1:
        raise bad_request("Collect samples for one patient at a time")
    for r in recs:
        if r.get("category") != "LAB":
            raise bad_request(f"{r['code']} is not a laboratory order")
        if r["status"] != "Ordered":
            raise conflict(f"{r['code']} is already {r['status']}")
    svcs = {r["service_id"]: (await _service(ctx, r["service_id"]) or {}) for r in recs}
    tubes: dict[str, list[dict]] = defaultdict(list)
    for r in recs:
        s = svcs[r["service_id"]]
        tubes[str(s.get("container") or s.get("sample_type") or r["id"])].append(r)
    labels = []
    for group in tubes.values():
        code = await _barcode(ctx)
        done = []
        for r in group:
            await update(ctx, ORD, r["id"], {"sample_barcode": code})
            done.append(await transition(ctx, ORD, r["id"], "Collected"))
        labels.append(await _label(ctx, done, svcs))
    return {"labels": labels}


@router.post("/{oid}/collect")
async def collect_one(oid: str, ctx: CtxDep):
    return await collect(CollectIn(order_ids=[oid]), ctx)


async def _tube_orders(ctx, o: dict, statuses: tuple[str, ...]) -> list[dict]:
    if not o.get("sample_barcode"):
        return [o]
    rows = await find(ctx, ORD, sample_barcode=o["sample_barcode"], status=list(statuses), patient_id=o["patient_id"], limit=30)
    return rows or [o]


async def _receive_tube(ctx, o: dict) -> list[dict]:
    out = []
    for r in await _tube_orders(ctx, o, ("Collected",)):
        out.append(await transition(ctx, ORD, r["id"], "In Progress", note="Sample received in lab"))
    if has(SAMPLES) and o.get("sample_barcode"):
        s = await first(ctx, SAMPLES, barcode=o["sample_barcode"])
        if s and s.get("status") == "Collected":
            await transition(ctx, SAMPLES, s["id"], "Received")
    return out


class ReceiveIn(BaseModel):
    barcode: str = Field(min_length=4, max_length=40)


@router.post("/receive")
async def receive_by_barcode(body: ReceiveIn, ctx: CtxDep):
    require_role(ctx, "lab")
    o = await first(ctx, ORD, sample_barcode=body.barcode.strip(), status="Collected")
    if not o:
        raise not_found(f"No collected sample with barcode {body.barcode}")
    return {"orders": await _receive_tube(ctx, o)}


@router.post("/{oid}/receive")
async def receive(oid: str, ctx: CtxDep):
    require_role(ctx, "lab")
    o = await _order(ctx, oid)
    if o.get("category") != "LAB" or o["status"] != "Collected":
        raise conflict(f"{o['code']} is {o['status']} — only collected samples can be received")
    return {"orders": await _receive_tube(ctx, o)}


class RejectIn(BaseModel):
    reason: Literal["Haemolysed", "Clotted", "Insufficient quantity", "Wrong container", "Unlabelled", "Delayed transport"]


@router.post("/{oid}/reject-sample")
async def reject_sample(oid: str, body: RejectIn, ctx: CtxDep):
    """Sample unfit: the tube is rejected and every test on it goes back to the collection list."""
    require_role(ctx, "lab")
    o = await _order(ctx, oid)
    if o.get("category") != "LAB" or o["status"] not in ("Collected", "In Progress"):
        raise conflict(f"{o['code']} is {o['status']} — there is no sample to reject")
    if has(SAMPLES) and o.get("sample_barcode"):
        s = await first(ctx, SAMPLES, barcode=o["sample_barcode"])
        if s and s.get("status") in ("Collected", "Received"):
            await transition(ctx, SAMPLES, s["id"], "Rejected", values={"rejection_reason": body.reason})
    out = []
    for r in await _tube_orders(ctx, o, ("Collected", "In Progress")):
        out.append(await update(ctx, ORD, r["id"], {
            "status": "Ordered", "sample_barcode": None, "collected_at": None, "recollect_reason": body.reason,
            "recollect_count": int(r.get("recollect_count") or 0) + 1}))
    await audit(ctx, "sample.reject", module="lab", entity="samples", record=o, note=body.reason)
    return {"orders": out}


class ValueIn(BaseModel):
    parameter: str = Field(min_length=1, max_length=120)
    value: str | float | int | None = None
    flag: str | None = None


class ResultsIn(BaseModel):
    values: list[ValueIn] = Field(default_factory=list, max_length=80)
    result: str | None = Field(default=None, max_length=20000)
    impression: str | None = Field(default=None, max_length=2000)
    critical: bool = False  # clinician / radiologist-declared critical finding (e.g. pneumothorax)


@router.post("/{oid}/results")
async def enter_results(oid: str, body: ResultsIn, ctx: CtxDep):
    o = await _order(ctx, oid)
    cat = o.get("category") or "LAB"
    require_role(ctx, *RESULT_ROLES.get(cat, ("doctor",)))
    if o["status"] in ("Verified", "Cancelled"):
        raise conflict(f"{o['code']} is {o['status']} — results can no longer be changed")
    vals = [{"parameter": v.parameter.strip(), "value": str(v.value).strip(), **({"flag": v.flag} if v.flag in FLAGS else {})}
            for v in body.values if v.parameter.strip() and v.value not in (None, "") and str(v.value).strip()]
    text = {k: v.strip() for k, v in (("result", body.result), ("impression", body.impression)) if v and v.strip()}
    if not vals and not text.get("result"):
        raise bad_request("Enter at least one result value or the report text")
    if body.critical and not o.get("critical"):
        o = await update(ctx, ORD, oid, {"critical": True})
    if o["status"] == "Resulted":  # correction before authorisation, fully audited
        flagged, crit = flag_values(await _service(ctx, o.get("service_id")), vals) if vals else (o.get("result_values") or [], False)
        patch: dict[str, Any] = {"result_values": flagged, **text, "critical": bool(o.get("critical") or crit),
                                 "amended_at": _stamp(), "amended_by": ctx.user.get("name")}
        newly = patch["critical"] and not o.get("critical_notified_at")
        if newly:
            patch["critical_notified_at"] = _stamp()
        rec = await update(ctx, ORD, oid, patch)
        if newly:
            await _alert_critical(ctx, rec)
        return await _detail(ctx, oid)
    if o["status"] == "Ordered" and cat == "LAB":
        raise conflict("Collect the sample before entering results")
    if o["status"] in ("Ordered", "Collected") and cat == "RAD" and not o.get("accession_no"):
        raise conflict("Start the study (accession number) before reporting")
    if o["status"] == "Collected" and cat == "LAB":
        await _receive_tube(ctx, o)
    elif o["status"] in ("Ordered", "Collected"):
        await transition(ctx, ORD, oid, "In Progress")
    await transition(ctx, ORD, oid, "Resulted", values={**({"result_values": vals} if vals else {}), **text})
    return await _detail(ctx, oid)


class VerifyIn(BaseModel):
    comment: str | None = Field(default=None, max_length=500)


@router.post("/{oid}/verify")
async def verify(oid: str, body: VerifyIn, ctx: CtxDep):
    o = await _order(ctx, oid)
    require_role(ctx, *VERIFY_ROLES.get(o.get("category") or "", ("doctor",)))
    if o["status"] != "Resulted":
        raise conflict(f"{o['code']} is {o['status']} — only resulted orders can be authorised")
    await transition(ctx, ORD, oid, "Verified", note=body.comment)
    return await _detail(ctx, oid)


# ================================================================== critical results & inbox

class AckIn(BaseModel):
    note: str | None = Field(default=None, max_length=500)
    read_back: bool = True


@router.post("/{oid}/acknowledge")
async def acknowledge(oid: str, body: AckIn, ctx: CtxDep):
    require_role(ctx, *CLINICIANS)
    o = await _order(ctx, oid)
    if not o.get("critical"):
        raise conflict(f"{o['code']} is not a critical result")
    if o.get("acknowledged_at"):
        raise conflict(f"Already acknowledged by {o.get('acknowledged_by') or 'a clinician'}")
    if o["status"] not in ("Resulted", "Verified"):
        raise conflict(f"{o['code']} has no result yet")
    note = " · ".join(x for x in ("Read-back confirmed" if body.read_back else None, (body.note or "").strip() or None) if x)
    readers = list(o.get("read_by") or [])
    rec = await update(ctx, ORD, oid, {"acknowledged_at": _stamp(), "acknowledged_by": f"{ctx.user.get('name')} ({ctx.role})",
                                       "acknowledged_by_user": ctx.user_id, "acknowledgement_note": note or None,
                                       "read_by": readers if ctx.user_id in readers else [*readers, ctx.user_id]})
    await audit(ctx, "critical.acknowledge", module="orders", entity="orders", record=rec, note=note or None,
                after={"minutes_to_ack": minutes_between(o.get("critical_notified_at") or o.get("resulted_at"), rec.get("acknowledged_at"))})
    return await _detail(ctx, oid)


class ReadIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)


@router.post("/inbox/read")
async def mark_read(body: ReadIn, ctx: CtxDep):
    # Read receipts are per-user UI state, not a clinical change: a direct JSONB append (no audit
    # entry or change broadcast per view). Acknowledging a critical result goes through the audited path.
    require_role(ctx, *CLINICIANS, "management")
    ids = [i for i in body.ids if is_uuid(i)]
    uid = sa.func.jsonb_build_array(sa.cast(ctx.user_id, sa.Text))
    cur = sa.func.coalesce(orders.c.data["read_by"], sa.literal_column("'[]'::jsonb"))
    res = await ctx.conn.execute(orders.update().where(orders.c.id.in_(ids), sa.not_(cur.op("@>")(uid))).values(
        data=orders.c.data.op("||")(sa.func.jsonb_build_object(sa.literal_column("'read_by'"), cur.op("||")(uid)))))
    return {"marked": res.rowcount}


async def _my_wards(ctx) -> list[str]:
    emp = ctx.user.get("employee_id")
    if not emp:
        return []
    dept = (await ctx.conn.execute(sa.select(employees.c.department_id).where(employees.c.id == emp))).scalar_one_or_none()
    if not dept:
        return []
    ent = E("mdm.wards")
    t = ent.table
    return [str(i) for (i,) in (await ctx.conn.execute(sa.select(t.c.id).where(*rs.base_where(ent), t.c.data["department"].astext == str(dept)))).all()]


@router.get("/inbox")
async def inbox(ctx: CtxDep, scope: Literal["mine", "ward", "all"] = "mine", ward: str | None = None, days: int = 3,
                unread_only: bool = False):
    require_role(ctx, *CLINICIANS, "management")
    ts = now()
    days = max(1, min(days, 30))
    o, e = orders, encounters
    stmt = _order_query().where(o.c.status.in_(["Resulted", "Verified"]), sa.or_(
        sa.func.coalesce(o.c.resulted_at, o.c.verified_at) >= ts - timedelta(days=days),
        sa.and_(o.c.critical.is_(True), o.c.acknowledged_at.is_(None), o.c.ordered_at >= ts - timedelta(days=30))))
    wards: list[str] = []
    emp = ctx.user.get("employee_id")
    if scope == "mine" and (emp or ctx.role != "admin"):
        mine_ipd = sa.select(e.c.patient_id).where(e.c.type == "IPD", e.c.status.in_(OPEN_IPD), e.c.deleted_at.is_(None), e.c.doctor_id == emp)
        conds = [o.c.ordered_by == ctx.user_id]
        if emp:
            conds += [o.c.data["ordering_doctor"].astext == emp, o.c.patient_id.in_(mine_ipd)]
        stmt = stmt.where(sa.or_(*conds))
    elif scope == "ward":
        wards = [ward] if ward and is_uuid(ward) else await _my_wards(ctx)
        inpatients = (sa.select(e.c.patient_id).select_from(e.join(beds, beds.c.id == e.c.bed_id))
                      .where(e.c.type == "IPD", e.c.status.in_(OPEN_IPD), e.c.deleted_at.is_(None)))
        if wards:
            inpatients = inpatients.where(beds.c.ward_id.in_(wards))
        stmt = stmt.where(o.c.patient_id.in_(inpatients))
    rows = (await ctx.conn.execute(stmt.order_by(sa.func.coalesce(o.c.verified_at, o.c.resulted_at).desc()).limit(400))).all()
    names = await _employee_names(ctx, rows)
    items = [_row(r, ts, ctx.user_id, names) for r in rows]
    if unread_only:
        items = [x for x in items if not x["read"] or (x["critical"] and not x["acknowledged_at"])]
    items.sort(key=lambda x: (not (x["critical"] and not x["acknowledged_at"]), x["read"],
                              -(parse_dt(x["verified_at"] or x["resulted_at"]) or ts).timestamp()))
    return {"rows": items, "scope": scope, "wards": wards,
            "counts": {"critical_unack": sum(1 for x in items if x["critical"] and not x["acknowledged_at"]),
                       "unread": sum(1 for x in items if not x["read"]), "total": len(items)}}


# ================================================================== radiology

class ScheduleIn(BaseModel):
    scheduled_at: str
    modality_room: str | None = None
    request_transport: bool = False
    transport_mode: Literal["Wheelchair", "Stretcher", "Trolley", "Trolley with monitor & O2", "Bed", "Walking with escort"] = "Wheelchair"


async def _room(ctx, rid: str | None) -> dict | None:
    if not rid:
        return None
    room = await get(ctx, ROOMS, rid) if has(ROOMS) else None
    if not room:
        raise bad_request("Modality room not found", {"fields": {"modality_room": "Unknown room"}})
    if room.get("status") not in (None, "Online"):
        raise conflict(f"{room.get('name')} is {room.get('status')}")
    return room


async def _transport_for(ctx, o: dict, when: datetime, mode: str, svc: dict) -> dict | None:
    if not has(TRANSPORT):
        return None
    e, b = encounters, beds
    w = records.alias("w")
    row = (await ctx.conn.execute(sa.select(e.c.id, b.c.ward_id, b.c.bed_no, w.c.title.label("ward")).select_from(
        e.outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id)).where(
        e.c.patient_id == o["patient_id"], e.c.type == "IPD", e.c.status.in_(OPEN_IPD), e.c.deleted_at.is_(None)).limit(1))).first()
    if not row:
        raise bad_request("Transport can be requested only for admitted patients")
    return await create(ctx, TRANSPORT, {
        "patient_id": o["patient_id"], "encounter_id": str(row.id), "from_ward": str(row.ward_id) if row.ward_id else None,
        "from_location": " bed ".join(x for x in (row.ward, row.bed_no) if x) or "Ward",
        "to_location": TRANSPORT_DESTINATION.get(svc.get("modality") or "", "Other"), "to_detail": svc.get("name"),
        "trip_type": "Round trip (wait & return)", "mode": mode, "priority": "STAT" if o.get("priority") == "STAT" else "Routine",
        "requested_for": (when - timedelta(minutes=15)).isoformat(timespec="minutes"), "order": o["id"], "status": "Requested",
    })


@router.post("/{oid}/schedule")
async def schedule(oid: str, body: ScheduleIn, ctx: CtxDep):
    require_role(ctx, "radiology")
    o = await _order(ctx, oid)
    if o.get("category") != "RAD" or o["status"] not in ("Ordered", "Collected"):
        raise conflict(f"{o['code']} cannot be scheduled ({o.get('category')} · {o['status']})")
    try:
        when = parse_dt(body.scheduled_at)
    except ValueError:
        raise bad_request("Invalid date / time", {"fields": {"scheduled_at": "Invalid"}}) from None
    if not when or when < now() - timedelta(minutes=15):
        raise bad_request("Choose a time that is not in the past", {"fields": {"scheduled_at": "In the past"}})
    room = await _room(ctx, body.modality_room)
    if room:
        slot = int(room.get("slot_minutes") or 20)
        sched = sa.cast(orders.c.data["scheduled_at"].astext, sa.DateTime(timezone=True))
        clash = (await ctx.conn.execute(sa.select(orders.c.code).where(
            orders.c.id != oid, orders.c.deleted_at.is_(None), orders.c.status.in_(["Ordered", "Collected", "In Progress"]),
            orders.c.data["modality_room"].astext == room["id"], orders.c.data["scheduled_at"].astext.isnot(None),
            sched > when - timedelta(minutes=slot), sched < when + timedelta(minutes=slot)).limit(1))).scalar_one_or_none()
        if clash:
            raise ApiError(409, f"{room.get('name')} is booked for {clash} within {slot} minutes of this slot",
                           {"fields": {"scheduled_at": "Slot taken"}}, code="SLOT_TAKEN")
    await update(ctx, ORD, oid, {"scheduled_at": when.isoformat(timespec="minutes"), "modality_room": room["id"] if room else None,
                                 "scheduled_by": ctx.user.get("name")})
    tr = None
    if body.request_transport:
        tr = await _transport_for(ctx, o, when, body.transport_mode, await _service(ctx, o.get("service_id")) or {})
    out = await _detail(ctx, oid)
    out["transport_request"] = {"id": tr["id"], "code": tr["code"]} if tr else None
    return out


class StartIn(BaseModel):
    modality_room: str | None = None


@router.post("/{oid}/start")
async def start(oid: str, body: StartIn, ctx: CtxDep):
    o = await _order(ctx, oid)
    cat = o.get("category")
    if cat == "LAB":
        raise bad_request("Laboratory orders start when the sample is received")
    require_role(ctx, *(("radiology",) if cat == "RAD" else ("doctor", "nurse")))
    if o["status"] not in ("Ordered", "Collected"):
        raise conflict(f"{o['code']} is already {o['status']}")
    if cat == "RAD":
        room = await _room(ctx, body.modality_room or o.get("modality_room"))
        day, n = await _next_code(ctx, "accession", "%Y%m%d")
        acc = f"ACC{day}{n:04d}"
        uid = f"{DICOM_UID_ROOT}.{day}.{n}"
        await update(ctx, ORD, oid, {"accession_no": acc, "study_uid": uid, "study_started_at": _stamp(),
                                     "modality_room": room["id"] if room else o.get("modality_room"),
                                     "pacs_url": f"{PACS_VIEWER_URL}?accession={acc}&StudyInstanceUIDs={uid}"})
    await transition(ctx, ORD, oid, "In Progress", note="Study started" if cat == "RAD" else None)
    return await _detail(ctx, oid)


__all__ = ["router", "flag_for", "flag_values", "ref_range", "ORDER_SETS", "PACS_VIEWER_URL"]
