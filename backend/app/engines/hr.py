"""HR engine — duty roster planner (conflict checks, publish, copy week, acuity staffing),
attendance punching from biometric / face / geo-fence devices and HR, leave → attendance and
roster integration, credential & licence expiry alerts, onboarding → employee master, staff
health and training hooks, and the Employee Self-Service API (/api/ess)."""

from __future__ import annotations

import calendar
import hashlib
import hmac
import logging
import math
import os
import re
from collections import Counter, defaultdict
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from itertools import pairwise
from typing import Annotated, Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit, hook
from ..core.security import CtxDep, get_ctx, get_public_ctx
from ..core.util import ApiError, bad_request, conflict, forbidden, is_uuid, not_found, now, parse_date, parse_dt, today
from ..db import Ctx, system_ctx
from ..modules.hr.employees import CATEGORIES
from ..modules.hr.roster import LEAVE_TYPES
from ..schema import beds, employees, records
from ._common import E, create, get, has, transition, update

log = logging.getLogger("vlack.hr")

router = APIRouter()  # carries the two routers below (see the end of this file)
hr_api = APIRouter(prefix="/api/hr", tags=["hr"])
ess_api = APIRouter(prefix="/api/ess", tags=["ess"])

ROSTER, SHIFTS, ATTENDANCE, LEAVES, STAFFING, OVERTIME = (
    "roster.rosters", "roster.shifts", "roster.attendance", "roster.leaves", "roster.staffing", "roster.overtime")
EMPLOYEES, CREDENTIALS, ONBOARDING = "employees.employees", "employees.credentials", "employees.onboarding"
GRIEVANCES, POSH, REQUESTS, ANNOUNCEMENTS = "ess.grievances", "ess.posh_complaints", "ess.requests", "ess.announcements"

LIVE = ("Planned", "Published", "Swapped")          # roster entries that put someone on duty
IN_SERVICE = ("Active", "On Notice")
MIN_REST_HOURS = 11
MAX_CONSECUTIVE_DAYS = 6
MAX_GRID_ROWS = 400
LATE_GRACE_MINUTES = 5                               # used when a shift has no grace configured
HALF_DAY_HOURS = 4
STANDARD_DAY_HOURS = 8
DUPLICATE_PUNCH_SECONDS = 120
MAX_BACKDATE_DAYS = 31
EXPIRY_WINDOW_DAYS = 60
POSH_INQUIRY_DAYS = 90                               # s.11(4) POSH Act
POSH_FILING_DAYS = 90                                # s.9: within 3 months of the incident
LEAVE_ENTITLEMENT = {"Casual": 12, "Sick": 12, "Earned": 18}
LEAVE_SHORT = {"Casual": "CL", "Sick": "SL", "Earned": "EL", "Maternity": "ML", "Paternity": "PL",
               "Compensatory Off": "CO", "Loss of Pay": "LOP"}
MATERNITY_MAX_DAYS = 182                             # Maternity Benefit Act: 26 weeks
WARD_RATIO = {"ICU": 1, "NICU": 1, "PICU": 1, "HDU": 2}
GENERAL_RATIO = 6
HIGH_ACUITY_RATIO = 2
SLOTS = ("M", "E", "N")
SLOT_OF = {"Morning": "M", "General": "M", "Evening": "E", "Night": "N"}
# Non-rostered staff of these categories are assumed to work the General shift.
GENERAL_SHIFT_CATEGORIES = {"Administrative", "Management", "Support", "Pharmacist", "Technician", "Therapist"}
CLINICAL_CATEGORIES = {"Doctor", "Nurse", "Technician"}
DEVICE_ROLE = "device"


# ====================================================================== shared helpers

def data_key(key: str):
    """A JSONB data key of the generic `records` table, as text."""
    return records.c.data[key].astext


async def fetch_records(ctx, fqn: str, *conds, order=None, limit: int | None = None) -> list[dict]:
    """All live records of an entity stored in `records` (no paging cap; engines enforce access)."""
    module, entity = fqn.split(".")
    t = records
    stmt = sa.select(t).where(t.c.module == module, t.c.entity == entity, t.c.deleted_at.is_(None), *conds)
    if order is not None:
        stmt = stmt.order_by(order)
    if limit:
        stmt = stmt.limit(limit)
    return [rs.to_record(r) for r in (await ctx.conn.execute(stmt)).all()]


async def fetch_employees(ctx, *conds) -> list[dict]:
    t = employees
    rows = (await ctx.conn.execute(sa.select(t).where(t.c.deleted_at.is_(None), *conds).order_by(t.c.name))).all()
    return [rs.to_record(r) for r in rows]


async def fetch_employee(ctx, eid: str | None) -> dict | None:
    if not eid or not is_uuid(eid):
        return None
    rows = await fetch_employees(ctx, employees.c.id == eid)
    return rows[0] if rows else None


async def labels(ctx, fqn: str) -> dict[str, dict]:
    return {r["id"]: r for r in await fetch_records(ctx, fqn)}


def date_span(a: date, b: date) -> list[date]:
    return [a + timedelta(days=i) for i in range((b - a).days + 1)]


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    return date(y, m + 1, min(d.day, calendar.monthrange(y, m + 1)[1]))


def _date(v: Any, label: str = "date") -> date:
    try:
        d = parse_date(v)
    except (ValueError, TypeError):
        raise bad_request(f"Invalid {label} — use YYYY-MM-DD") from None
    if d is None:
        raise bad_request(f"{label.capitalize()} is required")
    return d


def _uuid(v: str | None, label: str) -> str | None:
    if v in (None, ""):
        return None
    if not is_uuid(v):
        raise bad_request(f"Invalid {label}")
    return str(v)


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _group(rows: Iterable[dict], key: str = "employee_id") -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[r.get(key)].append(r)
    return out


def _brief(emp: dict | None) -> dict | None:
    if not emp:
        return None
    return {k: emp.get(k) for k in ("id", "code", "name", "category", "designation", "department_id", "phone", "email")}


def _hhmm(v: Any) -> time | None:
    try:
        h, m = str(v)[:5].split(":")
        return time(int(h), int(m))
    except (ValueError, TypeError):
        return None


def shift_window(d: date, shift: dict | None) -> tuple[datetime, datetime] | None:
    """Start/end of a shift worked on `d`; night shifts end the next morning."""
    if not shift:
        return None
    s, e = _hhmm(shift.get("start_time")), _hhmm(shift.get("end_time"))
    if not s or not e:
        return None
    start = datetime.combine(d, s, tzinfo=settings.tz)
    end = datetime.combine(d, e, tzinfo=settings.tz)
    if end <= start:
        end += timedelta(days=1)
    return start, end


def shift_hours(shift: dict | None) -> float:
    if not shift:
        return 0.0
    if shift.get("hours") not in (None, ""):
        return float(shift["hours"])
    w = shift_window(date(2000, 1, 3), shift)
    return round((w[1] - w[0]).total_seconds() / 3600, 2) if w else 0.0


def shift_label(shift: dict | None) -> str:
    if not shift:
        return "?"
    return str(shift.get("shift_code") or shift.get("name") or "?")[:3].upper()


def _shift_out(s: dict) -> dict:
    keys = ("id", "code", "name", "shift_code", "shift_type", "start_time", "end_time", "hours", "color", "status",
            "night_allowance", "grace_minutes", "applies_to")
    return {**{k: s.get(k) for k in keys}, "label": shift_label(s)}


async def shift_map(ctx) -> dict[str, dict]:
    return {r["id"]: r for r in await fetch_records(ctx, SHIFTS)}


def _sorted_shifts(shifts: dict[str, dict]) -> list[dict]:
    return sorted(shifts.values(), key=lambda s: (s.get("status") != "Active", s.get("start_time") or ""))


async def live_entries(ctx, emp_ids: Iterable[str], a: date, b: date) -> list[dict]:
    ids = [i for i in emp_ids if i]
    if not ids:
        return []
    return await fetch_records(ctx, ROSTER, records.c.employee_id.in_(ids), records.c.status.in_(LIVE),
                               data_key("roster_date") >= a.isoformat(), data_key("roster_date") <= b.isoformat(),
                               order=data_key("roster_date"))


async def leaves_between(ctx, emp_ids: Iterable[str] | None, a: date, b: date,
                         statuses: tuple[str, ...] = ("Approved",)) -> list[dict]:
    conds = [records.c.status.in_(statuses), data_key("from_date") <= b.isoformat(), data_key("to_date") >= a.isoformat()]
    if emp_ids is not None:
        ids = [i for i in emp_ids if i]
        if not ids:
            return []
        conds.append(records.c.employee_id.in_(ids))
    return await fetch_records(ctx, LEAVES, *conds)


def leave_dates(lv: dict) -> list[date]:
    f, t = parse_date(lv.get("from_date")), parse_date(lv.get("to_date"))
    return date_span(f, t) if f and t and t >= f else []


def leave_days_within(lv: dict, a: date, b: date) -> float:
    f, t = parse_date(lv.get("from_date")), parse_date(lv.get("to_date"))
    if not f or not t:
        return 0.0
    if lv.get("half_day"):
        return 0.5 if a <= f <= b else 0.0
    lo, hi = max(f, a), min(t, b)
    return float(max(0, (hi - lo).days + 1))


# ====================================================================== roster conflicts

def roster_conflicts(entries: list[dict], shifts: dict[str, dict], leaves: list[dict]) -> dict[str, list[dict]]:
    """Conflicts for ONE employee's live roster entries (any ward) → {entry_id: [{type, message}]}.
    Pass entries from a week before the range of interest so rest / consecutive-day checks see context."""
    out: dict[str, list[dict]] = defaultdict(list)
    by_day: dict[str, list[dict]] = defaultdict(list)
    for e in entries:
        by_day[e["roster_date"]].append(e)
    on_leave = {d.isoformat(): lv for lv in leaves if not lv.get("half_day") for d in leave_dates(lv)}
    for day, es in by_day.items():
        lv = on_leave.get(day)
        for e in es:
            if lv:
                out[e["id"]].append({"type": "leave", "message": f"On approved {str(lv.get('leave_type') or '').lower()} leave ({lv.get('code')})"})
            if len(es) > 1:
                out[e["id"]].append({"type": "double", "message": f"{len(es)} shifts on the same day"})
    timed = sorted(((w, e) for e in entries if (w := shift_window(parse_date(e["roster_date"]), shifts.get(e.get("shift"))))),
                   key=lambda x: x[0][0])
    for (w1, e1), (w2, e2) in pairwise(timed):
        if e1["roster_date"] == e2["roster_date"]:
            continue  # already reported as a double shift
        rest = (w2[0] - w1[1]).total_seconds() / 3600
        if rest < MIN_REST_HOURS:
            prev = (shifts.get(e1.get("shift")) or {}).get("name") or "previous"
            out[e2["id"]].append({"type": "rest", "message": f"Only {max(rest, 0):.0f} h rest after the {prev} shift of "
                                                             f"{e1['roster_date']} (minimum {MIN_REST_HOURS} h)"})
    run, prev_day = 0, None
    for d in sorted(parse_date(x) for x in by_day):
        run = run + 1 if prev_day and (d - prev_day).days == 1 else 1
        prev_day = d
        if run > MAX_CONSECUTIVE_DAYS:
            for e in by_day[d.isoformat()]:
                out[e["id"]].append({"type": "consecutive",
                                     "message": f"Working day {run} in a row — a weekly off is due after {MAX_CONSECUTIVE_DAYS}"})
    return out


