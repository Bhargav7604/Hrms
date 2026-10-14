"""Connector Hub (module 56): FHIR R4 read API, HL7 v2 (ORU^R01 in, ADT^A01/A03 out), ABDM ABHA
verification, TPA claim submission and Tally / ERP voucher export — every exchange is written to
`connectors.messages` so the hub can show health, counts and failures per connector.

Transport is in *log mode*: outbound messages are generated, validated and logged (status Sent)
but not transmitted. Live transports (MLLP sender, ABDM gateway, TPA / NHCX APIs, Tally HTTP
port) plug into the `_deliver_*` points below without changing message generation or logging.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, timedelta
from typing import Any
from xml.sax.saxutils import escape as xml_escape

import sqlalchemy as sa
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit, hook, listen
from ..core.registry import get_entity
from ..core.security import CtxDep
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    is_uuid,
    new_id,
    not_found,
    now,
    parse_date,
    parse_dt,
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
from . import metrics
from ._common import E, create, find, get, live, require_role, transition, update

log = logging.getLogger("vlack.integrations")
router = APIRouter(prefix="/api")
fhir = APIRouter(prefix="/fhir", tags=["fhir"])
hl7 = APIRouter(prefix="/hl7", tags=["hl7"])
abdm = APIRouter(prefix="/abdm", tags=["abdm"])
tpa = APIRouter(prefix="/tpa", tags=["tpa"])
tally = APIRouter(prefix="/tally", tags=["tally"])
hub = APIRouter(prefix="/integrations", tags=["integrations"])

UHID_SYSTEM = "https://vlack.health/uhid"
ABHA_SYSTEM = "https://healthid.ndhm.gov.in"
FHIR_JSON = "application/fhir+json"

# Default connector records, created on first use so every message has a connector to report under.
CONNECTORS: dict[str, dict] = {
    "hl7_in": {"name": "LIS analysers — results (HL7 ORU)", "connector_type": "HL7 v2", "direction": "Inbound", "transport": "HTTPS REST",
               "message_types": ["ORU^R01"], "vendor": "Laboratory / radiology middleware"},
    "hl7_out": {"name": "ADT feed (HL7 v2 outbound)", "connector_type": "HL7 v2", "direction": "Outbound", "transport": "MLLP / TCP",
                "message_types": ["ADT^A01", "ADT^A03"], "vendor": "Subscribing systems (LIS, RIS, PACS, dietary)"},
    "fhir": {"name": "FHIR R4 API", "connector_type": "FHIR R4", "direction": "Outbound", "transport": "FHIR REST",
             "message_types": ["Patient", "Encounter", "Observation", "DiagnosticReport", "MedicationRequest"]},
    "abdm": {"name": "ABDM gateway (ABHA / HIE-CM)", "connector_type": "ABDM (ABHA / HIE-CM)", "direction": "Bidirectional",
             "transport": "HTTPS REST", "endpoint": "https://dev.abdm.gov.in/gateway", "environment": "Sandbox",
             "auth_type": "OAuth 2.0 (client credentials)", "message_types": ["ABHA verify"]},
    "tpa": {"name": "TPA / insurer claims", "connector_type": "TPA Portal", "direction": "Outbound", "transport": "HTTPS REST",
            "environment": "Sandbox", "message_types": ["Claim submission"]},
    "tally": {"name": "Tally Prime (XML import)", "connector_type": "Tally / ERP", "direction": "Outbound", "transport": "HTTPS REST",
              "endpoint": "http://tally-server:9000", "message_types": ["Sales voucher", "Receipt voucher", "Payment voucher", "Journal voucher"]},
}


async def connector(ctx, key: str) -> dict | None:
    spec = CONNECTORS[key]
    if not get_entity("connectors.connectors"):
        return None
    rows = await find(ctx, "connectors.connectors", connector_type=spec["connector_type"], limit=50)
    same_way = [r for r in rows if r.get("direction") in (spec["direction"], "Bidirectional")]
    if same_way:
        # prefer an exact-direction Active connector; a Disabled one is still used so the traffic is visible against it
        return sorted(same_way, key=lambda r: (r.get("direction") != spec["direction"], r.get("status") != "Active"))[0]
    return await create(ctx, "connectors.connectors", {"environment": "Sandbox", "auth_type": "None", **spec, "status": "Active"})


async def log_message(ctx, key: str, *, message_type: str, direction: str, status: str, payload: str | None = None,
                      response: str | None = None, control_id: str | None = None, correlation_id: str | None = None,
                      ack_code: str | None = None, error: str | None = None, patient_id: str | None = None) -> dict | None:
    if not get_entity("connectors.messages"):
        return None
    cx = await connector(ctx, key)
    msg = await create(ctx, "connectors.messages", {
        "connector": cx["id"] if cx else None, "direction": direction, "message_type": message_type, "control_id": control_id,
        "correlation_id": correlation_id, "ack_code": ack_code, "attempts": 1, "payload": (payload or "")[:19000] or None,
        "response": (response or "")[:4000] or None, "error": (error or "")[:900] or None,
        "processed_at": now().isoformat(timespec="seconds"), "patient_id": patient_id, "status": status,
    })
    if cx:
        upd: dict[str, Any] = {"last_sync_at": now().isoformat(timespec="seconds")}
        if status == "Failed":
            upd["last_error"] = (error or "")[:300]
        await update(ctx, "connectors.connectors", cx["id"], upd)
    return msg


# ====================================================================== FHIR R4

class FhirError(Exception):
    def __init__(self, status: int, code: str, msg: str):
        super().__init__(msg)
        self.status, self.code, self.msg = status, code, msg


def _fhir(body: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, media_type=FHIR_JSON)


def _outcome(status: int, code: str, msg: str) -> JSONResponse:
    return _fhir({"resourceType": "OperationOutcome", "issue": [{"severity": "error", "code": code, "diagnostics": msg}]}, status)


def _iso(v: Any) -> str | None:
    d = parse_dt(v) if v else None
    return d.astimezone(settings.tz).isoformat(timespec="seconds") if d else None


def _abha_fmt(digits: str | None) -> str | None:
    d = re.sub(r"\D", "", digits or "")
    return f"{d[:2]}-{d[2:6]}-{d[6:10]}-{d[10:14]}" if len(d) == 14 else None


def _base(request: Request) -> str:
    return str(request.base_url).rstrip("/") + "/api/fhir"


def _bundle(request: Request, resources: list[dict]) -> dict:
    base = _base(request)
    return {"resourceType": "Bundle", "id": new_id(), "meta": {"lastUpdated": now().isoformat(timespec="seconds")}, "type": "searchset",
            "total": len(resources), "link": [{"relation": "self", "url": str(request.url)}],
            "entry": [{"fullUrl": f"{base}/{r['resourceType']}/{r['id']}", "resource": r, "search": {"mode": "match"}} for r in resources]}


def patient_resource(p: dict) -> dict:
    ident = [{"use": "usual", "type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0203", "code": "MR",
                                                   "display": "Medical record number"}]}, "system": UHID_SYSTEM, "value": p.get("code")}]
    if p.get("abha_id"):
        ident.append({"type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0203", "code": "NH",
                                           "display": "National unique individual identifier"}], "text": "ABHA number"},
                      "system": ABHA_SYSTEM, "value": _abha_fmt(p["abha_id"]) or p["abha_id"]})
    name = {"use": "official", "text": " ".join(x for x in (p.get("first_name"), p.get("last_name")) if x) or p.get("title")}
    if p.get("last_name"):
        name["family"] = p["last_name"]
    if p.get("first_name"):
        name["given"] = [p["first_name"]]
    if p.get("salutation"):
        name["prefix"] = [p["salutation"]]
    res: dict[str, Any] = {
        "resourceType": "Patient", "id": p["id"],
        "meta": {"lastUpdated": _iso(p.get("updated_at") or p.get("created_at")),
                 "profile": ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Patient"]},
        "identifier": ident, "active": p.get("status") == "Active", "name": [name],
        "gender": {"Male": "male", "Female": "female", "Other": "other"}.get(p.get("gender"), "unknown"),
    }
    telecom = [{"system": "phone", "value": p["phone"], "use": "mobile"}] if p.get("phone") else []
    if p.get("email"):
        telecom.append({"system": "email", "value": p["email"], "use": "home"})
    if telecom:
        res["telecom"] = telecom
    if p.get("dob"):
        res["birthDate"] = p["dob"]
    if p.get("status") == "Deceased":
        res["deceasedDateTime" if p.get("date_of_death") else "deceasedBoolean"] = _iso(p.get("date_of_death")) or True
    if any(p.get(k) for k in ("address", "city", "state", "pincode")):
        addr = {"use": "home", "text": ", ".join(x for x in (p.get("address"), p.get("city"), p.get("state"), p.get("pincode")) if x), "country": "IN"}
        for src, dst in (("city", "city"), ("state", "state"), ("pincode", "postalCode")):
            if p.get(src):
                addr[dst] = p[src]
        res["address"] = [addr]
    if p.get("marital_status"):
        res["maritalStatus"] = {"text": p["marital_status"]}
    if p.get("merged_into"):
        res["link"] = [{"other": {"reference": f"Patient/{p['merged_into']}"}, "type": "replaced-by"}]
    return res


ENC_CLASS = {"IPD": ("IMP", "inpatient encounter"), "OPD": ("AMB", "ambulatory"), "ER": ("EMER", "emergency"),
             "DAYCARE": ("SS", "short stay"), "TELE": ("VR", "virtual")}
ENC_STATUS = {"Open": "in-progress", "Waiting": "arrived", "In Treatment": "in-progress", "Observation": "in-progress",
              "Admitted": "in-progress", "Discharge Initiated": "in-progress", "Discharged": "finished", "Closed": "finished",
              "Disposed": "finished", "Cancelled": "cancelled"}


def encounter_resource(e: dict, pname: str | None) -> dict:
    cls = ENC_CLASS.get(e.get("type") or "", ("AMB", "ambulatory"))
    res: dict[str, Any] = {
        "resourceType": "Encounter", "id": e["id"], "meta": {"lastUpdated": _iso(e.get("updated_at") or e.get("created_at"))},
        "identifier": [{"system": "https://vlack.health/encounter", "value": e.get("code")}],
        "status": ENC_STATUS.get(e.get("status") or "", "unknown"),
        "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": cls[0], "display": cls[1]},
        "subject": {"reference": f"Patient/{e['patient_id']}", "display": pname},
        "period": {k: v for k, v in (("start", _iso(e.get("started_at"))), ("end", _iso(e.get("ended_at")))) if v},
        "serviceProvider": {"display": settings.hospital_name},
    }
    if e.get("doctor"):
        res["participant"] = [{"type": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-ParticipationType", "code": "ATND",
                                                      "display": "attender"}]}], "individual": {"display": e["doctor"]}}]
    reason = e.get("diagnosis") or e.get("chief_complaint") or e.get("provisional_diagnosis")
    if reason:
        res["reasonCode"] = [{"text": reason}]
    if e.get("ward") or e.get("bed_no"):
        res["location"] = [{"location": {"display": " / ".join(x for x in (e.get("ward"), e.get("bed_no")) if x)}}]
    hosp = {}
    if e.get("admission_source"):
        hosp["admitSource"] = {"text": e["admission_source"]}
    if e.get("discharge_type") or e.get("disposition"):
        hosp["dischargeDisposition"] = {"text": e.get("discharge_type") or e.get("disposition")}
    if hosp:
        res["hospitalization"] = hosp
    if e.get("department"):
        res["serviceType"] = {"text": e["department"]}
    return res


UCUM = "http://unitsofmeasure.org"
LOINC = "http://loinc.org"
VITALS = [  # field, id suffix, LOINC, display, unit text, UCUM code
    ("pulse", "hr", "8867-4", "Heart rate", "beats/minute", "/min"),
    ("resp_rate", "rr", "9279-1", "Respiratory rate", "breaths/minute", "/min"),
    ("spo2", "spo2", "2708-6", "Oxygen saturation in Arterial blood", "%", "%"),
    ("temperature", "temp", "8310-5", "Body temperature", "°F", "[degF]"),
    ("weight", "wt", "29463-7", "Body weight", "kg", "kg"),
    ("height", "ht", "8302-2", "Body height", "cm", "cm"),
    ("bmi", "bmi", "39156-5", "Body mass index (BMI) [Ratio]", "kg/m2", "kg/m2"),
]
LAB_LOINC = {
    "haemoglobin": ("718-7", "Hemoglobin [Mass/volume] in Blood"), "total wbc": ("6690-2", "Leukocytes [#/volume] in Blood by Automated count"),
    "platelets": ("777-3", "Platelets [#/volume] in Blood by Automated count"), "pcv": ("4544-3", "Hematocrit [Volume Fraction] of Blood by Automated count"),
    "neutrophils": ("770-8", "Neutrophils/100 leukocytes in Blood by Automated count"),
    "lymphocytes": ("736-9", "Lymphocytes/100 leukocytes in Blood by Automated count"),
    "glucose (random)": ("2345-7", "Glucose [Mass/volume] in Serum or Plasma"), "glucose (fasting)": ("1558-6", "Fasting glucose [Mass/volume] in Serum or Plasma"),
    "hba1c": ("4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood"), "urea": ("3091-6", "Urea [Mass/volume] in Serum or Plasma"),
    "creatinine": ("2160-0", "Creatinine [Mass/volume] in Serum or Plasma"), "sodium": ("2951-2", "Sodium [Moles/volume] in Serum or Plasma"),
    "potassium": ("2823-3", "Potassium [Moles/volume] in Serum or Plasma"), "chloride": ("2075-0", "Chloride [Moles/volume] in Serum or Plasma"),
    "total bilirubin": ("1975-2", "Bilirubin.total [Mass/volume] in Serum or Plasma"), "sgot (ast)": ("1920-8", "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma"),
    "sgpt (alt)": ("1742-6", "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma"),
    "alkaline phosphatase": ("6768-6", "Alkaline phosphatase [Enzymatic activity/volume] in Serum or Plasma"),
    "albumin": ("1751-7", "Albumin [Mass/volume] in Serum or Plasma"), "total cholesterol": ("2093-3", "Cholesterol [Mass/volume] in Serum or Plasma"),
    "triglycerides": ("2571-8", "Triglyceride [Mass/volume] in Serum or Plasma"), "hdl": ("2085-9", "Cholesterol in HDL [Mass/volume] in Serum or Plasma"),
    "ldl": ("13457-7", "Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation"), "tsh": ("3016-3", "Thyrotropin [Units/volume] in Serum or Plasma"),
    "t3": ("3053-6", "Triiodothyronine (T3) [Mass/volume] in Serum or Plasma"), "t4": ("3026-2", "Thyroxine (T4) [Mass/volume] in Serum or Plasma"),
    "troponin i": ("89579-7", "Troponin I.cardiac [Mass/volume] in Serum or Plasma by High sensitivity method"),
    "crp": ("1988-5", "C reactive protein [Mass/volume] in Serum or Plasma"), "pt": ("5902-2", "Prothrombin time (PT)"),
    "inr": ("6301-6", "INR in Platelet poor plasma by Coagulation assay"), "esr": ("4537-7", "Erythrocyte sedimentation rate by Westergren method"),
    "d-dimer": ("48065-7", "Fibrin D-dimer FEU [Mass/volume] in Platelet poor plasma"), "procalcitonin": ("33959-8", "Procalcitonin [Mass/volume] in Serum or Plasma"),
    "vitamin b12": ("2132-9", "Cobalamin (Vitamin B12) [Mass/volume] in Serum or Plasma"),
    "25-oh vitamin d": ("1989-3", "25-Hydroxyvitamin D3+25-Hydroxyvitamin D2 [Mass/volume] in Serum or Plasma"),
    "ph": ("2744-1", "pH of Arterial blood"), "pco2": ("2019-8", "Carbon dioxide [Partial pressure] in Arterial blood"),
    "po2": ("2703-7", "Oxygen [Partial pressure] in Arterial blood"), "lactate": ("2524-7", "Lactate [Moles/volume] in Serum or Plasma"),
}
INTERP = {"Normal": ("N", "Normal"), "Low": ("L", "Low"), "High": ("H", "High"), "Critical Low": ("LL", "Critical low"),
          "Critical High": ("HH", "Critical high"), "Abnormal": ("A", "Abnormal")}


async def _loinc_overrides(ctx) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    for m in await find(ctx, "connectors.mappings", mapping_type="Lab test (LOINC)", status="Active", limit=500):
        if m.get("local_code") and m.get("external_code"):
            out[str(m["local_code"]).strip().lower()] = (m["external_code"], m.get("external_display") or m.get("local_display") or "")
    return out


def _cat(code: str, display: str) -> list[dict]:
    return [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": code, "display": display}]}]


def _num(v: Any) -> float | None:
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def vitals_observations(v: dict) -> list[dict]:
    base = {"resourceType": "Observation", "status": "entered-in-error" if v.get("status") == "Entered in Error" else "final",
            "category": _cat("vital-signs", "Vital Signs"), "subject": {"reference": f"Patient/{v['patient_id']}"},
            "effectiveDateTime": _iso(v.get("recorded_at") or v.get("created_at")),
            "meta": {"profile": ["http://hl7.org/fhir/StructureDefinition/vitalsigns"]}}
    if v.get("encounter_id"):
        base["encounter"] = {"reference": f"Encounter/{v['encounter_id']}"}
    out = []
    for field, sfx, code, disp, unit, ucum in VITALS:
        val = _num(v.get(field))
        if val is None:
            continue
        coding = [{"system": LOINC, "code": code, "display": disp}]
        if field == "spo2":
            coding.append({"system": LOINC, "code": "59408-5", "display": "Oxygen saturation in Arterial blood by Pulse oximetry"})
        out.append({**base, "id": f"vs-{v['id']}-{sfx}", "code": {"coding": coding, "text": disp},
                    "valueQuantity": {"value": val, "unit": unit, "system": UCUM, "code": ucum}})
    sbp, dbp = _num(v.get("bp_systolic")), _num(v.get("bp_diastolic"))
    if sbp is not None or dbp is not None:
        comps = []
        for val, code, disp in ((sbp, "8480-6", "Systolic blood pressure"), (dbp, "8462-4", "Diastolic blood pressure")):
            if val is not None:
                comps.append({"code": {"coding": [{"system": LOINC, "code": code, "display": disp}], "text": disp},
                              "valueQuantity": {"value": val, "unit": "mmHg", "system": UCUM, "code": "mm[Hg]"}})
        out.append({**base, "id": f"vs-{v['id']}-bp", "code": {"coding": [{"system": LOINC, "code": "85354-9",
                                                                          "display": "Blood pressure panel with all children optional"}],
                                                              "text": "Blood pressure"}, "component": comps})
    return out


def _ref_range(rr: str | None) -> list[dict] | None:
    m = re.match(r"^\s*([\d.]+)\s*[–-]\s*([\d.]+)\s*$", rr or "")
    if not m:
        return [{"text": rr}] if rr else None
    return [{"low": {"value": float(m.group(1))}, "high": {"value": float(m.group(2))}, "text": rr}]


def lab_observations(o: dict, overrides: dict) -> list[dict]:
    out = []
    status = "final" if o.get("status") == "Verified" else "preliminary"
    for i, v in enumerate(o.get("result_values") or []):
        param = str(v.get("parameter") or "Result")
        key = param.strip().lower()
        loinc = overrides.get(f"{(o.get('service_code') or '').lower()}:{key}") or overrides.get(key) or LAB_LOINC.get(key)
        code: dict[str, Any] = {"text": param}
        if loinc:
            code["coding"] = [{"system": LOINC, "code": loinc[0], "display": loinc[1] or param}]
        res: dict[str, Any] = {"resourceType": "Observation", "id": f"lab-{o['id']}-{i}", "status": status,
                               "category": _cat("laboratory", "Laboratory"), "code": code,
                               "subject": {"reference": f"Patient/{o['patient_id']}"},
                               "effectiveDateTime": _iso(o.get("collected_at") or o.get("ordered_at")),
                               "issued": _iso(o.get("verified_at") or o.get("resulted_at"))}
        if o.get("encounter_id"):
            res["encounter"] = {"reference": f"Encounter/{o['encounter_id']}"}
        num = _num(v.get("value"))
        if num is not None:
            res["valueQuantity"] = {"value": num, "unit": v.get("unit") or "", **({"system": UCUM, "code": v["unit"]} if v.get("unit") else {})}
        else:
            res["valueString"] = str(v.get("value") or "")
        rr = _ref_range(v.get("ref_range"))
        if rr:
            res["referenceRange"] = rr
        if v.get("flag") in INTERP:
            c, d = INTERP[v["flag"]]
            res["interpretation"] = [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", "code": c, "display": d}]}]
        out.append(res)
    return out


async def _fhir_patient(ctx, pid: str) -> dict:
    if not is_uuid(pid):
        raise FhirError(404, "not-found", f"Patient/{pid} is not known")
    row = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid, patients.c.deleted_at.is_(None)))).first()
    if not row:
        raise FhirError(404, "not-found", f"Patient/{pid} is not known")
    return rs.to_record(row)


async def _fhir_subject(ctx, patient: str | None) -> dict:
    if not patient:
        raise FhirError(400, "required", "The 'patient' search parameter is required")
    return await _fhir_patient(ctx, patient.removeprefix("Patient/"))


async def _fhir_log(ctx, what: str, patient_id: str | None, n: int, query: str) -> None:
    await audit(ctx, "fhir.read", module="connectors", entity="messages", record={"patient_id": patient_id}, note=f"{what} {query}")
    await log_message(ctx, "fhir", message_type=f"FHIR {what}", direction="Outbound", status="Sent", ack_code="HTTP 2xx",
                      payload=f"{what} {query} → {n} resource(s)", patient_id=patient_id)


def _fhir_guard(ctx, fqn: str) -> None:
    try:
        rs.ensure_access(ctx, E(fqn), "read")
    except ApiError as e:
        raise FhirError(403, "forbidden", e.detail["message"]) from e


async def _fhir_run(fn):
    try:
        return _fhir(await fn())
    except FhirError as e:
        return _outcome(e.status, e.code, e.msg)


@fhir.get("/metadata")
async def capability(request: Request, ctx: CtxDep):
    def res(t: str, search: list[tuple[str, str, str]], read: bool = True) -> dict:
        r = {"type": t, "interaction": ([{"code": "read"}] if read else []) + [{"code": "search-type"}],
             "searchParam": [{"name": n, "type": ty, "documentation": doc} for n, ty, doc in search]}
        return r
    return _fhir({
        "resourceType": "CapabilityStatement", "id": "vlack-hrms", "status": "active", "date": today().isoformat(), "kind": "instance",
        "publisher": settings.hospital_name, "fhirVersion": "4.0.1", "format": ["json"],
        "software": {"name": "Vlack HRMS", "version": "0.1.0"},
        "implementation": {"description": f"{settings.hospital_name} — read-only FHIR R4 API", "url": _base(request)},
        "rest": [{"mode": "server", "security": {"description": "Bearer token of an authenticated staff user; every read is audited."},
                  "resource": [
                      res("Patient", [("identifier", "token", f"UHID ({UHID_SYSTEM}) or ABHA number ({ABHA_SYSTEM})")]),
                      res("Encounter", [("patient", "reference", "Patient id")], read=False),
                      res("Observation", [("patient", "reference", "Patient id"), ("category", "token", "vital-signs | laboratory")], read=False),
                      res("DiagnosticReport", [("patient", "reference", "Patient id"), ("category", "token", "LAB | RAD")], read=False),
                      res("MedicationRequest", [("patient", "reference", "Patient id")], read=False),
                  ]}],
    })


@fhir.get("/Patient/{pid}")
async def fhir_patient_read(pid: str, ctx: CtxDep):
    async def run():
        _fhir_guard(ctx, "registration.patients")
        p = await _fhir_patient(ctx, pid)
        await _fhir_log(ctx, "Patient read", p["id"], 1, pid)
        return patient_resource(p)
    return await _fhir_run(run)


@fhir.get("/Patient")
async def fhir_patient_search(request: Request, ctx: CtxDep, identifier: str | None = None):
    async def run():
        _fhir_guard(ctx, "registration.patients")
        if not identifier:
            raise FhirError(400, "required", "Search by identifier, e.g. identifier=https://vlack.health/uhid|UH00000001")
        system, _, value = identifier.rpartition("|")
        value = value.strip()
        digits = re.sub(r"\D", "", value)
        t = patients
        if system == ABHA_SYSTEM or (not system and len(digits) == 14 and not value.upper().startswith("UH")):
            cond = t.c.abha_id == digits
        elif system in ("", UHID_SYSTEM):
            cond = sa.func.upper(t.c.code) == value.upper()
        else:
            raise FhirError(400, "not-supported", f"Identifier system {system} is not supported")
        rows = (await ctx.conn.execute(sa.select(t).where(cond, t.c.deleted_at.is_(None)).limit(20))).all()
        recs = [rs.to_record(r) for r in rows]
        await _fhir_log(ctx, "Patient search", recs[0]["id"] if len(recs) == 1 else None, len(recs), f"identifier={identifier}")
        return _bundle(request, [patient_resource(p) for p in recs])
    return await _fhir_run(run)


@fhir.get("/Encounter")
async def fhir_encounters(request: Request, ctx: CtxDep, patient: str | None = None):
    async def run():
        _fhir_guard(ctx, "ipd.encounters")
        p = await _fhir_subject(ctx, patient)
        w, d = records.alias("w"), records.alias("d")
        rows = (await ctx.conn.execute(
            sa.select(encounters, beds.c.bed_no, w.c.title.label("ward"), d.c.title.label("department"), employees.c.name.label("doctor"))
            .select_from(encounters.outerjoin(beds, beds.c.id == encounters.c.bed_id).outerjoin(w, w.c.id == beds.c.ward_id)
                         .outerjoin(d, d.c.id == encounters.c.department_id).outerjoin(employees, employees.c.id == encounters.c.doctor_id))
            .where(encounters.c.patient_id == p["id"], encounters.c.deleted_at.is_(None))
            .order_by(encounters.c.started_at.desc().nulls_last()).limit(100))).all()
        res = [encounter_resource(rs.to_record(r), p.get("title")) for r in rows]
        await _fhir_log(ctx, "Encounter search", p["id"], len(res), f"patient={p['id']}")
        return _bundle(request, res)
    return await _fhir_run(run)


async def _orders_for(ctx, pid: str, cats: list[str]) -> list[dict]:
    rows = (await ctx.conn.execute(
        sa.select(orders, services.c.title.label("service_name"), services.c.code.label("service_code"))
        .select_from(orders.outerjoin(services, services.c.id == orders.c.service_id))
        .where(orders.c.patient_id == pid, orders.c.deleted_at.is_(None), orders.c.category.in_(cats),
               orders.c.status.in_(["Resulted", "Verified"])).order_by(orders.c.resulted_at.desc().nulls_last()).limit(200))).all()
    return [rs.to_record(r) for r in rows]


@fhir.get("/Observation")
async def fhir_observations(request: Request, ctx: CtxDep, patient: str | None = None, category: str | None = None):
    async def run():
        p = await _fhir_subject(ctx, patient)
        cat = (category or "").rpartition("|")[2] or None
        if cat not in (None, "vital-signs", "laboratory"):
            raise FhirError(400, "not-supported", "category must be vital-signs or laboratory")
        res: list[dict] = []
        if cat in (None, "vital-signs"):
            _fhir_guard(ctx, "emr.vitals")
            ent = E("emr.vitals")
            rows = (await ctx.conn.execute(sa.select(records).where(*rs.base_where(ent), records.c.patient_id == p["id"])
                                           .order_by(records.c.data["recorded_at"].astext.desc()).limit(200))).all()
            for r in rows:
                res += vitals_observations(rs.to_record(r))
        if cat in (None, "laboratory"):
            _fhir_guard(ctx, "orders.orders")
            overrides = await _loinc_overrides(ctx)
            for o in await _orders_for(ctx, p["id"], ["LAB"]):
                res += lab_observations(o, overrides)
        await _fhir_log(ctx, "Observation search", p["id"], len(res), f"patient={p['id']}&category={cat or 'all'}")
        return _bundle(request, res)
    return await _fhir_run(run)


@fhir.get("/DiagnosticReport")
async def fhir_reports(request: Request, ctx: CtxDep, patient: str | None = None, category: str | None = None):
    async def run():
        _fhir_guard(ctx, "orders.orders")
        p = await _fhir_subject(ctx, patient)
        cat = ((category or "").rpartition("|")[2] or "").upper()
        cats = [cat] if cat in ("LAB", "RAD") else ["LAB", "RAD"]
        res = []
        for o in await _orders_for(ctx, p["id"], cats):
            lab = o.get("category") == "LAB"
            r: dict[str, Any] = {
                "resourceType": "DiagnosticReport", "id": o["id"], "identifier": [{"system": "https://vlack.health/order", "value": o.get("code")}],
                "status": "final" if o.get("status") == "Verified" else "preliminary",
                "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0074", "code": "LAB" if lab else "RAD",
                                          "display": "Laboratory" if lab else "Radiology"}]}],
                "code": {"text": o.get("service_name") or "Investigation",
                         **({"coding": [{"system": "https://vlack.health/service", "code": o["service_code"], "display": o.get("service_name")}]}
                            if o.get("service_code") else {})},
                "subject": {"reference": f"Patient/{p['id']}"}, "effectiveDateTime": _iso(o.get("collected_at") or o.get("ordered_at")),
                "issued": _iso(o.get("verified_at") or o.get("resulted_at")),
            }
            if o.get("encounter_id"):
                r["encounter"] = {"reference": f"Encounter/{o['encounter_id']}"}
            if lab and o.get("result_values"):
                r["result"] = [{"reference": f"Observation/lab-{o['id']}-{i}"} for i in range(len(o["result_values"]))]
            if o.get("impression") or o.get("result"):
                r["conclusion"] = o.get("impression") or o.get("result")
            res.append(r)
        await _fhir_log(ctx, "DiagnosticReport search", p["id"], len(res), f"patient={p['id']}")
        return _bundle(request, res)
    return await _fhir_run(run)


@fhir.get("/MedicationRequest")
async def fhir_medications(request: Request, ctx: CtxDep, patient: str | None = None):
    async def run():
        _fhir_guard(ctx, "opd.prescriptions")
        p = await _fhir_subject(ctx, patient)
        ent = E("opd.prescriptions")
        rows = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(records).where(*rs.base_where(ent), records.c.patient_id == p["id"])
                                                                 .order_by(records.c.created_at.desc()).limit(100))).all()]
        refs = await rs.resolve_refs(ctx, ent, rows)
        doc_ids = {r.get("doctor") for r in rows if r.get("doctor")}
        docs = {str(i): n for i, n in (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name).where(
            employees.c.id.in_([d for d in doc_ids if is_uuid(d)])))).all()} if doc_ids else {}
        status = {"Active": "active", "Partially Dispensed": "active", "Dispensed": "completed", "Cancelled": "cancelled"}
        res = []
        for rx in rows:
            for i, it in enumerate(rx.get("items") or []):
                dose = " ".join(str(x) for x in (it.get("dose"), it.get("route"), it.get("frequency")) if x)
                if it.get("duration_days"):
                    dose += f" for {it['duration_days']} days"
                m: dict[str, Any] = {
                    "resourceType": "MedicationRequest", "id": f"{rx['id']}-{i}",
                    "identifier": [{"system": "https://vlack.health/prescription", "value": f"{rx.get('code')}/{i + 1}"}],
                    "status": status.get(rx.get("status") or "", "unknown"), "intent": "order",
                    "medicationCodeableConcept": {"text": refs.get(it.get("drug"), "Medicine")},
                    "subject": {"reference": f"Patient/{p['id']}"}, "authoredOn": _iso(rx.get("prescribed_at") or rx.get("created_at")),
                    "dosageInstruction": [{"text": dose + (f". {it['instructions']}" if it.get("instructions") else ""),
                                           **({"route": {"text": it["route"]}} if it.get("route") else {}),
                                           **({"timing": {"code": {"text": it["frequency"]}}} if it.get("frequency") else {})}],
                }
                if rx.get("encounter_id"):
                    m["encounter"] = {"reference": f"Encounter/{rx['encounter_id']}"}
                if docs.get(str(rx.get("doctor"))):
                    m["requester"] = {"display": docs[str(rx.get("doctor"))]}
                disp: dict[str, Any] = {}
                if it.get("qty"):
                    disp["quantity"] = {"value": _num(it["qty"])}
                if it.get("duration_days"):
                    disp["expectedSupplyDuration"] = {"value": _num(it["duration_days"]), "unit": "days", "system": UCUM, "code": "d"}
                if disp:
                    m["dispenseRequest"] = disp
                res.append(m)
        await _fhir_log(ctx, "MedicationRequest search", p["id"], len(res), f"patient={p['id']}")
        return _bundle(request, res)
    return await _fhir_run(run)


# ====================================================================== HL7 v2

HL7_ESC = [("\\", "\\E\\"), ("|", "\\F\\"), ("^", "\\S\\"), ("&", "\\T\\"), ("~", "\\R\\")]


def h(v: Any) -> str:
    s = "" if v is None else str(v)
    for a, b in HL7_ESC:
        s = s.replace(a, b)
    return s.replace("\r", " ").replace("\n", " ")


def hl7_ts(v: Any = None) -> str:
    d = parse_dt(v) if v else now()
    return d.astimezone(settings.tz).strftime("%Y%m%d%H%M%S%z") if d else ""


def parse_hl7_ts(v: str | None) -> datetime | None:
    m = re.match(r"^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?([+-]\d{4})?$", (v or "").strip())
    if not m:
        return None
    y, mo, d, hh, mi, ss, tz = m.groups()
    dt = datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), int(ss or 0))
    if tz:
        from datetime import timezone

        sign = 1 if tz[0] == "+" else -1
        dt = dt.replace(tzinfo=timezone(sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5]))))
    else:
        dt = dt.replace(tzinfo=settings.tz)
    return dt


class Hl7Message:
    def __init__(self, text: str):
        segs = [s for s in re.split(r"\r\n|\r|\n", text.strip()) if s.strip()]
        if not segs or not segs[0].startswith("MSH") or len(segs[0]) < 8:
            raise ValueError("Message must start with an MSH segment")
        self.fs = segs[0][3]
        enc = segs[0][4:8]
        self.cs, self.rs = enc[0], enc[1]
        self.segments = [s.split(self.fs) for s in segs]

    def msh(self, n: int) -> str:
        parts = self.segments[0]
        return parts[n - 1] if n >= 2 and len(parts) > n - 1 else ""

    @staticmethod
    def f(seg: list[str], n: int) -> str:
        return seg[n] if len(seg) > n else ""

    def comp(self, value: str, n: int = 1) -> str:
        first = value.split(self.rs)[0]
        parts = first.split(self.cs)
        return parts[n - 1] if len(parts) >= n else ""

    def of(self, name: str) -> list[list[str]]:
        return [s for s in self.segments if s[0] == name]


HL7_ERRORS = {"100": "Segment sequence error", "101": "Required field missing", "200": "Unsupported message type",
              "204": "Unknown key identifier", "207": "Application internal error"}


def build_ack(msg: Hl7Message | None, code: str, text: str, errors: list[tuple[str, str]] | None = None) -> str:
    ctrl = msg.msh(10) if msg else ""
    trig = msg.comp(msg.msh(9), 2) if msg else ""
    lines = ["|".join(["MSH", "^~\\&", "VLACK-HIS", h(settings.hospital_name[:40]), msg.msh(3) if msg else "", msg.msh(4) if msg else "",
                       hl7_ts(), "", f"ACK^{trig}^ACK" if trig else "ACK", f"ACK{now():%Y%m%d%H%M%S%f}"[:20], "P", "2.5.1"]),
             f"MSA|{code}|{h(ctrl)}|{h(text[:80])}"]
    for err_code, err_text in errors or []:  # ERR-3 HL7 error code (table 0357), ERR-4 severity, ERR-8 user message
        lines.append(f"ERR|||{err_code}^{HL7_ERRORS.get(err_code, 'Application error')}^HL70357|E||||{h(err_text[:200])}")
    return "\r".join(lines) + "\r"


FLAG_MAP = {"H": "High", "L": "Low", "HH": "Critical High", "LL": "Critical Low", "N": "Normal", "A": "Abnormal", "AA": "Abnormal",
            ">": "High", "<": "Low"}


def flag_from_params(value: str, param: dict | None, obx_flag: str) -> tuple[str | None, str | None]:
    """Flag a result using the test master's reference / critical limits; fall back to the analyser flag."""
    num = _num(value)
    if num is not None and param:
        lo, hi, clo, chi = (param.get(k) for k in ("ref_low", "ref_high", "critical_low", "critical_high"))
        rr = f"{lo}–{hi}" if lo is not None and hi is not None else None
        if clo is not None and num <= float(clo):
            return "Critical Low", rr
        if chi is not None and num >= float(chi):
            return "Critical High", rr
        if lo is not None and num < float(lo):
            return "Low", rr
        if hi is not None and num > float(hi):
            return "High", rr
        if lo is not None or hi is not None:
            return "Normal", rr
    return FLAG_MAP.get(obx_flag.strip().upper()) if obx_flag else None, None


