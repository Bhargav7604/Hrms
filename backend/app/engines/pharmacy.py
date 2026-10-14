"""Pharmacy / e-Rx: drug-safety screening (allergy, interaction, duplicate therapy, high-alert,
scheduled / narcotic drugs, stock), the OP / IP prescription queue, FEFO batch dispensing with
charge capture, returns with restock + credit, and ward indents issued from the IP pharmacy."""

from __future__ import annotations

import re
from datetime import timedelta
from decimal import Decimal
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import hook
from ..core.security import CtxDep
from ..core.sequences import next_code
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    is_uuid,
    money,
    new_id,
    not_found,
    now,
    parse_dt,
    today,
)
from ..schema import encounters, patients
from ._common import E, create, find, get, require_role, update
from .inventory import available, item_label, items_by_id, stock_in, stock_out

router = APIRouter(prefix="/api/pharmacy", tags=["pharmacy"])

STORES = ("OP Pharmacy", "IP Pharmacy")
RX = "opd.prescriptions"
DISPENSE = "pharmacy.dispenses"
RETURN = "pharmacy.returns"
INDENT = "pharmacy.indents"
INTERVENTION = "pharmacy.interventions"

SEVERITY_RANK = {"Contraindicated": 4, "Major": 3, "Moderate": 2, "Minor": 1}
SEVERE = {"Contraindicated", "Major"}
CONTROLLED = {"H1", "X", "Narcotic"}
REGISTER = {"Narcotic": "Narcotic Drugs Register", "X": "Schedule X Register", "H1": "Schedule H1 Register"}
SCHEDULE_LABEL = {"Narcotic": "Narcotic (NDPS)", "X": "Schedule X", "H1": "Schedule H1", "H": "Schedule H"}
OPEN_RX = ["Active", "Partially Dispensed"]
LIVE_RX = ["Active", "Partially Dispensed", "Dispensed"]
DEFAULT_COURSE_DAYS = 30
ZERO = Decimal(0)

# An interaction is graded Major when either drug is high-alert or in one of these classes.
MAJOR_CLASSES = {"anticoagulant", "antimetabolite", "opioid", "opioid analgesic", "antiarrhythmic", "benzodiazepine", "ssri",
                 "potassium-sparing diuretic", "aminoglycoside"}
CONTRAINDICATED_PAIRS = [({"ceftriaxone"}, {"calcium"})]  # IV ceftriaxone + calcium: fatal precipitates
# Several IV fluids / electrolytes together are routine, not duplicate therapy.
DUPLICATE_CLASS_EXEMPT = {"iv fluid", "electrolyte"}
# Allergy keyword → (members that are the same allergen, cross-reactive drugs)
ALLERGY_GROUPS: dict[str, tuple[list[str], list[str]]] = {
    "penicillin": (["penicillin", "amoxicillin", "ampicillin", "piperacillin", "cloxacillin", "benzathine"], ["cef", "ceph", "penem"]),
    "beta-lactam": (["penicillin", "amoxicillin", "ampicillin", "piperacillin", "cef", "ceph", "penem", "beta-lactam"], []),
    "cephalosporin": (["cef", "ceph"], ["penicillin", "amoxicillin", "ampicillin", "piperacillin"]),
    "sulfa": (["sulfa", "sulpha", "sulfamethoxazole", "sulfonamide", "cotrimoxazole", "sulfasalazine"], []),
    "sulpha": (["sulfa", "sulpha", "sulfamethoxazole", "sulfonamide", "cotrimoxazole", "sulfasalazine"], []),
    "nsaid": (["nsaid", "ibuprofen", "diclofenac", "naproxen", "aspirin", "ketorolac", "mefenamic", "aceclofenac"], []),
    "aspirin": (["aspirin"], ["nsaid", "ibuprofen", "diclofenac", "naproxen", "ketorolac"]),
    "opioid": (["opioid", "morphine", "tramadol", "fentanyl", "codeine", "pethidine"], []),
    "iodine": (["iodinated", "contrast", "povidone"], []),
    "quinolone": (["floxacin", "quinolone"], []),
    "macrolide": (["macrolide", "azithromycin", "clarithromycin", "erythromycin"], []),
}
ALERT_TYPE_LABEL = {
    "allergy": "Drug–allergy", "interaction": "Drug–drug interaction", "duplicate": "Duplicate therapy",
    "high_alert": "High-alert medication", "controlled": "Schedule H1 / X documentation", "schedule": "Schedule H1 / X documentation",
}


# ------------------------------------------------------------------ drug profiles & patient context

def _split(s: Any) -> list[str]:
    return [x.strip().lower() for x in re.split(r"\s*(?:\+|/|,|;|\band\b)\s*", str(s or "")) if x.strip()]


def profile(it: dict) -> dict:
    name = str(it.get("name") or it.get("code") or "")
    generics = _split(it.get("generic_name")) or [name.lower()]
    classes = _split(it.get("drug_class"))
    return {
        "id": it["id"], "name": name, "generic": it.get("generic_name") or name, "generics": generics, "classes": classes,
        "terms": [*generics, *classes, name.lower()],
        "interacts": [str(x).strip().lower() for x in it.get("interacts_with") or [] if str(x).strip()],
        "schedule": it.get("schedule") or "None", "high_alert": bool(it.get("high_alert")), "status": it.get("status") or "Active",
        "type": it.get("type"), "uom": it.get("uom"), "mrp": it.get("mrp"), "code": it.get("code"), "barcode": it.get("barcode"),
    }


def _hit(keyword: str, terms: list[str]) -> str | None:
    k = keyword.strip().lower()
    for t in terms:
        if t and (k == t or (len(k) >= 4 and k in t) or (len(t) >= 4 and t in k)):
            return t
    return None


