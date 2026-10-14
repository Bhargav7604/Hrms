"""Payroll engine — monthly runs with loss-of-pay from attendance and leave, pro-rated earnings,
Indian statutory deductions (EPF, ESI, Professional Tax by state, TDS), approved overtime,
incentives, doctor fee-sharing from consultation revenue and advance recovery; payslips,
statutory (challan) summary, bank transfer file and printable payslips."""

from __future__ import annotations

import calendar
import re
from collections import defaultdict
from datetime import date
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter
from fastapi.responses import Response

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit, hook
from ..core.security import CtxDep
from ..core.util import bad_request, conflict, day_bounds, forbidden, not_found, now, parse_date, to_csv
from ..schema import appointments, charges, employees, encounters, records, services
from ._common import E, create, get, require_role, update
from .hr import data_key, date_span, fetch_employee, fetch_employees, fetch_records, labels

router = APIRouter(prefix="/api/payroll", tags=["payroll"])

RUNS, SLIPS, STRUCTS = "payroll.payroll_runs", "payroll.payslips", "payroll.salary_structures"
INCENTIVES, ADVANCES = "payroll.incentives", "payroll.advances"
ATTENDANCE, LEAVES, OVERTIME = "roster.attendance", "roster.leaves", "roster.overtime"

PERIOD_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
LOCKED = ("Approved", "Paid")
PAYROLL_ROLES = ("hr", "admin", "management")

PF_RATE = Decimal("0.12")
PF_WAGE_CEILING = Decimal(15000)
EPS_RATE = Decimal("0.0833")
ESI_EMPLOYEE = Decimal("0.0075")
ESI_EMPLOYER = Decimal("0.0325")
ESI_WAGE_CEILING = Decimal(21000)
OT_MULTIPLIER = Decimal(2)                 # twice the ordinary rate of wages
OT_HOURS_PER_MONTH = Decimal(208)          # 26 working days × 8 h
NO_OVERTIME = {"Doctor", "Management"}

EARNINGS = (("basic", "Basic"), ("da", "Dearness allowance"), ("hra", "House rent allowance"),
            ("special_allowance", "Special allowance"), ("conveyance", "Conveyance allowance"),
            ("medical_allowance", "Medical allowance"), ("other_allowance", "Other allowance"))
DEDUCTION_LABELS = {"pf": "Provident Fund (12%)", "vpf": "Voluntary PF", "esi": "ESI (0.75%)", "pt": "Professional tax",
                    "tds": "Income tax (TDS)"}


# ====================================================================== statutory rules

def _d(v: Any) -> Decimal:
    return Decimal(str(v)) if v not in (None, "") else Decimal(0)


def rupees(v: Decimal) -> Decimal:
    return Decimal(v).quantize(Decimal(1), rounding=ROUND_HALF_UP)


def rupees_up(v: Decimal) -> Decimal:
    """ESIC rounds contributions up to the next rupee."""
    return Decimal(v).quantize(Decimal(1), rounding=ROUND_CEILING)


def parse_period(p: str | None) -> tuple[int, int]:
    m = PERIOD_RE.match(str(p or "").strip())
    if not m:
        raise bad_request("Period must be YYYY-MM, e.g. 2026-10", {"fields": {"period": "Use YYYY-MM"}})
    return int(m.group(1)), int(m.group(2))


def period_label(p: str) -> str:
    y, m = parse_period(p)
    return f"{calendar.month_name[m]} {y}"


def professional_tax(state: str | None, gross: Decimal, month: int, gender: str | None = None) -> Decimal:
    """Monthly Professional Tax by state slab on gross salary.
    Tamil Nadu levies PT half-yearly; ₹200 a month above ₹21,000 is used as a documented approximation.
    States without PT (and 'Other') deduct nothing."""
    g = Decimal(gross)
    if state in ("Andhra Pradesh", "Telangana"):
        return Decimal(0 if g <= 15000 else 150 if g <= 20000 else 200)
    if state == "Karnataka":
        return Decimal(200 if g >= 25000 else 0)
    if state == "Maharashtra":
        if gender == "Female":
            due = g > 25000
        else:
            if 7500 < g <= 10000:
                return Decimal(175)
            due = g > 10000
        return Decimal((300 if month == 2 else 200) if due else 0)
    if state == "West Bengal":
        for upto, tax in ((10000, 0), (15000, 110), (25000, 130), (40000, 150)):
            if g <= upto:
                return Decimal(tax)
        return Decimal(200)
    if state == "Gujarat":
        return Decimal(200 if g > 12000 else 0)
    if state == "Tamil Nadu":
        return Decimal(200 if g > 21000 else 0)
    return Decimal(0)