async def _find_order(ctx, placer: str, filler: str) -> dict | None:
    o = orders
    for cond in ([sa.func.upper(o.c.code) == placer.upper()] if placer else []) + \
                ([o.c.data["sample_barcode"].astext == filler] if filler else []):
        row = (await ctx.conn.execute(sa.select(o, services.c.title.label("service_name"), services.c.code.label("service_code"),
                                                services.c.data["parameters"].label("parameters"))
                                      .select_from(o.outerjoin(services, services.c.id == o.c.service_id))
                                      .where(cond, o.c.deleted_at.is_(None)).limit(1))).first()
        if row:
            return rs.to_record(row)
    return None


async def apply_oru_group(ctx, msg: Hl7Message, pid_value: str, obr: list[str], obxs: list[list[str]], notes: list[str]) -> dict:
    placer = msg.comp(msg.f(obr, 2)) or ""
    filler = msg.comp(msg.f(obr, 3)) or ""
    order = await _find_order(ctx, placer, filler)
    if not order:
        raise ApiError(404, f"Order {placer or filler or '?'} not found")
    if order.get("category") not in ("LAB", "RAD"):
        raise ApiError(409, f"Order {order['code']} is not a lab or radiology order")
    if pid_value:
        pcode = (await ctx.conn.execute(sa.select(patients.c.code).where(patients.c.id == order["patient_id"]))).scalar_one_or_none()
        if pcode and pcode.upper() != pid_value.upper():
            raise ApiError(409, f"Patient {pid_value} does not match order {order['code']} (UHID {pcode})")
    if order["status"] == "Cancelled":
        raise ApiError(409, f"Order {order['code']} is cancelled")
    if order["status"] == "Verified":
        raise ApiError(409, f"Order {order['code']} is already verified; send corrections through the LIS amendment workflow")
    params = {str(p.get("parameter", "")).strip().lower(): p for p in (order.get("parameters") or [])}
    values, critical = [], False
    for obx in obxs:
        ident = msg.f(obx, 3)
        name = msg.comp(ident, 2) or msg.comp(ident, 1) or "Result"
        code = msg.comp(ident, 1)
        value = msg.f(obx, 5).replace(msg.rs, "; ")
        if msg.f(obx, 2) in ("CE", "CWE"):
            value = msg.comp(value, 2) or msg.comp(value, 1)
        param = params.get(name.strip().lower()) or params.get(code.strip().lower())
        flag, rr = flag_from_params(value, param, msg.f(obx, 8))
        unit = msg.comp(msg.f(obx, 6), 1) or (param or {}).get("unit") or ""
        critical = critical or (flag or "").startswith("Critical")
        values.append({"parameter": (param or {}).get("parameter") or name, "value": value, "unit": unit,
                       "ref_range": rr or msg.f(obx, 7) or None, "flag": flag})
    if not values and not notes:
        raise ApiError(400, f"No OBX results for order {order['code']}")
    t = order
    if t["status"] == "Ordered":
        t = await transition(ctx, "orders.orders", t["id"], "Collected", note="HL7 ORU: specimen received by analyser")
    if t["status"] in ("Ordered", "Collected"):
        t = await transition(ctx, "orders.orders", t["id"], "In Progress", note="HL7 ORU")
    upd: dict[str, Any] = {"result_values": values, "critical": critical}
    collected = parse_hl7_ts(msg.f(obr, 7))
    if collected:
        upd["collected_at"] = collected.isoformat()
    if filler:
        upd["analyser_sample_id"] = filler
        if not t.get("sample_barcode"):
            upd["sample_barcode"] = filler
    if notes:
        upd["result"] = "\n".join(notes)[:20000]
    if t["status"] == "Resulted":
        # preliminary → final from the analyser: no transition, so raise the critical alert here if it is new
        was_critical = bool(t.get("critical"))
        rec = await update(ctx, "orders.orders", t["id"], upd)
        if critical and not was_critical:
            pname = (await ctx.conn.execute(sa.select(patients.c.title).where(patients.c.id == order["patient_id"]))).scalar_one_or_none()
            live(ctx, "alerts", {"type": "critical_result", "patient": pname, "test": order.get("service_name"), "order_id": rec["id"],
                                 "patient_id": rec["patient_id"]})
            await emit("order.critical", ctx, {"order": rec, "test": order.get("service_name"), "source": "hl7"})
    else:
        await update(ctx, "orders.orders", t["id"], upd)
        # the orders engine re-flags against the test master and raises the critical-result alert on this transition
        rec = await transition(ctx, "orders.orders", t["id"], "Resulted", note=f"HL7 ORU^R01 {msg.msh(10)} from {msg.msh(3)}")
    return {"order": rec["code"], "order_id": rec["id"], "patient_id": order["patient_id"], "values": len(values),
            "critical": bool(rec.get("critical")), "status": rec["status"]}


