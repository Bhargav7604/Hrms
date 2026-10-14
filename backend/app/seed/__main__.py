"""Seed masters and (optionally) realistic demo activity.

    uv run python -m app.seed               # masters + demo data (skips if already seeded)
    uv run python -m app.seed --reset       # wipe every table first
    uv run python -m app.seed --no-demo     # masters only (go-live installs)
"""

from __future__ import annotations

import asyncio
import os
import random
import sys
import time
from datetime import date, datetime, timedelta

import sqlalchemy as sa

from app.core.records import fetch
from app.core.registry import load_registry
from app.core.security import hash_password
from app.core.util import new_id, now, today
from app.db import SYSTEM_USER, engine, system_ctx
from app.engines._common import E, create, has, transition, update
from app.schema import ENTITY_TABLES, audit_log, sequences, users

from .masters import (
    CITIES,
    CONSUMABLES,
    DEPARTMENTS,
    DRUGS,
    FIRST_F,
    FIRST_M,
    LAB_TESTS,
    LAST,
    OPD_DEPTS,
    RAD_STUDIES,
    STORES,
    TARIFF,
    USERS,
    WARDS,
)

rnd = random.Random(2026)
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "Vlack@2026")
TZ = None


def log(msg: str) -> None:
    print(f"  · {msg}", flush=True)


def phone() -> str:
    return f"{rnd.choice('6789')}{rnd.randint(100000000, 999999999)}"


def person(gender: str | None = None) -> tuple[str, str, str]:
    g = gender or rnd.choice(["Male", "Female"])
    first = rnd.choice(FIRST_M if g == "Male" else FIRST_F)
    return first, rnd.choice(LAST), g


def at(d: date, h: int, m: int = 0) -> str:
    from app.config import settings

    return datetime(d.year, d.month, d.day, h, m, tzinfo=settings.tz).isoformat()


async def backdate(ctx, table: str, rid: str, ts: str) -> None:
    t = ENTITY_TABLES[table]
    when = datetime.fromisoformat(ts)
    extra = {"charged_at": when} if table == "charges" else {}
    await ctx.conn.execute(t.update().where(t.c.id == rid).values(created_at=when, updated_at=when, **extra))


# ====================================================================== masters

