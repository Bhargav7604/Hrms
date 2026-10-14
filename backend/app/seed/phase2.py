"""Phase-2 demo data: masters and activity that exercise the phase-2 engines (queue, sponsors & IP
billing, ER, lab suite, pharmacy counter, assets, OP billing, dialysis desk, clinical forms, messages,
reports). Everything goes through the engines' own functions or `_common.create` / `transition` so
hooks, numbering and audit run; timestamps that the engines stamp with "now" are moved into the past
afterwards so turnaround times look like a real day.

Every step runs in its own transaction and is skipped (with a one-line reason) when its module or
engine is not installed, so the seed never stops halfway. Set SEED_DEBUG=1 to print tracebacks."""

from __future__ import annotations

import os
import random
import time
import traceback
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from app.config import settings
from app.core.util import now, today
from app.db import system_ctx
from app.engines._common import create, find, get, has, transition, update
from app.schema import ENTITY_TABLES, employees, encounters, users

from .masters import (
    ANTIBIOTICS,
    ASSETS,
    BILLABLE_EQUIPMENT,
    DIALYSIS_MACHINES,
    DISPLAY_BOARDS,
    LAB_DELTA_PERCENT,
    LAB_DELTA_RULES,
    LAB_OUTSOURCED,
    LAB_REF_RANGES,
    LAB_REFLEX_RULES,
    LAB_SECTION_OF,
    LAB_TESTS,
    PAYERS,
    PHARMACY_CREDIT_ORGS,
    PHARMACY_MARGIN_RULES,
    QUEUE_MASTERS,
    REFERENCE_LABS,
    TAT_TARGETS,
    TEXT_TEMPLATES,
    VENDORS,
)

rnd = random.Random(20261014)
DEBUG = bool(os.environ.get("SEED_DEBUG"))
STATS: dict[str, int] = defaultdict(int)
USERS: dict[str, dict] = {}
LAB_SECTIONS = ["Haematology", "Biochemistry", "Clinical Pathology", "Microbiology", "Serology & Immunology", "Histopathology", "Molecular"]


def log(msg: str) -> None:
    print(f"  · {msg}", flush=True)


def _why(e: Exception) -> str:
    d = getattr(e, "detail", None)
    if isinstance(d, dict):
        return f"{d.get('message')} {d.get('details') or ''}".strip()
    return f"{type(e).__name__}: {e}"


async def step(name: str, fn, *args) -> Any:
    """Run one seeding step in isolation: a failure is reported and skipped, never fatal."""
    t0 = time.time()
    try:
        out = await fn(*args)
    except Exception as e:  # noqa: BLE001 - demo data is best effort
        log(f"{name}: skipped — {_why(e)}")
        if DEBUG:
            traceback.print_exc()
        return None
    log(f"{name}{f' — {out}' if isinstance(out, str) else ''} ({time.time() - t0:.1f}s)")
    return out


async def guard(coro, what: str = "") -> Any:
    """One optional action inside a step (e.g. one ER visit): log and carry on if it is refused."""
    try:
        return await coro
    except Exception as e:  # noqa: BLE001
        STATS["refused"] += 1
        if DEBUG:
            log(f"    {what}: {_why(e)}")
            traceback.print_exc()
        return None


def as_user(username: str) -> system_ctx:
    """Transaction acting as a demo user (role, name and employee for attribution); admin system user otherwise."""
    return system_ctx(USERS.get(username))


def tz_at(d: date, h: int, m: int = 0) -> datetime:
    return datetime(d.year, d.month, d.day, h, m, tzinfo=settings.tz)


def iso(t: datetime) -> str:
    return t.isoformat(timespec="seconds")


def clamp_past(t: datetime, margin_min: int = 1) -> datetime:
    lim = now() - timedelta(minutes=margin_min)
    return t if t <= lim else lim


async def jpatch(ctx, table: str, rid: str, data: dict | None = None, **cols: Any) -> None:
    """Merge keys into a record's JSON data and / or set physical columns — used only to move engine
    'now' stamps into the past after the engine has run its rules."""
    t = ENTITY_TABLES[table]
    vals: dict[str, Any] = dict(cols)
    if data:
        vals["data"] = t.c.data.op("||")(sa.literal({k: (iso(v) if isinstance(v, datetime) else v) for k, v in data.items()}, JSONB))
    if vals:
        await ctx.conn.execute(t.update().where(t.c.id == rid).values(**vals))


def svc(ids: dict, code: str) -> str | None:
    return ids["services"].get(code)


# ====================================================================== shared lookups

async def load_lookups(ids: dict) -> None:
    async with system_ctx() as ctx:
        for r in (await ctx.conn.execute(sa.select(users.c.id, users.c.username, users.c.name, users.c.role, users.c.employee_id))).all():
            USERS[r.username] = {"id": str(r.id), "username": r.username, "name": r.name, "role": r.role,
                                 "employee_id": str(r.employee_id) if r.employee_id else None}
        rows = (await ctx.conn.execute(sa.select(employees.c.id, employees.c.code, employees.c.name, employees.c.category,
                                                 employees.c.department_id, employees.c.data["designation"].astext))).all()
        ids["emp"] = {str(r.id): {"code": r.code, "name": r.name, "category": r.category,
                                  "dept": str(r.department_id) if r.department_id else None, "designation": r[5]} for r in rows}
        dept_code = {v: k for k, v in ids["dept"].items()}
        ids["staff_by"] = defaultdict(list)
        for eid, e in ids["emp"].items():
            ids["staff_by"][(e["category"], dept_code.get(e["dept"] or ""))].append(eid)


def staff_of(ids: dict, category: str, dept: str | None = None) -> list[str]:
    if dept:
        return ids["staff_by"].get((category, dept), [])
    return [eid for (c, _), xs in ids["staff_by"].items() if c == category for eid in xs]


# ====================================================================== masters

async def seed_phase2_masters(ids: dict, demo: bool = True) -> None:
    """Configuration masters always; the hospital-specific registers (sponsors, equipment, assets, dialysis
    machines) only with demo data."""
    await load_lookups(ids)
    await step("queue lines, extra counters and display boards", queue_masters, ids)
    await step("lab sections, analysers, reference ranges, delta / reflex rules, antibiotics, reference labs", lab_masters, ids)
    await step("pharmacy margin discount rules and credit organisations", pharmacy_masters, ids)
    await step("clinical text templates", text_templates, ids)
    await step("TAT targets (metric dictionary)", tat_targets, ids)
    if not demo:
        return
    await step("sponsors (insurer / TPA / corporate / schemes) with tariffs and co-pay", sponsor_masters, ids)
    await step("billable bedside equipment", equipment_master, ids)
    await step("asset register with AMC / CMC, PM, calibration, breakdowns and transfers", asset_masters, ids)
    await step("dialysis machines", dialysis_machines, ids)


async def queue_masters(ids: dict) -> str:
    if not has("queue.queues"):
        raise RuntimeError("queue.queues is not installed")
    n = 0
    async with system_ctx() as ctx:
        for key, name, kind, dept, cap, svc_min, open_t, close_t, kiosk, order in QUEUE_MASTERS:
            await create(ctx, "queue.queues", {
                "name": name, "queue_key": key, "kind": kind, "department": ids["dept"].get(dept) if dept else None,
                "daily_capacity": cap, "avg_service_minutes": svc_min, "open_time": open_t, "close_time": close_t, "kiosk": kiosk,
                "display_order": order, "status": "Active"})
            n += 1
        dept_names = {"CARD": "Cardiology", "ORTH": "Orthopaedics", "GMED": "General Medicine", "OBGY": "Obstetrics & Gynaecology",
                      "PAED": "Paediatrics", "NEUR": "Neurology"}
        for i, (dept, label) in enumerate(dept_names.items()):
            doc = (ids["doctors"].get(dept) or [None])[-1]
            if not doc:
                continue
            e = ids["emp"][doc]
            await create(ctx, "queue.queues", {
                "name": f"OPD Consultation — {label} ({e['name']})", "queue_key": f"DR-{e['code']}", "kind": "Consultation",
                "department": ids["dept"][dept], "doctor": doc, "daily_capacity": 40, "avg_service_minutes": 10, "open_time": "09:00",
                "close_time": "13:00", "kiosk": True, "display_order": 10 + i, "status": "Active"})
            n += 1
        ids["counters"] = defaultdict(list)
        for name, key, typ, loc, order in (("Radiology Reception", "RAD", "Radiology", "Block A, first floor", 6),
                                           ("Help Desk & Insurance", "HELP", "Help Desk", "Block A, ground floor", 7),
                                           ("Billing Counter 2", "BILL", "Billing", "Block A, ground floor", 3)):
            await create(ctx, "queue.counters", {"name": name, "queue_key": key, "counter_type": typ, "location": loc,
                                                 "display_order": order, "avg_service_minutes": 5, "status": "Open"})
        for c in await find(ctx, "queue.counters", limit=50):
            ids["counters"][(c.get("queue_key") or "").upper()].append((c["id"], c.get("name")))
        for name, code, loc, dept, qs, nxt, ticker in DISPLAY_BOARDS:
            await create(ctx, "queue.display_boards", {
                "code": code, "name": name, "location": loc, "department": ids["dept"].get(dept) if dept else None, "queues": qs,
                "next_count": nxt, "announce": True, "ticker": ticker, "status": "Active"})
    return f"{n} queue lines, {len(DISPLAY_BOARDS)} display boards"


SCHEME_PRICES = {  # service code → scheme rate (PM-JAY HBP / state scheme / CGHS style price lists)
    "PM-JAY": [("ROOM-GENERAL", 1000), ("ICU-DAILY", 3500), ("VENT-DAILY", 2500), ("DIAL-HD", 1500), ("LAB-CBC", 150), ("LAB-RFT", 300),
               ("RAD-CT-BRAIN", 1500), ("PROC-ECHO", 1200), ("CONS-IPD-VISIT", 500)],
    "Aarogyasri": [("ROOM-GENERAL", 1100), ("ICU-DAILY", 4000), ("DIAL-HD", 1600), ("LAB-CBC", 160), ("RAD-CT-BRAIN", 1600)],
    "CGHS": [("CONS-OPD", 350), ("CONS-IPD-VISIT", 450), ("ROOM-GENERAL", 1000), ("ICU-DAILY", 5400), ("LAB-CBC", 135), ("LAB-LFT", 225),
             ("LAB-RFT", 225), ("LAB-TFT", 250), ("RAD-XR-CHEST", 230), ("RAD-CT-BRAIN", 1700), ("RAD-USG-ABD", 650), ("PROC-ECG", 90),
             ("PROC-ECHO", 1500), ("DIAL-HD", 1610)],
}
SCHEME_PACKAGES = {"Normal Delivery": 9000, "LSCS": 15000, "Laparoscopic Cholecystectomy": 22800, "Total Knee Replacement (unilateral)": 80000,
                   "Coronary Angioplasty (single stent)": 65000, "Cataract (Phaco + IOL)": 10000}


