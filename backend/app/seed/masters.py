"""Reference data for a 1,000-bed multispecialty hospital (Indian context)."""

DEPARTMENTS = [
    # code, name, type
    ("GMED", "General Medicine", "Clinical"), ("GSUR", "General Surgery", "Surgical"), ("CARD", "Cardiology", "Clinical"),
    ("ORTH", "Orthopaedics", "Surgical"), ("OBGY", "Obstetrics & Gynaecology", "Surgical"), ("PAED", "Paediatrics", "Clinical"),
    ("NEUR", "Neurology", "Clinical"), ("NEPH", "Nephrology", "Clinical"), ("ONCO", "Oncology", "Clinical"),
    ("ENT", "ENT", "Surgical"), ("OPHT", "Ophthalmology", "Surgical"), ("DERM", "Dermatology", "Clinical"),
    ("PSYC", "Psychiatry", "Clinical"), ("PULM", "Pulmonology", "Clinical"), ("GAST", "Gastroenterology", "Clinical"),
    ("UROL", "Urology", "Surgical"), ("EMED", "Emergency Medicine", "Clinical"), ("ANES", "Anaesthesiology", "Clinical"),
    ("RADI", "Radiology", "Diagnostic"), ("PATH", "Pathology & Lab Medicine", "Diagnostic"), ("PHYS", "Physiotherapy & Rehab", "Clinical"),
    ("DENT", "Dental", "Clinical"), ("CRIT", "Critical Care", "Clinical"),
    ("ADMN", "Administration", "Administrative"), ("NURS", "Nursing", "Support"), ("PHAR", "Pharmacy", "Support"),
    ("HR", "Human Resources", "Administrative"), ("FIN", "Finance & Billing", "Administrative"), ("FAC", "Facilities & Support Services", "Support"),
]

OPD_DEPTS = ["GMED", "GSUR", "CARD", "ORTH", "OBGY", "PAED", "NEUR", "NEPH", "ONCO", "ENT", "OPHT", "DERM", "PSYC",
             "PULM", "GAST", "UROL", "DENT", "PHYS"]

# ward code, name, ward type, floor, block, department, beds, bed category, daily rate
WARDS = [
    ("M1", "Medical Ward M1 (Male)", "General", "2", "A", "GMED", 50, "General", 1500),
    ("M2", "Medical Ward M2 (Female)", "General", "2", "A", "GMED", 50, "General", 1500),
    ("M3", "Medical Ward M3", "General", "3", "A", "GMED", 50, "General", 1500),
    ("M4", "Medical Ward M4", "General", "3", "A", "PULM", 50, "General", 1500),
    ("S1", "Surgical Ward S1 (Male)", "General", "2", "B", "GSUR", 50, "General", 1800),
    ("S2", "Surgical Ward S2 (Female)", "General", "2", "B", "GSUR", 50, "General", 1800),
    ("S3", "Surgical Ward S3", "General", "3", "B", "UROL", 50, "General", 1800),
    ("S4", "Surgical Ward S4", "General", "3", "B", "GAST", 50, "General", 1800),
    ("O1", "Orthopaedic Ward O1", "General", "4", "B", "ORTH", 40, "General", 1800),
    ("O2", "Orthopaedic Ward O2", "General", "4", "B", "ORTH", 40, "General", 1800),
    ("W1", "Maternity Ward W1", "Maternity", "5", "C", "OBGY", 40, "General", 2000),
    ("W2", "Gynaecology Ward W2", "General", "5", "C", "OBGY", 40, "General", 2000),
    ("P1", "Paediatric Ward P1", "General", "5", "C", "PAED", 40, "General", 1800),
    ("PR1", "Private Wing PR1", "Private", "6", "D", "GMED", 30, "Private", 5000),
    ("PR2", "Private Wing PR2", "Private", "6", "D", "GSUR", 30, "Private", 5000),
    ("PR3", "Private Wing PR3", "Private", "7", "D", "CARD", 30, "Private", 5000),
    ("SP1", "Semi-Private SP1", "Semi-Private", "7", "D", "GMED", 30, "Semi-Private", 3000),
    ("SP2", "Semi-Private SP2", "Semi-Private", "7", "D", "ORTH", 30, "Semi-Private", 3000),
    ("DX1", "Deluxe Suites DX1", "Private", "8", "D", "GMED", 20, "Deluxe", 9000),
    ("MICU", "Medical ICU", "ICU", "1", "E", "CRIT", 24, "ICU", 12000),
    ("SICU", "Surgical ICU", "ICU", "1", "E", "CRIT", 20, "ICU", 12000),
    ("CCU", "Coronary Care Unit", "ICU", "1", "E", "CARD", 16, "ICU", 14000),
    ("NICU", "Neonatal ICU", "NICU", "5", "C", "PAED", 20, "NICU", 9000),
    ("PICU", "Paediatric ICU", "PICU", "5", "C", "PAED", 12, "PICU", 10000),
    ("HDU", "High Dependency Unit", "HDU", "1", "E", "CRIT", 20, "HDU", 7000),
    ("ISO", "Isolation Ward", "Isolation", "G", "F", "GMED", 14, "Isolation", 4000),
    ("DC1", "Day Care Unit", "Day Care", "G", "A", "GSUR", 30, "Day Care", 2000),
    ("ODC", "Oncology Day Care", "Day Care", "G", "C", "ONCO", 20, "Day Care", 2500),
    ("ER", "Emergency Department", "Emergency", "G", "A", "EMED", 30, "ER", 2500),
    ("BRN", "Burns Unit", "HDU", "4", "F", "GSUR", 10, "HDU", 6000),
    ("STR", "Stroke Unit", "HDU", "4", "E", "NEUR", 14, "HDU", 7000),
]

FIRST_M = ["Aarav", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna", "Ishaan", "Rohan", "Karthik", "Venkat", "Suresh", "Ramesh",
           "Mahesh", "Anil", "Ravi", "Srinivas", "Prakash", "Rajesh", "Naveen", "Kiran", "Harsha", "Vamsi", "Teja", "Manoj",
           "Abdul", "Imran", "Joseph", "Thomas", "Gurpreet", "Amit", "Rahul", "Vikram", "Siddharth", "Nikhil", "Pranav"]
FIRST_F = ["Ananya", "Diya", "Saanvi", "Aadhya", "Lakshmi", "Priya", "Sravani", "Divya", "Keerthi", "Swathi", "Padma",
           "Sunitha", "Kavya", "Meena", "Radha", "Anjali", "Pooja", "Sneha", "Bhavana", "Harika", "Farida", "Mary",
           "Jaspreet", "Neha", "Shreya", "Deepika", "Revathi", "Madhuri", "Gayathri", "Nandini"]
LAST = ["Reddy", "Rao", "Naidu", "Sharma", "Varma", "Chowdary", "Kumar", "Iyer", "Nair", "Menon", "Patel", "Gupta",
        "Singh", "Khan", "Das", "Mukherjee", "Joshi", "Kulkarni", "Pillai", "Shetty", "Moparthi", "Bhat", "Agarwal",
        "Yadav", "Mishra", "Jain", "Fernandes", "Sheikh", "Goud", "Murthy"]
CITIES = [("Guntur", "Andhra Pradesh", "522002"), ("Vijayawada", "Andhra Pradesh", "520010"), ("Hyderabad", "Telangana", "500034"),
          ("Tenali", "Andhra Pradesh", "522201"), ("Ongole", "Andhra Pradesh", "523001"), ("Nellore", "Andhra Pradesh", "524001"),
          ("Eluru", "Andhra Pradesh", "534001"), ("Narasaraopet", "Andhra Pradesh", "522601")]

