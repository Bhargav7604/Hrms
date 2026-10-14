"""IP discharge summary — 17 numbered narrative sections plus the discharge details block.

One active summary per admission. Every section offers Copy-from (earlier entries / the admission H&P), Templates
and Dictate in the runner; "Import from doctor assessment" pre-fills from the admission H&P."""

from ..dsl import doctor, dt, section, sel, ta, text, when

DISCHARGE_TYPES = ["Normal discharge", "Discharge against medical advice (DAMA / LAMA)", "Transfer to another hospital", "Absconded",
                   "Death", "Discharge on request"]

H = "doctor.admission_hp"
NARRATIVE = [
    ("consultant", "Consultant", [], 2),
    ("referral_consultant", "Referral consultant", [], 2),
    ("diagnosis", "Diagnosis", [f"{H}.provisional_diagnosis"], 3),
    ("hpi", "History of present illness", [f"{H}.hpi", f"{H}.chief_complaints"], 4),
    ("past_history", "Past history", [f"{H}.past_history", f"{H}.surgical_history"], 3),
    ("family_history", "Family history", [f"{H}.family_history"], 2),
    ("obstetric_history", "Obstetric history", [f"{H}.obstetric_history"], 2),
    ("general_examination", "General examination", [], 3),
    ("systemic_examination", "Systemic examination", [], 4),
    ("course", "Course of treatment in the hospital", ["doctor.progress_soap.assessment"], 6),
    ("procedures", "Procedures / operations performed", ["ot.operative_note.procedure_done", "doctor.procedure_note.technique"], 3),
    ("investigations", "Significant investigations", [], 4),
    ("condition_at_discharge", "Condition at discharge", [], 2),
    ("discharge_medications", "Medications on discharge", [], 5),
    ("advice", "Advice on discharge (diet, activity, wound care)", [], 4),
    ("follow_up", "Follow-up", [], 2),
    ("urgent_care", "When to come back urgently", [], 3),
]

SUMMARY = {
    "key": "discharge.summary", "suite": "discharge", "title": "IP Discharge Summary", "short": "Discharge summary", "icon": "FileOutput",
    "order": 1, "roles": ["doctor"], "view_roles": ["doctor", "nurse", "quality", "billing"], "one_per_admission": True,
    "description": "Narrative discharge summary (one active per admission).", "summary": ["discharge_type", "diagnosis"],
    "import_from": [{"form": H, "label": "Doctor assessment (admission H&P)", "map": {
        "consultant": "consultant", "diagnosis": "provisional_diagnosis,diagnoses", "hpi": "chief_complaints,hpi",
        "past_history": "chronic,past_history,surgical_history,drug_history", "family_history": "family_history",
        "obstetric_history": "obstetric_history", "general_examination": "built,ge_findings,consciousness,pulse,bp_sys,bp_dia,resp_rate,spo2",
        "systemic_examination": "cvs,rs,abdomen,cns,local_exam",
    }}],
    "sections": [
        section("Discharge", dt("noted_at", "Prepared at"), sel("discharge_type", "Discharge type", DISCHARGE_TYPES, required=True),
                dt("discharge_at", "Discharge date & time", default=None),
                text("eprint_mobile", "E-print mobile number", prefill="patient.phone", help="The e-copy of the summary is sent to this number"),
                text("cause_of_death", "Cause of death", show_if=when("discharge_type", eq="Death"), required_if=when("discharge_type", eq="Death")),
                dt("death_at", "Death date & time", default=None, show_if=when("discharge_type", eq="Death"), required_if=when("discharge_type", eq="Death")),
                doctor("verified_by", "Verified by consultant", prefill="admission.doctor_id"), key="discharge", tone="blue"),
        section("Summary", *[ta(k, f"{i}. {label}", rows=rows, copy_from=src or None, width="full",
                                required=k in ("diagnosis", "course", "condition_at_discharge", "advice", "follow_up"),
                                prefill="admission.doctor_name" if k == "consultant" else ("admission.diagnosis" if k == "diagnosis" else None))
                              for i, (k, label, src, rows) in enumerate(NARRATIVE, start=1)], key="narrative", tone="gray"),
    ],
}

FORMS = [SUMMARY]
