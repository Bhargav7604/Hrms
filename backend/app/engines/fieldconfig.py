"""Field Configuration — per form/screen and per field: Visible, Required, Read-only, Editable after
create, default value, label rename, masking and order, layered Organization → Branch → Department →
Doctor (most specific wins), plus screen-level settings.

Every entity form is configurable (namespace = its fqn, e.g. "ipd.admissions"); /api/meta and the
record service apply the effective configuration automatically. Custom screens are registered here
(or from another engine with `register_screen(...)`) and read their effective configuration with

    GET /api/fieldconfig/screens/<screen>
      → {screen, label, namespace, scope, fields: {<key>: {visible, required, readonly, editable,
         hidden, label, default, mask, order, section}}, sections: [...], settings: {...}}

Screens with `personal=True` (OP clinical note / vitals / prescription) can also be arranged by each
doctor for themselves ("My Consultation Format" = the doctor scope).
Server-side checks for custom screens: `await check_screen(ctx, "registration", payload)`.
"""

from __future__ import annotations

import copy
import re
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel

from ..core.audit import audit
from ..core.config_store import (
    SCOPE_RANK, SCOPES, delete_layer, get_layer, load_layers, merge_fields, merge_values, normalize_props, put_layer,
    user_scope_ids,
)
from ..core.registry import all_entities, get_entity
from ..core.security import CtxDep
from ..core.util import bad_request, forbidden, humanize, is_uuid, not_found, to_json_value
from ..schema import config_entries, employees
from .settings import resolve_scope

router = APIRouter(prefix="/api/fieldconfig", tags=["fieldconfig"])

SCREENS: dict[str, dict] = {}
SKIP_TYPES = {"signature"}


def _f(key: str, label: str | None = None, **kw: Any) -> dict:
    return {"key": key, "label": label or humanize(key), **kw}


def register_screen(key: str, *, label: str, group: str = "General", icon: str = "LayoutList", entity: str | None = None,
                    description: str | None = None, personal: bool = False, sections: list[dict] | None = None,
                    settings: list[dict] | None = None) -> None:
    """Register a configurable screen. `entity` aliases the screen to that entity's form namespace, so the
    generic record form and the custom screen share one configuration. Section fields:
    {key, label, type?, visible?, required?, readonly?, editable?, default?, mask?, help?}.
    Settings: {key, label, type: boolean|number|text|select|multiselect, default, options?, help?}."""
    if not re.match(r"^[a-z][a-z0-9_.-]{1,60}$", key):
        raise ValueError(f"bad screen key {key}")
    SCREENS[key] = {"key": key, "label": label, "group": group, "icon": icon, "entity": entity,
                    "description": description, "personal": personal, "sections": sections or [], "settings": settings or []}


# ------------------------------------------------------------------ built-in screens

OPT = {"visible": False}  # shorthand: optional field that is off until a branch turns it on

