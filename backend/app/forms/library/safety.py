"""Patient safety suite: fall, pressure injury and medication-error reports (posted to Patient Safety › Incidents when
signed), restraint monitoring, transfusion monitoring / reaction and the high-alert medication double check."""

from ..dsl import (
    BLOOD_GROUPS,
    band,
    compliance_bands,
    doctor,
    dt,
    lines,
    multi,
    num,
    nurse,
    score,
    section,
    seg,
    sel,
    ta,
    text,
    time,
    when,
    yn,
)

ALL = ["nurse", "doctor", "quality"]
VIEW = ["doctor", "nurse", "quality"]
HARM = ["No Harm", "Mild", "Moderate", "Severe", "Sentinel Event"]

FALL = {
    "key": "safety.fall_incident", "suite": "safety", "title": "Fall Incident & Post-fall Assessment", "short": "Fall incident",
    "icon": "PersonStanding", "order": 1, "roles": ALL, "view_roles": VIEW, "multi_entry": True, "summary": ["injury", "harm"],
    "description": "Immediate post-fall assessment and incident report — posted to Patient Safety incidents for review.",
    "mirror": [{"kind": "incident", "options": {"incident_type": "Fall"}}],
    "sections": [
        section("Event", dt("occurred_at", "Fall occurred at", required=True), text("location", "Location", required=True, prefill="admission.location"),
                seg("witnessed", "Witnessed", ["Yes", "No"], required=True),
                sel("found_position", "Found", ["On floor beside bed", "In bathroom", "In corridor", "Slid from chair", "Assisted to floor", "Other"]),
                sel("activity", "Activity at the time", ["Getting out of bed", "Walking", "Toileting", "Transferring", "Reaching", "Unknown"]),
                num("pre_fall_morse", "Last Morse score before the fall", None, 0, 125, prefill="score:nursing.morse"), tone="amber"),
        section("Post-fall assessment",
                seg("injury", "Injury", ["None", "Minor (bruise / abrasion)", "Major (fracture / head injury / bleed)", "Death"], required=True),
                ta("injury_details", "Injury details", rows=2, show_if=when("injury", ne="None")),
                yn("head_strike", "Head strike suspected", required=True),
                num("gcs", "GCS after fall", None, 3, 15), num("pulse", "Pulse", "bpm", 0, 300), num("bp_sys", "BP systolic", "mmHg", 0, 300),
                num("bp_dia", "BP diastolic", "mmHg", 0, 200), num("spo2", "SpO₂", "%", 0, 100), num("grbs", "GRBS", "mg/dL", 10, 900),
                yn("neuro_obs_started", "Neuro observations started", show_if=when("head_strike", eq="Yes")),
                tone="red"),
        section("Response", doctor("doctor_informed", "Doctor informed", required=True), time("doctor_informed_at", "Informed at"),
                yn("family_informed", "Family informed", required=True),
                multi("contributing", "Contributing factors", ["Sedation / medication", "Postural hypotension", "Confusion / delirium", "Wet floor",
                                                               "Poor lighting", "Bed rails down", "Call bell out of reach", "Inappropriate footwear",
                                                               "No attendant", "Unfamiliar environment"]),
                ta("immediate_action", "Immediate action taken", rows=2, required=True), sel("harm", "Harm severity", HARM, required=True),
                tone="blue"),
    ],
}