def statutory(struct: dict, earned: dict[str, Decimal], gross: Decimal, full_gross: Decimal, month: int,
              gender: str | None) -> dict[str, Decimal]:
    """Employee deductions and employer contributions for one month."""
    out: dict[str, Decimal] = {}
    if struct.get("pf_applicable") is not False:
        basic_da = earned.get("basic", Decimal(0)) + earned.get("da", Decimal(0))
        wages = min(basic_da, PF_WAGE_CEILING) if struct.get("pf_wage_ceiling") is not False else basic_da
        employer = rupees(wages * PF_RATE)
        eps = rupees(min(wages, PF_WAGE_CEILING) * EPS_RATE)
        out.update(pf_wages=wages, pf=rupees(wages * PF_RATE), employer_pf=employer, employer_eps=eps, employer_epf=employer - eps)
        if _d(struct.get("vpf_percent")) > 0:
            out["vpf"] = rupees(wages * _d(struct["vpf_percent"]) / 100)
    # ESI coverage follows the contracted monthly wage, not a month shortened by loss of pay.
    if struct.get("esi_applicable") and full_gross <= ESI_WAGE_CEILING and gross > 0:
        out.update(esi_wages=gross, esi=rupees_up(gross * ESI_EMPLOYEE), employer_esi=rupees_up(gross * ESI_EMPLOYER))
    if struct.get("pt_applicable") is not False and gross > 0:
        out["pt"] = professional_tax(struct.get("pt_state"), gross, month, gender)
    if gross > 0:
        out["tds"] = rupees(_d(struct.get("monthly_tds")))
    return out


# ====================================================================== salary structures, runs, advances

def _structure_gross(s: dict) -> Decimal:
    return sum((_d(s.get(k)) for k, _ in EARNINGS), Decimal(0))


@hook(STRUCTS, "before_create")
@hook(STRUCTS, "before_update")
async def _structure_totals(ctx, nxt: dict, prev: dict | None = None):
    gross = _structure_gross(nxt)
    full = {k: _d(nxt.get(k)) for k, _ in EARNINGS}
    st = statutory(nxt, full, gross, gross, 4, None)
    nxt["gross_monthly"] = float(gross)
    nxt["ctc_annual"] = float(rupees((gross + st.get("employer_pf", 0) + st.get("employer_esi", 0)) * 12))


@hook(STRUCTS, "after_create")
async def _supersede(ctx, rec: dict):
    if rec.get("status") != "Active" or not rec.get("employee_id"):
        return
    eff = rec.get("effective_from") or ""
    for old in await fetch_records(ctx, STRUCTS, records.c.employee_id == rec["employee_id"], records.c.status == "Active",
                                   records.c.id != rec["id"]):
        if (old.get("effective_from") or "") <= eff:
            await update(ctx, STRUCTS, old["id"], {"status": "Superseded", "superseded_by": rec["id"]})


@router.post("/structures/recalculate")
async def recalculate_structures(ctx: CtxDep):
    """Refresh gross / CTC on every active salary structure (after imports or statutory changes)."""
    require_role(ctx, "hr")
    n = 0
    for s in await fetch_records(ctx, STRUCTS, records.c.status == "Active"):
        await update(ctx, STRUCTS, s["id"], {})
        n += 1
    return {"updated": n}


@hook(RUNS, "before_create")
async def _run_defaults(ctx, draft: dict):
    y, m = parse_period(draft.get("period"))
    period = f"{y:04d}-{m:02d}"
    dup = await fetch_records(ctx, RUNS, data_key("period") == period, limit=1)
    if dup:
        raise conflict(f"A payroll run for {period_label(period)} already exists ({dup[0].get('code')})")
    last = date(y, m, calendar.monthrange(y, m)[1])
    draft["period"] = period
    draft["attendance_cutoff"] = draft.get("attendance_cutoff") or last.isoformat()
    draft["pay_date"] = draft.get("pay_date") or last.isoformat()
    draft["status"] = "Draft"


@hook(RUNS, "before_update")
async def _run_lock(ctx, nxt: dict, prev: dict):
    if prev.get("status") != "Draft" and any(nxt.get(k) != prev.get(k) for k in ("period", "attendance_cutoff")):
        raise conflict("Re-open the run (back to Draft) before changing its period or attendance cut-off")
    if nxt.get("period") != prev.get("period"):
        y, m = parse_period(nxt.get("period"))
        nxt["period"] = f"{y:04d}-{m:02d}"


@hook(RUNS, "before_transition")
async def _run_controls(ctx, nxt: dict, prev: dict):
    to = nxt.get("status")
    if to == "Approved":
        if not nxt.get("employee_count"):
            raise bad_request("Process the payroll before approving it")
        if ctx.role != "admin" and nxt.get("processed_by_id") == ctx.user_id:
            raise forbidden("Maker-checker: the payroll must be approved by someone other than the person who processed it")
        nxt["approved_by"] = ctx.user.get("name")
    if to == "Paid" and not (nxt.get("bank_reference") or "").strip():
        raise bad_request("Enter the bank batch / UTR reference", {"fields": {"bank_reference": "Required"}})