register_screen(
    "registration", label="Patient Registration", group="Front office", icon="UserPlus", entity="registration.patients",
    description="The registration form at the front desk, the patient edit screen and QR pre-registration.",
    sections=[
        {"key": "category", "label": "Category & Sponsor", "icon": "Tags", "description": "Patient category and sponsorship details.",
         "fields": [_f("category", "Category"), _f("payer_type", "Payer type"), _f("sponsor", "Sponsor / TPA"),
                    _f("tags", "Patient tags"), _f("mlc_no", "MLC number")]},
        {"key": "organisation", "label": "Organisation Details", "icon": "Building2", "description": "Organisation and employment details.",
         "fields": [_f("org_scheme", "Organisation / scheme name", **OPT), _f("employee_name", "Employee name"),
                    _f("employee_ref", "Employee ID"), _f("employee_branch", "Employee branch"),
                    _f("dependent_relation", "Dependent relation", **OPT), _f("insurance_category", "Insurance category", **OPT),
                    _f("company_name", "Company name", **OPT)]},
        {"key": "financial", "label": "Financial Details", "icon": "IndianRupee", "description": "Financial and payment related fields.",
         "fields": [_f("credit_letter_no", "Credit letter no."), _f("credit_letter_validity", "Credit letter validity", type="date", **OPT),
                    _f("policy_no", "Policy no."), _f("insurance_card_no", "Insurance card no.", **OPT),
                    _f("discount_percent", "Discount %", type="percent")]},
        {"key": "identity", "label": "Identity & Demographics", "icon": "UserRound", "description": "Patient identity and demographic information.",
         "fields": [_f("salutation", "Title"), _f("first_name", "First name"), _f("middle_name", "Middle name"),
                    _f("last_name", "Last name"), _f("gender", "Gender"), _f("dob", "Date of birth"),
                    _f("age", "Age (years / months / days)"), _f("blood_group", "Blood group"), _f("marital_status", "Marital status"),
                    _f("occupation", "Occupation"), _f("religion", "Religion"), _f("guardian_relation", "Relation (S/W/D/B/O)"),
                    _f("guardian_name", "Guardian name"), _f("nationality", "Nationality")]},
        {"key": "contact", "label": "Contact", "icon": "Phone", "description": "How patient contact details are captured.",
         "fields": [_f("phone", "Mobile", mask=False), _f("alternate_phone", "Alternate mobile"), _f("email", "Email"),
                    _f("attender_name", "Attender name"), _f("attender_phone", "Attender mobile"),
                    _f("emergency_contact_name", "Emergency contact"), _f("emergency_contact_phone", "Emergency mobile"),
                    _f("emergency_contact_relation", "Emergency contact relation")]},
        {"key": "address", "label": "Address", "icon": "MapPin", "description": "Address related fields and requirements.",
         "fields": [_f("pincode", "Pincode"), _f("country", "Country", default="India"), _f("state", "State"),
                    _f("district", "District"), _f("city", "City"), _f("area", "Area / locality"), _f("address", "Address line")]},
        {"key": "documents", "label": "Identity Documents", "icon": "IdCard", "description": "Identity document fields and verification.",
         "fields": [_f("id_type", "ID type"), _f("id_number", "Aadhaar / ID number", mask=True), _f("pan", "PAN"),
                    _f("passport_no", "Passport"), _f("driving_licence", "Driving licence"), _f("voter_id", "Voter ID (EPIC)", **OPT),
                    _f("abha_id", "ABHA number"), _f("abha_address", "ABHA address")]},
        {"key": "family", "label": "Family Details", "icon": "Users", "description": "Family and next-of-kin information.",
         "fields": [_f("father_name", "Father name", **OPT), _f("mother_name", "Mother name", **OPT), _f("spouse_name", "Spouse name", **OPT),
                    _f("next_of_kin", "Next of kin", **OPT), _f("next_of_kin_relation", "Next of kin relation", **OPT),
                    _f("next_of_kin_phone", "Next of kin mobile", **OPT), _f("family_link", "Link to family", **OPT)]},
        {"key": "visit", "label": "Visit Details", "icon": "CalendarCheck", "description": "Visit and consultation captured at registration.",
         "fields": [_f("visit_type", "Visit type", default="New"), _f("visit_department", "Department", **OPT),
                    _f("consulting_doctor", "Consulting doctor"), _f("chief_complaint", "Chief complaint / visit reason")]},
        {"key": "referral", "label": "Referral Details", "icon": "Share2", "description": "Referral source related fields.",
         "fields": [_f("referral_category", "Referral category"), _f("referral_name", "Referral name"), _f("referral_remarks", "Remarks")]},
        {"key": "history", "label": "Medical History", "icon": "HeartPulse", "description": "Medical history captured at the desk.",
         "fields": [_f("allergies", "Allergies", **OPT), _f("chronic_conditions", "Chronic conditions", **OPT),
                    _f("current_medications", "Current medications", **OPT), _f("past_history", "Past medical history", **OPT)]},
        {"key": "consent", "label": "Consent", "icon": "ShieldCheck", "description": "Consent and communication preferences (DPDP).",
         "fields": [_f("consent_treatment", "Consent to treatment", type="boolean", **OPT),
                    _f("terms_accepted", "Terms & conditions accepted", type="boolean", **OPT),
                    _f("sms_opt_in", "SMS notifications opt-in", type="boolean", **OPT),
                    _f("whatsapp_opt_in", "WhatsApp notifications opt-in", type="boolean", **OPT)]},
        {"key": "photo", "label": "Photo & Edit Control", "icon": "Camera", "description": "Patient photo and supporting documents for edits.",
         "fields": [_f("photo", "Patient photo"), _f("edit_document", "Supporting document for edits"), _f("edit_reason", "Reason for edit")]},
    ],
    settings=[
        {"key": "collect_fee_on_submit", "label": "Collect registration fee on submit", "type": "boolean", "default": False},
        {"key": "registration_fee", "label": "Registration fee (₹)", "type": "number", "default": 100, "min": 0},
        {"key": "consult_billing_prompt", "label": "Ask to bill consultation when a doctor is chosen", "type": "boolean", "default": True},
        {"key": "family_linking", "label": "Enable family linking & family tree", "type": "boolean", "default": True},
        {"key": "duplicate_keys", "label": "Block registration when these match an existing patient", "type": "multiselect",
         "default": ["id_number", "abha_id"],
         "options": [{"value": "id_number", "label": "Aadhaar number"}, {"value": "abha_id", "label": "ABHA number"},
                     {"value": "phone+first_name", "label": "Mobile + first name"}, {"value": "phone+dob", "label": "Mobile + date of birth"},
                     {"value": "passport_no", "label": "Passport"}, {"value": "pan", "label": "PAN"}]},
        {"key": "edit_requires_document", "label": "Supporting document required for a UHID / patient edit", "type": "boolean",
         "default": False, "help": "On = the edit screen asks for a scan (letter, ID proof, affidavit) before it saves a change to "
                                   "a patient's details, and the server refuses the edit without one."},
        {"key": "autofocus_field", "label": "Cursor starts in this field on the registration form", "type": "field",
         "default": "first_name"},
    ],
)