async def patient_or_404(ctx, pid: str) -> dict:
    if not is_uuid(pid):
        raise not_found("Patient not found")
    row = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid, patients.c.deleted_at.is_(None)))).first()
    if not row:
        raise not_found("Patient not found")
    rec = rs.to_record(row)
    rec["age"] = age_from(rec.get("dob"))
    return rec


async def patient_allergies(ctx, pid: str, patient: dict | None = None) -> list[dict]:
    """Registration 'known allergies' tags + active, non-refuted EMR allergy records."""
    p = patient or await patient_or_404(ctx, pid)
    out: dict[str, dict] = {}
    for a in p.get("allergies") or []:
        if str(a).strip():
            out[str(a).strip().lower()] = {"allergen": str(a).strip(), "severity": None, "reaction": None, "drug": None,
                                           "drug_class": None, "source": "Registration", "id": None}
    for a in await find(ctx, "emr.allergies", patient_id=pid, status="Active", limit=100):
        if a.get("verification") == "Refuted" or not a.get("allergen"):
            continue
        out[str(a["allergen"]).strip().lower()] = {
            "allergen": a["allergen"], "severity": a.get("severity"), "reaction": a.get("reaction"), "drug": a.get("drug"),
            "drug_class": a.get("drug_class"), "allergen_type": a.get("allergen_type"), "verification": a.get("verification"),
            "source": "EMR", "id": a["id"], "code": a.get("code"),
        }
    return list(out.values())


async def active_medications(ctx, pid: str, *, exclude_rx: str | None = None) -> list[dict]:
    """Lines of live prescriptions whose course has not ended (duration, else 30 days; STAT = 1 day)."""
    out = []
    ts = now()
    for rx in await find(ctx, RX, patient_id=pid, status=LIVE_RX, sort="-prescribed_at", limit=40):
        if rx["id"] == exclude_rx:
            continue
        start = parse_dt(rx.get("prescribed_at") or rx.get("created_at")) or ts
        if rx.get("valid_till") and parse_dt(rx["valid_till"]) and parse_dt(rx["valid_till"]) + timedelta(days=1) < ts:
            continue
        for ln in rx.get("items") or []:
            days = 1 if ln.get("frequency") == "STAT" else float(ln.get("duration_days") or DEFAULT_COURSE_DAYS)
            until = start + timedelta(days=days)
            if until < ts or not ln.get("drug"):
                continue
            out.append({"item_id": ln["drug"], "dose": ln.get("dose"), "route": ln.get("route"), "frequency": ln.get("frequency"),
                        "duration_days": ln.get("duration_days"), "qty": ln.get("qty"), "instructions": ln.get("instructions"),
                        "prescription_id": rx["id"], "prescription_code": rx.get("code"), "prescribed_at": rx.get("prescribed_at"),
                        "doctor": rx.get("doctor"), "encounter_id": rx.get("encounter_id"), "until": until.isoformat(),
                        "status": rx.get("status"), "_refs": rx.get("_refs")})
    return out


async def admission_of(ctx, pid: str) -> dict | None:
    t = encounters
    row = (await ctx.conn.execute(sa.select(t).where(
        t.c.patient_id == pid, t.c.deleted_at.is_(None), t.c.type.in_(["IPD", "DAYCARE"]),
        t.c.status.in_(["Admitted", "Discharge Initiated"])).order_by(t.c.started_at.desc().nulls_last()).limit(1))).first()
    return rs.to_record(row) if row else None


# ------------------------------------------------------------------ safety screening

def _alert(kind: str, severity: str, p: dict, message: str, *, with_: str | None = None, blocking: bool = False) -> dict:
    return {"type": kind, "label": ALERT_TYPE_LABEL.get(kind, kind.replace("_", " ").title()), "severity": severity,
            "item_id": p["id"], "item": p["name"], "with": with_, "message": message, "blocking": blocking}


def _pair_severity(a: dict, b: dict) -> str:
    def has(keys: set[str], p: dict) -> bool:
        return any(_hit(k, p["terms"]) for k in keys)

    for x, y in CONTRAINDICATED_PAIRS:
        if (has(x, a) and has(y, b)) or (has(x, b) and has(y, a)):
            return "Contraindicated"
    if a["high_alert"] or b["high_alert"] or (set(a["classes"]) | set(b["classes"])) & MAJOR_CLASSES:
        return "Major"
    return "Moderate"


def _interaction(a: dict, b: dict) -> str | None:
    if set(a["generics"]) & set(b["generics"]):
        return None
    hit = next((k for k in a["interacts"] if _hit(k, b["terms"])), None) or next((k for k in b["interacts"] if _hit(k, a["terms"])), None)
    return _pair_severity(a, b) if hit else None


def _allergy_alerts(p: dict, allergies: list[dict]) -> list[dict]:
    out = []
    for al in allergies:
        allergen = str(al["allergen"]).lower()
        severe = al.get("severity") in ("Severe", "Life-threatening")
        sev, why = None, None
        if al.get("drug") and al["drug"] == p["id"]:
            sev, why = "Contraindicated", "recorded allergy to this exact drug"
        elif _hit(allergen, p["terms"]) or (al.get("drug_class") and _hit(str(al["drug_class"]), p["terms"])):
            sev, why = ("Contraindicated" if severe else "Major"), "same drug / class"
        else:
            for key, (members, cross) in ALLERGY_GROUPS.items():
                if key not in allergen and not (al.get("drug_class") and key in str(al["drug_class"]).lower()):
                    continue
                if any(m in t for m in members for t in p["terms"]):
                    sev, why = ("Contraindicated" if severe else "Major"), f"{key} group"
                    break
                if any(c in t for c in cross for t in p["terms"]):
                    sev, why = "Moderate", f"possible cross-sensitivity with {key}"
                    break
        if sev:
            reaction = f" — reaction: {al['reaction']}" if al.get("reaction") else ""
            out.append(_alert("allergy", sev, p, f"Patient is allergic to {al['allergen']} ({why}){reaction}.", with_=al["allergen"]))
    return out