async def _conflicts_for(ctx, emp_ids: Iterable[str], a: date, b: date, shifts: dict) -> tuple[dict[str, list[dict]], list[dict]]:
    """Conflicts for entries dated a..b (context loaded around the range). Returns (by entry id, entries in range)."""
    ids = list({i for i in emp_ids if i})
    entries = await live_entries(ctx, ids, a - timedelta(days=MAX_CONSECUTIVE_DAYS + 1), b + timedelta(days=1))
    leaves = _group(await leaves_between(ctx, ids, a, b))
    out: dict[str, list[dict]] = {}
    for emp_id, es in _group(entries).items():
        out.update(roster_conflicts(es, shifts, leaves.get(emp_id, [])))
    in_range = [e for e in entries if a.isoformat() <= e["roster_date"] <= b.isoformat()]
    return out, in_range


# ====================================================================== acuity staffing

def ward_ratio(ward: dict | None, override: str | None = None) -> int:
    for txt in (override, (ward or {}).get("nurse_patient_ratio")):
        m = re.match(r"^\s*1\s*:\s*(\d+)", str(txt or ""))
        if m and int(m.group(1)) > 0:
            return int(m.group(1))
    return WARD_RATIO.get((ward or {}).get("ward_type"), GENERAL_RATIO)


def required_nurses(per: int, census: int, high_acuity: int = 0, ventilated: int = 0) -> int:
    """Nurses needed per shift: ventilated 1:1, other high-acuity 1:2 (or the ward ratio if tighter),
    everyone else at the ward ratio (ICU 1:1, HDU 1:2, general 1:6 — NABH / INC norms)."""
    census = max(0, int(census or 0))
    vent = min(max(0, int(ventilated or 0)), census)
    high = min(max(int(high_acuity or 0), vent), census)
    rest = census - high
    return vent + math.ceil((high - vent) / min(HIGH_ACUITY_RATIO, per)) + math.ceil(rest / per)


async def ward_census(ctx, ward_ids: list[str] | None = None) -> dict[str, int]:
    conds = [beds.c.deleted_at.is_(None), beds.c.status == "Occupied"]
    if ward_ids is not None:
        conds.append(beds.c.ward_id.in_(ward_ids))
    rows = (await ctx.conn.execute(sa.select(beds.c.ward_id, sa.func.count()).where(*conds).group_by(beds.c.ward_id))).all()
    return {str(w): n for w, n in rows if w}


async def _latest_acuity(ctx, ward_id: str, d: date) -> tuple[int, int]:
    rows = await fetch_records(ctx, STAFFING, data_key("ward") == ward_id, data_key("staff_date") <= d.isoformat(),
                               order=data_key("staff_date").desc(), limit=1)
    if not rows:
        return 0, 0
    return int(rows[0].get("high_acuity_patients") or 0), int(rows[0].get("ventilated_patients") or 0)


async def nurse_slot_counts(ctx, ward_ids: list[str] | None, a: date, b: date, shifts: dict) -> dict[tuple[str, str], Counter]:
    """Rostered nurses per (ward, date) and shift slot (M / E / N)."""
    conds = [records.c.status.in_(LIVE), data_key("roster_date") >= a.isoformat(), data_key("roster_date") <= b.isoformat()]
    if ward_ids is not None:
        conds.append(data_key("ward").in_(ward_ids))
    entries = await fetch_records(ctx, ROSTER, *conds)
    emp_ids = {e["employee_id"] for e in entries if e.get("employee_id")}
    nurses = {str(i) for (i,) in (await ctx.conn.execute(
        sa.select(employees.c.id).where(employees.c.id.in_(emp_ids), employees.c.category == "Nurse"))).all()} if emp_ids else set()
    out: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for e in entries:
        slot = SLOT_OF.get((shifts.get(e.get("shift")) or {}).get("shift_type"))
        if slot and e.get("employee_id") in nurses:
            out[(e.get("ward"), e["roster_date"])][slot] += 1
    return out


def _staffing_cell(required: int, counts: Counter) -> dict:
    return {"required": required, **{s: counts.get(s, 0) for s in SLOTS},
            "gap": sum(max(0, required - counts.get(s, 0)) for s in SLOTS)}


@hook(STAFFING, "before_create")
@hook(STAFFING, "before_update")
async def _staffing_compute(ctx, nxt: dict, prev: dict | None = None):
    wards = await labels(ctx, "mdm.wards")
    ward = wards.get(nxt.get("ward"))
    if not ward:
        return
    d = parse_date(nxt.get("staff_date")) or today()
    if nxt.get("census") in (None, ""):
        nxt["census"] = (await ward_census(ctx, [ward["id"]])).get(ward["id"], 0)
    if nxt.get("rostered_nurses") in (None, ""):
        shifts = await shift_map(ctx)
        counts = (await nurse_slot_counts(ctx, [ward["id"]], d, d, shifts)).get((ward["id"], d.isoformat()), Counter())
        slot = SLOT_OF.get((shifts.get(nxt.get("shift")) or {}).get("shift_type"))
        nxt["rostered_nurses"] = counts.get(slot, 0) if slot else min((counts.get(s, 0) for s in SLOTS), default=0)
    per = ward_ratio(ward, nxt.get("target_ratio"))
    if not nxt.get("target_ratio"):
        nxt["target_ratio"] = f"1:{per}"
    nxt["required_nurses"] = required_nurses(per, nxt["census"], nxt.get("high_acuity_patients") or 0, nxt.get("ventilated_patients") or 0)
    nxt["gap"] = max(0, nxt["required_nurses"] - int(nxt.get("rostered_nurses") or 0))


@hr_api.get("/staffing")
async def staffing_board(ctx: CtxDep, day: str | None = Query(None, alias="date")):
    """Hospital-wide nurse staffing for a date: census (current occupancy), ward ratio and rostered nurses per shift."""
    rs.ensure_access(ctx, E(STAFFING), "read")
    d = _date(day) if day else today()
    wards = [w for w in (await labels(ctx, "mdm.wards")).values() if w.get("status") == "Active"]
    census = await ward_census(ctx)
    shifts = await shift_map(ctx)
    counts = await nurse_slot_counts(ctx, None, d, d, shifts)
    out = []
    for w in sorted(wards, key=lambda x: x.get("code") or ""):
        high, vent = await _latest_acuity(ctx, w["id"], d)
        per = ward_ratio(w)
        req = required_nurses(per, census.get(w["id"], 0), high, vent)
        out.append({"ward": w["id"], "code": w.get("code"), "name": w.get("name"), "ward_type": w.get("ward_type"),
                    "ratio": f"1:{per}", "census": census.get(w["id"], 0), "high_acuity": high, "ventilated": vent,
                    **_staffing_cell(req, counts.get((w["id"], d.isoformat()), Counter()))})
    return {"date": d.isoformat(), "wards": out, "total_gap": sum(r["gap"] for r in out)}


class SnapshotIn(BaseModel):
    shift_id: str
    staff_date: date | None = None


@hr_api.post("/staffing/snapshot")
async def staffing_snapshot(body: SnapshotIn, ctx: CtxDep):
    """Record an acuity staffing check per occupied ward for one shift (feeds the shortfall KPI)."""
    rs.ensure_access(ctx, E(STAFFING), "write")
    d = body.staff_date or today()
    shifts = await shift_map(ctx)
    if body.shift_id not in shifts:
        raise bad_request("Choose a shift")
    census = await ward_census(ctx)
    existing = {(r.get("ward"), r.get("shift")): r for r in await fetch_records(ctx, STAFFING, data_key("staff_date") == d.isoformat())}
    n = 0
    for w in (await labels(ctx, "mdm.wards")).values():
        if w.get("status") != "Active" or not census.get(w["id"]):
            continue
        high, vent = await _latest_acuity(ctx, w["id"], d)
        payload = {"ward": w["id"], "staff_date": d.isoformat(), "shift": body.shift_id, "census": census[w["id"]],
                   "high_acuity_patients": high, "ventilated_patients": vent, "rostered_nurses": None}
        cur = existing.get((w["id"], body.shift_id))
        if cur:
            await update(ctx, STAFFING, cur["id"], payload)
        else:
            await create(ctx, STAFFING, payload)
        n += 1
    return {"wards": n, "date": d.isoformat()}


# ====================================================================== roster planner

def _role_for(emp: dict) -> str | None:
    desig = (emp.get("designation") or "").lower()
    cat = emp.get("category")
    if cat == "Nurse":
        return "Charge Nurse" if ("charge" in desig or "supervisor" in desig) else "Staff Nurse"
    return {"Doctor": "Duty Doctor", "Technician": "Technician", "Support": "Support"}.get(cat)


@hook(ROSTER, "before_create")
async def _roster_entry_rules(ctx, draft: dict):
    emp = await fetch_employee(ctx, draft.get("employee_id"))
    if not emp:
        raise bad_request("Choose the employee", {"fields": {"employee_id": "Required"}})
    if emp.get("status") not in IN_SERVICE:
        raise conflict(f"{emp['name']} is {emp.get('status')} and cannot be rostered")
    dup = await fetch_records(ctx, ROSTER, records.c.employee_id == emp["id"], records.c.status.in_(LIVE),
                              data_key("roster_date") == draft.get("roster_date"), data_key("shift") == draft.get("shift"), limit=1)
    if dup:
        raise conflict(f"{emp['name']} already has this shift on {draft.get('roster_date')} ({dup[0]['code']})")
    if not draft.get("role_on_duty"):
        draft["role_on_duty"] = _role_for(emp)
    if draft.get("ward") and not draft.get("department"):
        ward = await get(ctx, "mdm.wards", draft["ward"])
        if ward and ward.get("department"):
            draft["department"] = ward["department"]


@hr_api.get("/roster/options")
async def roster_options(ctx: CtxDep):
    rs.ensure_access(ctx, E(ROSTER), "read")
    wards = sorted((w for w in (await labels(ctx, "mdm.wards")).values() if w.get("status") == "Active"), key=lambda w: w.get("code") or "")
    depts = sorted((await labels(ctx, "mdm.departments")).values(), key=lambda d: d.get("name") or "")
    return {
        "wards": [{"id": w["id"], "code": w.get("code"), "name": w.get("name"), "ward_type": w.get("ward_type"),
                   "ratio": f"1:{ward_ratio(w)}"} for w in wards],
        "departments": [{"id": d["id"], "code": d.get("code"), "name": d.get("name")} for d in depts],
        "shifts": [_shift_out(s) for s in _sorted_shifts(await shift_map(ctx))],
        "categories": CATEGORIES,
    }