register_screen(
    "op.clinical_note", label="OP Clinical Note", group="Outpatient", icon="NotebookPen", personal=True,
    description="The doctor's consultation note in OP EMR. Doctors can arrange it for themselves in My Consultation Format.",
    sections=[{"key": "general", "label": "General", "fields": [
        _f("chief_complaint", "Chief complaint"), _f("hpi", "History of present illness"), _f("examination", "Examination"),
        _f("assessment", "Assessment", **OPT), _f("diagnosis", "Diagnosis"), _f("icd_code", "ICD-10 code"),
        _f("plan", "Plan"), _f("advice", "Advice"), _f("follow_up_date", "Follow-up date"),
        _f("past_history", "Past medical history", **OPT), _f("family_history", "Family history", **OPT),
        _f("social_history", "Personal / social history", **OPT), _f("ros", "Review of systems", **OPT),
        _f("allergies_note", "Allergies (note)", **OPT), _f("current_medications", "Current medications", **OPT),
        _f("provisional_diagnosis", "Provisional diagnosis", **OPT), _f("differential_diagnosis", "Differential diagnosis", **OPT),
        _f("investigations_advised", "Investigations advised", **OPT), _f("referred_to", "Cross-refer to department", **OPT),
    ]}],
)

register_screen(
    "op.vitals", label="OP Vitals", group="Outpatient", icon="Activity", personal=True,
    description="Vitals captured by the OP nurse and shown on the doctor's screen.",
    sections=[{"key": "vitals", "label": "Vitals", "fields": [
        _f("temperature", "Temperature (°F)"), _f("pulse", "Pulse (bpm)"), _f("resp_rate", "Respiratory rate"),
        _f("bp_systolic", "BP systolic"), _f("bp_diastolic", "BP diastolic"), _f("spo2", "SpO2 (%)"),
        _f("pain_score", "Pain score (0–10)"), _f("weight", "Weight (kg)"), _f("height", "Height (cm)"), _f("bmi", "BMI", readonly=True),
        _f("blood_sugar", "Blood sugar (CBG)", **OPT), _f("o2_support", "Oxygen support", **OPT), _f("gcs", "GCS", **OPT),
        _f("head_circumference", "Head circumference (cm)", **OPT), _f("muac", "MUAC (cm)", **OPT),
        _f("waist", "Waist circumference (cm)", **OPT), _f("lmp", "LMP", type="date", **OPT),
    ]}],
)

