"""Monitoring suite: intake/output flowsheet, diabetic (GRBS / insulin) chart, neuro observations and the vitals chart."""

from ..dsl import O2_DEVICES, band, calc, choice, dt, num, rng, score, section, sel, ta, text, when, yn
from .nursing import GCS_BANDS, GCS_EYE, GCS_MOTOR, GCS_VERBAL, PUPIL_REACT, PUPIL_SIZE

N = ["nurse", "doctor"]
VIEW = ["doctor", "nurse"]
POWER = ["5 — Normal", "4 — Against resistance", "3 — Against gravity", "2 — Gravity eliminated", "1 — Flicker", "0 — None"]

IO = {
    "key": "monitoring.io", "suite": "monitoring", "title": "Intake / Output", "short": "I/O", "icon": "Droplets", "order": 1, "roles": N, "view_roles": VIEW,
    "component": "io_flowsheet",
    "description": "Fluid balance flowsheet — clinical day 08:00 → 08:00, urine output in mL/kg/h and cumulative balance since admission.",
}

DIABETIC = {
    "key": "monitoring.diabetic", "suite": "monitoring", "title": "Diabetic Chart (GRBS / Insulin)", "short": "GRBS", "icon": "Droplet",
    "order": 2, "roles": N, "view_roles": VIEW, "multi_entry": True, "summary": ["timing", "insulin_dose"],
    "description": "Capillary blood glucose with insulin given — hypoglycaemia and hyperglycaemia flagged.",
    "sections": [
        section("Reading", dt(), sel("timing", "Timing", ["Fasting", "Pre-breakfast", "Post-breakfast (2 h)", "Pre-lunch", "Post-lunch (2 h)",
                                                         "Pre-dinner", "Post-dinner (2 h)", "Bedtime", "3 AM", "Random"], required=True),
                num("grbs", "GRBS", "mg/dL", 10, 900, required=True, score_value=True), yn("ketones_checked", "Urine / blood ketones checked",
                                                                                         show_if=when("grbs", gt=250)),
                sel("ketones", "Ketones", ["Negative", "Trace", "+", "++", "+++"], show_if=when("ketones_checked", eq="Yes")), tone="blue"),
        section("Insulin", yn("insulin_given", "Insulin given", required=True),
                sel("insulin_type", "Insulin", ["Regular (Actrapid / Huminsulin R)", "Lispro", "Aspart", "Glulisine", "NPH (Insulatard)", "Glargine",
                                                "Detemir", "Degludec", "Premix 30/70", "Premix 50/50", "IV infusion"],
                    show_if=when("insulin_given", eq="Yes"), required_if=when("insulin_given", eq="Yes")),
                num("insulin_dose", "Dose", "units", 0, 200, step=0.5, show_if=when("insulin_given", eq="Yes"), required_if=when("insulin_given", eq="Yes")),
                sel("route", "Route", ["SC", "IV infusion"], show_if=when("insulin_given", eq="Yes")),
                sel("site", "Site", ["Abdomen", "Right arm", "Left arm", "Right thigh", "Left thigh"], show_if=when("route", eq="SC")),
                yn("hypo_protocol", "Hypoglycaemia protocol followed", show_if=when("grbs", lt=70), required_if=when("grbs", lt=70)),
                text("hypo_treatment", "Hypoglycaemia treatment given", show_if=when("grbs", lt=70), placeholder="e.g. 25% dextrose 50 mL IV, recheck 15 min"),
                yn("doctor_informed", "Doctor informed"), ta("remarks", "Remarks", rows=2), tone="green"),
    ],
    "score": score(["grbs"], "GRBS", method="value", unit="mg/dL"),
    "bands": [
        band("Hypoglycaemia", "red", lt=70, reassess=0.25, alert=True,
             action="Hypoglycaemia protocol: 15–20 g oral glucose if conscious, else 25% dextrose IV as per order; recheck GRBS in 15 minutes.",
             task="Hypoglycaemia protocol now, recheck GRBS in 15 min, inform doctor", priority="STAT", category="Medication"),
        band("In target", "green", lo=70, hi=180, reassess=6, action="Continue the current regimen."),
        band("High", "amber", lo=181, hi=250, reassess=4, action="Insulin correction as per sliding scale."),
        band("Very high", "red", lo=251, reassess=2, action="Check ketones, inform the doctor, correction insulin as ordered.",
             task="Check ketones, correction insulin as ordered, inform doctor", priority="Urgent", category="Medication"),
    ],
}