# code, name, category, dept, rate, tax%, tat
TARIFF = [
    ("CONS-OPD", "OPD consultation", "CONSULT", "GMED", 600, 0, None),
    ("CONS-FOLLOWUP", "Follow-up consultation", "CONSULT", "GMED", 300, 0, None),
    ("CONS-TELE", "Teleconsultation", "CONSULT", "GMED", 500, 0, None),
    ("CONS-IPD-VISIT", "Consultant visit (IPD)", "CONSULT", "GMED", 1000, 0, None),
    ("ER-CONSULT", "Emergency consultation", "CONSULT", "EMED", 1000, 0, None),
    ("ER-OBS", "ER observation (per 6 h)", "PROC", "EMED", 1500, 0, None),
    ("ROOM-GENERAL", "Room rent — general ward", "ROOM", "NURS", 1500, 0, None),
    ("NURSING-DAILY", "Nursing charges (per day)", "NURSING", "NURS", 600, 0, None),
    ("ICU-DAILY", "ICU monitoring & nursing (per day)", "ICU", "CRIT", 5000, 0, None),
    ("VENT-DAILY", "Ventilator charges (per day)", "ICU", "CRIT", 4500, 0, None),
    ("NICU-DAILY", "NICU care (per day)", "ICU", "PAED", 4000, 0, None),
    ("DIAL-HD", "Haemodialysis session", "DIALYSIS", "NEPH", 2500, 0, None),
    ("DIAL-PD", "Peritoneal dialysis (per day)", "DIALYSIS", "NEPH", 1800, 0, None),
    ("PHYSIO-SESSION", "Physiotherapy session", "PHYSIO", "PHYS", 500, 0, None),
    ("OT-MINOR", "Operation theatre — minor", "OT", "GSUR", 8000, 0, None),
    ("OT-MAJOR", "Operation theatre — major", "OT", "GSUR", 25000, 0, None),
    ("ANAES-GA", "Anaesthesia — general", "OT", "ANES", 9000, 0, None),
    ("ANAES-RA", "Anaesthesia — regional", "OT", "ANES", 6000, 0, None),
    ("CHEMO-ADMIN", "Chemotherapy administration (day care)", "PROC", "ONCO", 3500, 0, None),
    ("RT-FRACTION", "Radiotherapy fraction", "PROC", "ONCO", 4000, 0, None),
    ("DENTAL-CONSULT", "Dental consultation", "DENTAL", "DENT", 400, 0, None),
    ("DENTAL-SCALING", "Scaling & polishing", "DENTAL", "DENT", 1200, 0, None),
    ("IVF-CYCLE", "IVF cycle (package)", "PACKAGE", "OBGY", 150000, 0, None),
    ("PSY-SESSION", "Psychotherapy session", "PROC", "PSYC", 1200, 0, None),
    ("PALL-VISIT", "Palliative care visit", "PROC", "ONCO", 800, 0, None),
    ("HOME-VISIT", "Home care nursing visit", "NURSING", "NURS", 900, 18, None),
    ("AMB-TRIP", "Ambulance trip (within city)", "AMBULANCE", "FAC", 1500, 0, None),
    ("BLOOD-COMPONENT", "Blood component issue (per unit)", "BLOOD", "PATH", 1550, 0, None),
    ("HC-BASIC", "Basic health check", "PACKAGE", "GMED", 2500, 0, None),
    ("HC-EXEC", "Executive health check", "PACKAGE", "GMED", 7500, 0, None),
    ("MORTUARY-DAY", "Mortuary storage (per day)", "MISC", "FAC", 1000, 0, None),
    ("VACCINE-ADMIN", "Vaccine administration", "PROC", "PAED", 200, 0, None),
    ("DIET-CONSULT", "Dietitian consultation", "DIET", "GMED", 500, 0, None),
    ("PROC-MINOR", "Minor procedure", "PROC", "GSUR", 2000, 0, None),
    ("LABOUR-NORMAL", "Normal delivery package", "PACKAGE", "OBGY", 25000, 0, None),
    ("LABOUR-LSCS", "Caesarean section package", "PACKAGE", "OBGY", 55000, 0, None),
    ("TRANSPLANT-WORKUP", "Transplant work-up panel", "PACKAGE", "NEPH", 45000, 0, None),
    ("HISTO-SMALL", "Histopathology — small specimen", "LAB", "PATH", 1200, 0, 4320),
    ("HISTO-LARGE", "Histopathology — large specimen", "LAB", "PATH", 2500, 0, 7200),
    ("CYTO-FNAC", "FNAC / cytology", "LAB", "PATH", 900, 0, 2880),
    ("PROC-DRESSING", "Wound dressing", "PROC", "NURS", 300, 0, None),
    ("PROC-ECG", "ECG", "PROC", "CARD", 300, 0, 30),
    ("PROC-ECHO", "2D Echocardiography", "PROC", "CARD", 2200, 0, 120),
    ("PROC-TMT", "Treadmill test", "PROC", "CARD", 2000, 0, 120),
    ("PROC-ENDO", "Upper GI endoscopy", "PROC", "GAST", 3500, 0, 180),
]

# code, name, sample, rate, tat(min), parameters [(name, unit, lo, hi, crit_lo, crit_hi)]
LAB_TESTS = [
    ("LAB-CBC", "Complete Blood Count", "Whole Blood (EDTA)", 350, 120, [
        ("Haemoglobin", "g/dL", 12, 16, 7, 20), ("Total WBC", "10^3/µL", 4, 11, 2, 30), ("Platelets", "10^3/µL", 150, 450, 20, 1000),
        ("PCV", "%", 36, 48, None, None), ("Neutrophils", "%", 40, 75, None, None), ("Lymphocytes", "%", 20, 45, None, None)]),
    ("LAB-RBS", "Random Blood Sugar", "Plasma", 80, 60, [("Glucose (random)", "mg/dL", 70, 140, 40, 450)]),
    ("LAB-FBS", "Fasting Blood Sugar", "Plasma", 80, 60, [("Glucose (fasting)", "mg/dL", 70, 100, 40, 400)]),
    ("LAB-HBA1C", "HbA1c", "Whole Blood (EDTA)", 550, 240, [("HbA1c", "%", 4, 5.6, None, None)]),
    ("LAB-LFT", "Liver Function Test", "Serum", 650, 180, [
        ("Total bilirubin", "mg/dL", 0.2, 1.2, None, 15), ("SGOT (AST)", "U/L", 5, 40, None, 1000), ("SGPT (ALT)", "U/L", 7, 56, None, 1000),
        ("Alkaline phosphatase", "U/L", 44, 147, None, None), ("Albumin", "g/dL", 3.5, 5, 1.5, None)]),
    ("LAB-RFT", "Renal Function Test", "Serum", 600, 180, [
        ("Urea", "mg/dL", 15, 40, None, 200), ("Creatinine", "mg/dL", 0.6, 1.2, None, 7), ("Sodium", "mmol/L", 135, 145, 120, 160),
        ("Potassium", "mmol/L", 3.5, 5.1, 2.5, 6.5), ("Chloride", "mmol/L", 98, 107, None, None)]),
    ("LAB-LIPID", "Lipid Profile", "Serum", 600, 240, [
        ("Total cholesterol", "mg/dL", 0, 200, None, None), ("Triglycerides", "mg/dL", 0, 150, None, 1000), ("HDL", "mg/dL", 40, 60, None, None),
        ("LDL", "mg/dL", 0, 100, None, None)]),
    ("LAB-TFT", "Thyroid Profile (T3, T4, TSH)", "Serum", 700, 360, [
        ("T3", "ng/dL", 80, 200, None, None), ("T4", "µg/dL", 5, 12, None, None), ("TSH", "µIU/mL", 0.4, 4.5, None, 50)]),
    ("LAB-ELEC", "Serum Electrolytes", "Serum", 450, 90, [
        ("Sodium", "mmol/L", 135, 145, 120, 160), ("Potassium", "mmol/L", 3.5, 5.1, 2.5, 6.5), ("Chloride", "mmol/L", 98, 107, None, None)]),
    ("LAB-TROP", "Troponin I (hs)", "Serum", 1200, 60, [("Troponin I", "ng/L", 0, 26, None, 100)]),
    ("LAB-CRP", "C-Reactive Protein", "Serum", 450, 120, [("CRP", "mg/L", 0, 5, None, None)]),
    ("LAB-PT", "PT / INR", "Plasma", 400, 90, [("PT", "sec", 11, 13.5, None, None), ("INR", "", 0.8, 1.2, None, 5)]),
    ("LAB-URINE", "Urine Routine & Microscopy", "Urine", 200, 90, [
        ("Protein", "", None, None, None, None), ("Sugar", "", None, None, None, None), ("Pus cells", "/hpf", 0, 5, None, None)]),
    ("LAB-DENGUE", "Dengue NS1 + IgM/IgG", "Serum", 1200, 240, [("NS1 antigen", "", None, None, None, None), ("IgM", "", None, None, None, None)]),
    ("LAB-MP", "Malaria Parasite (smear + RDT)", "Whole Blood (EDTA)", 300, 120, [("Malaria parasite", "", None, None, None, None)]),
    ("LAB-ABG", "Arterial Blood Gas", "Whole Blood (EDTA)", 900, 30, [
        ("pH", "", 7.35, 7.45, 7.2, 7.6), ("pCO2", "mmHg", 35, 45, 20, 70), ("pO2", "mmHg", 80, 100, 50, None), ("Lactate", "mmol/L", 0.5, 2, None, 4)]),
    ("LAB-CULT-B", "Blood Culture & Sensitivity", "Whole Blood (EDTA)", 1100, 4320, [("Organism", "", None, None, None, None)]),
    ("LAB-CULT-U", "Urine Culture & Sensitivity", "Urine", 800, 4320, [("Organism", "", None, None, None, None)]),
    ("LAB-VITD", "Vitamin D (25-OH)", "Serum", 1400, 720, [("25-OH Vitamin D", "ng/mL", 30, 100, None, None)]),
    ("LAB-B12", "Vitamin B12", "Serum", 900, 720, [("Vitamin B12", "pg/mL", 200, 900, None, None)]),
    ("LAB-HIV", "HIV 1 & 2 (screening)", "Serum", 500, 240, [("HIV 1 & 2 antibodies", "", None, None, None, None)]),
    ("LAB-HBSAG", "HBsAg", "Serum", 400, 240, [("HBsAg", "", None, None, None, None)]),
    ("LAB-ESR", "ESR", "Whole Blood (EDTA)", 120, 90, [("ESR", "mm/hr", 0, 20, None, None)]),
    ("LAB-BGRP", "Blood Group & Rh", "Whole Blood (EDTA)", 150, 60, [("ABO group", "", None, None, None, None), ("Rh", "", None, None, None, None)]),
    ("LAB-DDIMER", "D-Dimer", "Plasma", 1300, 120, [("D-Dimer", "µg/mL FEU", 0, 0.5, None, None)]),
    ("LAB-PROCAL", "Procalcitonin", "Serum", 2200, 180, [("Procalcitonin", "ng/mL", 0, 0.5, None, 10)]),
]

