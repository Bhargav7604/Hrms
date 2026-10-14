"""Doctor suite: admission H&P, progress notes, consults, procedures, transfers, death, orders and referrals.
(The pre-anaesthesia check lives in the OT file as ``ot.pac`` and is also listed here.)"""

from ..dsl import (
    BLOOD_GROUPS,
    CONDITION,
    calc,
    doctor,
    dt,
    info,
    lines,
    multi,
    num,
    section,
    seg,
    sel,
    ta,
    text,
    when,
    yn,
)

D = ["doctor"]
DN = ["doctor", "nurse"]
VIEW = ["doctor", "nurse", "quality"]
CHRONIC = ["Diabetes mellitus", "Hypertension", "Coronary artery disease", "Heart failure", "Asthma", "COPD", "Chronic kidney disease",
           "Chronic liver disease", "Hypothyroidism", "Epilepsy", "Stroke", "Tuberculosis (past)", "HIV", "Hepatitis B / C", "Cancer"]
GE_FINDINGS = ["Pallor", "Icterus", "Cyanosis", "Clubbing", "Lymphadenopathy", "Pedal oedema", "Dehydration", "JVP raised"]
DX_LINES = [text("diagnosis", "Diagnosis", required=True), text("icd10", "ICD-10", placeholder="e.g. A90"),
            sel("dx_type", "Type", ["Provisional", "Final", "Differential", "Co-morbidity"])]


def vitals_block(prefix: str = "") -> list[dict]:
    return [
        num(f"{prefix}pulse", "Pulse", "bpm", 0, 300), num(f"{prefix}bp_sys", "BP systolic", "mmHg", 0, 300),
        num(f"{prefix}bp_dia", "BP diastolic", "mmHg", 0, 200), num(f"{prefix}resp_rate", "Resp. rate", "/min", 0, 80),
        num(f"{prefix}temperature", "Temperature", "°F", 85, 110, step=0.1), num(f"{prefix}spo2", "SpO₂", "%", 0, 100),
        num(f"{prefix}grbs", "GRBS", "mg/dL", 10, 900),
    ]


ADMISSION_HP = {
    "key": "doctor.admission_hp", "suite": "doctor", "title": "Admission History & Physical", "short": "Admission H&P",
    "icon": "ClipboardPlus", "order": 1, "roles": D, "view_roles": VIEW, "one_per_admission": True,
    "description": "Doctor's admission assessment — history, examination, provisional diagnosis and plan (one per admission).",
    "sections": [
        section("History", dt(), doctor("consultant", "Consultant", prefill="admission.doctor_id"),
                ta("chief_complaints", "Chief complaints with duration", required=True, rows=3,
                   placeholder="e.g. Fever 5 days, vomiting 2 days, generalised body pains"),
                ta("hpi", "History of present illness", required=True, rows=5),
                multi("chronic", "Known illnesses", CHRONIC), ta("past_history", "Past medical history", rows=2),
                ta("surgical_history", "Past surgical history", rows=2), ta("drug_history", "Drug history / current medications", rows=2),
                text("allergies", "Allergies", prefill="patient.allergies"), ta("family_history", "Family history", rows=2),
                ta("personal_history", "Personal history", rows=2, placeholder="Diet, appetite, sleep, bowel & bladder, smoking, alcohol"),
                ta("obstetric_history", "Menstrual / obstetric history (if applicable)", rows=2), tone="blue"),
        section("General examination", *vitals_block(),
                num("weight", "Weight", "kg", 0.5, 400, step=0.1, prefill="weight"), num("height", "Height", "cm", 30, 250, prefill="vitals.height"),
                calc("bmi", "BMI", "bmi", ["weight", "height"], "kg/m²"),
                sel("built", "Built & nourishment", ["Well built, well nourished", "Moderately built", "Thin built, poorly nourished", "Obese"]),
                multi("ge_findings", "Findings present", GE_FINDINGS + ["None of these"]),
                sel("consciousness", "Consciousness", ["Conscious, oriented", "Conscious, disoriented", "Drowsy", "Stuporous", "Comatose"]),
                tone="green"),
        section("Systemic examination",
                ta("cvs", "Cardiovascular", rows=2, placeholder="S1 S2 heard, no murmurs"), ta("rs", "Respiratory", rows=2, placeholder="NVBS, no added sounds"),
                ta("abdomen", "Per abdomen", rows=2, placeholder="Soft, non-tender, no organomegaly"),
                ta("cns", "Central nervous system", rows=2, placeholder="No focal neurological deficit"),
                ta("local_exam", "Local examination", rows=2), tone="violet"),
        section("Assessment & plan",
                ta("provisional_diagnosis", "Provisional diagnosis", required=True, rows=2, prefill="admission.diagnosis"),
                lines("diagnoses", "Diagnoses (ICD-10)", DX_LINES),
                ta("investigations_plan", "Investigations planned", rows=2), ta("treatment_plan", "Treatment plan", rows=3, required=True),
                sel("diet", "Diet", ["Normal", "Soft", "Liquid", "Diabetic", "Renal", "Cardiac / low salt", "NBM"]),
                sel("code_status", "Code status", ["Full code", "DNR — do not resuscitate", "Limited intervention"], default="Full code"),
                text("dnr_details", "DNR discussion — with whom, when", show_if=when("code_status", ne="Full code"),
                     required_if=when("code_status", ne="Full code")),
                num("expected_los", "Expected length of stay", "days", 0, 120), yn("family_counselled", "Patient / family counselled about plan"),
                tone="amber"),
    ],
    "summary": ["provisional_diagnosis"],
}