register_screen(
    "op.prescription", label="OP Prescription", group="Outpatient", icon="Pill", personal=True,
    description="Prescription lines and the printed footer.",
    sections=[
        {"key": "line", "label": "Medicine line", "fields": [
            _f("drug", "Drug"), _f("dose", "Dose"), _f("route", "Route", default="Oral"), _f("frequency", "Frequency"),
            _f("duration_days", "Days"), _f("qty", "Quantity"), _f("instructions", "Instructions"),
            _f("start_date", "Start date", **OPT), _f("generic_only", "Substitute with generic", type="boolean", **OPT)]},
        {"key": "footer", "label": "Footer", "fields": [
            _f("advice", "Advice"), _f("diet_advice", "Diet advice", **OPT), _f("follow_up_date", "Follow-up date"),
            _f("review_with_reports", "Review with reports"), _f("next_visit_tests", "Tests before next visit", **OPT)]},
    ],
)

register_screen(
    "op.billing", label="OP Billing", group="Outpatient", icon="Receipt",
    description="The OP billing counter (services, consultation, payments).",
    sections=[{"key": "bill", "label": "Bill header", "fields": [
        _f("payer", "Payer"), _f("sponsor", "Sponsor / TPA"), _f("referral_doctor", "Referring doctor"),
        _f("ordering_doctor", "Ordering doctor"), _f("remarks", "Remarks"), _f("discount_reason", "Discount reason"),
        _f("authorised_by", "Discount authorised by", **OPT)]},
        {"key": "payment", "label": "Payment", "fields": [
            _f("payment_mode", "Payment mode", default="CASH"), _f("reference_no", "Transaction / UTR no."),
            _f("card_last4", "Card last 4 digits", **OPT), _f("payer_name", "Paid by", **OPT)]}],
    settings=[
        {"key": "allow_line_discount", "label": "Allow line-level discounts", "type": "boolean", "default": True},
        {"key": "max_discount_percent", "label": "Discount above this % needs approval", "type": "number", "default": 10, "min": 0, "max": 100},
        {"key": "print_on_save", "label": "Print the bill automatically on save", "type": "boolean", "default": True},
        {"key": "default_payment_mode", "label": "Default payment mode", "type": "select", "default": "CASH",
         "options": ["CASH", "CARD", "UPI", "WALLET", "BANK"]},
    ],
)

register_screen("ip.admission", label="IP Admission", group="Inpatient", icon="BedDouble", entity="ipd.admissions",
                description="The admission form (sponsor, consultant, bed, package).",
                settings=[{"key": "deposit_mandatory", "label": "Deposit must be collected before admission", "type": "boolean", "default": False},
                          {"key": "second_consultant", "label": "Ask for a second consultant", "type": "boolean", "default": False}])
register_screen("appointments", label="Appointments", group="Front office", icon="CalendarDays", entity="appointments.appointments",
                description="Booking an OP appointment.")
register_screen("dialysis", label="Dialysis", group="Specialty", icon="Droplets", entity="dialysis.sessions",
                description="Dialysis check-in, session record and check-out.")
register_screen("asset.registration", label="Asset Registration", group="Operations", icon="Wrench", entity="assets.assets",
                description="Registering a biomedical or general asset.")


# ------------------------------------------------------------------ definitions

def _base_field(spec: dict, ent_field: Any | None) -> dict:
    """Base (default) state of a field before any configuration."""
    sys_required = bool(ent_field and ent_field.required)
    sys_readonly = bool(ent_field and ent_field.readonly)
    return {
        "key": spec["key"], "label": spec.get("label") or (ent_field.label if ent_field else humanize(spec["key"])),
        "type": spec.get("type") or (ent_field.type if ent_field else "text"),
        "visible": spec.get("visible", True) if not (ent_field and ent_field.hidden) else False,
        "required": bool(spec.get("required")) or sys_required,
        "readonly": bool(spec.get("readonly")) or sys_readonly,
        "editable": spec.get("editable", True), "default": spec.get("default", ent_field.default if ent_field else None),
        "mask": bool(spec.get("mask")), "system_required": sys_required, "system_readonly": sys_readonly,
        "help": spec.get("help") or (ent_field.help if ent_field else None),
    }


