"""OT suite: the paperless 21-sheet OT file grouped Pre-op · Intra-op · Post-op.

Sheets are saved against the admission (and the OT booking when there is one). The WHO Sign In / Time Out /
Sign Out sheets also advance the OT module's surgical safety checklist for the booking; the SSI bundle is posted to
Infection Surveillance › Bundle Audits."""

from ..dsl import (
    ANAESTHESIA,
    ASA,
    SIDES,
    band,
    calc,
    choice,
    compliance_bands,
    date,
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
    yn_opts,
)

OT = ["doctor", "nurse"]
VIEW = ["doctor", "nurse", "quality"]
DOC = ["doctor"]


def sheet(key: str, title: str, short: str, group: str, order: int, sections: list[dict], *, icon: str = "FileText", description: str = "",
          sign_roles: list[str] | None = None, **kw) -> dict:
    d = {"key": f"ot.{key}", "suite": "ot", "title": title, "short": short, "group": group, "order": order, "icon": icon,
         "description": description, "roles": OT, "view_roles": VIEW, "sections": sections}
    if sign_roles:
        d["sign_roles"] = sign_roles
    d.update(kw)
    return d


def checks(*items: tuple[str, str], na: bool = False) -> list[dict]:
    return [yn(k, label, na=na, required=True) for k, label in items]


# ------------------------------------------------------------------ PRE-OP

STOP_BANG = [("sb_snore", "Snores loudly"), ("sb_tired", "Tired / sleepy in the daytime"), ("sb_observed", "Observed apnoea"),
             ("sb_pressure", "High blood pressure (treated or not)"), ("sb_bmi", "BMI > 35 kg/m²"), ("sb_age", "Age > 50 years"),
             ("sb_neck", "Neck circumference > 40 cm"), ("sb_male", "Male")]
PAC = sheet("pac", "Pre-anaesthesia Check (PAC)", "PAC", "Pre-op", 1, icon="Stethoscope", sign_roles=DOC, also_in=["doctor"],
            description="Anaesthetist's pre-operative assessment, ASA grade, airway, STOP-BANG and fitness for anaesthesia.",
            summary=["asa_grade", "fitness"],
            sections=[
                section("Patient & procedure", dt(), text("procedure", "Proposed procedure", required=True, prefill="booking.procedure"),
                        doctor("anaesthetist", "Anaesthetist", default="me", required=True),
                        num("weight", "Weight", "kg", 0.5, 400, step=0.1, prefill="weight", required=True), num("height", "Height", "cm", 30, 250, prefill="vitals.height"),
                        calc("bmi", "BMI", "bmi", ["weight", "height"], "kg/m²"), tone="blue"),
                section("History", multi("comorbidities", "Co-morbidities", ["Hypertension", "Diabetes", "IHD", "Heart failure", "Valvular disease",
                                                                            "Asthma / COPD", "OSA", "CKD", "Liver disease", "Thyroid", "Epilepsy",
                                                                            "Stroke", "Anaemia", "Pregnancy", "None"]),
                        ta("medications", "Current medications", rows=2), text("anticoagulants", "Anticoagulant / antiplatelet & last dose"),
                        text("allergies", "Allergies", prefill="patient.allergies"), ta("previous_anaesthesia", "Previous anaesthesia & complications", rows=2),
                        seg("functional_capacity", "Functional capacity", ["≥ 4 METs (climbs 2 flights)", "< 4 METs", "Unable to assess"]),
                        multi("habits", "Habits", ["Smoking", "Alcohol", "Tobacco chewing", "None"]), tone="pink"),
                section("Examination & airway", num("pulse", "Pulse", "bpm", 0, 300), num("bp_sys", "BP systolic", "mmHg", 0, 300),
                        num("bp_dia", "BP diastolic", "mmHg", 0, 200), num("spo2", "SpO₂", "%", 0, 100),
                        seg("mallampati", "Mallampati", ["I", "II", "III", "IV"], required=True),
                        seg("mouth_opening", "Mouth opening", ["> 3 fingers", "2–3 fingers", "< 2 fingers"]),
                        seg("tmd", "Thyromental distance", ["> 6.5 cm", "6–6.5 cm", "< 6 cm"]),
                        seg("neck_movement", "Neck movement", ["Full", "Restricted"]),
                        multi("dentition", "Dentition", ["Normal", "Loose teeth", "Dentures", "Crowns / bridges", "Edentulous"]),
                        ta("cvs_rs", "CVS / RS examination", rows=2), text("spine", "Spine (for regional)"), tone="green"),
                section("STOP-BANG (obstructive sleep apnoea)", *[yn(k, label) for k, label in STOP_BANG], tone="violet"),
                section("Investigations", num("hb", "Hb", "g/dL", 2, 25, step=0.1), num("platelets", "Platelets", "×10³/µL", 0, 2000),
                        num("inr", "INR", None, 0, 20, step=0.1), num("creatinine", "Creatinine", "mg/dL", 0, 30, step=0.1),
                        num("sodium", "Sodium", "mmol/L", 90, 200), num("potassium", "Potassium", "mmol/L", 1, 10, step=0.1),
                        num("rbs", "Blood sugar", "mg/dL", 10, 900), text("ecg", "ECG"), text("cxr", "Chest X-ray"), text("echo", "2D echo"),
                        text("viral_markers", "HIV / HBsAg / HCV"), tone="amber"),
                section("Plan & fitness", sel("asa_grade", "ASA grade", ASA, required=True, prefill="booking.asa_grade"),
                        sel("plan", "Anaesthesia plan", ANAESTHESIA, required=True, prefill="booking.anaesthesia_type"),
                        seg("fitness", "Fitness", ["Fit", "Fit — high risk explained", "Optimise and review", "Unfit / deferred"], required=True),
                        ta("instructions", "Pre-operative instructions", rows=3,
                           placeholder="NBM: solids 6 h, clear fluids 2 h; continue antihypertensives; stop metformin on morning of surgery"),
                        text("premedication", "Premedication"), yn("blood_arranged", "Blood to be arranged", na=True),
                        yn("icu_bed", "Post-op ICU / HDU bed needed", na=True), yn("consent_anaesthesia", "Consent for anaesthesia taken", required=True),
                        tone="blue"),
            ],
            score=score([k for k, _ in STOP_BANG], "STOP-BANG", method="count_yes", lo=0, hi=8),
            bands=[band("Low OSA risk", "green", lo=0, hi=2), band("Intermediate OSA risk", "amber", lo=3, hi=4,
                                                                    action="Anticipate difficult mask ventilation; minimise opioids."),
                   band("High OSA risk", "red", lo=5, action="Plan for difficult airway, CPAP availability and monitored post-op bed.")])