PRESSURE = {
    "key": "safety.pressure_injury", "suite": "safety", "title": "Pressure Injury Report", "short": "Pressure injury", "icon": "Bandage",
    "order": 2, "roles": ALL, "view_roles": VIEW, "multi_entry": True, "summary": ["site", "stage"],
    "description": "Pressure injury staging (NPIAP) and wound description; hospital-acquired injuries are reported as incidents.",
    "mirror": [{"kind": "incident", "when": {"field": "present_on_admission", "eq": "No"}, "options": {"incident_type": "Pressure Injury"}}],
    "sections": [
        section("Injury", dt("occurred_at", "Identified at", required=True),
                sel("site", "Site", ["Sacrum / coccyx", "Right heel", "Left heel", "Right ischium", "Left ischium", "Right trochanter", "Left trochanter",
                                     "Occiput", "Ear", "Elbow", "Device-related (nose / face)", "Other"], required=True),
                sel("stage", "Stage (NPIAP)", ["Stage 1", "Stage 2", "Stage 3", "Stage 4", "Unstageable", "Deep tissue injury", "Medical device related",
                                               "Mucosal membrane"], required=True),
                seg("present_on_admission", "Present on admission", ["Yes", "No"], required=True),
                num("length_cm", "Length", "cm", 0, 50, step=0.1), num("width_cm", "Width", "cm", 0, 50, step=0.1), num("depth_cm", "Depth", "cm", 0, 20, step=0.1),
                sel("wound_bed", "Wound bed", ["Epithelial", "Granulation", "Slough", "Eschar", "Mixed"]),
                sel("exudate", "Exudate", ["None", "Light", "Moderate", "Heavy"]), text("surrounding_skin", "Surrounding skin"),
                num("braden", "Braden score at detection", None, 6, 23, prefill="score:nursing.braden"), tone="amber"),
        section("Plan", multi("interventions", "Interventions", ["2-hourly repositioning", "Air mattress", "Heel off-loading", "Dressing applied",
                                                                 "Wound care nurse referral", "Dietitian referral", "Plastic surgery referral"]),
                text("dressing", "Dressing used"), ta("immediate_action", "Immediate action taken", rows=2, required=True),
                sel("harm", "Harm severity", HARM, default="Mild"), tone="green"),
    ],
}

MED_ERROR = {
    "key": "safety.medication_error", "suite": "safety", "title": "Medication Error Report", "short": "Medication error", "icon": "PillBottle",
    "order": 3, "roles": ALL + ["pharmacist"], "view_roles": VIEW + ["pharmacist"], "multi_entry": True, "summary": ["error_type", "ncc_merp_category"],
    "description": "Non-punitive medication error / near-miss report with NCC MERP category.",
    "mirror": [{"kind": "incident", "options": {"incident_type": "Medication Error"}}],
    "sections": [
        section("Error", dt("occurred_at", "Occurred at", required=True), text("location", "Location", required=True, prefill="admission.location"),
                {"key": "drug", "label": "Drug involved", "type": "drug"}, text("drug_name", "Drug (free text)"),
                sel("med_error_stage", "Stage", ["Prescribing", "Transcribing", "Indenting", "Dispensing", "Administration", "Monitoring"], required=True),
                multi("error_type", "Type of error", ["Wrong drug", "Wrong dose", "Wrong route", "Wrong time", "Wrong patient", "Omission",
                                                      "Extra dose", "Wrong rate", "Expired drug", "Known allergy", "Documentation"], required=True),
                sel("ncc_merp_category", "NCC MERP category", [
                    "A — capacity to cause error", "B — error, did not reach patient", "C — reached, no harm", "D — reached, monitoring needed",
                    "E — temporary harm, intervention", "F — temporary harm, prolonged stay", "G — permanent harm",
                    "H — life-sustaining intervention", "I — death"], required=True), tone="amber"),
        section("Response", ta("description", "What happened", rows=3, required=True), ta("immediate_action", "Immediate action taken", rows=2, required=True),
                doctor("doctor_informed", "Doctor informed"), seg("patient_informed", "Disclosed to patient / family", ["Yes", "No", "Pending", "Not applicable"]),
                tone="blue"),
    ],
}