def form_definition(form: str) -> dict:
    """{key, label, namespace, kind, sections: [{key, label, fields: [base field]}], settings: [...]}"""
    scr = SCREENS.get(form)
    ent = get_entity(scr["entity"] if scr and scr.get("entity") else form)
    if not scr and not ent:
        raise not_found(f"Unknown form {form}")
    ent_fields = {f.key: f for f in ent.fields} if ent else {}
    sections: list[dict] = []
    seen: set[str] = set()
    for sec in (scr or {}).get("sections", []):
        fields = []
        for spec in sec["fields"]:
            if spec["key"] in seen:
                continue
            seen.add(spec["key"])
            fields.append(_base_field(spec, ent_fields.get(spec["key"])))
        sections.append({k: v for k, v in sec.items() if k != "fields"} | {"fields": fields})
    if ent:
        rest = [f for f in ent.fields if f.key not in seen and not f.hidden and f.type not in SKIP_TYPES]
        if rest:
            sections.append({"key": "fields" if not sections else "other", "label": ent.label if not sections else "Other fields",
                             "description": None if not sections else "Fields of the record form not placed in a section above.",
                             "icon": ent.icon or "LayoutList",
                             "fields": [_base_field({"key": f.key}, f) for f in rest]})
    return {
        "key": form, "label": scr["label"] if scr else f"{ent.label} ({ent.module.name})",
        "namespace": ent.fqn if ent else form, "kind": "screen" if scr else "entity",
        "group": scr["group"] if scr else ent.module.name, "icon": (scr or {}).get("icon") or (ent.icon if ent else None) or ent.module.icon,
        "description": (scr or {}).get("description") or (ent.d.description if ent else None),
        "personal": bool((scr or {}).get("personal")), "entity": ent.fqn if ent else None,
        "sections": sections, "settings": copy.deepcopy((scr or {}).get("settings", [])),
    }


def _resolve_form(form: str) -> dict:
    if form in SCREENS:
        return form_definition(form)
    # an entity whose namespace is owned by a screen resolves to that screen
    for k, s in SCREENS.items():
        if s.get("entity") == form:
            return form_definition(k)
    return form_definition(form)


def effective(defn: dict, overrides: dict[str, dict]) -> tuple[dict[str, dict], list[dict]]:
    """Apply merged overrides to the base fields → (fields by key, sections with ordered keys)."""
    fields: dict[str, dict] = {}
    sections = []
    for sec in defn["sections"]:
        keys = []
        for i, base in enumerate(sec["fields"]):
            o = overrides.get(base["key"]) or {}
            visible = o.get("visible", base["visible"])
            if base["system_required"]:
                visible = True
            required = base["system_required"] or bool(o.get("required", base["required"]))
            readonly = base["system_readonly"] or bool(o.get("readonly", base["readonly"]))
            fields[base["key"]] = {
                "visible": bool(visible), "hidden": not visible, "required": required and bool(visible) and not readonly,
                "readonly": readonly, "editable": bool(o.get("editable", base["editable"])),
                "label": o.get("label") or base["label"], "default": o.get("default", base["default"]),
                "mask": bool(o.get("mask", base["mask"])), "order": o.get("order", i), "section": sec["key"],
            }
            keys.append(base["key"])
        pos = {k: i for i, k in enumerate(keys)}
        keys.sort(key=lambda k: (fields[k]["order"], pos[k]))
        sections.append({"key": sec["key"], "label": sec["label"], "description": sec.get("description"),
                         "icon": sec.get("icon"), "fields": keys})
    return fields, sections


def _settings_defaults(defn: dict) -> dict:
    return {s["key"]: s.get("default") for s in defn["settings"]}


async def _chain_below(ctx, scope: str, scope_id: str) -> list[tuple[str, str]]:
    """The less specific layers a given scope target inherits from."""
    chain: list[tuple[str, str]] = [("org", "")]
    mine = dict(await user_scope_ids(ctx))
    if SCOPE_RANK[scope] > SCOPE_RANK["branch"]:
        chain.append(("branch", mine.get("branch", "")))
    if scope == "doctor" and is_uuid(scope_id):
        dept = (await ctx.conn.execute(sa.select(employees.c.department_id).where(employees.c.id == scope_id))).scalar()
        if dept:
            chain.append(("department", str(dept)))
    return chain if scope != "org" else []


# ------------------------------------------------------------------ public helpers for engines

async def screen_config(ctx, screen: str) -> dict:
    defn = _resolve_form(screen)
    layers = (await load_layers(ctx, "fieldconfig", [defn["namespace"]])).get(defn["namespace"], [])
    overrides, scope = merge_fields(layers)
    fields, sections = effective(defn, overrides)
    slayers = (await load_layers(ctx, "settings", [f"screen.{defn['key']}"])).get(f"screen.{defn['key']}", [])
    svalues, sscope = merge_values(slayers)
    scope = max([s for s in (scope, sscope) if s], key=lambda s: SCOPE_RANK[s], default=None)
    return {"screen": defn["key"], "label": defn["label"], "namespace": defn["namespace"], "personal": defn["personal"],
            "scope": scope or "default", "fields": fields, "sections": sections,
            "settings": {**_settings_defaults(defn), **svalues}}