async def safety_check(ctx, *, patient_id: str, lines: list[dict], purpose: str = "prescribe", store: str | None = None,
                       prescription: dict | None = None) -> dict:
    """lines: [{item_id, qty, batch?}]. Returns alerts sorted by severity plus per-item facts."""
    patient = await patient_or_404(ctx, patient_id)
    ids = [ln["item_id"] for ln in lines]
    items = await items_by_id(ctx, ids)
    missing = [i for i in ids if i not in items]
    if missing:
        raise bad_request("One or more drugs are not in the item master")
    profs = [profile(items[i]) for i in dict.fromkeys(ids)]
    by_id = {p["id"]: p for p in profs}
    alerts: list[dict] = []

    allergies = await patient_allergies(ctx, patient_id, patient)
    for p in profs:
        alerts += _allergy_alerts(p, allergies)

    for i, a in enumerate(profs):
        for b in profs[i + 1:]:
            sev = _interaction(a, b)
            if sev:
                alerts.append(_alert("interaction", sev, a, f"{a['name']} interacts with {b['name']}.", with_=b["name"]))
            if set(a["generics"]) & set(b["generics"]):
                alerts.append(_alert("duplicate", "Major", a, f"Duplicate therapy: {a['name']} and {b['name']} are both "
                                     f"{', '.join(sorted(set(a['generics']) & set(b['generics'])))}.", with_=b["name"]))
            else:
                shared = (set(a["classes"]) & set(b["classes"])) - DUPLICATE_CLASS_EXEMPT
                if shared:
                    alerts.append(_alert("duplicate", "Moderate", a, f"Two drugs of the same class ({', '.join(sorted(shared))}): "
                                         f"{a['name']} and {b['name']}.", with_=b["name"]))
    if len(ids) != len(set(ids)) and purpose == "prescribe":
        for i in {i for i in ids if ids.count(i) > 1}:
            alerts.append(_alert("duplicate", "Major", by_id[i], f"{by_id[i]['name']} is listed more than once."))

    active = await active_medications(ctx, patient_id, exclude_rx=prescription["id"] if prescription else None)
    act_items = await items_by_id(ctx, [m["item_id"] for m in active])
    seen_pairs: set[tuple[str, str]] = set()
    for m in active:
        it = act_items.get(m["item_id"])
        if not it:
            continue
        ap = profile(it)
        for p in profs:
            if (p["id"], ap["id"]) in seen_pairs:
                continue
            seen_pairs.add((p["id"], ap["id"]))
            sev = _interaction(p, ap)
            if sev:
                alerts.append(_alert("interaction", sev, p, f"{p['name']} interacts with current medication {ap['name']} "
                                     f"(Rx {m['prescription_code']}).", with_=ap["name"]))
            if set(p["generics"]) & set(ap["generics"]):
                alerts.append(_alert("duplicate", "Moderate", p, f"Patient already has an active prescription for {ap['name']} "
                                     f"(Rx {m['prescription_code']}).", with_=ap["name"]))

    rx_valid = True
    if prescription and prescription.get("valid_till"):
        rx_valid = (parse_dt(prescription["valid_till"]).date() >= today())
    for p in profs:
        if p["status"] == "Banned":
            alerts.append(_alert("schedule", "Contraindicated", p, f"{p['name']} is banned (CDSCO) and cannot be prescribed or dispensed.",
                                 blocking=True))
        elif p["status"] == "Inactive":
            alerts.append(_alert("schedule", "Minor", p, f"{p['name']} is inactive in the hospital formulary."))
        if p["high_alert"]:
            alerts.append(_alert("high_alert", "Moderate", p, f"{p['name']} is a high-alert medication — independent double-check of "
                                 "drug, dose, route and patient before administration."))
        sched = p["schedule"]
        if purpose == "dispense" and sched in CONTROLLED:
            if not prescription:
                alerts.append(_alert("controlled", "Contraindicated", p, f"{SCHEDULE_LABEL[sched]} drug {p['name']} can only be dispensed "
                                     "against a valid prescription.", blocking=True))
            elif not rx_valid:
                alerts.append(_alert("controlled", "Contraindicated", p, f"The prescription for {SCHEDULE_LABEL[sched]} drug {p['name']} "
                                     "has expired.", blocking=True))
            else:
                alerts.append(_alert("controlled", "Minor", p, f"{SCHEDULE_LABEL[sched]}: entry will be made in the {REGISTER[sched]}."))
        elif purpose == "dispense" and sched == "H" and (not prescription or not rx_valid):
            alerts.append(_alert("schedule", "Major", p, f"{p['name']} is a Schedule H (prescription-only) drug and there is "
                                 f"{'no valid' if not prescription else 'an expired'} prescription."))

    facts = []
    want: dict[tuple[str, str | None], Decimal] = {}
    for ln in lines:
        key = (ln["item_id"], ln.get("batch") or None)
        want[key] = want.get(key, ZERO) + Decimal(str(ln.get("qty") or 0))
    for p in profs:
        avail = await available(ctx, p["id"], store) if store else None
        facts.append({"item_id": p["id"], "name": p["name"], "generic": p["generic"], "schedule": p["schedule"], "high_alert": p["high_alert"],
                      "uom": p["uom"], "mrp": p["mrp"], "available": float(avail) if avail is not None else None})
    if store:
        for (iid, batch), q in want.items():
            avail = await available(ctx, iid, store, batch)
            if avail < q:
                p = by_id[iid]
                where = f"batch {batch}" if batch else store
                alerts.append(_alert("stock", "Major" if purpose == "dispense" else "Minor", p,
                                     f"Only {avail.normalize():f} {p['uom'] or ''} of {p['name']} available in {where} "
                                     f"(needed {q.normalize():f}).", blocking=purpose == "dispense"))

    uniq: dict[tuple, dict] = {}
    for a in alerts:
        uniq.setdefault((a["type"], a["item_id"], a["with"], a["severity"]), a)
    out = sorted(uniq.values(), key=lambda a: (-SEVERITY_RANK[a["severity"]], a["item"]))
    severe = [a for a in out if a["severity"] in SEVERE and not a["blocking"]]
    return {"alerts": out, "items": facts,
            "summary": {"total": len(out), "blocking": sum(a["blocking"] for a in out), "severe": len(severe),
                        "requires_override": bool(severe)},
            "allergies": [a["allergen"] for a in allergies]}