RESTRAINT_CHECKS = [
    yn("chk_csm", "Circulation, sensation & movement of restrained limbs normal", required=True),
    yn("chk_skin", "Skin intact under restraint", required=True), yn("chk_position", "Position changed / ROM exercises done", required=True),
    yn("chk_fluids", "Fluids / nutrition offered", na=True, required=True), yn("chk_toilet", "Toileting needs met", na=True, required=True),
    yn("chk_release", "Restraint released for at least 10 min (every 2 h)", na=True, required=True),
    yn("chk_still_needed", "Restraint still needed", required=True),
]
RESTRAINT_MONITOR = {
    "key": "safety.restraint_monitoring", "suite": "safety", "title": "Restraint Monitoring", "short": "Restraint monitoring", "icon": "Link2",
    "order": 4, "roles": ["nurse", "doctor"], "view_roles": VIEW, "multi_entry": True, "summary": ["behaviour"],
    "description": "Nursing checks while a patient is restrained — every 15 to 60 minutes as ordered.",
    "sections": [
        section("Check", dt(), sel("restraint_type", "Restraint in use", ["Physical — limb", "Physical — vest / belt", "Mittens", "Chemical (sedation)"],
                                   required=True),
                dt("order_at", "Order date & time", default=None, prefill="form:doctor.restraint_order.noted_at"),
                sel("behaviour", "Behaviour", ["Calm", "Restless", "Agitated", "Aggressive", "Sleeping", "Sedated"], required=True), tone="blue"),
        section("Checks", *RESTRAINT_CHECKS, tone="green"),
        section("Outcome", seg("outcome", "Outcome", ["Continue", "Discontinued", "Doctor review requested"], required=True),
                yn("injury", "Injury from restraint noted"), ta("remarks", "Remarks", rows=2), tone="amber"),
    ],
    "score": score([f["key"] for f in RESTRAINT_CHECKS if f["key"] != "chk_still_needed"], "Checks met", method="percent_yes", lo=0, hi=100, unit="%"),
    "bands": compliance_bands("All checks met", "Gaps in restraint care", "Correct the missed checks now; inform the nurse in-charge."),
}

TRANSFUSION = {
    "key": "safety.transfusion_monitoring", "suite": "safety", "title": "Blood Transfusion Monitoring & Reaction", "short": "Transfusion",
    "icon": "Droplet", "order": 5, "roles": ["nurse", "doctor"], "view_roles": VIEW, "multi_entry": True, "summary": ["component", "bag_no"],
    "description": "Bedside checks, vitals before / 15 min / hourly / end, and transfusion reaction management (haemovigilance).",
    "mirror": [{"kind": "incident", "when": {"field": "reaction", "eq": "Yes"},
                "options": {"incident_type": "Transfusion Reaction", "occurred_field": "start_at"}}],
    "sections": [
        section("Unit", dt("start_at", "Transfusion started", required=True),
                sel("component", "Component", ["PRBC", "Whole blood", "FFP", "Platelets (RDP)", "Platelets (SDP)", "Cryoprecipitate"], required=True),
                text("bag_no", "Bag / unit number", required=True), sel("unit_group", "Unit blood group", BLOOD_GROUPS, required=True),
                sel("patient_group", "Patient blood group", BLOOD_GROUPS, prefill="patient.blood_group", required=True),
                yn("bedside_check", "Two-person bedside identity & unit check done", required=True), nurse("checked_by", "Second checker", required=True),
                dt("end_at", "Transfusion completed", default=None), num("volume", "Volume transfused", "mL", 0, 2000), tone="blue"),
        section("Monitoring", lines("obs", "Observations", [
            sel("point", "Time point", ["Pre-transfusion", "15 min", "30 min", "1 h", "2 h", "3 h", "End", "1 h after"], required=True),
            time("at", "Time"), num("temperature", "Temp °F", None, 85, 110, step=0.1), num("pulse", "Pulse"), num("bp_sys", "SBP"),
            num("bp_dia", "DBP"), num("resp_rate", "RR"), num("spo2", "SpO₂")]), tone="green"),
        section("Reaction", seg("reaction", "Reaction observed", ["No", "Yes"], required=True),
                multi("signs", "Signs", ["Fever ≥ 1 °C rise", "Chills / rigors", "Urticaria / itching", "Breathlessness / wheeze", "Hypotension",
                                         "Tachycardia", "Back / loin pain", "Haemoglobinuria", "Anaphylaxis"], show_if=when("reaction", eq="Yes"),
                      required_if=when("reaction", eq="Yes")),
                multi("actions", "Actions taken", ["Transfusion stopped", "IV line kept open with NS", "Doctor informed", "Blood bank informed",
                                                   "Bag & samples sent to blood bank", "Urine sample sent"], show_if=when("reaction", eq="Yes"),
                      required_if=when("reaction", eq="Yes")),
                sel("reaction_type", "Reaction type (doctor)", ["Febrile non-haemolytic", "Allergic (minor)", "Anaphylactic", "Acute haemolytic",
                                                                 "TACO", "TRALI", "Septic", "Other"], show_if=when("reaction", eq="Yes")),
                yn("hvpi_reported", "Reported to Haemovigilance Programme of India", show_if=when("reaction", eq="Yes")),
                ta("immediate_action", "Immediate action / notes", rows=2, show_if=when("reaction", eq="Yes"), required_if=when("reaction", eq="Yes")),
                sel("harm", "Harm severity", HARM, show_if=when("reaction", eq="Yes")), tone="red"),
    ],
}

