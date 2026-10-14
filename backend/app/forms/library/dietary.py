"""Dietary suite: dietitian progress note, maternal nutrition, STRONGkids, SGA, mNUTRIC, re-assessment (MUST) and the daily diet plan."""

from ..dsl import (
    DIET_TYPES,
    FOOD_PREF,
    band,
    calc,
    choice,
    date,
    dt,
    lines,
    multi,
    num,
    rng,
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

DT = ["nurse", "doctor", "support"]
VIEW = ["doctor", "nurse", "support", "quality"]

PROGRESS = {
    "key": "dietary.progress_note", "suite": "dietary", "title": "Dietary Progress Note", "short": "Diet progress", "icon": "NotebookPen",
    "order": 1, "roles": DT, "view_roles": VIEW, "multi_entry": True, "summary": ["diet_type", "intake_percent"],
    "description": "Dietitian follow-up — intake, tolerance, energy and protein achieved against target.",
    "sections": [
        section("Intake", dt(), sel("diet_type", "Current diet", DIET_TYPES, required=True),
                seg("intake_percent", "Meal intake", ["0%", "25%", "50%", "75%", "100%"], required=True),
                multi("tolerance", "Tolerance issues", ["None", "Nausea", "Vomiting", "Diarrhoea", "Constipation", "Abdominal distension",
                                                       "High gastric residual", "Dysphagia", "Poor appetite"]),
                num("weight", "Weight", "kg", 0.5, 400, step=0.1, prefill="weight"), tone="blue"),
        section("Energy & protein", num("kcal_target", "Energy target", "kcal/day", 0, 6000), num("kcal_achieved", "Energy achieved", "kcal/day", 0, 6000),
                calc("kcal_percent", "Energy achieved", "percent", ["kcal_achieved", "kcal_target"], "%", 0),
                num("protein_target", "Protein target", "g/day", 0, 400), num("protein_achieved", "Protein achieved", "g/day", 0, 400),
                calc("protein_percent", "Protein achieved", "percent", ["protein_achieved", "protein_target"], "%", 0), tone="green"),
        section("Assessment & plan", ta("assessment", "Assessment", rows=3, required=True), ta("plan", "Plan / diet modification", rows=3, required=True),
                date("follow_up", "Next review"), tone="violet"),
    ],
}

MATERNAL = {
    "key": "dietary.maternal_nutrition", "suite": "dietary", "title": "Maternal Nutrition Assessment", "short": "Maternal",
    "icon": "Baby", "order": 2, "roles": DT, "view_roles": VIEW, "multi_entry": True, "summary": ["stage", "gwg"],
    "description": "Antenatal / postnatal nutrition — BMI, gestational weight gain, anaemia, GDM and ICMR-NIN based counselling.",
    "sections": [
        section("Status", dt(), seg("stage", "Stage", ["1st trimester", "2nd trimester", "3rd trimester", "Postpartum / lactating"], required=True),
                num("gest_weeks", "Gestational age", "weeks", 4, 44, show_if=when("stage", ne="Postpartum / lactating")),
                num("height", "Height", "cm", 120, 200, prefill="vitals.height"), num("pre_weight", "Pre-pregnancy weight", "kg", 25, 200, step=0.1),
                calc("pre_bmi", "Pre-pregnancy BMI", "bmi", ["pre_weight", "height"], "kg/m²"),
                num("weight", "Current weight", "kg", 25, 250, step=0.1, prefill="weight", required=True),
                calc("gwg", "Gestational weight gain", "diff", ["weight", "pre_weight"], "kg"),
                num("hb", "Haemoglobin", "g/dL", 2, 20, step=0.1, help="< 11 g/dL = anaemia in pregnancy"),
                seg("gdm", "GDM", ["No", "Yes — diet", "Yes — insulin / metformin"]), yn("pih", "Hypertension / pre-eclampsia"), tone="pink"),
        section("Diet", sel("food_pref", "Food preference", FOOD_PREF), seg("meals_per_day", "Meals per day", ["2", "3", "4", "5", "6"]),
                multi("supplements", "Supplements", ["IFA", "Calcium", "Folic acid", "Vitamin D", "Protein supplement", "None"]),
                multi("concerns", "Concerns", ["Nausea / vomiting", "Pica", "Heartburn", "Constipation", "Food aversions", "Food insecurity"]),
                num("kcal_plan", "Energy advised", "kcal/day", 1200, 4000, help="ICMR-NIN: +350 kcal/day in 2nd–3rd trimester; +600 (0–6 mo) lactation"),
                num("protein_plan", "Protein advised", "g/day", 30, 150), ta("counselling", "Counselling given", rows=3, required=True), tone="green"),
    ],
}

STRONGKIDS = {
    "key": "dietary.strongkids", "suite": "dietary", "title": "Paediatric Nutrition Risk (STRONGkids)", "short": "STRONGkids", "icon": "Baby",
    "order": 3, "roles": DT, "view_roles": VIEW, "reassess_hours": 168,
    "description": "Malnutrition risk screening for children 1 month – 18 years on admission and weekly.",
    "sections": [
        section("Screening", dt(),
                choice("subjective", "Subjective clinical assessment: poor nutritional status (reduced fat / muscle, hollow face)?", [("No", 0), ("Yes", 1)],
                       ui="segmented", required=True),
                choice("high_risk_disease", "High-risk disease (e.g. anorexia nervosa, burns, BPD, coeliac, CF, prematurity, cardiac, IBD, cancer, "
                                            "major surgery, CKD, liver disease)?", [("No", 0), ("Yes", 2)], ui="segmented", required=True),
                choice("intake_losses", "Nutritional intake & losses: diarrhoea ≥ 5/day, vomiting > 3/day, reduced intake, or pre-existing dietetic "
                                        "intervention?", [("No", 0), ("Yes", 1)], ui="segmented", required=True),
                choice("weight_loss", "Weight loss or no weight gain (infants < 1 y) in the past few weeks?", [("No", 0), ("Yes", 1)], ui="segmented",
                       required=True),
                num("weight", "Weight", "kg", 0.3, 150, step=0.01, prefill="weight"), ta("remarks", "Remarks", rows=2), tone="violet"),
    ],
    "score": score(["subjective", "high_risk_disease", "intake_losses", "weight_loss"], "STRONGkids", lo=0, hi=5),
    "bands": [
        band("Low risk", "green", lo=0, hi=0, reassess=168, action="No intervention; weigh regularly and repeat screening weekly."),
        band("Medium risk", "amber", lo=1, hi=3, reassess=168, action="Consult doctor; check weight twice a week; consider dietetic advice."),
        band("High risk", "red", lo=4, reassess=72, action="Full dietitian assessment and individual nutrition plan; weigh twice weekly.",
             task="Dietitian assessment and individual nutrition plan", priority="Routine", category="Other"),
    ],
}

SGA = {
    "key": "dietary.sga", "suite": "dietary", "title": "Subjective Global Assessment (SGA)", "short": "SGA", "icon": "Scale", "order": 4,
    "roles": DT, "view_roles": VIEW, "summary": ["weight_change_6m"],
    "description": "Clinician's global nutrition rating from history and physical examination.",
    "sections": [
        section("History", dt(), num("usual_weight", "Usual weight", "kg", 1, 300, step=0.1), num("weight", "Current weight", "kg", 1, 300, step=0.1, prefill="weight"),
                calc("weight_change_6m", "Weight change (6 months)", "weight_change_pct", ["usual_weight", "weight"], "%"),
                sel("change_2w", "Change in past 2 weeks", ["Increase", "No change", "Decrease"]),
                sel("intake_change", "Dietary intake change", ["No change", "Suboptimal solid diet", "Full liquid diet", "Hypocaloric liquids", "Starvation"]),
                multi("gi_symptoms", "GI symptoms > 2 weeks", ["None", "Nausea", "Vomiting", "Diarrhoea", "Anorexia"]),
                sel("functional", "Functional capacity", ["No dysfunction", "Working suboptimally", "Ambulatory", "Bedridden"]),
                sel("metabolic_stress", "Metabolic demand", ["None", "Low", "Moderate", "High"]), tone="blue"),
        section("Physical examination", *[sel(k, lbl, ["Normal", "Mild", "Moderate", "Severe"]) for k, lbl in (
            ("fat_loss", "Subcutaneous fat loss (triceps, chest)"), ("muscle_wasting", "Muscle wasting (temple, deltoid, quadriceps)"),
            ("oedema", "Ankle / sacral oedema"), ("ascites", "Ascites"))], tone="green"),
        section("Rating", choice("sga_rating", "SGA rating", [("A — Well nourished", 1), ("B — Moderately / suspected malnourished", 2),
                                                             ("C — Severely malnourished", 3)], required=True),
                ta("plan", "Nutrition plan", rows=3), tone="violet"),
    ],
    "score": score(["sga_rating"], "SGA", method="value", lo=1, hi=3),
    "bands": [
        band("Well nourished (A)", "green", hi=1, reassess=168),
        band("Moderate malnutrition (B)", "amber", lo=2, hi=2, reassess=72, action="Dietary counselling, oral supplements, weekly weight."),
        band("Severe malnutrition (C)", "red", lo=3, reassess=48, action="Dietitian-led plan; consider enteral feeding; monitor refeeding risk.",
             task="Dietitian-led plan, consider enteral feeding, monitor for refeeding", priority="Urgent", category="Other"),
    ],
}

NUTRIC = {
    "key": "dietary.nutric", "suite": "dietary", "title": "NUTRIC Score (modified)", "short": "mNUTRIC", "icon": "Gauge", "order": 5,
    "roles": DT, "view_roles": VIEW,
    "description": "Nutrition risk in the critically ill (mNUTRIC — without IL-6). Score ≥ 5 benefits most from aggressive feeding.",
    "sections": [
        section("Variables", dt(),
                num("age", "Age", "years", 18, 120, required=True, prefill="patient.age", score_ranges=[rng(0, lt=50), rng(1, lo=50, lt=75), rng(2, lo=75)]),
                num("apache2", "APACHE II", None, 0, 71, required=True, score_ranges=[rng(0, lt=15), rng(1, lo=15, lt=20), rng(2, lo=20, lt=28), rng(3, lo=28)]),
                num("sofa", "SOFA", None, 0, 24, required=True, score_ranges=[rng(0, lt=6), rng(1, lo=6, lt=10), rng(2, lo=10)]),
                num("comorbidities", "Number of co-morbidities", None, 0, 20, required=True, score_ranges=[rng(0, lt=2), rng(1, lo=2)]),
                num("days_to_icu", "Days from hospital to ICU admission", "days", 0, 365, required=True, score_ranges=[rng(0, lt=1), rng(1, lo=1)]),
                num("il6", "IL-6 (optional, not scored in mNUTRIC)", "pg/mL", 0, 10000), tone="blue"),
        section("Plan", ta("plan", "Nutrition plan", rows=3), tone="green"),
    ],
    "score": score(["age", "apache2", "sofa", "comorbidities", "days_to_icu"], "mNUTRIC", lo=0, hi=9),
    "bands": [
        band("Low nutrition risk", "green", lo=0, hi=4, reassess=72, action="Standard ICU nutrition; low malnutrition risk."),
        band("High nutrition risk", "red", lo=5, reassess=48,
             action="Start early enteral nutrition and aim for > 80% of energy and protein targets within 48–72 h.",
             task="Early enteral nutrition, target > 80% energy & protein in 48–72 h (dietitian)", priority="Urgent", category="Other"),
    ],
}

MUST = {
    "key": "dietary.reassessment", "suite": "dietary", "title": "Nutritional Re-assessment (MUST)", "short": "Re-assessment", "icon": "RefreshCw",
    "order": 6, "roles": DT, "view_roles": VIEW, "multi_entry": True, "reassess_hours": 168,
    "description": "Weekly re-screening with the Malnutrition Universal Screening Tool.",
    "sections": [
        section("Step 1 — BMI", dt(), num("height", "Height", "cm", 50, 250, prefill="vitals.height", required=True),
                num("weight", "Weight", "kg", 2, 300, step=0.1, prefill="weight", required=True),
                calc("bmi", "BMI", "bmi", ["weight", "height"], "kg/m²", 1,
                     score_ranges=[rng(0, lo=20.01), rng(1, lo=18.5, lt=20.01), rng(2, lt=18.5)], help="> 20 = 0 · 18.5–20 = 1 · < 18.5 = 2"),
                tone="blue"),
        section("Step 2 — Weight loss", num("weight_3_6m", "Weight 3–6 months ago", "kg", 2, 300, step=0.1),
                calc("loss_pct", "Unplanned weight loss", "weight_change_pct", ["weight_3_6m", "weight"], "%", 1),
                choice("loss_score", "Weight loss in 3–6 months", [("< 5%", 0), ("5–10%", 1), ("> 10%", 2)], ui="segmented", required=True),
                tone="pink"),
        section("Step 3 — Acute disease effect",
                choice("acute_disease", "Acutely ill and no nutritional intake for > 5 days (or likely)?", [("No", 0), ("Yes", 2)], ui="segmented", required=True),
                ta("plan", "Plan", rows=2), tone="green"),
    ],
    "score": score(["bmi", "loss_score", "acute_disease"], "MUST", lo=0, hi=6),
    "bands": [
        band("Low risk", "green", lo=0, hi=0, reassess=168, action="Routine care; repeat screening weekly."),
        band("Medium risk", "amber", lo=1, hi=1, reassess=72, action="Observe: document intake for 3 days; review."),
        band("High risk", "red", lo=2, reassess=72, action="Treat: refer to dietitian, improve intake, monitor and review care plan.",
             task="Dietitian referral and nutrition care plan", priority="Routine", category="Other"),
    ],
}

DAILY_DIET = {
    "key": "dietary.daily_diet", "suite": "dietary", "title": "Daily Diet Plan", "short": "Daily diet", "icon": "Utensils", "order": 7,
    "roles": DT, "view_roles": VIEW, "multi_entry": True, "summary": ["diet_type", "kcal_total"],
    "description": "Meal-by-meal plan for the kitchen with energy and protein totals.",
    "sections": [
        section("Diet", date("plan_date", "Date", default="today", required=True), sel("diet_type", "Diet", DIET_TYPES, required=True),
                sel("food_pref", "Food preference", FOOD_PREF), num("kcal_target", "Energy target", "kcal", 0, 6000),
                num("protein_target", "Protein target", "g", 0, 400), num("fluid_limit", "Fluid restriction", "mL/day", 0, 5000),
                text("allergies", "Allergies / intolerances", prefill="patient.allergies"), tone="blue"),
        section("Meals", lines("meals", "Meals", [
            sel("slot", "Meal", ["Early morning", "Breakfast", "Mid-morning", "Lunch", "Evening", "Dinner", "Bedtime", "Feed"], required=True),
            time("at", "Time"), text("item", "Item", required=True), text("quantity", "Quantity"), num("kcal", "kcal"), num("protein", "Protein g")]),
            calc("kcal_total", "Total energy", "lines_sum", ["meals", "kcal"], "kcal", 0),
            calc("protein_total", "Total protein", "lines_sum", ["meals", "protein"], "g", 0), tone="green"),
        section("Instructions", ta("instructions", "Special instructions for the kitchen", rows=2), tone="violet"),
    ],
}

FORMS = [PROGRESS, MATERNAL, STRONGKIDS, SGA, NUTRIC, MUST, DAILY_DIET]