PROGRESS = {
    "key": "doctor.progress_soap", "suite": "doctor", "title": "Daily Progress Note (SOAP)", "short": "Progress", "icon": "NotebookPen",
    "order": 2, "roles": D, "view_roles": VIEW, "multi_entry": True, "summary": ["assessment"],
    "description": "Daily ward-round note in Subjective · Objective · Assessment · Plan format.",
    "import_from": [{"form": "doctor.progress_soap", "label": "Yesterday's note", "map": {"assessment": "assessment", "plan": "plan"}}],
    "sections": [
        section("Note", dt(), seg("shift", "Round", ["Morning", "Evening", "Night"], default="Morning"),
                num("hospital_day", "Day of admission / POD", None, 0, 365), tone="blue"),
        section("S — Subjective", ta("subjective", "Subjective", rows=3, required=True, placeholder="Complaints, sleep, appetite, pain"), tone="pink"),
        section("O — Objective", *vitals_block(), ta("objective", "Examination & results", rows=3, required=True), tone="green"),
        section("A — Assessment", ta("assessment", "Assessment", rows=3, required=True), sel("condition", "Condition", CONDITION), tone="violet"),
        section("P — Plan", ta("plan", "Plan", rows=4, required=True), yn("family_updated", "Family updated"), tone="amber"),
    ],
}

CONSULTANT_VISIT = {
    "key": "doctor.consultant_visit", "suite": "doctor", "title": "Consultant Visit", "short": "Consultant visit", "icon": "UserCheck",
    "order": 3, "roles": D, "view_roles": VIEW, "multi_entry": True, "summary": ["visit_type", "consultant"],
    "description": "Consultant's visit record — billable visit with findings and instructions.",
    "sections": [
        section("Visit", dt(), doctor("consultant", "Consultant", default="me", required=True),
                seg("visit_type", "Visit type", ["Routine round", "Called visit", "Emergency visit", "Night visit"], required=True),
                text("requested_by", "Requested by (for called visits)", show_if=when("visit_type", ne="Routine round")), tone="blue"),
        section("Findings & instructions", ta("findings", "Findings", rows=3, required=True), ta("instructions", "Instructions / orders", rows=3),
                yn("plan_changed", "Change in management plan"), ta("plan_change", "What changed", rows=2, show_if=when("plan_changed", eq="Yes")),
                yn("family_briefed", "Family briefed"), dt("next_review", "Next review", default=None), tone="green"),
    ],
}

CROSS_CONSULT = {
    "key": "doctor.cross_consult", "suite": "doctor", "title": "Cross-consultation Request & Reply", "short": "Cross-consult",
    "icon": "Users", "order": 4, "roles": D, "view_roles": VIEW, "multi_entry": True, "summary": ["consult_department", "urgency"],
    "description": "Request an opinion from another specialty; the consultant replies on the same form.",
    "sections": [
        section("Request", dt(), doctor("requested_by", "Requesting doctor", default="me"),
                {"key": "consult_department", "label": "Department consulted", "type": "department", "required": True},
                doctor("consultant", "Consultant (if known)"),
                seg("urgency", "Urgency", ["Routine (24 h)", "Urgent (4 h)", "Emergency (30 min)"], required=True),
                ta("question", "Reason / question for the consultant", rows=3, required=True),
                ta("summary", "Relevant clinical summary", rows=3), tone="blue"),
        section("Reply", dt("seen_at", "Seen at", default=None), ta("reply_findings", "Findings", rows=3), ta("impression", "Impression", rows=2),
                ta("recommendations", "Recommendations", rows=3), sel("follow_up", "Follow-up", ["Will review", "SOS", "Take over care", "No further input"]),
                tone="green", desc="Completed by the consultant."),
    ],
}

