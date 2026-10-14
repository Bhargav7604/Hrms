"""Asset management engine: the asset lifecycle (activation → out of service / out for service →
decommissioning → disposal), breakdown tickets taking equipment down and back into service, PM /
calibration / electrical-safety completion rolling due dates forward, inter-department transfers,
live depreciation (SLM / WDV) and the asset dashboard with drill-through.

Endpoints
* GET /api/assets/dashboard — one payload for every dashboard tab (period, comparison, due window)
* GET /api/assets/drill     — the assets behind a KPI / tile / chart bucket
"""

from __future__ import annotations

import calendar
import logging
from collections import Counter, defaultdict
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter

from ..config import settings
from ..core import records as rs
from ..core.hooks import hook
from ..core.rbac import require_page
from ..core.security import CtxDep
from ..core.util import bad_request, conflict, is_uuid, now, parse_date, parse_dt, today
from ..schema import employees, records
from ._common import E, find, get, require_role, transition, update

log = logging.getLogger("vlack.assets")

router = APIRouter(prefix="/api/assets", tags=["assets"])

ASSETS = "assets.assets"
BREAKDOWNS = "assets.breakdowns"
PM_JOBS = "assets.pm_jobs"
CONTRACTS = "assets.contracts"
TRANSFERS = "assets.transfers"

AWAITING, ACTIVE, OOS, OFS, DECOM, DISPOSED = (
    "Awaiting activation", "Active", "Out of service", "Out for service", "Decommissioned", "Disposed")
LIFECYCLE = [ACTIVE, AWAITING, OOS, OFS, DECOM, DISPOSED]
IN_SERVICE = {ACTIVE, OOS, OFS}  # on the books and in use (not awaiting / leaving)
OPEN_TICKET = ("Open", "Assigned", "In Progress", "Awaiting Spares")
TRANSFER_LIVE = ("Requested", "Approved", "In Transit")
PM_OWED = ("In Progress", "Overdue")
FREQ_MONTHS = {"Monthly": 1, "Quarterly": 3, "Half-yearly": 6, "Yearly": 12}
WHERE = ["At assigned location", "Issued", "Outside hospital", "In transit", "Lost / missing"]
AGE_BUCKETS = ["<1y", "1-3y", "3-5y", "5-10y", "10y+", "Unknown"]
SEVERITIES = ["Critical", "High", "Medium", "Low"]
EXPIRED_LISTED_DAYS = 90  # expired warranty / AMC cover stays on the due list this long
AERB_WARN_DAYS = 90
DEFAULT_LIFE = 10.0
DEFAULT_WDV_RATE = 15.0

# (kind, label, last key, next key, frequency key, result key)
DUE_KINDS = (
    ("calibration", "Calibration", "last_calibrated_on", "next_calibration_due", "calibration_frequency", "last_calibration_result"),
    ("pm", "PM", "last_pm_on", "next_pm_due", "pm_frequency", None),
    ("electrical_safety", "Electrical safety", "last_electrical_safety_on", "next_electrical_safety_due",
     "electrical_safety_frequency", "last_electrical_safety_result"),
)
COVER_KINDS = (("warranty", "Warranty"), ("amc", "AMC / CMC"))
# Who sees what: the dashboard page is governed by the roles & permissions matrix (page "assets.asset-dashboard";
# by default support, stores via pages[].roles, admin). Asset finance (cost, book value, depreciation, disposal
# proceeds) only for stores, management and admin.
FINANCE_ROLES = ("stores", "management")
FINANCE_BUCKETS = ("nbv",)
FINANCE_DIMS = ("method",)
KIND_LABEL = {k: lbl for k, lbl, *_ in DUE_KINDS} | dict(COVER_KINDS)


# ------------------------------------------------------------------ small helpers

def _d(v: Any) -> date | None:
    try:
        return parse_date(v)
    except (ValueError, TypeError):
        return None


def _dt(v: Any) -> datetime | None:
    try:
        return parse_dt(v)
    except (ValueError, TypeError):
        return None


def _f(v: Any) -> float | None:
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "1", "yes", "on")


def _iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    return date(y, m + 1, min(d.day, calendar.monthrange(y, m + 1)[1]))


def shift_years(d: date, n: int) -> date:
    try:
        return d.replace(year=d.year + n)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year + n, day=28)


def next_due(last: date | None, freq: str | None) -> date | None:
    months = FREQ_MONTHS.get(freq or "")
    return add_months(last, months) if last and months else None


def is_high(criticality: Any) -> bool:
    return str(criticality or "").startswith("High")


def severity(v: Any) -> str:
    s = str(v or "").split(" (")[0].strip()
    return s if s in SEVERITIES else (s or "Medium")


def takes_down(ticket: dict) -> bool:
    """Critical / High tickets, or any ticket flagged 'equipment down', put an active asset out of service."""
    return severity(ticket.get("severity")) in ("Critical", "High") or _truthy(ticket.get("equipment_down"))


def start_date(a: dict) -> date | None:
    """Date put to use — depreciation and age run from here."""
    return _d(a.get("capitalised_on")) or _d(a.get("installation_date")) or _d(a.get("purchase_date"))


def pct(n: float, d: float) -> float | None:
    return round(n * 100.0 / d, 1) if d else None


def _where(ctx, ent) -> list:
    """Active-branch scoping when the core provides it."""
    fn = getattr(rs, "scoped_where", None)
    return fn(ctx, ent) if fn else rs.base_where(ent)


async def _live_transfer(ctx, asset_id: str, exclude: str | None = None) -> dict | None:
    rows = await find(ctx, TRANSFERS, status=list(TRANSFER_LIVE), asset=asset_id, limit=5)
    return next((r for r in rows if r["id"] != exclude), None)


async def _asset_or_400(ctx, asset_id: Any) -> dict:
    a = await get(ctx, ASSETS, str(asset_id or ""))
    if not a:
        raise bad_request("Pick an asset from the register", {"fields": {"asset": "Unknown asset"}})
    return a


# ------------------------------------------------------------------ asset rules

def _changed(rec: dict, prev: dict | None, *keys: str) -> bool:
    return prev is None or any(rec.get(k) != prev.get(k) for k in keys)


def _check_asset(rec: dict, prev: dict | None) -> None:
    """Field rules, checked only when the user touches the fields involved (engine updates never trip on old data)."""
    errors: dict[str, str] = {}
    if _changed(rec, prev, "purchase_cost", "salvage_value"):
        cost, salvage = _f(rec.get("purchase_cost")), _f(rec.get("salvage_value"))
        if cost is not None and cost < 0:
            errors["purchase_cost"] = "Cost cannot be negative"
        if cost is not None and salvage is not None and salvage > cost:
            errors["salvage_value"] = "Salvage value cannot exceed the purchase cost"
    if _changed(rec, prev, "depreciation_method", "wdv_rate_percent"):
        if rec.get("depreciation_method") == "WDV" and not _f(rec.get("wdv_rate_percent")):
            errors["wdv_rate_percent"] = "Enter the WDV rate for written-down-value depreciation"
    if _changed(rec, prev, "purchase_date", "installation_date"):
        pd, inst = _d(rec.get("purchase_date")), _d(rec.get("installation_date"))
        if pd and pd > today():
            errors["purchase_date"] = "Purchase date cannot be in the future"
        if pd and inst and inst < pd:
            errors["installation_date"] = "Installation cannot be before the purchase date"
    if _changed(rec, prev, "location_status", "issued_to") and rec.get("location_status") == "Issued" and not rec.get("issued_to"):
        errors["issued_to"] = "Say who the asset is issued to"
    if errors:
        raise bad_request("Please fix the highlighted fields", {"fields": errors})


def _roll_due(rec: dict, prev: dict | None) -> None:
    """Next PM / calibration / electrical-safety due = last done + frequency, unless the user set it."""
    for _k, _lbl, last_k, next_k, freq_k, _r in DUE_KINDS:
        last = _d(rec.get(last_k))
        if not last:
            continue
        user_set_next = prev is not None and rec.get(next_k) != prev.get(next_k) and rec.get(next_k)
        if user_set_next:
            continue
        if not rec.get(next_k) or _changed(rec, prev, last_k, freq_k):
            nd = next_due(last, rec.get(freq_k))
            if nd:
                rec[next_k] = nd.isoformat()