@hook(RUNS, "after_transition")
async def _run_paid(ctx, rec: dict, prev: dict):
    if rec.get("status") != "Paid":
        return
    await _publish_slips(ctx, rec)
    for inc in await fetch_records(ctx, INCENTIVES, data_key("payroll_run") == rec["id"], records.c.status == "Approved"):
        await update(ctx, INCENTIVES, inc["id"], {"status": "Paid", "paid_at": now().isoformat(timespec="seconds")})
    recovered: dict[str, Decimal] = defaultdict(Decimal)
    for slip in await fetch_records(ctx, SLIPS, data_key("payroll_run") == rec["id"]):
        for r in slip.get("advance_recoveries") or []:
            recovered[r["advance_id"]] += _d(r.get("amount"))
    for adv_id, amt in recovered.items():
        adv = await get(ctx, ADVANCES, adv_id)
        if adv and adv.get("status") == "Recovering":
            bal = max(Decimal(0), _d(adv.get("balance")) - amt)
            await update(ctx, ADVANCES, adv_id, {"balance": float(bal), "status": "Closed" if bal <= 0 else "Recovering"})
    await emit("payroll.paid", ctx, {"run_id": rec["id"], "period": rec.get("period"), "net_total": rec.get("net_total")})


@hook(ADVANCES, "before_create")
async def _advance_balance(ctx, draft: dict):
    draft["balance"] = draft.get("amount")


@hook(ADVANCES, "before_transition")
async def _advance_terms(ctx, nxt: dict, prev: dict):
    if nxt.get("status") == "Approved":
        parse_period(nxt.get("recovery_start"))
        if _d(nxt.get("emi")) <= 0 or _d(nxt.get("emi")) > _d(nxt.get("amount")):
            raise bad_request("The monthly recovery must be more than zero and not exceed the advance", {"fields": {"emi": "Check the amount"}})


@hook(INCENTIVES, "before_create")
@hook(INCENTIVES, "before_update")
async def _incentive_period(ctx, nxt: dict, prev: dict | None = None):
    y, m = parse_period(nxt.get("period"))
    nxt["period"] = f"{y:04d}-{m:02d}"


# ====================================================================== processing inputs

async def _payable_employees(ctx, a: date, b: date) -> list[dict]:
    t = employees
    in_service = sa.or_(t.c.status.in_(("Active", "On Notice")),
                        sa.and_(t.c.status.in_(("Resigned", "Terminated")), t.c.data["last_working_day"].astext >= a.isoformat()))
    return await fetch_employees(ctx, in_service, sa.or_(t.c.doj.is_(None), t.c.doj <= b))


async def _structures(ctx, b: date) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for s in await fetch_records(ctx, STRUCTS, records.c.status == "Active", data_key("effective_from") <= b.isoformat(),
                                 order=data_key("effective_from")):
        out[s["employee_id"]] = s  # latest effective structure wins
    return out


async def _lop_dates(ctx, a: date, cutoff: date) -> dict[str, dict[date, tuple[Decimal, str]]]:
    """Loss-of-pay per employee and date: Absent = 1, Half Day = ½, approved Loss of Pay leave = 1 (½ for half-day)."""
    out: dict[str, dict[date, tuple[Decimal, str]]] = defaultdict(dict)

    def mark(emp: str, d: date, v: Decimal, why: str) -> None:
        if v > out[emp].get(d, (Decimal(0), ""))[0]:
            out[emp][d] = (v, why)

    for r in await fetch_records(ctx, ATTENDANCE, records.c.status.in_(("Absent", "Half Day")),
                                 data_key("att_date") >= a.isoformat(), data_key("att_date") <= cutoff.isoformat()):
        mark(r["employee_id"], parse_date(r["att_date"]), Decimal(1) if r["status"] == "Absent" else Decimal("0.5"),
             "absent" if r["status"] == "Absent" else "half_day")
    for lv in await fetch_records(ctx, LEAVES, records.c.status == "Approved", data_key("leave_type") == "Loss of Pay",
                                  data_key("from_date") <= cutoff.isoformat(), data_key("to_date") >= a.isoformat()):
        f, t = parse_date(lv["from_date"]), parse_date(lv["to_date"])
        for d in date_span(max(f, a), min(t, cutoff)):
            mark(lv["employee_id"], d, Decimal("0.5") if lv.get("half_day") else Decimal(1), "lop_leave")
    return out


async def _overtime_hours(ctx, a: date, b: date) -> dict[str, Decimal]:
    out: dict[str, Decimal] = defaultdict(Decimal)
    for r in await fetch_records(ctx, OVERTIME, records.c.status == "Approved", data_key("ot_date") >= a.isoformat(),
                                 data_key("ot_date") <= b.isoformat()):
        out[r["employee_id"]] += _d(r.get("approved_hours") if r.get("approved_hours") not in (None, "") else r.get("hours"))
    return out


