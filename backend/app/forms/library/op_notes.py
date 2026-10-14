"""OP specialty clinical-note formats for the OP EMR ("op.note.<specialty>").

Every format shares chief complaint, HPI, history, system-wise examination, diagnosis (ICD-10), plan, advice and
follow-up, and adds the specialty's own sections. `match` lists department-name keywords used to pick the format
for a patient's department (GET /api/forms/op-format?department_id=…)."""

from ..dsl import date, dt, lines, multi, num, scale, section, seg, sel, ta, text

OP = ["doctor"]
VIEW = ["doctor", "nurse"]


def common_top() -> list[dict]:
    return [
        section("History", dt(), ta("chief_complaint", "Chief complaint", rows=2, required=True),
                ta("hpi", "History of present illness", rows=4, required=True),
                ta("past_history", "Past medical history", rows=2), ta("family_history", "Family history", rows=2),
                ta("personal_history", "Personal / social history", rows=2), text("allergies", "Allergies", prefill="patient.allergies"),
                ta("current_medications", "Current medications", rows=2), key="history", tone="blue"),
        section("Vitals", num("pulse", "Pulse", "bpm", 0, 300), num("bp_sys", "BP systolic", "mmHg", 0, 300), num("bp_dia", "BP diastolic", "mmHg", 0, 200),
                num("temperature", "Temperature", "°F", 85, 110, step=0.1), num("spo2", "SpO₂", "%", 0, 100), num("weight", "Weight", "kg", 0.5, 400, step=0.1,
                                                                                                            prefill="weight"),
                key="vitals", tone="green"),
    ]


def exam(*extra: dict) -> dict:
    return section("Examination", ta("general_exam", "General examination", rows=2),
                   ta("cvs", "Cardiovascular", rows=1), ta("rs", "Respiratory", rows=1), ta("abdomen", "Abdomen", rows=1), ta("cns", "CNS", rows=1),
                   *extra, key="examination", tone="violet")


def common_bottom() -> list[dict]:
    return [
        section("Diagnosis", lines("diagnoses", "Diagnosis (ICD-10)", [text("diagnosis", "Diagnosis", required=True), text("icd10", "ICD-10"),
                                                                       sel("dx_type", "Type", ["Provisional", "Final", "Differential"])], required=True),
                key="diagnosis", tone="amber"),
        section("Plan & advice", ta("investigations", "Investigations advised", rows=2), ta("plan", "Plan / treatment", rows=3, required=True),
                ta("advice", "Advice", rows=3), date("follow_up_date", "Follow-up date"), text("follow_up_notes", "Follow-up instructions"),
                key="plan", tone="green"),
    ]


def note(key: str, title: str, match: list[str], specialty: list[dict], exam_extra: list[dict] | None = None, icon: str = "Stethoscope",
         order: int = 0) -> dict:
    return {
        "key": f"op.note.{key}", "suite": "op", "title": f"{title} — OP note", "short": title, "icon": icon, "order": order,
        "roles": OP, "view_roles": VIEW, "multi_entry": True, "match": match, "summary": ["chief_complaint"],
        "description": f"Outpatient consultation note for {title}.",
        "sections": [*common_top(), exam(*(exam_extra or [])), *specialty, *common_bottom()],
    }