# code, name, modality, body part, rate, tat
RAD_STUDIES = [
    ("RAD-XR-CHEST", "X-Ray Chest PA", "X-Ray", "Chest", 400, 120),
    ("RAD-XR-KNEE", "X-Ray Knee AP/Lat", "X-Ray", "Knee", 500, 120),
    ("RAD-XR-LS", "X-Ray Lumbosacral Spine", "X-Ray", "Spine", 600, 120),
    ("RAD-XR-ABD", "X-Ray Abdomen Erect", "X-Ray", "Abdomen", 450, 120),
    ("RAD-USG-ABD", "USG Whole Abdomen", "Ultrasound", "Abdomen", 1200, 180),
    ("RAD-USG-OBS", "USG Obstetric (Growth scan)", "Ultrasound", "Pelvis", 1500, 180),
    ("RAD-USG-PEL", "USG Pelvis", "Ultrasound", "Pelvis", 1000, 180),
    ("RAD-DOP-LL", "Doppler Lower Limb (Venous)", "Ultrasound", "Lower limb", 2500, 240),
    ("RAD-CT-BRAIN", "CT Brain (Plain)", "CT", "Brain", 2500, 120),
    ("RAD-CT-CHEST", "HRCT Chest", "CT", "Chest", 4000, 240),
    ("RAD-CT-ABD", "CECT Abdomen & Pelvis", "CT", "Abdomen", 7500, 360),
    ("RAD-CT-KUB", "CT KUB (Plain)", "CT", "Abdomen", 4500, 240),
    ("RAD-CTA-COR", "CT Coronary Angiography", "CT", "Heart", 12000, 720),
    ("RAD-MRI-BRAIN", "MRI Brain (Plain)", "MRI", "Brain", 7000, 720),
    ("RAD-MRI-LS", "MRI Lumbosacral Spine", "MRI", "Spine", 7500, 720),
    ("RAD-MRI-KNEE", "MRI Knee", "MRI", "Knee", 7500, 720),
    ("RAD-MAMMO", "Mammography (Bilateral)", "Mammography", "Breast", 2500, 720),
    ("RAD-DEXA", "DEXA Scan", "DEXA", "Whole body", 3000, 720),
]