@hl7.post("/oru")
async def hl7_oru(request: Request, ctx: CtxDep):
    require_role(ctx, "lab", "radiology")
    raw = await request.body()
    if len(raw) > 1_000_000:
        raise bad_request("HL7 message is larger than 1 MB")
    text = raw.decode("utf-8", errors="replace")
    try:
        msg = Hl7Message(text)
    except ValueError as e:
        ack = build_ack(None, "AR", str(e), [("100", str(e))])
        await log_message(ctx, "hl7_in", message_type="Unparseable", direction="Inbound", status="Failed", payload=text, response=ack,
                          ack_code="AR", error=str(e))
        return PlainTextResponse(ack, media_type="application/hl7-v2")
    mtype = "^".join(x for x in (msg.comp(msg.msh(9), 1), msg.comp(msg.msh(9), 2)) if x)
    ctrl = msg.msh(10)
    if mtype != "ORU^R01":
        err = f"Unsupported message type {mtype or '?'}; this endpoint accepts ORU^R01"
        ack = build_ack(msg, "AR", err, [("200", err)])
        await log_message(ctx, "hl7_in", message_type=mtype or "?", direction="Inbound", status="Failed", payload=text, response=ack,
                          control_id=ctrl, ack_code="AR", error=err)
        return PlainTextResponse(ack, media_type="application/hl7-v2")
    pid_seg = (msg.of("PID") or [[]])[0]
    pid_value = msg.comp(msg.f(pid_seg, 3)) if pid_seg else ""
    # group OBX / NTE under their OBR
    groups: list[tuple[list[str], list[list[str]], list[str]]] = []
    for seg in msg.segments[1:]:
        if seg[0] == "OBR":
            groups.append((seg, [], []))
        elif seg[0] == "OBX" and groups:
            groups[-1][1].append(seg)
        elif seg[0] == "NTE" and groups:
            groups[-1][2].append(msg.f(seg, 3))
    if not groups:
        err = "Message has no OBR segment"
        ack = build_ack(msg, "AE", err, [("101", err)])
        await log_message(ctx, "hl7_in", message_type=mtype, direction="Inbound", status="Failed", payload=text, response=ack,
                          control_id=ctrl, ack_code="AE", error=err)
        return PlainTextResponse(ack, media_type="application/hl7-v2")
    done, errors = [], []
    for obr, obxs, notes in groups:
        try:
            async with ctx.conn.begin_nested():  # one bad order must not undo the others
                done.append(await apply_oru_group(ctx, msg, pid_value, obr, obxs, notes))
        except ApiError as e:
            errors.append(("204" if e.status_code == 404 else "207", e.detail["message"]))
    code = "AA" if not errors else "AE"
    text_ack = (f"{len(done)} order(s) resulted" + (f"; {len(errors)} rejected" if errors else "")) if done else errors[0][1]
    ack = build_ack(msg, code, text_ack, errors)
    patient_id = done[0]["patient_id"] if done else None
    await log_message(ctx, "hl7_in", message_type=mtype, direction="Inbound", status="Processed" if not errors else ("Failed" if not done else "Processed"),
                      payload=text, response=ack, control_id=ctrl, ack_code=code, patient_id=patient_id,
                      correlation_id=", ".join(f"orders.orders:{d['order_id']}" for d in done)[:500] or None,
                      error="; ".join(e for _, e in errors) or None)
    return PlainTextResponse(ack, media_type="application/hl7-v2")