PROCEDURE_NOTE = {
    "key": "doctor.procedure_note", "suite": "doctor", "title": "Procedure Note", "short": "Procedure", "icon": "Syringe", "order": 5,
    "roles": D, "view_roles": VIEW, "multi_entry": True, "summary": ["procedure"],
    "description": "Bedside / ward procedure documentation — consent, time-out, technique, findings and complications.",
    "sections": [
        section("Procedure", dt(),
                sel("procedure", "Procedure", ["Central venous catheter", "Arterial line", "Intercostal drain", "Pleural tap", "Ascitic tap",
                                               "Lumbar puncture", "Bone marrow aspiration / biopsy", "Endotracheal intubation", "Tracheostomy change",
                                               "Urinary catheterisation (difficult)", "Wound debridement / suturing", "Incision & drainage", "Other"],
                    required=True),
                text("procedure_other", "Procedure (other)", show_if=when("procedure", eq="Other"), required_if=when("procedure", eq="Other")),
                ta("indication", "Indication", rows=2, required=True), sel("side", "Site / side", ["Left", "Right", "Midline", "Not applicable"]),
                doctor("operator", "Performed by", default="me"), doctor("assistant", "Assisted by"),
                yn("consent", "Informed consent taken", required=True), yn("time_out", "Time-out done", required=True),
                sel("anaesthesia", "Anaesthesia", ["Local", "Sedation", "General", "None"]), tone="blue"),
        section("Technique & outcome", ta("technique", "Technique", rows=4, required=True), ta("findings", "Findings", rows=2),
                yn("specimen_sent", "Specimen sent"), text("specimen_details", "Specimen & tests", show_if=when("specimen_sent", eq="Yes")),
                num("blood_loss", "Blood loss", "mL", 0, 5000), seg("complications", "Complications", ["None", "Yes"], required=True),
                ta("complication_details", "Complication details", rows=2, show_if=when("complications", eq="Yes"),
                   required_if=when("complications", eq="Yes")),
                ta("post_instructions", "Post-procedure instructions", rows=2), tone="green"),
    ],
}

TRANSFER_NOTE = {
    "key": "doctor.transfer_note", "suite": "doctor", "title": "Transfer Note", "short": "Transfer", "icon": "ArrowRightLeft", "order": 6,
    "roles": D, "view_roles": VIEW, "multi_entry": True, "summary": ["transfer_type", "to_unit"],
    "description": "Clinical handover when the patient moves between units or hospitals.",
    "sections": [
        section("Transfer", dt(),
                seg("transfer_type", "Transfer", ["Ward → ICU", "ICU → Ward", "Inter-department", "To another hospital"], required=True),
                text("from_unit", "From unit"), text("to_unit", "To unit / hospital", required=True), doctor("receiving_doctor", "Receiving doctor"),
                ta("reason", "Reason for transfer", rows=2, required=True), tone="blue"),
        section("Clinical status", ta("course", "Summary of course so far", rows=4, required=True), *vitals_block(),
                sel("condition", "Condition at transfer", CONDITION, required=True),
                multi("lines", "Lines & devices", ["Peripheral IV", "Central line", "Arterial line", "Urinary catheter", "Ryle's tube", "Drain",
                                                  "ETT / ventilator", "Tracheostomy", "None"]),
                ta("medications", "Current medications / infusions", rows=3), ta("pending", "Pending investigations & issues", rows=2),
                yn("family_informed", "Family informed"), tone="green"),
    ],
}