async def sponsor_masters(ids: dict) -> str:
    if not has("insurance.payers"):
        raise RuntimeError("insurance.payers is not installed")
    ids["payers"] = {"Insurance": [], "Corporate": [], "Government Scheme": []}
    ids["payer_info"] = {}
    tariffs = 0
    async with system_ctx() as ctx:
        packages = {p.get("name"): p["id"] for p in await find(ctx, "billing.packages", limit=50)}
        for name, short, ptype, scheme, copay, disc, days, tariff in PAYERS:
            slug = "".join(ch for ch in short.lower() if ch.isalnum())
            suspended = short == "Godavari Infra"
            p = await create(ctx, "insurance.payers", {
                "name": name, "short_name": short, "payer_type": ptype, "scheme": scheme,
                "insurers_serviced": ["New India Assurance", "United India Insurance", "Oriental Insurance", "National Insurance"]
                if ptype == "TPA" else None,
                "contact_person": f"{rnd.choice(['Ravi', 'Sneha', 'Arun', 'Meena', 'Pradeep'])} {rnd.choice(['Kumar', 'Rao', 'Iyer', 'Shah'])}",
                "phone": f"9{rnd.randint(100000000, 999999999)}", "email": f"hospital.desk@{slug}.example.in",
                "preauth_email": f"cashless@{slug}.example.in", "integration": "NHCX API" if ptype in ("Insurer", "TPA") else "Payer portal",
                "tariff_type": {"Insurer": "Negotiated tariff", "TPA": "PPN / GIPSA package", "Corporate": "Negotiated tariff"}.get(
                    ptype, "CGHS rates" if short == "CGHS" else "Scheme package (HBP)"),
                "discount_percent": disc, "default_co_pay_percent": copay, "credit_days": days,
                "tds_percent": 0 if ptype == "Government Scheme" else 10,
                "mou_valid_till": (today() + timedelta(days=18 if short == "Paramount" else rnd.randint(90, 700))).isoformat(),
                "status": "Suspended" if suspended else "Active",
                "suspension_reason": "Outstanding dues above 90 days — empanelment on hold" if suspended else None,
            })
            kind = {"Insurer": "Insurance", "TPA": "Insurance", "Corporate": "Corporate"}.get(ptype, "Government Scheme")
            if not suspended:
                ids["payers"][kind].append(p["id"])
            ids["payer_info"][p["id"]] = {"name": name, "short": short, "type": ptype, "copay": copay}
            if tariff and has("billing.tariffs"):
                basis, pct, rules = tariff
                data: dict[str, Any] = {
                    "name": f"{short} — {'scheme rates' if ptype == 'Government Scheme' else 'negotiated tariff'} 2026-27", "payer": p["id"],
                    "basis": basis, "percent": pct, "category_rules": [{"category": c, "percent": v} for c, v in rules],
                    "co_pay_percent": copay, "valid_from": "2026-04-01", "valid_till": "2027-03-31", "status": "Active",
                    "notes": f"Agreed with {short} for FY 2026-27; review in March 2027.",
                }
                prices = SCHEME_PRICES.get(short)
                if prices:
                    data["prices"] = [{"service": svc(ids, c), "rate": r} for c, r in prices if svc(ids, c)]
                if ptype == "Government Scheme" and short != "CGHS":
                    data["package_prices"] = [{"package": packages[n], "price": v} for n, v in SCHEME_PACKAGES.items() if n in packages]
                if ptype in ("Insurer", "Corporate", "TPA"):
                    data["room_rates"] = [{"category": "General", "rate": 1400}, {"category": "Semi-Private", "rate": 2800},
                                          {"category": "Private", "rate": 4500}, {"category": "ICU", "rate": 11000}]
                t = await create(ctx, "billing.tariffs", data)
                await update(ctx, "insurance.payers", p["id"], {"tariff": t["id"]})
                tariffs += 1
    return f"{len(PAYERS)} payers, {tariffs} sponsor tariffs"


async def equipment_master(ids: dict) -> str:
    if not has("ipd.equipment"):
        raise RuntimeError("ipd.equipment is not installed")
    ids["equipment"] = defaultdict(list)
    n = 0
    async with system_ctx() as ctx:
        for name, tag, typ, rule, rate, ward, count in BILLABLE_EQUIPMENT:
            for k in range(1, count + 1):
                status = "Maintenance" if (tag == "VENT" and ward == "SICU" and k == count) else "Available"
                e = await create(ctx, "ipd.equipment", {
                    "code": f"EQP-{tag}-{ward}-{k:02d}", "name": f"{name} #{k}", "tag": f"{tag}-{ward}-{k:02d}", "equipment_type": typ,
                    "billing_rule": rule, "rate": rate, "min_units": 1, "service": svc(ids, "VENT-DAILY") if typ == "Ventilator" else None,
                    "ward": ids["ward"].get(ward), "status": status,
                    "remarks": "Preventive maintenance in progress" if status == "Maintenance" else None})
                if status == "Available":
                    ids["equipment"][ward].append(e["id"])
                n += 1
    return f"{n} machines"


async def lab_masters(ids: dict) -> str:
    if not has("lab.sections"):
        raise RuntimeError("lab suite masters are not installed")
    out = defaultdict(int)
    async with system_ctx() as ctx:
        path_docs = ids["doctors"].get("PATH") or []
        for i, name in enumerate(LAB_SECTIONS):
            await create(ctx, "lab.sections", {
                "name": name, "report_heading": f"DEPARTMENT OF {name.upper()}", "department": ids["dept"]["PATH"],
                "head": path_docs[i % len(path_docs)] if path_docs else None, "bench": f"Lab block, 1st floor, bench {i + 1}",
                "sort_order": (i + 1) * 10, "status": "Active" if name != "Molecular" else "Inactive"})
            out["sections"] += 1
        analyzers = {}
        for name, make, model, section, iface, st in (
                ("Sysmex XN-550", "Sysmex", "XN-550", "Haematology", "HL7 v2", "Online"),
                ("Beckman Coulter AU480", "Beckman Coulter", "AU480", "Biochemistry", "ASTM", "Online"),
                ("Roche cobas e 411", "Roche", "cobas e 411", "Serology & Immunology", "ASTM", "Online"),
                ("BacT/ALERT 3D", "bioMérieux", "BacT/ALERT 3D", "Microbiology", "LIS2-A2", "Online"),
                ("Radiometer ABL80 (ABG)", "Radiometer", "ABL80 FLEX", "Biochemistry", "HL7 v2", "Maintenance")):
            a = await create(ctx, "lab.analyzers", {"name": name, "make": make, "model": model, "section": section, "interface": iface,
                                                    "host": f"10.10.4.{20 + len(analyzers)}", "port": 5000 + len(analyzers),
                                                    "last_calibration": (today() - timedelta(days=rnd.randint(2, 40))).isoformat(), "status": st})
            analyzers.setdefault(section, a["id"])
        templates = {}
        for name, section, layout in (("Standard laboratory report", "All sections", "Tabular"),
                                      ("Culture & sensitivity report", "Microbiology", "Culture & sensitivity"),
                                      ("Histopathology report", "Histopathology", "Narrative")):
            t = await create(ctx, "lab.report_templates", {
                "name": name, "section": section, "layout": layout, "show_method": True, "show_previous": layout == "Tabular",
                "header_note": "NABL accredited laboratory — Certificate MC-4417", "signatory_1_name": "Dr. Gayathri Pillai",
                "signatory_1_designation": "MD Pathology, Consultant Pathologist", "signatory_2_name": "Dr. Imran Sheikh",
                "signatory_2_designation": "MD Microbiology", "status": "Active",
                "footer_text": "Results relate only to the sample tested. Please correlate clinically."})
            templates[section] = t["id"]
        refs = []
        for name, accr, contact, phone, address, pickup, tat in REFERENCE_LABS:
            r = await create(ctx, "lab.reference_labs", {"name": name, "accreditation": accr, "contact_person": contact, "phone": phone,
                                                         "email": f"accession@{name.split()[0].lower()}lab.example.in", "address": address,
                                                         "pickup_schedule": pickup, "turnaround_days": tat, "status": "Active"})
            refs.append(r["id"])
        ids["reference_labs"] = refs
        out["reference labs"] = len(refs)
        # test catalogue: section, container, delta %, analyser, outsourcing
        for code, _name, _sample, _rate, _tat, params in LAB_TESTS:
            tid = svc(ids, code)
            sec = LAB_SECTION_OF.get(code)
            if not tid or not sec:
                continue
            section, container, short = sec
            patch: dict[str, Any] = {
                "section": section, "container": container, "short_name": short, "analyzer": analyzers.get(section),
                "sample_volume": "2 mL" if container != "Sterile container" else "10 mL",
                "parameters": [{"parameter": p, "unit": u, "ref_low": lo, "ref_high": hi, "critical_low": cl, "critical_high": ch,
                                "decimals": 1 if lo is not None else None, "delta_percent": LAB_DELTA_PERCENT.get(p)}
                               for p, u, lo, hi, cl, ch in params]}
            if section == "Microbiology":
                patch["report_template"] = templates.get("Microbiology")
            if code in LAB_OUTSOURCED and refs:
                patch.update(outsourced=True, reference_lab=refs[0])
            if code in ("LAB-FBS", "LAB-LIPID"):
                patch["prep_instructions"] = "10–12 hours overnight fasting; water allowed."
            await update(ctx, "lab.tests", tid, patch)
            out["tests updated"] += 1
        for code, param, sex, a0, a1, unit, lo, hi, cl, ch in LAB_REF_RANGES:
            if svc(ids, code):
                await create(ctx, "lab.ref_ranges", {"test": svc(ids, code), "parameter": param, "sex": sex, "age_from": a0, "age_to": a1,
                                                     "age_unit": unit, "ref_low": lo, "ref_high": hi, "critical_low": cl, "critical_high": ch,
                                                     "status": "Active"})
                out["reference ranges"] += 1
        for param, code, pct, absv, window, action in LAB_DELTA_RULES:
            await create(ctx, "lab.delta_rules", {"test": svc(ids, code) if code else None, "parameter": param, "max_change_percent": pct,
                                                  "max_change_absolute": absv, "window_days": window, "action": action, "status": "Active"})
            out["delta rules"] += 1
        for name, code, param, op, value, reflex, action, comment in LAB_REFLEX_RULES:
            if svc(ids, code) and svc(ids, reflex):
                await create(ctx, "lab.reflex_rules", {"name": name, "test": svc(ids, code), "parameter": param, "operator": op, "value": value,
                                                       "reflex_test": svc(ids, reflex), "action": action, "comment": comment, "status": "Active"})
                out["reflex rules"] += 1
        for i, (name, cls, panels) in enumerate(ANTIBIOTICS):
            await create(ctx, "lab.antibiotics", {"name": name, "drug_class": cls, "panels": panels, "sort_order": (i + 1) * 10, "status": "Active"})
            out["antibiotics"] += 1
        if has("lab.qc_runs"):
            for back in range(6, -1, -1):
                for section, test, mean, sd in (("Haematology", "LAB-CBC", 13.2, 0.3), ("Biochemistry", "LAB-RFT", 1.1, 0.05),
                                                ("Biochemistry", "LAB-RBS", 102, 3)):
                    for level in ("L1", "L2"):
                        z = rnd.gauss(0, 1)
                        res = "Pass" if abs(z) < 2 else "Warning (1-2s)" if abs(z) < 3 else "Fail (Westgard)"
                        await create(ctx, "lab.qc_runs", {"analyzer": analyzers.get(section), "test": svc(ids, test), "level": level,
                                                          "run_date": (today() - timedelta(days=back)).isoformat(),
                                                          "value": round(mean * (1.6 if level == "L2" else 1) + z * sd, 2),
                                                          "target_mean": round(mean * (1.6 if level == "L2" else 1), 2), "target_sd": sd,
                                                          "result": res, "action_taken": "Re-run after recalibration" if res != "Pass" else None})
                        out["QC runs"] += 1
    return ", ".join(f"{v} {k}" for k, v in out.items())