async def seed_masters() -> dict:
    ids: dict = {"dept": {}, "ward": {}, "doctors": {}, "nurses": [], "staff": [], "items": {}, "services": {}, "beds": []}
    async with system_ctx() as ctx:
        for code, name, typ in DEPARTMENTS:
            r = await create(ctx, "mdm.departments", {"code": code, "name": name, "dept_type": typ, "opd_enabled": code in OPD_DEPTS,
                                                       "location": f"Block {rnd.choice('ABCD')}", "status": "Active"})
            ids["dept"][code] = r["id"]
        for b in ("Main Campus — Guntur",):
            await create(ctx, "mdm.branches", {"code": "MAIN", "name": b, "city": "Guntur", "state": "Andhra Pradesh", "beds": 1000,
                                                "gstin": "37AABCV1234F1Z5", "status": "Active"})
        log(f"{len(DEPARTMENTS)} departments")

        for code, name, wtype, floor, block, dept, n, cat, rate in WARDS:
            w = await create(ctx, "mdm.wards", {"code": code, "name": name, "ward_type": wtype, "floor": floor, "block": block,
                                                 "department": ids["dept"][dept], "status": "Active",
                                                 "nurse_patient_ratio": "1:1" if wtype in ("ICU", "NICU", "PICU") else "1:2" if wtype == "HDU" else "1:6"})
            ids["ward"][code] = w["id"]
            for i in range(1, n + 1):
                bno = f"{code}-{i:02d}"
                b = await create(ctx, "ipd.beds", {"code": bno, "bed_no": bno, "ward_id": w["id"], "category": cat, "rate": rate,
                                                    "room_no": f"{floor}{block}{(i - 1) // 4 + 1:02d}", "status": "Vacant"})
                ids["beds"].append({"id": b["id"], "ward": code, "category": cat, "rate": rate, "dept": dept})
        log(f"{len(WARDS)} wards, {len(ids['beds'])} beds")

        # tariff
        for code, name, cat, dept, rate, tax, tat in TARIFF:
            s = await create(ctx, "billing.services", {"code": code, "name": name, "category": cat, "department_id": ids["dept"][dept],
                                                        "rate": rate, "tax_percent": tax, "tat_minutes": tat, "status": "Active"})
            ids["services"][code] = s["id"]
        for code, name, sample, rate, tat, params in LAB_TESTS:
            s = await create(ctx, "lab.tests", {"code": code, "name": name, "sample_type": sample, "rate": rate, "tat_minutes": tat,
                                                 "department_id": ids["dept"]["PATH"], "status": "Active",
                                                 "parameters": [{"parameter": p, "unit": u, "ref_low": lo, "ref_high": hi, "critical_low": cl, "critical_high": ch}
                                                                for p, u, lo, hi, cl, ch in params]})
            ids["services"][code] = s["id"]
        for code, name, modality, part, rate, tat in RAD_STUDIES:
            s = await create(ctx, "radiology.studies", {"code": code, "name": name, "modality": modality, "body_part": part, "rate": rate,
                                                         "tat_minutes": tat, "status": "Active", "contrast": "CECT" in name or "Angio" in name})
            ids["services"][code] = s["id"]
        log(f"{len(ids['services'])} tariff services, lab tests and radiology studies")

        for i, (name, generic, form, strength, uom, cls, inter, mrp, sched, high) in enumerate(DRUGS, 1):
            it = await create(ctx, "mdm.items", {"code": f"DRG{i:04d}", "name": name, "type": "Drug", "generic_name": generic, "form": form,
                                                  "strength": strength, "uom": uom, "drug_class": cls, "interacts_with": inter, "mrp": mrp,
                                                  "purchase_rate": round(mrp * 0.72, 2), "schedule": sched, "high_alert": high, "gst_percent": 12,
                                                  "reorder_level": 200, "status": "Active", "manufacturer": rnd.choice(["Cipla", "Sun Pharma", "Dr. Reddy's", "Lupin", "Alkem", "Mankind", "Zydus"])})
            ids["items"][name] = it["id"]
        for i, (name, typ, uom, mrp) in enumerate(CONSUMABLES, 1):
            it = await create(ctx, "mdm.items", {"code": f"CON{i:04d}", "name": name, "type": typ, "uom": uom, "mrp": mrp,
                                                  "purchase_rate": round(mrp * 0.7, 2), "gst_percent": 12, "reorder_level": 50, "status": "Active"})
            ids["items"][name] = it["id"]
        log(f"{len(ids['items'])} drugs & items")

        # staff
        emp_no = 0

        async def employee(name, category, designation, dept, **extra):
            nonlocal emp_no
            emp_no += 1
            return await create(ctx, "employees.employees", {
                "name": name, "category": category, "designation": designation, "department_id": ids["dept"].get(dept),
                "phone": phone(), "doj": (today() - timedelta(days=rnd.randint(60, 3650))).isoformat(), "status": "Active",
                "employment_type": "Permanent", "gender": extra.pop("gender", None), **extra,
            })

        user_emp = {}
        for uname, display, role, cat in USERS:
            emp = None
            if cat:
                dept = {"doctor": "GMED", "nurse": "NURS", "pharmacist": "PHAR", "lab": "PATH", "radiology": "RADI", "hr": "HR",
                        "billing": "FIN", "front_office": "ADMN", "stores": "FAC", "support": "FAC", "quality": "ADMN"}.get(role, "ADMN")
                desig = {"doctor": "Consultant", "nurse": "Staff Nurse", "management": "Director", "pharmacist": "Chief Pharmacist",
                         "lab": "Senior Lab Technologist", "radiology": "Radiographer"}.get(role, "Executive")
                extra = {}
                if role == "doctor":
                    extra = {"specialization": "Internal Medicine", "license_no": f"APMC/{rnd.randint(10000, 99999)}",
                             "license_expiry": (today() + timedelta(days=rnd.randint(20, 900))).isoformat(), "consult_fee": 800,
                             "fee_share_percent": 60, "qualification": "MBBS, MD", "registration_council": "AP Medical Council"}
                if role == "nurse":
                    extra = {"license_no": f"APNC/{rnd.randint(10000, 99999)}", "license_expiry": (today() + timedelta(days=rnd.randint(20, 900))).isoformat(),
                             "qualification": "B.Sc Nursing"}
                emp = await employee(display.split(" (")[0], cat, desig, dept, **extra)
                user_emp[uname] = emp["id"]
                if role == "doctor":
                    ids["doctors"].setdefault("GMED", []).append(emp["id"])
            await ctx.conn.execute(users.insert().values(
                id=new_id(), username=uname, name=display, role=role, password_hash=hash_password(DEMO_PASSWORD),
                employee_id=emp["id"] if emp else None, active=True, created_at=now(), updated_at=now()))
            if emp:
                await ctx.conn.execute(ENTITY_TABLES["employees"].update().where(ENTITY_TABLES["employees"].c.id == emp["id"]).values(user_id=None))
        log(f"{len(USERS)} user accounts")

        specs = {"GMED": "Internal Medicine", "GSUR": "General Surgery", "CARD": "Cardiology", "ORTH": "Orthopaedics", "OBGY": "Obstetrics & Gynaecology",
                 "PAED": "Paediatrics", "NEUR": "Neurology", "NEPH": "Nephrology", "ONCO": "Medical Oncology", "ENT": "ENT", "OPHT": "Ophthalmology",
                 "DERM": "Dermatology", "PSYC": "Psychiatry", "PULM": "Pulmonology", "GAST": "Gastroenterology", "UROL": "Urology",
                 "DENT": "Dental Surgery", "PHYS": "Physiotherapy", "EMED": "Emergency Medicine", "ANES": "Anaesthesiology", "RADI": "Radiology",
                 "PATH": "Pathology", "CRIT": "Critical Care"}
        for dept, spec in specs.items():
            for _ in range(3 if dept in OPD_DEPTS else 2):
                f, last, g = person()
                d = await employee(f"Dr. {f} {last}", "Doctor", rnd.choice(["Consultant", "Senior Consultant", "Associate Consultant"]), dept,
                                   gender=g, specialization=spec, qualification=rnd.choice(["MBBS, MD", "MBBS, MS", "MBBS, DNB", "MBBS, DM", "MBBS, MCh"]),
                                   license_no=f"APMC/{rnd.randint(10000, 99999)}", registration_council="AP Medical Council",
                                   license_expiry=(today() + timedelta(days=rnd.randint(-20, 1200))).isoformat(),
                                   consult_fee=rnd.choice([500, 600, 700, 800, 1000]), fee_share_percent=rnd.choice([50, 60, 70]))
                ids["doctors"].setdefault(dept, []).append(d["id"])
        for _ in range(140):
            f, last, g = person(rnd.choice(["Female"] * 5 + ["Male"]))
            n = await employee(f"{f} {last}", "Nurse", rnd.choice(["Staff Nurse"] * 6 + ["Charge Nurse", "Nursing Supervisor"]), "NURS", gender=g,
                               qualification=rnd.choice(["B.Sc Nursing", "GNM"]), license_no=f"APNC/{rnd.randint(10000, 99999)}",
                               license_expiry=(today() + timedelta(days=rnd.randint(-10, 1200))).isoformat())
            ids["nurses"].append(n["id"])
        for cat, desig, dept, n in (("Technician", "Lab Technician", "PATH", 18), ("Technician", "Radiographer", "RADI", 10),
                                    ("Pharmacist", "Pharmacist", "PHAR", 10), ("Support", "Housekeeping Attendant", "FAC", 40),
                                    ("Support", "Ward Assistant", "NURS", 30), ("Administrative", "Front Office Executive", "ADMN", 14),
                                    ("Administrative", "Billing Executive", "FIN", 10), ("Therapist", "Physiotherapist", "PHYS", 6)):
            for _ in range(n):
                f, last, g = person()
                e = await employee(f"{f} {last}", cat, desig, dept, gender=g)
                ids["staff"].append(e["id"])
        log(f"{emp_no} employees")

        # doctor schedules + queue counters
        for dept in OPD_DEPTS:
            for doc in ids["doctors"].get(dept, []):
                await create(ctx, "appointments.schedules", {"doctor": doc, "department": ids["dept"][dept], "weekdays": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
                                                              "start_time": "09:00", "end_time": "13:00", "slot_minutes": 15, "max_patients": 16,
                                                              "room": f"OPD-{rnd.randint(1, 60):02d}", "consult_fee": 600, "mode": "Both", "status": "Active"})
        for name, key, typ in (("Registration 1", "REG", "Registration"), ("Registration 2", "REG", "Registration"), ("Billing Counter", "BILL", "Billing"),
                               ("OP Pharmacy", "PHARM", "Pharmacy"), ("Sample Collection", "LAB", "Lab Collection")):
            await create(ctx, "queue.counters", {"name": name, "queue_key": key, "counter_type": typ, "location": "Ground floor", "status": "Open"})
        log("doctor schedules and queue counters")

        # optional masters from other modules
        if has("inventory.stock"):
            for name, item_id in ids["items"].items():
                drug = next((d for d in DRUGS if d[0] == name), None)
                mrp = drug[7] if drug else next(c[3] for c in CONSUMABLES if c[0] == name)
                for store in (["OP Pharmacy", "IP Pharmacy", "Main Store"] if drug else ["Main Store", "OT Store"]):
                    for _ in range(rnd.choice([1, 2])):
                        exp = today() + timedelta(days=rnd.choice([25, 60, 200, 400, 700]))
                        await create(ctx, "inventory.stock", {"item_id": item_id, "store": store, "batch": f"B{rnd.randint(10000, 99999)}",
                                                               "expiry": exp.isoformat(), "qty": rnd.choice([40, 120, 300, 800, 1500]) if drug else rnd.randint(5, 60),
                                                               "rate": round(mrp * 0.72, 2), "mrp": mrp, "status": "Available"})
            log("opening stock")
        if has("workflow.flows"):
            for name, key, min_amt, steps in (
                ("Bill discount approval", "billing.discount", 0, [("management", 4)]),
                ("Refund approval", "billing.refund", 5000, [("management", 8)]),
                ("Purchase order approval", "procurement.purchase_order", 0, [("management", 24)]),
                ("High-value purchase order", "procurement.purchase_order", 500000, [("management", 24), ("admin", 48)]),
                ("Stock adjustment approval", "inventory.adjustment", 0, [("management", 24)]),
                ("Credit note approval", "billing.credit_note", 0, [("management", 24)]),
            ):
                await create(ctx, "workflow.flows", {"name": name, "flow_key": key, "min_amount": min_amt, "notify": True, "status": "Active",
                                                      "steps": [{"step_no": i + 1, "approver_role": r, "sla_hours": h} for i, (r, h) in enumerate(steps)]})
            log("approval flows")
        if has("notifications.templates"):
            for key, ch, body in (
                ("appointment.booked", "SMS", "Dear {patient_name}, your appointment with {doctor} is confirmed for {date} {time}. UHID {uhid}. - Vlack Hospital"),
                ("patient.registered", "SMS", "Welcome to Vlack Hospital, {patient_name}. Your UHID is {uhid}."),
                ("report.ready", "WHATSAPP", "Hi {patient_name}, your {test} report is ready. View it in the patient portal."),
                ("bill.due", "SMS", "Dear {patient_name}, an amount of Rs.{amount} is due on bill {bill}."),
                ("discharge.done", "WHATSAPP", "Dear {patient_name}, you have been discharged. Follow-up on {date}. Get well soon!"),
                ("otp", "SMS", "{otp} is your OTP for Vlack Hospital. Valid for 5 minutes. Do not share it."),
                ("queue.called", "SMS", "Token {token} — please proceed to {counter}."),
                ("appointment.reminder", "SMS", "Reminder: {patient_name}, your appointment with {doctor} is tomorrow at {time}. UHID {uhid}."),
                ("appointment.checked_in", "SMS", "Hi {patient_name}, you are checked in. Token {token} for {doctor}."),
                ("appointment.doctor_unavailable", "SMS", "Dear {patient_name}, {doctor} is unavailable on {date}. Please reschedule — call us or use the portal."),
                ("payment.received", "SMS", "Received Rs.{amount} towards bill {bill}. Thank you — Vlack Hospital."),
            ):
                await create(ctx, "notifications.templates", {"name": key.replace(".", " ").title(), "event_key": key, "channel": ch, "body": body, "status": "Active"})
            log("notification templates")
        if has("aigov.policies"):
            for uc, risk, may, roles in (
                ("Patient Summary", "Medium", "Draft only", ["doctor", "nurse"]),
                ("Progress Note", "Medium", "Draft only", ["doctor"]),
                ("Discharge Summary", "High", "Draft only", ["doctor"]),
                ("Task Prioritisation", "Low", "Suggest", ["nurse", "doctor"]),
                ("TAT Bottlenecks", "Low", "Suggest", ["management", "quality"]),
                ("Anomaly Alert", "Low", "Suggest", ["management", "quality"]),
                ("Feedback Themes", "Low", "Auto-apply with audit", ["quality"]),
            ):
                await create(ctx, "aigov.policies", {"use_case": uc, "risk_class": risk, "ai_may": may, "review_required": may != "Auto-apply with audit",
                                                      "reviewer_roles": roles, "data_scope": ["Demographics", "Vitals", "Notes", "Orders & Results", "Medications"],
                                                      "retention_days": 365, "status": "Active"})
            log("AI governance policies")
        if has("roster.shifts"):
            for name, code, typ, s, e, h in (("Morning", "M", "Morning", "07:00", "13:00", 6), ("Evening", "E", "Evening", "13:00", "19:00", 6),
                                              ("Night", "N", "Night", "19:00", "07:00", 12), ("General", "G", "General", "09:00", "17:00", 8)):
                await create(ctx, "roster.shifts", {"name": name, "shift_code": code, "shift_type": typ, "start_time": s, "end_time": e, "hours": h,
                                                     "night_allowance": typ == "Night", "status": "Active"})
            log("shifts")
        if has("payroll.salary_structures"):
            t = ENTITY_TABLES["employees"]
            rows = (await ctx.conn.execute(sa.select(t.c.id, t.c.category).where(t.c.deleted_at.is_(None)))).all()
            base = {"Doctor": 120000, "Nurse": 28000, "Technician": 24000, "Pharmacist": 26000, "Therapist": 30000, "Administrative": 25000,
                    "Support": 14000, "Management": 180000}
            for r in rows:
                b = base.get(r.category, 20000) * rnd.uniform(0.85, 1.35)
                basic = round(b * 0.5, -2)
                await create(ctx, "payroll.salary_structures", {
                    "employee_id": str(r.id), "effective_from": date(today().year, 4, 1).isoformat(), "basic": basic, "hra": round(basic * 0.4, -2),
                    "da": round(basic * 0.1, -2), "special_allowance": round(b - basic * 1.5, -2), "conveyance": 1600, "medical_allowance": 1250,
                    "pf_applicable": True, "esi_applicable": b <= 21000, "pt_applicable": True, "pt_state": "Andhra Pradesh",
                    "tax_regime": "New", "monthly_tds": round(max(0, (b * 12 - 1200000) * 0.1 / 12), -1), "status": "Active"})
            log("salary structures")
        if has("billing.packages"):
            for name, price, los, cat in (("Normal Delivery", 25000, 2, "General"), ("LSCS", 55000, 4, "General"), ("Laparoscopic Cholecystectomy", 65000, 2, "Semi-Private"),
                                          ("Total Knee Replacement (unilateral)", 245000, 5, "Private"), ("Coronary Angioplasty (single stent)", 185000, 3, "Private"),
                                          ("Cataract (Phaco + IOL)", 28000, 0, "General")):
                await create(ctx, "billing.packages", {"name": name, "price": price, "los_days": los, "room_category": cat, "status": "Active",
                                                        "exclusions": "Blood products, high-end drugs, extra stay beyond package days"})
            log("surgical packages")
    return ids