async def check_screen(ctx, screen: str, payload: dict, *, creating: bool = True) -> dict:
    """Server-side enforcement for custom screens: drops hidden / read-only (and, on edit, non-editable)
    values, fills configured defaults and raises 400 for missing required fields. Returns the cleaned payload."""
    cfg = await screen_config(ctx, screen)
    out = dict(payload)
    errors: dict[str, str] = {}
    for key, f in cfg["fields"].items():
        if f["hidden"] or f["readonly"] or (not creating and not f["editable"]):
            out.pop(key, None)
            if creating and f["default"] not in (None, ""):
                out[key] = f["default"]
            continue
        if creating and out.get(key) in (None, "", []) and f["default"] not in (None, ""):
            out[key] = f["default"]
        if f["required"] and (creating or key in out) and out.get(key) in (None, "", []):
            errors[key] = f"{f['label']} is required"
    if errors:
        raise bad_request("Please fix the highlighted fields", {"fields": errors})
    return out


# ------------------------------------------------------------------ endpoints

@router.get("/screens/{screen}")
async def get_screen(screen: str, ctx: CtxDep):
    """Effective configuration of a screen (or entity form) for the signed-in user."""
    if screen not in SCREENS and not get_entity(screen):
        raise not_found(f"No field configuration for screen {screen}")
    return await screen_config(ctx, screen)


@router.get("/forms")
async def list_forms(ctx: CtxDep):
    aliased = {s["entity"] for s in SCREENS.values() if s.get("entity")}
    configured = {r.namespace: r.n for r in (await ctx.conn.execute(
        sa.select(config_entries.c.namespace, sa.func.count().label("n")).where(config_entries.c.kind == "fieldconfig")
        .group_by(config_entries.c.namespace))).all()}
    screens = []
    for s in SCREENS.values():
        d = form_definition(s["key"])
        screens.append({"key": s["key"], "label": s["label"], "group": s["group"], "icon": s["icon"], "personal": s["personal"],
                        "sections": len(d["sections"]), "fields": sum(len(x["fields"]) for x in d["sections"]),
                        "settings": len(d["settings"]), "layers": configured.get(d["namespace"], 0)})
    entities = [{"key": e.fqn, "label": e.label, "module": e.module.name, "module_id": e.module_id, "icon": e.icon or e.module.icon,
                 "fields": sum(1 for f in e.fields if not f.hidden), "layers": configured.get(e.fqn, 0)}
                for e in all_entities() if e.fqn not in aliased and not e.readonly]
    return {"screens": screens, "entities": entities, "scopes": list(SCOPES[:4])}


@router.get("/forms/{form}")
async def get_form(form: str, ctx: CtxDep, scope: str = "branch", scope_id: str | None = None):
    defn = _resolve_form(form)
    scope, sid = await resolve_scope(ctx, scope, scope_id)
    _ensure_read(ctx, defn, scope, sid)
    ns = defn["namespace"]
    layer = await get_layer(ctx.conn, "fieldconfig", ns, scope, sid)
    below = await _chain_below(ctx, scope, sid)
    inherited, _ = merge_fields((await load_layers(ctx, "fieldconfig", [ns], below)).get(ns, []))
    own = ((layer or {}).get("value") or {}).get("fields") or {}
    fields, sections = effective(defn, _merge(inherited, own))
    inherited_fields, _ = effective(defn, inherited)
    s_ns = f"screen.{defn['key']}"
    s_layer = await get_layer(ctx.conn, "settings", s_ns, scope, sid)
    s_inh, _ = merge_values((await load_layers(ctx, "settings", [s_ns], below)).get(s_ns, []))
    s_own = (s_layer or {}).get("value") or {}
    stored = (await ctx.conn.execute(sa.select(config_entries.c.scope, config_entries.c.scope_id, config_entries.c.updated_at)
                                     .where(config_entries.c.namespace.in_([ns, s_ns])))).all()
    return {
        **{k: v for k, v in defn.items() if k != "sections"},
        "sections": [{**s, "fields": [{**next(b for b in ds["fields"] if b["key"] == k), "effective": fields[k],
                                        "inherited": inherited_fields[k], "override": own.get(k) or {}} for k in s["fields"]]}
                     for s, ds in zip(sections, defn["sections"], strict=True)],
        "scope": scope, "scope_id": sid,
        "settings_values": {**_settings_defaults(defn), **s_inh, **s_own}, "settings_override": s_own,
        "settings_inherited": {**_settings_defaults(defn), **s_inh},
        "updated_at": to_json_value((layer or {}).get("updated_at")), "updated_by": (layer or {}).get("updated_by"),
        "layers": [{"scope": r.scope, "scope_id": r.scope_id, "updated_at": to_json_value(r.updated_at)} for r in stored],
        "can_edit": _can_edit(ctx, defn, scope, sid),
    }