# ---------------------------------------------------------------------- outbound ADT

async def _adt_context(ctx, eid: str) -> tuple[dict, dict] | None:
    w, d = records.alias("w"), records.alias("d")
    row = (await ctx.conn.execute(
        sa.select(encounters, beds.c.bed_no, beds.c.data["room_no"].astext.label("room_no"), w.c.title.label("ward"), w.c.code.label("ward_code"),
                  d.c.title.label("department"), employees.c.name.label("doctor"), employees.c.code.label("doctor_code"))
        .select_from(encounters.outerjoin(beds, beds.c.id == encounters.c.bed_id).outerjoin(w, w.c.id == beds.c.ward_id)
                     .outerjoin(d, d.c.id == encounters.c.department_id).outerjoin(employees, employees.c.id == encounters.c.doctor_id))
        .where(encounters.c.id == eid))).first()
    if not row:
        return None
    e = rs.to_record(row)
    p = rs.to_record((await ctx.conn.execute(sa.select(patients).where(patients.c.id == e["patient_id"]))).first())
    return e, p


def build_adt(event: str, e: dict, p: dict) -> str:
    sex = {"Male": "M", "Female": "F", "Other": "O"}.get(p.get("gender"), "U")
    pid3 = f"{h(p.get('code'))}^^^VLACK^MR" + (f"~{h(p['abha_id'])}^^^ABDM^NH" if p.get("abha_id") else "")
    dob = (parse_date(p.get("dob")).strftime("%Y%m%d") if p.get("dob") else "")
    addr = "^".join([h(p.get("address")), "", h(p.get("city")), h(p.get("state")), h(p.get("pincode")), "IND"])
    pclass = {"IPD": "I", "ER": "E", "DAYCARE": "I", "OPD": "O"}.get(e.get("type") or "", "I")
    loc = "^".join([h(e.get("ward_code") or e.get("ward")), h(e.get("room_no")), h(e.get("bed_no")), "VLACK"])
    doctor = f"{h(e.get('doctor_code'))}^{h(e.get('doctor'))}" if e.get("doctor") else ""
    # positions follow HL7 2.5.1: PV1-19 visit number, PV1-36 discharge disposition, PV1-44/45 admit / discharge time
    pv1 = ["PV1", "1", pclass, loc, h(e.get("admission_type")), "", "", doctor, "", "", h(e.get("department")), "", "", "", h(e.get("admission_source")),
           "", "", "", "", h(e.get("code"))] + [""] * 16 + [h(e.get("discharge_type")) if event == "A03" else ""] + [""] * 7 + \
          [hl7_ts(e.get("started_at")), hl7_ts(e.get("ended_at")) if event == "A03" and e.get("ended_at") else ""]
    segs = [
        "|".join(["MSH", "^~\\&", "VLACK-HIS", h(settings.hospital_name[:40]), "", "", hl7_ts(), "", f"ADT^{event}^ADT_{event}",
                  f"ADT{now():%Y%m%d%H%M%S%f}"[:20], "P", "2.5.1"]),
        f"EVN|{event}|{hl7_ts()}",
        "|".join(["PID", "1", "", pid3, "", f"{h(p.get('last_name'))}^{h(p.get('first_name'))}^^^{h(p.get('salutation'))}", "", dob, sex,
                  "", "", addr, "", h(p.get("phone"))]),
        "|".join(pv1),
    ]
    if e.get("diagnosis"):
        segs.append(f"DG1|1||^{h(e['diagnosis'])}|||A")
    return "\r".join(segs) + "\r"