# name, generic, form, strength, uom, class, interacts_with, mrp, schedule, high_alert
DRUGS = [
    ("Paracetamol 650", "Paracetamol", "Tablet", "650 mg", "Tab", "Analgesic", [], 2.2, "None", False),
    ("Pantoprazole 40", "Pantoprazole", "Tablet", "40 mg", "Tab", "PPI", ["Clopidogrel"], 9.5, "H", False),
    ("Pantoprazole 40 Inj", "Pantoprazole", "Injection", "40 mg", "Vial", "PPI", ["Clopidogrel"], 55, "H", False),
    ("Amoxicillin-Clavulanate 625", "Amoxicillin + Clavulanic acid", "Tablet", "625 mg", "Tab", "Beta-lactam", ["Methotrexate"], 18, "H", False),
    ("Ceftriaxone 1g Inj", "Ceftriaxone", "Injection", "1 g", "Vial", "Beta-lactam", ["Calcium gluconate"], 65, "H", False),
    ("Azithromycin 500", "Azithromycin", "Tablet", "500 mg", "Tab", "Macrolide", ["Amiodarone", "Ondansetron"], 22, "H", False),
    ("Metformin 500", "Metformin", "Tablet", "500 mg", "Tab", "Biguanide", ["Iodinated contrast"], 3.5, "H", False),
    ("Glimepiride 2", "Glimepiride", "Tablet", "2 mg", "Tab", "Sulfonylurea", [], 6.8, "H", False),
    ("Insulin Regular 40IU/ml", "Human insulin", "Injection", "40 IU/ml", "Vial", "Insulin", [], 180, "H", True),
    ("Amlodipine 5", "Amlodipine", "Tablet", "5 mg", "Tab", "Calcium channel blocker", [], 4.2, "H", False),
    ("Telmisartan 40", "Telmisartan", "Tablet", "40 mg", "Tab", "ARB", ["Potassium chloride", "Spironolactone"], 8.5, "H", False),
    ("Atorvastatin 20", "Atorvastatin", "Tablet", "20 mg", "Tab", "Statin", ["Clarithromycin"], 12, "H", False),
    ("Aspirin 75", "Aspirin", "Tablet", "75 mg", "Tab", "Antiplatelet / NSAID", ["Warfarin", "Heparin", "Ibuprofen"], 1.5, "None", False),
    ("Clopidogrel 75", "Clopidogrel", "Tablet", "75 mg", "Tab", "Antiplatelet", ["Pantoprazole", "Warfarin"], 9.8, "H", False),
    ("Warfarin 5", "Warfarin", "Tablet", "5 mg", "Tab", "Anticoagulant", ["Aspirin", "Clopidogrel", "Ibuprofen", "Azithromycin"], 6, "H", True),
    ("Heparin 5000IU Inj", "Heparin", "Injection", "5000 IU/ml", "Vial", "Anticoagulant", ["Aspirin", "Ibuprofen"], 95, "H", True),
    ("Enoxaparin 40 Inj", "Enoxaparin", "Injection", "40 mg", "Vial", "Anticoagulant", ["Aspirin", "Ibuprofen"], 380, "H", True),
    ("Ibuprofen 400", "Ibuprofen", "Tablet", "400 mg", "Tab", "NSAID", ["Warfarin", "Aspirin", "Telmisartan"], 2.8, "None", False),
    ("Diclofenac 75 Inj", "Diclofenac", "Injection", "75 mg", "Ampoule", "NSAID", ["Warfarin"], 15, "H", False),
    ("Tramadol 50", "Tramadol", "Capsule", "50 mg", "Cap", "Opioid analgesic", ["Ondansetron"], 8, "H1", False),
    ("Morphine 10mg Inj", "Morphine", "Injection", "10 mg/ml", "Ampoule", "Opioid", ["Midazolam"], 40, "Narcotic", True),
    ("Ondansetron 4 Inj", "Ondansetron", "Injection", "4 mg", "Ampoule", "Antiemetic", ["Tramadol", "Azithromycin"], 14, "H", False),
    ("Ondansetron 4", "Ondansetron", "Tablet", "4 mg", "Tab", "Antiemetic", ["Tramadol"], 6, "H", False),
    ("Metronidazole 500 IV", "Metronidazole", "Infusion", "500 mg/100 ml", "Bottle", "Nitroimidazole", ["Warfarin"], 30, "H", False),
    ("Piperacillin-Tazobactam 4.5g", "Piperacillin + Tazobactam", "Injection", "4.5 g", "Vial", "Beta-lactam", [], 420, "H", False),
    ("Meropenem 1g Inj", "Meropenem", "Injection", "1 g", "Vial", "Carbapenem", ["Valproate"], 1450, "H1", False),
    ("Vancomycin 500 Inj", "Vancomycin", "Injection", "500 mg", "Vial", "Glycopeptide", [], 380, "H1", False),
    ("Normal Saline 500ml", "Sodium chloride 0.9%", "Infusion", "500 ml", "Bottle", "IV fluid", [], 35, "None", False),
    ("Ringer Lactate 500ml", "Compound sodium lactate", "Infusion", "500 ml", "Bottle", "IV fluid", ["Ceftriaxone"], 40, "None", False),
    ("DNS 500ml", "Dextrose 5% + NaCl 0.9%", "Infusion", "500 ml", "Bottle", "IV fluid", [], 38, "None", False),
    ("Potassium Chloride Inj", "Potassium chloride", "Injection", "15% 10 ml", "Ampoule", "Electrolyte", ["Telmisartan", "Spironolactone"], 20, "H", True),
    ("Furosemide 40", "Furosemide", "Tablet", "40 mg", "Tab", "Loop diuretic", ["Gentamicin"], 2.5, "H", False),
    ("Furosemide 20 Inj", "Furosemide", "Injection", "20 mg", "Ampoule", "Loop diuretic", ["Gentamicin"], 9, "H", False),
    ("Spironolactone 25", "Spironolactone", "Tablet", "25 mg", "Tab", "Potassium-sparing diuretic", ["Telmisartan", "Potassium chloride"], 4, "H", False),
    ("Salbutamol Nebules", "Salbutamol", "Inhaler", "2.5 mg", "Nos", "Bronchodilator", [], 7, "H", False),
    ("Budesonide Respules", "Budesonide", "Inhaler", "0.5 mg", "Nos", "Corticosteroid", [], 28, "H", False),
    ("Hydrocortisone 100 Inj", "Hydrocortisone", "Injection", "100 mg", "Vial", "Corticosteroid", [], 45, "H", False),
    ("Dexamethasone 8 Inj", "Dexamethasone", "Injection", "8 mg", "Ampoule", "Corticosteroid", [], 12, "H", False),
    ("Levetiracetam 500", "Levetiracetam", "Tablet", "500 mg", "Tab", "Antiepileptic", [], 14, "H", False),
    ("Phenytoin 100", "Phenytoin", "Tablet", "100 mg", "Tab", "Antiepileptic", ["Warfarin"], 2, "H", False),
    ("Midazolam 5 Inj", "Midazolam", "Injection", "5 mg/ml", "Ampoule", "Benzodiazepine", ["Morphine"], 22, "H1", True),
    ("Amiodarone 200", "Amiodarone", "Tablet", "200 mg", "Tab", "Antiarrhythmic", ["Azithromycin", "Warfarin"], 9, "H", True),
    ("Gentamicin 80 Inj", "Gentamicin", "Injection", "80 mg", "Ampoule", "Aminoglycoside", ["Furosemide"], 8, "H", False),
    ("Calcium Gluconate Inj", "Calcium gluconate", "Injection", "10% 10 ml", "Ampoule", "Electrolyte", ["Ceftriaxone"], 25, "H", False),
    ("Cetirizine 10", "Cetirizine", "Tablet", "10 mg", "Tab", "Antihistamine", [], 1.8, "None", False),
    ("ORS Sachet", "Oral rehydration salts", "Powder", "21 g", "Nos", "Electrolyte", [], 22, "None", False),
    ("Iron-Folic Acid", "Ferrous sulphate + Folic acid", "Tablet", "100 mg + 0.5 mg", "Tab", "Haematinic", [], 1.2, "None", False),
    ("Oxytocin 5IU Inj", "Oxytocin", "Injection", "5 IU/ml", "Ampoule", "Uterotonic", [], 18, "H", True),
    ("Methotrexate 2.5", "Methotrexate", "Tablet", "2.5 mg", "Tab", "Antimetabolite", ["Amoxicillin + Clavulanic acid", "Ibuprofen"], 4, "H", True),
    ("Sertraline 50", "Sertraline", "Tablet", "50 mg", "Tab", "SSRI", ["Tramadol"], 7, "H", False),
]

CONSUMABLES = [
    ("IV Cannula 20G", "Consumable", "Nos", 35), ("Syringe 5 ml", "Consumable", "Nos", 6), ("Surgical Gloves 7.0", "Consumable", "Pair", 28),
    ("Foley Catheter 16Fr", "Consumable", "Nos", 85), ("Gauze Roll", "Consumable", "Roll", 60), ("Suture Vicryl 2-0", "Consumable", "Nos", 320),
    ("Knee Implant (Total)", "Implant", "Set", 95000), ("Coronary Stent (DES)", "Implant", "Nos", 31000), ("Bed Sheet", "Linen", "Nos", 250),
    ("Vacutainer EDTA", "Reagent", "Nos", 9), ("Glucose Reagent Kit", "Reagent", "Box", 2400),
]

STORES = ["Main Store", "OP Pharmacy", "IP Pharmacy", "OT Store", "ICU Store", "Lab Store"]

# username, display name, role, employee category (None → no employee record)
USERS = [
    ("admin", "System Administrator", "admin", None),
    ("ceo", "Dr. Ramakrishna Varma (CEO)", "management", "Management"),
    ("cfo", "Sunitha Agarwal (CFO)", "management", "Management"),
    ("dr.rao", "Dr. Venkat Rao", "doctor", "Doctor"),
    ("dr.lakshmi", "Dr. Lakshmi Iyer", "doctor", "Doctor"),
    ("nurse.priya", "Priya Nair", "nurse", "Nurse"),
    ("frontdesk", "Kavya Reddy", "front_office", "Administrative"),
    ("billing", "Mahesh Gupta", "billing", "Administrative"),
    ("pharmacy", "Anil Kumar", "pharmacist", "Pharmacist"),
    ("lab", "Swathi Rao", "lab", "Technician"),
    ("radiology", "Naveen Chowdary", "radiology", "Technician"),
    ("hr", "Padma Menon", "hr", "Administrative"),
    ("stores", "Ravi Naidu", "stores", "Administrative"),
    ("quality", "Dr. Meena Kulkarni", "quality", "Management"),
    ("support", "Ramesh Goud", "support", "Support"),
    ("marketing", "Harika Shetty", "marketing", "Administrative"),
    ("employee", "Teja Varma", "employee", "Support"),
]

# ====================================================================== phase 2 reference data