class CheckLine(BaseModel):
    item_id: str
    qty: float = Field(default=1, ge=0)
    batch: str | None = None


class CheckIn(BaseModel):
    patient_id: str
    items: list[CheckLine] = Field(min_length=1, max_length=60)
    store: Literal["OP Pharmacy", "IP Pharmacy"] | None = None
    prescription_id: str | None = None
    purpose: Literal["prescribe", "dispense"] = "prescribe"


@router.post("/check")
async def check(body: CheckIn, ctx: CtxDep):
    require_role(ctx, "pharmacist", "doctor", "nurse")
    rx = await _prescription(ctx, body.prescription_id, body.patient_id) if body.prescription_id else None
    return await safety_check(ctx, patient_id=body.patient_id, lines=[ln.model_dump() for ln in body.items], purpose=body.purpose,
                              store=body.store, prescription=rx)


# ------------------------------------------------------------------ prescription queue

async def _prescription(ctx, rx_id: str, patient_id: str | None = None) -> dict:
    rx = await get(ctx, RX, rx_id)
    if not rx:
        raise not_found("Prescription not found")
    if patient_id and rx.get("patient_id") != patient_id:
        raise bad_request("The prescription belongs to another patient")
    return rx


async def dispensed_by_rx(ctx, rx_ids: list[str]) -> dict[str, dict[str, Decimal]]:
    """{rx_id: {item_id: qty dispensed}} from non-cancelled dispenses."""
    if not rx_ids:
        return {}
    ent = E(DISPENSE)
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t.c.data).where(*rs.base_where(ent), t.c.status != "Cancelled",
                                                              t.c.data["prescription"].astext.in_(rx_ids)))).all()
    out: dict[str, dict[str, Decimal]] = {}
    for (d,) in rows:
        per = out.setdefault(d.get("prescription"), {})
        for ln in d.get("items") or []:
            per[ln.get("item")] = per.get(ln.get("item"), ZERO) + Decimal(str(ln.get("qty") or 0))
    return out


def _rx_lines(rx: dict, dispensed: dict[str, Decimal], items: dict[str, dict]) -> list[dict]:
    """Prescribed lines merged per drug with dispensed / remaining quantities."""
    merged: dict[str, dict] = {}
    for ln in rx.get("items") or []:
        iid = ln.get("drug")
        if not iid:
            continue
        m = merged.setdefault(iid, {"item_id": iid, "name": item_label(items.get(iid)), "dose": ln.get("dose"), "route": ln.get("route"),
                                    "frequency": ln.get("frequency"), "duration_days": ln.get("duration_days"),
                                    "instructions": ln.get("instructions"), "prescribed": ZERO})
        m["prescribed"] += Decimal(str(ln.get("qty") or 0))
    out = []
    for iid, m in merged.items():
        it = items.get(iid) or {}
        done = dispensed.get(iid, ZERO)
        out.append({**m, "prescribed": float(m["prescribed"]), "dispensed": float(done),
                    "remaining": float(max(m["prescribed"] - done, ZERO)), "uom": it.get("uom"), "mrp": it.get("mrp"),
                    "schedule": it.get("schedule"), "high_alert": bool(it.get("high_alert"))})
    return out