DEATH_NOTE = {
    "key": "doctor.death_note", "suite": "doctor", "title": "Death Note / Summary", "short": "Death note", "icon": "FileX2", "order": 7,
    "roles": D, "view_roles": VIEW, "one_per_admission": True,
    "description": "Declaration of death with MCCD (Form 4) cause-of-death sequence, MLC status and handover of the body.",
    "sections": [
        section("Declaration", dt("death_at", "Date & time of death", required=True), doctor("declared_by", "Declared by", default="me", required=True),
                yn("cpr_done", "Resuscitation attempted", required=True), num("cpr_minutes", "CPR duration", "min", 0, 240, show_if=when("cpr_done", eq="Yes")),
                ta("events", "Events leading to death", rows=4, required=True), tone="red"),
        section("Cause of death (MCCD — Form 4)",
                text("cause_a", "I (a) Immediate cause", required=True), text("cause_b", "I (b) Due to (antecedent cause)"),
                text("cause_c", "I (c) Due to (underlying cause)"), text("cause_contributory", "II Other significant conditions"),
                sel("manner", "Manner of death", ["Natural", "Accident", "Suicide", "Homicide", "Pending investigation"], required=True),
                tone="amber"),
        section("Formalities",
                yn("mlc", "Medico-legal case", required=True), text("police_station", "Police station intimated", show_if=when("mlc", eq="Yes"),
                                                                       required_if=when("mlc", eq="Yes")),
                yn("family_informed", "Family informed", required=True), text("informed_whom", "Informed whom & when", show_if=when("family_informed", eq="Yes")),
                sel("body_handover", "Body handed over to", ["Relatives", "Mortuary", "Police", "Pending"]),
                yn("mccd_issued", "MCCD issued"), ta("summary", "Brief clinical summary", rows=4), tone="gray"),
    ],
}

TRANSFUSION_ORDER = {
    "key": "doctor.transfusion_order", "suite": "doctor", "title": "Blood Transfusion Order", "short": "Transfusion order", "icon": "Droplet",
    "order": 9, "roles": D, "view_roles": VIEW, "multi_entry": True, "summary": ["component", "units"],
    "description": "Order for blood components with indication, consent and pre-transfusion values.",
    "sections": [
        section("Order", dt(), sel("blood_group", "Patient blood group", BLOOD_GROUPS, prefill="patient.blood_group", required=True),
                sel("component", "Component", ["Packed red cells (PRBC)", "Whole blood", "Fresh frozen plasma (FFP)", "Platelets — random donor (RDP)",
                                               "Platelets — single donor (SDP)", "Cryoprecipitate"], required=True),
                num("units", "Units", None, 1, 20, required=True), num("volume", "Volume per unit", "mL", 0, 600),
                seg("urgency", "Urgency", ["Routine", "Urgent (cross-matched)", "Emergency (uncross-matched O neg)"], required=True),
                text("rate", "Rate / duration", placeholder="e.g. Over 3 hours each unit"),
                multi("special", "Special requirements", ["Irradiated", "Leukodepleted", "CMV negative", "Washed"]), tone="blue"),
        section("Indication", ta("indication", "Indication", rows=2, required=True),
                num("pre_hb", "Pre-transfusion Hb", "g/dL", 0, 25, step=0.1), num("pre_platelets", "Platelets", "×10³/µL", 0, 2000),
                num("pre_inr", "INR", None, 0, 20, step=0.1), text("premedication", "Premedication", placeholder="e.g. Inj. Pheniramine 22.75 mg IV"),
                yn("consent", "Transfusion consent taken", required=True), yn("history_reaction", "Previous transfusion reaction"),
                tone="green"),
    ],
}

RESTRAINT_ORDER = {
    "key": "doctor.restraint_order", "suite": "doctor", "title": "Restraint Order", "short": "Restraint order", "icon": "Link", "order": 10,
    "roles": D, "view_roles": VIEW, "multi_entry": True, "summary": ["restraint_type", "valid_hours"],
    "description": "Physician order for physical or chemical restraint — time-limited, with alternatives tried and monitoring frequency.",
    "sections": [
        section("Order", dt(), sel("restraint_type", "Restraint", ["Physical — limb", "Physical — vest / belt", "Mittens", "Bed rails only",
                                                                "Chemical (sedation)"], required=True),
                multi("indication", "Indication", ["Risk of harm to self", "Risk of harm to others", "Pulling lines / tubes", "Agitation / delirium",
                                                   "Post-operative confusion"], required=True),
                multi("alternatives", "Alternatives tried first", ["Reorientation", "Attendant / sitter", "Pain relief", "Treat cause of delirium",
                                                                   "Diversion", "Environment change"]),
                num("valid_hours", "Order valid for", "hours", 1, 24, required=True, help="Re-evaluate in person before renewing; maximum 24 h"),
                sel("monitoring", "Monitoring frequency", ["Every 15 min", "Every 30 min", "Hourly"], required=True),
                yn("family_informed", "Family informed / consent", required=True), ta("remarks", "Remarks", rows=2), tone="amber"),
    ],
}