# extra tests used by reflex rules (appended so existing demo order sampling is unchanged)
LAB_TESTS += [
    ("LAB-FT4", "Free T4", "Serum", 650, 360, [("Free T4", "ng/dL", 0.8, 1.8, None, None)]),
    ("LAB-IRON", "Iron Studies (Iron, TIBC, Ferritin)", "Serum", 1100, 480, [
        ("Serum iron", "µg/dL", 60, 170, None, None), ("TIBC", "µg/dL", 240, 450, None, None), ("Ferritin", "ng/mL", 20, 250, None, None)]),
    ("LAB-PS", "Peripheral Smear Examination", "Whole Blood (EDTA)", 300, 240, [("Smear findings", "", None, None, None, None)]),
    ("LAB-LIPASE", "Serum Lipase", "Serum", 750, 120, [("Lipase", "U/L", 13, 60, None, None)]),
]

# lab test → (section, container, report abbreviation, outsourced)
LAB_SECTION_OF = {
    "LAB-CBC": ("Haematology", "Lavender (EDTA)", "CBC"), "LAB-ESR": ("Haematology", "Lavender (EDTA)", "ESR"),
    "LAB-PT": ("Haematology", "Blue (citrate)", "PT/INR"), "LAB-DDIMER": ("Haematology", "Blue (citrate)", "D-DIMER"),
    "LAB-BGRP": ("Haematology", "Lavender (EDTA)", "BG"), "LAB-PS": ("Haematology", "Lavender (EDTA)", "PS"),
    "LAB-MP": ("Haematology", "Lavender (EDTA)", "MP"), "LAB-HBA1C": ("Biochemistry", "Lavender (EDTA)", "HbA1c"),
    "LAB-RBS": ("Biochemistry", "Grey (fluoride)", "RBS"), "LAB-FBS": ("Biochemistry", "Grey (fluoride)", "FBS"),
    "LAB-LFT": ("Biochemistry", "Yellow (SST)", "LFT"), "LAB-RFT": ("Biochemistry", "Yellow (SST)", "RFT"),
    "LAB-LIPID": ("Biochemistry", "Yellow (SST)", "LIPID"), "LAB-TFT": ("Biochemistry", "Yellow (SST)", "TFT"),
    "LAB-ELEC": ("Biochemistry", "Green (heparin)", "LYTES"), "LAB-TROP": ("Biochemistry", "Green (heparin)", "TROP-I"),
    "LAB-CRP": ("Biochemistry", "Yellow (SST)", "CRP"), "LAB-ABG": ("Biochemistry", "Green (heparin)", "ABG"),
    "LAB-PROCAL": ("Biochemistry", "Yellow (SST)", "PCT"), "LAB-FT4": ("Biochemistry", "Yellow (SST)", "FT4"),
    "LAB-IRON": ("Biochemistry", "Yellow (SST)", "IRON"), "LAB-LIPASE": ("Biochemistry", "Yellow (SST)", "LIPASE"),
    "LAB-VITD": ("Biochemistry", "Yellow (SST)", "VIT-D"), "LAB-B12": ("Biochemistry", "Yellow (SST)", "B12"),
    "LAB-URINE": ("Clinical Pathology", "Sterile container", "URINE R/M"),
    "LAB-CULT-B": ("Microbiology", "Other", "BLOOD C/S"), "LAB-CULT-U": ("Microbiology", "Sterile container", "URINE C/S"),
    "LAB-DENGUE": ("Serology & Immunology", "Red top (plain)", "DENGUE"), "LAB-HIV": ("Serology & Immunology", "Red top (plain)", "HIV"),
    "LAB-HBSAG": ("Serology & Immunology", "Red top (plain)", "HBsAg"),
}
LAB_OUTSOURCED = {"LAB-VITD", "LAB-B12"}
# parameter → delta check % printed on the test master
LAB_DELTA_PERCENT = {"Haemoglobin": 20, "Platelets": 40, "Creatinine": 50, "Potassium": 25, "Sodium": 5}

# test code, parameter, sex, age_from, age_to, unit, ref_low, ref_high, crit_low, crit_high
LAB_REF_RANGES = [
    ("LAB-CBC", "Haemoglobin", "Male", 18, 120, "Years", 13.0, 17.0, 7, 20),
    ("LAB-CBC", "Haemoglobin", "Female", 18, 120, "Years", 12.0, 15.5, 7, 20),
    ("LAB-CBC", "Haemoglobin", "Any", 0, 30, "Days", 14.0, 22.0, 10, 25),
    ("LAB-CBC", "Haemoglobin", "Any", 1, 12, "Years", 11.0, 14.5, 7, 20),
    ("LAB-CBC", "Total WBC", "Any", 0, 30, "Days", 9.0, 30.0, 5, 40),
    ("LAB-CBC", "Platelets", "Any", 0, 30, "Days", 150, 450, 50, 1000),
    ("LAB-RFT", "Creatinine", "Male", 18, 120, "Years", 0.7, 1.3, None, 7),
    ("LAB-RFT", "Creatinine", "Female", 18, 120, "Years", 0.5, 1.1, None, 7),
    ("LAB-RFT", "Creatinine", "Any", 1, 17, "Years", 0.3, 0.7, None, 4),
    ("LAB-RFT", "Urea", "Any", 60, 120, "Years", 17, 49, None, 200),
    ("LAB-LFT", "Alkaline phosphatase", "Any", 1, 17, "Years", 100, 390, None, None),
    ("LAB-LFT", "Total bilirubin", "Any", 0, 14, "Days", 1.0, 12.0, None, 20),
    ("LAB-TFT", "TSH", "Any", 0, 12, "Months", 0.7, 6.0, None, 50),
    ("LAB-ESR", "ESR", "Male", 18, 120, "Years", 0, 15, None, None),
    ("LAB-ESR", "ESR", "Female", 18, 120, "Years", 0, 20, None, None),
    ("LAB-IRON", "Ferritin", "Male", 18, 120, "Years", 30, 400, None, None),
    ("LAB-IRON", "Ferritin", "Female", 18, 120, "Years", 15, 150, None, None),
    ("LAB-HBA1C", "HbA1c", "Any", 18, 120, "Years", 4.0, 5.6, None, None),
]

# parameter, test (None = any test), max %, max absolute, window days, action
LAB_DELTA_RULES = [
    ("Haemoglobin", "LAB-CBC", 20, 2.0, 7, "Flag for review"),
    ("Platelets", "LAB-CBC", 50, None, 7, "Flag for review"),
    ("Creatinine", None, 50, 0.5, 14, "Flag for review"),
    ("Potassium", None, None, 1.0, 3, "Hold authorisation"),
    ("Sodium", None, None, 10, 3, "Hold authorisation"),
    ("TSH", "LAB-TFT", 100, None, 90, "Flag for review"),
]

# name, test, parameter, operator, value, reflex test, action, comment
LAB_REFLEX_RULES = [
    ("TSH high → Free T4", "LAB-TFT", "TSH", ">", "4.5", "LAB-FT4", "Auto-order", "Free T4 added as per thyroid reflex protocol"),
    ("Low haemoglobin → iron studies", "LAB-CBC", "Haemoglobin", "<", "10", "LAB-IRON", "Suggest to pathologist",
     "Iron studies suggested to evaluate anaemia"),
    ("Thrombocytopenia → peripheral smear", "LAB-CBC", "Platelets", "<", "100", "LAB-PS", "Auto-order",
     "Smear reviewed to rule out pseudothrombocytopenia"),
    ("Leucocytosis → peripheral smear", "LAB-CBC", "Total WBC", ">", "20", "LAB-PS", "Suggest to pathologist", None),
    ("RBS ≥ 200 → HbA1c", "LAB-RBS", "Glucose (random)", ">=", "200", "LAB-HBA1C", "Suggest to pathologist", None),
    ("Dengue NS1 positive → CBC", "LAB-DENGUE", "NS1 antigen", "Contains", "Positive", "LAB-CBC", "Auto-order",
     "Platelet monitoring for NS1-positive dengue"),
    ("High SGPT → lipase", "LAB-LFT", "SGPT (ALT)", ">", "200", "LAB-LIPASE", "Suggest to pathologist", None),
]

