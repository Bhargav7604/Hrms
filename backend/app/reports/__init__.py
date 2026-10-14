"""Report framework for the Reports Hub (module 51).

A report is a *definition* — code, name, category, description, filters, columns, a query
function that returns rows (+ summary tiles) and an optional chart. Two families exist:

* curated MIS reports, hand-written in `app/reports/<area>.py` (aggregated in SQL);
* a register report auto-generated for every record type from the module metadata
  (`app/reports/registers.py`) — filters from date_field / status / patient / doctor /
  department, columns from the list plus the key fields.

The engine (`app/engines/reports.py`) owns the HTTP API, caching, paging, exports, saved views,
favourites and schedules; this package only knows how to describe and compute a report.
"""

from __future__ import annotations

import hashlib
import importlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

import orjson

from ..core.rbac import check_access
from ..core.registry import get_entity
from ..core.util import bad_request, day_bounds, parse_date, to_json_value, today

log = logging.getLogger("vlack.reports")

FINANCE_ROLES = ("admin", "management", "billing", "quality")

# ====================================================================== periods

PERIODS: list[tuple[str, str]] = [
    ("today", "Today"), ("yesterday", "Yesterday"), ("this_week", "This week"), ("last_7", "Last 7 days"),
    ("this_month", "This month"), ("last_month", "Last month"), ("last_30", "Last 30 days"),
    ("this_quarter", "This quarter"), ("this_fy", "This FY"), ("last_fy", "Last FY"), ("all", "All dates"),
    ("custom", "Custom range"),
]
PERIOD_KEYS = {k for k, _ in PERIODS}


def fy_start(d: date) -> date:
    """Indian financial year: 1 April – 31 March."""
    return date(d.year if d.month >= 4 else d.year - 1, 4, 1)