@router.get("/queue")
async def queue(ctx: CtxDep, store: Literal["OP Pharmacy", "IP Pharmacy"] = "OP Pharmacy", days: int = 3, q: str | None = None):
    rs.ensure_access(ctx, E(DISPENSE), "read")
    days = max(1, min(days, 30))
    rxs = await find(ctx, RX, status=OPEN_RX, date_from=(today() - timedelta(days=days - 1)).isoformat(), sort="prescribed_at",
                     limit=400, q=q or None)
    pids = list({r["patient_id"] for r in rxs})
    enc_ids = list({r["encounter_id"] for r in rxs if r.get("encounter_id")})
    enc_type: dict[str, str] = {}
    if enc_ids:
        for eid, typ in (await ctx.conn.execute(sa.select(encounters.c.id, encounters.c.type).where(encounters.c.id.in_(enc_ids)))).all():
            enc_type[str(eid)] = typ
    admitted: dict[str, dict] = {}
    if pids:
        rows = (await ctx.conn.execute(sa.select(encounters.c.id, encounters.c.patient_id, encounters.c.code, encounters.c.bed_id).where(
            encounters.c.patient_id.in_(pids), encounters.c.type.in_(["IPD", "DAYCARE"]), encounters.c.deleted_at.is_(None),
            encounters.c.status.in_(["Admitted", "Discharge Initiated"])))).all()
        admitted = {str(r.patient_id): {"id": str(r.id), "code": r.code, "bed_id": str(r.bed_id) if r.bed_id else None} for r in rows}

    def is_ip(rx: dict) -> bool:
        if rx.get("encounter_id") and rx["encounter_id"] in enc_type:
            return enc_type[rx["encounter_id"]] in ("IPD", "DAYCARE")
        return rx["patient_id"] in admitted

    counts = {"OP Pharmacy": 0, "IP Pharmacy": 0}
    for rx in rxs:
        counts["IP Pharmacy" if is_ip(rx) else "OP Pharmacy"] += 1
    mine = [rx for rx in rxs if is_ip(rx) == (store == "IP Pharmacy")]
    done = await dispensed_by_rx(ctx, [r["id"] for r in mine])
    items = await items_by_id(ctx, [ln.get("drug") for r in mine for ln in r.get("items") or []])
    pts = {}
    if mine:
        for r in (await ctx.conn.execute(sa.select(patients).where(patients.c.id.in_(list({x["patient_id"] for x in mine}))))).all():
            p = rs.to_record(r)
            pts[p["id"]] = {"id": p["id"], "name": p.get("title"), "uhid": p.get("code"), "age": age_from(p.get("dob")),
                            "gender": p.get("gender"), "allergies": p.get("allergies") or [], "phone": p.get("phone")}
    refs = await rs.resolve_refs(ctx, E(RX), mine)
    out = []
    for rx in mine:
        lines = _rx_lines(rx, done.get(rx["id"], {}), items)
        out.append({
            "id": rx["id"], "code": rx.get("code"), "status": rx.get("status"), "prescribed_at": rx.get("prescribed_at"),
            "diagnosis": rx.get("diagnosis"), "notes": rx.get("notes"), "valid_till": rx.get("valid_till"),
            "doctor": refs.get(rx.get("doctor") or "", None), "patient": pts.get(rx["patient_id"]),
            "encounter_id": rx.get("encounter_id") or (admitted.get(rx["patient_id"]) or {}).get("id"),
            "admission": admitted.get(rx["patient_id"]), "items": lines,
            "pending_lines": sum(1 for ln in lines if ln["remaining"] > 0),
            "controlled": any(ln.get("schedule") in CONTROLLED for ln in lines),
            "high_alert": any(ln.get("high_alert") for ln in lines),
        })
    return {"store": store, "counts": counts, "rows": out}


# ------------------------------------------------------------------ dispense planning (FEFO preview) and dispensing

class DispenseLine(BaseModel):
    item_id: str
    qty: float = Field(gt=0, le=100000)
    batch: str | None = None


class PlanIn(BaseModel):
    patient_id: str
    store: Literal["OP Pharmacy", "IP Pharmacy"]
    prescription_id: str | None = None
    items: list[DispenseLine] | None = None


async def _batches(ctx, item_id: str, store: str) -> list[dict]:
    from ..schema import stock

    t = stock
    rows = (await ctx.conn.execute(sa.select(t.c.batch, t.c.expiry, t.c.qty, t.c.mrp).where(
        t.c.item_id == item_id, t.c.store == store, t.c.deleted_at.is_(None), t.c.qty > 0,
        sa.func.coalesce(t.c.status, "Available") != "Quarantine", sa.or_(t.c.expiry.is_(None), t.c.expiry >= today()),
    ).order_by(t.c.expiry.asc().nulls_last(), t.c.created_at))).all()
    return [{"batch": r.batch, "expiry": r.expiry.isoformat() if r.expiry else None,
             "days_left": (r.expiry - today()).days if r.expiry else None, "qty": float(r.qty), "mrp": float(r.mrp or 0)} for r in rows]


def _allocate(batches: list[dict], qty: Decimal, batch: str | None) -> list[dict]:
    pool = [b for b in batches if b["batch"] == batch] if batch else batches
    out, need = [], qty
    for b in pool:
        if need <= 0:
            break
        take = min(Decimal(str(b["qty"])), need)
        need -= take
        out.append({"batch": b["batch"], "expiry": b["expiry"], "qty": float(take), "mrp": b["mrp"],
                    "amount": float(money(take * Decimal(str(b["mrp"]))))})
    return out


@router.post("/plan")
async def plan(body: PlanIn, ctx: CtxDep):
    """What a dispense would do: lines (from the prescription's remaining qty when none are given),
    FEFO batch allocation per line, safety alerts and the bill total. Nothing is written."""
    require_role(ctx, "pharmacist")
    rx = await _prescription(ctx, body.prescription_id, body.patient_id) if body.prescription_id else None
    rx_lines: list[dict] = []
    if rx:
        items = await items_by_id(ctx, [ln.get("drug") for ln in rx.get("items") or []])
        rx_lines = _rx_lines(rx, (await dispensed_by_rx(ctx, [rx["id"]])).get(rx["id"], {}), items)
    lines = [ln.model_dump() for ln in body.items] if body.items is not None else [
        {"item_id": ln["item_id"], "qty": ln["remaining"], "batch": None} for ln in rx_lines if ln["remaining"] > 0]
    lines = [ln for ln in lines if ln["qty"] and ln["qty"] > 0]
    if not lines:
        return {"lines": [], "alerts": [], "summary": {"total": 0, "blocking": 0, "severe": 0, "requires_override": False},
                "total": 0, "prescription": rx_lines}
    items = await items_by_id(ctx, [ln["item_id"] for ln in lines])
    by_rx = {ln["item_id"]: ln for ln in rx_lines}
    out, total = [], ZERO
    for ln in lines:
        it = items.get(ln["item_id"])
        if not it:
            raise bad_request("Unknown drug in the dispense lines")
        batches = await _batches(ctx, ln["item_id"], body.store)
        alloc = _allocate(batches, Decimal(str(ln["qty"])), ln.get("batch"))
        amount = sum((Decimal(str(a["amount"])) for a in alloc), ZERO)
        total += amount
        r = by_rx.get(ln["item_id"])
        out.append({"item_id": ln["item_id"], "name": item_label(it), "uom": it.get("uom"), "qty": ln["qty"], "batch": ln.get("batch"),
                    "batches": batches, "allocation": alloc, "allocated": float(sum((Decimal(str(a["qty"])) for a in alloc), ZERO)),
                    "amount": float(amount), "mrp": it.get("mrp"), "schedule": it.get("schedule"), "high_alert": bool(it.get("high_alert")),
                    "on_prescription": r is not None, "remaining": r["remaining"] if r else None,
                    "dose": (r or {}).get("dose"), "frequency": (r or {}).get("frequency"), "duration_days": (r or {}).get("duration_days"),
                    "instructions": (r or {}).get("instructions")})
    safety = await safety_check(ctx, patient_id=body.patient_id, lines=lines, purpose="dispense", store=body.store, prescription=rx)
    alerts = safety["alerts"] + _rx_quantity_alerts(lines, rx, rx_lines, items)
    return {"lines": out, "alerts": alerts, "summary": {**safety["summary"], "blocking": sum(a["blocking"] for a in alerts)},
            "total": float(money(total)), "prescription": rx_lines, "allergies": safety["allergies"]}