SURGEON_PREOP = sheet(
    "surgeon_preop", "Surgeon's Pre-operative Note", "Surgeon's Pre-op Note", "Pre-op", 2, icon="ClipboardPen", sign_roles=DOC,
    description="The operating surgeon's assessment, indication and plan — written before the patient is shifted.",
    summary=["planned_procedure", "urgency"],
    sections=[
        section("1. Diagnosis & indication", dt(required=True), ta("preop_diagnosis", "Pre-operative diagnosis", rows=2, required=True,
                                                                  prefill="admission.diagnosis"),
                ta("planned_procedure", "Planned procedure", rows=2, required=True, prefill="booking.procedure"),
                sel("side", "Side / laterality", SIDES, prefill="booking.side"), ta("indication", "Indication for surgery", rows=2),
                seg("urgency", "Urgency", ["Elective", "Urgent", "Emergency"], required=True), ta("alternatives", "Alternatives discussed", rows=2),
                tone="blue"),
        section("2. Assessment", ta("clinical_summary", "Clinical summary / examination", rows=3), yn("investigations_reviewed", "Investigations reviewed"),
                yn("imaging_reviewed", "Imaging reviewed"), ta("comorbidities", "Co-morbidities & optimisation", rows=2),
                yn("on_anticoagulant", "On anticoagulant / antiplatelet"), tone="pink"),
        section("3. Plan & preparation", yn("blood_arranged", "Blood / components arranged", na=True), yn("icu_bed", "ICU / HDU bed needed post-op", na=True),
                yn("implants_arranged", "Implants / special equipment arranged", na=True), yn("site_marked", "Operative site marked", required=True),
                yn("consent_taken", "Surgical consent taken (risks explained)", required=True), ta("risks_explained", "Specific risks explained", rows=2),
                text("expected_duration", "Expected duration", prefill="booking.duration"),
                ta("preop_orders", "Pre-op orders (NBM, antibiotic, bowel prep, shave …)", rows=2),
                doctor("surgeon", "Surgeon", default="me", required=True, prefill="booking.surgeon"), tone="green"),
    ])

SITE_MARKING = sheet(
    "site_marking", "Site Marking", "Site Marking", "Pre-op", 3, icon="MapPin", sign_roles=DOC,
    description="Operative site marked by the operating surgeon with the patient involved, before pre-medication.",
    summary=["site", "side"],
    sections=[
        section("Marking", dt(), text("procedure", "Procedure", required=True, prefill="booking.procedure"),
                text("site", "Site", required=True), sel("side", "Side", SIDES, required=True, prefill="booking.side"),
                yn("marked", "Site marked with indelible marker (arrow / initials)", required=True),
                sel("not_marked_reason", "Reason not marked", ["Single organ / midline", "Mucosal surface / perineum", "Teeth", "Premature infant",
                                                               "Patient refused", "Other"],
                    show_if=when("marked", eq="No"), required_if=when("marked", eq="No")),
                yn("patient_involved", "Patient / attendant involved and confirmed", required=True),
                yn("visible_after_drape", "Mark visible after prep and draping", na=True),
                doctor("marked_by", "Marked by (operating surgeon)", default="me", required=True),
                {"key": "photo", "label": "Diagram / photo", "type": "file"}, tone="blue"),
    ])