def month_end(d: date) -> date:
    return (d.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def resolve_period(key: str | None, d_from: str | date | None = None, d_to: str | date | None = None,
                   ref: date | None = None) -> tuple[date | None, date | None]:
    """Preset → (from, to). `custom` (or explicit dates) uses the given dates; `all` → (None, None)."""
    t = ref or today()
    k = (key or "").strip()
    if k == "today":
        return t, t
    if k == "yesterday":
        y = t - timedelta(days=1)
        return y, y
    if k == "this_week":
        return t - timedelta(days=t.weekday()), t
    if k == "last_7":
        return t - timedelta(days=6), t
    if k == "this_month":
        return t.replace(day=1), t
    if k == "last_month":
        e = t.replace(day=1) - timedelta(days=1)
        return e.replace(day=1), e
    if k == "last_30":
        return t - timedelta(days=29), t
    if k == "this_quarter":
        qm = ((t.month - 1) // 3) * 3 + 1
        return date(t.year, qm, 1), t
    if k == "this_fy":
        return fy_start(t), t
    if k == "last_fy":
        s = fy_start(t)
        return date(s.year - 1, 4, 1), s - timedelta(days=1)
    if k == "all":
        return None, None
    try:
        a = parse_date(d_from) if d_from else None
        b = parse_date(d_to) if d_to else None
    except ValueError as e:
        raise bad_request("Dates must be YYYY-MM-DD") from e
    if a and not b:
        b = t
    if b and not a:
        a = b
    return a, b


def comparison_window(d_from: date, d_to: date, mode: str | None) -> tuple[date, date] | None:
    """`previous` = same number of days immediately before; `last_year` = same dates a year earlier."""
    if mode == "previous":
        days = (d_to - d_from).days + 1
        return d_from - timedelta(days=days), d_from - timedelta(days=1)
    if mode == "last_year":
        def back(d: date) -> date:
            try:
                return d.replace(year=d.year - 1)
            except ValueError:  # 29 Feb
                return d.replace(year=d.year - 1, day=28)
        return back(d_from), back(d_to)
    return None


# ====================================================================== definitions

COL_TYPES = {"text", "code", "number", "money", "percent", "date", "datetime", "minutes", "days", "status", "bool"}


@dataclass
class Col:
    key: str
    label: str
    type: str = "text"
    default: bool = True        # False → an EXTRA column (hidden until chosen)
    total: bool = False         # summed in the totals row
    link: str | None = None     # row key holding a URL to open (e.g. "_link")

    def public(self) -> dict:
        return {"key": self.key, "label": self.label, "type": self.type, "default": self.default, "total": self.total}


@dataclass
class Filter:
    key: str
    label: str
    type: str = "select"        # period | text | select | ref
    options: list[str] | None = None
    ref: str | None = None
    ref_filter: dict | None = None
    placeholder: str | None = None

    def public(self) -> dict:
        d = {"key": self.key, "label": self.label, "type": self.type}
        for k in ("options", "ref", "ref_filter", "placeholder"):
            if getattr(self, k) is not None:
                d[k] = getattr(self, k)
        return d


class F:
    """Standard filters used across reports."""

    period = Filter("period", "Period", "period")

    @staticmethod
    def search(placeholder: str = "Code / name…") -> Filter:
        return Filter("q", "Search", "text", placeholder=placeholder)

    doctor = Filter("doctor", "Doctor", "ref", ref="employees.employees", ref_filter={"category": "Doctor"}, placeholder="All doctors")
    department = Filter("department", "Department", "ref", ref="mdm.departments", placeholder="All departments")
    ward = Filter("ward", "Ward", "ref", ref="mdm.wards", placeholder="All wards")
    patient = Filter("patient", "Patient", "ref", ref="registration.patients", placeholder="Any patient")
    payer = Filter("payer", "Payer / Sponsor", "select", options=["Self / Cash", "Insurance", "Government Scheme", "Corporate"],
                   placeholder="All payers")
    mode = Filter("mode", "Payment mode", "select", options=["CASH", "CARD", "UPI", "BANK", "WALLET", "INSURANCE"], placeholder="All modes")
    store = Filter("store", "Store", "select", options=["Main Store", "OP Pharmacy", "IP Pharmacy", "OT Store", "Lab Store", "Ward Store"],
                   placeholder="All stores")

    @staticmethod
    def status(options: list[str]) -> Filter:
        return Filter("status", "Status", "select", options=options, placeholder="All")

    @staticmethod
    def select(key: str, label: str, options: list[str], placeholder: str = "All") -> Filter:
        return Filter(key, label, "select", options=options, placeholder=placeholder)

    @staticmethod
    def view(options: list[str]) -> Filter:
        return Filter("view", "View", "select", options=options, placeholder=options[0])


@dataclass
class Result:
    rows: list[dict]
    summary: list[dict] | None = None       # [{label, value, format}] — format: number|money|percent|minutes|days|text
    note: str | None = None
    chart: dict | None = None                # overrides the definition's chart (e.g. computed buckets)


RunFn = Callable[[Any, "Params"], Awaitable["Result | list[dict]"]]


@dataclass
class Report:
    code: str
    name: str
    category: str
    description: str
    columns: list[Col]
    run: RunFn
    filters: list[Filter] = field(default_factory=lambda: [F.period])
    chart: dict | None = None               # {"type": bar|line|area|donut, "x": key, "y": [keys], "horizontal": bool}
    access: tuple[str, ...] = ()            # entity fqns — the user must be able to read at least one
    roles: tuple[str, ...] = ()             # optional extra role gate (admin always passes)
    finance: bool = False                   # money: finance-facing roles only
    popular: bool = False
    tags: tuple[str, ...] = ()
    icon: str = "FileText"
    default_period: str = "this_month"
    max_days: int = 400
    kind: str = "curated"                   # curated | register | statutory
    handles_q: bool = False                 # the run function applies `q` itself
    default_sort: str | None = None

    def public(self, *, full: bool = False) -> dict:
        d = {"code": self.code, "name": self.name, "category": self.category, "description": self.description,
             "filters": [f.key for f in self.filters], "popular": self.popular, "tags": list(self.tags), "icon": self.icon,
             "kind": self.kind, "chart": bool(self.chart), "finance": self.finance}
        if full:
            d.update(filters=[f.public() for f in self.filters], columns=[c.public() for c in self.columns],
                     chart=self.chart, default_period=self.default_period, max_days=self.max_days, default_sort=self.default_sort)
        return d


# ====================================================================== params

RESERVED_PARAMS = {"period", "from", "to", "q", "page", "limit", "sort", "cols", "format", "token", "compare", "fresh", "branch"}


@dataclass
class Params:
    period: str
    d_from: date | None
    d_to: date | None
    q: str | None
    values: dict[str, str]

    def get(self, key: str, default: Any = None) -> Any:
        v = self.values.get(key)
        return v if v not in (None, "") else default

    @property
    def start(self) -> datetime | None:
        return day_bounds(self.d_from)[0] if self.d_from else None

    @property
    def end(self) -> datetime | None:
        """Exclusive upper bound (start of the day after `d_to`)."""
        return day_bounds(self.d_to)[1] if self.d_to else None

    @property
    def days(self) -> int:
        return (self.d_to - self.d_from).days + 1 if self.d_from and self.d_to else 0

    def label(self) -> str:
        if not self.d_from:
            return "All dates"
        if self.d_from == self.d_to:
            return f"{self.d_from:%d %b %Y}"
        return f"{self.d_from:%d %b %Y} – {self.d_to:%d %b %Y}"

    def cache_key(self) -> str:
        raw = orjson.dumps({"p": self.period, "f": str(self.d_from), "t": str(self.d_to), "q": self.q,
                            "v": {k: v for k, v in sorted(self.values.items())}}, option=orjson.OPT_SORT_KEYS)
        return hashlib.sha1(raw).hexdigest()[:16]


def parse_params(rep: Report, query: dict[str, str], *, ref: date | None = None) -> Params:
    allowed = {f.key for f in rep.filters}
    period = (query.get("period") or "").strip()
    has_dates = bool(query.get("from") or query.get("to"))
    if period and period not in PERIOD_KEYS:
        raise bad_request(f"Unknown period '{period}'")
    if not period:
        period = "custom" if has_dates else rep.default_period
    if "period" not in allowed:
        period = "all" if not has_dates else "custom"
    d_from, d_to = resolve_period(period, query.get("from"), query.get("to"), ref)
    if period == "custom" and not d_from:
        period, (d_from, d_to) = rep.default_period, resolve_period(rep.default_period, ref=ref)
    if d_from and d_to:
        if d_from > d_to:
            raise bad_request("'From' must be on or before 'To'")
        if (d_to - d_from).days >= rep.max_days:
            raise bad_request(f"Choose a period of at most {rep.max_days} days for this report")
    values = {k: str(v).strip() for k, v in query.items() if k in allowed and k not in RESERVED_PARAMS and str(v).strip()}
    q = (query.get("q") or "").strip()[:100] or None
    return Params(period=period, d_from=d_from, d_to=d_to, q=q, values=values)


# ====================================================================== access

def can_view(user: dict, rep: Report) -> bool:
    role = user.get("role")
    if role == "admin":
        return True
    if rep.finance and role not in FINANCE_ROLES:
        return False
    if rep.roles and role not in rep.roles:
        return False
    if rep.access:
        for fqn in rep.access:
            ent = get_entity(fqn)
            if ent and check_access(user, ent.module, ent, "read").ok:
                return True
        return False
    return True


# ====================================================================== registry

REPORTS: dict[str, Report] = {}
CATEGORY_INFO: dict[str, dict] = {}
_loaded = False

CURATED_MODULES = ("mis", "finance", "clinical", "quality", "supply", "people")


def category(name: str, description: str, icon: str = "FileText", order: int = 100) -> str:
    CATEGORY_INFO.setdefault(name, {"name": name, "description": description, "icon": icon, "order": order})
    return name


def register(rep: Report) -> Report:
    if rep.code in REPORTS:
        raise RuntimeError(f"duplicate report code {rep.code}")
    for c in rep.columns:
        if c.type not in COL_TYPES:
            raise RuntimeError(f"{rep.code}: column {c.key} has unknown type {c.type}")
    REPORTS[rep.code] = rep
    return rep


def report(code: str, name: str, cat: str, description: str, columns: list[Col], **kw: Any):
    """Decorator: `@report("MIS-01", "Daily Flash Report", MIS, "…", [Col(...)], filters=[...])` on the run function."""
    def deco(fn: RunFn) -> RunFn:
        register(Report(code=code, name=name, category=cat, description=description, columns=columns, run=fn, **kw))
        return fn
    return deco


def buckets(start: date, end: date, view: str | None) -> list[tuple[str, str]]:
    """Period buckets (key as produced by `_sql.bucket`, display label) covering start..end."""
    out: list[tuple[str, str]] = []
    v = (view or "Day").lower()
    if v == "month":
        d = start.replace(day=1)
        while d <= end:
            out.append((d.strftime("%Y-%m"), d.strftime("%b %Y")))
            d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    elif v == "week":
        d = start - timedelta(days=start.weekday())
        while d <= end:
            out.append((d.isoformat(), f"w/c {d:%d %b %Y}"))
            d += timedelta(days=7)
    else:
        d = start
        while d <= end:
            out.append((d.isoformat(), d.strftime("%d %b %Y")))
            d += timedelta(days=1)
    return out


def load() -> dict[str, Report]:
    """Import the curated report modules, then generate a register for every record type."""
    global _loaded
    if _loaded:
        return REPORTS
    _loaded = True
    for name in CURATED_MODULES:
        try:
            importlib.import_module(f"app.reports.{name}")
        except Exception:  # a broken report module must not take the hub down
            log.exception("report module %s failed to load", name)
    from .registers import build_registers

    build_registers()
    return REPORTS


def get_report(code: str) -> Report | None:
    load()
    return REPORTS.get(code) or REPORTS.get(code.upper())


# ====================================================================== results

def normalise(rows: list[dict]) -> list[dict]:
    """DB values → JSON-friendly (Decimal → float, dates → ISO) so results cache and serialise cleanly."""
    out = []
    for r in rows:
        out.append({k: to_json_value(v) for k, v in r.items()})
    return out


def default_summary(rep: Report, rows: list[dict]) -> list[dict]:
    tiles = [{"label": "Rows", "value": len(rows), "format": "number"}]
    for c in rep.columns:
        if c.total and c.default and len(tiles) < 7:
            tiles.append({"label": c.label, "value": round(sum(float(r.get(c.key) or 0) for r in rows), 2),
                          "format": "money" if c.type == "money" else "number"})
    return tiles


def totals(rep: Report, rows: list[dict]) -> dict:
    out: dict[str, float] = {}
    for c in rep.columns:
        if c.total:
            out[c.key] = round(sum(float(r.get(c.key) or 0) for r in rows if isinstance(r.get(c.key), (int, float))), 2)
    return out


def chart_data(rep: Report, rows: list[dict], override: dict | None = None, limit: int = 60) -> dict | None:
    spec = override or rep.chart
    if not spec:
        return None
    if spec.get("data") is not None:
        return spec
    y = spec.get("y") or []
    labels = {c.key: c.label for c in rep.columns}
    types = {c.key: c.type for c in rep.columns}
    data = [{spec["x"]: r.get(spec["x"]), **{k: r.get(k) for k in y}} for r in rows[:limit]]
    if spec.get("type") == "line" or spec.get("type") == "area":
        data = list(reversed(data)) if spec.get("reverse") else data
    return {**spec, "y": [{"key": k, "label": labels.get(k, k), "type": types.get(k, "number")} for k in y], "data": data,
            "truncated": len(rows) > limit}


__all__ = [
    "Col", "Filter", "F", "Report", "Result", "Params", "REPORTS", "CATEGORY_INFO", "PERIODS", "FINANCE_ROLES",
    "register", "report", "buckets", "category", "load", "get_report", "can_view", "parse_params", "resolve_period", "comparison_window",
    "normalise", "default_summary", "totals", "chart_data", "fy_start", "month_end",
]