# name, class, panels
ANTIBIOTICS = [
    ("Ampicillin", "Penicillin", ["Gram-negative", "Enterococcus"]),
    ("Amoxicillin-clavulanate", "Beta-lactam / BLI", ["Gram-negative"]),
    ("Piperacillin-tazobactam", "Beta-lactam / BLI", ["Gram-negative", "Pseudomonas", "Anaerobes"]),
    ("Cefuroxime", "Cephalosporin (2nd gen)", ["Gram-negative"]),
    ("Ceftriaxone", "Cephalosporin (3rd gen)", ["Gram-negative"]),
    ("Ceftazidime", "Cephalosporin (3rd gen)", ["Pseudomonas"]),
    ("Cefepime", "Cephalosporin (4th gen)", ["Gram-negative", "Pseudomonas"]),
    ("Cefoperazone-sulbactam", "Beta-lactam / BLI", ["Gram-negative"]),
    ("Ertapenem", "Carbapenem", ["Gram-negative"]),
    ("Imipenem", "Carbapenem", ["Gram-negative", "Pseudomonas"]),
    ("Meropenem", "Carbapenem", ["Gram-negative", "Pseudomonas", "Anaerobes"]),
    ("Amikacin", "Aminoglycoside", ["Gram-negative", "Pseudomonas"]),
    ("Gentamicin", "Aminoglycoside", ["Gram-negative", "Pseudomonas", "Gram-positive"]),
    ("Ciprofloxacin", "Fluoroquinolone", ["Gram-negative", "Pseudomonas", "Gram-positive", "Enterococcus"]),
    ("Levofloxacin", "Fluoroquinolone", ["Gram-negative", "Pseudomonas"]),
    ("Trimethoprim-sulfamethoxazole", "Folate antagonist", ["Gram-negative", "Gram-positive"]),
    ("Colistin", "Polymyxin", ["Gram-negative", "Pseudomonas"]),
    ("Tigecycline", "Glycylcycline", ["Gram-negative"]),
    ("Nitrofurantoin", "Nitrofuran", ["Urinary", "Enterococcus"]),
    ("Fosfomycin", "Phosphonic acid", ["Urinary"]),
    ("Penicillin", "Penicillin", ["Gram-positive"]),
    ("Cefoxitin screen", "Cephamycin (MRSA screen)", ["Gram-positive"]),
    ("Erythromycin", "Macrolide", ["Gram-positive"]),
    ("Clindamycin", "Lincosamide", ["Gram-positive", "Anaerobes"]),
    ("Linezolid", "Oxazolidinone", ["Gram-positive", "Enterococcus"]),
    ("Vancomycin", "Glycopeptide", ["Gram-positive", "Enterococcus"]),
    ("Teicoplanin", "Glycopeptide", ["Gram-positive", "Enterococcus"]),
    ("Doxycycline", "Tetracycline", ["Gram-positive"]),
    ("Metronidazole", "Nitroimidazole", ["Anaerobes"]),
    ("Fluconazole", "Azole antifungal", ["Fungal"]),
    ("Voriconazole", "Azole antifungal", ["Fungal"]),
    ("Amphotericin B", "Polyene antifungal", ["Fungal"]),
    ("Caspofungin", "Echinocandin", ["Fungal"]),
]

# name, accreditation, contact, phone, address, pickup, turnaround days
REFERENCE_LABS = [
    ("Deccan Reference Laboratory", "NABL MC-5512", "Ms. Shalini Rao", "9849012345", "Banjara Hills, Hyderabad, Telangana",
     "Daily 11:00 and 17:00", 3),
    ("Coastal Molecular Diagnostics", "NABL MC-6120", "Mr. Kiran Varma", "9866023456", "Benz Circle, Vijayawada, Andhra Pradesh",
     "Daily 14:00", 4),
]

# name, short name, payer type, scheme, co-pay %, discount %, credit days, tariff (basis, percent, category rules)
PAYERS = [
    ("Star Health & Allied Insurance", "Star Health", "Insurer", "Not applicable", 10, 10, 30,
     ("% on base tariff", -10, [("ROOM", -5), ("LAB", -15), ("RAD", -12)])),
    ("HDFC ERGO General Insurance", "HDFC ERGO", "Insurer", "Not applicable", 0, 8, 30, None),
    ("Medi Assist TPA", "Medi Assist", "TPA", "Not applicable", 10, 0, 45, ("% on base tariff", -8, [])),
    ("Paramount Health Services TPA", "Paramount", "TPA", "Not applicable", 20, 0, 45, None),
    ("Krishna Cements Ltd (staff & dependants)", "Krishna Cements", "Corporate", "Not applicable", 0, 12, 60,
     ("% on base tariff", -12, [("PHARM", -5)])),
    ("Godavari Infra Pvt Ltd", "Godavari Infra", "Corporate", "Not applicable", 0, 10, 45, None),
    ("Ayushman Bharat PM-JAY", "PM-JAY", "Government Scheme", "PM-JAY (Ayushman Bharat)", 0, 0, 30,
     ("Price list, else % on base", -35, [])),
    ("Dr. YSR Aarogyasri (AP state scheme)", "Aarogyasri", "Government Scheme", "State scheme", 0, 0, 30,
     ("Price list, else % on base", -30, [])),
    ("CGHS Vijayawada", "CGHS", "Government Scheme", "CGHS", 0, 0, 30, ("Price list", 0, [])),
]
PAYER_KIND = {"Insurance": ["Insurer", "TPA"], "Corporate": ["Corporate"], "Government Scheme": ["Government Scheme"]}

# name, tag prefix, type, billing rule, rate, home ward, count
BILLABLE_EQUIPMENT = [
    ("Ventilator — Hamilton C3", "VENT", "Ventilator", "Per day", 4500, "MICU", 4),
    ("Ventilator — Dräger Savina 300", "VENT", "Ventilator", "Per day", 4500, "SICU", 3),
    ("BiPAP — ResMed VPAP ST", "BIPAP", "BiPAP / CPAP", "Per day", 1800, "MICU", 3),
    ("HFNC — Fisher & Paykel Airvo 2", "HFNC", "HFNC", "Per day", 2200, "CCU", 2),
    ("Syringe pump — B. Braun Perfusor", "SYR", "Syringe pump", "Per day", 350, "MICU", 6),
    ("Infusion pump — BD Alaris", "INF", "Infusion pump", "Per day", 400, "SICU", 5),
    ("Multipara monitor — Philips IntelliVue MX450", "MON", "Multipara monitor", "Per day", 800, "HDU", 6),
    ("Defibrillator — Zoll R Series", "DEFIB", "Defibrillator", "Per use", 1500, "CCU", 2),
    ("DVT pump — Kendall SCD 700", "DVT", "DVT / SCD pump", "Per day", 600, "SICU", 3),
    ("Air mattress — alternating pressure", "AIRM", "Air / alpha mattress", "Per day", 250, "M1", 6),
    ("Suction machine — portable", "SUC", "Suction machine", "Per use", 200, "HDU", 3),
    ("Phototherapy unit — LED", "PHOTO", "Phototherapy unit", "Per hour", 120, "NICU", 3),
    ("Radiant warmer", "WARM", "Warmer / radiant warmer", "Per day", 900, "NICU", 3),
]

# name, type, gstin, contact, phone, city, supplies
VENDORS = [
    ("MedEquip Biomedical Services", "Service provider", "37AAFCM4521K1Z2", "Rajesh Kumar", "9848011122", "Vijayawada", ["Equipment", "AMC"]),
    ("Philips Healthcare Service (authorised partner)", "Service provider", "36AABCP1234L1Z9", "Anand Reddy", "9848022233", "Hyderabad",
     ["Equipment", "AMC", "CMC"]),
    ("Andhra Biomed Calibration Lab", "Service provider", "37AAKFA7788C1Z4", "Sudheer Babu", "9848033344", "Guntur", ["Calibration"]),
    ("Sri Sai Electricals & HVAC", "Contractor", "37ABCFS9900D1Z1", "Venu Gopal", "9848044455", "Guntur", ["Electrical", "HVAC"]),
    ("Guntur Medical Gases", "Distributor", "37AADCG3344E1Z7", "Prasad Rao", "9848055566", "Guntur", ["Medical gas"]),
    ("Fresenius Kabi Service Centre", "Service provider", "36AAACF5566F1Z3", "Imran Khan", "9848066677", "Hyderabad",
     ["Dialysis", "Equipment"]),
]