def _rx_quantity_alerts(lines: list[dict], rx: dict | None, rx_lines: list[dict], items: dict) -> list[dict]:
    if not rx:
        return []
    by_rx = {ln["item_id"]: ln for ln in rx_lines}
    want: dict[str, Decimal] = {}
    for ln in lines:
        want[ln["item_id"]] = want.get(ln["item_id"], ZERO) + Decimal(str(ln["qty"]))
    out = []
    for iid, q in want.items():
        p = profile(items[iid])
        r = by_rx.get(iid)
        if r is None:
            out.append(_alert("schedule", "Contraindicated" if p["schedule"] in CONTROLLED else "Moderate", p,
                              f"{p['name']} is not on prescription {rx.get('code')}.", blocking=p["schedule"] in CONTROLLED))
        elif q > Decimal(str(r["remaining"])):
            out.append(_alert("quantity", "Major", p, f"{p['name']}: {q.normalize():f} exceeds the {r['remaining']:g} remaining on "
                              f"prescription {rx.get('code')}.", blocking=True))
    return out


class DispenseIn(BaseModel):
    patient_id: str
    store: Literal["OP Pharmacy", "IP Pharmacy"]
    items: list[DispenseLine] = Field(min_length=1, max_length=60)
    prescription_id: str | None = None
    encounter_id: str | None = None
    override_reason: str | None = Field(default=None, max_length=1000)
    counselled: bool = False


@router.post("/dispense", status_code=201)
async def dispense(body: DispenseIn, ctx: CtxDep):
    require_role(ctx, "pharmacist")
    from .billing import post_charge

    patient = await patient_or_404(ctx, body.patient_id)
    rx = await _prescription(ctx, body.prescription_id, body.patient_id) if body.prescription_id else None
    if rx and rx.get("status") not in OPEN_RX:
        raise conflict(f"Prescription {rx.get('code')} is {rx.get('status')} — nothing left to dispense")
    encounter_id = body.encounter_id or (rx or {}).get("encounter_id")
    if body.store == "IP Pharmacy":
        adm = await admission_of(ctx, body.patient_id)
        if not adm:
            raise conflict("The patient is not admitted — dispense from the OP pharmacy")
        encounter_id = encounter_id or adm["id"]
    lines = [ln.model_dump() for ln in body.items]
    items = await items_by_id(ctx, [ln["item_id"] for ln in lines])
    rx_lines: list[dict] = []
    if rx:
        rx_items = await items_by_id(ctx, [ln.get("drug") for ln in rx.get("items") or []])
        rx_lines = _rx_lines(rx, (await dispensed_by_rx(ctx, [rx["id"]])).get(rx["id"], {}), rx_items)

    safety = await safety_check(ctx, patient_id=body.patient_id, lines=lines, purpose="dispense", store=body.store, prescription=rx)
    alerts = safety["alerts"] + _rx_quantity_alerts(lines, rx, rx_lines, items)
    blocking = [a for a in alerts if a["blocking"]]
    if blocking:
        raise ApiError(409, blocking[0]["message"], {"alerts": alerts}, code="DISPENSE_BLOCKED")
    severe = [a for a in alerts if a["severity"] in SEVERE]
    reason = (body.override_reason or "").strip()
    if severe and len(reason) < 5:
        raise ApiError(409, f"{len(severe)} serious alert(s) need an override reason before dispensing", {"alerts": alerts},
                       code="OVERRIDE_REQUIRED")

    ent = E(DISPENSE)
    did = new_id()
    code = await next_code(ctx.conn, ent.prefix, ent.code_digits, ent.code_sep)
    out_lines, total, register = [], ZERO, []
    for ln in lines:
        it = items[ln["item_id"]]
        allocs = await stock_out(ctx, item_id=ln["item_id"], store=body.store, qty=ln["qty"], batch=ln.get("batch"), kind="DISPENSE",
                                 ref=code, ref_fqn=DISPENSE, ref_id=did, patient_id=body.patient_id, encounter_id=encounter_id)
        for a in allocs:
            rate = Decimal(str(a["mrp"] if a["mrp"] is not None else it.get("mrp") or 0))
            amount = money(rate * Decimal(str(a["qty"])))
            total += amount
            out_lines.append({"item": ln["item_id"], "batch": a["batch"], "expiry": a["expiry"], "qty": a["qty"],
                              "rate": float(rate), "amount": float(amount)})
            if it.get("schedule") in CONTROLLED:
                register.append({"register": REGISTER[it["schedule"]], "item": ln["item_id"], "drug": item_label(it), "batch": a["batch"],
                                 "qty": a["qty"], "balance_after": a["balance"], "patient": patient.get("title"), "uhid": patient.get("code"),
                                 "prescription": (rx or {}).get("code"), "prescriber": (rx or {}).get("doctor"),
                                 "dispensed_by": ctx.user.get("name"), "at": now().isoformat(timespec="seconds")})
    rec = await create(ctx, DISPENSE, {
        "id": did, "code": code, "patient_id": body.patient_id, "encounter_id": encounter_id, "prescription": (rx or {}).get("id"),
        "store": body.store, "items": out_lines, "total": float(money(total)), "pharmacist": ctx.user.get("employee_id"),
        "dispensed_at": now().isoformat(timespec="seconds"), "counselled": body.counselled, "status": "Dispensed",
        "alerts_overridden": _override_text(severe, reason),
        "controlled_register": bool(register), "register_entries": register or None,
    })
    for ln in out_lines:
        it = items[ln["item"]]
        await post_charge(ctx, patient_id=body.patient_id, encounter_id=encounter_id, qty=ln["qty"], rate=ln["rate"],
                          description=f"{item_label(it)} · batch {ln['batch'] or '—'}", source=DISPENSE, source_id=did)
    if severe:
        await audit(ctx, "pharmacy.override", module="pharmacy", entity="dispenses", record=rec,
                    after={"alerts": [{k: a[k] for k in ("type", "severity", "item", "with", "message")} for a in severe]}, note=reason)
        for a in severe:
            await create(ctx, INTERVENTION, {
                "patient_id": body.patient_id, "encounter_id": encounter_id, "prescription": (rx or {}).get("id"),
                "alert_type": ALERT_TYPE_LABEL.get(a["type"], "Drug–drug interaction"), "severity": a["severity"], "drug": a["item_id"],
                "interacting_with": a.get("with"), "message": a["message"], "override_reason": reason[:1000],
                "resolved_by": ctx.user.get("employee_id"), "resolved_at": now().isoformat(timespec="seconds"),
                "dispense": did, "status": "Overridden",
            })
    rx_status = None
    if rx:
        rx_status = await _refresh_rx_status(ctx, rx)
    return {"dispense": rec, "total": float(money(total)), "alerts": alerts, "prescription_status": rx_status}