PREOP_CHECKS = [
    ("chk_id_band", "Identity band on, details correct"), ("chk_consent_surgery", "Surgical consent signed"),
    ("chk_consent_anaesthesia", "Anaesthesia consent signed"), ("chk_site_marked", "Site marked"), ("chk_npo", "Nil by mouth as instructed"),
    ("chk_bath", "Pre-op bath with antiseptic"), ("chk_hair", "Hair removed by clipper (if needed)"),
    ("chk_jewellery", "Jewellery, dentures, prostheses, hairpins removed"), ("chk_makeup", "Make-up and nail polish removed"),
    ("chk_void", "Bladder voided / catheter in situ"), ("chk_premed", "Pre-medication given as ordered"),
    ("chk_reports", "Investigation reports & imaging attached"), ("chk_blood", "Blood cross-matched & arranged"),
    ("chk_implants", "Implants / special items sent"), ("chk_pregnancy", "Pregnancy test (if applicable)"),
]
PREOP_CHECKLIST = sheet(
    "preop_checklist", "Pre-operative Checklist", "Pre-op Checklist", "Pre-op", 4, icon="ListChecks",
    description="Ward-to-OT readiness checklist before shifting the patient.",
    sections=[
        section("Readiness", dt(), *[yn(k, label, na=True, required=True) for k, label in PREOP_CHECKS], tone="blue"),
        section("Status at shifting", dt("npo_since", "Nil by mouth since", default=None),
                calc("npo_hours", "Fasting duration", "hours_since", ["npo_since"], "h", 1),
                num("pulse", "Pulse", "bpm", 0, 300), num("bp_sys", "BP systolic", "mmHg", 0, 300), num("bp_dia", "BP diastolic", "mmHg", 0, 200),
                num("temperature", "Temperature", "°F", 85, 110, step=0.1), num("spo2", "SpO₂", "%", 0, 100), num("grbs", "GRBS", "mg/dL", 10, 900),
                num("weight", "Weight", "kg", 0.5, 400, step=0.1, prefill="weight"), text("allergies", "Allergies", prefill="patient.allergies"),
                text("iv_access", "IV access (size / site)"), sel("valuables", "Valuables", ["Handed over to relative", "None"]),
                nurse("handed_by", "Handed over by (ward)", default="me"), nurse("received_by", "Received by (OT)"), tone="green"),
    ],
    score=score([k for k, _ in PREOP_CHECKS], "Readiness", method="percent_yes", lo=0, hi=100, unit="%"),
    bands=[band("Ready for OT", "green", lo=100), band("Gaps — resolve before shifting", "amber", lt=100,
                                                       action="Resolve the unchecked items or record why they do not apply.")])

PRE_INDUCTION_CHECKS = [
    ("chk_identity", "Identity, procedure and consent re-confirmed"), ("chk_pac", "PAC reviewed, fitness confirmed"),
    ("chk_npo", "Fasting confirmed"), ("chk_iv", "IV access patent"), ("chk_machine", "Anaesthesia machine checked"),
    ("chk_suction", "Suction working"), ("chk_airway", "Airway equipment & difficult airway cart ready"),
    ("chk_drugs", "Drugs drawn and labelled"), ("chk_emergency", "Emergency drugs & defibrillator available"),
    ("chk_monitors", "Monitors attached (ECG, NIBP, SpO₂, EtCO₂, temperature)"),
]
PRE_INDUCTION = sheet(
    "pre_induction", "Pre-induction Assessment", "Pre-induction", "Pre-op", 5, icon="Gauge", sign_roles=DOC,
    description="Anaesthetist's check in the induction room immediately before anaesthesia.",
    sections=[
        section("Checks", dt(), *[yn(k, label, na=True, required=True) for k, label in PRE_INDUCTION_CHECKS], tone="blue"),
        section("Baseline", num("pulse", "Pulse", "bpm", 0, 300), num("bp_sys", "BP systolic", "mmHg", 0, 300), num("bp_dia", "BP diastolic", "mmHg", 0, 200),
                num("spo2", "SpO₂ (room air)", "%", 0, 100), text("iv_access", "IV access", placeholder="e.g. 18G left forearm"),
                ta("changes", "Changes since PAC", rows=2), tone="green"),
    ],
    score=score([k for k, _ in PRE_INDUCTION_CHECKS], "Readiness", method="percent_yes", lo=0, hi=100, unit="%"),
    bands=[band("Ready for induction", "green", lo=100), band("Not ready", "red", lt=100, action="Do not induce until every applicable item is done.")])

# ------------------------------------------------------------------ INTRA-OP

WHO_SIGN_IN = sheet(
    "who_sign_in", "WHO Surgical Safety Checklist — Sign In", "WHO Sign In", "Intra-op", 1, icon="ShieldCheck",
    description="Before induction of anaesthesia — with at least the nurse and anaesthetist.",
    mirror=[{"kind": "who_checklist", "options": {"phase": "sign_in"}}],
    sections=[
        section("Sign in", dt(),
                yn("si_identity_site_consent", "Patient has confirmed identity, site, procedure and consent", required=True),
                yn_opts("si_site_marked", "Site marked", ["Yes", "Not applicable"], required=True),
                yn("si_anaesthesia_check", "Anaesthesia machine and medication check complete", required=True),
                yn("si_pulse_oximeter", "Pulse oximeter on the patient and functioning", required=True),
                yn_opts("si_known_allergy", "Does the patient have a known allergy?", ["No", "Yes"], required=True),
                yn_opts("si_difficult_airway", "Difficult airway or aspiration risk?", ["No", "Yes — equipment and assistance available"], required=True),
                yn_opts("si_blood_loss_risk", "Risk of > 500 mL blood loss (7 mL/kg in children)?",
                        ["No", "Yes — two IVs / central access and fluids planned"], required=True),
                nurse("coordinator", "Checklist coordinator", default="me", required=True), tone="blue"),
    ])