async def _grid_employees(ctx, a: date, b: date, ward: str | None, department: str | None,
                          category: str | None, include: list[str]) -> list[dict]:
    t = employees
    filt = []
    if category:
        filt.append(t.c.category == category)
    if department:
        filt.append(t.c.department_id == department)
    if ward:
        in_ward = sa.select(records.c.employee_id).where(
            records.c.module == "roster", records.c.entity == "rosters", records.c.deleted_at.is_(None),
            records.c.status.in_(LIVE), data_key("ward") == ward,
            data_key("roster_date") >= (a - timedelta(days=7)).isoformat(), data_key("roster_date") <= b.isoformat())
        filt.append(sa.or_(t.c.data["ward"].astext == ward, t.c.id.in_(in_ward)))
    scope = sa.and_(*filt) if filt else sa.true()
    if include:
        scope = sa.or_(scope, t.c.id.in_(include))
    rows = await fetch_employees(ctx, t.c.status.in_(IN_SERVICE), scope)
    lead = re.compile(r"supervisor|charge|in-charge|head", re.I)
    rows.sort(key=lambda e: (0 if lead.search(e.get("designation") or "") else 1, e.get("name") or ""))
    return rows[:MAX_GRID_ROWS]


def _cell(e: dict, shift: dict | None, wards: dict, conflicts: list[dict]) -> dict:
    w = wards.get(e.get("ward")) or {}
    return {"id": e["id"], "code": e.get("code"), "shift": e.get("shift"), "label": shift_label(shift),
            "shift_name": (shift or {}).get("name"), "shift_type": (shift or {}).get("shift_type"),
            "start": (shift or {}).get("start_time"), "end": (shift or {}).get("end_time"), "color": (shift or {}).get("color"),
            "status": e.get("status"), "ward": e.get("ward"), "ward_code": w.get("code"), "role_on_duty": e.get("role_on_duty"),
            "changed_after_publish": bool(e.get("changed_after_publish")), "conflicts": conflicts}


@hr_api.get("/roster")
async def roster_grid(ctx: CtxDep, week_start: str | None = None, ward: str | None = None, department: str | None = None,
                      category: str | None = None, include: str | None = None):
    """Employees × 7 days with their shifts, approved leave, conflicts and (for a ward) nurse staffing per day."""
    rs.ensure_access(ctx, E(ROSTER), "read")
    start = _monday(_date(week_start, "week_start") if week_start else today())
    end = start + timedelta(days=6)
    ward, department = _uuid(ward, "ward"), _uuid(department, "department")
    cat = None if category in ("", "All") else (category or ("Nurse" if ward else None))
    if cat and cat not in CATEGORIES:
        raise bad_request(f"Unknown staff category {cat}")
    inc = [i for i in (include or "").split(",") if is_uuid(i)][:50]
    days = date_span(start, end)
    shifts = await shift_map(ctx)
    wards = await labels(ctx, "mdm.wards")
    if ward and ward not in wards:
        raise not_found("Ward not found")
    emps = await _grid_employees(ctx, start, end, ward, department, cat, inc)
    ids = [e["id"] for e in emps]
    conflicts, entries = await _conflicts_for(ctx, ids, start, end, shifts)
    leaves = _group(await leaves_between(ctx, ids, start, end, ("Approved", "Applied")))
    by_emp = _group(entries)
    rows, planned, published, n_conf = [], 0, 0, 0
    for emp in emps:
        cells: dict[str, list[dict]] = defaultdict(list)
        hours = 0.0
        for e in by_emp.get(emp["id"], []):
            sh = shifts.get(e.get("shift"))
            c = _cell(e, sh, wards, conflicts.get(e["id"], []))
            cells[e["roster_date"]].append(c)
            hours += shift_hours(sh)
            planned += e.get("status") == "Planned"
            published += e.get("status") == "Published"
            n_conf += bool(c["conflicts"])
        leave_days = {}
        for lv in leaves.get(emp["id"], []):
            for d in leave_dates(lv):
                if start <= d <= end:
                    leave_days[d.isoformat()] = {"id": lv["id"], "code": lv.get("code"), "leave_type": lv.get("leave_type"),
                                                 "short": LEAVE_SHORT.get(lv.get("leave_type"), "L"), "status": lv.get("status"),
                                                 "half_day": bool(lv.get("half_day"))}
        rows.append({**_brief(emp), "home_ward": emp.get("ward"), "hours": round(hours, 1), "cells": cells, "leave": leave_days})
    staffing = None
    if ward:
        w = wards[ward]
        census = (await ward_census(ctx, [ward])).get(ward, 0)
        high, vent = await _latest_acuity(ctx, ward, end)
        per = ward_ratio(w)
        req = required_nurses(per, census, high, vent)
        counts = await nurse_slot_counts(ctx, [ward], start, end, shifts)
        staffing = {"ward": ward, "ward_name": w.get("name"), "ward_type": w.get("ward_type"), "ratio": f"1:{per}",
                    "census": census, "high_acuity": high, "ventilated": vent, "required_per_shift": req,
                    "days": {d.isoformat(): _staffing_cell(req, counts.get((ward, d.isoformat()), Counter())) for d in days}}
    return {"week_start": start.isoformat(), "days": [d.isoformat() for d in days], "category": cat,
            "shifts": [_shift_out(s) for s in _sorted_shifts(shifts)], "employees": rows, "staffing": staffing,
            "summary": {"employees": len(rows), "planned": planned, "published": published, "conflicts": n_conf}}


class CellIn(BaseModel):
    employee_id: str
    date: date
    shift_id: str | None = None
    ward: str | None = None
    department: str | None = None
    role_on_duty: str | None = None
    mode: Literal["replace", "add"] = "replace"


class CellsIn(BaseModel):
    cells: list[CellIn] = Field(min_length=1, max_length=700)


async def _drop_entry(ctx, e: dict, reason: str) -> None:
    """Drafts disappear; published shifts are cancelled so staff and the audit trail see the change."""
    if e.get("status") == "Planned":
        await rs.delete_record(ctx, E(ROSTER), e["id"], reason=reason, check=False)
    else:
        await update(ctx, ROSTER, e["id"], {"status": "Cancelled", "notes": reason})


@hr_api.put("/roster/cells")
async def roster_cells(body: CellsIn, ctx: CtxDep):
    """Bulk upsert / clear roster cells. New and changed shifts are Planned until the week is published."""
    rs.ensure_access(ctx, E(ROSTER), "write")
    emp_ids = {_uuid(c.employee_id, "employee") for c in body.cells}
    emps = {e["id"]: e for e in await fetch_employees(ctx, employees.c.id.in_(emp_ids))}
    shifts = await shift_map(ctx)
    wards = await labels(ctx, "mdm.wards")
    lo, hi = min(c.date for c in body.cells), max(c.date for c in body.cells)
    if (hi - lo).days > 62:
        raise bad_request("Edit at most two months of the roster at a time")
    index: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for e in await live_entries(ctx, emp_ids, lo, hi):
        index[(e["employee_id"], e["roster_date"])].append(e)
    counts: Counter = Counter()
    for c in body.cells:
        emp = emps.get(c.employee_id)
        if not emp:
            raise not_found("Employee not found")
        if emp.get("status") not in IN_SERVICE:
            raise conflict(f"{emp['name']} is {emp.get('status')} and cannot be rostered")
        ward = _uuid(c.ward, "ward")
        if ward and ward not in wards:
            raise bad_request("Unknown ward")
        key = (c.employee_id, c.date.isoformat())
        current = [e for e in index[key] if not ward or e.get("ward") in (None, ward)]
        if c.shift_id is None:
            for e in current:
                await _drop_entry(ctx, e, "Cleared in the roster planner")
                index[key].remove(e)
                counts["cleared"] += 1
            continue
        sh = shifts.get(c.shift_id)
        if not sh or sh.get("status") != "Active":
            raise bad_request("Choose an active shift")
        if c.mode == "add" or not current:
            if any(e.get("shift") == c.shift_id for e in index[key]):
                counts["unchanged"] += 1
                continue
            rec = await create(ctx, ROSTER, {
                "employee_id": c.employee_id, "roster_date": c.date.isoformat(), "shift": c.shift_id, "ward": ward,
                "department": _uuid(c.department, "department") or (None if ward else emp.get("department_id")),
                "role_on_duty": c.role_on_duty, "status": "Planned"})
            index[key].append(rec)
            counts["created"] += 1
            continue
        keep, *extra = current
        for e in extra:
            await _drop_entry(ctx, e, "Replaced in the roster planner")
            index[key].remove(e)
            counts["cleared"] += 1
        if keep.get("shift") == c.shift_id and (not ward or keep.get("ward") == ward):
            counts["unchanged"] += 1
            continue
        rec = await update(ctx, ROSTER, keep["id"], {
            "shift": c.shift_id, "ward": ward or keep.get("ward"), "status": "Planned",
            "changed_after_publish": keep.get("status") != "Planned" or bool(keep.get("changed_after_publish"))})
        index[key] = [rec if e["id"] == keep["id"] else e for e in index[key]]
        counts["updated"] += 1
    conf, in_range = await _conflicts_for(ctx, emp_ids, lo, hi, shifts)
    return {**{k: counts.get(k, 0) for k in ("created", "updated", "cleared", "unchanged")},
            "conflicts": [{"entry_id": e["id"], "employee_id": e["employee_id"], "date": e["roster_date"], "conflicts": conf[e["id"]]}
                          for e in in_range if conf.get(e["id"])]}


class WeekIn(BaseModel):
    week_start: date
    ward: str | None = None
    department: str | None = None
    force: bool = False
    overwrite: bool = False


def _scope_conds(body: WeekIn) -> list:
    conds = []
    if body.ward:
        conds.append(data_key("ward") == _uuid(body.ward, "ward"))
    if body.department:
        conds.append(data_key("department") == _uuid(body.department, "department"))
    return conds


@hr_api.post("/roster/publish")
async def roster_publish(body: WeekIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(ROSTER), "write")
    start = _monday(body.week_start)
    end = start + timedelta(days=6)
    planned = await fetch_records(ctx, ROSTER, records.c.status == "Planned", data_key("roster_date") >= start.isoformat(),
                                  data_key("roster_date") <= end.isoformat(), *_scope_conds(body))
    if not planned:
        raise bad_request("There are no draft (planned) shifts to publish for this week")
    emp_ids = {p["employee_id"] for p in planned}
    shifts = await shift_map(ctx)
    conf, _ = await _conflicts_for(ctx, emp_ids, start, end, shifts)
    flagged = [p for p in planned if conf.get(p["id"])]
    if flagged and not body.force:
        names = {e["id"]: e["name"] for e in await fetch_employees(ctx, employees.c.id.in_(emp_ids))}
        raise ApiError(409, f"{len(flagged)} shift(s) have conflicts — resolve them or publish anyway",
                       {"conflicts": [{"employee": names.get(p["employee_id"]), "date": p["roster_date"],
                                       "messages": [c["message"] for c in conf[p["id"]]]} for p in flagged[:50]]},
                       code="ROSTER_CONFLICTS")
    ts = now().isoformat(timespec="seconds")
    for p in planned:
        await update(ctx, ROSTER, p["id"], {"status": "Published", "published_at": ts, "published_by": ctx.user.get("name"),
                                            "changed_after_publish": False})
    note = f"Week of {start.isoformat()}: {len(planned)} shifts for {len(emp_ids)} staff" + (f", {len(flagged)} with conflicts" if flagged else "")
    await audit(ctx, "roster.publish", module="roster", entity="rosters", after={"ward": body.ward, "department": body.department}, note=note)
    await emit("roster.published", ctx, {"week_start": start.isoformat(), "ward": body.ward, "department": body.department,
                                         "employee_ids": sorted(emp_ids), "shifts": len(planned)})
    return {"published": len(planned), "employees": len(emp_ids), "with_conflicts": len(flagged)}