def _override_text(severe: list[dict], reason: str) -> str | None:
    if not severe:
        return None
    lines = [f"[{a['severity']}] {a['label']}: {a['message']}" for a in severe]
    return "\n".join([*lines, f"Override reason: {reason}"])


async def _refresh_rx_status(ctx, rx: dict) -> str:
    items = await items_by_id(ctx, [ln.get("drug") for ln in rx.get("items") or []])
    lines = _rx_lines(rx, (await dispensed_by_rx(ctx, [rx["id"]])).get(rx["id"], {}), items)
    any_done = any(ln["dispensed"] > 0 for ln in lines)
    status = "Dispensed" if lines and all(ln["remaining"] <= 0 for ln in lines) else "Partially Dispensed" if any_done else "Active"
    if status != rx.get("status"):
        await update(ctx, RX, rx["id"], {"status": status})
    return status


# ------------------------------------------------------------------ returns: restock the same batch + credit the bill

async def _returnable(ctx, disp: dict, exclude_return: str | None = None) -> dict[tuple[str, str | None], dict]:
    pool: dict[tuple[str, str | None], dict] = {}
    for ln in disp.get("items") or []:
        k = (ln.get("item"), ln.get("batch"))
        p = pool.setdefault(k, {"qty": ZERO, "rate": Decimal(str(ln.get("rate") or 0)), "expiry": ln.get("expiry")})
        p["qty"] += Decimal(str(ln.get("qty") or 0))
    for r in await find(ctx, RETURN, dispense=disp["id"], status=["Requested", "Accepted"], limit=200):
        if r["id"] == exclude_return:
            continue
        for ln in r.get("items") or []:
            k = (ln.get("item"), ln.get("batch"))
            if k in pool:
                pool[k]["qty"] -= Decimal(str(ln.get("qty") or 0))
    return pool


async def _match_return(ctx, disp: dict, lines: list[dict], exclude_return: str | None) -> list[dict]:
    pool = await _returnable(ctx, disp, exclude_return)
    items = await items_by_id(ctx, [ln.get("item") for ln in lines])
    out = []
    for i, ln in enumerate(lines, 1):
        iid, q = ln.get("item"), Decimal(str(ln.get("qty") or 0))
        name = item_label(items.get(iid))
        if q <= 0:
            raise bad_request(f"Line {i}: return quantity must be more than zero")
        keys = [k for k in pool if k[0] == iid and (not ln.get("batch") or k[1] == ln.get("batch"))]
        if not keys:
            raise bad_request(f"Line {i}: {name}{' batch ' + ln['batch'] if ln.get('batch') else ''} was not dispensed on {disp.get('code')}")
        left = q
        for k in keys:
            take = min(pool[k]["qty"], left)
            if take <= 0:
                continue
            pool[k]["qty"] -= take
            left -= take
            out.append({"item": iid, "batch": k[1], "qty": float(take), "rate": float(pool[k]["rate"]), "expiry": pool[k]["expiry"]})
        if left > 0:
            raise conflict(f"Line {i}: only {(q - left).normalize():f} of {name} can still be returned against {disp.get('code')}")
    return out


@hook(RETURN, "before_create")
async def _return_validate(ctx, draft):
    disp = await get(ctx, DISPENSE, draft.get("dispense"))
    if not disp:
        raise bad_request("Dispense not found", {"fields": {"dispense": "Choose the dispense being returned"}})
    if disp.get("patient_id") != draft.get("patient_id"):
        raise bad_request("That dispense belongs to another patient", {"fields": {"dispense": "Different patient"}})
    if disp.get("status") in ("Returned", "Cancelled"):
        raise conflict(f"Dispense {disp.get('code')} is already {disp.get('status')}")
    draft["items"] = await _match_return(ctx, disp, draft.get("items") or [], None)
    draft["refund_amount"] = float(money(sum((Decimal(str(ln["qty"])) * Decimal(str(ln["rate"])) for ln in draft["items"]), ZERO)))
    draft.setdefault("encounter_id", disp.get("encounter_id"))
    draft["store"] = disp.get("store")


