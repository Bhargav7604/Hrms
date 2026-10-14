"""Registration v2: the sectioned Register Patient desk.

* Validation of Indian identifiers (mobile, Aadhaar with Verhoeff check, PAN, passport, driving
  licence, Voter ID, ABHA number / address) and DOB ↔ age (Y/M/D) — an age-only entry stores an
  estimated DOB.
* Aadhaar is never stored: the patient keeps the masked number (last 4) and a keyed hash used only
  for duplicate detection (Aadhaar Act s.29, DPDP Act 2023).
* Aadhaar Secure QR decoding (big integer → bytes → gzip/zlib → 0xFF-delimited fields, V2/V3) and
  the older XML QR, from a camera or a USB scanner.
* Configurable duplicate keys (settings namespace "registration"), override with an audited reason.
* Visit capture at registration: walk-in appointment → check-in (OPD encounter, doctor queue token,
  consultation charge) → optional prompt to bill the consultation at the OP counter.
* Optional registration fee collected on submit, drafts, family linking and the family tree,
  supporting-document rule for demographic edits, pincode autofill (embedded AP/TS dataset +
  optional India Post lookup).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import zlib
from datetime import date, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
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
    new_id,
    not_found,
    now,
    parse_date,
    today,
)
from ..schema import patients, users
from ._common import E, create, find, get, transition, update

log = logging.getLogger("vlack.registration")
router = APIRouter(prefix="/api/registration", tags=["registration"])

PFQN = "registration.patients"
DRAFTS = "registration.drafts"

DEFAULTS: dict[str, Any] = {
    "duplicate_keys": ["phone+name", "aadhaar", "abha"],
    "allow_duplicate_override": True,
    "registration_fee_enabled": False,
    "registration_fee_amount": 100,
    "registration_fee_service_code": "REG-FEE",
    "consult_billing_prompt": True,
    "family_tree_enabled": True,
    "edit_requires_document": False,
    "autofocus_field": "first_name",
    "default_country": "India",
    "default_state": "Andhra Pradesh",
    "default_category": "General",
    "pincode_external_lookup": False,
    "patient_tags": ["General", "VIP", "Repeat", "Corporate", "Insurance", "Camp", "High risk", "Staff"],
    "occupations": ["Student", "Homemaker", "Farmer", "Agricultural labourer", "Business", "Private employee",
                    "Government employee", "Self-employed", "Professional", "Daily wage worker", "Driver", "Teacher",
                    "Retired", "Unemployed", "Child", "Other"],
}
DUPLICATE_KEYS = {
    "phone+name": "Same mobile and first name",
    "phone": "Same mobile number",
    "phone+dob": "Same mobile and date of birth",
    "aadhaar": "Same Aadhaar",
    "abha": "Same ABHA number",
    "abha_address": "Same ABHA address",
    "name+dob": "Same name and date of birth",
    "pan": "Same PAN",
    "passport": "Same passport number",
}
INDIAN_STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
    "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
    "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
    "West Bengal", "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
    "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
]
VISIT_TYPES = ["New", "Follow-up", "Review with reports", "Procedure"]
PRIORITIES = ["Normal", "Senior Citizen", "Differently Abled", "Emergency"]
# demographic keys that need a supporting document to change (when the setting is on)
DOC_KEYS = ("first_name", "middle_name", "last_name", "dob", "gender", "id_number", "abha_id", "pan", "passport_no", "voter_id",
            "driving_licence")
INTERNAL_KEYS = {"family_id", "merged_into", "date_of_death", "dob_estimated", "edit_document", "edit_reason"}


# Field Configuration › Patient Registration › screen settings (namespace "screen.registration") → our keys
SCREEN_KEYS = {"collect_fee_on_submit": "registration_fee_enabled", "registration_fee": "registration_fee_amount",
               "consult_billing_prompt": "consult_billing_prompt", "family_linking": "family_tree_enabled",
               "edit_requires_document": "edit_requires_document", "autofocus_field": "autofocus_field"}
SCREEN_DUP_KEYS = {"id_number": "aadhaar", "abha_id": "abha", "phone+first_name": "phone+name", "phone+dob": "phone+dob",
                   "passport_no": "passport", "pan": "pan", "phone": "phone", "abha_address": "abha_address", "name+dob": "name+dob",
                   "aadhaar": "aadhaar", "abha": "abha", "phone+name": "phone+name", "passport": "passport"}


async def screen_config(ctx, screen: str) -> dict:
    """Effective Field Configuration of a screen ({fields, settings}); empty when unavailable."""
    try:
        from .fieldconfig import screen_config as _sc
    except ImportError:  # pragma: no cover - platform without field configuration
        return {"fields": {}, "settings": {}}
    try:
        async with ctx.conn.begin_nested():
            return await _sc(ctx, screen)
    except Exception:  # noqa: BLE001 - configuration is optional; never block the desk on it
        log.exception("field configuration unavailable for %s", screen)
        return {"fields": {}, "settings": {}}


async def reg_settings(ctx) -> dict:
    """Effective registration settings: defaults ← settings namespace "registration" ← the screen
    settings an administrator sets in Field Configuration › Patient Registration."""
    out = dict(DEFAULTS)
    try:
        from ..core.config_store import get_settings

        async with ctx.conn.begin_nested():
            out.update(await get_settings(ctx, "registration", {}))
    except Exception:  # noqa: BLE001
        log.exception("registration settings unavailable — using defaults")
    scr = (await screen_config(ctx, "registration")).get("settings") or {}
    for k, ours in SCREEN_KEYS.items():
        if scr.get(k) is not None:
            out[ours] = scr[k]
    if isinstance(scr.get("duplicate_keys"), list):
        out["duplicate_keys"] = list(dict.fromkeys(SCREEN_DUP_KEYS[k] for k in scr["duplicate_keys"] if k in SCREEN_DUP_KEYS))
    return out


async def field_rules(ctx, screen: str = "registration") -> dict[str, dict]:
    """Effective per-field configuration for a screen ({key: {visible, required, …}}), {} if unset."""
    return (await screen_config(ctx, screen)).get("fields") or {}


# ------------------------------------------------------------------ identifier validation

_D = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
      [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
      [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
_P = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
      [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
      [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]

MOBILE_RE = re.compile(r"^[6-9]\d{9}$")
PAN_RE = re.compile(r"^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$")
PASSPORT_RE = re.compile(r"^[A-Z]\d{7}$")
VOTER_RE = re.compile(r"^[A-Z]{3}\d{7}$")
DL_RE = re.compile(r"^[A-Z]{2}\d{2}[A-Z0-9]{0,2}(19|20)\d{2}\d{7}$")
ABHA_ADDR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._]{2,31}@[a-z]{2,10}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PIN_RE = re.compile(r"^[1-9]\d{5}$")


def digits(s: Any) -> str:
    return re.sub(r"\D", "", str(s or ""))


def verhoeff_ok(num: str) -> bool:
    c = 0
    for i, ch in enumerate(reversed(num)):
        c = _D[c][_P[i % 8][int(ch)]]
    return c == 0


def valid_aadhaar(num: str) -> bool:
    return len(num) == 12 and num[0] not in "01" and verhoeff_ok(num)


def aadhaar_hash(num: str) -> str:
    """Keyed hash for duplicate detection only — the number itself is never stored."""
    return hmac.new(settings.jwt_secret.encode(), f"aadhaar:{num}".encode(), hashlib.sha256).hexdigest()


def mobile10(v: Any) -> str:
    d = digits(v)
    if len(d) == 12 and d.startswith("91"):
        d = d[2:]
    elif len(d) == 11 and d.startswith("0"):
        d = d[1:]
    return d


def dob_from_age(years: int | None, months: int | None, days: int | None, ref: date | None = None) -> date:
    """Calendar arithmetic without dateutil: subtract years, then months (clamped day), then days."""
    ref = ref or today()
    y, m = ref.year - (years or 0), ref.month - (months or 0)
    while m <= 0:
        m += 12
        y -= 1
    day = ref.day
    while True:
        try:
            d = date(y, m, day)
            break
        except ValueError:
            day -= 1
    return d - timedelta(days=days or 0)


def age_ymd(dob: date, ref: date | None = None) -> dict:
    ref = ref or today()
    y = ref.year - dob.year
    m = ref.month - dob.month
    d = ref.day - dob.day
    if d < 0:
        m -= 1
        prev_month_end = date(ref.year, ref.month, 1) - timedelta(days=1)
        d += prev_month_end.day
    if m < 0:
        y -= 1
        m += 12
    return {"years": y, "months": m, "days": d}


def clean_patient(p: dict[str, Any], errors: dict[str, str]) -> dict[str, Any]:
    """Normalise and validate the identity / contact fields of a registration payload."""
    ent = E(PFQN)
    out: dict[str, Any] = {}
    for f in ent.fields:
        if f.key in INTERNAL_KEYS or f.key not in p:
            continue
        v = p[f.key]
        if isinstance(v, str):
            v = " ".join(v.split()) if f.type != "textarea" else v.strip()
        if v in ("", None, []):
            continue
        out[f.key] = v
    for k in ("phone", "alternate_phone", "attender_phone", "emergency_contact_phone", "next_of_kin_phone"):
        if out.get(k):
            m = mobile10(out[k])
            if not MOBILE_RE.match(m):
                errors[k] = "Enter a valid 10-digit Indian mobile number"
            out[k] = m
    if out.get("phone") and out.get("alternate_phone") == out["phone"]:
        errors["alternate_phone"] = "Alternate mobile is the same as the mobile number"
    if out.get("email") and not EMAIL_RE.match(str(out["email"])):
        errors["email"] = "Enter a valid email address"
    if out.get("pan"):
        out["pan"] = str(out["pan"]).upper().replace(" ", "")
        if not PAN_RE.match(out["pan"]):
            errors["pan"] = "PAN looks like ABCDE1234F (5 letters, 4 digits, 1 letter)"
    if out.get("passport_no"):
        out["passport_no"] = str(out["passport_no"]).upper().replace(" ", "")
        if not PASSPORT_RE.match(out["passport_no"]):
            errors["passport_no"] = "Indian passport numbers are a letter followed by 7 digits"
    if out.get("voter_id"):
        out["voter_id"] = str(out["voter_id"]).upper().replace(" ", "")
        if not VOTER_RE.match(out["voter_id"]):
            errors["voter_id"] = "Voter ID (EPIC) is 3 letters followed by 7 digits"
    if out.get("driving_licence"):
        dl = re.sub(r"[\s-]", "", str(out["driving_licence"]).upper())
        if not DL_RE.match(dl):
            errors["driving_licence"] = "Driving licence looks like TS09 20190001234 (state, RTO, year, number)"
        out["driving_licence"] = f"{dl[:4]} {dl[4:]}" if DL_RE.match(dl) else out["driving_licence"]
    if out.get("abha_id"):
        a = digits(out["abha_id"])
        if len(a) != 14:
            errors["abha_id"] = "ABHA number has 14 digits (xx-xxxx-xxxx-xxxx)"
        out["abha_id"] = a
    if out.get("abha_address"):
        aa = str(out["abha_address"]).strip().lower()
        if "@" not in aa:
            aa = f"{aa}@abdm"
        if not ABHA_ADDR_RE.match(aa):
            errors["abha_address"] = "ABHA address looks like name@abdm"
        out["abha_address"] = aa
    if out.get("pincode"):
        pin = digits(out["pincode"])
        if not PIN_RE.match(pin):
            errors["pincode"] = "Pincode has 6 digits"
        out["pincode"] = pin
    if out.get("dob"):
        try:
            d = parse_date(out["dob"])
        except ValueError:
            errors["dob"] = "Invalid date of birth"
            d = None
        if d and d > today():
            errors["dob"] = "Date of birth cannot be in the future"
        elif d and d < date(today().year - 130, 1, 1):
            errors["dob"] = "Check the date of birth (age over 130 years)"
        if d:
            out["dob"] = d.isoformat()
    for k in ("first_name", "middle_name", "last_name", "guardian_name", "attender_name", "emergency_contact_name", "father_name",
              "mother_name", "spouse_name", "employee_name", "next_of_kin"):
        if out.get(k):
            if re.search(r"\d", str(out[k])):
                errors[k] = "Names cannot contain digits"
            out[k] = str(out[k])[:80]
    for k in ("tags", "chronic_conditions", "allergies"):
        if out.get(k) and isinstance(out[k], str):
            out[k] = [t.strip() for t in out[k].split(",") if t.strip()]
    if out.get("discount_percent") is not None:
        try:
            dp = float(out["discount_percent"])
            if not 0 <= dp <= 100:
                errors["discount_percent"] = "Discount must be between 0 and 100%"
        except (TypeError, ValueError):
            errors["discount_percent"] = "Enter a number"
    return out


# ------------------------------------------------------------------ duplicate detection

async def find_duplicates(ctx, p: dict, keys: list[str], *, a_hash: str | None = None, exclude: str | None = None) -> list[dict]:
    t = patients
    conds = []
    phone, first = p.get("phone"), (p.get("first_name") or "").strip().lower()
    if "phone" in keys and phone:
        conds.append(t.c.phone == phone)
    if "phone+name" in keys and phone and first:
        conds.append(sa.and_(t.c.phone == phone, sa.func.lower(t.c.first_name) == first))
    if "phone+dob" in keys and phone and p.get("dob"):
        conds.append(sa.and_(t.c.phone == phone, t.c.dob == parse_date(p["dob"])))
    if "aadhaar" in keys and a_hash:
        conds.append(t.c.data["aadhaar_hash"].astext == a_hash)
    if "abha" in keys and p.get("abha_id"):
        conds.append(t.c.abha_id == p["abha_id"])
    if "abha_address" in keys and p.get("abha_address"):
        conds.append(t.c.data["abha_address"].astext == p["abha_address"])
    if "name+dob" in keys and first and p.get("dob"):
        cond = sa.and_(sa.func.lower(t.c.first_name) == first, t.c.dob == parse_date(p["dob"]))
        if p.get("last_name"):
            cond = sa.and_(cond, sa.func.lower(sa.func.coalesce(t.c.last_name, "")) == str(p["last_name"]).strip().lower())
        conds.append(cond)
    if "pan" in keys and p.get("pan"):
        conds.append(t.c.data["pan"].astext == p["pan"])
    if "passport" in keys and p.get("passport_no"):
        conds.append(t.c.data["passport_no"].astext == p["passport_no"])
    if not conds:
        return []
    stmt = sa.select(t).where(sa.or_(*conds), t.c.deleted_at.is_(None), sa.func.coalesce(t.c.status, "") != "Merged").limit(10)
    if exclude:
        stmt = stmt.where(t.c.id != exclude)
    out = []
    for r in (await ctx.conn.execute(stmt)).all():
        rec = rs.to_record(r)
        reasons = []
        same_phone = bool(phone) and rec.get("phone") == phone
        same_first = bool(first) and (rec.get("first_name") or "").lower() == first
        if "phone+name" in keys and same_phone and same_first:
            reasons.append("phone+name")
        if "phone" in keys and same_phone:
            reasons.append("phone")
        if "phone+dob" in keys and same_phone and p.get("dob") and rec.get("dob") == p["dob"]:
            reasons.append("phone+dob")
        if "aadhaar" in keys and a_hash and rec.get("aadhaar_hash") == a_hash:
            reasons.append("aadhaar")
        if "abha" in keys and p.get("abha_id") and rec.get("abha_id") == p["abha_id"]:
            reasons.append("abha")
        if "abha_address" in keys and p.get("abha_address") and rec.get("abha_address") == p["abha_address"]:
            reasons.append("abha_address")
        if "name+dob" in keys and same_first and p.get("dob") and rec.get("dob") == p["dob"]:
            reasons.append("name+dob")
        if "pan" in keys and p.get("pan") and rec.get("pan") == p["pan"]:
            reasons.append("pan")
        if "passport" in keys and p.get("passport_no") and rec.get("passport_no") == p["passport_no"]:
            reasons.append("passport")
        if not reasons:
            continue
        out.append({"id": rec["id"], "code": rec["code"], "title": rec.get("title"), "phone": rec.get("phone"),
                    "dob": rec.get("dob"), "age": age_from(rec.get("dob")), "gender": rec.get("gender"),
                    "registered_at": rec.get("created_at"), "status": rec.get("status"),
                    "keys": reasons, "reasons": [DUPLICATE_KEYS[k] for k in reasons]})
    return out


class DupCheckIn(BaseModel):
    patient: dict[str, Any]
    aadhaar: str | None = None
    exclude_id: str | None = None


@router.post("/check-duplicates")
async def check_duplicates(body: DupCheckIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "read")
    s = await reg_settings(ctx)
    p = clean_patient(body.patient, {})
    a = digits(body.aadhaar)
    keys = [k for k in s.get("duplicate_keys") or [] if k in DUPLICATE_KEYS]
    dups = await find_duplicates(ctx, p, keys, a_hash=aadhaar_hash(a) if valid_aadhaar(a) else None, exclude=body.exclude_id)
    return {"keys": keys, "duplicates": dups, "blocking": bool(dups)}


# ------------------------------------------------------------------ configuration for the desk

@router.get("/config")
async def config(ctx: CtxDep):
    ent = E(PFQN)
    rs.ensure_access(ctx, ent, "read")
    s = await reg_settings(ctx)
    opts = {f.key: f.options for f in ent.fields if f.options}
    return {
        "settings": s,
        "duplicate_keys": [{"key": k, "label": v} for k, v in DUPLICATE_KEYS.items()],
        "options": {
            "titles": opts.get("salutation"), "genders": opts.get("gender"), "categories": opts.get("category"),
            "blood_groups": opts.get("blood_group"), "marital_status": opts.get("marital_status"),
            "religions": opts.get("religion"), "relations": opts.get("guardian_relation"),
            "emergency_relations": opts.get("emergency_contact_relation"), "referral_categories": opts.get("referral_category"),
            "payer_types": opts.get("payer_type"), "tags": s.get("patient_tags") or DEFAULTS["patient_tags"],
            "occupations": s.get("occupations") or DEFAULTS["occupations"], "states": INDIAN_STATES,
            "visit_types": VISIT_TYPES, "priorities": PRIORITIES,
        },
        "field_rules": await field_rules(ctx),
    }


# ------------------------------------------------------------------ register

class AgeIn(BaseModel):
    years: int | None = Field(default=None, ge=0, le=130)
    months: int | None = Field(default=None, ge=0, le=11)
    days: int | None = Field(default=None, ge=0, le=30)


class VisitIn(BaseModel):
    doctor_id: str
    department_id: str | None = None
    visit_type: Literal["New", "Follow-up", "Review with reports", "Procedure"] = "New"
    priority: Literal["Normal", "Senior Citizen", "Differently Abled", "Emergency"] | None = None
    chief_complaint: str | None = Field(default=None, max_length=500)
    referral_category: str | None = Field(default=None, max_length=60)
    referral_name: str | None = Field(default=None, max_length=120)
    remarks: str | None = Field(default=None, max_length=1000)


class FeeIn(BaseModel):
    collect: bool = True
    mode: Literal["CASH", "CARD", "UPI", "WALLET", "BANK", "CHEQUE"] = "CASH"
    reference: str | None = Field(default=None, max_length=80)


class FamilyIn(BaseModel):
    related_patient: str
    relationship: Literal["Spouse", "Father", "Mother", "Son", "Daughter", "Brother", "Sister", "Grandparent", "Grandchild",
                          "Guardian", "Other"]
    is_guarantor: bool = False


class RegisterIn(BaseModel):
    patient: dict[str, Any]
    age: AgeIn | None = None
    aadhaar: str | None = Field(default=None, max_length=20, description="Full Aadhaar — validated and hashed, never stored")
    visit: VisitIn | None = None
    fee: FeeIn | None = None
    family: FamilyIn | None = None
    draft_id: str | None = None
    pre_registration_id: str | None = None
    force: bool = False
    override_reason: str | None = Field(default=None, max_length=300)


async def _walk_in_slot(ctx, doctor_id: str) -> tuple[str, bool]:
    """Next free slot today at or after now, else an extra (overbooked) slot at the current time."""
    from .appointments import slot_grid

    grid = await slot_grid(ctx, doctor_id, today(), with_patients=False)
    free = [s["time"] for s in grid["slots"] if s["status"] == "free"]  # past slots are already excluded
    if free:
        return free[0], False
    t = now()
    return f"{t.hour:02d}:{(t.minute // 5) * 5:02d}", True


async def capture_visit(ctx, patient_id: str, visit: VisitIn, *, source: str = "Registration") -> dict:
    """Walk-in booking + check-in for a registered patient: OPD encounter, doctor token and the
    consultation charge (unbilled — billed at the OP counter)."""
    from .appointments import BookIn, book, doctor_info

    if not is_uuid(visit.doctor_id):
        raise bad_request("Choose the consulting doctor", {"fields": {"visit.doctor_id": "Required"}})
    doc = await doctor_info(ctx, visit.doctor_id)
    slot, extra = await _walk_in_slot(ctx, visit.doctor_id)
    appt = await book(ctx, BookIn(
        patient_id=patient_id, doctor_id=visit.doctor_id, appt_date=today().isoformat(), slot=slot, type=visit.visit_type,
        booking_source="Referral" if visit.referral_category and visit.referral_category not in ("Self / walk-in",) else "Walk-in",
        department_id=visit.department_id or doc.get("department_id"), reason=visit.chief_complaint, notes=visit.remarks,
        overbook=extra,
    ), extra={k: v for k, v in {"referral_category": visit.referral_category, "referral_name": visit.referral_name,
                                  "visit_priority": visit.priority, "captured_at": source}.items() if v})
    appt = await transition(ctx, "appointments.appointments", appt["id"], "Checked-in", note=f"Checked in at {source.lower()}")
    token = await get(ctx, "queue.tokens", appt["queue_token"]) if appt.get("queue_token") else None
    if token and visit.priority and visit.priority != token.get("priority"):
        token = await update(ctx, "queue.tokens", token["id"], {"priority": visit.priority})
    charge = await get(ctx, "billing.charges", appt["charge_id"]) if appt.get("charge_id") else None
    from .queue import token_label

    return {
        "appointment": {k: appt.get(k) for k in ("id", "code", "slot", "token_no", "type", "status", "encounter_id", "department_id")},
        "doctor": {k: doc.get(k) for k in ("id", "name", "code", "department", "department_id")},
        "token": {"id": token["id"], "label": token_label(token["queue"], token.get("token_no")), "queue": token["queue"],
                  "priority": token.get("priority")} if token else None,
        "encounter_id": appt.get("encounter_id"),
        "charge": {k: charge.get(k) for k in ("id", "code", "description", "amount", "status")} if charge else None,
        "overbooked": extra,
    }


async def _link_family(ctx, pid: str, fam: FamilyIn) -> dict:
    if not is_uuid(fam.related_patient) or fam.related_patient == pid:
        raise bad_request("Choose a different patient to link as family")
    rows = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.family_id, patients.c.status).where(
        patients.c.id.in_([pid, fam.related_patient]), patients.c.deleted_at.is_(None)))).all()
    by_id = {str(r.id): r for r in rows}
    other = by_id.get(fam.related_patient)
    if not other:
        raise not_found("Family member not found")
    if other.status == "Merged":
        raise conflict("That UHID was merged — link the surviving record")
    fid = next((str(r.family_id) for r in rows if r.family_id), None) or new_id()
    link = await create(ctx, "registration.family_links", {
        "patient_id": pid, "related_patient": fam.related_patient, "relationship": fam.relationship, "is_guarantor": fam.is_guarantor,
    })
    await ctx.conn.execute(patients.update().where(patients.c.id.in_([pid, fam.related_patient])).values(family_id=fid))
    return {"link": link, "family_id": fid}


async def _fee(ctx, s: dict, pid: str, fee: FeeIn | None) -> dict | None:
    amount = float(s.get("registration_fee_amount") or 0)
    if not s.get("registration_fee_enabled") or amount <= 0:
        return None
    from .billing import post_charge

    ch = await post_charge(ctx, patient_id=pid, service_code=s.get("registration_fee_service_code") or "REG-FEE", rate=amount,
                           description="Registration fee (UHID card)", source="registration.fee", source_id=pid)
    out: dict[str, Any] = {"charge": {"id": ch["id"], "amount": ch.get("amount"), "description": ch.get("description")}, "invoice": None}
    if fee is None or fee.collect:
        from .opbilling import quick_bill

        mode = fee.mode if fee else "CASH"
        inv = await quick_bill(ctx, patient_id=pid, charge_ids=[ch["id"]],
                               payments=[{"mode": mode, "amount": amount, "reference": fee.reference if fee else None}],
                               remarks="Registration fee")
        out["invoice"] = {k: inv.get(k) for k in ("id", "code", "net", "paid", "balance", "status")}
    return out


@router.post("/register", status_code=201)
async def register(body: RegisterIn, ctx: CtxDep):
    ent = E(PFQN)
    rs.ensure_access(ctx, ent, "write")
    s = await reg_settings(ctx)
    errors: dict[str, str] = {}
    p = clean_patient(body.patient, errors)

    # identity: Aadhaar (full number only to validate + hash), DOB or age
    a_hash = None
    a = digits(body.aadhaar or (p.get("id_number") if (p.get("id_type") or "Aadhaar") == "Aadhaar" else ""))
    if a:
        if len(a) == 12 and valid_aadhaar(a):
            a_hash = aadhaar_hash(a)
            p.update(id_type="Aadhaar", id_number=a)  # the patients hook masks it to the last 4 digits
        elif len(a) == 12:
            errors["aadhaar"] = "This is not a valid Aadhaar number (checksum failed) — re-check the 12 digits"
        elif len(a) == 4 and body.aadhaar and str(body.aadhaar).upper().startswith("X"):
            p.update(id_type="Aadhaar", id_number="XXXXXXXX" + a)  # from a Secure QR: only the last 4 digits are known
        else:
            errors["aadhaar"] = "Aadhaar has 12 digits"
    if not p.get("dob") and body.age and any(x for x in (body.age.years, body.age.months, body.age.days)):
        p["dob"] = dob_from_age(body.age.years, body.age.months, body.age.days).isoformat()
        p["dob_estimated"] = True
    for k in ("first_name", "gender", "phone"):
        if not p.get(k):
            errors[k] = {"first_name": "First name is required", "gender": "Gender is required", "phone": "Mobile is required"}[k]
    p.setdefault("category", s.get("default_category") or "General")
    p.setdefault("country", s.get("default_country") or "India")
    rules = await field_rules(ctx)
    virtual = {"age": p.get("dob"), "consulting_doctor": body.visit.doctor_id if body.visit else None,
               "visit_type": body.visit.visit_type if body.visit else None,
               "chief_complaint": body.visit.chief_complaint if body.visit else None,
               "referral_category": (body.visit.referral_category if body.visit else None) or p.get("referral_category"),
               "referral_name": (body.visit.referral_name if body.visit else None) or p.get("referral_name")}
    for key, rule in rules.items():
        if not rule.get("required") or rule.get("hidden") or rule.get("visible") is False:
            continue
        if key in virtual:
            if key in ("consulting_doctor", "visit_type", "chief_complaint") and not body.visit:
                continue  # visit capture is optional; when a visit is captured its required fields apply
            if not virtual[key]:
                errors.setdefault("dob" if key == "age" else f"visit.{key}" if key in ("consulting_doctor", "visit_type", "chief_complaint")
                                  else key, "Enter the date of birth or the age" if key == "age" else f"{rule.get('label') or key} is required")
            continue
        if key in ent.field_map and not p.get(key) and not (key == "id_number" and p.get("id_number")):
            errors.setdefault(key, f"{rule.get('label') or ent.field_map[key].label} is required")
    for key, rule in rules.items():  # values of hidden / read-only fields are not taken from the desk
        if (rule.get("hidden") or rule.get("visible") is False or rule.get("readonly")) and key in p and key not in ("first_name", "gender", "phone"):
            if key in ent.field_map and not ent.field_map[key].required:
                p.pop(key, None)
    if errors:
        raise bad_request("Please fix the highlighted fields", {"fields": errors})
    if p.get("category") in ("Corporate", "Insurance") and p.get("payer_type", "Cash") == "Cash":
        p["payer_type"] = p["category"]

    keys = [k for k in s.get("duplicate_keys") or [] if k in DUPLICATE_KEYS]
    dups = await find_duplicates(ctx, p, keys, a_hash=a_hash)
    if dups:
        if not body.force:
            raise ApiError(409, "This patient may already be registered", {"duplicates": dups, "keys": keys}, code="DUPLICATE")
        if not s.get("allow_duplicate_override", True) and ctx.role != "admin":
            raise ApiError(409, "Duplicate registrations are blocked by hospital policy — open the existing UHID",
                           {"duplicates": dups, "keys": keys}, code="DUPLICATE_BLOCKED")
        if not (body.override_reason or "").strip():
            raise bad_request("Give the reason for registering a new UHID despite the match", {"fields": {"override_reason": "Required"}})

    if body.visit:  # fail before creating anything if the doctor cannot be booked
        from .appointments import doctor_info

        await doctor_info(ctx, body.visit.doctor_id)

    data = {**p, "status": "Active"}
    if a_hash:
        data["aadhaar_hash"] = a_hash
    if body.visit and body.visit.referral_category and not p.get("referral_category"):
        data["referral_category"] = body.visit.referral_category
        data["referral_name"] = body.visit.referral_name
    rec = await create(ctx, PFQN, data)
    if dups:
        await audit(ctx, "patient.duplicate_override", module="registration", entity="patients", record=rec,
                    after={"matches": [d["code"] for d in dups], "keys": sorted({k for d in dups for k in d["keys"]})},
                    note=body.override_reason)

    if body.pre_registration_id and is_uuid(body.pre_registration_id):
        pre = await get(ctx, "registration.pre_registrations", body.pre_registration_id)
        if pre and pre.get("status") == "Pending":
            await update(ctx, "registration.pre_registrations", pre["id"], {"status": "Converted", "converted_patient": rec["id"]})
    if body.draft_id and is_uuid(body.draft_id):
        d = await get(ctx, DRAFTS, body.draft_id)
        if d and d.get("status") == "Draft":
            await update(ctx, DRAFTS, d["id"], {"status": "Registered", "registered_patient": rec["id"], "payload": None})

    family = await _link_family(ctx, rec["id"], body.family) if body.family else None
    fee = await _fee(ctx, s, rec["id"], body.fee)
    visit = await capture_visit(ctx, rec["id"], body.visit) if body.visit else None
    await emit("patient.registered", ctx, {"patient": rec})

    bill_prompt = None
    if visit and visit.get("charge") and s.get("consult_billing_prompt", True) and visit["charge"].get("status") == "Unbilled":
        bill_prompt = {"charge_ids": [visit["charge"]["id"]], "amount": visit["charge"].get("amount"),
                       "description": visit["charge"].get("description"), "doctor": visit["doctor"]["name"]}
    rec = await get(ctx, PFQN, rec["id"])
    return {"patient": rec, "age": age_ymd(parse_date(rec["dob"])) if rec.get("dob") else None, "visit": visit, "fee": fee,
            "family": family, "bill_prompt": bill_prompt, "duplicates_overridden": [d["code"] for d in dups]}


# ------------------------------------------------------------------ supporting document for demographic edits

@hook(PFQN, "before_update")
async def _edit_document(ctx, nxt: dict, prev: dict):
    if ctx.user.get("id") == "system":
        return
    changed = [k for k in DOC_KEYS if str(nxt.get(k) or "") != str(prev.get(k) or "")]
    if not changed:
        return
    s = await reg_settings(ctx)
    if not s.get("edit_requires_document"):
        return
    if not nxt.get("edit_document") or nxt.get("edit_document") == prev.get("edit_document"):
        ent = E(PFQN)
        raise bad_request(f"Attach a supporting document to change {', '.join(ent.field_map[k].label for k in changed)}",
                          {"fields": {"edit_document": "Upload the supporting document (ID proof, affidavit …)"}})
    if not (nxt.get("edit_reason") or "").strip():
        raise bad_request("Give the reason for the change", {"fields": {"edit_reason": "Required"}})


# ------------------------------------------------------------------ drafts

class DraftIn(BaseModel):
    payload: dict[str, Any]
    notes: str | None = Field(default=None, max_length=300)


def _draft_payload(payload: dict) -> dict:
    """Drafts never keep a full Aadhaar number — only the last 4 digits survive."""
    out = dict(payload)
    a = digits(out.get("aadhaar"))
    if a:
        out["aadhaar"] = f"XXXXXXXX{a[-4:]}" if len(a) >= 4 else None
    p = dict(out.get("patient") or {})
    if p.get("id_number") and len(digits(p["id_number"])) > 4:
        p["id_number"] = f"XXXXXXXX{digits(p['id_number'])[-4:]}"
    out["patient"] = p
    if len(str(out)) > 60_000:
        raise bad_request("The draft is too large to save")
    return out


def _draft_fields(payload: dict) -> dict:
    p = payload.get("patient") or {}
    name = " ".join(x for x in (p.get("salutation"), p.get("first_name"), p.get("middle_name"), p.get("last_name")) if x) or "Unnamed patient"
    v = payload.get("visit") or {}
    phone = mobile10(p.get("phone")) if p.get("phone") else None
    return {"name": name[:120], "phone": phone if phone and MOBILE_RE.match(phone) else None,
            "gender": p.get("gender") if p.get("gender") in ("Male", "Female", "Transgender", "Other") else None,
            "visit_doctor": v.get("doctor_id") if is_uuid(v.get("doctor_id")) else None}


@router.post("/drafts", status_code=201)
async def save_draft(body: DraftIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "write")
    payload = _draft_payload(body.payload)
    return await create(ctx, DRAFTS, {**_draft_fields(payload), "payload": payload, "notes": body.notes, "status": "Draft",
                                      "saved_by": ctx.user.get("employee_id"), "saved_at": now().isoformat(timespec="seconds")})


@router.put("/drafts/{draft_id}")
async def update_draft(draft_id: str, body: DraftIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "write")
    d = await get(ctx, DRAFTS, draft_id)
    if not d:
        raise not_found("Draft not found")
    if d.get("status") != "Draft":
        raise conflict(f"This draft is already {d.get('status', '').lower()}")
    payload = _draft_payload(body.payload)
    return await update(ctx, DRAFTS, draft_id, {**_draft_fields(payload), "payload": payload, "notes": body.notes,
                                                "saved_by": ctx.user.get("employee_id"), "saved_at": now().isoformat(timespec="seconds")})


@router.get("/drafts")
async def list_drafts(ctx: CtxDep, status: str = "Draft", mine: bool = False, q: str | None = None, limit: int = 100):
    rs.ensure_access(ctx, E(PFQN), "read")
    rows = await find(ctx, DRAFTS, status=status if status != "all" else None, q=q or None, limit=max(1, min(limit, 300)), sort="-saved_at")
    if mine:
        rows = [r for r in rows if r.get("created_by") == ctx.user_id]
    refs = rows[0].get("_refs", {}) if rows else {}
    return [{**{k: r.get(k) for k in ("id", "code", "name", "phone", "gender", "visit_doctor", "notes", "saved_at", "status",
                                      "created_at", "registered_patient")},
             "saved_by_name": refs.get(r.get("saved_by") or ""), "doctor_name": refs.get(r.get("visit_doctor") or ""),
             "mine": r.get("created_by") == ctx.user_id} for r in rows]


@router.get("/drafts/{draft_id}")
async def get_draft(draft_id: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "read")
    d = await get(ctx, DRAFTS, draft_id)
    if not d:
        raise not_found("Draft not found")
    return {k: d.get(k) for k in ("id", "code", "name", "status", "notes", "saved_at", "payload", "registered_patient")}


@router.post("/drafts/{draft_id}/discard")
async def discard_draft(draft_id: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "write")
    d = await get(ctx, DRAFTS, draft_id)
    if not d:
        raise not_found("Draft not found")
    if d.get("status") != "Draft":
        raise conflict(f"This draft is already {d.get('status', '').lower()}")
    return await update(ctx, DRAFTS, draft_id, {"status": "Discarded", "payload": None})


# ------------------------------------------------------------------ registered today / family tree

@router.get("/registered")
async def registered(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None, q: str | None = None, mine: bool = False,
                     limit: int = 100):
    """Patients registered in a window (View Registered), newest first, with who registered them."""
    rs.ensure_access(ctx, E(PFQN), "read")
    d_from, d_to = parse_date(date_from) or today(), parse_date(date_to) or parse_date(date_from) or today()
    if d_to < d_from:
        raise bad_request("'To' date is before 'From' date")
    t = patients
    conds = [t.c.deleted_at.is_(None), t.c.created_at >= day_bounds(d_from)[0], t.c.created_at < day_bounds(d_to)[1]]
    if mine:
        conds.append(t.c.created_by == ctx.user_id)
    if q and q.strip():
        term = q.strip().lower()
        conds.append(sa.or_(t.c.search.ilike(f"%{term}%"), t.c.phone.like(f"%{digits(term) or term}%")))
    total = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(t).where(*conds))).scalar_one()
    rows = (await ctx.conn.execute(sa.select(t, users.c.name.label("by_name")).select_from(t.outerjoin(users, sa.cast(users.c.id, sa.Text) == t.c.created_by))
                                   .where(*conds).order_by(t.c.created_at.desc()).limit(max(1, min(limit, 300))))).all()
    out = []
    for r in rows:
        m = dict(r._mapping)
        by = m.pop("by_name")
        rec = rs.to_record(m)
        out.append({**{k: rec.get(k) for k in ("id", "code", "title", "gender", "dob", "phone", "category", "city", "status", "created_at", "tags")},
                    "age": age_from(rec.get("dob")), "registered_by": by})
    return {"total": total, "rows": out}


@router.get("/patients/{pid}/family")
async def family_tree(pid: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "read")
    if not is_uuid(pid):
        raise not_found("Patient not found")
    me = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.family_id).where(patients.c.id == pid))).first()
    if not me:
        raise not_found("Patient not found")
    links = await find(ctx, "registration.family_links", patient_id=pid, limit=100)
    rt = E("registration.family_links").table
    reverse = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(rt).where(
        *rs.base_where(E("registration.family_links")), rt.c.data["related_patient"].astext == pid))).all()]
    inverse = {"Father": "Child", "Mother": "Child", "Son": "Parent", "Daughter": "Parent", "Spouse": "Spouse", "Brother": "Sibling",
               "Sister": "Sibling", "Grandparent": "Grandchild", "Grandchild": "Grandparent", "Guardian": "Ward"}
    members: dict[str, dict] = {}
    for link in links:
        members[link["related_patient"]] = {"relationship": link.get("relationship"), "link_id": link["id"],
                                            "is_guarantor": link.get("is_guarantor"), "direction": "out"}
    for link in reverse:
        members.setdefault(link["patient_id"], {"relationship": inverse.get(link.get("relationship") or "", "Family"),
                                                "link_id": link["id"], "is_guarantor": False, "direction": "in"})
    if me.family_id:
        for (oid,) in (await ctx.conn.execute(sa.select(patients.c.id).where(patients.c.family_id == me.family_id, patients.c.id != pid,
                                                                             patients.c.deleted_at.is_(None)))).all():
            members.setdefault(str(oid), {"relationship": "Family", "link_id": None, "is_guarantor": False, "direction": "group"})
    rows = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.code, patients.c.title, patients.c.dob, patients.c.gender,
                                             patients.c.phone, patients.c.status).where(
        patients.c.id.in_([m for m in members if is_uuid(m)])))).all() if members else []
    out = [{"id": str(r.id), "code": r.code, "name": r.title, "age": age_from(r.dob), "gender": r.gender, "phone": r.phone,
            "status": r.status, **members[str(r.id)]} for r in rows]
    return {"family_id": str(me.family_id) if me.family_id else None, "members": sorted(out, key=lambda m: m["relationship"] or "")}


@router.post("/patients/{pid}/family", status_code=201)
async def add_family(pid: str, body: FamilyIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "write")
    if not is_uuid(pid):
        raise not_found("Patient not found")
    return await _link_family(ctx, pid, body)


# ------------------------------------------------------------------ Aadhaar QR decoding

REL_RE = re.compile(r"^\s*(S|W|D|C|B)\s*/\s*O\s*[:.,-]?\s*", re.I)


def _split_name(name: str) -> dict:
    parts = [x for x in re.split(r"\s+", (name or "").strip()) if x]
    if not parts:
        return {}
    if len(parts) == 1:
        return {"first_name": parts[0].title()}
    if len(parts) == 2:
        return {"first_name": parts[0].title(), "last_name": parts[1].title()}
    return {"first_name": parts[0].title(), "middle_name": " ".join(parts[1:-1]).title(), "last_name": parts[-1].title()}


def _care_of(co: str) -> dict:
    co = (co or "").strip()
    if not co:
        return {}
    m = REL_RE.match(co)
    if m:
        return {"guardian_relation": f"{m.group(1).upper()}/o", "guardian_name": co[m.end():].strip().title() or None}
    return {"guardian_relation": "C/o", "guardian_name": co.title()}


def _dob(v: str) -> dict:
    v = (v or "").strip()
    if re.fullmatch(r"\d{4}", v):
        return {"yob": int(v)}
    m = re.fullmatch(r"(\d{2})[-/](\d{2})[-/](\d{4})", v)
    if m:
        return {"dob": f"{m.group(3)}-{m.group(2)}-{m.group(1)}"}
    m = re.fullmatch(r"(\d{4})[-/](\d{2})[-/](\d{2})", v)
    if m:
        return {"dob": f"{m.group(1)}-{m.group(2)}-{m.group(3)}"}
    return {}


GENDERS = {"M": "Male", "F": "Female", "T": "Transgender", "MALE": "Male", "FEMALE": "Female", "TRANSGENDER": "Transgender"}


def _result(*, name: str, dob: str, gender: str, co: str, house: str = "", street: str = "", landmark: str = "", loc: str = "",
            vtc: str = "", po: str = "", district: str = "", subdist: str = "", state: str = "", pincode: str = "", **extra) -> dict:
    out: dict[str, Any] = {"name": name.strip(), **_split_name(name), **_dob(dob), **_care_of(co)}
    g = GENDERS.get((gender or "").strip().upper())
    if g:
        out["gender"] = g
    if out.get("yob") and not out.get("dob"):
        out["age"] = {"years": today().year - out["yob"]}
    addr = ", ".join(x.strip() for x in (house, street, landmark) if x and x.strip())
    out.update({"address": addr or None, "area": (loc or "").strip() or None, "city": (vtc or po or subdist or "").strip() or None,
                "post_office": (po or "").strip() or None, "sub_district": (subdist or "").strip() or None,
                "district": (district or "").strip() or None, "state": (state or "").strip().title() or None,
                "pincode": digits(pincode) or None})
    if out["state"]:
        match = next((s for s in INDIAN_STATES if s.lower() == out["state"].lower()), None)
        out["state"] = match or out["state"]
    out.update(extra)
    return out


def decode_secure_qr(raw: str) -> dict:
    """UIDAI Secure QR: decimal big integer → big-endian bytes → gzip (zlib / raw deflate tolerated) →
    fields separated by 0xFF. V2/V3 carry a version marker and the last 4 digits of the mobile."""
    s = re.sub(r"\s", "", raw)
    n = int(s)
    blob = n.to_bytes((n.bit_length() + 7) // 8, "big")
    data = None
    for wbits in (16 + zlib.MAX_WBITS, zlib.MAX_WBITS, -zlib.MAX_WBITS):
        try:
            data = zlib.decompressobj(wbits).decompress(blob)
            if data:
                break
        except zlib.error:
            continue
    if not data:
        raise ValueError("not a compressed Aadhaar Secure QR")
    parts = data.split(b"\xff")
    version = "V1"
    if parts and re.fullmatch(rb"V\d", parts[0] or b""):
        version = parts[0].decode()
        parts = parts[1:]
    if len(parts) < 16:
        raise ValueError("too few fields")
    f = [p.decode("iso-8859-1", errors="replace") for p in parts[:17]]
    indicator, ref = f[0], f[1]
    if not re.fullmatch(r"\d{4}\d*", ref or ""):
        raise ValueError("unexpected reference id")
    mobile_last4 = f[16] if version != "V1" and len(f) > 16 and re.fullmatch(r"\d{4}", f[16] or "") else None
    out = _result(name=f[2], dob=f[3], gender=f[4], co=f[5], district=f[6], landmark=f[7], house=f[8], loc=f[9], pincode=f[10], po=f[11],
                  state=f[12], street=f[13], subdist=f[14], vtc=f[15])
    out.update({"format": f"Secure QR {version}", "aadhaar_last4": ref[:4], "reference_id": ref,
                "generated_at": _ref_time(ref[4:]), "mobile_last4": mobile_last4,
                "has_email": indicator in ("1", "3"), "has_mobile": indicator in ("2", "3"), "signature_verified": False})
    return out


def _ref_time(ts: str) -> str | None:
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d*", ts or "")
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}T{m.group(4)}:{m.group(5)}:{m.group(6)}" if m else None


def decode_xml_qr(text: str) -> dict:
    m = re.search(r"<(?:PrintLetterBarcodeData|QPDB|QDA)\b([^>]*)/?>", text, re.I)
    if not m:
        raise ValueError("no Aadhaar XML element")
    attrs = {k.lower(): v for k, v in re.findall(r'(\w+)\s*=\s*"([^"]*)"', m.group(1))}
    uid = digits(attrs.get("uid"))
    out = _result(name=attrs.get("name") or attrs.get("n", ""), dob=attrs.get("dob") or attrs.get("d") or attrs.get("yob", ""),
                  gender=attrs.get("gender") or attrs.get("g", ""), co=attrs.get("co") or attrs.get("gname", ""),
                  house=attrs.get("house") or attrs.get("h", ""), street=attrs.get("street") or attrs.get("s", ""),
                  landmark=attrs.get("lm") or attrs.get("l", ""), loc=attrs.get("loc", ""), vtc=attrs.get("vtc") or attrs.get("v", ""),
                  po=attrs.get("po", ""), district=attrs.get("dist", ""), subdist=attrs.get("subdist", ""), state=attrs.get("state", ""),
                  pincode=attrs.get("pc", ""))
    out.update({"format": "XML QR", "signature_verified": False})
    if len(uid) == 12:
        out["aadhaar_last4"] = uid[-4:]
        out["aadhaar_valid"] = valid_aadhaar(uid)
        out["aadhaar"] = uid  # handed back once to prefill the form; hashed at registration, never stored
    elif len(uid) >= 4:
        out["aadhaar_last4"] = uid[-4:]
    return out


class QrIn(BaseModel):
    data: str = Field(min_length=10, max_length=20000)


@router.post("/aadhaar/decode")
async def aadhaar_decode(body: QrIn, ctx: CtxDep):
    """Decode a scanned Aadhaar QR (camera or USB scanner) into registration fields. Nothing is stored."""
    rs.ensure_access(ctx, E(PFQN), "read")
    text = body.data.strip()
    try:
        if re.fullmatch(r"[\d\s]+", text):
            return decode_secure_qr(text)
        if "<" in text:
            return decode_xml_qr(text)
    except (ValueError, OverflowError, IndexError) as e:
        log.info("aadhaar QR not decoded: %s", e)
    raise bad_request("This does not look like an Aadhaar QR. Scan the large QR on the Aadhaar letter / e-Aadhaar, "
                      "or the one in the mAadhaar app.")


# ------------------------------------------------------------------ pincode autofill

async def _external_pincode(pin: str) -> dict | None:
    import httpx

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"https://api.postalpincode.in/pincode/{pin}")
            r.raise_for_status()
            body = r.json()
    except Exception as e:  # noqa: BLE001
        log.info("India Post pincode lookup failed for %s: %s", pin, e)
        return None
    entry = body[0] if isinstance(body, list) and body else {}
    offices = entry.get("PostOffice") or []
    if not offices:
        return None
    first = offices[0]
    return {"pincode": pin, "areas": sorted({o.get("Name") for o in offices if o.get("Name")}),
            "city": first.get("Block") if first.get("Block") not in (None, "NA") else first.get("Division"),
            "district": first.get("District"), "state": first.get("State"), "country": "India", "source": "India Post", "precision": "exact"}


def lookup_pincode(pin: str) -> dict | None:
    _load_pins()
    hit = _PINS.get(pin)
    if hit:
        area, city, district, st = hit
        return {"pincode": pin, "areas": [area] if area and area != "Head Post Office" else [], "city": city, "district": district, "state": STATES[st],
                "country": "India", "source": "Embedded directory", "precision": "exact"}
    n = int(pin)
    for lo, hi, city, district, st in _RANGES:
        if lo <= n <= hi:
            return {"pincode": pin, "areas": [], "city": city, "district": district, "state": STATES[st], "country": "India",
                    "source": "Embedded directory", "precision": "city"}
    pre = _PREFIX.get(pin[:3])
    if pre:
        district, st = pre
        return {"pincode": pin, "areas": [], "city": None, "district": district, "state": STATES[st], "country": "India",
                "source": "Sorting district", "precision": "district"}
    circle = _CIRCLES.get(pin[:2])
    if circle:
        return {"pincode": pin, "areas": [], "city": None, "district": None, "state": circle, "country": "India",
                "source": "Postal circle", "precision": "state"}
    return None


@router.get("/pincode/{pin}")
async def pincode(pin: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(PFQN), "read")
    pin = digits(pin)
    if not PIN_RE.match(pin):
        raise bad_request("Pincode has 6 digits")
    local = lookup_pincode(pin)
    if local and local["precision"] in ("exact", "city"):
        return local
    s = await reg_settings(ctx)
    if s.get("pincode_external_lookup"):
        ext = await _external_pincode(pin)
        if ext:
            return ext
    if local:
        return local
    raise not_found("Pincode not in the directory — fill the address manually")


@router.get("/pincodes")
async def pincodes(ctx: CtxDep, q: str = "", limit: int = 20):
    """Search the embedded directory by area / city / district (type-ahead for the address)."""
    rs.ensure_access(ctx, E(PFQN), "read")
    _load_pins()
    term = q.strip().lower()
    if len(term) < 2:
        return []
    out = []
    for pin, (area, city, district, st) in _PINS.items():
        if term in (area or "").lower() or term in (city or "").lower() or term in (district or "").lower() or pin.startswith(term):
            out.append({"pincode": pin, "area": area, "city": city, "district": district, "state": STATES[st]})
            if len(out) >= max(1, min(limit, 50)):
                break
    return out


# ------------------------------------------------------------------ embedded pincode directory (Andhra Pradesh & Telangana)
# Post-2022 revenue districts. Exact entries are head / town post offices and well-known localities;
# ranges cover the city delivery offices; the 3-digit sorting-district table is the fallback.

STATES = {"AP": "Andhra Pradesh", "TS": "Telangana"}
_CIRCLES = {"50": "Telangana", "51": "Andhra Pradesh", "52": "Andhra Pradesh", "53": "Andhra Pradesh"}
_PREFIX: dict[str, tuple[str, str]] = {
    "500": ("Hyderabad", "TS"), "501": ("Ranga Reddy", "TS"), "502": ("Sangareddy", "TS"), "503": ("Nizamabad", "TS"),
    "504": ("Adilabad", "TS"), "505": ("Karimnagar", "TS"), "506": ("Warangal", "TS"), "507": ("Khammam", "TS"),
    "508": ("Nalgonda", "TS"), "509": ("Mahabubnagar", "TS"),
    "515": ("Anantapuramu", "AP"), "516": ("YSR Kadapa", "AP"), "517": ("Chittoor", "AP"), "518": ("Kurnool", "AP"),
    "520": ("NTR", "AP"), "521": ("Krishna", "AP"), "522": ("Guntur", "AP"), "523": ("Prakasam", "AP"), "524": ("SPSR Nellore", "AP"),
    "530": ("Visakhapatnam", "AP"), "531": ("Anakapalli", "AP"), "532": ("Srikakulam", "AP"), "533": ("East Godavari", "AP"),
    "534": ("West Godavari", "AP"), "535": ("Vizianagaram", "AP"),
}
_RANGES: list[tuple[int, int, str, str, str]] = [
    (500001, 500100, "Hyderabad", "Hyderabad", "TS"), (506001, 506015, "Warangal", "Hanumakonda", "TS"),
    (505001, 505002, "Karimnagar", "Karimnagar", "TS"), (507001, 507003, "Khammam", "Khammam", "TS"),
    (508001, 508002, "Nalgonda", "Nalgonda", "TS"), (509001, 509002, "Mahabubnagar", "Mahabubnagar", "TS"),
    (503001, 503003, "Nizamabad", "Nizamabad", "TS"), (504001, 504002, "Adilabad", "Adilabad", "TS"),
    (520001, 520015, "Vijayawada", "NTR", "AP"), (522001, 522020, "Guntur", "Guntur", "AP"), (524001, 524005, "Nellore", "SPSR Nellore", "AP"),
    (530001, 530053, "Visakhapatnam", "Visakhapatnam", "AP"), (533101, 533107, "Rajamahendravaram", "East Godavari", "AP"),
    (533001, 533008, "Kakinada", "Kakinada", "AP"), (517501, 517507, "Tirupati", "Tirupati", "AP"), (518001, 518006, "Kurnool", "Kurnool", "AP"),
    (515001, 515005, "Anantapur", "Anantapuramu", "AP"), (516001, 516004, "Kadapa", "YSR Kadapa", "AP"), (534001, 534007, "Eluru", "Eluru", "AP"),
    (523001, 523002, "Ongole", "Prakasam", "AP"), (535001, 535004, "Vizianagaram", "Vizianagaram", "AP"),
    (532001, 532005, "Srikakulam", "Srikakulam", "AP"), (517001, 517004, "Chittoor", "Chittoor", "AP"),
]

# pincode|area|city|district|state  (area blank where the office is the town itself)
_PIN_TABLE = """
500001|Abids (GPO)|Hyderabad|Hyderabad|TS
500003|Secunderabad|Secunderabad|Hyderabad|TS
500004|Khairatabad|Hyderabad|Hyderabad|TS
500008|Golconda|Hyderabad|Hyderabad|TS
500011|Bowenpally|Secunderabad|Hyderabad|TS
500013|Amberpet|Hyderabad|Hyderabad|TS
500015|Trimulgherry|Secunderabad|Hyderabad|TS
500016|Begumpet|Hyderabad|Hyderabad|TS
500017|Tarnaka|Secunderabad|Hyderabad|TS
500018|Erragadda / Sanathnagar|Hyderabad|Hyderabad|TS
500020|Musheerabad|Hyderabad|Hyderabad|TS
500027|Kachiguda|Hyderabad|Hyderabad|TS
500028|Mehdipatnam|Hyderabad|Hyderabad|TS
500029|Himayatnagar|Hyderabad|Hyderabad|TS
500030|Rajendranagar|Hyderabad|Ranga Reddy|TS
500032|Gachibowli|Hyderabad|Ranga Reddy|TS
500033|Jubilee Hills|Hyderabad|Hyderabad|TS
500034|Banjara Hills|Hyderabad|Hyderabad|TS
500036|Malakpet|Hyderabad|Hyderabad|TS
500037|Balanagar|Hyderabad|Medchal-Malkajgiri|TS
500038|Ameerpet / S R Nagar|Hyderabad|Hyderabad|TS
500039|Uppal|Hyderabad|Medchal-Malkajgiri|TS
500040|Moula Ali|Hyderabad|Medchal-Malkajgiri|TS
500044|Nallakunta|Hyderabad|Hyderabad|TS
500047|Malkajgiri|Secunderabad|Medchal-Malkajgiri|TS
500049|Miyapur|Hyderabad|Ranga Reddy|TS
500050|Chandanagar|Hyderabad|Ranga Reddy|TS
500055|Jeedimetla|Hyderabad|Medchal-Malkajgiri|TS
500056|Neredmet|Secunderabad|Medchal-Malkajgiri|TS
500058|Kanchanbagh|Hyderabad|Hyderabad|TS
500059|Saidabad|Hyderabad|Hyderabad|TS
500060|Dilsukhnagar|Hyderabad|Ranga Reddy|TS
500062|ECIL / Kamalanagar|Secunderabad|Medchal-Malkajgiri|TS
500070|Vanasthalipuram|Hyderabad|Ranga Reddy|TS
500072|Kukatpally (KPHB)|Hyderabad|Medchal-Malkajgiri|TS
500073|Srinagar Colony|Hyderabad|Hyderabad|TS
500074|L B Nagar|Hyderabad|Ranga Reddy|TS
500076|Nacharam|Hyderabad|Medchal-Malkajgiri|TS
500081|Madhapur / HITEC City|Hyderabad|Ranga Reddy|TS
500082|Somajiguda|Hyderabad|Hyderabad|TS
500084|Kondapur|Hyderabad|Ranga Reddy|TS
500085|JNTU Kukatpally|Hyderabad|Medchal-Malkajgiri|TS
500087|Sainikpuri|Secunderabad|Medchal-Malkajgiri|TS
500089|Manikonda / Narsingi|Hyderabad|Ranga Reddy|TS
500090|Nizampet / Bachupally|Hyderabad|Medchal-Malkajgiri|TS
500092|Boduppal|Hyderabad|Medchal-Malkajgiri|TS
500096|Film Nagar|Hyderabad|Hyderabad|TS
501101||Vikarabad|Vikarabad|TS
501141||Tandur|Vikarabad|TS
501218||Shamshabad|Ranga Reddy|TS
501301||Ghatkesar|Medchal-Malkajgiri|TS
501401||Medchal|Medchal-Malkajgiri|TS
501505||Hayathnagar|Ranga Reddy|TS
501510||Ibrahimpatnam|Ranga Reddy|TS
502001||Sangareddy|Sangareddy|TS
502103||Siddipet|Siddipet|TS
502110||Medak|Medak|TS
502220||Zaheerabad|Sangareddy|TS
503001|Head Post Office|Nizamabad|Nizamabad|TS
503111||Kamareddy|Kamareddy|TS
503185||Bodhan|Nizamabad|TS
503224||Armoor|Nizamabad|TS
504001|Head Post Office|Adilabad|Adilabad|TS
504106||Nirmal|Nirmal|TS
504208||Mancherial|Mancherial|TS
504296||Asifabad|Kumuram Bheem Asifabad|TS
505001|Head Post Office|Karimnagar|Karimnagar|TS
505172||Peddapalli|Peddapalli|TS
505301||Sircilla|Rajanna Sircilla|TS
505327||Jagtial|Jagtial|TS
506001|Hanamkonda|Warangal|Hanumakonda|TS
506002||Warangal|Warangal|TS
506101||Mahabubabad|Mahabubabad|TS
506167||Jangaon|Jangaon|TS
507001|Head Post Office|Khammam|Khammam|TS
507101||Kothagudem|Bhadradri Kothagudem|TS
507111||Bhadrachalam|Bhadradri Kothagudem|TS
508001|Head Post Office|Nalgonda|Nalgonda|TS
508116||Bhongir|Yadadri Bhuvanagiri|TS
508207||Miryalaguda|Nalgonda|TS
508213||Suryapet|Suryapet|TS
509001|Head Post Office|Mahabubnagar|Mahabubnagar|TS
509103||Wanaparthy|Wanaparthy|TS
509125||Gadwal|Jogulamba Gadwal|TS
509209||Nagarkurnool|Nagarkurnool|TS
509216||Shadnagar|Ranga Reddy|TS
509301||Jadcherla|Mahabubnagar|TS
515001|Head Post Office|Anantapur|Anantapuramu|AP
515134|Prasanthi Nilayam|Puttaparthi|Sri Sathya Sai|AP
515201||Hindupur|Sri Sathya Sai|AP
515411||Tadipatri|Anantapuramu|AP
515801||Guntakal|Anantapuramu|AP
516001|Head Post Office|Kadapa|YSR Kadapa|AP
516269||Rayachoti|Annamayya|AP
516360||Proddatur|YSR Kadapa|AP
516390||Pulivendula|YSR Kadapa|AP
517001|Head Post Office|Chittoor|Chittoor|AP
517325||Madanapalle|Annamayya|AP
517501|Head Post Office|Tirupati|Tirupati|AP
517504|Tirumala|Tirupati|Tirupati|AP
517644||Srikalahasti|Tirupati|AP
518001|Head Post Office|Kurnool|Kurnool|AP
518301||Adoni|Kurnool|AP
518360||Yemmiganur|Kurnool|AP
518501||Nandyal|Nandyal|AP
520001|One Town|Vijayawada|NTR|AP
520002|Governorpet|Vijayawada|NTR|AP
520007|Patamata|Vijayawada|NTR|AP
520010|Benz Circle|Vijayawada|NTR|AP
521001|Head Post Office|Machilipatnam|Krishna|AP
521101||Gannavaram|Krishna|AP
521175||Jaggayyapet|NTR|AP
521185||Nandigama|NTR|AP
521201||Nuzvid|Eluru|AP
521301||Gudivada|Krishna|AP
522001|Head Post Office|Guntur|Guntur|AP
522002|Arundelpet / Brodipet|Guntur|Guntur|AP
522101||Bapatla|Bapatla|AP
522124||Ponnur|Guntur|AP
522201|Head Post Office|Tenali|Guntur|AP
522265||Repalle|Bapatla|AP
522403||Sattenapalli|Palnadu|AP
522501||Tadepalli|Guntur|AP
522503||Mangalagiri|Guntur|AP
522601|Head Post Office|Narasaraopet|Palnadu|AP
522616||Chilakaluripet|Palnadu|AP
522647||Vinukonda|Palnadu|AP
523001|Head Post Office|Ongole|Prakasam|AP
523155||Chirala|Bapatla|AP
523316||Markapur|Prakasam|AP
524001|Head Post Office|Nellore|SPSR Nellore|AP
524101||Gudur|Tirupati|AP
524121||Sullurpeta|Tirupati|AP
524201||Kavali|SPSR Nellore|AP
530001|Head Post Office|Visakhapatnam|Visakhapatnam|AP
530016|Dwaraka Nagar|Visakhapatnam|Visakhapatnam|AP
530017|MVP Colony|Visakhapatnam|Visakhapatnam|AP
530026|Gajuwaka|Visakhapatnam|Visakhapatnam|AP
530048|Madhurawada|Visakhapatnam|Visakhapatnam|AP
531001||Anakapalle|Anakapalli|AP
532001|Head Post Office|Srikakulam|Srikakulam|AP
533001|Head Post Office|Kakinada|Kakinada|AP
533101|Head Post Office|Rajamahendravaram|East Godavari|AP
533201||Amalapuram|Dr. B.R. Ambedkar Konaseema|AP
533255||Ramachandrapuram|Dr. B.R. Ambedkar Konaseema|AP
533308||Mandapeta|Dr. B.R. Ambedkar Konaseema|AP
533401||Tuni|Kakinada|AP
533450||Peddapuram|Kakinada|AP
534001|Head Post Office|Eluru|Eluru|AP
534101||Tadepalligudem|West Godavari|AP
534201||Bhimavaram|West Godavari|AP
534211||Tanuku|West Godavari|AP
534260||Palakollu|West Godavari|AP
534275||Narsapur|West Godavari|AP
535001|Head Post Office|Vizianagaram|Vizianagaram|AP
535501||Parvathipuram|Parvathipuram Manyam|AP
"""
_PINS: dict[str, tuple[str | None, str, str, str]] = {}


def _load_pins() -> None:
    if _PINS:
        return
    for line in _PIN_TABLE.strip().splitlines():
        pin, area, city, district, st = line.split("|")
        _PINS[pin] = (area or None, city, district, st)


__all__ = ["router", "reg_settings", "field_rules", "capture_visit", "valid_aadhaar", "aadhaar_hash", "decode_secure_qr",
           "decode_xml_qr", "lookup_pincode", "dob_from_age", "age_ymd", "DEFAULTS"]