def _first_due(rec: dict) -> None:
    """A newly registered asset with a frequency but no history is first due one interval after it is put to use
    (or after registration, for equipment already in use when it is entered)."""
    base = max(start_date(rec) or today(), today())
    for _k, _lbl, last_k, next_k, freq_k, _r in DUE_KINDS:
        if not rec.get(last_k) and not rec.get(next_k):
            nd = next_due(base, rec.get(freq_k))
            if nd:
                rec[next_k] = nd.isoformat()


@hook(ASSETS, "before_create")
async def asset_before_create(ctx, draft: dict) -> None:
    _check_asset(draft, None)
    _roll_due(draft, None)
    _first_due(draft)


@hook(ASSETS, "before_update")
async def asset_before_update(ctx, nxt: dict, prev: dict) -> None:
    _check_asset(nxt, prev)
    _roll_due(nxt, prev)


@hook(ASSETS, "before_transition")
async def asset_before_transition(ctx, nxt: dict, prev: dict) -> None:
    to, frm = nxt.get("status"), prev.get("status")
    stamp = now().isoformat(timespec="seconds")
    if to in (OOS, OFS) and frm == ACTIVE and not nxt.get("down_since"):
        nxt["down_since"] = stamp
    if to == OFS:
        back = _d(nxt.get("expected_return_date"))
        if back and back < today():
            raise bad_request("Expected return date is in the past", {"fields": {"expected_return_date": "Past date"}})
        live = await _live_transfer(ctx, nxt["id"])
        if live and live.get("status") == "In Transit":
            raise conflict(f"Transfer {live['code']} is in transit — receive it before sending the asset out")
        nxt["location_status"] = "Outside hospital"
        nxt["sent_out_at"] = stamp
    if to == ACTIVE and frm in (OOS, OFS):
        nxt.update(down_since=None, down_ticket=None, out_of_service_reason=None, expected_return_date=None)
        if frm == OFS or nxt.get("location_status") in (None, "", "Outside hospital"):
            nxt["location_status"] = "At assigned location"
        nxt["back_in_service_at"] = stamp
    if to == ACTIVE and frm == AWAITING and not start_date(nxt):
        nxt["capitalised_on"] = today().isoformat()
    if to == DECOM:
        live = await _live_transfer(ctx, nxt["id"])
        if live:
            raise conflict(f"Transfer {live['code']} is {live['status'].lower()} — complete or cancel it first")
        nxt["decommissioned_on"] = today().isoformat()
    if to == DISPOSED:
        dd = _d(nxt.get("disposal_date"))
        if dd and dd > today():
            raise bad_request("Disposal date cannot be in the future", {"fields": {"disposal_date": "Future date"}})
        decom = _d(nxt.get("decommissioned_on"))
        if dd and decom and dd < decom:
            raise bad_request("Disposal cannot be before decommissioning", {"fields": {"disposal_date": f"Decommissioned on {decom}"}})
        val = _f(nxt.get("disposal_value"))
        if val is not None and val < 0:
            raise bad_request("Disposal proceeds cannot be negative", {"fields": {"disposal_value": "Negative"}})


# ------------------------------------------------------------------ breakdown tickets

@hook(BREAKDOWNS, "before_create")
async def breakdown_before_create(ctx, draft: dict) -> None:
    asset = await _asset_or_400(ctx, draft.get("asset"))
    if asset.get("status") in (DECOM, DISPOSED):
        raise conflict(f"{asset.get('code')} is {asset['status'].lower()} — breakdown tickets are for assets in service")
    if not draft.get("department") and asset.get("department"):
        draft["department"] = asset["department"]
    # The ticket shares the downtime when it takes an active asset down, or when the asset is already down on a ticket.
    if takes_down(draft) and (asset.get("status") == ACTIVE or (asset.get("status") == OOS and asset.get("down_ticket"))):
        draft["asset_down"] = True


@hook(BREAKDOWNS, "after_create")
async def breakdown_after_create(ctx, rec: dict) -> None:
    if rec.get("asset_down"):
        await _take_down(ctx, rec)


async def _take_down(ctx, ticket: dict) -> None:
    asset = await get(ctx, ASSETS, ticket["asset"])
    if not asset or asset.get("status") != ACTIVE:
        return
    problem = " ".join(str(ticket.get("problem") or "").split())[:160]
    await transition(ctx, ASSETS, asset["id"], OOS, note=f"Breakdown {ticket.get('code')}",
                     values={"out_of_service_reason": f"Breakdown {ticket.get('code')}: {problem}"})
    await update(ctx, ASSETS, asset["id"], {"down_since": ticket.get("reported_at") or now().isoformat(timespec="minutes"),
                                            "down_ticket": ticket["id"]})


async def _maybe_restore(ctx, ticket: dict) -> None:
    """Back in service when the last open ticket that took the asset down is resolved. Assets marked out of
    service by hand (no down ticket) or sent out for service stay where they are."""
    asset = await get(ctx, ASSETS, ticket["asset"])
    if not asset or asset.get("status") != OOS or not asset.get("down_ticket"):
        return
    others = [t for t in await find(ctx, BREAKDOWNS, status=list(OPEN_TICKET), asset=asset["id"], limit=50)
              if t["id"] != ticket["id"] and _truthy(t.get("asset_down"))]
    if others:
        if asset.get("down_ticket") == ticket["id"]:
            await update(ctx, ASSETS, asset["id"], {"down_ticket": others[0]["id"]})
        return
    await transition(ctx, ASSETS, asset["id"], ACTIVE,
                     note=f"Back in service — breakdown {ticket.get('code')} {str(ticket.get('status')).lower()}")


@hook(BREAKDOWNS, "before_transition")
async def breakdown_before_transition(ctx, nxt: dict, prev: dict) -> None:
    if nxt.get("status") == "Resolved" and nxt.get("downtime_hours") in (None, ""):
        start, end = _dt(nxt.get("reported_at")), _dt(nxt.get("resolved_at"))
        if start and end and end > start:
            nxt["downtime_hours"] = round((end - start).total_seconds() / 3600, 1)


@hook(BREAKDOWNS, "after_transition")
async def breakdown_after_transition(ctx, rec: dict, prev: dict) -> None:
    if not _truthy(rec.get("asset_down")):
        return
    to, frm = rec.get("status"), prev.get("status")
    if to in ("Resolved", "Closed") and frm in OPEN_TICKET:
        await _maybe_restore(ctx, rec)
    elif to in OPEN_TICKET and frm == "Resolved":  # reopened
        await _take_down(ctx, rec)


# ------------------------------------------------------------------ PM / calibration / electrical safety

@hook(PM_JOBS, "before_create")
async def pm_before_create(ctx, draft: dict) -> None:
    asset = await _asset_or_400(ctx, draft.get("asset"))
    if asset.get("status") == DISPOSED:
        raise conflict(f"{asset.get('code')} is disposed")


@hook(PM_JOBS, "before_transition")
async def pm_before_transition(ctx, nxt: dict, prev: dict) -> None:
    if nxt.get("status") != "Completed":
        return
    done = _d(nxt.get("done_on"))
    if done and done > today():
        raise bad_request("Done on cannot be in the future", {"fields": {"done_on": "Future date"}})
    kind = nxt.get("pm_type")
    if kind == "Calibration" and nxt.get("result") not in ("Pass", "Fail"):
        raise bad_request("Record the calibration result (Pass / Fail)", {"fields": {"result": "Required"}})
    if kind == "Electrical safety test" and nxt.get("result") not in ("Pass", "Fail") \
            and nxt.get("electrical_safety") not in ("Pass", "Fail"):
        raise bad_request("Record the electrical safety result (Pass / Fail)", {"fields": {"result": "Required"}})
    nd = _d(nxt.get("next_due_date"))
    if nd and done and nd <= done:
        raise bad_request("Next due must be after the date it was done", {"fields": {"next_due_date": "Too early"}})