async def _incentives(ctx, run: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in await fetch_records(ctx, INCENTIVES, records.c.status == "Approved", data_key("period") == run["period"]):
        if r.get("payment_mode") == "Professional fee (TDS s.194J)":
            continue  # paid outside payroll as professional fees
        if r.get("payroll_run") and r["payroll_run"] != run["id"]:
            continue
        out[r["employee_id"]].append(r)
    return out


async def fee_share_revenue(ctx, a: date, b: date) -> dict[str, dict]:
    """Consultation revenue per doctor: charges raised from appointments (appointment doctor) or CONSULT
    services linked to the doctor (charge data.doctor_id, else the encounter's doctor), net of discount."""
    c, ap, s, e = charges, appointments, services, encounters
    doctor = sa.func.coalesce(sa.cast(ap.c.doctor_id, sa.Text), c.c.data["doctor_id"].astext, sa.cast(e.c.doctor_id, sa.Text))
    net = c.c.amount - sa.func.coalesce(c.c.discount, 0)
    stmt = (sa.select(doctor.label("doctor"), sa.func.count().label("n"), sa.func.coalesce(sa.func.sum(net), 0).label("revenue"))
            .select_from(c.outerjoin(ap, sa.and_(c.c.source == "appointments.appointments", ap.c.id == c.c.source_id))
                         .outerjoin(s, s.c.id == c.c.service_id).outerjoin(e, e.c.id == c.c.encounter_id))
            .where(c.c.deleted_at.is_(None), c.c.status != "Cancelled", c.c.charged_at >= day_bounds(a)[0],
                   c.c.charged_at < day_bounds(b)[1], sa.or_(c.c.source == "appointments.appointments", s.c.category == "CONSULT"))
            .group_by(doctor))
    return {r.doctor: {"consults": r.n, "revenue": _d(r.revenue)} for r in (await ctx.conn.execute(stmt)).all() if r.doctor}


async def _advances(ctx, period: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in await fetch_records(ctx, ADVANCES, records.c.status == "Recovering"):
        if (r.get("recovery_start") or "") <= period and _d(r.get("balance")) > 0:
            out[r["employee_id"]].append(r)
    return out


# ====================================================================== payslip computation

def compute_payslip(emp: dict, struct: dict, y: int, m: int, lop: dict[date, tuple[Decimal, str]], ot_hours: Decimal,
                    incentives: list[dict], fee: dict | None, advances: list[dict]) -> dict | None:
    """One employee's payslip for the month, or None when not in service during the month."""
    a = date(y, m, 1)
    dim = calendar.monthrange(y, m)[1]
    b = date(y, m, dim)
    doj = parse_date(emp.get("doj"))
    lwd = parse_date(emp.get("last_working_day")) if emp.get("status") != "Active" else None
    first, last = max(a, doj) if doj else a, min(b, lwd) if lwd else b
    if last < first:
        return None
    not_in_service = (first - a).days + (b - last).days
    lop_in = {d: v for d, v in lop.items() if first <= d <= last}
    lop_days = sum((v for v, _ in lop_in.values()), Decimal(0))
    paid_days = max(Decimal(0), Decimal(dim) - not_in_service - lop_days)
    factor = paid_days / dim

    earnings, earned = [], {}
    for key, label in EARNINGS:
        full = _d(struct.get(key))
        if full > 0:
            earned[key] = rupees(full * factor)
            earnings.append({"component": label, "amount": earned[key]})
    full_gross = _structure_gross(struct)
    if ot_hours > 0 and emp.get("category") not in NO_OVERTIME:
        hourly = (_d(struct.get("basic")) + _d(struct.get("da"))) / OT_HOURS_PER_MONTH
        earnings.append({"component": f"Overtime ({ot_hours.normalize():f} h at 2×)", "amount": rupees(hourly * OT_MULTIPLIER * ot_hours)})
    manual_fee_share = False
    for inc in incentives:
        manual_fee_share |= inc.get("incentive_type") == "Fee Share"
        earnings.append({"component": inc.get("incentive_type") or "Incentive", "amount": rupees(_d(inc.get("amount"))),
                         "incentive_id": inc["id"]})
    fee_basis = None
    pct = _d(emp.get("fee_share_percent"))
    if emp.get("category") == "Doctor" and pct > 0 and fee and fee["revenue"] > 0 and not manual_fee_share:
        amount = rupees(fee["revenue"] * pct / 100)
        earnings.append({"component": "Professional fee share", "amount": amount})
        fee_basis = {"consults": fee["consults"], "revenue": float(fee["revenue"]), "percent": float(pct), "amount": float(amount),
                     "basis": f"{fee['consults']} consultations, revenue ₹{fee['revenue']:,.2f} @ {pct.normalize():f}%"}
    gross = sum((e["amount"] for e in earnings), Decimal(0))

    st = statutory(struct, earned, gross, full_gross, m, emp.get("gender"))
    deductions = [{"component": DEDUCTION_LABELS[k], "amount": st[k]} for k in ("pf", "vpf", "esi", "pt", "tds") if st.get(k)]
    recoveries = []
    for adv in advances:
        amt = min(_d(adv.get("emi")), _d(adv.get("balance")))
        if amt > 0:
            recoveries.append({"advance_id": adv["id"], "code": adv.get("code"), "amount": amt})
            deductions.append({"component": f"Advance recovery ({adv.get('code')})", "amount": amt})
    warnings = []
    total = sum((x["amount"] for x in deductions), Decimal(0))
    if total > gross:  # never pay a negative salary: hold back advance recovery, then TDS
        for label in [d["component"] for d in deductions if d["component"].startswith("Advance")] + [DEDUCTION_LABELS["tds"]]:
            excess = total - gross
            if excess <= 0:
                break
            line = next(d for d in deductions if d["component"] == label)
            cut = min(line["amount"], excess)
            line["amount"] -= cut
            total -= cut
            warnings.append(f"{label} reduced by ₹{cut} (insufficient pay)")
        recoveries = [{**r, "amount": next(d["amount"] for d in deductions if d["component"] == f"Advance recovery ({r['code']})")}
                      for r in recoveries]
        deductions = [d for d in deductions if d["amount"] > 0]
    by_why = defaultdict(Decimal)
    for v, why in lop_in.values():
        by_why[why] += v

    def f(v: Any) -> float:
        return float(v)

    return {
        "days_in_month": dim, "paid_days": f(paid_days), "lop_days": f(lop_days),
        "earnings": [{**e, "amount": f(e["amount"])} for e in earnings],
        "deductions": [{**x, "amount": f(x["amount"])} for x in deductions],
        "gross": f(gross), "total_deductions": f(total), "net_pay": f(gross - total),
        "employer_pf": f(st.get("employer_pf", 0)), "employer_esi": f(st.get("employer_esi", 0)),
        "statutory": {k: f(v) for k, v in st.items()},
        "lop_detail": {"absent": f(by_why["absent"]), "half_day": f(by_why["half_day"]), "lop_leave": f(by_why["lop_leave"]),
                       "not_in_service": not_in_service},
        "fee_share": fee_basis, "advance_recoveries": [{**r, "amount": f(r["amount"])} for r in recoveries],
        "warnings": warnings,
    }


SNAPSHOT_KEYS = ("code", "name", "category", "designation", "department_id", "bank_account", "ifsc", "pan", "uan", "esi_no")


async def process_payroll(ctx, run: dict) -> dict:
    y, m = parse_period(run["period"])
    a, b = date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])
    cutoff = min(max(parse_date(run.get("attendance_cutoff")) or b, a), b)
    emps = await _payable_employees(ctx, a, b)
    structs = await _structures(ctx, b)
    lop = await _lop_dates(ctx, a, cutoff)
    ot = await _overtime_hours(ctx, a, b)
    incentives = await _incentives(ctx, run)
    fees = await fee_share_revenue(ctx, a, b)
    advances = await _advances(ctx, run["period"])
    existing = {s["employee_id"]: s for s in await fetch_records(ctx, SLIPS, data_key("payroll_run") == run["id"])}
    totals: dict[str, Decimal] = defaultdict(Decimal)
    warnings: list[str] = []
    count = 0
    for emp in emps:
        struct = structs.get(emp["id"])
        if not struct:
            warnings.append(f"{emp.get('code')} {emp.get('name')}: no active salary structure — not paid")
            continue
        slip = compute_payslip(emp, struct, y, m, lop.get(emp["id"], {}), ot.get(emp["id"], Decimal(0)),
                               incentives.get(emp["id"], []), fees.get(emp["id"]), advances.get(emp["id"], []))
        if slip is None:
            continue
        warnings += [f"{emp.get('code')} {emp.get('name')}: {w}" for w in slip["warnings"]]
        if slip["net_pay"] > 0 and not (emp.get("bank_account") and emp.get("ifsc")):
            warnings.append(f"{emp.get('code')} {emp.get('name')}: bank account / IFSC missing")
        payload = {**slip, "payroll_run": run["id"], "period": run["period"], "employee_id": emp["id"], "status": "Generated",
                   "salary_structure": struct["id"], "pt_state": struct.get("pt_state"),
                   **{f"employee_{k}" if k in ("code", "name") else k: emp.get(k) for k in SNAPSHOT_KEYS}}
        prev = existing.pop(emp["id"], None)
        if prev:
            await update(ctx, SLIPS, prev["id"], payload)
        else:
            await create(ctx, SLIPS, payload)
        for line in slip["earnings"]:
            inc_id = line.get("incentive_id")
            if inc_id and next((i for i in incentives[emp["id"]] if i["id"] == inc_id), {}).get("payroll_run") != run["id"]:
                await update(ctx, INCENTIVES, inc_id, {"payroll_run": run["id"]})
        count += 1
        for k, src in (("gross", "gross"), ("deductions", "total_deductions"), ("net", "net_pay"), ("employer_pf", "employer_pf"),
                       ("employer_esi", "employer_esi")):
            totals[k] += _d(slip[src])
    for stale in existing.values():
        await rs.delete_record(ctx, E(SLIPS), stale["id"], reason="No longer payable when the run was re-processed", check=False)
    run = await update(ctx, RUNS, run["id"], {
        "employee_count": count, "gross_total": float(totals["gross"]), "deduction_total": float(totals["deductions"]),
        "net_total": float(totals["net"]), "employer_pf_total": float(totals["employer_pf"]),
        "employer_esi_total": float(totals["employer_esi"]), "status": "Processed", "attendance_cutoff": cutoff.isoformat(),
        "processed_at": now().isoformat(timespec="seconds"), "processed_by": ctx.user.get("name"), "processed_by_id": ctx.user_id,
        "warnings": warnings[:300], "warning_count": len(warnings)})
    await audit(ctx, "payroll.process", module="payroll", entity="payroll_runs", record=run,
                after={"payslips": count, "net_total": run.get("net_total")}, note=f"{count} payslips, {len(warnings)} warnings")
    return {"run": run, "payslips": count, "warnings": warnings}