FORMS = [
    note("general_medicine", "General Medicine", ["general medicine", "internal medicine", "medicine", "family medicine", "gastro", "nephro",
                                                  "endocrin", "neuro"], [
        section("Medicine", ta("review_of_systems", "Review of systems", rows=2), ta("assessment", "Assessment", rows=2),
                key="medicine", tone="pink"),
    ], order=1),
    note("obgyn", "OB / GYN", ["obstetric", "gynaec", "obg", "ob/gyn", "maternity"], [
        section("Obstetric & gynaecological", date("lmp", "LMP"), date("edd", "EDD"), num("gravida", "Gravida (G)", None, 0, 20),
                num("para", "Para (P)", None, 0, 20), num("abortions", "Abortions (A)", None, 0, 20), num("living", "Living children (L)", None, 0, 20),
                num("gest_age", "Gestational age", "weeks", 0, 44), ta("obstetric_history", "Obstetric history", rows=2),
                ta("menstrual_history", "Menstrual history", rows=2), num("fundal_height", "Fundal height", "cm", 0, 50),
                num("fhr", "Fetal heart rate", "bpm", 0, 250), sel("presentation", "Fetal presentation", ["Cephalic", "Breech", "Transverse", "Oblique", "Not applicable"]),
                ta("pv_exam", "Pelvic / PV examination", rows=2), text("pap_smear", "Pap smear / cervical screening"),
                key="obgyn", tone="pink"),
    ], icon="Baby", order=2),
    note("paediatrics", "Paediatrics", ["paediatric", "pediatric", "neonat", "child"], [
        section("Growth & development", num("birth_weight", "Birth weight", "kg", 0.3, 6, step=0.01), num("current_weight", "Current weight", "kg", 0.3, 150, step=0.01),
                num("height", "Height / length", "cm", 20, 200, step=0.1), num("head_circumference", "Head circumference", "cm", 20, 70, step=0.1),
                ta("feeding_history", "Feeding history", rows=2), ta("milestones", "Developmental milestones", rows=2),
                sel("immunisation", "Immunisation status", ["Up to date (IAP)", "Partially immunised", "Not immunised", "Not known"]),
                key="paeds", tone="pink"),
    ], icon="Baby", order=3),
    note("dermatology", "Dermatology", ["dermatolog", "skin", "cosmetolog", "venereolog"], [
        section("Skin", ta("lesion_morphology", "Lesion morphology", rows=2), ta("distribution", "Distribution", rows=2),
                ta("dermoscopy", "Dermoscopy findings", rows=2), text("woods_lamp", "Wood's lamp"), ta("biopsy", "Biopsy / histopathology", rows=2),
                key="derm", tone="pink"),
    ], order=4),
    note("physiotherapy", "Physiotherapy", ["physiotherap", "physical therapy"], [
        section("Physiotherapy", scale("pain_vas", "Pain score (VAS 0–10)"), ta("rom", "Range of motion", rows=2), ta("mmt", "Muscle strength (MMT)", rows=2),
                ta("posture", "Postural assessment", rows=2), ta("gait", "Gait assessment", rows=2), ta("functional_goals", "Functional goals", rows=2),
                ta("modalities", "Treatment modalities", rows=2), ta("home_program", "Home exercise programme", rows=2), key="physio", tone="pink"),
    ], icon="Activity", order=5),
    note("cardiology", "Cardiology", ["cardiolog", "cardiac", "cardio"], [
        section("Cardiology", sel("nyha", "NYHA class", ["I", "II", "III", "IV"]), ta("ecg", "ECG findings", rows=2), ta("echo", "Echo findings", rows=2),
                multi("risk_factors", "Cardiac risk factors", ["Diabetes", "Hypertension", "Dyslipidaemia", "Smoking", "Family history of premature CAD",
                                                               "Obesity", "CKD"]), key="cardio", tone="pink"),
    ], icon="HeartPulse", order=6),
    note("ophthalmology", "Ophthalmology", ["ophthalm", "eye"], [
        section("Eye", text("va_right", "Visual acuity — right", placeholder="e.g. 6/9"), text("va_left", "Visual acuity — left"),
                num("iop_right", "IOP — right", "mmHg", 0, 80), num("iop_left", "IOP — left", "mmHg", 0, 80),
                ta("anterior_segment", "Anterior segment", rows=2), ta("fundus", "Fundus examination", rows=2), text("keratometry", "Keratometry"),
                text("axial_length", "Axial length"), key="eye", tone="pink"),
    ], icon="Eye", order=7),
    note("ent", "ENT", ["ent", "otorhinolaryng", "ear nose"], [
        section("ENT", ta("ear_exam", "Ear examination", rows=1), text("otoscopy_right", "Otoscopy — right"), text("otoscopy_left", "Otoscopy — left"),
                text("tuning_fork", "Tuning fork (Rinne / Weber)"), sel("hearing_loss", "Hearing loss", ["None", "Conductive", "Sensorineural", "Mixed"]),
                text("tympanometry", "Tympanometry"), ta("nasal_endoscopy", "Nasal endoscopy", rows=1), text("sinus_tenderness", "Sinus tenderness"),
                ta("laryngoscopy", "Indirect / video laryngoscopy", rows=1), ta("neck_nodes", "Neck / lymph nodes", rows=1),
                text("vertigo", "Vertigo / balance"), text("voice", "Voice assessment"), key="ent", tone="pink"),
    ], icon="Ear", order=8),
    note("orthopaedics", "Orthopaedics", ["orthopaed", "orthoped", "ortho", "spine", "trauma"], [
        section("Orthopaedic", sel("side", "Side", ["Left", "Right", "Bilateral", "Not applicable"]), text("swelling", "Swelling"),
                text("tenderness", "Tenderness"), ta("special_tests", "Special tests", rows=2), text("limb_length", "Limb length"),
                sel("muscle_power", "Muscle power (MRC)", ["0", "1", "2", "3", "4", "5"]), text("distal_sensation", "Distal neurovascular status"),
                ta("imaging", "X-ray / MRI / CT findings", rows=2), text("fracture_class", "Fracture classification"),
                text("implant", "Implant / prosthesis"), sel("weight_bearing", "Weight bearing", ["Non weight bearing", "Toe touch", "Partial", "As tolerated", "Full"]),
                key="ortho", tone="pink"),
    ], icon="Bone", order=9),
    {**note("psychiatry", "Psychiatry", ["psychiat", "mental health", "de-addiction"], [
        section("Mental status", ta("appearance", "Appearance and behaviour", rows=1), text("speech", "Speech"), ta("mood_affect", "Mood & affect", rows=1),
                ta("thought", "Thought (form & content)", rows=1), text("perception", "Perception (hallucinations)"),
                text("cognition", "Cognition"), text("insight", "Insight"), text("judgement", "Judgement"),
                seg("suicide_risk", "Suicide risk", ["None", "Low", "Moderate", "High"], required=True),
                ta("substance_use", "Substance use history", rows=1), num("phq9", "PHQ-9", None, 0, 27), num("gad7", "GAD-7", None, 0, 21),
                num("mmse", "MMSE / MoCA", None, 0, 30), text("sleep_appetite", "Sleep and appetite"), ta("stressors", "Psychosocial stressors", rows=1),
                text("adherence", "Medication adherence"), key="psych", tone="pink"),
    ], icon="Brain", order=10), "restricted": True},  # other roles must break the glass (audited)
    note("pulmonology", "Pulmonology", ["pulmonolog", "respiratory", "chest", "tb"], [
        section("Respiratory", ta("cough", "Cough and sputum", rows=1), sel("haemoptysis", "Haemoptysis", ["None", "Streaky", "Frank", "Massive"]),
                sel("mmrc", "Dyspnoea (mMRC grade)", ["0", "1", "2", "3", "4"]), text("chest_expansion", "Chest expansion"), text("percussion", "Percussion"),
                ta("breath_sounds", "Breath sounds / added sounds", rows=1), num("spo2_ra", "SpO₂ on room air", "%", 0, 100),
                num("pefr", "Peak expiratory flow", "L/min", 0, 900), num("six_mwd", "Six-minute walk distance", "m", 0, 1000),
                ta("abg", "ABG findings", rows=1), ta("chest_imaging", "Chest X-ray / CT findings", rows=2), num("pack_years", "Smoking", "pack-years", 0, 200),
                text("occupational", "Occupational exposure"), num("act", "Asthma control (ACT)", None, 5, 25),
                sel("gold_group", "COPD GOLD group", ["A", "B", "E", "Not applicable"]), num("stop_bang", "STOP-BANG", None, 0, 8),
                key="pulm", tone="pink"),
    ], icon="Wind", order=11),
    note("dental", "Dental", ["dental", "dentist", "oral", "maxillofacial"], [
        section("Dental", text("teeth", "Tooth number(s) — FDI", placeholder="e.g. 36, 46"), text("caries", "Caries"),
                text("periodontal", "Periodontal status"), text("gingival_index", "Gingival index"),
                sel("mobility", "Mobility", ["Grade 0", "Grade I", "Grade II", "Grade III"]), text("occlusion", "Occlusion"), text("tmj", "TMJ examination"),
                text("radiograph", "Radiograph (IOPA / OPG)"), text("anaesthesia_used", "Anaesthesia used"),
                ta("postop_instructions", "Post-operative instructions", rows=2), key="dental", tone="pink"),
    ], icon="Smile", order=12),
    note("rehabilitation", "Rehabilitation", ["rehab", "pmr", "physical medicine"], [
        section("Rehabilitation", text("onset", "Onset and duration"), text("factors", "Aggravating / relieving factors"),
                text("oedema", "Oedema / limb girth"), ta("balance", "Balance assessment", rows=1), ta("adl", "Activities of daily living", rows=2),
                num("sessions", "Sessions planned", None, 0, 100), ta("progress", "Progress since last visit", rows=2),
                key="rehab", tone="pink"),
    ], icon="Accessibility", order=13),
]