@hook(PM_JOBS, "after_transition")
async def pm_after_transition(ctx, rec: dict, prev: dict) -> None:
    if rec.get("status") != "Completed" or prev.get("status") == "Completed":
        return
    asset = await get(ctx, ASSETS, rec.get("asset"))
    if not asset or asset.get("status") == DISPOSED:
        return
    done = _d(rec.get("done_on")) or today()
    explicit = _d(rec.get("next_due_date"))
    patch: dict[str, Any] = {}

    def roll(kind: str, result: str | None, nd_override: date | None) -> None:
        _k, _l, last_k, next_k, freq_k, result_k = next(k for k in DUE_KINDS if k[0] == kind)
        cur = _d(asset.get(last_k))
        if cur and cur > done:  # an older job entered late never rewinds the asset
            return
        patch[last_k] = done.isoformat()
        nd = nd_override or next_due(done, asset.get(freq_k))
        if nd:
            patch[next_k] = nd.isoformat()
        if result_k and result in ("Pass", "Fail"):
            patch[result_k] = result

    kind = rec.get("pm_type")
    es = rec.get("electrical_safety")
    if kind == "Preventive maintenance":
        roll("pm", None, explicit)
    elif kind == "Calibration":
        roll("calibration", rec.get("result"), explicit)
    elif kind == "Electrical safety test":
        roll("electrical_safety", rec.get("result") if rec.get("result") in ("Pass", "Fail") else es, explicit)
    if kind != "Electrical safety test" and es in ("Pass", "Fail"):  # safety test done during the visit
        roll("electrical_safety", es, None)
    if patch:
        await update(ctx, ASSETS, asset["id"], patch)


# ------------------------------------------------------------------ transfers

@hook(TRANSFERS, "before_create")
async def transfer_before_create(ctx, draft: dict) -> None:
    asset = await _asset_or_400(ctx, draft.get("asset"))
    if asset.get("status") in (DECOM, DISPOSED):
        raise conflict(f"{asset.get('code')} is {asset['status'].lower()} and cannot be transferred")
    live = await _live_transfer(ctx, asset["id"])
    if live:
        raise conflict(f"{asset.get('code')} already has transfer {live['code']} ({live['status'].lower()})")
    if not draft.get("from_department"):
        draft["from_department"] = asset.get("department")
    if not draft.get("from_location"):
        draft["from_location"] = asset.get("location")
    same_dept = draft.get("to_department") == draft.get("from_department")
    same_loc = (draft.get("to_location") or "").strip().lower() in ("", (draft.get("from_location") or "").strip().lower())
    if same_dept and same_loc:
        raise bad_request("The asset is already in that department and location", {"fields": {"to_department": "Same as current"}})
    if draft.get("transfer_type") == "Temporary" and not draft.get("expected_return_date"):
        raise bad_request("A temporary transfer needs a return date", {"fields": {"expected_return_date": "Required"}})


@hook(TRANSFERS, "before_transition")
async def transfer_before_transition(ctx, nxt: dict, prev: dict) -> None:
    if nxt.get("status") in ("In Transit", "Completed"):
        asset = await get(ctx, ASSETS, nxt.get("asset"))
        if asset and asset.get("status") in (OFS, DECOM, DISPOSED):
            raise conflict(f"{asset.get('code')} is {asset['status'].lower()} — it cannot move now")


@hook(TRANSFERS, "after_transition")
async def transfer_after_transition(ctx, rec: dict, prev: dict) -> None:
    asset = await get(ctx, ASSETS, rec.get("asset"))
    if not asset:
        return
    to = rec.get("status")
    if to == "In Transit":
        await update(ctx, ASSETS, asset["id"], {"location_status": "In transit"})
    elif to == "Completed":
        patch: dict[str, Any] = {"department": rec.get("to_department"), "location_status": "At assigned location",
                                 "last_transfer": rec["id"]}
        if rec.get("to_location"):
            patch["location"] = rec["to_location"]
        await update(ctx, ASSETS, asset["id"], patch)


# ------------------------------------------------------------------ nightly: PM jobs past due + grace → Overdue

async def mark_overdue_pm(arq_ctx: dict | None = None) -> int:
    from ..db import system_ctx

    n = 0
    async with system_ctx() as ctx:
        ent = E(PM_JOBS)
        t = ent.table
        rows = (await ctx.conn.execute(
            sa.select(t.c.id, t.c.data["due_date"].astext, t.c.data["asset"].astext)
            .where(*rs.base_where(ent), t.c.status == "Scheduled", t.c.data["due_date"].astext < today().isoformat())
        )).all()
        graces = await _graces(ctx, {r[2] for r in rows})
        for rid, due, asset_id in rows:
            d = _d(due)
            if d and d + timedelta(days=graces.get(asset_id, 7)) < today():
                await transition(ctx, PM_JOBS, str(rid), "Overdue", note="Auto-marked: past due date and grace")
                n += 1
    log.info("marked %s PM jobs overdue", n)
    return n


async def _graces(ctx, ids: set[str]) -> dict[str, int]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(
        sa.select(records.c.id, records.c.data["pm_grace_days"].astext).where(records.c.id.in_(list(ids)))
    )).all()
    return {str(i): int(_f(g) if _f(g) is not None else 7) for i, g in rows}


CRON = [(mark_overdue_pm, {"hour": 0, "minute": 40})]


# ------------------------------------------------------------------ dashboard: periods

PERIODS = {"this_fy": "This FY", "last_fy": "Last FY", "this_quarter": "This quarter", "this_month": "This month",
           "last_30": "Last 30 days", "custom": "Custom range"}
COMPARES = {"none": "No comparison", "previous": "Previous period", "last_year": "Same period last year"}
WINDOWS = (7, 30, 60, 90)


def fy_start(d: date) -> date:
    return date(d.year if d.month >= 4 else d.year - 1, 4, 1)


def fy_label(start: date) -> str:
    return f"FY {start.year}-{str(start.year + 1)[2:]}"