# name, category, make, model, dept, location, cost, criticality, pm freq, calibration freq, AMC type, vendor index, risk class
ASSETS = [
    ("Ventilator — Hamilton C3 #1", "Ventilator", "Hamilton Medical", "C3", "CRIT", "MICU bed 1", 1450000, "High (life support / critical care)",
     "Quarterly", "Yearly", "CMC", 0, "Class C (moderate-high)"),
    ("Ventilator — Hamilton C3 #2", "Ventilator", "Hamilton Medical", "C3", "CRIT", "MICU bed 4", 1450000, "High (life support / critical care)",
     "Quarterly", "Yearly", "CMC", 0, "Class C (moderate-high)"),
    ("Ventilator — Dräger Savina 300 #1", "Ventilator", "Dräger", "Savina 300", "CRIT", "SICU bed 2", 1250000,
     "High (life support / critical care)", "Quarterly", "Yearly", "AMC", 0, "Class C (moderate-high)"),
    ("Defibrillator — Zoll R Series", "Defibrillator", "Zoll", "R Series", "CARD", "CCU nursing station", 420000,
     "High (life support / critical care)", "Monthly", "Half-yearly", "AMC", 0, "Class C (moderate-high)"),
    ("Defibrillator — Philips HeartStart XL+", "Defibrillator", "Philips", "HeartStart XL+", "EMED", "ER resus bay", 380000,
     "High (life support / critical care)", "Monthly", "Half-yearly", "CMC", 1, "Class C (moderate-high)"),
    ("Multipara monitor — IntelliVue MX450 #1", "Patient monitor", "Philips", "IntelliVue MX450", "CRIT", "HDU bed 3", 310000,
     "Medium", "Half-yearly", "Yearly", "CMC", 1, "Class B (low-moderate)"),
    ("Multipara monitor — IntelliVue MX450 #2", "Patient monitor", "Philips", "IntelliVue MX450", "CRIT", "HDU bed 7", 310000,
     "Medium", "Half-yearly", "Yearly", "CMC", 1, "Class B (low-moderate)"),
    ("Multipara monitor — BPL Excello", "Patient monitor", "BPL", "Excello", "EMED", "ER bay 4", 145000, "Medium",
     "Half-yearly", "Yearly", "AMC", 0, "Class B (low-moderate)"),
    ("Syringe pump — B. Braun Perfusor Space", "Syringe pump", "B. Braun", "Perfusor Space", "CRIT", "MICU store", 85000, "Medium",
     "Half-yearly", "Yearly", "None", 0, "Class B (low-moderate)"),
    ("Infusion pump — BD Alaris GP", "Infusion pump", "BD", "Alaris GP", "CRIT", "SICU store", 95000, "Medium",
     "Half-yearly", "Yearly", "AMC", 0, "Class B (low-moderate)"),
    ("Anaesthesia workstation — GE Carestation 650", "Anaesthesia workstation", "GE Healthcare", "Carestation 650", "ANES", "OT 2",
     2600000, "High (life support / critical care)", "Quarterly", "Half-yearly", "CMC", 1, "Class C (moderate-high)"),
    ("Electrosurgical unit — Valleylab FT10", "OT equipment", "Medtronic", "Valleylab FT10", "GSUR", "OT 1", 980000, "Medium",
     "Half-yearly", "Yearly", "AMC", 0, "Class C (moderate-high)"),
    ("OT table — Mindray HyBase 6100", "OT equipment", "Mindray", "HyBase 6100", "GSUR", "OT 3", 760000, "Medium",
     "Yearly", "Not applicable", "None", 0, "Class A (low)"),
    ("Fully automated chemistry analyser — Beckman AU480", "Laboratory analyser", "Beckman Coulter", "AU480", "PATH", "Lab — Biochemistry",
     3200000, "Medium", "Monthly", "Quarterly", "CMC", 0, "Class B (low-moderate)"),
    ("Haematology analyser — Sysmex XN-550", "Laboratory analyser", "Sysmex", "XN-550", "PATH", "Lab — Haematology", 1850000,
     "Medium", "Monthly", "Quarterly", "CMC", 0, "Class B (low-moderate)"),
    ("CT scanner — Siemens Somatom go.Up", "Imaging equipment", "Siemens Healthineers", "Somatom go.Up", "RADI", "Radiology — CT suite",
     38500000, "High (life support / critical care)", "Quarterly", "Half-yearly", "CMC", 1, "Class C (moderate-high)"),
    ("Digital X-ray — Fujifilm FDR Smart X", "Imaging equipment", "Fujifilm", "FDR Smart X", "RADI", "Radiology — X-ray room 1",
     5400000, "Medium", "Quarterly", "Yearly", "AMC", 1, "Class B (low-moderate)"),
    ("Ultrasound — GE Logiq P9", "Imaging equipment", "GE Healthcare", "Logiq P9", "RADI", "Radiology — USG room 2", 2900000,
     "Medium", "Half-yearly", "Yearly", "AMC", 1, "Class B (low-moderate)"),
    ("Haemodialysis machine — Fresenius 4008S (HD-01)", "Dialysis machine", "Fresenius", "4008S", "NEPH", "Dialysis unit bay 1",
     720000, "High (life support / critical care)", "Quarterly", "Half-yearly", "CMC", 5, "Class C (moderate-high)"),
    ("Haemodialysis machine — Nipro Surdial X (HD-05)", "Dialysis machine", "Nipro", "Surdial X", "NEPH", "Dialysis unit bay 5",
     680000, "High (life support / critical care)", "Quarterly", "Half-yearly", "CMC", 5, "Class C (moderate-high)"),
    ("Vaccine refrigerator — Vestfrost MK 304", "Refrigerator / freezer", "Vestfrost", "MK 304", "PAED", "Immunisation room", 160000,
     "Medium", "Quarterly", "Quarterly", "AMC", 3, "Not a medical device"),
    ("Blood bank refrigerator — Remi BBR 300", "Refrigerator / freezer", "Remi", "BBR 300", "PATH", "Blood bank", 240000,
     "High (life support / critical care)", "Quarterly", "Quarterly", "AMC", 3, "Not a medical device"),
    ("Medical oxygen manifold (2×10 cylinders)", "Medical gas", "Medi Gas Systems", "Auto-changeover", "FAC", "Gas plant room", 650000,
     "High (life support / critical care)", "Monthly", "Not applicable", "AMC", 4, "Not a medical device"),
    ("Diesel generator 500 kVA", "Electrical", "Cummins", "C500D5", "FAC", "DG yard", 4200000, "High (life support / critical care)",
     "Monthly", "Not applicable", "AMC", 3, "Not a medical device"),
    ("UPS 60 kVA — ICU block", "Electrical", "Emerson", "Liebert APM", "FAC", "Block E electrical room", 1100000, "Medium",
     "Quarterly", "Not applicable", "AMC", 3, "Not a medical device"),
    ("AHU — OT complex (HEPA)", "HVAC", "Blue Star", "AHU-12", "FAC", "OT complex roof", 1800000, "High (life support / critical care)",
     "Monthly", "Not applicable", "AMC", 3, "Not a medical device"),
    ("Fire alarm panel — Block A", "Fire & safety", "Honeywell", "Notifier NFS2", "FAC", "Block A ground floor", 350000, "Medium",
     "Quarterly", "Not applicable", "AMC", 3, "Not a medical device"),
    ("Autoclave — CSSD horizontal 400 L", "Biomedical equipment", "Tuttnauer", "69-series", "FAC", "CSSD", 1650000, "Medium",
     "Monthly", "Quarterly", "AMC", 0, "Class B (low-moderate)"),
    ("ECG machine — BPL Cardiart 9108", "Medical equipment", "BPL", "Cardiart 9108", "CARD", "Cardiology OPD", 120000, "Low",
     "Half-yearly", "Yearly", "None", 0, "Class B (low-moderate)"),
    ("Ambulance — Force Traveller ALS", "Vehicle", "Force Motors", "Traveller 26", "FAC", "Ambulance bay", 2850000, "Medium",
     "Quarterly", "Not applicable", "AMC", 3, "Not a medical device"),
    ("Server — HIS primary (Dell PowerEdge R750)", "IT hardware", "Dell", "PowerEdge R750", "ADMN", "Data centre rack 2", 980000,
     "High (life support / critical care)", "Half-yearly", "Not applicable", "AMC", 3, "Not a medical device"),
]