WHO_TIME_OUT = sheet(
    "who_time_out", "WHO Surgical Safety Checklist — Time Out", "WHO Time Out", "Intra-op", 2, icon="Timer",
    description="Before skin incision — with nurse, anaesthetist and surgeon.",
    mirror=[{"kind": "who_checklist", "options": {"phase": "time_out"}}],
    sections=[
        section("Time out", dt(),
                yn("to_team_introduced", "All team members introduced by name and role", required=True),
                yn("to_confirmed", "Surgeon, anaesthetist and nurse confirm patient, site and procedure", required=True),
                yn_opts("to_antibiotic_prophylaxis", "Antibiotic prophylaxis given within the last 60 minutes", ["Yes", "Not applicable"], required=True),
                yn_opts("to_imaging_displayed", "Essential imaging displayed", ["Yes", "Not applicable"], required=True), tone="blue"),
        section("Anticipated critical events", ta("surgeon_events", "Surgeon — critical or non-routine steps, duration, anticipated blood loss", rows=2),
                ta("anaesthesia_concerns", "Anaesthetist — patient-specific concerns", rows=2),
                yn("sterility_confirmed", "Nursing — sterility (incl. indicator results) confirmed", required=True),
                text("equipment_concerns", "Nursing — equipment issues or concerns"), tone="amber"),
    ])

TECHNIQUE = sheet(
    "technique_airway", "Anaesthesia Technique & Airway", "Technique & Airway", "Intra-op", 3, icon="Wind", sign_roles=DOC,
    description="Technique, airway management and regional block details.", summary=["technique", "airway_device"],
    sections=[
        section("Technique", dt(), sel("technique", "Technique", ANAESTHESIA, required=True, prefill="booking.anaesthesia_type"),
                text("induction_agents", "Induction agents", placeholder="e.g. Propofol 120 mg, Fentanyl 100 mcg, Atracurium 35 mg"), tone="blue"),
        section("Airway", sel("airway_device", "Airway device", ["ETT", "Reinforced ETT", "Double-lumen tube", "LMA / i-gel", "Face mask",
                                                                  "Nasal cannula", "Tracheostomy", "None (regional)"]),
                text("tube_size", "Size"), seg("route", "Route", ["Oral", "Nasal"]), seg("cormack_lehane", "Cormack-Lehane grade", ["1", "2a", "2b", "3", "4"]),
                num("attempts", "Attempts", None, 1, 10), yn("difficult_airway", "Difficult airway"),
                multi("airway_aids", "Aids used", ["Bougie", "Video laryngoscope", "Stylet", "Fibreoptic", "BURP"], show_if=when("difficult_airway", eq="Yes")),
                num("fixed_at", "Tube fixed at", "cm", 5, 40), multi("confirmation", "Confirmation", ["EtCO₂ trace", "Bilateral air entry", "Chest rise"]),
                sel("ventilation", "Ventilation", ["Spontaneous", "Volume control", "Pressure control", "SIMV", "Manual"]),
                show_if=when("technique", in_=["General (GA)", "MAC / sedation"]), tone="green"),
        section("Regional", sel("position", "Position", ["Sitting", "Left lateral", "Right lateral"]), text("level", "Level / space", placeholder="e.g. L3–L4"),
                text("needle", "Needle", placeholder="e.g. 25G Quincke"), text("block_drug", "Drug & dose", placeholder="e.g. 0.5% Bupivacaine heavy 3 mL"),
                text("block_height", "Block height achieved", placeholder="e.g. T6"), num("block_attempts", "Attempts", None, 1, 10),
                yn("usg_guided", "Ultrasound guided"), yn("csf_clear", "CSF clear", na=True),
                show_if=when("technique", nin=["General (GA)", "MAC / sedation"]), tone="violet"),
    ])

ANAESTHESIA_RECORD = sheet(
    "anaesthesia_record", "Anaesthesia Record", "Anaesthesia Record", "Intra-op", 4, icon="Activity", sign_roles=DOC,
    description="Intra-operative vitals, events and emergence.",
    sections=[
        section("Times", dt("induction_at", "Induction", required=True), dt("incision_at", "Incision", default=None),
                dt("end_at", "End of anaesthesia", default=None), calc("duration_min", "Anaesthesia duration", "minutes_between", ["induction_at", "end_at"], "min", 0),
                sel("position", "Position", ["Supine", "Prone", "Lithotomy", "Lateral", "Trendelenburg", "Reverse Trendelenburg", "Beach chair"]),
                multi("protection", "Protection", ["Eyes taped", "Pressure points padded", "Warming blanket", "Fluid warmer", "DVT stockings / SCD"]),
                tone="blue"),
        section("Intra-op vitals", lines("vitals", "Readings", [
            time("at", "Time", required=True), num("pulse", "HR"), num("bp_sys", "SBP"), num("bp_dia", "DBP"), num("spo2", "SpO₂"), num("etco2", "EtCO₂"),
            num("temperature", "Temp °C", step=0.1), calc("map", "MAP", "map", ["bp_sys", "bp_dia"], decimals=0)]), tone="green"),
        section("Events & emergence", ta("events", "Intra-operative events", rows=3), text("reversal", "Reversal", placeholder="e.g. Neostigmine 2.5 mg + Glycopyrrolate 0.4 mg"),
                seg("extubation", "Extubation", ["Awake", "Deep", "Not extubated — shifted ventilated", "Not applicable"]),
                sel("condition_end", "Condition at end", ["Stable", "Stable on support", "Unstable"]), tone="amber"),
    ])