# ====================================================================== endpoints

async def _run(ctx, run_id: str) -> dict:
    run = await get(ctx, RUNS, run_id)
    if not run:
        raise not_found("Payroll run not found")
    return run


async def _slips(ctx, run_id: str) -> list[dict]:
    return await fetch_records(ctx, SLIPS, data_key("payroll_run") == run_id, order=data_key("employee_name"))


@router.post("/runs/{run_id}/process")
async def process_run(run_id: str, ctx: CtxDep):
    require_role(ctx, "hr")
    run = await _run(ctx, run_id)
    if run.get("status") in LOCKED:
        raise conflict(f"Payroll for {period_label(run['period'])} is {run['status']} and locked")
    return await process_payroll(ctx, run)


async def _publish_slips(ctx, run: dict) -> int:
    n = 0
    for s in await fetch_records(ctx, SLIPS, data_key("payroll_run") == run["id"], records.c.status == "Generated"):
        await update(ctx, SLIPS, s["id"], {"status": "Published", "published_at": now().isoformat(timespec="seconds")})
        n += 1
    return n


@router.post("/runs/{run_id}/publish")
async def publish_run(run_id: str, ctx: CtxDep):
    """Release payslips to staff (visible in self-service)."""
    require_role(ctx, "hr")
    run = await _run(ctx, run_id)
    if run.get("status") not in LOCKED:
        raise conflict("Approve the payroll before publishing payslips to staff")
    n = await _publish_slips(ctx, run)
    run = await update(ctx, RUNS, run_id, {"payslips_published_at": now().isoformat(timespec="seconds"),
                                           "payslips_published_by": ctx.user.get("name")})
    await emit("payslips.published", ctx, {"run_id": run_id, "period": run.get("period"), "count": n})
    return {"published": n, "run": run}