HAM_CHECKS = [
    yn("chk_identity", "Patient identity confirmed with two identifiers", required=True),
    yn("chk_order", "Order verified against the prescription", required=True), yn("chk_drug", "Right drug & concentration", required=True),
    yn("chk_dose", "Dose calculation independently verified", required=True), yn("chk_route", "Right route & line traced to patient", required=True),
    yn("chk_pump", "Pump programming (rate / VTBI) verified", na=True, required=True), yn("chk_label", "Syringe / bag labelled", required=True),
    yn("chk_allergy", "Allergy status checked", required=True),
]
HIGH_ALERT = {
    "key": "safety.high_alert_double_check", "suite": "safety", "title": "High-alert Medication Double Check", "short": "Double check",
    "icon": "ShieldCheck", "order": 6, "roles": ["nurse", "doctor"], "view_roles": VIEW, "multi_entry": True, "summary": ["drug_name", "second_nurse"],
    "description": "Independent double check by two nurses before administering a high-alert medicine.",
    "sections": [
        section("Medicine", dt(), sel("category", "Category", ["Insulin", "Heparin / anticoagulant", "Potassium chloride concentrate", "Opioid",
                                                               "Inotrope / vasopressor", "Neuromuscular blocker", "Concentrated electrolyte",
                                                               "Chemotherapy", "Magnesium sulphate", "Other"], required=True),
                {"key": "drug", "label": "Drug", "type": "drug"}, text("drug_name", "Drug & strength", required=True),
                text("dose", "Prescribed dose", required=True), text("calculated", "Independently calculated dose / rate", required=True),
                num("rate", "Pump rate", "mL/h", 0, 999, step=0.1), tone="blue"),
        section("Checks", *HAM_CHECKS, tone="green"),
        section("Sign-off", nurse("first_nurse", "First nurse", default="me", required=True), nurse("second_nurse", "Second nurse (independent)", required=True),
                seg("discrepancy", "Discrepancy found", ["No", "Yes"], required=True),
                ta("resolution", "Resolution", rows=2, show_if=when("discrepancy", eq="Yes"), required_if=when("discrepancy", eq="Yes")), tone="amber"),
    ],
    "score": score([f["key"] for f in HAM_CHECKS], "Checks verified", method="percent_yes", lo=0, hi=100, unit="%"),
    "bands": [
        band("Verified", "green", lo=100, action="Proceed with administration and document in the MAR."),
        band("Discrepancy — do not administer", "red", lt=100, action="Do not administer; resolve with the prescriber / pharmacist and repeat the check."),
    ],
}

FORMS = [FALL, PRESSURE, MED_ERROR, RESTRAINT_MONITOR, TRANSFUSION, HIGH_ALERT]