DRUGS_IO = sheet(
    "drugs_io", "Intra-operative Drugs & I/O", "Drugs & I/O", "Intra-op", 5, icon="Droplets",
    description="Drugs given, fluids, blood loss and urine output with the intra-operative balance.",
    sections=[
        section("Drugs", lines("drugs", "Drugs given", [time("at", "Time"), text("drug", "Drug", required=True), text("dose", "Dose"),
                                                        sel("route", "Route", ["IV", "IM", "SC", "Inhalational", "Intrathecal", "Epidural", "Perineural", "Local"])]),
                tone="blue"),
        section("Intake", lines("fluids", "Fluids & blood", [sel("fluid", "Fluid", ["Ringer lactate", "Normal saline", "Plasmalyte", "Dextrose 5%",
                                                                                   "DNS", "Colloid", "PRBC", "FFP", "Platelets", "Albumin"], required=True),
                                                            num("volume", "Volume mL", lo=0, required=True)]),
                calc("intake_total", "Total intake", "lines_sum", ["fluids", "volume"], "mL", 0), tone="green"),
        section("Output", num("blood_loss", "Estimated blood loss", "mL", 0, 20000), num("urine", "Urine output", "mL", 0, 10000),
                num("other_loss", "Other losses (suction, drains)", "mL", 0, 10000),
                calc("output_total", "Total output", "sum", ["blood_loss", "urine", "other_loss"], "mL", 0),
                calc("balance", "Intra-op balance (intake − output)", "diff", ["intake_total", "output_total"], "mL", 0), tone="amber"),
    ])

INTRAOP_NURSING = sheet(
    "intraop_nursing", "Intra-operative Nursing Record", "Intra-op Nursing", "Intra-op", 6, icon="HeartHandshake",
    description="Scrub and circulating nurse record — positioning, skin prep, diathermy, tourniquet and devices.",
    sections=[
        section("Team & position", dt(), nurse("scrub_nurse", "Scrub nurse", required=True), nurse("circulating_nurse", "Circulating nurse", default="me"),
                sel("position", "Position", ["Supine", "Prone", "Lithotomy", "Lateral", "Trendelenburg", "Beach chair"], required=True),
                multi("positioning_aids", "Positioning aids", ["Gel pads", "Arm boards", "Head ring", "Stirrups", "Bean bag", "Kidney rest"]), tone="blue"),
        section("Skin prep & diathermy", sel("skin_prep", "Skin prep", ["Chlorhexidine 2% in alcohol", "Povidone-iodine", "Povidone-iodine in alcohol"], required=True),
                seg("diathermy", "Diathermy", ["Monopolar", "Bipolar", "Both", "None"]), text("plate_site", "Return plate site", show_if=when("diathermy", in_=["Monopolar", "Both"])),
                yn("plate_skin_ok", "Skin under plate intact after removal", na=True), tone="green"),
        section("Tourniquet", yn("tourniquet", "Tourniquet used", required=True), text("tourniquet_site", "Site", show_if=when("tourniquet", eq="Yes")),
                num("tourniquet_pressure", "Pressure", "mmHg", 0, 500, show_if=when("tourniquet", eq="Yes")),
                time("tourniquet_on", "On", show_if=when("tourniquet", eq="Yes")), time("tourniquet_off", "Off", show_if=when("tourniquet", eq="Yes")),
                calc("tourniquet_minutes", "Tourniquet time", "minutes_between", ["tourniquet_on", "tourniquet_off"], "min", 0,
                     show_if=when("tourniquet", eq="Yes"), help="Alert the surgeon at 90 min (limb)"), tone="amber"),
        section("Devices & closure", multi("devices", "Devices in situ at end", ["Urinary catheter", "Drain", "Ryle's tube", "Central line", "Arterial line",
                                                                                "Epidural catheter", "None"]),
                text("dressing", "Dressing"), ta("skin_condition", "Skin condition at end / remarks", rows=2), tone="violet"),
    ])

COUNT_ITEMS = ["Swabs / gauze", "Abdominal packs (mops)", "Needles", "Blades", "Instruments", "Sutures", "Ligaclips", "Bulldogs / small items", "Other"]
COUNTS = sheet(
    "counts", "Instrument, Swab & Needle Counts", "Counts", "Intra-op", 7, icon="ListOrdered",
    description="Initial, added and final counts with automatic reconciliation — do not close with an unresolved discrepancy.",
    summary=["counts_status"],
    sections=[
        section("Counts", dt(), lines("count_lines", "Counts", [
            sel("item", "Item", COUNT_ITEMS, required=True), num("initial", "Initial", lo=0, required=True), num("added", "Added", lo=0),
            calc("total", "Total", "sum", ["initial", "added"], decimals=0), num("cavity", "Before cavity closure", lo=0),
            num("final", "Final", lo=0, required=True), calc("discrepancy", "Difference", "diff", ["total", "final"], decimals=0)], required=True),
            calc("discrepancies", "Lines with a discrepancy", "lines_nonzero", ["count_lines", "discrepancy"], decimals=0, score_value=True),
            tone="blue"),
        section("Reconciliation", seg("counts_status", "Counts", ["Correct", "Discrepancy — resolved", "Discrepancy — unresolved"], required=True),
                yn("xray_done", "Intra-op X-ray done", show_if=when("discrepancies", gt=0)),
                ta("resolution", "Search & resolution", rows=2, show_if=when("discrepancies", gt=0), required_if=when("discrepancies", gt=0)),
                yn("surgeon_informed", "Surgeon informed", show_if=when("discrepancies", gt=0), required_if=when("discrepancies", gt=0)),
                nurse("counted_by", "Counted by (scrub)", required=True), nurse("verified_by", "Verified by (circulating)", default="me", required=True),
                tone="green"),
    ],
    score=score(["discrepancies"], "Discrepancies", method="value", lo=0),
    bands=[band("Counts reconciled", "green", hi=0), band("Count discrepancy", "red", lo=1, alert=True,
                                                          action="Do not close: re-count, search the field and floor, intra-op X-ray, inform the surgeon and document.")])