@hr_api.post("/roster/copy")
async def roster_copy(body: WeekIn, ctx: CtxDep):
    """Copy last week's shifts into this week as drafts (skips staff on leave or already rostered)."""
    rs.ensure_access(ctx, E(ROSTER), "write")
    start = _monday(body.week_start)
    src_start = start - timedelta(days=7)
    src = await fetch_records(ctx, ROSTER, records.c.status.in_(LIVE), data_key("roster_date") >= src_start.isoformat(),
                              data_key("roster_date") <= (start - timedelta(days=1)).isoformat(), *_scope_conds(body),
                              order=data_key("roster_date"))
    if not src:
        raise bad_request("Last week has no shifts to copy for this selection")
    emp_ids = {s["employee_id"] for s in src}
    emps = {e["id"]: e for e in await fetch_employees(ctx, employees.c.id.in_(emp_ids))}
    existing = _group(await live_entries(ctx, emp_ids, start, start + timedelta(days=6)), "employee_id")
    on_leave = {(lv["employee_id"], d.isoformat()) for lv in await leaves_between(ctx, emp_ids, start, start + timedelta(days=6))
                if not lv.get("half_day") for d in leave_dates(lv)}
    created, skipped = 0, Counter()
    for s in src:
        emp = emps.get(s["employee_id"])
        if not emp or emp.get("status") not in IN_SERVICE:
            skipped["not_in_service"] += 1
            continue
        d = (parse_date(s["roster_date"]) + timedelta(days=7)).isoformat()
        if (emp["id"], d) in on_leave:
            skipped["on_leave"] += 1
            continue
        current = [e for e in existing.get(emp["id"], []) if e["roster_date"] == d]
        if current:
            if not body.overwrite or any(e.get("status") != "Planned" for e in current):
                skipped["already_rostered"] += 1
                continue
            for e in current:
                await _drop_entry(ctx, e, "Overwritten by copy of previous week")
                existing[emp["id"]].remove(e)
        rec = await create(ctx, ROSTER, {"employee_id": emp["id"], "roster_date": d, "shift": s.get("shift"), "ward": s.get("ward"),
                                         "department": s.get("department"), "role_on_duty": s.get("role_on_duty"),
                                         "notes": f"Copied from {s.get('code')}", "status": "Planned"})
        existing[emp["id"]].append(rec)
        created += 1
    return {"created": created, "skipped": dict(skipped)}


# ====================================================================== attendance

async def _rostered_shift(ctx, emp: dict, d: date, at: datetime | None, shifts: dict) -> str | None:
    entries = await fetch_records(ctx, ROSTER, records.c.employee_id == emp["id"], records.c.status.in_(LIVE),
                                  data_key("roster_date") == d.isoformat())
    if entries:
        def distance(e: dict) -> float:
            w = shift_window(d, shifts.get(e.get("shift")))
            return abs((w[0] - at).total_seconds()) if w and at else 0.0
        entries.sort(key=lambda e: (e.get("status") != "Published", distance(e)))
        return entries[0].get("shift")
    if emp.get("category") in GENERAL_SHIFT_CATEGORIES:
        general = next((s for s in _sorted_shifts(shifts) if s.get("shift_type") == "General" and s.get("status") == "Active"), None)
        return general["id"] if general else None
    return None