async def send_adt(ctx, event: str, eid: str) -> None:
    """Generate and log ADT^A01 / ADT^A03. Failures are logged, never block the clinical workflow."""
    try:
        async with ctx.conn.begin_nested():
            corr = f"ipd.admissions:{eid}"
            if event == "A03":
                ent = get_entity("connectors.messages")
                if ent:
                    dup = (await ctx.conn.execute(sa.select(records.c.id).where(
                        *rs.base_where(ent), records.c.data["correlation_id"].astext == corr,
                        records.c.data["message_type"].astext == "ADT^A03").limit(1))).first()
                    if dup:
                        return
            got = await _adt_context(ctx, eid)
            if not got:
                return
            e, p = got
            payload = build_adt(event, e, p)
            await log_message(ctx, "hl7_out", message_type=f"ADT^{event}", direction="Outbound", status="Sent", payload=payload,
                              response="Log mode: message generated and recorded; no live MLLP transport configured",
                              control_id=payload.split("|")[9], correlation_id=corr, patient_id=str(e["patient_id"]))
    except Exception:
        log.exception("ADT^%s generation failed for encounter %s", event, eid)


@hook("ipd.admissions", "after_create")
async def _adt_admit(ctx, rec: dict):
    await send_adt(ctx, "A01", rec["id"])