SLIP_ROW_KEYS = ("id", "code", "employee_id", "employee_code", "employee_name", "designation", "category", "department_id",
                 "days_in_month", "paid_days", "lop_days", "gross", "total_deductions", "net_pay", "employer_pf", "employer_esi",
                 "status", "fee_share", "lop_detail", "statutory")


@router.get("/runs/{run_id}/payslips")
async def run_payslips(run_id: str, ctx: CtxDep):
    rs.ensure_access(ctx, E(SLIPS), "read")
    await _run(ctx, run_id)
    depts = {k: v.get("name") for k, v in (await labels(ctx, "mdm.departments")).items()}
    rows = []
    for s in await _slips(ctx, run_id):
        rows.append({**{k: s.get(k) for k in SLIP_ROW_KEYS}, "department": depts.get(s.get("department_id")),
                     "bank_ok": bool(s.get("bank_account") and s.get("ifsc"))})
    rows.sort(key=lambda r: r.get("employee_name") or "")
    return {"rows": rows}


def _next_month_day(period: str, day: int) -> str:
    y, m = parse_period(period)
    y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return date(y, m, day).isoformat()


@router.get("/runs/{run_id}/summary")
async def run_summary(run_id: str, ctx: CtxDep):
    """Department totals and statutory remittances (PF / ESI / PT / TDS) for the challans."""
    rs.ensure_access(ctx, E(RUNS), "read")
    run = await _run(ctx, run_id)
    slips = await _slips(ctx, run_id)
    depts = {k: v.get("name") for k, v in (await labels(ctx, "mdm.departments")).items()}
    by_dept: dict[str, dict[str, Any]] = {}
    pf = defaultdict(Decimal)
    esi = defaultdict(Decimal)
    pt_by_state: dict[str, dict[str, Any]] = {}
    tds = defaultdict(Decimal)
    missing_bank = []
    for s in slips:
        st = {k: _d(v) for k, v in (s.get("statutory") or {}).items()}
        name = depts.get(s.get("department_id")) or "Unassigned"
        d = by_dept.setdefault(name, {"department": name, "employees": 0, "gross": Decimal(0), "deductions": Decimal(0), "net": Decimal(0),
                                      "employer_pf": Decimal(0), "employer_esi": Decimal(0)})
        d["employees"] += 1
        for k, src in (("gross", "gross"), ("deductions", "total_deductions"), ("net", "net_pay"), ("employer_pf", "employer_pf"),
                       ("employer_esi", "employer_esi")):
            d[k] += _d(s.get(src))
        if "pf" in st:
            pf["members"] += 1
            for k in ("pf_wages", "pf", "vpf", "employer_pf", "employer_eps", "employer_epf"):
                pf[k] += st.get(k, Decimal(0))
        if "esi" in st:
            esi["members"] += 1
            for k in ("esi_wages", "esi", "employer_esi"):
                esi[k] += st.get(k, Decimal(0))
        if st.get("pt"):
            p = pt_by_state.setdefault(s.get("pt_state") or "Other", {"state": s.get("pt_state") or "Other", "employees": 0, "amount": Decimal(0)})
            p["employees"] += 1
            p["amount"] += st["pt"]
        if st.get("tds"):
            tds["employees"] += 1
            tds["amount"] += st["tds"]
        if _d(s.get("net_pay")) > 0 and not (s.get("bank_account") and s.get("ifsc")):
            missing_bank.append({"employee_id": s.get("employee_id"), "code": s.get("employee_code"), "name": s.get("employee_name")})

    def plain(d: dict) -> dict:
        return {k: (int(v) if k in ("members", "employees") else float(v)) if isinstance(v, Decimal) else v for k, v in d.items()}

    depts_out = sorted((plain({**d, "employer_cost": d["gross"] + d["employer_pf"] + d["employer_esi"]}) for d in by_dept.values()),
                       key=lambda d: -d["gross"])
    total = {k: sum(d[k] for d in depts_out) for k in ("employees", "gross", "deductions", "net", "employer_pf", "employer_esi", "employer_cost")}
    p = run["period"]
    return {
        "run": {k: run.get(k) for k in ("id", "code", "period", "status", "pay_date", "employee_count", "net_total")},
        "period_label": period_label(p), "totals": total, "departments": depts_out,
        "statutory": {
            "pf": {**plain(pf), "total_remittance": float(pf["pf"] + pf["vpf"] + pf["employer_pf"]), "due_date": _next_month_day(p, 15)},
            "esi": {**plain(esi), "total_remittance": float(esi["esi"] + esi["employer_esi"]), "due_date": _next_month_day(p, 15)},
            "pt": {"total": float(sum((x["amount"] for x in pt_by_state.values()), Decimal(0))),
                   "by_state": [plain(x) for x in pt_by_state.values()], "due_date": _next_month_day(p, 10)},
            "tds": {**plain(tds), "due_date": _next_month_day(p, 7)},
        },
        "missing_bank": missing_bank,
        "warnings": run.get("warnings") or [],
    }