HIGH_RISK_MED_ORDER = {
    "key": "doctor.high_risk_med_order", "suite": "doctor", "title": "High-risk Medication Order", "short": "High-risk med order",
    "icon": "Pill", "order": 11, "roles": D, "view_roles": VIEW + ["pharmacist"], "multi_entry": True, "summary": ["category", "drug_name"],
    "description": "Structured order for high-alert medicines — concentration, rate, monitoring and reversal — requiring a nurse double check.",
    "sections": [
        section("Medicine", dt(),
                sel("category", "Category", ["Insulin infusion", "Heparin / anticoagulant", "Potassium chloride concentrate", "Opioid infusion",
                                             "Inotrope / vasopressor", "Neuromuscular blocker", "Concentrated electrolyte", "Magnesium sulphate",
                                             "Thrombolytic", "Chemotherapy", "Other"], required=True),
                {"key": "drug", "label": "Drug", "type": "drug"}, text("drug_name", "Drug name & strength", required=True),
                text("dose", "Dose", required=True), num("dosing_weight", "Dosing weight", "kg", 0.5, 400, step=0.1, prefill="weight"),
                text("diluent", "Diluent & total volume", placeholder="e.g. 50 IU in 50 mL NS"), text("concentration", "Final concentration"),
                sel("route", "Route", ["IV infusion", "IV bolus", "SC", "Oral", "Intrathecal"], required=True),
                num("rate", "Rate", "mL/h", 0, 999, step=0.1), text("titration", "Titration / sliding scale"),
                ta("indication", "Indication", rows=2, required=True), tone="red"),
        section("Safety", ta("monitoring", "Monitoring", rows=2, required=True, placeholder="e.g. GRBS hourly, aPTT 6-hourly, BP every 15 min"),
                text("reversal", "Reversal agent / antidote available", placeholder="e.g. Protamine, Naloxone, 25% dextrose"),
                info("dc_info", "Administration needs an independent double check by two nurses (Patient Safety › High-alert medication double check).",
                     tone="amber"), tone="amber"),
    ],
}

REFERRAL = {
    "key": "doctor.referral_letter", "suite": "doctor", "title": "Referral Letter", "short": "Referral", "icon": "Send", "order": 12,
    "roles": D, "view_roles": VIEW, "multi_entry": True, "summary": ["referral_type", "referred_to"],
    "description": "Referral to another doctor or a higher centre with summary, treatment given and transport arrangements.",
    "sections": [
        section("Referral", dt(), seg("referral_type", "Referral", ["Internal", "External doctor", "Higher centre"], required=True),
                text("referred_to", "Referred to (doctor / hospital)", required=True), text("department", "Department / specialty"),
                seg("urgency", "Urgency", ["Routine", "Urgent", "Emergency"], required=True), tone="blue"),
        section("Clinical details", ta("reason", "Reason for referral", rows=2, required=True), ta("diagnosis", "Diagnosis", rows=2, required=True),
                ta("clinical_summary", "Clinical summary", rows=4), ta("treatment_given", "Treatment given", rows=3),
                ta("investigations", "Significant investigations", rows=2), sel("condition", "Condition at referral", CONDITION), tone="green"),
        section("Transport", sel("transport", "Mode of transport", ["Own vehicle", "BLS ambulance", "ALS ambulance", "Air ambulance", "Not applicable"]),
                text("accompanied_by", "Accompanied by"), multi("enclosures", "Documents enclosed", ["Case summary", "Investigation reports",
                                                                                                   "Imaging films / CD", "Prescription"]),
                tone="violet"),
    ],
}

FORMS = [ADMISSION_HP, PROGRESS, CONSULTANT_VISIT, CROSS_CONSULT, PROCEDURE_NOTE, TRANSFER_NOTE, DEATH_NOTE, TRANSFUSION_ORDER,
         RESTRAINT_ORDER, HIGH_RISK_MED_ORDER, REFERRAL]