@hook("ipd.admissions", "after_transition")
@hook("ipd.admissions", "after_update")
async def _adt_discharge_status(ctx, rec: dict, prev: dict):
    if rec.get("status") == "Discharged" and prev.get("status") != "Discharged":
        await send_adt(ctx, "A03", rec["id"])


@listen("discharge.done")
async def _adt_discharge_event(ctx, payload: dict):
    enc = payload.get("encounter") or payload.get("admission") or {}
    eid = enc.get("id") if isinstance(enc, dict) else None
    eid = eid or payload.get("encounter_id") or (payload.get("summary") or {}).get("encounter_id")
    if eid:
        await send_adt(ctx, "A03", str(eid))


# ====================================================================== ABDM

class AbhaIn(BaseModel):
    patient_id: str
    abha_number: str = Field(min_length=14, max_length=20)


def abha_checksum_ok(digits: str) -> bool:
    """ABHA numbers carry no publicly documented check digit (unlike Aadhaar's Verhoeff); authenticity
    is established by the ABDM gateway. Locally we only reject numbers that cannot be real."""
    return len(set(digits)) > 2 and digits not in "01234567890123456789" and digits not in "98765432109876543210"


@abdm.post("/abha/verify")
async def abha_verify(body: AbhaIn, ctx: CtxDep):
    """Sandbox verification of an ABHA number.

    Plugging the real ABDM sandbox in behind this function (same request / response):
      1. POST {gateway}/v0.5/sessions {clientId, clientSecret} → accessToken (cache until expiry; secrets from the vault,
         never from connectors.config).
      2. Search / verify: POST {abha_base}/v1/search/searchByHealthId {healthId} (or the v3 ABHA profile APIs) with
         headers Authorization: Bearer <token>, X-CM-ID: sbx; confirm name / gender / year of birth against the patient.
      3. Optional demographic / OTP auth (v1/auth/init → confirmWithMobileOTP) before linking care contexts.
    Use httpx.AsyncClient with a 10 s timeout; log request + response through log_message() exactly as below.
    """
    rs.ensure_access(ctx, E("registration.patients"), "write")
    digits = re.sub(r"\D", "", body.abha_number)
    if len(digits) != 14:
        raise bad_request("An ABHA number has 14 digits (XX-XXXX-XXXX-XXXX)")
    if not abha_checksum_ok(digits):
        raise bad_request("This ABHA number is not valid")
    p = await get(ctx, "registration.patients", body.patient_id)
    if not p:
        raise not_found("Patient not found")
    other = (await ctx.conn.execute(sa.select(patients.c.code).where(patients.c.abha_id == digits, patients.c.id != body.patient_id,
                                                                      patients.c.deleted_at.is_(None), patients.c.status != "Merged"))).first()
    if other:
        raise conflict(f"ABHA {_abha_fmt(digits)} is already linked to UHID {other.code}")
    cx = await connector(ctx, "abdm")
    mode = "sandbox" if not cx or cx.get("environment") != "Production" else "production"
    ts = now().isoformat(timespec="seconds")
    req = {"healthIdNumber": f"XX-XXXX-XXXX-{digits[-4:]}", "purpose": "KYC_AND_LINK", "requestId": new_id(), "timestamp": ts}
    resp = {"status": "VERIFIED", "mode": mode, "message": "Sandbox: format validated; gateway verification simulated"}
    rec = await update(ctx, "registration.patients", body.patient_id, {
        "abha_id": digits, "abha_verified": True, "abha_verified_at": ts, "abha_verification_mode": mode.title(),
        "abha_number": _abha_fmt(digits)})
    await log_message(ctx, "abdm", message_type="ABHA verify", direction="Outbound", status="Sent", ack_code="HTTP 2xx",
                      payload=json.dumps(req), response=json.dumps(resp), control_id=req["requestId"],
                      correlation_id=f"registration.patients:{body.patient_id}", patient_id=body.patient_id)
    await audit(ctx, "abha.verify", module="registration", entity="patients", record=rec, after={"abha": f"…{digits[-4:]}", "mode": mode})
    return {"verified": True, "mode": mode, "abha_number": _abha_fmt(digits), "patient": {"id": rec["id"], "code": rec["code"], "title": rec["title"]}}


# ====================================================================== TPA claims

async def _rows(ctx, table, *conds, order=None, limit=500) -> list[dict]:
    stmt = sa.select(table).where(table.c.deleted_at.is_(None), *conds)
    if order is not None:
        stmt = stmt.order_by(order)
    return [rs.to_record(r) for r in (await ctx.conn.execute(stmt.limit(limit))).all()]