@router.get("/runs/{run_id}/bank-file")
async def bank_file(run_id: str, ctx: CtxDep):
    """Salary transfer CSV for the bank portal (account, IFSC, name, net). Staff without valid bank details are excluded."""
    require_role(ctx, "hr")
    run = await _run(ctx, run_id)
    if run.get("status") not in LOCKED:
        raise conflict("Approve the payroll before generating the bank transfer file")
    slips = await _slips(ctx, run_id)
    masters = {e["id"]: e for e in await fetch_employees(ctx, employees.c.id.in_([s["employee_id"] for s in slips]))} if slips else {}
    rows, excluded, total = [], 0, Decimal(0)
    narration = f"Salary {period_label(run['period'])}"
    for s in slips:
        net = _d(s.get("net_pay"))
        if net <= 0:
            continue
        emp = masters.get(s["employee_id"], {})
        acct = re.sub(r"\s", "", str(emp.get("bank_account") or s.get("bank_account") or ""))
        ifsc = str(emp.get("ifsc") or s.get("ifsc") or "").strip().upper()
        if not acct.isdigit() or not IFSC_RE.match(ifsc):
            excluded += 1
            continue
        rows.append({"account": acct, "ifsc": ifsc, "name": emp.get("name") or s.get("employee_name"), "amount": f"{net:.2f}",
                     "employee_code": s.get("employee_code"), "narration": narration})
        total += net
    await audit(ctx, "payroll.bank_file", module="payroll", entity="payroll_runs", record=run,
                note=f"{len(rows)} transfers, ₹{total:.2f}; {excluded} excluded for missing / invalid bank details")
    body = to_csv(rows, [("account", "Beneficiary Account No"), ("ifsc", "IFSC"), ("name", "Beneficiary Name"), ("amount", "Amount"),
                         ("employee_code", "Employee Code"), ("narration", "Narration")])
    return Response(body, media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="salary-{run["period"]}.csv"', "X-Excluded-Count": str(excluded),
        "X-Total-Amount": f"{total:.2f}", "Access-Control-Expose-Headers": "X-Excluded-Count, X-Total-Amount"})