def resolve_period(period: str, date_from: str | None, date_to: str | None) -> tuple[date, date, str]:
    t = today()
    if period == "this_fy":
        s = fy_start(t)
        return s, t, f"This FY · {fy_label(s)}"
    if period == "last_fy":
        s = date(fy_start(t).year - 1, 4, 1)
        return s, date(s.year + 1, 3, 31), f"Last FY · {fy_label(s)}"
    if period == "this_quarter":
        s = date(t.year, 3 * ((t.month - 1) // 3) + 1, 1)
        q = ((s.month - 4) % 12) // 3 + 1  # Indian FY quarter: Apr-Jun = Q1
        return s, t, f"Q{q} {fy_label(fy_start(s))}"
    if period == "this_month":
        return t.replace(day=1), t, t.strftime("%B %Y")
    if period == "last_30":
        return t - timedelta(days=29), t, "Last 30 days"
    if period == "custom":
        a, b = _d(date_from), _d(date_to)
        if not a or not b:
            raise bad_request("Choose both dates for a custom range", {"fields": {"date_from": "Required", "date_to": "Required"}})
        if a > b:
            raise bad_request("The range starts after it ends", {"fields": {"date_from": "After the end date"}})
        if (b - a).days > 3660:
            raise bad_request("Custom ranges are limited to 10 years")
        return a, b, "Custom range"
    raise bad_request(f"Unknown period {period!r}")


def resolve_compare(compare: str, lo: date, hi: date) -> tuple[date, date] | None:
    if compare == "none":
        return None
    if compare == "previous":
        prev_hi = lo - timedelta(days=1)
        return prev_hi - (hi - lo), prev_hi
    if compare == "last_year":
        return shift_years(lo, -1), shift_years(hi, -1)
    raise bad_request(f"Unknown comparison {compare!r}")


# ------------------------------------------------------------------ dashboard: loading

ASSET_KEYS = (
    "name", "category", "make", "model", "serial_no", "department", "location", "source", "ownership", "location_status",
    "issued_to", "criticality", "risk_class", "vendor", "purchase_date", "installation_date", "capitalised_on",
    "purchase_cost", "salvage_value", "useful_life_years", "depreciation_method", "wdv_rate_percent", "warranty_until",
    "amc_cmc_type", "amc_cmc_until", "insurance_until", "pm_frequency", "pm_grace_days", "last_pm_on", "next_pm_due",
    "calibration_frequency", "last_calibrated_on", "last_calibration_result", "next_calibration_due",
    "electrical_safety_frequency", "last_electrical_safety_on", "last_electrical_safety_result",
    "next_electrical_safety_due", "aerb_licence_no", "aerb_valid_until", "activated_at", "down_since",
    "disposal_date", "disposal_value", "disposal_method", "decommissioned_on",
)
TICKET_KEYS = ("asset", "department", "severity", "reported_at", "resolved_at", "root_cause", "repair_cost",
               "downtime_hours", "problem", "assigned_to", "asset_down", "equipment_down")
JOB_KEYS = ("asset", "pm_type", "due_date", "done_on", "cost", "downtime_hours", "performed_by")
CONTRACT_KEYS = ("asset", "contract_type", "start_date", "end_date", "vendor", "contract_no")
TRANSFER_KEYS = ("asset", "from_department", "to_department", "requested_on", "transfer_type")


async def _load(ctx, fqn: str, keys: tuple[str, ...], *conds) -> list[dict]:
    ent = E(fqn)
    t = ent.table
    cols = [t.c.id, t.c.code, t.c.status, t.c.title, t.c.created_at] + [t.c.data[k].astext.label(f"d_{k}") for k in keys]
    rows = (await ctx.conn.execute(sa.select(*cols).where(*_where(ctx, ent), *conds))).all()
    out = []
    for r in rows:
        m = r._mapping
        rec = {"id": str(m["id"]), "code": m["code"], "status": m["status"], "title": m["title"],
               "created": m["created_at"].astimezone(settings.tz).date() if m["created_at"] else None}
        for k in keys:
            rec[k] = m[f"d_{k}"]
        out.append(rec)
    return out


async def _labels(ctx, ids: set[Any]) -> dict[str, str]:
    """Display names for department / vendor / staff ids (records and employees tables)."""
    want = [str(i) for i in ids if i and is_uuid(i)]
    out: dict[str, str] = {}
    if not want:
        return out
    for tbl in (records, employees):
        rows = (await ctx.conn.execute(sa.select(tbl.c.id, tbl.c.code, tbl.c.title).where(tbl.c.id.in_(want)))).all()
        for r in rows:
            out[str(r.id)] = r.title or r.code or ""
    return out


# ------------------------------------------------------------------ dashboard: analysis

def acc_depreciation(a: dict, upto: date) -> float:
    """Accumulated depreciation up to a date (disposed assets stop at the disposal date)."""
    cost = _f(a.get("purchase_cost")) or 0.0
    start = start_date(a)
    if cost <= 0 or not start:
        return 0.0
    if a.get("status") == DISPOSED and _d(a.get("disposal_date")):
        upto = min(upto, _d(a.get("disposal_date")))  # type: ignore[type-var]
    if upto < start:
        return 0.0
    salvage = min(max(_f(a.get("salvage_value")) or 0.0, 0.0), cost)
    years = ((upto - start).days + 1) / 365.25
    if a.get("depreciation_method") == "WDV":
        rate = min(max((_f(a.get("wdv_rate_percent")) or DEFAULT_WDV_RATE) / 100.0, 0.0), 1.0)
        nbv = max(cost * (1 - rate) ** years, salvage)
        return round(cost - nbv, 2)
    life = max(_f(a.get("useful_life_years")) or DEFAULT_LIFE, 0.5)
    return round(min(cost - salvage, (cost - salvage) * years / life), 2)


def age_bucket(a: dict, t: date) -> str:
    s = start_date(a)
    if not s:
        return "Unknown"
    y = (t - s).days / 365.25
    return "<1y" if y < 1 else "1-3y" if y < 3 else "3-5y" if y < 5 else "5-10y" if y < 10 else "10y+"


class Analysis:
    """Every number on the dashboard, computed once from one consistent read."""

    def __init__(self, *, assets: list[dict], tickets: list[dict], jobs: list[dict], contracts: list[dict],
                 transfers: list[dict], labels: dict[str, str], window: int, lo: date, hi: date):
        self.t = today()
        self.as_of = min(hi, self.t)
        self.window, self.lo, self.hi = window, lo, hi
        self.assets = assets
        self.by_id = {a["id"]: a for a in assets}
        self.tickets, self.jobs, self.contracts, self.transfers, self.labels = tickets, jobs, contracts, transfers, labels
        self.open_tickets = [x for x in tickets if x["status"] in OPEN_TICKET]
        self.jobs_owed = [j for j in jobs if j["status"] in PM_OWED]
        self.live_transfers = [x for x in transfers if x["status"] in TRANSFER_LIVE]
        self._cover_index()
        for a in assets:
            self._derive(a)

    # -- per asset ------------------------------------------------------------
    def _cover_index(self) -> None:
        self.warranty_contract: dict[str, dict] = {}
        self.amc_contract: dict[str, dict] = {}
        for c in self.contracts:
            if c["status"] == "Terminated" or not _d(c.get("end_date")):
                continue
            ctype = c.get("contract_type")
            idx = self.warranty_contract if ctype == "Warranty" else self.amc_contract if ctype in ("AMC", "CMC") else None
            if idx is None:
                continue
            cur = idx.get(c.get("asset"))
            if not cur or _d(c["end_date"]) > _d(cur["end_date"]):  # type: ignore[operator]
                idx[c.get("asset")] = c

    def dept(self, a: dict) -> str:
        return self.labels.get(a.get("department") or "", "") or "Unassigned"

    def _derive(self, a: dict) -> None:
        t = self.t
        a["_dept"] = self.dept(a)
        a["_age"] = age_bucket(a, t)
        a["_where"] = a.get("location_status") or WHERE[0]
        a["_cost"] = _f(a.get("purchase_cost")) or 0.0
        a["_acc"] = acc_depreciation(a, self.as_of)
        a["_nbv"] = round(a["_cost"] - a["_acc"], 2) if a["_cost"] else 0.0
        # warranty: the later of the asset field and a Warranty contract
        wc = self.warranty_contract.get(a["id"])
        w_end = max(filter(None, [_d(a.get("warranty_until")), _d(wc["end_date"]) if wc else None]), default=None)
        a["_warranty_end"] = w_end
        # AMC / CMC: an active contract record, else the asset's own fields
        ac = self.amc_contract.get(a["id"])
        if ac:
            a["_amc"] = {"type": ac.get("contract_type"), "end": _d(ac.get("end_date")), "code": ac.get("code"),
                         "vendor": self.labels.get(ac.get("vendor") or "", "")}
        elif a.get("amc_cmc_type") in ("AMC", "CMC") and _d(a.get("amc_cmc_until")):
            a["_amc"] = {"type": a["amc_cmc_type"], "end": _d(a.get("amc_cmc_until")), "code": None, "vendor": ""}
        else:
            a["_amc"] = None
        under_w = bool(w_end and w_end >= t)
        amc_ok = bool(a["_amc"] and a["_amc"]["end"] and a["_amc"]["end"] >= t)
        a["_cover"] = "Warranty" if under_w else (a["_amc"]["type"] if amc_ok else "No cover")  # type: ignore[index]
        # AERB
        lic, valid = a.get("aerb_licence_no"), _d(a.get("aerb_valid_until"))
        if lic or valid:
            a["_aerb"] = ("expired" if valid and valid < t else "expiring" if valid and (valid - t).days <= AERB_WARN_DAYS
                          else "valid" if valid else "no_expiry")
        elif a.get("category") == "Imaging equipment":
            a["_aerb"] = "missing"
        else:
            a["_aerb"] = None
        ins = _d(a.get("insurance_until"))
        a["_insurance"] = "Insured" if ins and ins >= t else "Expired" if ins else "Not recorded"
        a["_due"] = self._due_items(a) if a.get("status") == ACTIVE else []

    def _due_items(self, a: dict) -> list[dict]:
        t, w = self.t, self.window
        out: list[dict] = []
        for kind, _label, last_k, next_k, freq_k, result_k in DUE_KINDS:
            last = _d(a.get(last_k))
            due = _d(a.get(next_k)) or next_due(last, a.get(freq_k))
            if not due:
                continue
            days = (due - t).days
            grace = int(_f(a.get("pm_grace_days")) or 0) if kind == "pm" else 0
            urgency = "overdue" if days < -grace else "due7" if days <= 7 else "due_window" if days <= w else None
            if kind == "pm":
                detail = f"{a.get(freq_k) or 'No frequency set'} · {grace} day grace" + (f" · last done {last}" if last else "")
            else:
                verb = "calibrated" if kind == "calibration" else "tested"
                res = a.get(result_k) or ""
                detail = (f"Last {verb} {last}" + (f" ({res.upper()})" if res else "")) if last else f"Never {verb} on record · {a.get(freq_k) or 'no frequency'}"
            out.append({"kind": kind, "due": due, "days": days, "urgency": urgency, "detail": detail,
                        "fail": a.get(result_k) == "Fail" if result_k else False, "grace": grace})
        for kind, end, detail in (
            ("warranty", a["_warranty_end"], "Supplier warranty" + (f" · {self.labels.get(a.get('vendor') or '', '')}" if a.get("vendor") else "")),
            ("amc", a["_amc"]["end"] if a["_amc"] else None,
             " · ".join(filter(None, [a["_amc"]["type"], a["_amc"]["code"] or "from the asset record", a["_amc"]["vendor"]])) if a["_amc"] else ""),
        ):
            if not end:
                continue
            days = (end - t).days
            if days < -EXPIRED_LISTED_DAYS:
                continue
            urgency = "overdue" if days < 0 else "due7" if days <= 7 else "due_window" if days <= w else None
            out.append({"kind": kind, "due": end, "days": days, "urgency": urgency, "detail": detail, "fail": False, "grace": 0})
        return out

    # -- sets behind tiles ------------------------------------------------------
    def ids_with_tickets(self, pred: Callable[[dict], bool] = lambda _x: True) -> set[str]:
        return {x.get("asset") for x in self.open_tickets if pred(x) and x.get("asset") in self.by_id}  # type: ignore[misc]

    def pm_overdue_ids(self) -> set[str]:
        ids = {a["id"] for a in self.assets for d in a["_due"] if d["kind"] == "pm" and d["urgency"] == "overdue"}
        ids |= {j.get("asset") for j in self.jobs if j["status"] == "Overdue" and j.get("pm_type") == "Preventive maintenance"
                and self.by_id.get(j.get("asset") or "", {}).get("status") not in (None, DISPOSED, DECOM)}
        return ids  # type: ignore[return-value]

    def under_maintenance_ids(self) -> set[str]:
        ids = self.ids_with_tickets(lambda x: x["status"] == "In Progress")
        ids |= {j.get("asset") for j in self.jobs if j["status"] == "In Progress" and j.get("asset") in self.by_id}
        return ids  # type: ignore[return-value]

    def critical_down_ids(self) -> set[str]:
        crit_ticket = self.ids_with_tickets(lambda x: severity(x.get("severity")) == "Critical")
        return {a["id"] for a in self.assets if is_high(a.get("criticality")) and a.get("status") not in (DISPOSED, DECOM)
                and (a.get("status") in (OOS, OFS) or a["id"] in crit_ticket)}

    def outside_ids(self) -> set[str]:
        return {a["id"] for a in self.assets if a.get("status") == OFS or (a["_where"] == "Outside hospital" and a.get("status") != DISPOSED)}

    def work_order_ids(self) -> set[str]:
        return self.ids_with_tickets() | {j.get("asset") for j in self.jobs_owed if j.get("asset") in self.by_id}  # type: ignore[operator]

    def transfer_ids(self, statuses=TRANSFER_LIVE) -> set[str]:
        return {x.get("asset") for x in self.live_transfers if x["status"] in statuses and x.get("asset") in self.by_id}  # type: ignore[misc]

    def not_disposed(self) -> list[dict]:
        return [a for a in self.assets if a.get("status") != DISPOSED]

    # -- flows (period metrics, comparable) --------------------------------------
    def flows(self, lo: date, hi: date) -> dict[str, float | None]:
        def within(v: Any) -> bool:
            d = _d(v)
            return bool(d and lo <= d <= hi)

        reported = [x for x in self.tickets if within(x.get("reported_at"))]
        resolved = [x for x in self.tickets if within(x.get("resolved_at"))]
        repair_hours = [h for x in resolved if (h := _hours(x.get("reported_at"), x.get("resolved_at"))) is not None]
        done = [j for j in self.jobs if j["status"] == "Completed" and within(j.get("done_on"))]
        due_upto = min(hi, self.t)
        due_jobs = [j for j in self.jobs if j["status"] != "Cancelled" and j.get("pm_type") == "Preventive maintenance"
                    and (d := _d(j.get("due_date"))) and lo <= d <= due_upto]
        on_time = 0
        for j in due_jobs:
            grace = int(_f(self.by_id.get(j.get("asset") or "", {}).get("pm_grace_days")) or 7)
            d_on, due = _d(j.get("done_on")), _d(j.get("due_date"))
            if j["status"] == "Completed" and d_on and due and d_on <= due + timedelta(days=grace):
                on_time += 1
        repair_cost = sum(_f(x.get("repair_cost")) or 0.0 for x in resolved)
        pm_cost = sum(_f(j.get("cost")) or 0.0 for j in done)
        dep_hi, dep_lo = min(hi, self.t), lo - timedelta(days=1)
        depreciation = sum(acc_depreciation(a, dep_hi) - acc_depreciation(a, dep_lo) for a in self.assets) if dep_hi >= lo else 0.0
        return {
            "registered": sum(1 for a in self.assets if a["created"] and lo <= a["created"] <= hi),
            "disposed": sum(1 for a in self.assets if a.get("status") == DISPOSED and within(a.get("disposal_date"))),
            "breakdowns": len(reported),
            "resolved": len(resolved),
            "mttr_hours": round(sum(repair_hours) / len(repair_hours), 1) if repair_hours else None,
            "downtime_hours": round(sum(_f(x.get("downtime_hours")) or 0.0 for x in resolved)
                                    + sum(_f(j.get("downtime_hours")) or 0.0 for j in done), 1),
            "repair_cost": round(repair_cost, 2),
            "pm_cost": round(pm_cost, 2),
            "maintenance_cost": round(repair_cost + pm_cost, 2),
            "pm_completed": len(done),
            "pm_due": len(due_jobs),
            "pm_compliance": pct(on_time, len(due_jobs)),
            "depreciation": round(depreciation, 2),
        }


def _hours(a: Any, b: Any) -> float | None:
    s, e = _dt(a), _dt(b)
    return (e - s).total_seconds() / 3600 if s and e and e >= s else None


def can_finance(ctx) -> bool:
    return ctx.role == "admin" or ctx.role in FINANCE_ROLES


def require_dashboard(ctx) -> None:
    """Same rule as the workspace tab: the role must be able to open the Asset Dashboard page."""
    require_page(ctx, "assets", "asset-dashboard")


async def analyse(ctx, *, lo: date, hi: date, window: int, earliest: date) -> Analysis:
    require_dashboard(ctx)
    R = records
    since = earliest.isoformat()
    assets = await _load(ctx, ASSETS, ASSET_KEYS)
    tickets = await _load(ctx, BREAKDOWNS, TICKET_KEYS, sa.or_(
        R.c.status.in_(OPEN_TICKET), R.c.data["reported_at"].astext >= since, R.c.data["resolved_at"].astext >= since))
    jobs = await _load(ctx, PM_JOBS, JOB_KEYS, sa.or_(
        R.c.status.in_(("Scheduled", "Overdue", "In Progress")), R.c.data["due_date"].astext >= since,
        R.c.data["done_on"].astext >= since))
    contracts = await _load(ctx, CONTRACTS, CONTRACT_KEYS, R.c.status != "Terminated")
    transfers = await _load(ctx, TRANSFERS, TRANSFER_KEYS, R.c.status.in_(TRANSFER_LIVE))
    ids: set[Any] = set()
    for a in assets:
        ids.update((a.get("department"), a.get("vendor")))
    for x in tickets:
        ids.update((x.get("department"), x.get("assigned_to")))
    for c in contracts:
        ids.add(c.get("vendor"))
    for x in transfers:
        ids.update((x.get("from_department"), x.get("to_department")))
    labels = await _labels(ctx, ids)
    return Analysis(assets=assets, tickets=tickets, jobs=jobs, contracts=contracts, transfers=transfers,
                    labels=labels, window=window, lo=lo, hi=hi)


# ------------------------------------------------------------------ dashboard: payload pieces

def _counts(values, order: list[str] | None = None, top: int | None = None) -> list[dict]:
    c = Counter(values)
    total = sum(c.values())
    keys = list(order) + [k for k in c if k not in order] if order else [k for k, _ in c.most_common()]
    rows = [{"key": k, "label": k, "count": c.get(k, 0), "pct": pct(c.get(k, 0), total) or 0.0} for k in keys if c.get(k, 0) or order]
    if top and len(rows) > top:
        rest = rows[top:]
        n = sum(r["count"] for r in rest)
        rows = rows[:top] + [{"key": None, "label": "Others", "count": n, "pct": pct(n, total) or 0.0, "more": len(rest)}]
    return rows


def _asset_brief(a: dict) -> dict:
    return {"id": a["id"], "code": a.get("code"), "name": a.get("name") or a.get("title"), "model": a.get("model"),
            "make": a.get("make"), "category": a.get("category"), "department": a["_dept"],
            "department_id": a.get("department"), "status": a.get("status"), "criticality": a.get("criticality"),
            "location": a.get("location"), "location_status": a["_where"]}


def _ticket_row(z: Analysis, x: dict) -> dict:
    a = z.by_id.get(x.get("asset") or "")
    rep = _dt(x.get("reported_at"))
    return {"id": x["id"], "code": x.get("code"), "status": x.get("status"), "severity": severity(x.get("severity")),
            "reported_at": x.get("reported_at"), "age_hours": round((now() - rep).total_seconds() / 3600, 1) if rep else None,
            "problem": x.get("problem"), "assigned_to": z.labels.get(x.get("assigned_to") or "") or None,
            "asset_id": x.get("asset"), "asset_code": a.get("code") if a else None,
            "asset_name": (a.get("name") or a.get("title")) if a else "Unknown asset", "asset_model": a.get("model") if a else None,
            "department": z.labels.get(x.get("department") or "") or (a["_dept"] if a else None),
            "takes_down": _truthy(x.get("asset_down"))}


def _due_section(z: Analysis) -> dict:
    cards = {k: {"key": k, "label": KIND_LABEL[k], "overdue": 0, "due7": 0, "due_window": 0, "listed": 0}
             for k in [k for k, *_ in DUE_KINDS] + [k for k, _ in COVER_KINDS]}
    items = []
    for a in z.assets:
        for d in a["_due"]:
            card = cards[d["kind"]]
            if d["urgency"] is None:
                continue
            card["listed"] += 1
            if d["urgency"] == "overdue":
                card["overdue"] += 1
            else:
                card["due_window"] += 1
                if d["days"] <= 7:
                    card["due7"] += 1
            items.append({**{k: v for k, v in _asset_brief(a).items() if k in ("id", "code", "name", "model", "make", "department", "department_id")},
                          "kind": d["kind"], "kind_label": KIND_LABEL[d["kind"]], "due": d["due"].isoformat(), "days": d["days"],
                          "urgency": d["urgency"], "detail": d["detail"], "fail": d["fail"], "grace": d["grace"]})
    items.sort(key=lambda r: (r["days"], r["code"] or ""))
    return {"window": z.window, "expired_listed_days": EXPIRED_LISTED_DAYS, "cards": list(cards.values()),
            "total": len(items), "items": items[:1000],
            "overdue_total": sum(c["overdue"] for c in cards.values())}


def _compliance(z: Analysis) -> dict:
    live = z.not_disposed()
    t = z.t
    aerb = Counter(a["_aerb"] for a in live if a["_aerb"])
    w_under = [a for a in live if a["_warranty_end"] and a["_warranty_end"] >= t]
    w_soon = [a for a in w_under if (a["_warranty_end"] - t).days <= z.window]
    w_exp = [a for a in live if a["_warranty_end"] and a["_warranty_end"] < t]
    in_use = [a for a in live if a.get("status") in IN_SERVICE | {AWAITING}]
    cover = Counter(a["_cover"] for a in in_use)
    high_uncovered = [a for a in in_use if is_high(a.get("criticality")) and a["_cover"] == "No cover"]

    def due_compliance(kind: str) -> dict:
        tracked = [d for a in z.assets for d in a["_due"] if d["kind"] == kind]
        ok = sum(1 for d in tracked if d["urgency"] != "overdue")
        fails = sum(1 for a in z.assets if a.get("status") == ACTIVE for d in a["_due"] if d["kind"] == kind and d["fail"])
        return {"tracked": len(tracked), "compliant": ok, "overdue": len(tracked) - ok, "failed": fails,
                "pct": pct(ok, len(tracked))}

    return {
        "aerb": {k: aerb.get(k, 0) for k in ("valid", "expiring", "expired", "missing", "no_expiry")},
        "warranty": {"under": len(w_under), "expiring": len(w_soon), "expired": len(w_exp),
                     "none": sum(1 for a in live if not a["_warranty_end"])},
        "cover": _counts([a["_cover"] for a in in_use], ["Warranty", "AMC", "CMC", "No cover"]),
        "cover_total": len(in_use),
        "covered_pct": pct(len(in_use) - cover.get("No cover", 0), len(in_use)),
        "high_uncovered": len(high_uncovered),
        "high_uncovered_list": [_asset_brief(a) for a in sorted(high_uncovered, key=lambda a: a.get("code") or "")[:50]],
        "insurance": _counts([a["_insurance"] for a in live], ["Insured", "Expired", "Not recorded"]),
        "calibration": due_compliance("calibration"),
        "electrical_safety": due_compliance("electrical_safety"),
        "pm": due_compliance("pm"),
        "risk_class": _counts([a.get("risk_class") or "Not classified" for a in live]),
        "alerts": aerb.get("expired", 0) + len(high_uncovered),
    }


def _finance(z: Analysis, period: dict) -> dict:
    live = z.not_disposed()
    by_cat: dict[str, dict] = defaultdict(lambda: {"count": 0, "cost": 0.0, "acc_dep": 0.0, "nbv": 0.0, "period_dep": 0.0})
    by_method: dict[str, dict] = defaultdict(lambda: {"count": 0, "cost": 0.0, "nbv": 0.0})
    dep_hi, dep_lo = min(z.hi, z.t), z.lo - timedelta(days=1)
    for a in z.assets:
        pdep = acc_depreciation(a, dep_hi) - acc_depreciation(a, dep_lo) if dep_hi >= z.lo else 0.0
        row = by_cat[a.get("category") or "Uncategorised"]
        row["period_dep"] += pdep
        if a.get("status") == DISPOSED:
            continue
        row["count"] += 1
        row["cost"] += a["_cost"]
        row["acc_dep"] += a["_acc"]
        row["nbv"] += a["_nbv"]
        m = by_method[a.get("depreciation_method") or "SLM"]
        m["count"] += 1
        m["cost"] += a["_cost"]
        m["nbv"] += a["_nbv"]
    disposals = []
    for a in z.assets:
        dd = _d(a.get("disposal_date"))
        if a.get("status") == DISPOSED and dd and z.lo <= dd <= z.hi:
            nbv_at = round(a["_cost"] - acc_depreciation(a, dd), 2)
            proceeds = _f(a.get("disposal_value")) or 0.0
            disposals.append({**_asset_brief(a), "disposal_date": dd.isoformat(), "method": a.get("disposal_method"),
                              "proceeds": proceeds, "nbv_at_disposal": nbv_at, "gain_loss": round(proceeds - nbv_at, 2)})
    rnd = lambda d: {k: round(v, 2) if isinstance(v, float) else v for k, v in d.items()}  # noqa: E731
    cats = sorted(({"category": k, **rnd(v)} for k, v in by_cat.items() if v["count"] or v["period_dep"]), key=lambda r: -r["cost"])
    return {
        "as_of": z.as_of.isoformat(),
        "cost": round(sum(a["_cost"] for a in live), 2),
        "acc_dep": round(sum(a["_acc"] for a in live), 2),
        "nbv": round(sum(a["_nbv"] for a in live), 2),
        "period_dep": period["depreciation"],
        "uncosted": sum(1 for a in live if not a["_cost"]),
        "by_category": cats,
        "by_method": [{"method": k, **rnd(v)} for k, v in sorted(by_method.items())],
        "disposals": sorted(disposals, key=lambda r: r["disposal_date"]),
        "disposal_proceeds": round(sum(r["proceeds"] for r in disposals), 2),
    }


def _months(z: Analysis) -> list[dict]:
    end = z.hi.replace(day=1)
    start = min(z.lo.replace(day=1), add_months(end, -11))
    if (end.year - start.year) * 12 + end.month - start.month > 35:
        start = add_months(end, -35)
    created = Counter((a["created"].year, a["created"].month) for a in z.assets if a["created"])
    before = sum(n for (y, m), n in created.items() if date(y, m, 1) < start)
    out, cum, cur = [], before, start
    while cur <= end:
        n = created.get((cur.year, cur.month), 0)
        cum += n
        out.append({"month": cur.strftime("%Y-%m"), "label": cur.strftime("%b %y"), "registered": n, "register_size": cum,
                    "in_period": z.lo.replace(day=1) <= cur <= z.hi})
        cur = add_months(cur, 1)
    return out


FLOW_META = {
    "registered": ("Assets registered", "number", "neutral"),
    "breakdowns": ("Breakdowns reported", "number", "down"),
    "mttr_hours": ("Mean time to repair", "hours", "down"),
    "downtime_hours": ("Downtime", "hours", "down"),
    "maintenance_cost": ("Maintenance cost", "currency", "down"),
    "pm_compliance": ("PM done on time", "percent", "up"),
    "depreciation": ("Depreciation", "currency", "neutral"),
    "disposed": ("Assets disposed", "number", "neutral"),
}


@router.get("/dashboard")
async def dashboard(ctx: CtxDep, period: str = "this_fy", date_from: str | None = None, date_to: str | None = None,
                    compare: str = "none", window: int = 30) -> dict:
    if window not in WINDOWS:
        raise bad_request("Window must be 7, 30, 60 or 90 days")
    if period not in PERIODS:
        raise bad_request(f"Unknown period {period!r}")
    lo, hi, label = resolve_period(period, date_from, date_to)
    cmp = resolve_compare(compare, lo, hi)
    earliest = min(lo, cmp[0]) if cmp else lo
    z = await analyse(ctx, lo=lo, hi=hi, window=window, earliest=earliest)
    t = z.t
    cur = z.flows(lo, hi)
    prev = z.flows(*cmp) if cmp else None
    finance_ok = can_finance(ctx)
    flows = []
    for k, (lbl, fmt, better) in FLOW_META.items():
        if k == "depreciation" and not finance_ok:
            continue
        v, p = cur.get(k), (prev or {}).get(k)
        delta = round((v - p) * 100.0 / p, 1) if prev is not None and v is not None and p not in (None, 0) else None
        flows.append({"key": k, "label": lbl, "format": fmt, "better": better, "value": v, "previous": p, "delta_pct": delta})

    n_total = len(z.assets)
    status_count = Counter(a.get("status") for a in z.assets)
    live = z.not_disposed()
    due = _due_section(z)
    compliance = _compliance(z)
    open_sev = Counter(severity(x.get("severity")) for x in z.open_tickets)
    work_orders = len(z.open_tickets) + len(z.jobs_owed)
    pm_overdue = z.pm_overdue_ids()
    lost = [a for a in live if a["_where"] == "Lost / missing"]
    oldest_first = sorted(z.open_tickets, key=lambda x: x.get("reported_at") or "")
    wo_rows = [{"type": "Breakdown", **_ticket_row(z, x)} for x in oldest_first]
    for j in sorted(z.jobs_owed, key=lambda j: j.get("due_date") or ""):
        a = z.by_id.get(j.get("asset") or "")
        due_d = _d(j.get("due_date"))
        wo_rows.append({"type": j.get("pm_type") or "PM", "id": j["id"], "code": j.get("code"), "status": j.get("status"),
                        "severity": None, "reported_at": j.get("due_date"), "age_hours": None,
                        "days_overdue": (t - due_d).days if due_d and due_d < t else 0,
                        "problem": None, "assigned_to": None, "asset_id": j.get("asset"),
                        "asset_code": a.get("code") if a else None, "asset_name": (a.get("name") or a.get("title")) if a else "Unknown asset",
                        "asset_model": a.get("model") if a else None, "department": a["_dept"] if a else None, "takes_down": False})
    period_tickets = [x for x in z.tickets if (d := _d(x.get("reported_at"))) and lo <= d <= hi]
    try:
        from ..core.branches import branch_info

        branch = (await branch_info(ctx.conn, getattr(ctx, "branch", None) or settings.branch_id)).get("name")
    except Exception:  # noqa: BLE001 — the header still works without a branch name
        branch = None

    return {
        "generated_at": now().isoformat(timespec="seconds"),
        "today": t.isoformat(),
        "hospital": settings.hospital_name,
        "branch": branch,
        "period": {"key": period, "label": label, "from": lo.isoformat(), "to": hi.isoformat(), "as_of": z.as_of.isoformat(),
                   "fy": fy_label(fy_start(lo))},
        "compare": {"key": compare, "label": COMPARES.get(compare, compare), "from": cmp[0].isoformat(), "to": cmp[1].isoformat()} if cmp else None,
        "window": window,
        "kpis": {
            "total": n_total,
            "active": status_count.get(ACTIVE, 0),
            "active_pct": pct(status_count.get(ACTIVE, 0), n_total),
            "out_of_service": status_count.get(OOS, 0),
            "out_for_service": status_count.get(OFS, 0),
            "open_work_orders": work_orders,
            "open_breakdowns": len(z.open_tickets),
            "pm_jobs_owed": len(z.jobs_owed),
            "pm_overdue": len(pm_overdue),
            "nbv": round(sum(a["_nbv"] for a in live), 2) if finance_ok else None,
        },
        "can_finance": finance_ok,
        "flows": flows,
        "alerts": {"due": due["overdue_total"], "maintenance": work_orders, "compliance": compliance["alerts"],
                   "register": len(lost) + sum(1 for x in z.live_transfers if x["status"] == "Requested"), "finance": 0},
        "overview": {
            "under_maintenance": len(z.under_maintenance_ids()),
            "open_breakdowns": len(z.open_tickets),
            "critical_down": len(z.critical_down_ids()),
            "outside_hospital": len(z.outside_ids()),
            "pending_approval": sum(1 for x in z.live_transfers if x["status"] == "Requested"),
            "under_warranty": sum(1 for a in live if a["_warranty_end"] and a["_warranty_end"] >= t),
        },
        "due": due,
        "charts": {
            "status": _counts([a.get("status") for a in z.assets], LIFECYCLE),
            "category": _counts([a.get("category") or "Uncategorised" for a in z.assets]),
            "department": [{**r, "key": next((a.get("department") for a in z.assets if a["_dept"] == r["label"]), None) if r["label"] != "Others" else None}
                           for r in _counts([a["_dept"] for a in z.assets], top=8)],
            "age": _counts([a["_age"] for a in z.assets], AGE_BUCKETS),
            "registered_by_month": _months(z),
        },
        "recent": [{**_asset_brief(a), "registered_on": a["created"].isoformat() if a["created"] else None}
                   for a in sorted(z.assets, key=lambda a: (a["created"] or date.min, a.get("code") or ""), reverse=True)[:8]],
        "open_breakdowns": [_ticket_row(z, x) for x in oldest_first[:100]],
        "maintenance": {
            "by_severity": [{"severity": s, "count": open_sev.get(s, 0)} for s in SEVERITIES],
            "work_orders": wo_rows[:200],
            "work_orders_total": len(wo_rows),
            "period": cur,
            "root_causes": _counts([x.get("root_cause") or "Not recorded yet" for x in period_tickets]),
            "upcoming_jobs": sorted(
                [{"id": j["id"], "code": j.get("code"), "type": j.get("pm_type"), "due_date": j.get("due_date"),
                  "asset_id": j.get("asset"), "asset_code": (z.by_id.get(j.get("asset") or "") or {}).get("code"),
                  "asset_name": (z.by_id.get(j.get("asset") or "") or {}).get("name"),
                  "department": (z.by_id.get(j.get("asset") or "") or {}).get("_dept")}
                 for j in z.jobs if j["status"] == "Scheduled" and (d := _d(j.get("due_date"))) and d <= t + timedelta(days=window)],
                key=lambda r: r["due_date"] or "")[:100],
        },
        "compliance": compliance,
        "register": {
            "total": n_total,
            "pending_transfer": len(z.live_transfers),
            "outside_hospital": len(z.outside_ids()),
            "lost": len(lost),
            "pending_disposal": status_count.get(DECOM, 0),
            "disposed": status_count.get(DISPOSED, 0),
            "in_transit": sum(1 for a in live if a["_where"] == "In transit"),
            "where": _counts([a["_where"] for a in live], WHERE),
            "source": _counts([a.get("source") or "Manual entry" for a in z.assets]),
            "ownership": _counts([a.get("ownership") or "Owned" for a in z.assets]),
            "manufacturers": _counts([(a.get("make") or "").strip() for a in z.assets if (a.get("make") or "").strip()], top=8),
            "transfers": [{"id": x["id"], "code": x.get("code"), "status": x.get("status"), "asset_id": x.get("asset"),
                           "asset_code": (z.by_id.get(x.get("asset") or "") or {}).get("code"),
                           "asset_name": (z.by_id.get(x.get("asset") or "") or {}).get("name"),
                           "from": z.labels.get(x.get("from_department") or ""), "to": z.labels.get(x.get("to_department") or ""),
                           "requested_on": x.get("requested_on"), "type": x.get("transfer_type")}
                          for x in sorted(z.live_transfers, key=lambda x: x.get("requested_on") or "")],
        },
        "finance": _finance(z, cur) if finance_ok else None,
    }


# ------------------------------------------------------------------ drill-through

DRILL_TITLES = {
    "total": "All assets on the register", "active": "Active assets", "out_of_service": "Out of service",
    "out_for_service": "Out for service", "awaiting_activation": "Awaiting activation",
    "pending_disposal": "Decommissioned — pending disposal", "disposed": "Disposed assets",
    "open_work_orders": "Assets with open work orders", "pm_overdue": "PM overdue (past due plus grace)",
    "nbv": "Book value by asset", "under_maintenance": "Under maintenance", "open_breakdowns": "Assets with open breakdowns",
    "critical_down": "High-criticality assets down", "outside_hospital": "Outside the hospital",
    "pending_approval": "Transfers awaiting approval", "pending_transfer": "Transfers in flight",
    "under_warranty": "Under warranty", "lost": "Lost / missing", "in_transit": "In transit",
    "high_uncovered": "High-criticality assets without warranty or AMC / CMC",
}


def _drill_pred(z: Analysis, bucket: str) -> tuple[str, Callable[[dict], bool]]:
    t = z.t
    nd = lambda a: a.get("status") != DISPOSED  # noqa: E731
    simple: dict[str, Callable[[dict], bool]] = {
        "total": lambda a: True,
        "active": lambda a: a.get("status") == ACTIVE,
        "out_of_service": lambda a: a.get("status") == OOS,
        "out_for_service": lambda a: a.get("status") == OFS,
        "awaiting_activation": lambda a: a.get("status") == AWAITING,
        "pending_disposal": lambda a: a.get("status") == DECOM,
        "disposed": lambda a: a.get("status") == DISPOSED,
        "nbv": lambda a: nd(a) and a["_cost"] > 0,
        "under_warranty": lambda a: nd(a) and bool(a["_warranty_end"] and a["_warranty_end"] >= t),
        "lost": lambda a: nd(a) and a["_where"] == "Lost / missing",
        "in_transit": lambda a: nd(a) and a["_where"] == "In transit",
        "high_uncovered": lambda a: a.get("status") in IN_SERVICE | {AWAITING} and is_high(a.get("criticality")) and a["_cover"] == "No cover",
    }
    if bucket in simple:
        return DRILL_TITLES[bucket], simple[bucket]
    sets: dict[str, Callable[[], set[str]]] = {
        "open_work_orders": z.work_order_ids, "pm_overdue": z.pm_overdue_ids, "under_maintenance": z.under_maintenance_ids,
        "open_breakdowns": z.ids_with_tickets, "critical_down": z.critical_down_ids, "outside_hospital": z.outside_ids,
        "pending_approval": lambda: z.transfer_ids(("Requested",)), "pending_transfer": z.transfer_ids,
    }
    if bucket in sets:
        ids = sets[bucket]()
        return DRILL_TITLES[bucket], lambda a: a["id"] in ids
    dim, _, val = bucket.partition(":")
    if not val:
        raise bad_request(f"Unknown bucket {bucket!r}")
    dims: dict[str, tuple[str, Callable[[dict], bool]]] = {
        "status": (val, lambda a: a.get("status") == val),
        "category": (f"Category · {val}", lambda a: (a.get("category") or "Uncategorised") == val),
        "department": ("Department", lambda a: (a.get("department") or "none") == val),
        "age": (f"Age {val}", lambda a: a["_age"] == val),
        "source": (f"Source · {val}", lambda a: (a.get("source") or "Manual entry") == val),
        "ownership": (f"Ownership · {val}", lambda a: (a.get("ownership") or "Owned") == val),
        "where": (val, lambda a: nd(a) and a["_where"] == val),
        "make": (f"Manufacturer · {val}", lambda a: (a.get("make") or "").strip() == val),
        "risk": (f"Risk class · {val}", lambda a: nd(a) and (a.get("risk_class") or "Not classified") == val),
        "method": (f"Depreciation · {val}", lambda a: nd(a) and (a.get("depreciation_method") or "SLM") == val),
        "cover": (f"Cover · {val}", lambda a: a.get("status") in IN_SERVICE | {AWAITING} and a["_cover"] == val),
        "insurance": (f"Insurance · {val}", lambda a: nd(a) and a["_insurance"] == val),
        "aerb": (f"AERB licence · {val}", lambda a: nd(a) and a["_aerb"] == val),
    }
    if dim == "due":  # due:<kind>:<overdue|due7|due_window|any>
        kind, _, urg = val.partition(":")
        if kind not in KIND_LABEL and kind != "all":
            raise bad_request(f"Unknown due type {kind!r}")

        def due_pred(a: dict) -> bool:
            return any((kind == "all" or d["kind"] == kind) and d["urgency"] is not None
                       and (urg in ("", "any") or d["urgency"] == urg or (urg == "due_window" and d["urgency"] == "due7")
                            or (urg == "due7" and d["urgency"] == "due_window" and d["days"] <= 7))
                       for d in a["_due"])

        return f"{KIND_LABEL.get(kind, 'All due')} · {urg or 'any'}", due_pred
    if dim not in dims:
        raise bad_request(f"Unknown bucket {bucket!r}")
    title, pred = dims[dim]
    if dim == "department":
        title = z.labels.get(val, "Unassigned") if val != "none" else "Unassigned"
    return title, pred


@router.get("/drill")
async def drill(ctx: CtxDep, bucket: str, period: str = "this_fy", date_from: str | None = None,
                date_to: str | None = None, window: int = 30, limit: int = 500) -> dict:
    if window not in WINDOWS:
        raise bad_request("Window must be 7, 30, 60 or 90 days")
    if period not in PERIODS:
        raise bad_request(f"Unknown period {period!r}")
    lo, hi, _label = resolve_period(period, date_from, date_to)
    finance_ok = can_finance(ctx)
    if not finance_ok and (bucket in FINANCE_BUCKETS or bucket.partition(":")[0] in FINANCE_DIMS):
        require_role(ctx, *FINANCE_ROLES)  # asset finance is for stores / management
    z = await analyse(ctx, lo=lo, hi=hi, window=window, earliest=lo)
    title, pred = _drill_pred(z, bucket)
    rows = [a for a in z.assets if pred(a)]
    if bucket == "nbv":
        rows.sort(key=lambda a: -a["_nbv"])
    else:
        rows.sort(key=lambda a: (LIFECYCLE.index(a["status"]) if a.get("status") in LIFECYCLE else 9, a.get("name") or ""))
    # the due date shown per row: the type the bucket is about (PM overdue → PM), else the most urgent
    focus = {"pm_overdue": "pm", "under_warranty": "warranty"}.get(bucket)
    if bucket.startswith("due:"):
        focus = bucket.split(":")[1] if bucket.split(":")[1] in KIND_LABEL else None
    out = []
    for a in rows[: max(1, min(limit, 1000))]:
        pool = [d for d in a["_due"] if d["urgency"] or (focus and d["kind"] == focus)]
        if focus and any(d["kind"] == focus for d in pool):
            pool = [d for d in pool if d["kind"] == focus]
        first_due = min(pool, key=lambda d: d["days"], default=None)
        out.append({**_asset_brief(a), "cost": a["_cost"] if finance_ok else None, "nbv": a["_nbv"] if finance_ok else None,
                    "warranty_until": _iso(a["_warranty_end"]),
                    "cover": a["_cover"], "down_since": a.get("down_since"),
                    "next_due": {"kind": KIND_LABEL[first_due["kind"]], "due": first_due["due"].isoformat(), "days": first_due["days"],
                                 "urgency": first_due["urgency"]} if first_due else None})
    return {"bucket": bucket, "title": title, "total": len(rows), "rows": out,
            "nbv": round(sum(a["_nbv"] for a in rows), 2) if finance_ok and bucket in ("nbv", "total") else None}


__all__ = ["router", "CRON", "dashboard", "drill", "analyse", "acc_depreciation", "resolve_period", "mark_overdue_pm"]