# ====================================================================== demo activity

async def seed_demo(ids: dict, n_patients: int = 1500) -> None:
    from app.engines.billing import post_charge

    pids: list[str] = []
    async with system_ctx() as ctx:
        for _ in range(n_patients):
            f, last, g = person()
            city, state, pin = rnd.choice(CITIES)
            dob = today() - timedelta(days=rnd.randint(1, 85) * 365 + rnd.randint(0, 364))
            p = await create(ctx, "registration.patients", {
                "salutation": "Mr." if g == "Male" and dob.year < today().year - 18 else "Ms." if g == "Female" else "Master",
                "first_name": f, "last_name": last, "gender": g, "dob": dob.isoformat(), "phone": phone(), "city": city, "state": state, "pincode": pin,
                "address": f"{rnd.randint(1, 99)}-{rnd.randint(1, 40)}, {rnd.choice(['Brodipet', 'Arundelpet', 'Lakshmipuram', 'Kothapet', 'Pattabhipuram'])}",
                "blood_group": rnd.choice(["A+", "B+", "O+", "AB+", "O-", "A-", "B-"]), "category": rnd.choice(["General"] * 8 + ["Senior Citizen", "Staff"]),
                "payer_type": rnd.choice(["Cash"] * 6 + ["Insurance"] * 3 + ["Government Scheme"]), "nationality": "Indian",
                "id_type": "Aadhaar", "id_number": f"{rnd.randint(1000, 9999)}{rnd.randint(1000, 9999)}{rnd.randint(1000, 9999)}",
                "allergies": rnd.choice([[]] * 8 + [["Penicillin"], ["Sulfa drugs"], ["Peanuts"]]), "status": "Active",
            })
            pids.append(p["id"])
            back = rnd.choice([0, 0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90])
            await backdate(ctx, "patients", p["id"], at(today() - timedelta(days=back), rnd.randint(8, 19), rnd.randint(0, 59)))
    log(f"{len(pids)} patients")

    opd_doctors = [(d, doc) for d in OPD_DEPTS for doc in ids["doctors"].get(d, [])]
    lab_codes = [c for c, *_ in LAB_TESTS]
    rad_codes = [c for c, *_ in RAD_STUDIES]
    days = 14

    # ---- OPD history + today
    for back in range(days, -1, -1):
        d = today() - timedelta(days=back)
        if d.weekday() == 6:
            continue
        async with system_ctx() as ctx:
            n = rnd.randint(110, 160) if back else 120
            for i in range(n):
                dept, doc = rnd.choice(opd_doctors)
                pid = rnd.choice(pids)
                slot_min = 9 * 60 + rnd.randint(0, 15) * 15
                slot = f"{slot_min // 60:02d}:{slot_min % 60:02d}"
                if back:
                    status = rnd.choice(["Completed"] * 9 + ["No-show", "Cancelled"])
                else:
                    status = "Completed" if slot_min < 10 * 60 + 30 else rnd.choice(["Checked-in", "Booked", "Booked", "In Consultation"])
                a = await create(ctx, "appointments.appointments", {
                    "patient_id": pid, "doctor_id": doc, "department_id": ids["dept"][dept], "appt_date": d.isoformat(), "slot": slot,
                    "type": rnd.choice(["New", "New", "Follow-up", "Review with reports"]), "booking_source": rnd.choice(["Walk-in", "Phone", "Online", "Patient Portal"]),
                    "token_no": i + 1, "status": status, "cancel_reason": "Patient request" if status == "Cancelled" else None,
                })
                await backdate(ctx, "appointments", a["id"], at(d, slot_min // 60, slot_min % 60))
                if status in ("Completed", "In Consultation", "Checked-in"):
                    ch = await post_charge(ctx, patient_id=pid, service_code="CONS-OPD", rate=rnd.choice([500, 600, 800, 1000]),
                                           description="OPD consultation", source="appointments.appointments", source_id=a["id"])
                    await backdate(ctx, "charges", ch["id"], at(d, slot_min // 60, slot_min % 60))
                    if rnd.random() < 0.35 and status == "Completed":
                        for code in rnd.sample(lab_codes[:16], rnd.randint(1, 3)):
                            await demo_order(ctx, ids, pid, None, "LAB", code, d, slot_min, verified=bool(back) or rnd.random() < 0.4)
                    if rnd.random() < 0.12 and status == "Completed":
                        await demo_order(ctx, ids, pid, None, "RAD", rnd.choice(rad_codes), d, slot_min, verified=bool(back) or rnd.random() < 0.3)
                    if status == "Completed":
                        await demo_bill(ctx, pid, None, "OP", d, slot_min + 20)
        log(f"OPD {d.isoformat()}: {n} appointments")

    # ---- inpatients: currently admitted (~65% occupancy) + discharged history
    ip_beds = [b for b in ids["beds"] if b["category"] not in ("ER", "Day Care")]
    rnd.shuffle(ip_beds)
    target = int(len(ip_beds) * 0.66)
    inpatients = rnd.sample(pids, min(target, len(pids)))
    target = len(inpatients)
    async with system_ctx() as ctx:
        for b, pid in zip(ip_beds[:target], inpatients, strict=True):
            docs = ids["doctors"].get(b["dept"]) or ids["doctors"]["GMED"]
            days_in = rnd.randint(0, 9)
            start = today() - timedelta(days=days_in)
            enc = await create(ctx, "ipd.admissions", {
                "patient_id": pid, "doctor_id": rnd.choice(docs), "department_id": ids["dept"][b["dept"]], "bed_id": b["id"],
                "admission_type": rnd.choice(["Elective", "Emergency", "Emergency"]), "admission_source": rnd.choice(["OPD", "ER"]),
                "diagnosis": rnd.choice(["Community acquired pneumonia", "Acute gastroenteritis", "Type 2 DM with cellulitis", "Dengue fever",
                                         "Acute coronary syndrome", "Fracture neck of femur", "Acute appendicitis", "COPD exacerbation",
                                         "CKD stage 5 on HD", "Cerebrovascular accident", "Urinary tract infection", "Post-partum care"]),
                "payer": rnd.choice(["Cash", "Insurance", "Insurance", "Government Scheme"]), "expected_los": rnd.randint(2, 8),
                "started_at": at(start, rnd.randint(8, 22), rnd.choice([0, 15, 30, 45])),
                "status": "Admitted",
                "attendant_name": f"{rnd.choice(FIRST_M + FIRST_F)} {rnd.choice(LAST)}", "attendant_phone": phone(),
            })
            await update(ctx, "ipd.beds", b["id"], {"status": "Occupied", "current_patient": pid, "current_encounter": enc["id"],
                                                    "status_since": enc["started_at"]})
            if days_in >= 4 and rnd.random() < 0.12:
                # through the real workflow so the ADT engine opens the discharge checklist
                await transition(ctx, "ipd.admissions", enc["id"], "Discharge Initiated", values={"discharge_type": "Routine"})
            await backdate(ctx, "encounters", enc["id"], enc["started_at"])
            for k in range(days_in + 1):
                dd = start + timedelta(days=k)
                c1 = await post_charge(ctx, patient_id=pid, encounter_id=enc["id"], rate=b["rate"], description=f"Room rent — {b['category']} ({dd})",
                                       source=f"ipd.daily:{dd}")
                await backdate(ctx, "charges", c1["id"], at(dd, 23, 0))
            if rnd.random() < 0.7:
                for code in rnd.sample(lab_codes, rnd.randint(1, 4)):
                    await demo_order(ctx, ids, pid, enc["id"], "LAB", code, start, 10 * 60, verified=rnd.random() < 0.75)
            if rnd.random() < 0.5:
                pay = await create(ctx, "billing.payments", {"patient_id": pid, "kind": "DEPOSIT", "mode": rnd.choice(["CASH", "UPI", "CARD"]),
                                                             "amount": rnd.choice([10000, 20000, 25000, 50000]), "paid_at": enc["started_at"],
                                                             "reference": f"TXN{rnd.randint(100000, 999999)}", "status": "Success"})
                await backdate(ctx, "payments", pay["id"], enc["started_at"])
    log(f"{target} inpatients admitted")

    async with system_ctx() as ctx:
        free = ip_beds[target:]
        for back in range(days, 0, -1):
            d = today() - timedelta(days=back)
            for _ in range(rnd.randint(12, 22)):
                b = rnd.choice(free)
                pid = rnd.choice(pids)
                los = rnd.randint(1, 6)
                st = d - timedelta(days=los)
                enc = await create(ctx, "ipd.encounters", {
                    "patient_id": pid, "type": "IPD", "doctor_id": rnd.choice(ids["doctors"]["GMED"]), "department_id": ids["dept"][b["dept"]],
                    "bed_id": b["id"], "started_at": at(st, 11), "ended_at": at(d, 13, 30), "status": "Discharged",
                    "diagnosis": "Recovered", "payer": "Cash",
                })
                await backdate(ctx, "encounters", enc["id"], at(st, 11))
                for k in range(los):
                    c = await post_charge(ctx, patient_id=pid, encounter_id=enc["id"], rate=b["rate"], description=f"Room rent — {b['category']}",
                                          source=f"ipd.daily:{st + timedelta(days=k)}")
                    await backdate(ctx, "charges", c["id"], at(st + timedelta(days=k), 23))
                await demo_bill(ctx, pid, enc["id"], "IP", d, 12 * 60)
    log("discharge history")

    # ---- ER today and this week
    er_beds = [b for b in ids["beds"] if b["category"] == "ER"]
    async with system_ctx() as ctx:
        if has("er.visits"):
            for back in range(6, -1, -1):
                d = today() - timedelta(days=back)
                for _ in range(rnd.randint(18, 30) if back else 14):
                    pid = rnd.choice(pids)
                    h = rnd.randint(0, 23) if back else rnd.randint(0, max(0, datetime.now().hour))
                    arrival = at(d, h, rnd.randint(0, 59))
                    seen = (datetime.fromisoformat(arrival) + timedelta(minutes=rnd.randint(3, 35))).isoformat()
                    st = "Disposed" if back else rnd.choice(["Waiting", "In Treatment", "In Treatment", "Observation", "Disposed"])
                    v = await create(ctx, "er.visits", {
                        "patient_id": pid, "arrival_mode": rnd.choice(["Walk-in", "Ambulance (108)", "Private Ambulance", "Referred"]),
                        "triage_level": rnd.choice(["Red (Immediate)", "Orange (Very urgent)", "Yellow (Urgent)", "Yellow (Urgent)", "Green (Standard)", "Green (Standard)"]),
                        "chief_complaint": rnd.choice(["Chest pain", "Breathlessness", "Road traffic accident", "Fever with rigors", "Abdominal pain", "Seizure", "Fall from height", "Snake bite"]),
                        "doctor_id": rnd.choice(ids["doctors"].get("EMED") or ids["doctors"]["GMED"]), "department_id": ids["dept"]["EMED"],
                        "started_at": arrival, "doctor_seen_at": seen if st != "Waiting" else None, "status": st,
                        "mlc": rnd.random() < 0.08, "disposition": rnd.choice(["Admitted", "Discharged", "Discharged", "Referred"]) if st == "Disposed" else None,
                    })
                    await backdate(ctx, "encounters", v["id"], arrival)
            log("ER visits")
    _ = er_beds


async def demo_order(ctx, ids, pid, enc_id, cat, code, d: date, minute: int, verified: bool) -> None:
    from app.seed.masters import LAB_TESTS

    sid = ids["services"][code]
    fqn = "orders.orders"
    ordered = at(d, min(23, minute // 60), minute % 60)
    o = await create(ctx, fqn, {"patient_id": pid, "encounter_id": enc_id, "category": cat, "service_id": sid,
                                "priority": rnd.choice(["Routine"] * 5 + ["Urgent", "STAT"]), "ordered_at": ordered, "status": "Ordered"})

    # the order's charge was captured automatically (entity charge rule) — just backdate it
    chg = ENTITY_TABLES["charges"]
    await ctx.conn.execute(chg.update().where(chg.c.source_id == o["id"]).values(
        created_at=datetime.fromisoformat(ordered), charged_at=datetime.fromisoformat(ordered)))
    await backdate(ctx, "orders", o["id"], ordered)
    if not verified:
        if rnd.random() < 0.5:
            await ctx.conn.execute(ENTITY_TABLES["orders"].update().where(ENTITY_TABLES["orders"].c.id == o["id"]).values(
                status=rnd.choice(["Collected", "In Progress"]), collected_at=datetime.fromisoformat(ordered) + timedelta(minutes=20)))
        return
    t0 = datetime.fromisoformat(ordered)
    values, critical = [], False
    if cat == "LAB":
        test = next(t for t in LAB_TESTS if t[0] == code)
        for name, unit, lo, hi, clo, chi in test[5]:
            if lo is None or hi is None:
                values.append({"parameter": name, "value": rnd.choice(["Negative", "Not detected", "Non-reactive"]), "unit": unit, "flag": "Normal"})
                continue
            span = hi - lo
            v = round(rnd.uniform(lo - span * 0.3, hi + span * 0.4), 1)
            flag = "Normal" if lo <= v <= hi else ("High" if v > hi else "Low")
            if (chi is not None and v >= chi) or (clo is not None and v <= clo) or rnd.random() < 0.01:
                flag, critical = ("Critical High" if v > hi else "Critical Low"), True
            values.append({"parameter": name, "value": str(v), "unit": unit, "ref_range": f"{lo}–{hi}", "flag": flag})
        tat = rnd.randint(40, 300)
        result = None
    else:
        result = "FINDINGS: No acute abnormality detected.\nIMPRESSION: Study within normal limits."
        tat = rnd.randint(60, 600)
    o2 = await fetch(ctx, E(fqn), o["id"])
    o2.update(status="Verified", collected_at=(t0 + timedelta(minutes=15)).isoformat(), resulted_at=(t0 + timedelta(minutes=tat)).isoformat(),
              verified_at=(t0 + timedelta(minutes=tat + 15)).isoformat(), result_values=values, result=result, critical=critical)
    from app.core.records import _write

    await _write(ctx, E(fqn), o2)


async def demo_bill(ctx, pid, enc_id, typ, d: date, minute: int) -> None:
    ch = ENTITY_TABLES["charges"]
    conds = [ch.c.patient_id == pid, ch.c.status == "Unbilled"]
    if enc_id:
        conds.append(ch.c.encounter_id == enc_id)
    else:
        conds.append(ch.c.encounter_id.is_(None))
    rows = (await ctx.conn.execute(sa.select(ch.c.id, ch.c.amount).where(*conds))).all()
    if not rows:
        return
    gross = round(sum(float(r.amount or 0) for r in rows), 2)
    disc = round(gross * 0.05, 2) if rnd.random() < 0.1 else 0
    net = round(gross - disc, 2)
    ts = at(d, min(23, minute // 60), minute % 60)
    inv = await create(ctx, "billing.invoices", {"patient_id": pid, "encounter_id": enc_id, "type": typ, "payer": "Self", "gross": gross, "discount": disc,
                                                  "tax": 0, "net": net, "paid": net, "balance": 0, "billed_at": ts, "status": "Paid",
                                                  "discount_reason": "Senior citizen" if disc else None})
    await ctx.conn.execute(ch.update().where(ch.c.id.in_([r.id for r in rows])).values(status="Billed", invoice_id=inv["id"]))
    await backdate(ctx, "invoices", inv["id"], ts)
    pay = await create(ctx, "billing.payments", {"patient_id": pid, "invoice_id": inv["id"], "kind": "PAYMENT",
                                                  "mode": rnd.choice(["CASH", "UPI", "UPI", "CARD", "INSURANCE"]), "amount": net, "paid_at": ts,
                                                  "reference": f"TXN{rnd.randint(100000, 999999)}", "status": "Success"})
    await backdate(ctx, "payments", pay["id"], ts)


# ====================================================================== entrypoint

async def main() -> None:
    load_registry(strict=True)
    from app.main import load_engines

    load_engines()
    reset = "--reset" in sys.argv
    demo = "--no-demo" not in sys.argv
    async with engine.begin() as conn:
        if reset:
            names = ", ".join([*ENTITY_TABLES, "users", "audit_log", "sequences"])
            await conn.execute(sa.text(f"TRUNCATE {names}"))
            print("wiped all data")
        elif (await conn.execute(sa.select(sa.func.count()).select_from(users))).scalar_one():
            print("database already seeded — use --reset to start over")
            return
    t0 = time.time()
    print("seeding masters …")
    ids = await seed_masters()
    if demo:
        print("seeding demo activity …")
        await seed_demo(ids)
    async with engine.begin() as conn:
        await conn.execute(audit_log.update().values(user_name="Seed"))
    await engine.dispose()
    print(f"done in {time.time() - t0:.0f}s — sign in with the accounts listed in backend/.env.example")
    _ = (sequences, SYSTEM_USER, STORES)


if __name__ == "__main__":
    asyncio.run(main())