IMPLANTS = sheet(
    "implants", "Implants Record", "Implants", "Intra-op", 8, icon="Cog",
    description="Implant traceability — manufacturer, reference, lot, serial and expiry with sticker sheet.",
    sections=[
        section("Implants", dt(), yn("implants_used", "Implants used", required=True),
                lines("implant_lines", "Implants", [text("name", "Implant", required=True), text("manufacturer", "Manufacturer"),
                                                    text("ref_no", "REF / catalogue"), text("lot", "Lot / batch", required=True), text("serial", "Serial"),
                                                    text("size", "Size"), date("expiry", "Expiry"), yn("sticker", "Sticker pasted")],
                      show_if=when("implants_used", eq="Yes"), required_if=when("implants_used", eq="Yes")),
                yn("sterility_verified", "Sterility indicator & expiry verified", show_if=when("implants_used", eq="Yes")),
                {"key": "sticker_sheet", "label": "Sticker sheet scan", "type": "file", "show_if": when("implants_used", eq="Yes")},
                ta("remarks", "Remarks", rows=2), tone="blue"),
    ])

SPECIMENS = sheet(
    "specimens", "Specimens Record", "Specimens", "Intra-op", 9, icon="FlaskConical",
    description="Specimens labelled, fixed and dispatched with the requisition.",
    sections=[
        section("Specimens", dt(), yn("specimens_taken", "Specimens taken", required=True),
                lines("specimen_lines", "Specimens", [text("specimen", "Specimen", required=True), text("site", "Site"), num("containers", "Containers", lo=1),
                                                      sel("fixative", "Fixative", ["10% formalin", "Normal saline", "Fresh / none", "Other"]),
                                                      sel("test", "Test", ["Histopathology", "Frozen section", "Culture & sensitivity", "Cytology", "Other"]),
                                                      yn("labelled", "Labelled & verified")],
                      show_if=when("specimens_taken", eq="Yes"), required_if=when("specimens_taken", eq="Yes")),
                time("sent_at", "Sent to lab at", show_if=when("specimens_taken", eq="Yes")),
                text("register_no", "Specimen register no.", show_if=when("specimens_taken", eq="Yes")),
                nurse("handed_by", "Handed over by", show_if=when("specimens_taken", eq="Yes")), tone="blue"),
    ])

WHO_SIGN_OUT = sheet(
    "who_sign_out", "WHO Surgical Safety Checklist — Sign Out", "WHO Sign Out", "Intra-op", 10, icon="ShieldCheck",
    description="Before the patient leaves the operating room.",
    mirror=[{"kind": "who_checklist", "options": {"phase": "sign_out"}}],
    sections=[
        section("Sign out", dt(), text("procedure_recorded", "Name of the procedure as recorded", required=True, prefill="booking.procedure"),
                yn_opts("so_counts_correct", "Instrument, sponge and needle counts correct", ["Yes", "No", "Not applicable"], required=True,
                        help="Check against the Counts sheet"),
                yn_opts("so_specimen_labelled", "Specimen labelled (incl. patient name)", ["Yes", "Not applicable"], required=True),
                text("so_equipment_issues", "Equipment problems to be addressed"),
                ta("so_recovery_concerns", "Key concerns for recovery and management", rows=2), tone="blue"),
    ])

OPERATIVE_NOTE = sheet(
    "operative_note", "Operative Note", "Operative Note", "Intra-op", 11, icon="FileSignature", sign_roles=DOC,
    description="Operating surgeon's record of the procedure.", summary=["procedure_done"],
    sections=[
        section("Team & times", dt(), doctor("surgeon", "Surgeon", default="me", required=True, prefill="booking.surgeon"),
                doctor("assistant", "Assistant", prefill="booking.assistant_surgeon"), doctor("anaesthetist", "Anaesthetist", prefill="booking.anaesthetist"),
                sel("anaesthesia", "Anaesthesia", ANAESTHESIA, prefill="booking.anaesthesia_type"),
                time("start_time", "Start", required=True), time("end_time", "End", required=True),
                calc("duration", "Duration", "minutes_between", ["start_time", "end_time"], "min", 0), tone="blue"),
        section("Procedure", ta("preop_dx", "Pre-operative diagnosis", rows=2, prefill="form:ot.surgeon_preop.preop_diagnosis"),
                ta("postop_dx", "Post-operative diagnosis", rows=2, required=True),
                ta("procedure_done", "Procedure performed", rows=2, required=True, prefill="booking.procedure"),
                text("incision", "Incision"), ta("findings", "Operative findings", rows=3, required=True), ta("steps", "Procedure details", rows=6, required=True),
                text("closure", "Closure"), text("drains", "Drains"), tone="green"),
        section("Outcome", num("blood_loss", "Estimated blood loss", "mL", 0, 20000), yn("specimens", "Specimens sent"), yn("implants", "Implants used"),
                seg("complications", "Complications", ["None", "Yes"], required=True),
                ta("complication_details", "Complication details", rows=2, show_if=when("complications", eq="Yes"), required_if=when("complications", eq="Yes")),
                sel("condition", "Condition at end", ["Stable", "Stable on support", "Critical"], required=True),
                ta("postop_plan", "Post-operative plan", rows=3), tone="amber"),
    ])