async def pharmacy_masters(ids: dict) -> str:
    if not has("pharmacy.margin_discounts"):
        raise RuntimeError("pharmacy counter masters are not installed")
    ids["credit_orgs"] = []
    async with system_ctx() as ctx:
        for name, applies, match, lo, hi, d, mx, sale_types, prio in PHARMACY_MARGIN_RULES:
            await create(ctx, "pharmacy.margin_discounts", {
                "name": name, "applies_to": applies, "match_value": match, "margin_from": lo, "margin_to": hi,
                "default_discount_percent": d, "max_discount_percent": mx, "sale_types": sale_types or None, "priority": prio,
                "valid_from": date(today().year, 4, 1).isoformat(), "status": "Active"})
        for name, typ, limit, days, disc, copay in PHARMACY_CREDIT_ORGS:
            o = await create(ctx, "pharmacy.credit_orgs", {
                "name": name, "org_type": typ, "contact_person": rnd.choice(["Accounts desk", "HR department", "Claims desk"]),
                "phone": f"9{rnd.randint(100000000, 999999999)}", "credit_limit": limit, "credit_days": days, "discount_percent": disc,
                "copay_percent": copay, "address": "Guntur, Andhra Pradesh", "status": "Active"})
            ids["credit_orgs"].append(o["id"])
    return f"{len(PHARMACY_MARGIN_RULES)} rules, {len(PHARMACY_CREDIT_ORGS)} credit organisations"


FREQ_DAYS = {"Monthly": 30, "Quarterly": 91, "Half-yearly": 182, "Yearly": 365}