async def claim_packet(ctx, claim: dict) -> tuple[dict, list[str]]:
    warnings: list[str] = []
    pid = claim["patient_id"]
    p = rs.to_record((await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid))).first())
    payer = await get(ctx, "insurance.payers", claim.get("payer")) if claim.get("payer") else None
    pre = await get(ctx, "insurance.preauths", claim.get("preauth")) if claim.get("preauth") else None
    elig = [e for e in await find(ctx, "insurance.eligibility", patient_id=pid, limit=20, sort="-created_at")
            if not claim.get("payer") or e.get("payer") == claim.get("payer")]
    pol = elig[0] if elig else None
    enc = None
    if claim.get("encounter_id"):
        got = await _adt_context(ctx, claim["encounter_id"])
        enc = got[0] if got else None
    inv = await get(ctx, "billing.invoices", claim.get("invoice")) if claim.get("invoice") else None
    if inv:
        lines = await _rows(ctx, charges, charges.c.invoice_id == inv["id"], order=charges.c.charged_at)
    elif claim.get("encounter_id"):
        lines = await _rows(ctx, charges, charges.c.encounter_id == claim["encounter_id"], charges.c.status != "Cancelled", order=charges.c.charged_at)
        warnings.append("No final bill linked — charges of the encounter are attached instead")
    else:
        lines = []
    svc = {str(r.id): r.code for r in (await ctx.conn.execute(sa.select(services.c.id, services.c.code).where(
        services.c.id.in_([c["service_id"] for c in lines if c.get("service_id")])))).all()} if lines else {}
    summ = (await find(ctx, "discharge.summaries", encounter_id=claim["encounter_id"], limit=1)) if claim.get("encounter_id") else []
    docs = []
    for label, fid in (("Claim documents", claim.get("claim_documents")), ("Pre-auth form", (pre or {}).get("preauth_form")),
                       ("Pre-auth approval letter", (pre or {}).get("approval_letter")), ("Policy card", (pol or {}).get("card_copy"))):
        if fid:
            docs.append({"type": label, "file_id": fid})
    for f in (await ctx.conn.execute(sa.select(files.c.id, files.c.name, files.c.mime).where(
            files.c.patient_id == pid, files.c.deleted_at.is_(None)).order_by(files.c.created_at.desc()).limit(20))).all():
        if str(f.id) not in {d["file_id"] for d in docs}:
            docs.append({"type": "Patient file", "file_id": str(f.id), "name": f.name, "mime": f.mime})
    if summ:
        docs.append({"type": "Discharge summary", "record": summ[0]["code"], "status": summ[0]["status"]})
        if summ[0].get("status") not in ("Approved", "Issued"):
            warnings.append(f"Discharge summary {summ[0]['code']} is {summ[0]['status']} (insurers expect the approved summary)")
    elif claim.get("encounter_id"):
        warnings.append("No discharge summary for this encounter")
    if claim.get("claim_type") == "Cashless" and not pre:
        warnings.append("Cashless claim without a linked pre-authorisation")
    if not pol:
        warnings.append("No eligibility / policy record for this payer")
    packet = {
        "claim": {"number": claim.get("claim_no"), "reference": claim.get("code"), "type": claim.get("claim_type"),
                  "claimed_amount": claim.get("claimed_amount"), "currency": "INR"},
        "provider": {"name": settings.hospital_name, "branch": settings.branch_id},
        "patient": {"uhid": p.get("code"), "name": p.get("title"), "gender": p.get("gender"), "dob": p.get("dob"), "age": age_from(p.get("dob")),
                    "abha": _abha_fmt(p.get("abha_id")), "phone": p.get("phone")},
        "payer": payer and {"name": payer.get("name"), "type": payer.get("payer_type"), "scheme": payer.get("scheme"),
                            "irdai_reg_no": payer.get("irdai_reg_no")},
        "policy": pol and {k: pol.get(k) for k in ("policy_no", "member_id", "policy_holder", "relation_to_holder", "corporate_name",
                                                    "policy_valid_from", "policy_valid_to", "sum_insured", "balance_sum_insured", "co_pay_percent")},
        "preauth": pre and {k: pre.get(k) for k in ("code", "payer_ref", "approved_amount", "diagnosis", "icd10", "procedure")},
        "encounter": enc and {"number": enc.get("code"), "type": enc.get("type"), "admitted_at": _iso(enc.get("started_at")),
                              "discharged_at": _iso(enc.get("ended_at")), "department": enc.get("department"), "treating_doctor": enc.get("doctor"),
                              "diagnosis": (summ[0].get("final_diagnosis") if summ else None) or enc.get("diagnosis"),
                              "icd10": (summ[0].get("icd_codes") if summ else None)},
        "bill": {"number": (inv or {}).get("code"), "gross": (inv or {}).get("gross"), "discount": (inv or {}).get("discount"),
                 "net": (inv or {}).get("net") or round(sum(float(c.get("amount") or 0) for c in lines), 2),
                 "lines": [{"date": _iso(c.get("charged_at")), "code": svc.get(str(c.get("service_id"))), "description": c.get("description"),
                            "qty": c.get("qty"), "rate": c.get("rate"), "amount": c.get("amount")} for c in lines]},
        "documents": docs,
    }
    return packet, warnings


@tpa.post("/claims/{claim_id}/submit")
async def submit_claim(claim_id: str, ctx: CtxDep):
    rs.ensure_access(ctx, E("insurance.claims"), "write")
    claim = await get(ctx, "insurance.claims", claim_id)
    if not claim:
        raise not_found("Claim not found")
    if claim.get("status") not in ("Draft", "Query", "Rejected"):
        raise conflict(f"Claim {claim['code']} is {claim.get('status')}; only Draft, Query or Rejected claims can be submitted")
    if not claim.get("payer"):
        raise bad_request("Choose the payer / TPA before submitting")
    if not claim.get("claimed_amount") or float(claim["claimed_amount"]) <= 0:
        raise bad_request("Enter the claimed amount before submitting")
    payer = await get(ctx, "insurance.payers", claim["payer"])
    channel = claim.get("channel") or (payer or {}).get("integration") or "TPA API"
    claim_no = claim.get("claim_no") or f"SBX-{claim['code']}"
    claim = await update(ctx, "insurance.claims", claim_id, {"claim_no": claim_no, "channel": channel})
    packet, warnings = await claim_packet(ctx, claim)
    ack_no = f"SBX-ACK-{now():%Y%m%d%H%M%S}"
    response = {"status": "RECEIVED", "acknowledgementNo": ack_no, "mode": "sandbox",
                "message": "Sandbox adapter: packet validated and logged; not transmitted to the payer"}
    rec = await transition(ctx, "insurance.claims", claim_id, "Submitted", note=f"Submitted via {channel} (sandbox) · {ack_no}",
                           values={"channel": channel} if claim.get("status") == "Draft" else None)
    msg = await log_message(ctx, "tpa", message_type="Claim submission", direction="Outbound", status="Sent", ack_code="HTTP 2xx",
                            payload=json.dumps(packet, default=str, ensure_ascii=False), response=json.dumps(response),
                            control_id=claim_no, correlation_id=f"insurance.claims:{claim_id}", patient_id=claim["patient_id"])
    return {"claim": rec, "packet": packet, "warnings": warnings, "ack": response, "message": msg and msg.get("code")}


# ====================================================================== Tally / ERP export

PARTY = {"Self": "Patient Receivables", "Insurance": "Insurance / TPA Receivables", "Corporate": "Corporate Receivables",
         "Government Scheme": "Government Scheme Receivables"}
INCOME = {"OP": "OP Revenue", "IP": "IP Revenue", "PHARMACY": "Pharmacy Sales", "PACKAGE": "Package Revenue", "DAYCARE": "Day Care Revenue"}
CASH_LEDGER = {"CASH": "Cash", "UPI": "Bank — UPI Collections", "CARD": "Bank — Card Settlements", "BANK": "Bank — NEFT / RTGS",
               "CHEQUE": "Cheques in Hand", "WALLET": "Wallet Settlements", "INSURANCE": "Insurance / TPA Receivables", "DEPOSIT": "Patient Advances (IP Deposits)"}
ADVANCES = "Patient Advances (IP Deposits)"


def _voucher(vtype: str, number: str, d: date, narration: str, entries: list[tuple[str, float]]) -> dict:
    """entries: (ledger, amount) with debit positive / credit negative; must balance."""
    entries = [(lg, round(a, 2)) for lg, a in entries if abs(a) >= 0.005]
    diff = round(sum(a for _, a in entries), 2)
    if abs(diff) >= 0.01:
        raise ValueError(f"Voucher {number} does not balance ({diff})")
    return {"type": vtype, "number": number, "date": d, "narration": narration, "entries": entries}


def voucher_xml(v: dict) -> str:
    rows = "".join(
        f"<ALLLEDGERENTRIES.LIST><LEDGERNAME>{xml_escape(lg)}</LEDGERNAME>"
        f"<ISDEEMEDPOSITIVE>{'Yes' if a > 0 else 'No'}</ISDEEMEDPOSITIVE><AMOUNT>{-a:.2f}</AMOUNT></ALLLEDGERENTRIES.LIST>"
        for lg, a in v["entries"])
    party = v["entries"][0][0]
    return (f'<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="{v["type"]}" ACTION="Create" OBJVIEW="Accounting Voucher View">'
            f"<DATE>{v['date']:%Y%m%d}</DATE><VOUCHERTYPENAME>{v['type']}</VOUCHERTYPENAME><VOUCHERNUMBER>{xml_escape(v['number'])}</VOUCHERNUMBER>"
            f"<PARTYLEDGERNAME>{xml_escape(party)}</PARTYLEDGERNAME><NARRATION>{xml_escape(v['narration'])}</NARRATION>"
            f"<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>{rows}</VOUCHER></TALLYMESSAGE>")


def envelope(vouchers: list[dict]) -> str:
    body = "".join(voucher_xml(v) for v in vouchers)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>'
            f"<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>{xml_escape(settings.hospital_name)}"
            f"</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>{body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n")