# ------------------------------------------------------------------ POST-OP

POSTOP_ORDERS = sheet(
    "postop_orders", "Post-operative Orders", "Post-op Orders", "Post-op", 1, icon="ClipboardList", sign_roles=DOC,
    description="Surgeon / anaesthetist orders for recovery and the ward.",
    sections=[
        section("Disposition", dt(), sel("shift_to", "Shift to", ["PACU / recovery", "ICU", "HDU", "Ward", "Day care"], required=True),
                sel("position", "Position", ["Supine", "Propped up 30°", "Lateral", "Prone", "Head elevated"]),
                sel("vitals_freq", "Vitals", ["Every 15 min × 1 h, then 30 min × 2 h, then hourly", "Hourly", "2-hourly", "4-hourly"], required=True),
                text("oxygen", "Oxygen", placeholder="e.g. 4 L/min via face mask till SpO₂ > 94% on room air"),
                text("diet", "Nil by mouth / diet", placeholder="e.g. NBM 6 h, then sips of water", required=True), tone="blue"),
        section("Medication", text("iv_fluids", "IV fluids", placeholder="e.g. RL 100 mL/h"),
                lines("medications", "Medications", [text("drug", "Drug", required=True), text("dose", "Dose"), sel("route", "Route", ["IV", "IM", "SC", "Oral", "PR"]),
                                                     text("frequency", "Frequency"), text("duration", "Duration")]),
                seg("dvt", "DVT prophylaxis", ["Mechanical", "Pharmacological", "Both", "Not indicated"]), tone="green"),
        section("Care & escalation", ta("drain_care", "Drains / catheter care", rows=2), ta("investigations", "Post-op investigations", rows=2),
                ta("call_if", "Call the doctor if", rows=2, placeholder="SBP < 90, HR > 120, SpO₂ < 92%, urine < 0.5 mL/kg/h, drain > 100 mL/h"),
                ta("special", "Special instructions", rows=2), tone="amber"),
    ])

ALDRETE = [
    ("al_activity", "Activity", [("Moves 4 limbs on command", 2), ("Moves 2 limbs", 1), ("Moves no limbs", 0)]),
    ("al_respiration", "Respiration", [("Breathes deeply, coughs freely", 2), ("Dyspnoea / limited breathing", 1), ("Apnoeic", 0)]),
    ("al_circulation", "Circulation", [("BP ± 20% of pre-anaesthetic level", 2), ("BP ± 20–49%", 1), ("BP ± 50% or more", 0)]),
    ("al_consciousness", "Consciousness", [("Fully awake", 2), ("Arousable on calling", 1), ("Not responding", 0)]),
    ("al_spo2", "Oxygen saturation", [("> 92% on room air", 2), ("Needs O₂ to keep > 90%", 1), ("< 90% even with O₂", 0)]),
]
PACU = sheet(
    "pacu", "Recovery (PACU) — Modified Aldrete", "Recovery (PACU)", "Post-op", 2, icon="BedSingle",
    description="Post-anaesthesia care unit observations and discharge readiness (Aldrete ≥ 9).",
    sections=[
        section("Arrival", dt("arrived_at", "Arrived in recovery", required=True), num("pulse", "Pulse", "bpm", 0, 300), num("bp_sys", "BP systolic", "mmHg", 0, 300),
                num("bp_dia", "BP diastolic", "mmHg", 0, 200), num("spo2", "SpO₂", "%", 0, 100), num("resp_rate", "Resp. rate", "/min", 0, 80),
                num("temperature", "Temperature", "°F", 85, 110, step=0.1), tone="blue"),
        section("Modified Aldrete", *[choice(k, lbl, opts, ui="segmented", required=True) for k, lbl, opts in ALDRETE], tone="green"),
        section("Comfort & discharge", num("pain", "Pain (0–10)", None, 0, 10), seg("ponv", "PONV", ["None", "Nausea", "Vomiting"]),
                sel("bromage", "Bromage (after spinal / epidural)", ["0 — Full movement", "1 — Can flex knees", "2 — Can move feet only", "3 — Cannot move"]),
                text("drain_output", "Drain / bleeding"), ta("recovery_meds", "Medications in recovery", rows=2),
                dt("discharged_at", "Discharged from recovery", default=None), doctor("discharged_by", "Discharged by (anaesthetist)"), tone="amber"),
    ],
    score=score([k for k, _, _ in ALDRETE], "Aldrete", lo=0, hi=10, lower_is_worse=True),
    bands=[band("Fit for discharge from recovery", "green", lo=9), band("Continue observation", "amber", lo=7, hi=8, action="Re-score every 15 minutes."),
           band("Not fit — inform anaesthetist", "red", hi=6, action="Inform the anaesthetist; continue close monitoring and treat the cause.")])