async def asset_masters(ids: dict) -> str:
    if not has("assets.assets"):
        raise RuntimeError("assets.assets is not installed")
    out = defaultdict(int)
    t0 = today()
    async with system_ctx() as ctx:
        vendors = []
        for name, typ, gstin, contact, phone, city, cats in VENDORS:
            v = await create(ctx, "procurement.vendors", {"name": name, "vendor_type": typ, "gstin": gstin, "contact_person": contact,
                                                          "phone": phone, "city": city, "state": "Telangana" if city == "Hyderabad" else "Andhra Pradesh",
                                                          "payment_terms": "30 days", "categories": cats, "rating": rnd.choice([3, 4, 4, 5]),
                                                          "status": "Active"}) if has("procurement.vendors") else None
            vendors.append(v["id"] if v else None)
        engineers = staff_of(ids, "Support", "FAC")[:6] or [None]
        assets = []
        for i, (name, cat, make, model, dept, loc, cost, crit, pm, cal, amc, vix, risk) in enumerate(ASSETS):
            bought = t0 - timedelta(days=rnd.randint(150, 2900))
            inst = bought + timedelta(days=rnd.randint(5, 30))
            # PM / calibration history: a few overdue, a few due this month, the rest in order
            scenario = ["overdue", "due_soon", "ok", "ok", "ok"][i % 5]

            def last_for(freq: str | None, scenario: str = scenario, inst: date = inst) -> str | None:
                days = FREQ_DAYS.get(freq or "")
                if not days:
                    return None
                back = {"overdue": days + rnd.randint(8, 40), "due_soon": days - rnd.randint(2, 20), "ok": rnd.randint(5, max(6, days // 2))}[scenario]
                return max(inst, t0 - timedelta(days=back)).isoformat()

            medical = risk != "Not a medical device"
            data: dict[str, Any] = {
                "name": name, "category": cat, "make": make, "model": model, "serial_no": f"{make[:3].upper()}{rnd.randint(100000, 999999)}",
                "asset_tag": f"VLK/BME/{i + 1:04d}", "department": ids["dept"][dept], "location": loc, "source": "Procurement (GRN)",
                "ownership": "Owned", "location_status": "At assigned location", "vendor": vendors[vix] if vix < len(vendors) else None,
                "purchase_date": bought.isoformat(), "installation_date": inst.isoformat(), "purchase_cost": cost,
                "salvage_value": round(cost * 0.05), "depreciation_method": "WDV" if cat in ("IT hardware", "Vehicle") else "SLM",
                "wdv_rate_percent": 40 if cat == "IT hardware" else 30 if cat == "Vehicle" else None,
                "useful_life_years": 6 if cat == "IT hardware" else 8 if cat == "Vehicle" else 13 if medical else 15,
                "criticality": crit, "risk_class": risk, "warranty_until": (inst + timedelta(days=730)).isoformat(),
                "amc_cmc_type": amc, "pm_frequency": pm, "pm_grace_days": 7, "last_pm_on": last_for(pm),
                "calibration_frequency": cal if cal != "Not applicable" else None, "last_calibrated_on": last_for(cal),
                "last_calibration_result": "Pass" if FREQ_DAYS.get(cal) else None,
                "electrical_safety_frequency": "Yearly" if medical else None, "last_electrical_safety_on": last_for("Yearly") if medical else None,
                "last_electrical_safety_result": "Pass" if medical else None, "insurance_until": (t0 + timedelta(days=rnd.randint(20, 300))).isoformat(),
                "status": "Active", "activated_at": iso(tz_at(inst, 11)),
            }
            if cat == "Imaging equipment" and "Ultrasound" not in name:
                data.update(aerb_licence_no=f"AERB/eLORA/{rnd.randint(100000, 999999)}",
                            aerb_valid_until=(t0 + timedelta(days=25 if "CT" in name else 400)).isoformat())
            a = await create(ctx, "assets.assets", data)
            assets.append((a, vix, amc, cost, scenario))
            out["assets"] += 1
        ids["assets"] = {a["name"]: a["id"] for a, *_ in assets}
        # warranty / AMC / CMC contracts (some expiring this month, one lapsed)
        for k, (a, vix, amc, cost, _sc) in enumerate(assets):
            if amc == "None" or not vendors[vix]:
                continue
            state = ["Active", "Active", "Expiring", "Active", "Expired"][k % 5]
            end = t0 + timedelta(days={"Active": rnd.randint(60, 330), "Expiring": rnd.randint(5, 28), "Expired": -rnd.randint(5, 40)}[state])
            start = end - timedelta(days=365)
            await create(ctx, "assets.contracts", {
                "asset": a["id"], "contract_type": amc, "vendor": vendors[vix], "contract_no": f"{amc}/{t0.year}/{k + 101}",
                "start_date": start.isoformat(), "end_date": end.isoformat(), "contract_value": round(cost * (0.1 if amc == "CMC" else 0.06), -2),
                "gst_percent": 18, "pm_visits_per_year": 4 if a.get("pm_frequency") == "Quarterly" else 2, "uptime_guarantee": 95 if amc == "CMC" else 90,
                "response_time_hours": 4 if "High" in (a.get("criticality") or "") else 24, "spares_covered": amc == "CMC",
                "coverage_notes": "Labour and spares included; consumables and accessories excluded." if amc == "CMC" else "Labour only; spares chargeable.",
                "status": state})
            await update(ctx, "assets.assets", a["id"], {"amc_cmc_until": end.isoformat()})
            out["contracts"] += 1
        # PM / calibration jobs: completed history, upcoming, overdue
        for k, (a, _vix, amc, _cost, scenario) in enumerate(assets):
            a = await get(ctx, "assets.assets", a["id"])
            nd = a.get("next_pm_due")
            if not nd:
                continue
            if k % 3 == 0 and a.get("last_pm_on"):
                j = await create(ctx, "assets.pm_jobs", {"asset": a["id"], "pm_type": "Preventive maintenance", "due_date": a["last_pm_on"],
                                                         "performed_by": engineers[k % len(engineers)], "status": "Scheduled",
                                                         "checklist": [{"check_point": c, "result": "OK"} for c in
                                                                       ("Visual inspection & cleaning", "Alarms tested", "Battery backup",
                                                                        "Accessories & cables", "Functional test against reference")]})
                await transition(ctx, "assets.pm_jobs", j["id"], "In Progress")
                await transition(ctx, "assets.pm_jobs", j["id"], "Completed", values={
                    "done_on": a["last_pm_on"], "result": "Pass", "electrical_safety": "Pass", "findings": "All checks within limits.",
                    "cost": 0 if amc != "None" else 2500})
                out["PM jobs"] += 1
            status = "Overdue" if scenario == "overdue" else "Scheduled"
            await create(ctx, "assets.pm_jobs", {"asset": a["id"], "pm_type": "Preventive maintenance", "due_date": nd,
                                                 "performed_by": engineers[(k + 1) % len(engineers)], "status": status})
            out["PM jobs"] += 1
            if a.get("next_calibration_due") and scenario in ("overdue", "due_soon"):
                await create(ctx, "assets.pm_jobs", {"asset": a["id"], "pm_type": "Calibration", "due_date": a["next_calibration_due"],
                                                     "vendor_engineer": "Andhra Biomed Calibration Lab",
                                                     "status": "Overdue" if a["next_calibration_due"] < t0.isoformat() else "Scheduled"})
                out["calibration jobs"] += 1
        by_name = {a["name"]: a for a, *_ in assets}
        nurses = USERS.get("nurse.priya", {}).get("employee_id")

        async def ticket(asset: str, problem: str, sev: str, back_h: int, path: list[str], **resolve: Any) -> None:
            a = by_name.get(asset)
            if not a:
                return
            rep = now() - timedelta(hours=back_h)
            t = await create(ctx, "assets.breakdowns", {"asset": a["id"], "reported_by": nurses, "reported_at": iso(rep), "problem": problem,
                                                        "severity": sev, "equipment_down": sev.startswith(("Critical", "High")),
                                                        "standby_arranged": sev.startswith("Critical"), "status": "Open"})
            for st in path:
                vals = {"assigned_to": engineers[0]} if st == "Assigned" else resolve if st == "Resolved" else {}
                if st == "Awaiting Spares":
                    vals = {"vendor_ticket_no": f"SR-{rnd.randint(100000, 999999)}"}
                await transition(ctx, "assets.breakdowns", t["id"], st, values=vals or None)
            out["breakdown tickets"] += 1

        await ticket("Ventilator — Dräger Savina 300 #1", "Flow sensor error, ventilator alarming 'Flow measurement inoperative'.",
                     "Critical (patient care affected)", 5, ["Assigned"])
        await ticket("Multipara monitor — BPL Excello", "SpO2 module not reading on any probe.", "High", 26, ["Assigned", "In Progress"])
        await ticket("Infusion pump — BD Alaris GP", "Occlusion alarm without occlusion; door latch loose.", "Medium", 50,
                     ["Assigned", "In Progress", "Awaiting Spares"])
        await ticket("Ultrasound — GE Logiq P9", "Convex probe image dropout on the left half.", "High", 96,
                     ["Assigned", "In Progress", "Resolved"], root_cause="Component failure", action_taken="Probe replaced under CMC.",
                     repair_cost=0)
        await ticket("AHU — OT complex (HEPA)", "OT 2 temperature above 24 °C, AHU tripping.", "High", 140,
                     ["Assigned", "In Progress", "Resolved", "Closed"], root_cause="Power fluctuation",
                     action_taken="Contactor and overload relay replaced; temperature stable at 21 °C.", repair_cost=6800)
        await ticket("Autoclave — CSSD horizontal 400 L", "Door gasket worn — slow vacuum leak.", "Low", 8, [])
        # one asset sent out for service, two transfers
        ecg = by_name.get("ECG machine — BPL Cardiart 9108")
        if ecg:
            await transition(ctx, "assets.assets", ecg["id"], "Out for service", values={
                "service_vendor": vendors[0], "gate_pass_no": f"GP/{t0.year}/{rnd.randint(100, 999)}",
                "expected_return_date": (t0 + timedelta(days=5)).isoformat()})
        mon = by_name.get("Multipara monitor — IntelliVue MX450 #2")
        if mon and has("assets.transfers"):
            await create(ctx, "assets.transfers", {"asset": mon["id"], "transfer_type": "Temporary", "to_department": ids["dept"]["EMED"],
                                                   "to_location": "ER resus bay 2", "reason": "ER monitor under repair — temporary cover",
                                                   "requested_by": engineers[0], "requested_on": t0.isoformat(),
                                                   "expected_return_date": (t0 + timedelta(days=7)).isoformat(), "status": "Requested"})
            out["transfers"] += 1
        pump = by_name.get("Syringe pump — B. Braun Perfusor Space")
        if pump and has("assets.transfers"):
            tr = await create(ctx, "assets.transfers", {"asset": pump["id"], "transfer_type": "Permanent", "to_department": ids["dept"]["PAED"],
                                                        "to_location": "PICU store", "reason": "PICU expansion — redeployed from MICU",
                                                        "requested_by": engineers[0], "requested_on": (t0 - timedelta(days=4)).isoformat(),
                                                        "status": "Requested"})
            for st in ("Approved", "In Transit", "Completed"):
                await transition(ctx, "assets.transfers", tr["id"], st, values={"received_by": engineers[-1]} if st == "Completed" else None)
            out["transfers"] += 1
    return ", ".join(f"{v} {k}" for k, v in out.items())


async def text_templates(ids: dict) -> str:
    if not has("emr.text_templates"):
        raise RuntimeError("emr.text_templates is not installed")
    n = 0
    for name, scope, keys, form_key, shortcut, body in TEXT_TEMPLATES:
        who = "nurse.priya" if name.startswith("Nursing") else "dr.rao"
        async with as_user(who) as ctx:
            dept = ids["dept"]["EMED"] if "ER" in name else ids["dept"]["NURS"] if who == "nurse.priya" else None
            if who == "nurse.priya" and scope == "Global":
                scope = "Department"
            await create(ctx, "emr.text_templates", {"name": name, "scope": scope, "department": dept if scope == "Department" else None,
                                                     "field_keys": keys, "form_key": form_key, "shortcut": shortcut, "body": body,
                                                     "status": "Active"})
            n += 1
    return f"{n} templates"


async def dialysis_machines(ids: dict) -> str:
    if not has("dialysis.machines"):
        raise RuntimeError("dialysis.machines is not installed")
    ids["dialysis_machines"] = {}
    async with system_ctx() as ctx:
        for name, station, make, model, seg, hdf in DIALYSIS_MACHINES:
            m = await create(ctx, "dialysis.machines", {
                "code": name, "name": name, "station": station, "make": make, "model": model, "serial_no": f"{make[:2].upper()}{rnd.randint(10000, 99999)}",
                "segregation": seg, "hdf_capable": hdf, "last_disinfection": iso(now() - timedelta(hours=rnd.randint(2, 20))),
                "disinfection_method": rnd.choice(["Heat", "Citric acid heat"]), "running_hours": rnd.randint(3000, 22000),
                "last_service_date": (today() - timedelta(days=rnd.randint(10, 80))).isoformat(),
                "next_service_due": (today() + timedelta(days=rnd.randint(5, 90))).isoformat(),
                "ro_water_test_date": (today() - timedelta(days=rnd.randint(3, 25))).isoformat(),
                "status": "Maintenance" if name == "HD-05" else "Available"})
            ids["dialysis_machines"][name] = m["id"]
    return f"{len(DIALYSIS_MACHINES)} machines"


async def tat_targets(ids: dict) -> str:
    if not has("analytics.metric_definitions"):
        raise RuntimeError("analytics.metric_definitions is not installed")
    async with system_ctx() as ctx:
        for code, name, area, unit, target, direction in TAT_TARGETS:
            await create(ctx, "analytics.metric_definitions", {
                "code": code, "name": name, "area": area, "unit": unit, "target": target, "direction": direction, "frequency": "Daily",
                "definition": f"{name}; median over the period (NABH turnaround indicator).", "status": "Active"})
    return f"{len(TAT_TARGETS)} targets"


# ====================================================================== OPD visit flow: check-in → called → seen, doctor tokens

def opd_times(d: date, slot_min: int, status: str, is_today: bool) -> dict:
    """Check-in, consultation start and finish for a visit, clamped to the past for today."""
    slot = tz_at(d, slot_min // 60, slot_min % 60)
    checked = slot - timedelta(minutes=rnd.randint(-5, 25))
    wait = max(3, int(rnd.triangular(4, 70, 16)))
    started = checked + timedelta(minutes=wait)
    done = started + timedelta(minutes=rnd.randint(6, 18))
    out: dict[str, datetime | None] = {"checked_in_at": checked, "consult_started_at": None, "completed_at": None}
    if status in ("In Consultation", "Completed"):
        out["consult_started_at"] = started
    if status == "Completed":
        out["completed_at"] = done
    if is_today:
        lim = now() - timedelta(minutes=2)
        if out["completed_at"] and out["completed_at"] > lim:
            out["completed_at"] = lim
            out["consult_started_at"] = min(out["consult_started_at"], lim - timedelta(minutes=rnd.randint(5, 12)))
        if out["consult_started_at"] and out["consult_started_at"] > lim:
            out["consult_started_at"] = lim - timedelta(minutes=rnd.randint(1, 10))
        cap = (out["consult_started_at"] or lim) - timedelta(minutes=rnd.randint(3, 25) if out["consult_started_at"] else 0)
        if out["checked_in_at"] > cap:
            out["checked_in_at"] = cap
    return out


async def opd_visit_token(ctx, ids: dict, appt: dict, times: dict, status: str, tok_id: str, priority: str) -> None:
    """Doctor-cabin token for a checked-in visit with its real issued / called / served times."""
    e = (ids.get("emp") or {}).get(appt["doctor_id"]) or {}
    if not e.get("code") or not has("queue.tokens"):
        return
    called, served = times["consult_started_at"], times["completed_at"]
    st = {"Completed": "Done", "In Consultation": "Serving", "Checked-in": "Waiting"}[status]
    data: dict[str, Any] = {
        "id": tok_id, "queue": f"DR-{e['code']}", "token_no": appt.get("token_no"), "token_date": appt["appt_date"], "patient_id": appt["patient_id"],
        "priority": priority, "appointment": appt["id"], "source": "Appointment", "status": st,
        "called_at": iso(called) if called else None, "served_at": iso(served) if served else None}
    if called:
        data.update(last_called_at=iso(called), call_count=1, counter_name=e["name"], serving_at=iso(called))
    await create(ctx, "queue.tokens", data)
    await ctx.conn.execute(ENTITY_TABLES["queue_tokens"].update().where(ENTITY_TABLES["queue_tokens"].c.id == tok_id)
                           .values(created_at=times["checked_in_at"], updated_at=served or called or times["checked_in_at"]))
    STATS["doctor tokens"] += 1


COUNTER_LOAD = {"REG": (26, (1, 35, 7), (2, 9, 4)), "BILL": (22, (1, 30, 6), (1, 8, 3)), "PHARM": (20, (1, 28, 6), (2, 10, 4)),
                "LAB": (16, (2, 40, 10), (2, 8, 4)), "RAD": (6, (5, 55, 18), (5, 20, 8)), "HELP": (5, (2, 25, 8), (4, 15, 7))}


async def counter_tokens(ctx, ids: dict, d: date, pids: list[str], is_today: bool) -> None:
    """Walk-in / kiosk tokens at the registration, billing, pharmacy, lab and radiology counters for one day."""
    if not has("queue.tokens"):
        return
    t = ENTITY_TABLES["queue_tokens"]
    ts_now = now()
    for q, (n, wait_tri, svc_tri) in COUNTER_LOAD.items():
        counters = ids.get("counters", {}).get(q) or []
        n = max(2, int(n * rnd.uniform(0.75, 1.25)))
        issued = []
        for _ in range(n):  # most walk-ins arrive in the morning rush
            mins = int(rnd.triangular(7.5 * 60, 19.5 * 60, 10 * 60))
            issued.append(tz_at(d, mins // 60, mins % 60) + timedelta(seconds=rnd.randint(0, 59)))
        issued.sort()
        live: dict[int, str] = {}
        if is_today:  # the counters are busy right now: someone at each counter and a short line waiting
            issued = [x for x in issued if x <= ts_now - timedelta(minutes=30)]
            extra = sorted(ts_now - timedelta(minutes=rnd.randint(2, 28), seconds=rnd.randint(0, 59)) for _ in range(rnd.randint(2, 5)))
            live = {len(issued) + 1: "Serving"} | {len(issued) + k: "Waiting" for k in range(2, len(extra) + 1)}
            issued += extra
        for no, at in enumerate(issued, 1):
            called = at + timedelta(minutes=max(1, int(rnd.triangular(*wait_tri))))
            served = called + timedelta(minutes=max(1, int(rnd.triangular(*svc_tri))))
            skipped = rnd.random() < 0.03 and no not in live
            status = "Skipped" if skipped else "Done"
            if no in live:
                status = live[no]
                if status == "Serving":
                    called, served = min(called, ts_now - timedelta(minutes=1)), None
                else:
                    called = served = None
            elif is_today:
                if called > ts_now:
                    status, called, served = "Waiting", None, None
                elif served > ts_now:
                    status, served = rnd.choice(["Called", "Serving"]), None
            if skipped:
                served = None
            r = rnd.random()
            prio = "Senior Citizen" if r < 0.15 else "Differently Abled" if r < 0.17 else "Emergency" if r < 0.18 else "Normal"
            cid, cname = rnd.choice(counters) if counters else (None, None)
            data: dict[str, Any] = {
                "queue": q, "token_no": no, "token_date": d.isoformat(), "patient_id": None if (q == "REG" and rnd.random() < 0.35) else rnd.choice(pids),
                "priority": prio, "source": rnd.choice(["Walk-in", "Walk-in", "Kiosk", "Registration"]) if q != "REG" else rnd.choice(["Walk-in", "Kiosk"]),
                "status": status, "called_at": iso(called) if called else None, "served_at": iso(served) if served else None}
            if called:
                data.update(counter=cid, counter_name=cname, last_called_at=iso(called), call_count=1 + (rnd.random() < 0.08))
            if status == "Serving":
                data["serving_at"] = iso(called + timedelta(minutes=1))
            if skipped:
                data["skipped_at"] = iso(called + timedelta(minutes=3))
            tok = await create(ctx, "queue.tokens", data)
            await ctx.conn.execute(t.update().where(t.c.id == tok["id"]).values(created_at=at, updated_at=served or called or at))
            STATS["counter tokens"] += 1


# ====================================================================== activity

async def seed_phase2_activity(ids: dict, pids: list[str]) -> None:
    busy = set(ids.get("inpatient_pids") or [])
    pool = [p for p in pids if p not in busy]
    rnd.shuffle(pool)
    ids["free_pool"] = pool
    await step("pre-authorisations for sponsored admissions", preauths, ids)
    await step("bedside equipment connected to ICU patients", equipment_usage, ids)
    await step("signed nursing risk forms (Morse, Braden, MEWS)", clinical_forms, ids)
    await step("ER visits through the ER engine", er_today, ids)
    await step("OP counter bills", op_counter_bills, ids)
    await step("dialysis prescriptions, sessions and today's desk", dialysis, ids)
    await step("OP pharmacy counter shift and bills", pharmacy_counter, ids)
    await step("lab send-outs to the reference lab", lab_send_outs, ids)
    await step("IP working bills", ip_working_bills, ids)
    await step("internal messages, pre-registrations and family links", front_office_extras, ids)
    await step("saved report views and schedules", saved_reports, ids)


def take(ids: dict, n: int) -> list[str]:
    pool = ids["free_pool"]
    out, ids["free_pool"] = pool[:n], pool[n:]
    return out


async def preauths(ids: dict) -> str:
    if not has("insurance.preauths"):
        raise RuntimeError("insurance.preauths is not installed")
    n = 0
    async with system_ctx() as ctx:
        for a in ids.get("admissions", []):
            if not a.get("sponsor") or ids["payer_info"].get(a["sponsor"], {}).get("type") == "Corporate" or rnd.random() > 0.55:
                continue
            st = rnd.choice(["Approved"] * 6 + ["Submitted", "Query", "Enhancement Requested"])
            req = rnd.choice([60000, 85000, 120000, 150000, 200000, 250000])
            approved = round(req * rnd.uniform(0.7, 1.0), -3) if st in ("Approved", "Enhancement Requested") else None
            started = datetime.fromisoformat(a["started_at"])
            await create(ctx, "insurance.preauths", {
                "patient_id": a["patient_id"], "encounter_id": a["id"], "payer": a["sponsor"], "policy_no": f"POL{rnd.randint(10**9, 10**10 - 1)}",
                "admission": a["id"], "treating_doctor": a["doctor_id"], "diagnosis": a["diagnosis"], "expected_admission": started.date().isoformat(),
                "expected_los": a["expected_los"], "room_category": {"Private": "Private", "Semi-Private": "Semi-Private", "Deluxe": "Deluxe"}.get(
                    a["category"], "ICU" if a["category"] in ("ICU", "NICU", "PICU") else "HDU" if a["category"] == "HDU" else "General"),
                "requested_amount": req, "approved_amount": approved, "payer_ref": f"CL{rnd.randint(1000000, 9999999)}" if approved else None,
                "channel": rnd.choice(["NHCX API", "TPA API", "Payer portal"]), "submitted_at": iso(started + timedelta(hours=2)),
                "approved_at": iso(started + timedelta(hours=rnd.randint(4, 20))) if approved else None,
                "query_details": "Please share the indoor case papers and investigation reports." if st == "Query" else None,
                "enhancement_amount": 50000 if st == "Enhancement Requested" else None,
                "enhancement_reason": "Extended ICU stay" if st == "Enhancement Requested" else None, "status": st})
            n += 1
    return f"{n} pre-auths"


async def equipment_usage(ids: dict) -> str:
    from app.engines.ipchart import ConnectIn, DisconnectIn, connect_equipment, disconnect_equipment

    units = ids.get("equipment") or {}
    icu = [a for a in ids.get("admissions", []) if a["ward"] in units and a["status"] == "Admitted"]
    rnd.shuffle(icu)
    connected = disconnected = 0
    async with as_user("nurse.priya") as ctx:
        for a in icu:
            free = units.get(a["ward"]) or []
            if not free:
                continue
            eq = free.pop(0)
            start = datetime.fromisoformat(a["started_at"])
            at = clamp_past(start + timedelta(minutes=rnd.randint(20, 240)), 30)
            res = await guard(connect_equipment(a["id"], ConnectIn(equipment_id=eq, connected_at=iso(at), remarks="Connected on admission"), ctx),
                              "connect equipment")
            if not res:
                continue
            connected += 1
            if rnd.random() < 0.3 and (now() - at) > timedelta(hours=8):
                end = at + (now() - at) * rnd.uniform(0.4, 0.9)
                if await guard(disconnect_equipment(res["id"], DisconnectIn(disconnected_at=iso(end), remarks="Weaned off"), ctx), "disconnect"):
                    disconnected += 1
                    free.append(eq)
    return f"{connected} connected, {disconnected} disconnected and billed"


def _morse(high: bool) -> dict:
    return {"history_of_falling": "Yes" if high else rnd.choice(["No", "No", "Yes"]), "secondary_diagnosis": rnd.choice(["Yes", "No"]),
            "ambulatory_aid": rnd.choice(["Crutches / cane / walker", "Clutches furniture for support"]) if high else
            rnd.choice(["None / bed rest / nurse assists", "None / bed rest / nurse assists", "Crutches / cane / walker"]),
            "iv_therapy": rnd.choice(["Yes", "Yes", "No"]), "gait": rnd.choice(["Weak", "Impaired"]) if high else
            rnd.choice(["Normal / bed rest / wheelchair", "Weak"]),
            "mental_status": "Overestimates / forgets limitations" if high and rnd.random() < 0.5 else "Oriented to own ability",
            "precautions": ["Yellow fall-risk wristband", "Bed at lowest position, brakes on", "Call bell within reach"] if high else
            ["Call bell within reach", "Non-slip footwear"]}


def _braden(risk: bool) -> dict:
    lo = (1, 2) if risk else (3, 4)
    return {"sensory": ["Completely limited", "Very limited", "Slightly limited", "No impairment"][rnd.randint(*lo) - 1],
            "moisture": ["Constantly moist", "Very moist", "Occasionally moist", "Rarely moist"][rnd.randint(*lo) - 1],
            "activity": ["Bedfast", "Chairfast", "Walks occasionally", "Walks frequently"][rnd.randint(*lo) - 1],
            "mobility": ["Completely immobile", "Very limited", "Slightly limited", "No limitation"][rnd.randint(*lo) - 1],
            "nutrition": ["Very poor", "Probably inadequate", "Adequate", "Excellent"][rnd.randint(*lo) - 1],
            "friction": ["Problem", "Potential problem", "No apparent problem"][min(2, rnd.randint(*lo) - 1)],
            "skin_intact": "Yes", "prevention": ["2-hourly repositioning", "Air / alternating-pressure mattress"] if risk else []}


def _mews(sick: bool) -> dict:
    return {"sbp": rnd.randint(78, 96) if sick else rnd.randint(108, 150), "heart_rate": rnd.randint(112, 138) if sick else rnd.randint(64, 98),
            "resp_rate": rnd.randint(22, 32) if sick else rnd.randint(14, 20), "temperature": round(rnd.uniform(100.8, 102.6) if sick else rnd.uniform(97.4, 99.4), 1),
            "avpu": rnd.choice(["Alert", "Reacts to voice"]) if sick else "Alert", "spo2": rnd.randint(88, 93) if sick else rnd.randint(95, 99),
            "response": ["Nurse in-charge informed", "Duty doctor informed"] if sick else []}


async def clinical_forms(ids: dict) -> str:
    from app.engines.forms import EntryIn, create_entry

    adms = [a for a in ids.get("admissions", []) if a["status"] == "Admitted"]
    rnd.shuffle(adms)
    signed = 0
    async with as_user("nurse.priya") as ctx:
        for i, a in enumerate(adms[:45]):
            started = datetime.fromisoformat(a["started_at"])
            sick = a["category"] in ("ICU", "HDU") or i % 9 == 0
            for key, answers in (("nursing.morse", _morse(i % 4 == 0)), ("nursing.braden", _braden(sick)), ("nursing.mews", _mews(sick and i % 3 == 0))):
                noted = clamp_past(max(started + timedelta(hours=1), now() - timedelta(hours=rnd.randint(1, 20))), 10)
                answers["noted_at"] = iso(noted)
                if await guard(create_entry(EntryIn(form_key=key, patient_id=a["patient_id"], encounter_id=a["id"], answers=answers, sign=True), ctx),
                               f"form {key}"):
                    signed += 1
    return f"{signed} signed forms"


# ---------------------------------------------------------------------- ER

ER_CASES = [
    # triage, complaint, arrival, disposition / end state, extra
    ("Red (Immediate)", "Chest pain radiating to the left arm with sweating", "Ambulance (108)", "Admitted",
     {"ward": "CCU", "dept": "CARD", "dx": "Acute inferior wall STEMI", "vitals": (118, 92, 94, 26, 15)}),
    ("Orange (Very urgent)", "Breathlessness — known COPD, worse since last night", "Walk-in", "Admitted",
     {"ward": "MICU", "dept": "PULM", "dx": "Acute exacerbation of COPD with type 2 respiratory failure", "vitals": (112, 150, 86, 30, 15)}),
    ("Yellow (Urgent)", "Road traffic accident — swelling and pain over the right forearm", "Police", "Discharged",
     {"mlc": "Road traffic accident", "dx": "Undisplaced fracture distal radius (right)", "vitals": (96, 128, 98, 18, 15), "bill": True}),
    ("Green (Standard)", "Fever with body aches for three days", "Walk-in", "Discharged",
     {"dx": "Acute febrile illness — dengue NS1 awaited", "vitals": (102, 118, 98, 18, 15), "bill": True, "labs": ["LAB-CBC", "LAB-DENGUE"]}),
    ("Yellow (Urgent)", "Acute abdominal pain in the right iliac fossa", "Private Ambulance", "Referred",
     {"dx": "Acute appendicitis", "vitals": (104, 124, 97, 20, 15), "labs": ["LAB-CBC", "LAB-CRP"],
      "referred_to": "District Hospital, Narasaraopet (surgeon on leave)", "reason": "Patient's request — near home, scheme coverage"}),
    ("Green (Standard)", "Dog bite on the left leg", "Walk-in", "Discharged",
     {"mlc": "Dog bite", "dx": "Category III dog bite — wound care and ARV started", "vitals": (88, 122, 99, 16, 15), "bill": True}),
    ("Orange (Very urgent)", "Seizure — known epileptic, missed doses for two days", "Ambulance (108)", "Observation",
     {"dx": "Breakthrough seizure — drug non-compliance", "vitals": (110, 136, 96, 20, 13), "labs": ["LAB-ELEC", "LAB-RBS"]}),
    ("Yellow (Urgent)", "Vomiting and loose stools since morning", "Walk-in", "Observation→Discharged",
     {"dx": "Acute gastroenteritis with moderate dehydration", "vitals": (114, 98, 98, 22, 15), "bill": False}),
    ("Red (Immediate)", "Unresponsive, found on the roadside", "Ambulance (108)", "In Treatment",
     {"unidentified": True, "dx": "Altered sensorium — ? hypoglycaemia / head injury", "vitals": (54, 90, 91, 10, 7)}),
    ("Green (Standard)", "Minor laceration over the forehead after a fall at home", "Walk-in", "Waiting", {"vitals": (84, 130, 99, 16, 15)}),
    ("Yellow (Urgent)", "Snake bite on the right foot while working in the field", "Referred", "In Treatment",
     {"mlc": "Snake bite", "dx": "Viper bite — local envenomation, 20WBCT pending", "vitals": (106, 140, 97, 20, 15), "labs": ["LAB-PT", "LAB-CBC"]}),
    ("Orange (Very urgent)", "High fever with altered sensorium", "Walk-in", "LAMA",
     {"dx": "? Meningoencephalitis", "vitals": (124, 104, 95, 24, 12)}),
    ("Yellow (Urgent)", "Palpitations and giddiness", "Walk-in", "Waiting", {"vitals": (148, 112, 97, 20, 15), "untriaged": True}),
]


async def er_today(ids: dict) -> str:
    if not has("er.visits"):
        raise RuntimeError("er.visits is not installed")
    from app.engines import er as ER
    from app.engines.billing import PaymentIn, collect

    er_beds = [b["id"] for b in ids["beds"] if b["category"] == "ER"]
    emed = ids["doctors"].get("EMED") or ids["doctors"]["GMED"]
    ts = now()
    since_midnight = int((ts - tz_at(today(), 0)).total_seconds() // 60)
    span = max(40, min(600, since_midnight - 10))
    pts = take(ids, len(ER_CASES))
    occupied: set[str] = set()
    async with system_ctx() as ctx:
        occupied = {str(r.id) for r in (await ctx.conn.execute(sa.select(ENTITY_TABLES["beds"].c.id).where(
            ENTITY_TABLES["beds"].c.status != "Vacant"))).all()}
    ward_beds = defaultdict(list)
    for b in ids["beds"]:
        if b["id"] not in occupied and b["category"] not in ("ER", "Day Care"):
            ward_beds[b["ward"]].append(b)
    counts = defaultdict(int)
    for i, ((level, complaint, arrival_mode, end, x), pid) in enumerate(zip(ER_CASES, pts, strict=False)):
        done = end not in ("Waiting", "In Treatment", "Observation")
        ago = rnd.randint(max(30, span // 3), span) if done else rnd.randint(6, 35) if end == "Waiting" else rnd.randint(25, max(30, span // 3))
        arrival = ts - timedelta(minutes=ago)
        bed = er_beds[i] if i < len(er_beds) else None
        async with as_user("frontdesk") as ctx:
            body = ER.RegisterIn(mode="unidentified" if x.get("unidentified") else "existing", patient_id=None if x.get("unidentified") else pid,
                                 unknown=ER.UnknownIn(gender="Male", approx_age=45, identification_marks="Tattoo 'OM' on the right forearm",
                                                      found_at="NH-16 service road near Chilakaluripet") if x.get("unidentified") else None,
                                 arrival_mode=arrival_mode, arrived_at=iso(arrival), chief_complaint=complaint,
                                 brought_by_type={"Police": "Police", "Ambulance (108)": "108 ambulance"}.get(arrival_mode, "Relatives"),
                                 brought_by="Constable B. Srinu" if arrival_mode == "Police" else None,
                                 police_station="Arundelpet PS" if arrival_mode == "Police" else None,
                                 payer=rnd.choice(["Self-pay", "Self-pay", "Insurance", "Government scheme"]), bed_id=bed, auto_assign=True,
                                 mlc=bool(x.get("mlc")), mlc_no=f"MLC/{today().year}/{rnd.randint(1000, 9999)}" if x.get("mlc") else None,
                                 mlc_case_type=x.get("mlc"))
            reg = await guard(ER.register(body, ctx), "ER register")
        if not reg:
            continue
        vid = reg["visit"]["id"]
        counts["visits"] += 1
        pulse, sbp, spo2, rr, gcs = x["vitals"]
        t_triage = arrival + timedelta(minutes=rnd.randint(2, 7))
        t_nurse = t_triage + timedelta(minutes=rnd.randint(3, 9))
        target = {"Red": 2, "Orange": 9, "Yellow": 30, "Green": 55}[level.split()[0]]
        t_doc = arrival + timedelta(minutes=max(3, int(target * rnd.uniform(0.5, 1.6))))
        if not done:
            t_doc = min(t_doc, ts - timedelta(minutes=3))
        patch: dict[str, Any] = {}
        if not x.get("untriaged"):
            async with as_user("nurse.priya") as ctx:
                await guard(ER.triage(vid, ER.TriageIn(level=level, red_flags=["Chest pain (suspected ACS)"] if "Chest" in complaint else [], pulse=pulse,
                                                       bp_systolic=sbp, spo2=spo2, resp_rate=rr, gcs=gcs, pain_score=rnd.randint(2, 8)), ctx), "triage")
                await guard(ER.nursing_assessment(vid, ER.NursingIn(
                    avpu="Alert" if gcs == 15 else "Voice" if gcs >= 12 else "Pain", airway="Patent", breathing="Laboured" if rr > 24 else "Normal",
                    circulation="Normal" if sbp > 100 else "Pale / cold peripheries", fall_risk="High" if gcs < 15 else "Low",
                    bp_systolic=sbp, bp_diastolic=int(sbp * 0.62), pulse=pulse, resp_rate=rr, temperature=round(rnd.uniform(98, 102.4), 1),
                    spo2=spo2, spo2_on="Room air" if spo2 >= 94 else "Face mask", grbs=rnd.randint(42, 60) if x.get("unidentified") else rnd.randint(90, 180),
                    gcs_e=4 if gcs == 15 else 2, gcs_v=5 if gcs == 15 else 2, gcs_m=6 if gcs == 15 else 3 if gcs < 10 else 5,
                    pain_score=rnd.randint(2, 8), medication_allergy="No", food_allergy="No", notes="Initial nursing assessment done."), ctx),
                    "nursing assessment")
            patch.update(triaged_at=t_triage, last_triaged_at=t_triage, nursing_assessed_at=t_nurse)
        if end == "Waiting":
            async with system_ctx() as ctx:
                await jpatch(ctx, "encounters", vid, patch)
            continue
        if i in (1, 6):  # re-assigned to a specialist on duty
            async with as_user("nurse.priya") as ctx:
                cur = await get(ctx, "er.visits", vid)
                other = next((d for d in emed if d != (cur or {}).get("doctor_id")), None)
                if other:
                    await guard(ER.assign_doctor(vid, ER.AssignIn(doctor_id=other, reason="Re-assigned to the senior resident on duty"), ctx),
                                "assign doctor")
        async with as_user("dr.rao") as ctx:
            await guard(ER.doctor_assessment(vid, ER.DoctorAssessmentIn(
                presenting_complaints=complaint, history=f"{complaint}. No similar episodes in the past." if not x.get("unidentified") else
                "History not available — patient brought unresponsive.", general_examination=f"Pulse {pulse}/min, BP {sbp}/{int(sbp * 0.62)} mmHg, "
                f"SpO2 {spo2}% on room air, RR {rr}/min.", cvs="S1 S2 heard", rs="Bilateral air entry present", cns=f"GCS {gcs}/15",
                abdomen="Soft" if "abdominal" not in complaint else "Tenderness in the right iliac fossa, guarding present",
                provisional_diagnosis=x.get("dx") or complaint, plan="Investigations sent; IV access; symptomatic treatment; review with reports."), ctx),
                "doctor assessment")
            for code in x.get("labs") or []:
                if svc(ids, code):
                    await guard(create(ctx, "orders.orders", {"patient_id": reg["patient"]["id"], "encounter_id": vid, "category": "LAB",
                                                              "service_id": svc(ids, code), "priority": "STAT", "ordered_at": iso(t_doc),
                                                              "status": "Ordered"}), "ER lab order")
        patch.update(doctor_assessed_at=t_doc, doctor_seen_at=t_doc, door_to_doctor_minutes=int((t_doc - arrival).total_seconds() // 60))
        async with as_user("nurse.priya") as ctx:
            await guard(ER.add_treatment(vid, ER.TreatmentIn(entry_type="Treatment given", details="IV line secured; NS 500 mL started; "
                                                             "Inj. Pantoprazole 40 mg IV given.", response="Improved"), ctx), "treatment")
            if i == 0:
                await guard(ER.add_treatment(vid, ER.TreatmentIn(entry_type="Specialist consult", details="Cardiology consult — primary PCI advised.",
                                                                 consultant=(ids["doctors"].get("CARD") or emed)[0], chargeable=True,
                                                                 response="Not applicable"), ctx), "specialist consult")
            if end.startswith("Observation"):
                await guard(ER.change_status(vid, ER.StatusIn(to="Observation"), ctx), "observation")
        if end in ("In Treatment", "Observation"):
            async with system_ctx() as ctx:
                await jpatch(ctx, "encounters", vid, patch)
            counts[end] += 1
            continue
        dispo = end.split("→")[-1]
        t_end = clamp_past(arrival + timedelta(minutes=rnd.randint(int(ago * 0.55), max(int(ago * 0.55) + 1, ago - 5))), 5)
        admit = None
        if dispo == "Admitted":
            ward = x["ward"]
            if ward_beds.get(ward):
                b = ward_beds[ward].pop(0)
                admit = ER.AdmitIn(bed_id=b["id"], doctor_id=(ids["doctors"].get(x["dept"]) or emed)[0], department_id=ids["dept"][x["dept"]],
                                   diagnosis=x["dx"], expected_los=rnd.randint(3, 7), attendant_name="Lakshmi (wife)", attendant_phone="9848112233")
            else:
                dispo = "Discharged"
        body = ER.DispositionIn(
            disposition=dispo, provisional_diagnosis=x.get("dx"), condition_at_disposition="Stable" if dispo != "LAMA" else "Unchanged",
            disposition_notes="Treated in ER; advised review in OPD with reports." if dispo == "Discharged" else None,
            followup_advice="Review in OPD after 3 days" if dispo == "Discharged" else None,
            referred_to=x.get("referred_to"), transfer_reason=x.get("reason"),
            lama_reason="Family wants to take the patient to a hospital in their home town" if dispo == "LAMA" else None,
            consent_by="Son (Ramesh)" if dispo == "LAMA" else None, risks_explained=True if dispo == "LAMA" else None, admit=admit)
        async with as_user("dr.rao") as ctx:
            res = await guard(ER.dispose(vid, body, ctx), f"disposition {dispo}")
        if not res:
            async with system_ctx() as ctx:
                await jpatch(ctx, "encounters", vid, patch)
            continue
        counts[dispo] += 1
        mins = int((t_end - arrival).total_seconds() // 60)
        async with system_ctx() as ctx:
            patch.update(disposed_at=t_end, er_los_minutes=mins)
            if res["visit"].get("observation_minutes") is not None:
                patch["observation_minutes"] = max(60, mins - int((t_doc - arrival).total_seconds() // 60) - 20)
            await jpatch(ctx, "encounters", vid, patch, ended_at=t_end)
            if res.get("admission"):
                await jpatch(ctx, "encounters", res["admission"]["id"], None, started_at=t_end)
                ids.setdefault("admissions", []).append({
                    "id": res["admission"]["id"], "patient_id": reg["patient"]["id"], "status": "Admitted", "ward": x["ward"], "category": "ICU",
                    "started_at": iso(t_end), "sponsor": None, "doctor_id": admit.doctor_id if admit else None, "diagnosis": x["dx"], "expected_los": 4})
        if x.get("bill"):
            async with as_user("billing") as ctx:
                inv = await guard(ER.make_bill(vid, ER.BillIn(), ctx), "ER bill")
                if inv and float(inv.get("balance") or 0) > 0:
                    await guard(collect(PaymentIn(patient_id=inv["patient_id"], invoice_id=inv["id"], mode="UPI", amount=float(inv["balance"]),
                                                  reference=f"UPI{rnd.randint(10**9, 10**10 - 1)}"), ctx), "ER payment")
                if inv:
                    counts["billed"] += 1
                    if await guard(ER.close_visit(vid, ER.CloseIn(note="Bill settled at the ER counter"), ctx), "ER close"):
                        counts["closed"] += 1
    return ", ".join(f"{v} {k}" for k, v in counts.items())


# ---------------------------------------------------------------------- OP billing counter

async def op_bill(ctx, ids: dict, pid: str, codes: list[str], *, payer: str = "Self", sponsor: str | None = None, share: float = 100,
                  disc: float = 0, remarks: str | None = None, mode: str = "CASH", partial: bool = False) -> dict | None:
    from app.engines import opbilling as ob

    draft = await ob.new_draft(ob.NewDraftIn(patient_id=pid), ctx)
    inv = await get(ctx, "billing.invoices", draft["id"])
    lines = [ob.Line(kind="service", service_id=svc(ids, c), name=c) for c in codes if svc(ids, c)]
    state = ob.DraftState(lines=lines, payer=payer, sponsor_id=sponsor, patient_share_type="%", patient_share_value=share,
                          bill_disc_type="%", bill_disc_value=disc, discount_remarks=remarks, lead_source="Walk-in" if payer == "Self" else
                          "Corporate" if payer == "Corporate" else "Insurance / TPA")
    state = await ob._normalise_state(ctx, state, None)
    tot = ob.compute(state)
    need = float(tot["patient_payable"])
    if partial:
        need = round(need / 2, 0)
    over = tot["discount_percent"] > 10 and tot["discount"] > 0
    if need > 0 and not over:
        state.pay_lines = [ob.PayLine(mode=mode, amount=need, reference=None if mode == "CASH" else f"{mode}{rnd.randint(10**8, 10**9 - 1)}")]
    return await ob.confirm_bill(ctx, inv, state)


async def op_counter_bills(ids: dict) -> str:
    if not has("billing.invoices"):
        raise RuntimeError("billing is not installed")
    corp = (ids.get("payers") or {}).get("Corporate") or []
    ins = (ids.get("payers") or {}).get("Insurance") or []
    plans = [
        (["LAB-CBC", "LAB-LFT", "LAB-RFT"], {}),
        (["RAD-USG-ABD", "LAB-LIPID"], {"mode": "UPI"}),
        (["PROC-ECG", "PROC-ECHO", "LAB-TROP"], {"mode": "CARD"}),
        (["HC-EXEC"], {"payer": "Corporate", "sponsor": corp[0] if corp else None, "share": 0}),
        (["RAD-MRI-LS"], {"payer": "Insurance", "sponsor": ins[0] if ins else None, "share": 20, "mode": "UPI"}),
        (["LAB-TFT", "LAB-VITD", "LAB-B12"], {"disc": 10, "remarks": "Senior citizen — 10% on diagnostics"}),
        (["RAD-CT-ABD"], {"disc": 20, "remarks": "Hardship case — MSW recommendation"}),  # above policy → approval
        (["PHYSIO-SESSION", "PHYSIO-SESSION", "PHYSIO-SESSION"], {"partial": True}),
        (["DENTAL-CONSULT", "DENTAL-SCALING"], {"mode": "UPI"}),
        (["HC-BASIC"], {}),
    ]
    made = approvals = 0
    pts = take(ids, len(plans))
    async with as_user("billing") as ctx:
        for pid, (codes, kw) in zip(pts, plans, strict=False):
            if kw.get("payer") and not kw.get("sponsor"):
                kw = {k: v for k, v in kw.items() if k not in ("payer", "sponsor", "share")}
            out = await guard(op_bill(ctx, ids, pid, codes, **kw), f"OP bill {codes}")
            if out:
                made += 1
                approvals += bool(out.get("approval_required"))
    return f"{made} bills ({approvals} awaiting discount approval)"


# ---------------------------------------------------------------------- dialysis

async def dialysis(ids: dict) -> str:
    if not has("dialysis.sessions"):
        raise RuntimeError("dialysis is not installed")
    from app.engines import dialysisdesk as DD

    machines = ids.get("dialysis_machines") or {}
    neph = ids["doctors"].get("NEPH") or ids["doctors"]["GMED"]
    pts = take(ids, 6)
    viral = ["Non-reactive", "Non-reactive", "Non-reactive", "Non-reactive", "HBsAg reactive", "Anti-HCV reactive"]
    seg_machine = {"HBsAg reactive": "HD-07", "Anti-HCV reactive": "HD-08"}
    general = ["HD-01", "HD-02", "HD-03", "HD-04"]
    counts = defaultdict(int)
    plans: dict[str, dict] = {}
    async with system_ctx() as ctx:
        for k, pid in enumerate(pts):
            days = ["Mon", "Wed", "Fri"] if k % 2 == 0 else ["Tue", "Thu", "Sat"]
            access = "AV fistula" if k != 3 else "Tunnelled cuffed catheter (permcath)"
            p = await create(ctx, "dialysis.plans", {
                "patient_id": pid, "indication": "CKD 5D (maintenance)", "primary_renal_disease": rnd.choice(
                    ["Diabetic nephropathy", "Hypertensive nephrosclerosis", "CKDu", "Chronic glomerulonephritis"]),
                "modality": "HDF" if k == 2 else "HD", "frequency": "3x / week", "days": days,
                "shift": rnd.choice(["Shift 1 (6 am)", "Shift 2 (10 am)", "Shift 3 (2 pm)"]),
                "preferred_machine": machines.get(seg_machine.get(viral[k]) or general[k % 4]), "viral_status": viral[k],
                "vascular_access": access, "dry_weight_kg": round(rnd.uniform(48, 74), 1), "duration_hours": 4, "target_ktv": 1.2,
                "dialyser": rnd.choice(["F8 HPS", "FX80", "Rexeed 18"]), "dialyser_reuse_limit": 6, "blood_flow_rate": rnd.choice([300, 320, 350]),
                "dialysate_flow_rate": 500, "dialysate_k": 2, "anticoagulation": "Standard heparin",
                "esa_prescription": "Erythropoietin 4000 IU SC twice weekly; iron sucrose 100 mg IV weekly",
                "payer": rnd.choice(["Cash", "PM-NDP (National Dialysis Programme)", "State scheme (Aarogyasri etc.)", "Cash"]),
                "nephrologist": neph[k % len(neph)], "start_date": (today() - timedelta(days=rnd.randint(90, 900))).isoformat(), "status": "Active"})
            plans[pid] = {"plan": p, "viral": viral[k], "days": days, "access": access}
            await create(ctx, "dialysis.vascular_access", {
                "patient_id": pid, "access_type": access, "site": "Left radiocephalic" if access == "AV fistula" else "Right IJV",
                "created_on": (today() - timedelta(days=rnd.randint(120, 1000))).isoformat(), "surgeon": (ids["doctors"].get("GSUR") or neph)[0],
                "thrill_bruit": "Good" if access == "AV fistula" else "Not applicable", "access_flow": rnd.randint(650, 1100) if access == "AV fistula" else None,
                "complication": "None", "status": "In Use"})
            if has("dialysis.monthly_review"):
                pre, post = rnd.randint(110, 160), rnd.randint(32, 50)
                last_month = (today().replace(day=1) - timedelta(days=1))
                await create(ctx, "dialysis.monthly_review", {
                    "patient_id": pid, "month": last_month.strftime("%Y-%m"), "sample_date": last_month.replace(day=12).isoformat(),
                    "reviewed_by": neph[0], "pre_urea": pre, "post_urea": post, "urr": round((pre - post) / pre * 100, 1),
                    "ktv": round(rnd.uniform(1.1, 1.5), 2), "haemoglobin": round(rnd.uniform(8.6, 11.4), 1), "ferritin": rnd.randint(180, 620),
                    "tsat": rnd.randint(18, 34), "calcium": round(rnd.uniform(8.2, 9.6), 1), "phosphorus": round(rnd.uniform(4.2, 6.8), 1),
                    "ipth": rnd.randint(180, 620), "albumin": round(rnd.uniform(3.2, 4.1), 1), "potassium": round(rnd.uniform(4.4, 5.8), 1),
                    "viral_markers_date": (today() - timedelta(days=rnd.randint(20, 80))).isoformat(), "hep_b_vaccination": "Complete (anti-HBs ≥ 10)"})
            # past two weeks of sessions on the plan's days
            for back in range(14, 0, -1):
                d = today() - timedelta(days=back)
                if ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d.weekday()] not in days:
                    continue
                mname = seg_machine.get(viral[k]) or general[(k + back) % 4]
                start = tz_at(d, rnd.choice([6, 10, 14]), rnd.choice([0, 10, 20]))
                pre_w = round(plans[pid]["plan"]["dry_weight_kg"] + rnd.uniform(1.5, 3.4), 1)
                missed = rnd.random() < 0.06
                s = await create(ctx, "dialysis.sessions", {
                    "patient_id": pid, "plan": p["id"], "machine": None if missed else machines.get(mname), "modality": p.get("modality") or "HD",
                    "scheduled_at": iso(start - timedelta(minutes=15)), "status": "Missed" if missed else "Completed",
                    "notes": "Patient did not turn up — called, will come tomorrow" if missed else None,
                    **({} if missed else {
                        "checked_in_at": iso(start - timedelta(minutes=20)), "started_at": iso(start), "ended_at": iso(start + timedelta(minutes=240)),
                        "dialyser_use_no": rnd.randint(1, 6), "access_used": access, "heparin_units": 5000, "pre_weight": pre_w,
                        "post_weight": round(pre_w - rnd.uniform(1.6, 3.0), 1), "uf_goal_ml": 2500, "uf_achieved_ml": rnd.randint(1800, 3000),
                        "pre_bp": f"{rnd.randint(140, 170)}/{rnd.randint(80, 100)}", "post_bp": f"{rnd.randint(120, 145)}/{rnd.randint(70, 90)}",
                        "pre_pulse": rnd.randint(76, 96), "post_pulse": rnd.randint(70, 90), "blood_flow_rate": 320, "duration_minutes": 240,
                        "ktv": round(rnd.uniform(1.1, 1.55), 2), "intradialytic_events": ["Hypotension"] if rnd.random() < 0.1 else ["None"],
                        "nurse": USERS.get("nurse.priya", {}).get("employee_id"), "billing_ref": "OP bill (paid at counter)", "prebilled": True,
                        "hourly_chart": [{"time": f"{(start + timedelta(hours=h)).astimezone(settings.tz):%H:%M}",
                                          "bp": f"{rnd.randint(120, 160)}/{rnd.randint(70, 95)}", "pulse": rnd.randint(70, 96), "qb": 320,
                                          "venous_pressure": rnd.randint(120, 180), "tmp": rnd.randint(80, 160), "uf_volume": 600 * h}
                                         for h in range(1, 4)]})})
                counts["past sessions"] += 1
                _ = s
    # today: bill at the OP counter → check in → start → chart → check out
    today_pts = pts[:4]
    async with as_user("billing") as ctx:
        for pid in today_pts:
            if await guard(op_bill(ctx, ids, pid, ["DIAL-HD"], mode=rnd.choice(["CASH", "UPI"])), "dialysis bill"):
                counts["billed today"] += 1
    ts = now()
    for k, pid in enumerate(today_pts[:3]):
        info = plans[pid]
        async with as_user("nurse.priya") as ctx:
            s = await guard(DD.check_in(DD.CheckInIn(patient_id=pid, modality="HD", pre_weight=round(info["plan"]["dry_weight_kg"] + 2.4, 1),
                                                     pre_bp=f"{rnd.randint(140, 165)}/{rnd.randint(82, 98)}", pre_pulse=rnd.randint(78, 94),
                                                     pre_temperature=98.4, access_used=info["access"]), ctx), "dialysis check-in")
            if not s:
                continue
            counts["checked in"] += 1
            mname = seg_machine.get(info["viral"]) or general[k]
            m_id = machines.get(mname)
            if not m_id:
                continue
            s2 = await guard(DD.start(s["id"], DD.StartIn(machine=m_id, uf_goal_ml=2500, blood_flow_rate=320, heparin_units=5000,
                                                         dialyser_use_no=rnd.randint(1, 5)), ctx), "dialysis start")
            if not s2:
                continue
            started = ts - timedelta(minutes=250 if k == 0 else rnd.randint(60, 150))
            for h in range(1, 4):
                at = started + timedelta(hours=h)
                if at < ts:
                    await guard(DD.chart(s["id"], DD.ChartIn(time=f"{at.astimezone(settings.tz):%H:%M}", bp=f"{rnd.randint(120, 150)}/{rnd.randint(70, 90)}",
                                                             pulse=rnd.randint(72, 92), qb=320, venous_pressure=rnd.randint(120, 170),
                                                             tmp=rnd.randint(90, 150), uf_volume=600 * h), ctx), "dialysis chart")
            if k == 0:
                await guard(DD.check_out(s["id"], DD.CheckOutIn(post_weight=round(info["plan"]["dry_weight_kg"] + 0.2, 1), post_bp="132/80",
                                                                post_pulse=82, intradialytic_events=["None"], ktv=1.34), ctx), "dialysis check-out")
                counts["completed today"] += 1
            else:
                counts["running now"] += 1
        async with system_ctx() as ctx:
            patch = {"checked_in_at": started - timedelta(minutes=15), "started_at": started, "scheduled_at": started - timedelta(minutes=20)}
            if k == 0:
                patch.update(ended_at=started + timedelta(minutes=240), checked_out_at=started + timedelta(minutes=240), duration_minutes=240)
            await jpatch(ctx, "records", s["id"], patch)
    return ", ".join(f"{v} {k}" for k, v in counts.items())


# ---------------------------------------------------------------------- pharmacy counter

async def pharmacy_counter(ids: dict) -> str:
    if not has("pharmacy.counter_bills"):
        raise RuntimeError("pharmacy counter is not installed")
    from app.engines import pharmacycounter as PC

    items = ids["items"]
    baskets = [
        ([("Paracetamol 650", 15), ("Cetirizine 10", 10)], {}),
        ([("ORS Sachet", 6), ("Paracetamol 650", 10)], {"mode": "UPI"}),
        ([("Amlodipine 5", 30), ("Atorvastatin 20", 30)], {"doctor": "Dr. K. Srinivas (outside prescription)"}),
        ([("Metformin 500", 60), ("Glimepiride 2", 30)], {"doctor": "Dr. P. Anuradha (outside prescription)", "mode": "CARD"}),
        ([("Iron-Folic Acid", 30)], {}),
        ([("Pantoprazole 40", 15), ("Ondansetron 4", 6)], {"doctor": "Dr. Venkat Rao", "mode": "UPI"}),
        ([("Amoxicillin-Clavulanate 625", 10), ("Paracetamol 650", 10)], {"doctor": "Dr. Venkat Rao", "credit": 1}),
        ([("Telmisartan 40", 30), ("Aspirin 75", 30)], {"doctor": "Dr. S. Reddy (outside prescription)", "credit": 0}),
        ([("Cetirizine 10", 10), ("ORS Sachet", 4)], {}),
        ([("Paracetamol 650", 20)], {"mode": "UPI"}),
    ]
    made = 0
    async with as_user("pharmacy") as ctx:
        await PC.open_shift(PC.OpenIn(counter=PC.COUNTERS[0], opening_cash=5000), ctx)
        orgs = ids.get("credit_orgs") or []
        for lines, kw in baskets:
            ln = [PC.LineIn(item_id=items[n], qty=q) for n, q in lines if n in items]
            if not ln:
                continue
            org = orgs[kw["credit"]] if "credit" in kw and kw["credit"] < len(orgs) else None
            sale = "Credit" if org else "Prescription" if kw.get("doctor") else "Walk-in (OTC)"
            org_rec = await get(ctx, "pharmacy.credit_orgs", org) if org else None
            priced = await PC.price(ctx, ln, sale_type=sale, org=org_rec)
            if [p for p in priced["problems"] if p["blocking"]]:
                continue
            net = float(priced["totals"]["net"])
            pay = net if not org_rec else round(net * float(org_rec.get("copay_percent") or 0) / 100, 2)
            mode = kw.get("mode", "CASH")
            credit_pid = take(ids, 1)[0] if org_rec and ids.get("free_pool") else None
            body = PC.BillIn(patient_id=credit_pid, override_reason="Prescriber confirmed; patient counselled" if credit_pid else None,
                             customer_name=None if credit_pid else
                             f"{rnd.choice(['Ravi', 'Sujatha', 'Imran', 'Mary', 'Kiran', 'Lakshmi'])} {rnd.choice(['Kumar', 'Reddy', 'Rao', 'Sheikh'])}",
                             customer_phone=None if credit_pid else f"9{rnd.randint(100000000, 999999999)}", doctor_name=kw.get("doctor"), sale_type=sale,
                             credit_org=org, items=ln, counselled=True,
                             payments=[PC.PaymentIn(mode=mode, amount=pay, reference=None if mode == "CASH" else f"{mode}{rnd.randint(10**8, 10**9 - 1)}")]
                             if pay > 0 else [])
            if await guard(PC.create_bill(body, ctx), "pharmacy bill"):
                made += 1
    return f"shift open at {PC.COUNTERS[0]}, {made} bills"


# ---------------------------------------------------------------------- lab send-outs

async def lab_send_outs(ids: dict) -> str:
    if not has("lab.send_outs") or not ids.get("reference_labs"):
        raise RuntimeError("lab out-sourcing is not installed")
    from app.engines.labsuite import ReceiveReportIn, SendOutIn, SheetValue, receive_report, send_out

    pts = take(ids, 5)
    oids = []
    async with system_ctx() as ctx:
        for k, pid in enumerate(pts):
            code = "LAB-VITD" if k % 2 == 0 else "LAB-B12"
            at = now() - timedelta(hours=rnd.randint(3, 30))
            o = await create(ctx, "orders.orders", {"patient_id": pid, "category": "LAB", "service_id": svc(ids, code), "priority": "Routine",
                                                    "ordered_at": iso(at), "status": "Ordered"})
            await jpatch(ctx, "orders", o["id"], {"sample_barcode": f"VLK{rnd.randint(10**7, 10**8 - 1)}"}, status="Collected",
                         collected_at=at + timedelta(minutes=20))
            oids.append(o["id"])
    out = None
    async with as_user("lab") as ctx:
        out = await send_out(SendOutIn(order_ids=oids[:4], reference_lab=ids["reference_labs"][0], courier="Blue Dart Medical",
                                       docket_no=f"BD{rnd.randint(10**8, 10**9 - 1)}", remarks="Frozen serum, cold chain maintained"), ctx)
        first = (out.get("send_outs") or [None])[0]
        if first:
            await guard(receive_report(first["id"], ReceiveReportIn(external_ref=f"DRL{rnd.randint(100000, 999999)}",
                                                                    values=[SheetValue(parameter="25-OH Vitamin D", value="18.4")], cost=650), ctx),
                        "receive report")
    return f"manifest {out.get('manifest_no')} with {len(out.get('send_outs') or [])} samples" if out else "none"


# ---------------------------------------------------------------------- IP working bills

async def ip_working_bills(ids: dict) -> str:
    if not has("billing.ip_bills"):
        raise RuntimeError("billing.ip_bills is not installed")
    from app.engines import ipbilling as IPB

    n = 0
    e = encounters
    async with system_ctx() as ctx:
        rows = (await ctx.conn.execute(sa.select(e.c.id).where(e.c.type == "IPD", e.c.deleted_at.is_(None),
                                                               e.c.status.in_(["Admitted", "Discharge Initiated"])))).all()
        ent = IPB.E(IPB.ADM)
        for (eid,) in rows:
            adm = await get(ctx, IPB.ADM, str(eid))
            if not adm:
                continue
            st = await IPB._ensure_state(ctx, adm)
            await IPB._snapshot(ctx, adm, st)
            await jpatch(ctx, "records", st["id"], {"opened_at": adm.get("started_at")})
            n += 1
        _ = ent
    return f"{n} open IP bills"


# ---------------------------------------------------------------------- messages, pre-registration, family links

async def front_office_extras(ids: dict) -> str:
    out = defaultdict(int)
    from app.engines.messaging import MessageIn, Recipient, compose

    adm = next((a for a in ids.get("admissions", []) if a["status"] == "Admitted" and a["category"] == "ICU"), None)
    msgs = [
        ("dr.rao", [("user", "nurse.priya")], "Bed M1 — repeat potassium at 6 am", "Please send repeat serum electrolytes at 6 am and inform me "
         "if K+ is above 5.5. Hold the potassium supplement till then.", "HIGH", "MESSAGE", True, adm),
        ("billing", [("role", "management")], "Insurance pre-auth queries pending", "Three pre-auth queries are awaiting replies from the "
         "treating teams. Please nudge the consultants — the TPA closes them after 48 hours.", "NORMAL", "NOTICE", False, None),
        ("quality", [("role", "nurse"), ("role", "doctor")], "Fall-risk reassessment compliance", "Morse reassessment for high-risk patients "
         "must be done every shift. Compliance last week was 82%. Please use the Forms tab on the IP chart.", "NORMAL", "NOTICE", False, None),
        ("nurse.priya", [("user", "dr.lakshmi")], "MEWS 5 — please review", "Patient's MEWS is 5 (SBP 88, HR 122). Fluids started as per "
         "standing orders. Requesting urgent review.", "URGENT", "ALERT", True, adm),
        ("support", [("role", "nurse")], "Ventilator VENT-SICU-03 in maintenance", "Flow sensor replacement in progress; use VENT-SICU-01/02 "
         "until further notice. Expected back tomorrow noon.", "HIGH", "NOTICE", False, None),
    ]
    for sender, to, subject, body, prio, typ, task, a in msgs:
        if sender not in USERS:
            continue
        rec = [Recipient(type=k, id=USERS[v]["id"] if k == "user" and v in USERS else v) for k, v in to]
        async with as_user(sender) as ctx:
            if await guard(compose(MessageIn(to=rec, subject=subject, body=body, priority=prio, type=typ, is_task=task,
                                             patient_id=a["patient_id"] if a else None, encounter_id=a["id"] if a else None), ctx), "message"):
                out["messages"] += 1
    async with system_ctx() as ctx:
        if has("registration.pre_registrations"):
            from .masters import FIRST_F, FIRST_M, LAST

            for k in range(8):
                g = rnd.choice(["Male", "Female"])
                await create(ctx, "registration.pre_registrations", {
                    "first_name": rnd.choice(FIRST_M if g == "Male" else FIRST_F), "last_name": rnd.choice(LAST), "gender": g,
                    "phone": f"{rnd.choice('6789')}{rnd.randint(100000000, 999999999)}",
                    "dob": (today() - timedelta(days=rnd.randint(20, 70) * 365)).isoformat(),
                    "preferred_department": ids["dept"][rnd.choice(["GMED", "CARD", "ORTH", "OBGY", "PAED", "DERM"])],
                    "preferred_date": (today() + timedelta(days=k % 3)).isoformat(), "source": rnd.choice(["QR", "Web", "WhatsApp", "Kiosk"]),
                    "otp_verified": True, "status": "Pending" if k < 6 else "Expired"})
                out["pre-registrations"] += 1
        if has("registration.family_links"):
            pts = take(ids, 24)
            for a, b in zip(pts[0::2], pts[1::2], strict=False):
                await create(ctx, "registration.family_links", {"patient_id": a, "related_patient": b,
                                                                "relationship": rnd.choice(["Spouse", "Son", "Daughter", "Father", "Mother"]),
                                                                "is_guarantor": rnd.random() < 0.5, "delegate_portal_access": rnd.random() < 0.4})
                out["family links"] += 1
    return ", ".join(f"{v} {k}" for k, v in out.items())


async def saved_reports(ids: dict) -> str:
    from app.engines.reports import ScheduleIn, ViewIn, create_schedule, save_view

    n = 0
    for who, code, name, freq, at, wd, roles, emails in (
            ("ceo", "MIS-01", "Daily flash — management", "Daily", "08:00", None, ["management"], []),
            ("quality", "IPD-05", "Discharge TAT — weekly review", "Weekly", "09:00", "Monday", ["quality"], ["quality.cell@vlack.example.in"]),
            ("cfo", "FIN-05", "Sponsor outstanding ageing", "Monthly", "10:00", None, ["management"], ["accounts@vlack.example.in"]),
            ("ceo", "OPD-04", "OP waiting time — weekly", "Weekly", "09:30", "Monday", ["quality", "front_office"], [])):
        async with as_user(who) as ctx:
            if await guard(create_schedule(code, ScheduleIn(name=name, schedule=freq, schedule_time=at, weekday=wd,
                                                            month_day=1 if freq == "Monthly" else None, recipient_roles=roles,
                                                            recipients=emails, format="Excel" if freq != "Daily" else "PDF"), ctx), "schedule"):
                n += 1
    for who, code, name in (("ceo", "REV-05", "Payer mix — this month"), ("quality", "ER-02", "Door-to-doctor by triage"),
                            ("cfo", "INS-02", "Pre-auth status — open")):
        async with as_user(who) as ctx:
            if await guard(save_view(code, ViewIn(name=name, state={}, shared=True), ctx), "view"):
                n += 1
    return f"{n} saved"


def summary() -> str:
    return ", ".join(f"{v} {k}" for k, v in STATS.items() if k != "refused") + (f" ({STATS['refused']} optional actions refused)" if STATS.get("refused") else "")


__all__ = ["seed_phase2_masters", "seed_phase2_activity", "opd_times", "opd_visit_token", "counter_tokens", "STATS", "step", "jpatch", "tz_at",
           "iso", "summary"]