def _merge(a: dict[str, dict], b: dict[str, dict]) -> dict[str, dict]:
    out = {k: dict(v) for k, v in a.items()}
    for k, v in b.items():
        out.setdefault(k, {}).update({p: x for p, x in v.items() if x is not None})
    return out


def _can_edit(ctx, defn: dict, scope: str, sid: str) -> bool:
    if ctx.role == "admin":
        return True
    return defn["personal"] and scope == "doctor" and bool(ctx.user.get("employee_id")) and sid == ctx.user.get("employee_id")


def _ensure_read(ctx, defn: dict, scope: str, sid: str) -> None:
    if ctx.role in ("admin", "management") or _can_edit(ctx, defn, scope, sid):
        return
    if defn["personal"] and scope == "doctor":
        raise forbidden("You can only open your own consultation format")
    raise forbidden("Only an administrator can open field configuration")


class FormIn(BaseModel):
    scope: str = "branch"
    scope_id: str | None = None
    fields: dict[str, dict[str, Any] | None] = {}
    settings: dict[str, Any] | None = None


@router.put("/forms/{form}")
async def put_form(form: str, body: FormIn, ctx: CtxDep):
    defn = _resolve_form(form)
    scope, sid = await resolve_scope(ctx, body.scope, body.scope_id)
    if not _can_edit(ctx, defn, scope, sid):
        raise forbidden("You cannot change this configuration")
    if scope == "user":
        raise bad_request("Field configuration is set per organisation, branch, department or doctor")
    known = {f["key"]: f for s in defn["sections"] for f in s["fields"]}
    ns = defn["namespace"]
    prev = ((await get_layer(ctx.conn, "fieldconfig", ns, scope, sid)) or {}).get("value") or {}
    cur = {k: dict(v) for k, v in (prev.get("fields") or {}).items()}
    for key, props in body.fields.items():
        if key not in known:
            raise bad_request(f"Unknown field {key}")
        if props is None:
            cur.pop(key, None)
            continue
        p = normalize_props(props)
        if known[key]["system_required"]:
            p.pop("visible", None)  # system-required fields cannot be hidden
        if not ctx.role == "admin":  # doctors arrange their own screen: show/hide, rename, reorder only
            p = {k: v for k, v in p.items() if k in ("visible", "label", "order")}
        merged = {**cur.get(key, {}), **p}
        merged = {k: v for k, v in merged.items() if v is not None}
        if merged:
            cur[key] = merged
        else:
            cur.pop(key, None)
    value = {**prev, "fields": cur}
    if cur:
        await put_layer(ctx.conn, "fieldconfig", ns, scope, sid, value, ctx.user_id)
    else:
        await delete_layer(ctx.conn, "fieldconfig", ns, scope, sid)
    if body.settings is not None:
        if ctx.role != "admin":
            raise forbidden("Only an administrator can change screen settings")
        s_ns = f"screen.{defn['key']}"
        allowed = {s["key"] for s in defn["settings"]}
        bad = [k for k in body.settings if k not in allowed]
        if bad:
            raise bad_request(f"Unknown settings {bad}")
        s_prev = ((await get_layer(ctx.conn, "settings", s_ns, scope, sid)) or {}).get("value") or {}
        s_cur = {**s_prev, **{k: v for k, v in body.settings.items() if v is not None}}
        for k, v in body.settings.items():
            if v is None:
                s_cur.pop(k, None)
        await put_layer(ctx.conn, "settings", s_ns, scope, sid, s_cur, ctx.user_id)
    await audit(ctx, "fieldconfig.update", module="settings", entity=ns, before={"fields": {k: (prev.get("fields") or {}).get(k) for k in body.fields}},
                after={"fields": {k: cur.get(k) for k in body.fields}, **({"settings": body.settings} if body.settings else {})},
                note=f"{defn['label']} · {scope}:{sid or 'org'}")
    return await get_form(form, ctx, scope, sid)