# ====================================================================== printable payslip

_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
         "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two(n: int) -> str:
    return _ONES[n] if n < 20 else _TENS[n // 10] + (f" {_ONES[n % 10]}" if n % 10 else "")


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    return " ".join(p for p in ((f"{_ONES[h]} Hundred" if h else ""), (_two(r) if r else "")) if p)


def indian_words(n: int) -> str:
    """Whole number in words with the Indian system (thousand, lakh, crore)."""
    if n == 0:
        return "Zero"
    crore, n = divmod(n, 10**7)
    lakh, n = divmod(n, 10**5)
    thousand, n = divmod(n, 1000)
    parts = [f"{indian_words(crore)} Crore" if crore else "", f"{_two(lakh)} Lakh" if lakh else "",
             f"{_two(thousand)} Thousand" if thousand else "", _three(n) if n else ""]
    return " ".join(p for p in parts if p)


def amount_in_words(v: Any) -> str:
    d = abs(_d(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    rupee, paise = int(d), int((d - int(d)) * 100)
    return f"Rupees {indian_words(rupee)}" + (f" and {_two(paise)} Paise" if paise else "") + " Only"


def _mask(v: Any) -> str | None:
    s = re.sub(r"\s", "", str(v or ""))
    return None if not s else "X" * max(0, len(s) - 4) + s[-4:]


async def payslip_print_data(ctx, slip_id: str) -> dict:
    """Everything a printed payslip needs; callers enforce who may see it."""
    slip = await get(ctx, SLIPS, slip_id)
    if not slip:
        raise not_found("Payslip not found")
    emp = await fetch_employee(ctx, slip.get("employee_id")) or {}
    dept = await get(ctx, "mdm.departments", emp["department_id"]) if emp.get("department_id") else None
    branch = next(iter(await fetch_records(ctx, "mdm.branches", records.c.status == "Active", limit=1)), None) or {}
    run = await get(ctx, RUNS, slip["payroll_run"]) if slip.get("payroll_run") else None
    await audit(ctx, "print", module="payroll", entity="payslips", record=slip)
    return {
        "payslip": slip,
        "employee": {"id": emp.get("id"), "code": emp.get("code") or slip.get("employee_code"), "name": emp.get("name") or slip.get("employee_name"),
                     "designation": emp.get("designation") or slip.get("designation"), "category": emp.get("category"),
                     "department": (dept or {}).get("name"), "doj": emp.get("doj"), "pan": emp.get("pan"), "uan": emp.get("uan"),
                     "esi_no": emp.get("esi_no"), "bank_account": _mask(emp.get("bank_account") or slip.get("bank_account")),
                     "ifsc": emp.get("ifsc") or slip.get("ifsc"), "gender": emp.get("gender")},
        "hospital": {"name": settings.hospital_name, "branch": branch.get("name"), "address": branch.get("address"),
                     "city": branch.get("city"), "state": branch.get("state"), "phone": branch.get("phone"), "gstin": branch.get("gstin")},
        "period_label": period_label(slip["period"]) if slip.get("period") else None,
        "pay_date": (run or {}).get("pay_date"), "run_code": (run or {}).get("code"),
        "net_in_words": amount_in_words(slip.get("net_pay")), "generated_at": now().isoformat(timespec="seconds"),
    }


@router.get("/payslips/{slip_id}/print")
async def payslip_print(slip_id: str, ctx: CtxDep):
    if ctx.role in PAYROLL_ROLES:
        rs.ensure_access(ctx, E(SLIPS), "read")
    else:
        slip = await get(ctx, SLIPS, slip_id)
        if not slip or slip.get("employee_id") != ctx.user.get("employee_id") or slip.get("status") != "Published":
            raise not_found("Payslip not found")
    return await payslip_print_data(ctx, slip_id)


__all__ = ["router", "process_payroll", "compute_payslip", "professional_tax", "statutory", "amount_in_words",
           "indian_words", "payslip_print_data", "fee_share_revenue"]