WARD_HANDOVER = sheet(
    "ward_handover", "OT → Ward Handover", "OT → Ward Handover", "Post-op", 3, icon="ArrowRightLeft",
    description="Recovery-to-ward nursing handover with condition, lines, orders and belongings.",
    sections=[
        section("Handover", dt(), nurse("handed_by", "Handed over by (OT / recovery)", default="me", required=True),
                nurse("received_by", "Received by (ward)", required=True), text("procedure_done", "Procedure done", prefill="booking.procedure"),
                sel("anaesthesia", "Anaesthesia", ANAESTHESIA, prefill="booking.anaesthesia_type"),
                sel("consciousness", "Consciousness", ["Awake & oriented", "Drowsy, arousable", "Sedated"], required=True),
                num("aldrete", "Aldrete at handover", None, 0, 10, prefill="score:ot.pacu"), tone="blue"),
        section("Status", num("pulse", "Pulse", "bpm", 0, 300), num("bp_sys", "BP systolic", "mmHg", 0, 300), num("bp_dia", "BP diastolic", "mmHg", 0, 200),
                num("spo2", "SpO₂", "%", 0, 100), num("pain", "Pain (0–10)", None, 0, 10),
                multi("lines", "Lines, drains & catheters", ["Peripheral IV", "Central line", "Urinary catheter", "Drain", "Ryle's tube", "Epidural catheter", "None"]),
                text("dressing", "Dressing status"), tone="green"),
        section("Documents", yn("orders_handed", "Post-op orders handed over", required=True), yn("file_handed", "Case file, films & reports handed over", required=True),
                yn("belongings", "Belongings handed over", na=True), ta("instructions", "Special instructions", rows=2), tone="amber"),
    ])

POST_ANAESTHESIA = sheet(
    "post_anaesthesia_visit", "Post-anaesthesia Visit", "Post-anaesthesia Visit", "Post-op", 4, icon="Stethoscope", sign_roles=DOC,
    description="Anaesthetist's follow-up visit within 24 hours.",
    sections=[
        section("Visit", dt(), doctor("anaesthetist", "Anaesthetist", default="me", required=True),
                sel("consciousness", "Consciousness", ["Awake & oriented", "Drowsy", "Confused"]), num("pain", "Pain (0–10)", None, 0, 10),
                multi("complaints", "Complaints", ["None", "Nausea / vomiting", "Sore throat", "Post-dural puncture headache", "Backache",
                                                   "Residual motor / sensory block", "Awareness / recall", "Dental injury", "Shivering"]),
                seg("satisfaction", "Patient satisfaction", ["Satisfied", "Neutral", "Dissatisfied"]),
                ta("plan", "Assessment & plan", rows=2), tone="blue"),
    ])

SSI_EL = [
    ("el_bath", "Pre-op bath with antiseptic"), ("el_hair", "Hair removal by clipper (no razor)"),
    ("el_antibiotic", "Antibiotic within 60 min before incision"), ("el_redose", "Antibiotic re-dosed if > 4 h or blood loss > 1500 mL"),
    ("el_prep", "Chlorhexidine-alcohol skin prep"), ("el_normothermia", "Normothermia maintained"),
    ("el_glucose", "Peri-op glucose < 180 mg/dL"), ("el_dressing", "Sterile dressing applied, kept 48 h"),
]
SSI_BUNDLE = sheet(
    "ssi_bundle", "SSI Prevention Bundle", "SSI Bundle", "Post-op", 5, icon="ShieldPlus", also_in=["infection"],
    view_roles=["doctor", "nurse", "quality"], roles=["doctor", "nurse", "quality"],
    description="Surgical site infection prevention bundle — posted to Infection Surveillance bundle audits.",
    mirror=[{"kind": "bundle", "options": {"bundle": "SSI — intra-op"}}],
    sections=[
        section("Case", dt(), {"key": "ward", "label": "Ward", "type": "ward", "required": True, "prefill": "admission.ward_id"},
                sel("wound_class", "Wound class", ["Clean", "Clean-contaminated", "Contaminated", "Dirty"], required=True, prefill="booking.wound_class"),
                text("antibiotic", "Prophylactic antibiotic & time", placeholder="e.g. Cefazolin 2 g IV at 09:10"), tone="blue"),
        section("Bundle elements", *[yn(k, label, na=True, required=True) for k, label in SSI_EL], tone="green"),
        section("Actions", ta("corrective_action", "Corrective action", rows=2), tone="amber"),
    ],
    score=score([k for k, _ in SSI_EL], "Compliance", method="percent_yes", lo=0, hi=100, unit="%"),
    bands=compliance_bands())

FORMS = [PAC, SURGEON_PREOP, SITE_MARKING, PREOP_CHECKLIST, PRE_INDUCTION,
         WHO_SIGN_IN, WHO_TIME_OUT, TECHNIQUE, ANAESTHESIA_RECORD, DRUGS_IO, INTRAOP_NURSING, COUNTS, IMPLANTS, SPECIMENS, WHO_SIGN_OUT, OPERATIVE_NOTE,
         POSTOP_ORDERS, PACU, WARD_HANDOVER, POST_ANAESTHESIA, SSI_BUNDLE]