NEURO = {
    "key": "monitoring.neuro", "suite": "monitoring", "title": "Neuro Observation Chart", "short": "Neuro obs", "icon": "Brain", "order": 3,
    "roles": N, "view_roles": VIEW, "multi_entry": True, "summary": ["pupil_right_size", "pupil_left_size"],
    "description": "GCS, pupils, limb power and vitals — head injury, stroke, post-neurosurgery.",
    "sections": [
        section("GCS", dt(), choice("eye", "Eye (E)", GCS_EYE, ui="segmented", required=True),
                choice("verbal", "Verbal (V)", GCS_VERBAL, ui="segmented", required=True),
                choice("motor", "Motor (M)", GCS_MOTOR, ui="segmented", required=True), tone="blue"),
        section("Pupils", sel("pupil_right_size", "Right size", PUPIL_SIZE, required=True), sel("pupil_right_reaction", "Right reaction", PUPIL_REACT, required=True),
                sel("pupil_left_size", "Left size", PUPIL_SIZE, required=True), sel("pupil_left_reaction", "Left reaction", PUPIL_REACT, required=True),
                tone="violet"),
        section("Limb power (MRC)", sel("power_rul", "Right upper limb", POWER), sel("power_lul", "Left upper limb", POWER),
                sel("power_rll", "Right lower limb", POWER), sel("power_lll", "Left lower limb", POWER), tone="pink"),
        section("Vitals", num("bp_sys", "BP systolic", "mmHg", 0, 300), num("bp_dia", "BP diastolic", "mmHg", 0, 200),
                num("pulse", "Pulse", "bpm", 0, 300), num("resp_rate", "Resp. rate", "/min", 0, 80), num("spo2", "SpO₂", "%", 0, 100),
                num("temperature", "Temperature", "°F", 85, 110, step=0.1), yn("seizure", "Seizure since last check"),
                ta("remarks", "Remarks", rows=2), tone="green"),
    ],
    "score": score(["eye", "verbal", "motor"], "GCS", lo=3, hi=15, lower_is_worse=True),
    "bands": GCS_BANDS,
}

# NEWS2 (RCP 2017, SpO₂ scale 1) — temperature in °F
VITALS = {
    "key": "monitoring.vitals", "suite": "monitoring", "title": "Vitals Chart", "short": "Vitals", "icon": "HeartPulse", "order": 4,
    "roles": N, "view_roles": VIEW, "multi_entry": True, "mirror": [{"kind": "vitals"}],
    "description": "Bedside observations with a live NEWS2 — signed entries are charted to the vitals trend and trigger escalation.",
    "sections": [
        section("Observations", dt(),
                num("resp_rate", "Respiratory rate", "/min", 0, 80, required=True,
                    score_ranges=[rng(3, hi=8), rng(1, lo=9, hi=11), rng(0, lo=12, hi=20), rng(2, lo=21, hi=24), rng(3, lo=25)]),
                num("spo2", "SpO₂", "%", 0, 100, required=True,
                    score_ranges=[rng(3, hi=91), rng(2, lo=92, hi=93), rng(1, lo=94, hi=95), rng(0, lo=96)]),
                sel("o2_support", "Air or oxygen", O2_DEVICES, default="Room air", required=True,
                    score_map={o: (0 if o == "Room air" else 2) for o in O2_DEVICES}),
                num("bp_sys", "Systolic BP", "mmHg", 0, 300, required=True,
                    score_ranges=[rng(3, hi=90), rng(2, lo=91, hi=100), rng(1, lo=101, hi=110), rng(0, lo=111, hi=219), rng(3, lo=220)]),
                num("bp_dia", "Diastolic BP", "mmHg", 0, 200), calc("map", "MAP", "map", ["bp_sys", "bp_dia"], "mmHg", 0),
                num("pulse", "Pulse", "bpm", 0, 300, required=True,
                    score_ranges=[rng(3, hi=40), rng(1, lo=41, hi=50), rng(0, lo=51, hi=90), rng(1, lo=91, hi=110), rng(2, lo=111, hi=130), rng(3, lo=131)]),
                choice("consciousness", "Consciousness (ACVPU)", [("Alert", 0), ("New confusion", 3), ("Voice", 3), ("Pain", 3), ("Unresponsive", 3)],
                       ui="segmented", required=True),
                num("temperature", "Temperature", "°F", 85, 110, step=0.1, required=True,
                    score_ranges=[rng(3, lt=95.1), rng(1, lo=95.1, lt=96.9), rng(0, lo=96.9, lt=100.5), rng(1, lo=100.5, lt=102.3), rng(2, lo=102.3)]),
                tone="blue"),
        section("Other", num("pain_score", "Pain (0–10)", None, 0, 10), num("grbs", "GRBS", "mg/dL", 10, 900),
                num("weight", "Weight", "kg", 0.5, 400, step=0.1), ta("remarks", "Remarks", rows=2), tone="green"),
    ],
    "score": score(["resp_rate", "spo2", "o2_support", "bp_sys", "pulse", "consciousness", "temperature"], "NEWS2", lo=0, hi=20),
    "bands": [
        band("Low", "green", lo=0, hi=4, reassess=12, action="Minimum 12-hourly observations (4–6-hourly for scores 1–4); any single parameter "
             "scoring 3 needs urgent ward-based review."),
        band("Medium", "amber", lo=5, hi=6, reassess=1, action="Urgent review by the ward doctor; observations at least hourly."),
        band("High", "red", lo=7, reassess=0.5, action="Emergency assessment by the critical-care team; continuous monitoring; consider ICU."),
    ],
}

FORMS = [IO, DIABETIC, NEURO, VITALS]
