"""Infection control suite: CLABSI, CAUTI and VAP care-bundle checklists (the SSI bundle is the OT sheet
``ot.ssi_bundle``, also listed here). Signed checklists are posted to Infection Surveillance › Bundle Audits."""

from ..dsl import calc, compliance_bands, date, dt, num, score, section, seg, sel, ta, text, yn

N = ["nurse", "doctor", "quality"]
VIEW = ["doctor", "nurse", "quality"]


def el(key: str, label: str, show_if: dict | None = None) -> dict:
    return yn(f"el_{key}", label, na=True, show_if=show_if, required=True)


INS = {"field": "audit_type", "eq": "Insertion"}
MAINT = {"field": "audit_type", "eq": "Maintenance"}

CLABSI_EL = [
    el("hh_ins", "Hand hygiene before procedure", INS), el("barrier", "Maximal sterile barrier precautions", INS),
    el("chg_prep", "Chlorhexidine-alcohol skin prep", INS), el("site", "Optimal site (avoid femoral)", INS),
    el("usg", "Ultrasound guidance used", INS), el("checklist", "Insertion checklist with trained observer", INS),
    el("hh_maint", "Hand hygiene before line access", MAINT), el("necessity", "Daily review of line / catheter necessity", MAINT),
    el("dressing", "Dressing clean, dry, intact and dated", MAINT), el("hub", "Hub disinfection before access", MAINT),
    el("sets", "Administration sets changed as per policy", MAINT), el("chg_bath", "Daily chlorhexidine bathing", MAINT),
]
CLABSI = {
    "key": "infection.clabsi", "suite": "infection", "title": "CLABSI Bundle Checklist", "short": "CLABSI", "icon": "Syringe", "order": 1,
    "roles": N, "view_roles": VIEW, "multi_entry": True, "summary": ["audit_type", "line_type"],
    "description": "Central line insertion and maintenance bundle — all-or-none compliance.",
    "mirror": [{"kind": "bundle", "options": {"by": "audit_type", "map": {"Insertion": "CLABSI — insertion", "Maintenance": "CLABSI — maintenance"}}}],
    "sections": [
        section("Device", dt(), seg("audit_type", "Audit", ["Insertion", "Maintenance"], required=True, default="Maintenance"),
                {"key": "ward", "label": "Ward", "type": "ward", "required": True, "prefill": "admission.ward_id"},
                sel("line_type", "Line", ["Non-tunnelled CVC", "Tunnelled CVC", "PICC", "Dialysis catheter", "Implanted port"], required=True),
                sel("line_site", "Site", ["Right internal jugular", "Left internal jugular", "Right subclavian", "Left subclavian", "Right femoral",
                                          "Left femoral", "Basilic / cephalic (PICC)"]),
                date("inserted_on", "Inserted on"), calc("device_day", "Device day", "days_since", ["inserted_on"], decimals=0), tone="blue"),
        section("Bundle elements", *CLABSI_EL, tone="green"),
        section("Actions", ta("corrective_action", "Corrective action", rows=2), tone="amber"),
    ],
    "score": score([f["key"] for f in CLABSI_EL], "Compliance", method="percent_yes", lo=0, hi=100, unit="%"),
    "bands": compliance_bands(),
}

CAUTI_EL = [
    el("indication", "Indication appropriate as per protocol", INS), el("hh_ins", "Hand hygiene before procedure", INS),
    el("aseptic", "Aseptic insertion technique", INS), el("secured", "Catheter secured", INS),
    el("hh_maint", "Hand hygiene before handling catheter", MAINT), el("necessity", "Daily review of line / catheter necessity", MAINT),
    el("closed", "Closed drainage system maintained", MAINT), el("bag", "Urine bag below bladder level, off floor", MAINT),
    el("flow", "Unobstructed flow, no kinks", MAINT), el("meatal", "Meatal / perineal hygiene done", MAINT),
]
CAUTI = {
    "key": "infection.cauti", "suite": "infection", "title": "CAUTI Bundle Checklist", "short": "CAUTI", "icon": "Droplets", "order": 2,
    "roles": N, "view_roles": VIEW, "multi_entry": True, "summary": ["audit_type", "catheter_type"],
    "description": "Urinary catheter insertion and maintenance bundle.",
    "mirror": [{"kind": "bundle", "options": {"by": "audit_type", "map": {"Insertion": "CAUTI — insertion", "Maintenance": "CAUTI — maintenance"}}}],
    "sections": [
        section("Device", dt(), seg("audit_type", "Audit", ["Insertion", "Maintenance"], required=True, default="Maintenance"),
                {"key": "ward", "label": "Ward", "type": "ward", "required": True, "prefill": "admission.ward_id"},
                sel("catheter_type", "Catheter", ["Foley 2-way", "Foley 3-way", "Silicone Foley", "Suprapubic", "Condom catheter"], required=True),
                num("catheter_size", "Size", "Fr", 6, 30), date("inserted_on", "Inserted on"),
                calc("device_day", "Device day", "days_since", ["inserted_on"], decimals=0), tone="blue"),
        section("Bundle elements", *CAUTI_EL, tone="green"),
        section("Actions", ta("corrective_action", "Corrective action", rows=2), tone="amber"),
    ],
    "score": score([f["key"] for f in CAUTI_EL], "Compliance", method="percent_yes", lo=0, hi=100, unit="%"),
    "bands": compliance_bands(),
}

VAP_EL = [
    el("hob", "Head of bed elevated 30–45°"), el("sat_sbt", "Daily sedation vacation and SBT"),
    el("oral_care", "Oral care with chlorhexidine"), el("pud", "Peptic ulcer prophylaxis"), el("dvt", "DVT prophylaxis"),
    el("cuff", "ETT cuff pressure 20–30 cmH2O"), el("ssd", "Subglottic suction"), el("hh", "Hand hygiene before procedure"),
    el("circuit", "Ventilator circuit changed only when soiled"),
]
VAP = {
    "key": "infection.vap", "suite": "infection", "title": "VAP Bundle Checklist", "short": "VAP", "icon": "Wind", "order": 3, "roles": N, "view_roles": VIEW,
    "multi_entry": True, "summary": ["airway"],
    "description": "Ventilator-associated pneumonia prevention bundle — daily for every ventilated patient.",
    "mirror": [{"kind": "bundle", "options": {"bundle": "VAP"}}],
    "sections": [
        section("Device", dt(), {"key": "ward", "label": "Ward", "type": "ward", "required": True, "prefill": "admission.ward_id"},
                sel("airway", "Airway", ["Endotracheal tube", "Tracheostomy"], required=True), date("ventilated_since", "Ventilated since"),
                calc("device_day", "Ventilator day", "days_since", ["ventilated_since"], decimals=0),
                text("ventilator_mode", "Mode / settings", placeholder="e.g. SIMV-VC, FiO₂ 0.4, PEEP 6"), tone="blue"),
        section("Bundle elements", *VAP_EL, tone="green"),
        section("Actions", ta("corrective_action", "Corrective action", rows=2), tone="amber"),
    ],
    "score": score([f["key"] for f in VAP_EL], "Compliance", method="percent_yes", lo=0, hi=100, unit="%"),
    "bands": compliance_bands(),
}

FORMS = [CLABSI, CAUTI, VAP]