@hook(ATTENDANCE, "before_create")
@hook(ATTENDANCE, "before_update")
async def _attendance_derive(ctx, nxt: dict, prev: dict | None = None):
    """Hours worked, late minutes (vs rostered shift start + grace), overtime and Present / Half Day."""
    cin, cout = parse_dt(nxt.get("check_in")), parse_dt(nxt.get("check_out"))
    if not cin:
        if cout:
            raise bad_request("Record the check-in before the check-out", {"fields": {"check_in": "Required"}})
        return
    if cout and cout <= cin:
        raise bad_request("Check-out must be after check-in", {"fields": {"check_out": "Must be after check-in"}})
    if cout and cout - cin > timedelta(hours=24):
        raise bad_request("A single attendance record cannot exceed 24 hours", {"fields": {"check_out": "Too long"}})
    shift = await get(ctx, SHIFTS, nxt["shift"]) if nxt.get("shift") else None
    d = parse_date(nxt.get("att_date")) or cin.astimezone(settings.tz).date()
    w = shift_window(d, shift)
    late = 0
    if w:
        mins = int((cin - w[0]).total_seconds() // 60)
        grace = shift.get("grace_minutes")
        late = mins if mins > (LATE_GRACE_MINUTES if grace in (None, "") else int(grace)) else 0
    nxt["late_minutes"] = late
    if cout:
        hours = round((cout - cin).total_seconds() / 3600, 2)
        nxt["hours_worked"] = hours
        if prev is None or parse_dt(prev.get("check_out")) != cout or nxt.get("overtime_hours") is None:
            nxt["overtime_hours"] = round(max(0.0, hours - (shift_hours(shift) or STANDARD_DAY_HOURS)), 2)
        if nxt.get("status") in (None, "Present", "Half Day", "Absent", "On Leave"):
            nxt["status"] = "Half Day" if hours < HALF_DAY_HOURS else "Present"
    else:
        nxt["hours_worked"] = None
        if nxt.get("status") in (None, "Absent", "On Leave", "Half Day"):
            nxt["status"] = "Present"


def _closes_overnight(row: dict, at: datetime, shifts: dict) -> bool:
    """Whether a punch on the next day is the check-out of yesterday's open (night) shift."""
    cin = parse_dt(row["check_in"])
    w = shift_window(parse_date(row["att_date"]), shifts.get(row.get("shift")))
    if w and w[1].date() > w[0].date():
        return cin < at <= w[1] + timedelta(hours=6)
    return cin < at <= cin + timedelta(hours=16)


async def record_punch(ctx, emp: dict, at: datetime, source: str, device: str | None = None, remarks: str | None = None) -> dict:
    """First punch of the day = check-in, later punches = check-out (the last one wins).
    A morning punch closes the previous night's open shift."""
    d = at.astimezone(settings.tz).date()
    recent = await fetch_records(ctx, ATTENDANCE, records.c.employee_id == emp["id"],
                                 data_key("att_date") >= (d - timedelta(days=1)).isoformat(), data_key("att_date") <= d.isoformat())
    today_row = next((r for r in recent if r.get("att_date") == d.isoformat()), None)
    stamps = [(r, parse_dt(r.get(k))) for r in recent for k in ("check_in", "check_out") if r.get(k)]
    dup = next((r for r, s in stamps if abs((at - s).total_seconds()) < DUPLICATE_PUNCH_SECONDS), None)
    if dup:
        return {"action": "duplicate", "attendance": dup, "employee": _brief(emp), "message": "Punch already recorded"}
    shifts = await shift_map(ctx)
    open_prev = next((r for r in recent if r.get("att_date") != d.isoformat() and r.get("check_in") and not r.get("check_out")
                      and _closes_overnight(r, at, shifts)), None)
    note = (remarks or "").strip() or None
    if open_prev or (today_row and today_row.get("check_in")):
        row = open_prev or today_row
        cin = parse_dt(row["check_in"])
        payload: dict[str, Any] = {"check_out_source": source, "check_out_device": device}
        if at < cin:  # an earlier punch synced late from an offline terminal
            payload.update(check_in=at.isoformat(), check_out=row.get("check_out") or cin.isoformat())
        else:
            payload["check_out"] = at.isoformat()
        if note:
            payload["remarks"] = "; ".join(x for x in (row.get("remarks"), f"Out: {note}") if x)
        rec = await update(ctx, ATTENDANCE, row["id"], payload)
        action = "check_out"
    else:
        payload = {"att_date": d.isoformat(), "check_in": at.isoformat(), "shift": await _rostered_shift(ctx, emp, d, at, shifts),
                   "source": source, "device": device, "status": "Present", "remarks": note}
        if today_row:  # a day pre-marked On Leave / Absent: the employee came to work
            payload["remarks"] = "; ".join(x for x in (note, f"Punched in on a day marked {today_row.get('status')}") if x)
            rec = await update(ctx, ATTENDANCE, today_row["id"], payload)
        else:
            rec = await create(ctx, ATTENDANCE, {**payload, "employee_id": emp["id"]})
        action = "check_in"
    if action == "check_in":
        msg = f"Checked in at {at.astimezone(settings.tz):%H:%M}" + (f" — {rec.get('late_minutes')} min late" if rec.get("late_minutes") else "")
    else:
        msg = f"Checked out at {at.astimezone(settings.tz):%H:%M} — {rec.get('hours_worked') or 0:g} h worked"
    return {"action": action, "attendance": rec, "employee": _brief(emp), "message": msg}


def _check_device_key(presented: str) -> None:
    expected = os.environ.get("BIOMETRIC_DEVICE_KEY", "")
    if not expected:
        if settings.env == "production":
            raise ApiError(503, "Device punching is not configured on this server (BIOMETRIC_DEVICE_KEY)")
        log.warning("BIOMETRIC_DEVICE_KEY is not set — accepting device punches without a key (development only)")
        return
    if not hmac.compare_digest(presented.encode(), expected.encode()):
        raise ApiError(401, "Invalid device key")


async def _punch_ctx(request: Request) -> AsyncIterator[Ctx]:
    """Attendance terminals authenticate with the shared `X-Device-Key`; everyone else with a staff token."""
    key = request.headers.get("x-device-key")
    if key is None:
        async with asynccontextmanager(get_ctx)(request) as ctx:
            yield ctx
        return
    _check_device_key(key)
    async with asynccontextmanager(get_public_ctx)(request) as ctx:
        ctx.user = {"id": "device", "name": "Attendance device", "role": DEVICE_ROLE}
        yield ctx


PunchCtxDep = Annotated[Ctx, Depends(_punch_ctx, scope="function")]


class PunchIn(BaseModel):
    employee_id: str | None = None
    employee_code: str | None = Field(default=None, max_length=40)
    device_id: str | None = Field(default=None, max_length=80)
    source: Literal["Biometric", "Face Recognition", "Mobile Geo-fence", "Manual"] = "Biometric"
    at: datetime | None = None
    remarks: str | None = Field(default=None, max_length=300)


@hr_api.post("/attendance/punch")
async def punch(body: PunchIn, ctx: PunchCtxDep):
    device = ctx.role == DEVICE_ROLE
    hr_user = ctx.role in ("hr", "admin")
    if device:
        if body.source == "Manual":
            raise bad_request("Devices record Biometric, Face Recognition or Mobile Geo-fence punches")
        ctx.user["name"] = f"Attendance device {body.device_id}" if body.device_id else "Attendance device"
    if body.employee_id:
        emp = await fetch_employee(ctx, body.employee_id)
    elif body.employee_code:
        found = await fetch_employees(ctx, employees.c.code == body.employee_code.strip().upper())
        emp = found[0] if found else None
    else:
        raise bad_request("Give the employee code or employee id")
    if not emp:
        raise not_found("No employee with that code")
    if not device and not hr_user:
        if emp["id"] != ctx.user.get("employee_id"):
            raise forbidden("You can only record your own attendance")
        if body.source != "Mobile Geo-fence" or body.at:
            raise bad_request("Self check-in uses the mobile geo-fence punch at the current time")
    if not device and hr_user and body.source == "Manual" and not (body.remarks or "").strip():
        raise bad_request("Give a reason for the manual punch", {"fields": {"remarks": "Required for manual punches"}})
    t_now = now()
    at = body.at or t_now
    if at.tzinfo is None:
        at = at.replace(tzinfo=settings.tz)
    if at > t_now + timedelta(minutes=5):
        raise bad_request("Punch time cannot be in the future")
    if at < t_now - timedelta(days=MAX_BACKDATE_DAYS):
        raise bad_request(f"Punches older than {MAX_BACKDATE_DAYS} days must be corrected in the attendance register")
    if emp.get("status") not in IN_SERVICE:
        raise conflict(f"{emp['name']} is {emp.get('status')}")
    return await record_punch(ctx, emp, at, body.source, body.device_id, body.remarks)


async def _dept_names(ctx) -> dict[str, str]:
    return {k: v.get("name") or v.get("title") for k, v in (await labels(ctx, "mdm.departments")).items()}


@hr_api.get("/attendance/board")
async def attendance_board(ctx: CtxDep, day: str | None = Query(None, alias="date"), department: str | None = None):
    """Who is in, late, absent (rostered without a punch) or on leave, by department."""
    rs.ensure_access(ctx, E(ATTENDANCE), "read")
    d = _date(day) if day else today()
    department = _uuid(department, "department")
    conds = [employees.c.status.in_(IN_SERVICE)]
    if department:
        conds.append(employees.c.department_id == department)
    emps = {e["id"]: e for e in await fetch_employees(ctx, *conds)}
    att = {r["employee_id"]: r for r in await fetch_records(ctx, ATTENDANCE, data_key("att_date") == d.isoformat())
           if r.get("employee_id") in emps}
    rost = {k: v for k, v in _group(await fetch_records(ctx, ROSTER, records.c.status.in_(LIVE),
                                                        data_key("roster_date") == d.isoformat())).items() if k in emps}
    leaves = {lv["employee_id"]: lv for lv in await leaves_between(ctx, list(emps), d, d) if not lv.get("half_day")}
    shifts = await shift_map(ctx)
    wards = await labels(ctx, "mdm.wards")
    depts = await _dept_names(ctx)
    t_now = now()
    rows = []
    for emp_id in set(att) | set(rost) | set(leaves):
        emp, a, entries, lv = emps[emp_id], att.get(emp_id), rost.get(emp_id, []), leaves.get(emp_id)
        shift = shifts.get((a or {}).get("shift") or (entries[0].get("shift") if entries else None))
        w = shift_window(d, shift)
        if a and a.get("check_in"):
            state = a.get("status") or "Present"
        elif (a and a.get("status") == "On Leave") or lv:
            state = "On Leave"
        elif a and a.get("status") in ("Absent", "Holiday", "Weekly Off"):
            state = a["status"]
        elif entries:
            grace = (shift or {}).get("grace_minutes") or LATE_GRACE_MINUTES
            started = w is None or t_now > w[0] + timedelta(minutes=int(grace))
            state = "Absent" if d < t_now.date() or (d == t_now.date() and started) else "Expected"
        else:
            continue
        entry = entries[0] if entries else {}
        rows.append({
            "employee_id": emp_id, "code": emp.get("code"), "name": emp.get("name"), "category": emp.get("category"),
            "designation": emp.get("designation"), "department_id": emp.get("department_id"),
            "department": depts.get(emp.get("department_id")) or "—", "ward_code": (wards.get(entry.get("ward")) or {}).get("code"),
            "shift": shift_label(shift) if shift else None, "shift_name": (shift or {}).get("name"),
            "shift_start": (shift or {}).get("start_time"), "shift_end": (shift or {}).get("end_time"), "rostered": bool(entries),
            "attendance_id": (a or {}).get("id"), "check_in": (a or {}).get("check_in"), "check_out": (a or {}).get("check_out"),
            "hours_worked": (a or {}).get("hours_worked"), "late_minutes": (a or {}).get("late_minutes") or 0,
            "overtime_hours": (a or {}).get("overtime_hours") or 0, "source": (a or {}).get("source"), "state": state,
            "leave_type": (lv or {}).get("leave_type"), "remarks": (a or {}).get("remarks"),
        })
    rows.sort(key=lambda r: (r["department"], r["name"] or ""))
    present = [r for r in rows if r["state"] in ("Present", "Half Day")]

    def tally(rs_: list[dict]) -> dict:
        return {"present": sum(r["state"] in ("Present", "Half Day") for r in rs_), "late": sum(r["state"] in ("Present", "Half Day") and r["late_minutes"] > 0 for r in rs_),
                "absent": sum(r["state"] == "Absent" for r in rs_), "on_leave": sum(r["state"] == "On Leave" for r in rs_),
                "expected": sum(r["state"] == "Expected" for r in rs_), "rostered": sum(r["rostered"] for r in rs_)}

    by_dept = []
    for name, group in sorted(_group(rows, "department").items()):
        by_dept.append({"department": name, "department_id": group[0]["department_id"], **tally(group)})
    return {"date": d.isoformat(), "kpis": {**tally(rows), "staff": len(emps), "not_recorded": len(emps) - len(rows),
                                            "overtime_hours": round(sum(float(r["overtime_hours"] or 0) for r in present), 2)},
            "by_department": by_dept, "rows": rows, "as_of": t_now.isoformat(timespec="seconds")}


async def mark_absentees(ctx, d: date) -> int:
    """Close a day: rostered staff with no punch and no approved leave are marked Absent (drives LOP)."""
    entries = _group(await fetch_records(ctx, ROSTER, records.c.status.in_(LIVE), data_key("roster_date") == d.isoformat()))
    if not entries:
        return 0
    have = {r["employee_id"] for r in await fetch_records(ctx, ATTENDANCE, data_key("att_date") == d.isoformat())}
    on_leave = {lv["employee_id"] for lv in await leaves_between(ctx, list(entries), d, d) if not lv.get("half_day")}
    active = {e["id"] for e in await fetch_employees(ctx, employees.c.id.in_(list(entries)), employees.c.status.in_(IN_SERVICE))}
    n = 0
    for emp_id, es in entries.items():
        if emp_id in have or emp_id in on_leave or emp_id not in active:
            continue
        await create(ctx, ATTENDANCE, {"employee_id": emp_id, "att_date": d.isoformat(), "shift": es[0].get("shift"), "source": None,
                                       "status": "Absent", "remarks": "No punch against the rostered shift (day closed)"})
        n += 1
    return n


class CloseDayIn(BaseModel):
    att_date: date


@hr_api.post("/attendance/close-day")
async def close_day(body: CloseDayIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(ATTENDANCE), "write")
    if ctx.role not in ("hr", "admin"):
        raise forbidden("Only HR can close attendance for a day")
    if body.att_date >= today():
        raise bad_request("A day can be closed only after it has ended")
    n = await mark_absentees(ctx, body.att_date)
    await audit(ctx, "attendance.close_day", module="roster", entity="attendance", note=f"{body.att_date}: {n} marked absent")
    return {"marked_absent": n}


# ====================================================================== leave

async def leave_balances(ctx, emp_id: str, year: int, exclude_id: str | None = None) -> list[dict]:
    a, b = date(year, 1, 1), date(year, 12, 31)
    rows = [lv for lv in await leaves_between(ctx, [emp_id], a, b, ("Applied", "Approved")) if lv["id"] != exclude_id]
    out = []
    for typ, entitled in LEAVE_ENTITLEMENT.items():
        used = sum(leave_days_within(lv, a, b) for lv in rows if lv.get("leave_type") == typ and lv["status"] == "Approved")
        pending = sum(leave_days_within(lv, a, b) for lv in rows if lv.get("leave_type") == typ and lv["status"] == "Applied")
        out.append({"type": typ, "short": LEAVE_SHORT[typ], "entitled": entitled, "used": used, "pending": pending,
                    "available": max(0.0, entitled - used - pending)})
    return out


@hook(LEAVES, "before_create")
@hook(LEAVES, "before_update")
async def _leave_rules(ctx, nxt: dict, prev: dict | None = None):
    f, t = parse_date(nxt.get("from_date")), parse_date(nxt.get("to_date"))
    if not f or not t:
        return
    if t < f:
        raise bad_request("'To' date is before the 'From' date", {"fields": {"to_date": "Must be on or after the from date"}})
    if nxt.get("half_day") and f != t:
        raise bad_request("A half-day leave must be for a single date", {"fields": {"half_day": "Single date only"}})
    nxt["days"] = 0.5 if nxt.get("half_day") else float((t - f).days + 1)
    if prev and all(prev.get(k) == nxt.get(k) for k in ("from_date", "to_date", "leave_type", "half_day", "employee_id")):
        return
    if nxt.get("status") not in (None, "Applied", "Approved"):
        return
    emp_id = nxt.get("employee_id")
    others = [lv for lv in await leaves_between(ctx, [emp_id], f, t, ("Applied", "Approved")) if lv["id"] != nxt.get("id")]
    if others:
        o = others[0]
        raise conflict(f"Overlaps {o.get('leave_type')} leave {o.get('code')} ({o.get('from_date')} to {o.get('to_date')})")
    typ = nxt.get("leave_type")
    if typ in LEAVE_ENTITLEMENT:
        for year in sorted({f.year, t.year}):
            need = leave_days_within(nxt, date(year, 1, 1), date(year, 12, 31))
            bal = next(x for x in await leave_balances(ctx, emp_id, year, exclude_id=nxt.get("id")) if x["type"] == typ)
            if need > bal["available"]:
                raise bad_request(f"Only {bal['available']:g} {typ.lower()} leave day(s) left for {year} "
                                  f"({bal['used']:g} taken, {bal['pending']:g} pending). Apply the rest as another leave type.")
    if typ == "Maternity" and nxt["days"] > MATERNITY_MAX_DAYS:
        raise bad_request(f"Maternity leave is up to {MATERNITY_MAX_DAYS} days (26 weeks)")
    if (typ == "Sick" and nxt["days"] > 2 or typ == "Maternity") and not nxt.get("attachment"):
        raise bad_request("Attach a medical certificate for this leave", {"fields": {"attachment": "Medical certificate required"}})


@hook(LEAVES, "before_transition")
async def _leave_approver(ctx, nxt: dict, prev: dict):
    if nxt.get("status") in ("Approved", "Rejected") and nxt.get("employee_id") and nxt["employee_id"] == ctx.user.get("employee_id"):
        raise forbidden("You cannot decide your own leave request")


@hook(LEAVES, "after_transition")
async def _leave_effects(ctx, rec: dict, prev: dict):
    if rec.get("status") == "Approved" and prev.get("status") != "Approved":
        await _apply_leave(ctx, rec)
        await emit("leave.approved", ctx, {"leave": rec})
    elif rec.get("status") == "Cancelled" and prev.get("status") == "Approved":
        await _revert_leave(ctx, rec)
    elif rec.get("status") == "Rejected":
        await emit("leave.rejected", ctx, {"leave": rec})


async def _apply_leave(ctx, lv: dict) -> None:
    """Approved leave: an 'On Leave' attendance row per day (existing rows kept) and overlapping shifts cancelled."""
    if lv.get("half_day"):
        return
    days = leave_dates(lv)
    if not days:
        return
    emp_id = lv["employee_id"]
    have = {r["att_date"] for r in await fetch_records(ctx, ATTENDANCE, records.c.employee_id == emp_id,
                                                        data_key("att_date") >= days[0].isoformat(), data_key("att_date") <= days[-1].isoformat())}
    for d in days:
        if d.isoformat() not in have:
            await create(ctx, ATTENDANCE, {"employee_id": emp_id, "att_date": d.isoformat(), "status": "On Leave", "source": None,
                                           "remarks": f"{lv.get('leave_type')} leave {lv.get('code')}", "leave_id": lv["id"]})
    for e in await live_entries(ctx, [emp_id], days[0], days[-1]):
        await update(ctx, ROSTER, e["id"], {"status": "Cancelled", "notes": f"Cancelled — approved leave {lv.get('code')}"})


async def _revert_leave(ctx, lv: dict) -> None:
    rows = await fetch_records(ctx, ATTENDANCE, records.c.employee_id == lv["employee_id"], data_key("leave_id") == lv["id"],
                               records.c.status == "On Leave")
    for r in rows:
        if not r.get("check_in"):
            await rs.delete_record(ctx, E(ATTENDANCE), r["id"], reason=f"Leave {lv.get('code')} cancelled", check=False)


# ====================================================================== credentials & licences

def expiry_status(valid_until: date | None, ref: date) -> str | None:
    if not valid_until:
        return None
    if valid_until < ref:
        return "Expired"
    if valid_until <= ref + timedelta(days=EXPIRY_WINDOW_DAYS):
        return "Expiring"
    return "Valid"


async def refresh_credentials(ctx) -> dict:
    """Mark credentials Valid / Expiring (≤ 60 days) / Expired and flag employee registration licences."""
    ref = today()
    changed: list[dict] = []
    for c in await fetch_records(ctx, CREDENTIALS):
        st = expiry_status(parse_date(c.get("valid_until")), ref)
        if st and st != c.get("status"):
            await update(ctx, CREDENTIALS, c["id"], {"status": st})
            changed.append({"kind": "credential", "id": c["id"], "employee_id": c.get("employee_id"),
                            "what": c.get("credential_type"), "valid_until": c.get("valid_until"), "status": st})
    for e in await fetch_employees(ctx, employees.c.license_expiry.isnot(None), employees.c.status.in_(IN_SERVICE)):
        st = expiry_status(parse_date(e.get("license_expiry")), ref)
        prev = e.get("license_status")
        if st == prev or (st == "Valid" and prev is None):
            continue
        await update(ctx, EMPLOYEES, e["id"], {"license_status": st})
        changed.append({"kind": "licence", "id": e["id"], "employee_id": e["id"], "what": "Registration licence",
                        "valid_until": e.get("license_expiry"), "status": st})
    for c in changed:
        if c["status"] in ("Expiring", "Expired"):
            await emit("credential.expiring", ctx, c)
    return {"checked_on": ref.isoformat(), "changed": len(changed),
            "expiring": sum(c["status"] == "Expiring" for c in changed), "expired": sum(c["status"] == "Expired" for c in changed)}


@hook(CREDENTIALS, "before_create")
@hook(CREDENTIALS, "before_update")
async def _credential_status(ctx, nxt: dict, prev: dict | None = None):
    nxt["status"] = expiry_status(parse_date(nxt.get("valid_until")), today()) or nxt.get("status")


async def credentials_job(_arq: dict | None = None) -> dict:
    async with system_ctx() as ctx:
        return await refresh_credentials(ctx)


async def absentee_job(_arq: dict | None = None) -> int:
    async with system_ctx() as ctx:
        return await mark_absentees(ctx, today() - timedelta(days=1))


CRON = [(credentials_job, {"hour": 6, "minute": 0}), (absentee_job, {"hour": 2, "minute": 15})]


@hr_api.post("/credentials/refresh")
async def credentials_refresh(ctx: CtxDep):
    rs.ensure_access(ctx, E(CREDENTIALS), "write")
    return await refresh_credentials(ctx)


@hr_api.get("/credentials/alerts")
async def credential_alerts(ctx: CtxDep, days: int = Query(EXPIRY_WINDOW_DAYS, ge=1, le=365)):
    """Expired and soon-expiring credentials and registration licences, soonest first."""
    rs.ensure_access(ctx, E(CREDENTIALS), "read")
    ref = today()
    horizon = (ref + timedelta(days=days)).isoformat()
    depts = await _dept_names(ctx)
    emps = {e["id"]: e for e in await fetch_employees(ctx, employees.c.status.in_(IN_SERVICE))}
    out = []
    for c in await fetch_records(ctx, CREDENTIALS, data_key("valid_until") <= horizon):
        emp = emps.get(c.get("employee_id"))
        if emp:
            out.append({"kind": "credential", "id": c["id"], "code": c.get("code"), "credential_type": c.get("credential_type"),
                        "number": c.get("number"), "valid_until": c.get("valid_until")} | _alert_emp(emp, depts))
    for emp in emps.values():
        if emp.get("license_expiry") and emp["license_expiry"] <= horizon:
            out.append({"kind": "licence", "id": emp["id"], "code": emp.get("code"), "credential_type": "Registration licence",
                        "number": emp.get("license_no"), "valid_until": emp["license_expiry"]} | _alert_emp(emp, depts))
    for r in out:
        r["days_left"] = (parse_date(r["valid_until"]) - ref).days
        r["status"] = expiry_status(parse_date(r["valid_until"]), ref)
    out.sort(key=lambda r: r["days_left"])
    return {"as_of": ref.isoformat(), "window_days": days, "expired": sum(r["status"] == "Expired" for r in out),
            "expiring": sum(r["status"] != "Expired" for r in out), "rows": out}


def _alert_emp(emp: dict, depts: dict[str, str]) -> dict:
    return {"employee_id": emp["id"], "employee_code": emp.get("code"), "employee_name": emp.get("name"),
            "category": emp.get("category"), "designation": emp.get("designation"), "department": depts.get(emp.get("department_id"))}


# ====================================================================== onboarding, health, training

@hook(ONBOARDING, "before_transition")
async def _onboarding_joined(ctx, nxt: dict, prev: dict):
    """Marking a candidate Joined creates the employee master record and starts statutory onboarding."""
    if nxt.get("status") != "Joined" or nxt.get("employee"):
        return
    expected = parse_date(nxt.get("expected_doj"))
    doj = expected if expected and expected <= today() else today()
    emp = await create(ctx, EMPLOYEES, {
        "name": nxt.get("candidate_name"), "category": nxt.get("category"), "designation": nxt.get("position"),
        "department_id": nxt.get("department"), "phone": nxt.get("phone"), "email": nxt.get("email"), "doj": doj.isoformat(),
        "employment_type": "Permanent", "status": "Active", "onboarding_id": nxt.get("id"), "offered_ctc": nxt.get("offered_ctc")})
    nxt["employee"] = emp["id"]
    if nxt.get("cv") and has("employees.documents"):
        await create(ctx, "employees.documents", {"employee_id": emp["id"], "doc_type": "Resume / CV", "file": nxt["cv"],
                                                  "status": "Pending Verification"})
    await _schedule_joining_health(ctx, emp, doj)
    await assign_mandatory_training(ctx, emp)
    await emit("employee.joined", ctx, {"employee": emp, "onboarding_id": nxt.get("id")})


async def _schedule_joining_health(ctx, emp: dict, doj: date) -> None:
    if has("occhealth.health_checks"):
        await create(ctx, "occhealth.health_checks", {"employee_id": emp["id"], "check_type": "Pre-employment",
                                                       "check_date": doj.isoformat(), "status": "Scheduled"})
    if has("occhealth.vaccinations") and emp.get("category") in CLINICAL_CATEGORIES:
        await create(ctx, "occhealth.vaccinations", {"employee_id": emp["id"], "vaccine": "Hepatitis B", "dose": "Dose 1",
                                                      "due_date": doj.isoformat(), "status": "Due"})


def _applies(applicable: Iterable[str] | str | None, category: str | None) -> bool:
    vals = [applicable] if isinstance(applicable, str) else list(applicable or [])
    return not vals or "All staff" in vals or (category in vals)


async def _mandatory_requirements(ctx, emp: dict) -> list[dict]:
    """Courses an employee must complete: the mandatory training matrix plus courses flagged mandatory."""
    if not has("training.courses"):
        return []
    courses = await labels(ctx, "training.courses")
    out: dict[str, dict] = {}
    for r in await fetch_records(ctx, "training.requirements", records.c.status == "Active"):
        if r.get("course") not in courses or not _applies(r.get("applies_to"), emp.get("category")):
            continue
        if r.get("department") and r["department"] != emp.get("department_id"):
            continue
        if r.get("ward") and r["ward"] != emp.get("ward"):
            continue
        out[r["course"]] = {"course": courses[r["course"]], "due_within_days": r.get("due_within_days") or 30,
                            "regulatory_basis": r.get("regulatory_basis")}
    for c in courses.values():
        if c.get("status") == "Active" and c.get("mandatory") and c["id"] not in out and _applies(c.get("applicable_to"), emp.get("category")):
            out[c["id"]] = {"course": c, "due_within_days": 30, "regulatory_basis": None}
    return list(out.values())


async def assign_mandatory_training(ctx, emp: dict) -> int:
    if not has("training.training_records"):
        return 0
    have = {r.get("course") for r in await fetch_records(ctx, "training.training_records", records.c.employee_id == emp["id"])}
    doj = parse_date(emp.get("doj")) or today()
    n = 0
    for req in await _mandatory_requirements(ctx, emp):
        if req["course"]["id"] in have:
            continue
        await create(ctx, "training.training_records", {
            "employee_id": emp["id"], "course": req["course"]["id"], "assigned_on": today().isoformat(),
            "due_date": max(today(), doj + timedelta(days=int(req["due_within_days"]))).isoformat(), "mandatory": True,
            "status": "Assigned"})
        n += 1
    return n


@hook("training.training_records", "before_create")
async def _training_defaults(ctx, draft: dict):
    course = await get(ctx, "training.courses", draft.get("course")) if draft.get("course") else None
    if course and draft.get("mandatory") is None:
        draft["mandatory"] = bool(course.get("mandatory"))
    if not draft.get("due_date"):
        start = parse_date(draft.get("assigned_on")) or today()
        draft["due_date"] = (start + timedelta(days=30)).isoformat()


@hook("training.training_records", "before_transition")
async def _training_validity(ctx, nxt: dict, prev: dict):
    if nxt.get("status") != "Completed" or nxt.get("valid_until"):
        return
    course = await get(ctx, "training.courses", nxt.get("course")) if nxt.get("course") else None
    done = parse_date(nxt.get("completed_on"))
    if course and course.get("refresher_months") and done:
        nxt["valid_until"] = add_months(done, int(course["refresher_months"])).isoformat()


@hook("occhealth.health_checks", "before_create")
@hook("occhealth.health_checks", "before_update")
async def _health_check_derive(ctx, nxt: dict, prev: dict | None = None):
    h, w = nxt.get("height_cm"), nxt.get("weight_kg")
    if h and w and float(h) > 0:
        nxt["bmi"] = round(float(w) / (float(h) / 100) ** 2, 1)
    periodic = ("Pre-employment", "Annual (periodic)", "Radiation worker", "Night-shift worker", "Food handler (FSSAI)")
    checked = parse_date(nxt.get("check_date"))
    if not nxt.get("next_due") and checked and nxt.get("check_type") in periodic:
        nxt["next_due"] = add_months(checked, 12).isoformat()


# ====================================================================== self-service (/api/ess)

async def _me(ctx) -> dict:
    emp = await fetch_employee(ctx, ctx.user.get("employee_id"))
    if not emp:
        raise forbidden("Your login is not linked to an employee profile. Please contact HR.")
    return emp


def _mask(v: Any, keep: int = 4) -> str | None:
    s = "".join(str(v or "").split())
    return None if not s else ("X" * max(0, len(s) - keep) + s[-keep:])


def _owner_ref(emp_id: str) -> str:
    """Opaque link between an anonymous grievance and its author (reviewers cannot reverse it)."""
    return hmac.new(settings.jwt_secret.encode(), f"ess-grievance:{emp_id}".encode(), hashlib.sha256).hexdigest()[:40]


@ess_api.get("/me")
async def ess_me(ctx: CtxDep):
    emp = await _me(ctx)
    manager = await fetch_employee(ctx, emp.get("reporting_to"))
    depts = await _dept_names(ctx)
    ward = await get(ctx, "mdm.wards", emp["ward"]) if emp.get("ward") else None
    lic = parse_date(emp.get("license_expiry"))
    t = today()
    profile_keys = ("id", "code", "name", "category", "designation", "employment_type", "doj", "dob", "gender", "phone", "email",
                    "qualification", "specialization", "registration_council", "license_no", "license_expiry", "uan", "esi_no",
                    "ifsc", "address", "emergency_contact", "status", "photo")
    att = await fetch_records(ctx, ATTENDANCE, records.c.employee_id == emp["id"], data_key("att_date") == t.isoformat(), limit=1)
    shifts = await shift_map(ctx)
    upcoming = [e for e in await live_entries(ctx, [emp["id"]], t, t + timedelta(days=13)) if e.get("status") != "Planned"]
    nxt = upcoming[0] if upcoming else None
    return {
        "employee": {**{k: emp.get(k) for k in profile_keys}, "bank_account": _mask(emp.get("bank_account")), "pan": _mask(emp.get("pan"))},
        "department": depts.get(emp.get("department_id")), "ward": (ward or {}).get("name"),
        "manager": _brief(manager) and {**_brief(manager), "department": depts.get(manager.get("department_id"))},
        "leave_balances": await leave_balances(ctx, emp["id"], t.year),
        "licence": lic and {"valid_until": lic.isoformat(), "days_left": (lic - t).days, "status": expiry_status(lic, t)},
        "today": {"attendance": att[0] if att else None},
        "next_shift": nxt and {"date": nxt["roster_date"], **_shift_out(shifts.get(nxt.get("shift")) or {})},
        "service_years": round(((t - parse_date(emp["doj"])).days / 365.25), 1) if emp.get("doj") else None,
    }


@ess_api.get("/leaves")
async def ess_leaves(ctx: CtxDep):
    emp = await _me(ctx)
    rows = await fetch_records(ctx, LEAVES, records.c.employee_id == emp["id"], order=data_key("from_date").desc(), limit=200)
    refs = await rs.resolve_refs(ctx, E(LEAVES), rows)
    t = today()
    for r in rows:
        f = parse_date(r.get("from_date"))
        r["can_cancel"] = r.get("status") == "Applied" or (r.get("status") == "Approved" and bool(f and f > t))
    return {"rows": rows, "refs": refs, "balances": await leave_balances(ctx, emp["id"], t.year), "types": LEAVE_TYPES}


class LeaveIn(BaseModel):
    leave_type: str
    from_date: date
    to_date: date
    half_day: bool = False
    reason: str | None = Field(default=None, max_length=500)
    handover_to: str | None = None
    attachment: str | None = None


@ess_api.post("/leaves", status_code=201)
async def ess_apply_leave(body: LeaveIn, ctx: CtxDep):
    emp = await _me(ctx)
    if body.from_date < today() - timedelta(days=30):
        raise bad_request("Leave more than 30 days in the past must be regularised by HR")
    if body.handover_to and body.handover_to == emp["id"]:
        raise bad_request("Hand over duties to a colleague, not yourself")
    rec = await create(ctx, LEAVES, {**body.model_dump(mode="json"), "employee_id": emp["id"], "status": "Applied"})
    await emit("leave.applied", ctx, {"leave": rec, "employee": _brief(emp)})
    return rec


@ess_api.post("/leaves/{lid}/cancel")
async def ess_cancel_leave(lid: str, ctx: CtxDep):
    emp = await _me(ctx)
    lv = await get(ctx, LEAVES, lid)
    if not lv or lv.get("employee_id") != emp["id"]:
        raise not_found("Leave request not found")
    if lv.get("status") == "Approved" and (parse_date(lv.get("from_date")) or today()) <= today():
        raise conflict("This leave has already started — ask HR to amend it")
    if lv.get("status") not in ("Applied", "Approved"):
        raise conflict(f"A {lv.get('status', '').lower()} leave cannot be cancelled")
    return await transition(ctx, LEAVES, lid, "Cancelled", note="Cancelled by the employee (self-service)")


def _month(month: str | None) -> tuple[date, date]:
    if month:
        m = re.match(r"^(\d{4})-(0[1-9]|1[0-2])$", month)
        if not m:
            raise bad_request("Month must be YYYY-MM")
        y, mo = int(m.group(1)), int(m.group(2))
    else:
        y, mo = today().year, today().month
    return date(y, mo, 1), date(y, mo, calendar.monthrange(y, mo)[1])


@ess_api.get("/attendance")
async def ess_attendance(ctx: CtxDep, month: str | None = None):
    emp = await _me(ctx)
    a, b = _month(month)
    att = {r["att_date"]: r for r in await fetch_records(ctx, ATTENDANCE, records.c.employee_id == emp["id"],
                                                          data_key("att_date") >= a.isoformat(), data_key("att_date") <= b.isoformat())}
    shifts = await shift_map(ctx)
    rost = _group([e for e in await live_entries(ctx, [emp["id"]], a, b) if e.get("status") != "Planned"], "roster_date")
    leaves = await leaves_between(ctx, [emp["id"]], a, b, ("Applied", "Approved"))
    leave_on = {d.isoformat(): lv for lv in leaves for d in leave_dates(lv) if a <= d <= b}
    days = []
    for d in date_span(a, b):
        k = d.isoformat()
        r = att.get(k)
        lv = leave_on.get(k)
        days.append({"date": k, "weekday": d.strftime("%a"),
                     "attendance": r and {x: r.get(x) for x in ("id", "status", "check_in", "check_out", "hours_worked", "late_minutes", "overtime_hours", "source")},
                     "shifts": [shift_label(shifts.get(e.get("shift"))) for e in rost.get(k, [])],
                     "leave": lv and {"leave_type": lv.get("leave_type"), "short": LEAVE_SHORT.get(lv.get("leave_type")), "status": lv.get("status")}})
    vals = list(att.values())
    return {"month": a.strftime("%Y-%m"), "days": days, "summary": {
        "present": sum(r.get("status") == "Present" for r in vals), "half_day": sum(r.get("status") == "Half Day" for r in vals),
        "absent": sum(r.get("status") == "Absent" for r in vals), "on_leave": sum(r.get("status") == "On Leave" for r in vals),
        "late_days": sum(bool(r.get("late_minutes")) for r in vals), "late_minutes": sum(int(r.get("late_minutes") or 0) for r in vals),
        "hours": round(sum(float(r.get("hours_worked") or 0) for r in vals), 1),
        "overtime_hours": round(sum(float(r.get("overtime_hours") or 0) for r in vals), 1),
        "rostered_days": len(rost)}}


@ess_api.get("/payslips")
async def ess_payslips(ctx: CtxDep):
    emp = await _me(ctx)
    rows = await fetch_records(ctx, "payroll.payslips", records.c.employee_id == emp["id"], records.c.status == "Published",
                               order=data_key("period").desc(), limit=36)
    keys = ("id", "code", "period", "days_in_month", "paid_days", "lop_days", "gross", "total_deductions", "net_pay", "status")
    return [{k: r.get(k) for k in keys} for r in rows]


@ess_api.get("/payslips/{sid}")
async def ess_payslip(sid: str, ctx: CtxDep):
    from .payroll import payslip_print_data  # payroll builds on this module's helpers

    emp = await _me(ctx)
    slip = await get(ctx, "payroll.payslips", sid)
    if not slip or slip.get("employee_id") != emp["id"] or slip.get("status") != "Published":
        raise not_found("Payslip not found")
    return await payslip_print_data(ctx, sid)


GRIEVANCE_KEYS = ("id", "code", "category", "severity", "description", "anonymous", "attachment", "status", "created_at",
                  "resolution", "resolved_at", "employee_feedback")


@ess_api.get("/grievances")
async def ess_grievances(ctx: CtxDep):
    emp = await _me(ctx)
    rows = await fetch_records(ctx, GRIEVANCES, sa.or_(records.c.employee_id == emp["id"], data_key("owner_ref") == _owner_ref(emp["id"])),
                               order=records.c.created_at.desc(), limit=100)
    return [{k: r.get(k) for k in GRIEVANCE_KEYS} for r in rows]


class GrievanceIn(BaseModel):
    category: str
    severity: Literal["Low", "Medium", "High"] = "Medium"
    description: str = Field(min_length=10, max_length=5000)
    anonymous: bool = False
    attachment: str | None = None


@ess_api.post("/grievances", status_code=201)
async def ess_raise_grievance(body: GrievanceIn, ctx: CtxDep):
    emp = await _me(ctx)
    rec = await create(ctx, GRIEVANCES, {**body.model_dump(), "employee_id": None if body.anonymous else emp["id"],
                                         "owner_ref": _owner_ref(emp["id"]), "status": "Submitted"})
    if body.anonymous:  # reviewers see the record, not who created it (the protected audit log keeps the actor)
        await ctx.conn.execute(records.update().where(records.c.id == rec["id"]).values(created_by="ess:anonymous", updated_by="ess:anonymous"))
    await emit("grievance.raised", ctx, {"id": rec["id"], "code": rec.get("code"), "category": body.category, "severity": body.severity})
    return {k: rec.get(k) for k in GRIEVANCE_KEYS}


class FeedbackIn(BaseModel):
    feedback: Literal["Satisfied", "Partly satisfied", "Not satisfied"]
    reopen: bool = False


@ess_api.post("/grievances/{gid}/feedback")
async def ess_grievance_feedback(gid: str, body: FeedbackIn, ctx: CtxDep):
    emp = await _me(ctx)
    g = await get(ctx, GRIEVANCES, gid)
    if not g or (g.get("employee_id") != emp["id"] and g.get("owner_ref") != _owner_ref(emp["id"])):
        raise not_found("Grievance not found")
    if g.get("status") != "Resolved":
        raise conflict("Feedback can be given once the grievance is resolved")
    rec = await transition(ctx, GRIEVANCES, gid, "Under Review" if body.reopen else "Closed",
                           note="Re-opened by the employee" if body.reopen else "Closed by the employee",
                           values={"employee_feedback": body.feedback})
    return {k: rec.get(k) for k in GRIEVANCE_KEYS}


POSH_STAGE = {"Filed": "Received by the Internal Committee", "Under Inquiry": "Inquiry in progress",
              "Hearing": "Hearings in progress", "Resolved": "IC report submitted to management", "Closed": "Closed"}


def _posh_minimal(r: dict) -> dict:
    return {"id": r["id"], "code": r.get("code"), "filed_on": r.get("filed_on"), "status": r.get("status"),
            "stage": POSH_STAGE.get(r.get("status"), r.get("status")), "inquiry_due": r.get("inquiry_due"), "updated_at": r.get("updated_at")}


@hook(POSH, "before_create")
async def _posh_rules(ctx, draft: dict):
    if draft.get("respondent") and draft.get("respondent") == draft.get("complainant"):
        raise bad_request("The complainant and the respondent cannot be the same person")
    filed = parse_date(draft.get("filed_on")) or today()
    draft["inquiry_due"] = (filed + timedelta(days=POSH_INQUIRY_DAYS)).isoformat()
    incident = parse_date(draft.get("incident_date"))
    if incident:
        if incident > filed:
            raise bad_request("The incident date cannot be after the filing date", {"fields": {"incident_date": "Check the date"}})
        draft["late_filing"] = (filed - incident).days > POSH_FILING_DAYS


@ess_api.get("/posh")
async def ess_posh(ctx: CtxDep):
    """A complainant sees only the stage of her own complaints — never the case file."""
    emp = await _me(ctx)
    rows = await fetch_records(ctx, POSH, data_key("complainant") == emp["id"], order=records.c.created_at.desc(), limit=50)
    return [_posh_minimal(r) for r in rows]


class PoshIn(BaseModel):
    respondent: str | None = None
    respondent_external: str | None = Field(default=None, max_length=300)
    incident_date: date
    incident_location: str | None = Field(default=None, max_length=300)
    description: str = Field(min_length=20, max_length=20000)
    witnesses: str | None = Field(default=None, max_length=5000)
    evidence: str | None = None


@ess_api.post("/posh", status_code=201)
async def ess_file_posh(body: PoshIn, ctx: CtxDep):
    emp = await _me(ctx)
    if not body.respondent and not (body.respondent_external or "").strip():
        raise bad_request("Name the respondent — a colleague, or describe the person if they are not an employee",
                          {"fields": {"respondent": "Required"}})
    if body.respondent and not await fetch_employee(ctx, body.respondent):
        raise bad_request("Choose the respondent from the staff list")
    if body.incident_date > today():
        raise bad_request("The incident date cannot be in the future", {"fields": {"incident_date": "Check the date"}})
    # The case file is restricted to the Internal Committee (HR); it is created on the complainant's behalf.
    rec = await create(ctx, POSH, {**body.model_dump(mode="json"), "complainant": emp["id"], "filed_on": today().isoformat(), "status": "Filed"})
    await emit("posh.filed", ctx, {"id": rec["id"], "code": rec.get("code")})
    return _posh_minimal(rec)


REQUEST_KEYS = ("id", "code", "request_type", "details", "supporting_document", "status", "response", "document", "created_at", "completed_at")


@ess_api.get("/requests")
async def ess_requests(ctx: CtxDep):
    emp = await _me(ctx)
    rows = await fetch_records(ctx, REQUESTS, records.c.employee_id == emp["id"], order=records.c.created_at.desc(), limit=100)
    return [{k: r.get(k) for k in REQUEST_KEYS} for r in rows]


class RequestIn(BaseModel):
    request_type: str
    details: str | None = Field(default=None, max_length=3000)
    supporting_document: str | None = None


@ess_api.post("/requests", status_code=201)
async def ess_raise_request(body: RequestIn, ctx: CtxDep):
    emp = await _me(ctx)
    if body.request_type in ("Address Change", "Bank Change", "Other") and not (body.details or "").strip():
        raise bad_request("Describe what needs to change", {"fields": {"details": "Required"}})
    rec = await create(ctx, REQUESTS, {**body.model_dump(), "employee_id": emp["id"], "status": "Open"})
    return {k: rec.get(k) for k in REQUEST_KEYS}


@ess_api.get("/roster")
async def ess_roster(ctx: CtxDep, days: int = Query(14, ge=1, le=62)):
    """My published shifts (and approved / pending leave) for the coming days."""
    emp = await _me(ctx)
    a = today()
    b = a + timedelta(days=days - 1)
    shifts = await shift_map(ctx)
    wards = await labels(ctx, "mdm.wards")
    by_day = _group([e for e in await live_entries(ctx, [emp["id"]], a, b) if e.get("status") != "Planned"], "roster_date")
    leave_on = {d.isoformat(): lv for lv in await leaves_between(ctx, [emp["id"]], a, b, ("Applied", "Approved"))
                for d in leave_dates(lv)}
    out = []
    for d in date_span(a, b):
        k = d.isoformat()
        lv = leave_on.get(k)
        out.append({"date": k, "weekday": d.strftime("%a"),
                    "shifts": [{**_shift_out(shifts.get(e.get("shift")) or {}), "ward": (wards.get(e.get("ward")) or {}).get("name"),
                                "role_on_duty": e.get("role_on_duty"), "status": e.get("status")} for e in by_day.get(k, [])],
                    "leave": lv and {"leave_type": lv.get("leave_type"), "status": lv.get("status")}})
    return {"days": out}


AUDIENCE_OF = {"Doctor": "Doctors", "Nurse": "Nurses", "Technician": "Technicians", "Administrative": "Administrative",
               "Management": "Administrative", "Support": "Support"}


@ess_api.get("/announcements")
async def ess_announcements(ctx: CtxDep):
    if not has(ANNOUNCEMENTS):
        return []
    emp = await _me(ctx)
    t = today().isoformat()
    rows = await fetch_records(ctx, ANNOUNCEMENTS, records.c.status == "Published", order=data_key("publish_on").desc(), limit=100)
    out = []
    for r in rows:
        if (r.get("publish_on") or "") > t or (r.get("expires_on") and r["expires_on"] < t):
            continue
        aud = r.get("audience") or []
        if aud and "All staff" not in aud and AUDIENCE_OF.get(emp.get("category")) not in aud:
            continue
        if r.get("department") and r["department"] != emp.get("department_id"):
            continue
        out.append({k: r.get(k) for k in ("id", "code", "title", "body", "publish_on", "expires_on", "attachment", "acknowledgement_required")})
    return out[:20]


@ess_api.get("/training")
async def ess_training(ctx: CtxDep):
    """Mandatory training compliance: every required course with my latest record against it."""
    emp = await _me(ctx)
    if not has("training.training_records"):
        return {"rows": [], "compliance_pct": None}
    t = today()
    records_ = _group(await fetch_records(ctx, "training.training_records", records.c.employee_id == emp["id"],
                                          order=records.c.created_at.desc()), "course")
    courses = await labels(ctx, "training.courses")
    doj = parse_date(emp.get("doj")) or t
    rows, seen = [], set()
    for req in await _mandatory_requirements(ctx, emp):
        c = req["course"]
        seen.add(c["id"])
        rec = (records_.get(c["id"]) or [None])[0]
        due = parse_date((rec or {}).get("due_date")) or doj + timedelta(days=int(req["due_within_days"]))
        rows.append(_training_row(c, rec, due, t, True, req.get("regulatory_basis")))
    for course_id, recs in records_.items():
        if course_id not in seen and course_id in courses:
            rec = recs[0]
            rows.append(_training_row(courses[course_id], rec, parse_date(rec.get("due_date")), t, bool(rec.get("mandatory")), None))
    mandatory = [r for r in rows if r["mandatory"]]
    ok = sum(r["compliance"] == "Compliant" for r in mandatory)
    return {"rows": rows, "compliance_pct": round(ok / len(mandatory) * 100) if mandatory else None,
            "mandatory": len(mandatory), "compliant": ok}


def _training_row(course: dict, rec: dict | None, due: date | None, t: date, mandatory: bool, basis: str | None) -> dict:
    status = (rec or {}).get("status")
    valid = parse_date((rec or {}).get("valid_until"))
    if status == "Completed" and (not valid or valid >= t):
        compliance = "Compliant"
    elif status in ("Completed", "Expired"):
        compliance = "Expired"
    elif due and due < t:
        compliance = "Overdue"
    else:
        compliance = "Due" if rec else "Not assigned"
    return {"course_id": course["id"], "course": course.get("name"), "category": course.get("category"), "mode": course.get("mode"),
            "video_url": course.get("video_url"), "duration_minutes": course.get("duration_minutes"), "mandatory": mandatory,
            "regulatory_basis": basis, "record_id": (rec or {}).get("id"), "status": status, "due_date": due and due.isoformat(),
            "completed_on": (rec or {}).get("completed_on"), "valid_until": valid and valid.isoformat(), "score": (rec or {}).get("score"),
            "compliance": compliance}


@ess_api.get("/health")
async def ess_health(ctx: CtxDep):
    """My occupational health checks and staff vaccinations (exposure incidents stay in the restricted register)."""
    emp = await _me(ctx)
    checks = await fetch_records(ctx, "occhealth.health_checks", records.c.employee_id == emp["id"],
                                 order=data_key("check_date").desc(), limit=10) if has("occhealth.health_checks") else []
    vacc = await fetch_records(ctx, "occhealth.vaccinations", records.c.employee_id == emp["id"],
                               order=data_key("due_date"), limit=50) if has("occhealth.vaccinations") else []
    return {"checks": [{k: c.get(k) for k in ("id", "code", "check_type", "check_date", "fitness", "restrictions", "next_due", "status")} for c in checks],
            "vaccinations": [{k: v.get(k) for k in ("id", "code", "vaccine", "dose", "due_date", "given_on", "next_dose_due", "status")} for v in vacc]}


router.include_router(hr_api)
router.include_router(ess_api)

__all__ = ["router", "CRON", "fetch_records", "fetch_employees", "fetch_employee", "labels", "data_key", "date_span",
           "leave_dates", "leave_days_within", "record_punch", "refresh_credentials", "mark_absentees", "roster_conflicts",
           "required_nurses", "leave_balances", "assign_mandatory_training", "add_months"]