@router.delete("/forms/{form}")
async def reset_form(form: str, ctx: CtxDep, scope: str = "branch", scope_id: str | None = None, section: str | None = None):
    """Reset to default: drop this scope's overrides (optionally only one section's fields)."""
    defn = _resolve_form(form)
    scope, sid = await resolve_scope(ctx, scope, scope_id)
    if not _can_edit(ctx, defn, scope, sid):
        raise forbidden("You cannot change this configuration")
    ns = defn["namespace"]
    if section:
        sec = next((s for s in defn["sections"] if s["key"] == section), None)
        if not sec:
            raise bad_request(f"Unknown section {section}")
        prev = ((await get_layer(ctx.conn, "fieldconfig", ns, scope, sid)) or {}).get("value") or {}
        keys = {f["key"] for f in sec["fields"]}
        cur = {k: v for k, v in (prev.get("fields") or {}).items() if k not in keys}
        if cur:
            await put_layer(ctx.conn, "fieldconfig", ns, scope, sid, {**prev, "fields": cur}, ctx.user_id)
        else:
            await delete_layer(ctx.conn, "fieldconfig", ns, scope, sid)
    else:
        await delete_layer(ctx.conn, "fieldconfig", ns, scope, sid)
        if ctx.role == "admin":
            await delete_layer(ctx.conn, "settings", f"screen.{defn['key']}", scope, sid)
    await audit(ctx, "fieldconfig.reset", module="settings", entity=ns, note=f"{defn['label']} · {scope}:{sid or 'org'}"
                + (f" · section {section}" if section else ""))
    return await get_form(form, ctx, scope, sid)


class CopyIn(BaseModel):
    from_branch: str
    to_branch: str | None = None
    forms: list[str] | None = None  # default: every form configured in the source branch


@router.post("/copy")
async def copy_from_branch(body: CopyIn, ctx: CtxDep):
    """Copy a branch's field configuration and screen settings onto another branch (replacing it)."""
    if ctx.role != "admin":
        raise forbidden("Only an administrator can copy configuration")
    src = body.from_branch
    dst = body.to_branch or ctx.branch
    if not dst or src == dst:
        raise bad_request("Choose a different branch to copy from")
    if dst not in (ctx.user.get("branches") or []) or src not in (ctx.user.get("branches") or []):
        raise forbidden("Unknown branch")
    t = config_entries
    namespaces = None
    if body.forms:
        defs = [_resolve_form(f) for f in body.forms]
        namespaces = [d["namespace"] for d in defs] + [f"screen.{d['key']}" for d in defs]
    conds = [t.c.scope == "branch", t.c.scope_id == src,
             sa.or_(t.c.kind == "fieldconfig", sa.and_(t.c.kind == "settings", t.c.namespace.like("screen.%")))]
    if namespaces:
        conds.append(t.c.namespace.in_(namespaces))
    rows = (await ctx.conn.execute(sa.select(t.c.kind, t.c.namespace, t.c.value).where(*conds))).all()
    for r in rows:
        await put_layer(ctx.conn, r.kind, r.namespace, "branch", dst, r.value, ctx.user_id)
    await audit(ctx, "fieldconfig.copy", module="settings", note=f"{src} → {dst}: {len(rows)} layers")
    return {"ok": True, "copied": len(rows), "from": src, "to": dst}


@router.get("/summary")
async def summary(ctx: CtxDep):
    """Which forms have overrides at which scopes (admin overview)."""
    if ctx.role not in ("admin", "management"):
        raise forbidden()
    t = config_entries
    rows = (await ctx.conn.execute(sa.select(t.c.kind, t.c.namespace, t.c.scope, t.c.scope_id, t.c.updated_at, t.c.updated_by)
                                   .order_by(t.c.updated_at.desc()).limit(500))).all()
    return [{k: to_json_value(v) for k, v in r._mapping.items()} for r in rows]