async def build_vouchers(ctx, start: date, end: date) -> tuple[list[dict], list[str]]:
    """Sales vouchers for bills, Receipt / Payment / Journal vouchers for money movements. Returns (vouchers, problems)."""
    s, e = metrics._rng(start, end)
    problems: list[str] = []
    loc = lambda v: parse_dt(v).astimezone(settings.tz).date()  # noqa: E731
    out: list[dict] = []
    pmap = {str(r.id): (r.code, r.title) for r in (await ctx.conn.execute(sa.select(patients.c.id, patients.c.code, patients.c.title).where(
        patients.c.id.in_(sa.select(invoices.c.patient_id).where(invoices.c.billed_at >= s, invoices.c.billed_at < e).union(
            sa.select(payments.c.patient_id).where(payments.c.paid_at >= s, payments.c.paid_at < e)))))).all()}
    for inv in await _rows(ctx, invoices, invoices.c.billed_at >= s, invoices.c.billed_at < e, invoices.c.status.notin_(["Cancelled", "Draft"]),
                           order=invoices.c.billed_at, limit=20000):
        gross, disc, tax, net = (float(inv.get(k) or 0) for k in ("gross", "discount", "tax", "net"))
        uhid, name = pmap.get(str(inv["patient_id"]), ("", ""))
        try:
            v = _voucher("Sales", inv["code"], loc(inv["billed_at"]), f"{inv.get('type')} bill {inv['code']} · {uhid} {name}".strip(),
                         [(PARTY.get(inv.get("payer") or "Self", "Patient Receivables"), net), ("Discount Allowed", disc),
                          (INCOME.get(inv.get("type") or "", "Other Operating Revenue"), -gross), ("Output GST", -tax)])
        except ValueError as err:
            problems.append(str(err))
            continue
        out.append({**v, "reference": inv["code"], "patient_id": inv["patient_id"]})
    for p in await _rows(ctx, payments, payments.c.paid_at >= s, payments.c.paid_at < e, payments.c.status == "Success",
                         order=payments.c.paid_at, limit=20000):
        amt = float(p.get("amount") or 0)
        uhid, name = pmap.get(str(p["patient_id"]), ("", ""))
        who = f"{uhid} {name}".strip()
        cash = CASH_LEDGER.get(p.get("mode") or "", "Cash")
        ref = f" · ref {p['reference']}" if p.get("reference") else ""
        if p.get("kind") in ("PAYMENT", "DEPOSIT"):
            credit = ADVANCES if p["kind"] == "DEPOSIT" else "Patient Receivables"
            v = _voucher("Receipt", p["code"], loc(p["paid_at"]), f"{p['kind'].title()} {p.get('mode')} from {who}{ref}", [(cash, amt), (credit, -amt)])
        elif p.get("kind") == "REFUND":
            debit = "Patient Receivables" if p.get("invoice_id") else ADVANCES
            v = _voucher("Payment", p["code"], loc(p["paid_at"]), f"Refund {p.get('mode')} to {who}{ref}", [(debit, amt), (cash, -amt)])
        elif p.get("kind") == "ADJUSTMENT":
            v = _voucher("Journal", p["code"], loc(p["paid_at"]), f"Deposit adjusted against bill for {who}", [(ADVANCES, amt), ("Patient Receivables", -amt)])
        else:
            continue
        out.append({**v, "reference": p["code"], "patient_id": p["patient_id"]})
    return out, problems


@tally.get("/export")
async def tally_export(ctx: CtxDep, date_from: str | None = Query(None, alias="from"), date_to: str | None = Query(None, alias="to"),
                       reexport: bool = False):
    require_role(ctx, "billing", "management")
    rs.ensure_access(ctx, E("finance.gl_postings"), "read")
    try:
        end = parse_date(date_to) or today() - timedelta(days=1)
        start = parse_date(date_from) or end
    except ValueError as e:
        raise bad_request("Dates must be YYYY-MM-DD") from e
    if start > end:
        raise bad_request("'from' must be on or before 'to'")
    if (end - start).days > 30:
        raise bad_request("Export at most 31 days at a time")
    vouchers, problems = await build_vouchers(ctx, start, end)
    ent = E("finance.gl_postings")
    done = {r[0] for r in (await ctx.conn.execute(sa.select(records.c.data["reference"].astext).where(
        *rs.base_where(ent), records.c.status == "Exported",
        records.c.data["reference"].astext.in_([v["reference"] for v in vouchers] or [""])))).all()}
    fresh = [v for v in vouchers if v["reference"] not in done]
    chosen = vouchers if reexport else fresh
    batch = f"TALLY-{now():%Y%m%d-%H%M%S}"
    ts = now().isoformat(timespec="seconds")
    for v in fresh:
        lead_ledger, lead_amt = v["entries"][0]
        await create(ctx, "finance.gl_postings", {
            "voucher_type": v["type"], "voucher_no": v["number"], "voucher_date": v["date"].isoformat(), "ledger": lead_ledger,
            "debit": lead_amt if lead_amt > 0 else None, "credit": -lead_amt if lead_amt < 0 else None, "narration": v["narration"][:900],
            "reference": v["reference"], "posted_at": ts, "exported_at": ts, "export_batch": batch, "status": "Exported",
            "entries": [{"ledger": lg, "debit": a if a > 0 else 0, "credit": -a if a < 0 else 0} for lg, a in v["entries"]],
        })
    xml = envelope(chosen)
    summary = {"from": start.isoformat(), "to": end.isoformat(), "vouchers": len(chosen), "new": len(fresh), "already_exported": len(done),
               "by_type": {t: sum(1 for v in chosen if v["type"] == t) for t in ("Sales", "Receipt", "Payment", "Journal")},
               "skipped": problems[:50]}
    await log_message(ctx, "tally", message_type="Tally XML vouchers", direction="Outbound", status="Sent", control_id=batch,
                      error=f"{len(problems)} unbalanced document(s) skipped: " + "; ".join(problems[:5]) if problems else None,
                      payload=json.dumps(summary) + "\n" + xml[:15000], response="Log mode: XML generated for import into Tally (Gateway → Import Data)")
    await audit(ctx, "tally.export", module="finance", entity="gl_postings", after=summary, note=batch)
    fname = f"tally-vouchers_{start.isoformat()}_{end.isoformat()}.xml"
    return Response(xml, media_type="application/xml", headers={
        "Content-Disposition": f'attachment; filename="{fname}"', "X-Export-Batch": batch,
        "X-Vouchers": str(len(chosen)), "X-New-Postings": str(len(fresh)), "X-Skipped": str(len(problems)),
        "Access-Control-Expose-Headers": "X-Export-Batch, X-Vouchers, X-New-Postings, X-Skipped"})


# ====================================================================== hub status

@hub.get("/status")
async def integration_status(ctx: CtxDep):
    rs.ensure_access(ctx, E("connectors.messages"), "read")
    ent = E("connectors.messages")
    t = records
    since = now() - timedelta(hours=24)
    cx_col = t.c.data["connector"].astext
    stats = (await ctx.conn.execute(sa.select(
        cx_col, sa.func.count().filter(t.c.created_at >= since), sa.func.count().filter(t.c.created_at >= since, t.c.status == "Failed"),
        sa.func.max(t.c.created_at), sa.func.count().filter(t.c.data["direction"].astext == "Inbound", t.c.created_at >= since),
        sa.func.count().filter(t.c.data["direction"].astext == "Outbound", t.c.created_at >= since), sa.func.count(),
    ).where(*rs.base_where(ent)).group_by(sa.text("1")))).all()
    by = {k: {"last_24h": n, "failed_24h": f, "last_message_at": last.astimezone(settings.tz).isoformat() if last else None,
              "inbound_24h": i, "outbound_24h": o, "total": tot} for k, n, f, last, i, o, tot in stats}
    out = []
    for c in await find(ctx, "connectors.connectors", limit=100, sort="title"):
        s = by.pop(c["id"], {"last_24h": 0, "failed_24h": 0, "last_message_at": None, "inbound_24h": 0, "outbound_24h": 0, "total": 0})
        health = "Error" if c.get("status") == "Error" or (s["failed_24h"] and s["failed_24h"] >= max(1, s["last_24h"] // 2)) else \
            "Disabled" if c.get("status") == "Disabled" else "Degraded" if s["failed_24h"] else "Healthy" if s["last_24h"] else "Idle"
        out.append({"id": c["id"], "code": c.get("code"), "name": c.get("name"), "type": c.get("connector_type"), "direction": c.get("direction"),
                    "transport": c.get("transport"), "environment": c.get("environment"), "status": c.get("status"), "health": health,
                    "last_error": c.get("last_error"), **s})
    if by:
        agg = {k: sum(v[k] for v in by.values()) for k in ("last_24h", "failed_24h", "inbound_24h", "outbound_24h", "total")}
        last = max((v["last_message_at"] for v in by.values() if v["last_message_at"]), default=None)
        out.append({"id": None, "name": "Unassigned messages", "type": "—", "direction": "—", "status": "—", "health": "Idle",
                    "last_message_at": last, **agg})
    return {"connectors": out, "mode": "log", "fhir_base": "/api/fhir"}


for _sub in (fhir, hl7, abdm, tpa, tally, hub):
    router.include_router(_sub)

__all__ = ["router", "build_adt", "Hl7Message", "build_ack", "patient_resource", "vitals_observations", "lab_observations", "envelope"]