@hook(RETURN, "before_transition")
async def _return_accept(ctx, nxt, prev):
    if nxt["status"] != "Accepted":
        return
    from .billing import post_charge

    disp = await get(ctx, DISPENSE, nxt.get("dispense"))
    if not disp:
        raise conflict("The original dispense no longer exists")
    lines = await _match_return(ctx, disp, nxt.get("items") or [], prev["id"])
    items = await items_by_id(ctx, [ln["item"] for ln in lines])
    for ln in lines:
        await stock_in(ctx, item_id=ln["item"], store=disp["store"], qty=ln["qty"], batch=ln["batch"], expiry=ln.get("expiry"),
                       mrp=ln["rate"], kind="RETURN", ref=prev["code"], ref_fqn=RETURN, ref_id=prev["id"],
                       patient_id=nxt.get("patient_id"), encounter_id=nxt.get("encounter_id"))
        await post_charge(ctx, patient_id=nxt["patient_id"], encounter_id=nxt.get("encounter_id") or disp.get("encounter_id"),
                          qty=-ln["qty"], rate=ln["rate"], description=f"Return: {item_label(items.get(ln['item']))} · batch {ln['batch'] or '—'}",
                          source=RETURN, source_id=prev["id"])
    nxt["items"] = lines
    nxt["refund_amount"] = float(money(sum((Decimal(str(ln["qty"])) * Decimal(str(ln["rate"])) for ln in lines), ZERO)))


@hook(RETURN, "after_transition")
async def _return_done(ctx, rec, prev):
    if rec["status"] != "Accepted":
        return
    disp = await get(ctx, DISPENSE, rec.get("dispense"))
    if not disp:
        return
    accepted = ZERO
    for r in await find(ctx, RETURN, dispense=disp["id"], status="Accepted", limit=200):
        accepted += sum((Decimal(str(ln.get("qty") or 0)) for ln in r.get("items") or []), ZERO)
    dispensed = sum((Decimal(str(ln.get("qty") or 0)) for ln in disp.get("items") or []), ZERO)
    status = "Returned" if accepted >= dispensed else "Partially Returned"
    if status != disp.get("status"):
        await update(ctx, DISPENSE, disp["id"], {"status": status})


# ------------------------------------------------------------------ ward indents (IP pharmacy → ward)

@hook(INDENT, "before_transition")
async def _indent_issue(ctx, nxt, prev):
    if nxt["status"] != "Issued":
        return
    from .billing import post_charge

    lines = nxt.get("items") or []
    items = await items_by_id(ctx, [ln.get("item") for ln in lines])
    pid = nxt.get("patient_id")
    adm = await admission_of(ctx, pid) if pid else None
    out, allocations, issued_any, register = [], [], False, []
    for i, ln in enumerate(lines):
        asked = Decimal(str(ln.get("qty") or 0))
        want = Decimal(str(ln["issued_qty"])) if ln.get("issued_qty") not in (None, "") else asked
        if want < 0 or want > asked:
            raise bad_request(f"Line {i + 1}: issued quantity must be between 0 and the indented {asked.normalize():f}")
        allocs = []
        if want > 0:
            allocs = await stock_out(ctx, item_id=ln["item"], store="IP Pharmacy", qty=want, kind="ISSUE", ref=prev["code"], ref_fqn=INDENT,
                                     ref_id=prev["id"], patient_id=pid, encounter_id=(adm or {}).get("id"), partial=True,
                                     extra={"ward": nxt.get("ward")})
        got = sum((Decimal(str(a["qty"])) for a in allocs), ZERO)
        issued_any = issued_any or got > 0
        allocations += [{**a, "line": i} for a in allocs]
        out.append({**ln, "issued_qty": float(got)})
        it = items.get(ln["item"]) or {}
        if it.get("schedule") in CONTROLLED and got > 0:
            register.append({"register": REGISTER[it["schedule"]], "item": ln["item"], "drug": item_label(it), "qty": float(got),
                             "ward": nxt.get("ward"), "batches": [a["batch"] for a in allocs], "issued_by": ctx.user.get("name")})
        if pid and got > 0 and it.get("type") in ("Drug", "Consumable", "Implant"):
            for a in allocs:
                await post_charge(ctx, patient_id=pid, encounter_id=(adm or {}).get("id"), qty=a["qty"], rate=a["mrp"] or it.get("mrp"),
                                  description=f"{item_label(it)} · batch {a['batch'] or '—'} (ward indent)", source=INDENT, source_id=prev["id"])
    if not issued_any:
        raise conflict("Nothing could be issued — none of the indented items are in stock in the IP pharmacy")
    nxt.update(items=out, allocations=allocations, issued_by=ctx.user.get("employee_id"))
    if register:
        nxt["controlled_register"], nxt["register_entries"] = True, register


@hook(INDENT, "after_transition")
async def _indent_partial(ctx, rec, prev):
    if rec["status"] == "Issued" and any(Decimal(str(ln.get("issued_qty") or 0)) < Decimal(str(ln.get("qty") or 0))
                                         for ln in rec.get("items") or []):
        await update(ctx, INDENT, rec["id"], {"status": "Partially Issued"})


@router.get("/patients/{pid}/medications")
async def medications(pid: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(RX), "read")
    meds = await active_medications(ctx, pid)
    items = await items_by_id(ctx, [m["item_id"] for m in meds])
    for m in meds:
        m["name"] = item_label(items.get(m["item_id"]))
        m.pop("_refs", None)
    return {"medications": meds, "allergies": await patient_allergies(ctx, pid)}


__all__ = ["router", "safety_check", "patient_allergies", "active_medications", "admission_of", "profile", "dispensed_by_rx"]