# name, scope, field keys, form key, shortcut, body (owner: dr.rao unless the scope says otherwise)
TEXT_TEMPLATES = [
    ("Normal systemic examination", "Global", ["general_examination", "systemic_examination"], None, "nse",
     "CVS: S1 S2 heard, no murmurs.\nRS: Bilateral air entry equal, normal vesicular breath sounds, no added sounds.\n"
     "P/A: Soft, non-tender, no organomegaly, bowel sounds present.\nCNS: Conscious, oriented, no focal neurological deficit."),
    ("Discharge advice — general medicine", "Global", ["advice", "discharge_advice"], "discharge.summary", "dadv",
     "1. Continue medicines as prescribed.\n2. Adequate oral fluids and a balanced diet.\n3. Review in medicine OPD after 7 days with reports.\n"
     "4. Return to the emergency department if fever, breathlessness, chest pain or reduced urine output."),
    ("Diabetic diet & foot care advice", "Department", ["advice"], None, "dmadv",
     "Diabetic diet (1800 kcal), avoid sweets and fruit juices; walk 30 minutes daily; check feet daily; "
     "home glucose monitoring — fasting and 2 h after lunch; review with HbA1c in 3 months."),
    ("Dengue warning signs", "Department", ["advice", "discharge_advice"], None, "dws",
     "Watch for abdominal pain, persistent vomiting, bleeding from gums or nose, black stools, drowsiness or restlessness — "
     "come to the ER immediately. Daily CBC until platelets rise."),
    ("Post-op instructions — laparoscopic surgery", "Global", ["advice", "post_op_instructions"], None, "lapadv",
     "Keep port sites dry for 48 hours; walk from the evening of surgery; soft diet for 3 days; dressing review on day 3; "
     "suture removal on day 7; avoid lifting heavy weights for 4 weeks."),
    ("Chest pain — initial ER plan", "Department", ["plan"], None, "cp",
     "ECG within 10 minutes, repeat at 30 minutes; hs-Troponin I at 0 and 3 h; Aspirin 325 mg chewed unless contraindicated; "
     "cardiology call if ST changes or troponin positive."),
    ("Nursing — fall precautions explained", "Global", ["remarks", "nursing_notes"], None, "fall",
     "Fall-risk wristband applied, bed in lowest position with brakes on, side rails up, call bell within reach; "
     "attendant educated about fall prevention."),
    ("My OPD review note", "Personal", ["plan", "advice"], None, "rev",
     "Reports reviewed and explained to the patient. Continue the same treatment. Review after 2 weeks or earlier if symptoms worsen."),
]

# queue key, name, kind, department code (None = hospital-wide), daily capacity, avg service min, open, close, kiosk, order
QUEUE_MASTERS = [
    ("REG", "Registration & Front Desk", "Registration", None, None, 4, "07:30", "20:00", True, 1),
    ("BILL", "OP Billing", "Billing", "FIN", None, 3, "07:30", "21:00", True, 2),
    ("LAB", "Sample Collection", "Sample Collection", "PATH", None, 4, "07:00", "19:00", True, 3),
    ("RAD", "Radiology Reception", "Radiology", "RADI", 120, 6, "08:00", "20:00", True, 4),
    ("PHARM", "OP Pharmacy", "Pharmacy", "PHAR", None, 3, "00:00", "23:59", True, 5),
    ("HELP", "Help Desk & Insurance", "Help Desk", "ADMN", None, 6, "08:00", "18:00", True, 6),
]

# name, code, location, department code, queue keys, next count, ticker
DISPLAY_BOARDS = [
    ("Ground floor — OPD lobby", "QDB-LOBBY", "Block A, ground floor", None, ["REG", "BILL", "LAB", "PHARM"], 6,
     "Please keep your token slip ready. Senior citizens and differently-abled patients are served first."),
    ("Pharmacy waiting area", "QDB-PHARM", "Block A, ground floor (east)", None, ["PHARM"], 8,
     "Check the medicines and the bill before leaving the counter."),
    ("Diagnostics corridor", "QDB-DIAG", "Block A, first floor", None, ["LAB", "RAD"], 6,
     "Fasting samples are collected first between 7 and 9 am."),
    ("Cardiology OPD screen", "QDB-CARD", "Block D, 7th floor", "CARD", [], 5, "Please carry your previous ECG and echo reports."),
    ("Orthopaedics OPD screen", "QDB-ORTH", "Block B, 4th floor", "ORTH", [], 5, None),
    ("General Medicine OPD screen", "QDB-GMED", "Block A, 2nd floor", "GMED", [], 5, None),
]

# name, org type, credit limit, credit days, discount %, co-pay %
PHARMACY_CREDIT_ORGS = [
    ("Krishna Cements Ltd — staff pharmacy credit", "Corporate", 300000, 45, 10, 0),
    ("Vlack Hospital staff (salary deduction)", "Hospital staff", 50000, 30, 15, 0),
    ("Star Health — OPD cashless pharmacy", "Insurance / TPA", 200000, 30, 5, 10),
    ("Guntur Diocese Charitable Trust", "Trust / NGO", 100000, 60, 20, 0),
]

# name, applies to, match value, margin from, margin to, default %, max %, sale types, priority
PHARMACY_MARGIN_RULES = [
    ("High-margin generics", "All items", None, 25, 100, 10, 20, ["Walk-in (OTC)", "Prescription"], 20),
    ("Antibiotics — capped discount", "Drug class", "Beta-lactam", 0, 100, 5, 8, [], 10),
    ("IV fluids — no discount", "Drug class", "IV fluid", 0, 100, 0, 0, [], 5),
    ("Consumables", "Item type", "Consumable", 20, 100, 5, 12, [], 15),
    ("Credit sales — agreed discount only", "All items", None, 0, 100, 0, 15, ["Credit"], 8),
]

# metric code, name, area, unit, target, direction
TAT_TARGETS = [
    ("TAT-LAB", "Lab TAT (collection → release)", "Lab", "Minutes", 240, "Lower is better"),
    ("TAT-RAD", "Radiology TAT (order → report)", "Radiology", "Minutes", 360, "Lower is better"),
    ("TAT-OPWAIT", "OP waiting time (check-in → seen)", "OP", "Minutes", 30, "Lower is better"),
    ("TAT-DISCHARGE", "Discharge TAT (decision → bed free)", "IP", "Minutes", 180, "Lower is better"),
    ("TAT-ER-D2D", "ER door-to-doctor", "Operations", "Minutes", 15, "Lower is better"),
    ("TAT-LAB-SLA", "Lab tests within their TAT target", "Lab", "%", 90, "Higher is better"),
]

DIALYSIS_MACHINES = [
    ("HD-01", "Bay 1", "Fresenius", "4008S", "General (non-reactive)", False),
    ("HD-02", "Bay 2", "Fresenius", "4008S", "General (non-reactive)", False),
    ("HD-03", "Bay 3", "Nipro", "Surdial X", "General (non-reactive)", True),
    ("HD-04", "Bay 4", "Nipro", "Surdial X", "General (non-reactive)", True),
    ("HD-05", "Bay 5", "B. Braun", "Dialog+", "General (non-reactive)", True),
    ("HD-06", "Bay 6", "Fresenius", "5008 CorDiax", "Isolation / AKI", True),
    ("HD-07", "Isolation room 1", "Fresenius", "4008S", "Dedicated HBsAg", False),
    ("HD-08", "Isolation room 2", "Nipro", "Surdial X", "Dedicated HCV", False),
]
