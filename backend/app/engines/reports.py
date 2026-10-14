"""Reports Hub engine (module 51): catalogue, generic report runner, exports, saved views,
favourites / recently used, and scheduled deliveries through the notifications outbox.

* Every report is a definition in `app/reports/**` (curated MIS reports + a register per record type).
* Visibility is role-based: a report is listed and runnable only when the user's role can read at
  least one of its source entities (`rbac.check_access`); money reports need a finance-facing role.
* Results are aggregated in SQL, cached in Redis for a minute (`app.redis.cached`) and paged / sorted
  from the cached set, so paging, sorting and exports never re-query.
* Schedules are `analytics.saved_reports` rows (kind = Schedule). The worker runs due schedules every
  15 minutes: it renders the report (CSV / Excel / PDF) into a stored file, queues one outbox message
  per recipient (emails, and users of the chosen roles who may open the report) and records an
  `analytics.report_deliveries` row.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, time, timedelta
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import reports as R
from ..config import settings
from ..core.audit import audit
from ..core.security import CtxDep
from ..core.util import ApiError, bad_request, forbidden, is_uuid, new_id, not_found, now, parse_dt, today
from ..db import system_ctx
from ..redis import PREFIX, cached, get_redis
from ..reports import export as R_EXPORT
from ..schema import employees, files, records, users
from ._common import create, find, get, update

log = logging.getLogger("vlack.reports")
router = APIRouter(prefix="/api/reports", tags=["reports"])

SAVED = "analytics.saved_reports"
PREFS = "analytics.preferences"
DELIVERIES = "analytics.report_deliveries"
OUTBOX = "notifications.outbox"
MANAGER_ROLES = ("admin", "management", "quality")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
FORMAT_KEYS = {"CSV": "csv", "Excel": "xlsx", "PDF": "pdf"}
DEFAULT_SCHEDULE_PERIOD = {"Daily": "yesterday", "Weekly": "last_7", "Monthly": "last_month"}
LEGACY_PERIODS = {"Today": "today", "Yesterday": "yesterday", "Last 7 days": "last_7", "Month to date": "this_month",
                  "Last month": "last_month", "Quarter to date": "this_quarter", "Financial year to date": "this_fy"}
RECENT_MAX = 12


# ====================================================================== access & execution

def get_visible(ctx, code: str) -> R.Report:
    rep = R.get_report(code)
    if not rep:
        raise not_found(f"Unknown report '{code}'")
    if not R.can_view(ctx.user, rep):
        raise forbidden("Your role cannot open this report")
    return rep


def _match(row: dict, q: str) -> bool:
    ql = q.lower()
    return any(isinstance(v, str) and ql in v.lower() for k, v in row.items() if not k.startswith("_"))


async def execute(ctx, rep: R.Report, query: dict[str, Any], *, use_cache: bool = True, refresh: bool = False) -> tuple[R.Params, dict]:
    """Parse the filters, run the report (cached) and return (params, {rows, summary, note, chart})."""
    p = R.parse_params(rep, {k: str(v) for k, v in query.items() if v is not None})

    async def compute() -> dict:
        res = await rep.run(ctx, p)
        if isinstance(res, list):
            res = R.Result(res)
        rows = R.normalise(res.rows)
        if p.q and not rep.handles_q:
            rows = [r for r in rows if _match(r, p.q)]
        return {"rows": rows, "summary": res.summary or R.default_summary(rep, rows), "note": res.note, "chart": res.chart}

    if not use_cache:
        return p, await compute()
    ttl = 30 if rep.kind == "register" else 60
    key = f"rep:{rep.code}:{getattr(ctx, 'branch', None) or '-'}:{p.cache_key()}"
    if refresh:
        from ..redis import invalidate

        await invalidate(key)
    return p, await cached(key, ttl, compute)


def sort_rows(rows: list[dict], key: str | None) -> list[dict]:
    if not key:
        return rows
    desc = key.startswith("-")
    k = key.lstrip("-")
    present = [r for r in rows if r.get(k) not in (None, "")]
    missing = [r for r in rows if r.get(k) in (None, "")]

    def sk(r):
        v = r[k]
        return (1, v.lower()) if isinstance(v, str) else (0, float(v) if isinstance(v, (int, float)) else 0)

    present.sort(key=sk, reverse=desc)
    return present + missing


def _period_out(p: R.Params) -> dict:
    return {"key": p.period, "from": p.d_from.isoformat() if p.d_from else None, "to": p.d_to.isoformat() if p.d_to else None,
            "label": p.label()}


async def _popular_bump(code: str) -> None:
    try:
        await get_redis().zincrby(f"{PREFIX}reports:popular", 1, code)
    except Exception:  # popularity is a nicety; never fail a report for it
        pass


async def _popular() -> list[str]:
    try:
        return list(await get_redis().zrevrange(f"{PREFIX}reports:popular", 0, 11))
    except Exception:
        return []


# ====================================================================== preferences (favourites / recent)

async def prefs(ctx, *, create_missing: bool = False) -> dict | None:
    rows = await find(ctx, PREFS, user_key=ctx.user_id, limit=1)
    if rows:
        return rows[0]
    if not create_missing:
        return None
    return await create(ctx, PREFS, {"user_key": ctx.user_id, "user_name": ctx.user.get("name")})


async def toggle_pref(ctx, key: str, value: str) -> bool:
    rec = await prefs(ctx, create_missing=True)
    cur = list(rec.get(key) or [])
    on = value not in cur
    cur = [*cur, value] if on else [x for x in cur if x != value]
    await update(ctx, PREFS, rec["id"], {key: cur})
    return on


async def push_recent(ctx, key: str, value: str) -> None:
    rec = await prefs(ctx)
    cur = list((rec or {}).get(key) or [])
    if cur[:1] == [value]:
        return  # already the most recent — no write
    cur = [value, *[x for x in cur if x != value]][:RECENT_MAX]
    if rec:
        await update(ctx, PREFS, rec["id"], {key: cur})
    else:
        await create(ctx, PREFS, {"user_key": ctx.user_id, "user_name": ctx.user.get("name"), key: cur})


# ====================================================================== catalogue & run

@router.get("/catalog")
async def catalog_api(ctx: CtxDep):
    R.load()
    visible = [r for r in R.REPORTS.values() if R.can_view(ctx.user, r)]
    codes = {r.code for r in visible}
    pr = await prefs(ctx) or {}
    counts: dict[str, int] = {}
    for r in visible:
        counts[r.category] = counts.get(r.category, 0) + 1
    cats = []
    for name, n in counts.items():
        info = R.CATEGORY_INFO.get(name, {"name": name, "description": "", "icon": "FileText", "order": 999})
        cats.append({**info, "count": n})
    cats.sort(key=lambda c: (c["order"], c["name"]))
    hot = [c for c in await _popular() if c in codes]
    popular = list(dict.fromkeys([*hot[:8], *[r.code for r in visible if r.popular]]))
    return {"total": len(visible), "categories": cats, "reports": [r.public() for r in visible],
            "favourites": [c for c in pr.get("favourite_reports") or [] if c in codes],
            "recent": [c for c in pr.get("recent_reports") or [] if c in codes], "popular": popular,
            "periods": [{"key": k, "label": lbl} for k, lbl in R.PERIODS]}


def _owner_filter(rows: list[dict], ctx) -> list[dict]:
    return [v for v in rows if v.get("owner_user") == ctx.user_id or (v.get("shared") and v.get("owner_role") == ctx.role)]


def _view_out(v: dict, ctx) -> dict:
    return {"id": v["id"], "code": v.get("code"), "name": v.get("name"), "state": v.get("state") or {}, "shared": bool(v.get("shared")),
            "mine": v.get("owner_user") == ctx.user_id, "owner": v.get("owner_name")}


def _sched_out(s: dict, ctx) -> dict:
    keys = ("id", "code", "name", "report_code", "schedule", "schedule_time", "weekday", "month_day", "period", "recipients",
            "recipient_roles", "format", "next_run_at", "last_run_at", "last_status", "status", "owner_name")
    return {**{k: s.get(k) for k in keys}, "period": s.get("report_period") or LEGACY_PERIODS.get(s.get("period") or "") or s.get("period"),
            "state": s.get("state") or {}, "mine": s.get("owner_user") == ctx.user_id}


async def _schedules_for(ctx, code: str | None = None) -> list[dict]:
    kw = {"report_code": code} if code else {}
    rows = await find(ctx, SAVED, kind="Schedule", status=["Active", "Paused"], limit=500, sort="-created_at", **kw)
    if ctx.role not in MANAGER_ROLES:
        rows = [s for s in rows if s.get("owner_user") == ctx.user_id]
    return rows


@router.get("/schedules/mine")
async def my_schedules(ctx: CtxDep):
    out = []
    for s in await _schedules_for(ctx):
        rep = R.get_report(s.get("report_code") or "")
        out.append({**_sched_out(s, ctx), "report_name": rep.name if rep else s.get("report_code")})
    return out


@router.get("/{code}")
async def report_meta(code: str, ctx: CtxDep):
    rep = get_visible(ctx, code)
    pr = await prefs(ctx) or {}
    views = _owner_filter(await find(ctx, SAVED, kind="View", report_code=rep.code, status="Active", limit=200, sort="name"), ctx)
    scheds = await _schedules_for(ctx, rep.code)
    return {**rep.public(full=True), "favourite": rep.code in (pr.get("favourite_reports") or []),
            "views": [_view_out(v, ctx) for v in views], "schedules": [_sched_out(s, ctx) for s in scheds],
            "periods": [{"key": k, "label": lbl} for k, lbl in R.PERIODS], "hospital": settings.hospital_name}


@router.get("/{code}/run")
async def run_api(code: str, request: Request, ctx: CtxDep, page: int = 1, limit: int = 25, sort: str | None = None, fresh: bool = False):
    rep = get_visible(ctx, code)
    p, data = await execute(ctx, rep, dict(request.query_params), refresh=fresh)
    natural = data["rows"]
    rows = sort_rows(natural, sort or rep.default_sort)
    limit = max(1, min(limit, 1000))
    page = max(1, page)
    if page == 1:
        await push_recent(ctx, "recent_reports", rep.code)
        await _popular_bump(rep.code)
    return {"rows": rows[(page - 1) * limit: page * limit], "total": len(rows), "page": page, "limit": limit,
            "totals": R.totals(rep, rows), "summary": data["summary"], "note": data["note"],
            "chart": R.chart_data(rep, natural, data.get("chart")), "period": _period_out(p), "generated_at": now().isoformat(timespec="seconds")}


async def _filter_text(ctx, rep: R.Report, p: R.Params) -> str:
    parts = [p.label()]
    ids = [v for k, v in p.values.items() if is_uuid(v)]
    names: dict[str, str] = {}
    if ids:
        for t, col in ((records, records.c.title), (employees, employees.c.name)):
            res = await ctx.conn.execute(sa.select(t.c.id, col).where(t.c.id.in_(ids)))
            names.update({str(i): n for i, n in res.all()})
    for f in rep.filters:
        v = p.values.get(f.key)
        if v and f.key not in ("period",):
            parts.append(f"{f.label}: {names.get(v, v)}")
    if p.q:
        parts.append(f"Search: {p.q}")
    return " · ".join(parts)


def _columns(rep: R.Report, cols: str | None) -> list[dict]:
    by = {c.key: c.public() for c in rep.columns}
    if cols:
        chosen = [by[k] for k in cols.split(",") if k in by]
        if chosen:
            return chosen
    return [c for c in by.values() if c["default"]]


async def render(ctx, rep: R.Report, query: dict, fmt: str, *, cols: str | None = None, sort: str | None = None,
                 use_cache: bool = True) -> tuple[bytes, str, str, R.Params, int]:
    if fmt not in R_EXPORT.FORMATS:
        raise bad_request("Format must be csv, xlsx or pdf")
    p, data = await execute(ctx, rep, query, use_cache=use_cache)
    rows = sort_rows(data["rows"], sort or rep.default_sort)
    columns = _columns(rep, cols)
    keys = {c["key"] for c in columns}
    tot = {k: v for k, v in R.totals(rep, rows).items() if k in keys}
    mime, ext, writer = R_EXPORT.FORMATS[fmt]
    subtitle = f"{settings.hospital_name} · {await _filter_text(ctx, rep, p)} · {len(rows):,} rows"
    body = writer(columns, rows, tot or None, f"{rep.code} {rep.name}", subtitle)
    fname = f"{rep.code}-{(p.d_from or today()).isoformat()}{'_' + p.d_to.isoformat() if p.d_to and p.d_to != p.d_from else ''}.{ext}"
    return body, mime, fname, p, len(rows)


@router.get("/{code}/export")
async def export_api(code: str, request: Request, ctx: CtxDep, format: str = "csv", cols: str | None = None, sort: str | None = None):
    rep = get_visible(ctx, code)
    query = {k: v for k, v in request.query_params.items() if k not in ("format", "cols", "sort", "token")}
    if format == "json":  # print view: every row, chosen columns
        p, data = await execute(ctx, rep, query)
        rows = sort_rows(data["rows"], sort or rep.default_sort)
        columns = _columns(rep, cols)
        keys = {c["key"] for c in columns}
        await audit(ctx, "report.print", module="analytics", entity="saved_reports", note=f"{rep.code} · {p.label()} · {len(rows)} rows")
        return {"columns": columns, "rows": rows, "totals": {k: v for k, v in R.totals(rep, rows).items() if k in keys},
                "summary": data["summary"], "filters": await _filter_text(ctx, rep, p), "period": _period_out(p)}
    body, mime, fname, p, n = await render(ctx, rep, query, format, cols=cols, sort=sort)
    await audit(ctx, "report.export", module="analytics", entity="saved_reports", note=f"{rep.code} · {format} · {p.label()} · {n} rows")
    return Response(body, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{fname}"', "Cache-Control": "no-store"})


@router.post("/{code}/favourite")
async def favourite_api(code: str, ctx: CtxDep):
    rep = get_visible(ctx, code)
    return {"favourite": await toggle_pref(ctx, "favourite_reports", rep.code)}


# ====================================================================== saved views

class ViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    state: dict = Field(default_factory=dict)
    shared: bool = False


def _clean_state(rep: R.Report, state: dict) -> dict:
    keys = {f.key for f in rep.filters} | {"period", "from", "to", "q"}
    cols = {c.key for c in rep.columns}
    filters = {k: str(v)[:200] for k, v in (state.get("filters") or {}).items() if k in keys and v not in (None, "")}
    out = {"filters": filters}
    if isinstance(state.get("columns"), list):
        out["columns"] = [c for c in state["columns"] if c in cols][:200]
    if isinstance(state.get("sort"), str) and state["sort"].lstrip("-") in cols:
        out["sort"] = state["sort"]
    if state.get("density") in ("comfortable", "compact"):
        out["density"] = state["density"]
    if state.get("view") in ("table", "chart"):
        out["view"] = state["view"]
    return out


@router.post("/{code}/views", status_code=201)
async def save_view(code: str, body: ViewIn, ctx: CtxDep):
    rep = get_visible(ctx, code)
    st = _clean_state(rep, body.state)
    rec = await create(ctx, SAVED, {
        "name": body.name.strip(), "kind": "View", "report_code": rep.code, "report_type": "Custom", "status": "Active",
        "columns": st.get("columns"), "shared": body.shared, "owner": ctx.user.get("employee_id"), "owner_user": ctx.user_id,
        "owner_role": ctx.role, "owner_name": ctx.user.get("name"), "state": st,
    })
    return _view_out(rec, ctx)


async def _own(ctx, sid: str, kind: str) -> dict:
    rec = await get(ctx, SAVED, sid) if is_uuid(sid) else None
    if not rec or rec.get("kind") != kind:
        raise not_found(f"{kind} not found")
    if rec.get("owner_user") != ctx.user_id and ctx.role not in MANAGER_ROLES:
        raise forbidden(f"Only the owner can change this {kind.lower()}")
    return rec


@router.delete("/views/{vid}")
async def delete_view(vid: str, ctx: CtxDep):
    rec = await _own(ctx, vid, "View")
    await update(ctx, SAVED, rec["id"], {"status": "Archived"})
    return {"ok": True}


# ====================================================================== schedules

def next_run(freq: str, at: str, weekday: str | None, month_day: int | None, after: datetime) -> datetime:
    hh, mm = (int(x) for x in (at or "08:00").split(":"))
    base = after.astimezone(settings.tz)
    cand = base.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if freq == "Daily":
        return cand if cand > base else cand + timedelta(days=1)
    if freq == "Weekly":
        wd = WEEKDAYS.index(weekday) if weekday in WEEKDAYS else 0
        cand = cand + timedelta(days=(wd - cand.weekday()) % 7)
        return cand if cand > base else cand + timedelta(days=7)
    day = max(1, min(int(month_day or 1), 28))
    cand = cand.replace(day=day)
    if cand <= base:
        cand = (cand.replace(day=28) + timedelta(days=4)).replace(day=day)
    return cand


class ScheduleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    schedule: str = Field(pattern="^(Daily|Weekly|Monthly)$")
    schedule_time: str = "08:00"
    weekday: str | None = None
    month_day: int | None = Field(default=None, ge=1, le=28)
    period: str | None = None
    recipients: list[str] = Field(default_factory=list)
    recipient_roles: list[str] = Field(default_factory=list)
    format: str = Field(default="Excel", pattern="^(CSV|Excel|PDF)$")
    state: dict = Field(default_factory=dict)


@router.post("/{code}/schedules", status_code=201)
async def create_schedule(code: str, body: ScheduleIn, ctx: CtxDep):
    from ..core.rbac import ROLES

    rep = get_visible(ctx, code)
    if not TIME_RE.match(body.schedule_time):
        raise bad_request("Send time must be HH:MM (24-hour)")
    if body.schedule == "Weekly" and body.weekday not in WEEKDAYS:
        raise bad_request("Choose the day of the week")
    emails = sorted({e.strip().lower() for e in body.recipients if e.strip()})
    bad = [e for e in emails if not EMAIL_RE.match(e)]
    if bad:
        raise bad_request(f"Invalid email address: {', '.join(bad[:3])}")
    roles = [r for r in body.recipient_roles if r in ROLES and r != "employee"]
    if not emails and not roles:
        raise bad_request("Add at least one recipient — an email address or a role")
    period = body.period if body.period in R.PERIOD_KEYS and body.period not in ("custom",) else DEFAULT_SCHEDULE_PERIOD[body.schedule]
    st = _clean_state(rep, body.state)
    st["filters"] = {k: v for k, v in st["filters"].items() if k not in ("period", "from", "to")}
    nxt = next_run(body.schedule, body.schedule_time, body.weekday, body.month_day, now())
    rec = await create(ctx, SAVED, {
        "name": body.name.strip(), "kind": "Schedule", "report_code": rep.code, "report_type": "Custom", "status": "Active",
        "schedule": body.schedule, "schedule_time": body.schedule_time, "weekday": body.weekday if body.schedule == "Weekly" else None,
        "month_day": body.month_day if body.schedule == "Monthly" else None, "recipients": emails, "recipient_roles": roles,
        "format": body.format, "columns": st.get("columns"), "owner": ctx.user.get("employee_id"), "owner_user": ctx.user_id,
        "owner_role": ctx.role, "owner_name": ctx.user.get("name"), "next_run_at": nxt.isoformat(timespec="minutes"),
        "report_period": period, "state": st,
    })
    await audit(ctx, "report.schedule", module="analytics", entity="saved_reports", record=rec,
                note=f"{rep.code} {body.schedule} {body.schedule_time} → {', '.join(emails + roles)}")
    return _sched_out(rec, ctx)


class StatusIn(BaseModel):
    status: str = Field(pattern="^(Active|Paused|Archived)$")


@router.post("/schedules/{sid}/status")
async def schedule_status(sid: str, body: StatusIn, ctx: CtxDep):
    rec = await _own(ctx, sid, "Schedule")
    patch: dict[str, Any] = {"status": body.status}
    if body.status == "Active":
        patch["next_run_at"] = next_run(rec.get("schedule") or "Daily", rec.get("schedule_time") or "08:00", rec.get("weekday"),
                                        rec.get("month_day"), now()).isoformat(timespec="minutes")
    return _sched_out(await update(ctx, SAVED, rec["id"], patch), ctx)


@router.post("/schedules/{sid}/run")
async def schedule_run_now(sid: str, ctx: CtxDep):
    rec = await _own(ctx, sid, "Schedule")
    get_visible(ctx, rec.get("report_code") or "")
    return await deliver(ctx, rec, trigger="Run now")


@router.get("/deliveries/recent")
async def recent_deliveries(ctx: CtxDep, report: str | None = None):
    kw = {"report_code": report} if report else {}
    rows = await find(ctx, DELIVERIES, limit=30, sort="-run_at", **kw)
    if ctx.role not in MANAGER_ROLES:
        mine = {s["id"] for s in await _schedules_for(ctx)}
        rows = [d for d in rows if d.get("schedule") in mine]
    return [{k: d.get(k) for k in ("id", "code", "report_code", "report_name", "run_at", "period_label", "rows", "format", "file", "recipients",
                                   "messages", "trigger", "status", "error")} for d in rows]


# ---------------------------------------------------------------- delivery

async def _store_file(ctx, body: bytes, name: str, mime: str) -> str:
    fid = new_id()
    ext = name.rsplit(".", 1)[-1]
    rel = f"reports/{now():%Y/%m}/{fid}.{ext}"
    dest = settings.upload_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    ts = now()
    await ctx.conn.execute(files.insert().values(
        id=fid, code=fid[:8].upper(), title=name, name=name, mime=mime.split(";")[0], size=len(body), path=rel, status="Active",
        created_by=ctx.user_id, created_at=ts, branch_id=settings.branch_id))
    return fid


async def _role_recipients(ctx, rep: R.Report, roles: list[str]) -> list[tuple[str, str]]:
    """(channel, recipient) for active users of the roles — only roles allowed to open the report."""
    allowed = [r for r in roles if R.can_view({"role": r}, rep)]
    if not allowed:
        return []
    res = await ctx.conn.execute(sa.select(users.c.username, users.c.email).where(users.c.role.in_(allowed), users.c.active.is_(True)))
    return [("EMAIL", e) if e and EMAIL_RE.match(e) else ("PUSH", u) for u, e in res.all()]


async def deliver(ctx, sched: dict, *, trigger: str = "Schedule") -> dict:
    from .notify import kick

    rep = R.get_report(sched.get("report_code") or "")
    t = now()
    patch: dict[str, Any] = {"last_run_at": t.isoformat(timespec="seconds")}
    if trigger == "Schedule" or not sched.get("next_run_at"):
        patch["next_run_at"] = next_run(sched.get("schedule") or "Daily", sched.get("schedule_time") or "08:00", sched.get("weekday"),
                                        sched.get("month_day"), t).isoformat(timespec="minutes")
    if not rep:
        await update(ctx, SAVED, sched["id"], {**patch, "last_status": "Report no longer exists"})
        return {"status": "Failed", "error": "Report no longer exists"}
    state = sched.get("state") or {}
    period = sched.get("report_period") or LEGACY_PERIODS.get(sched.get("period") or "") or DEFAULT_SCHEDULE_PERIOD.get(sched.get("schedule") or "", "yesterday")
    query = {**(state.get("filters") or {}), "period": period}
    fmt = FORMAT_KEYS.get(sched.get("format") or "Excel", "xlsx")
    cols = ",".join(state.get("columns") or sched.get("columns") or []) or None
    try:
        body, mime, fname, p, n = await render(ctx, rep, query, fmt, cols=cols, sort=state.get("sort"), use_cache=False)
    except ApiError as e:
        msg = (e.detail or {}).get("message") if isinstance(e.detail, dict) else str(e.detail)
        dl = await create(ctx, DELIVERIES, {"schedule": sched["id"], "report_code": rep.code, "report_name": rep.name, "run_at": t.isoformat(timespec="seconds"),
                                             "trigger": trigger, "status": "Failed", "error": msg, "format": sched.get("format")})
        await update(ctx, SAVED, sched["id"], {**patch, "last_status": f"Failed: {msg}"[:200]})
        return {"status": "Failed", "error": msg, "delivery": dl.get("code")}
    fid = await _store_file(ctx, body, fname, mime)
    targets: list[tuple[str, str]] = [("EMAIL", e) for e in sched.get("recipients") or []]
    targets += await _role_recipients(ctx, rep, list(sched.get("recipient_roles") or []))
    targets = list(dict.fromkeys(targets))
    subject = f"{rep.name} — {p.label()}"
    text = (f"{settings.hospital_name}: {rep.code} {rep.name} for {p.label()} ({n:,} rows) is ready. "
            f"Open Vlack › Reports Hub › {rep.name}, or download the {sched.get('format') or 'Excel'} file: /api/files/{fid}")
    ids = []
    for channel, to in targets:
        row = await create(ctx, OUTBOX, {"channel": channel, "recipient": to, "template": "report.scheduled", "message": text,
                                         "subject": subject, "attempts": 0, "status": "Queued", "ref_id": sched["id"], "file_id": fid})
        ids.append(row["id"])
    status = "Sent" if ids else "Skipped"
    dl = await create(ctx, DELIVERIES, {
        "schedule": sched["id"], "report_code": rep.code, "report_name": rep.name, "run_at": t.isoformat(timespec="seconds"),
        "period_label": p.label(), "rows": n, "format": sched.get("format") or "Excel", "file": fid,
        "recipients": [to for _, to in targets], "messages": len(ids), "trigger": trigger, "status": status,
        "error": None if ids else "No recipient could receive this report (roles without access are skipped)",
    })
    await update(ctx, SAVED, sched["id"], {**patch, "last_status": f"{status} · {len(ids)} message(s) · {n:,} rows"})
    await audit(ctx, "report.deliver", module="analytics", entity="report_deliveries", record=dl,
                note=f"{rep.code} {p.label()} → {len(ids)} recipient(s)")
    if ids:
        ctx.on_commit(lambda: kick(ids))
    return {"status": status, "delivery": dl.get("code"), "delivery_id": dl["id"], "messages": len(ids), "rows": n, "file": fid,
            "recipients": [to for _, to in targets]}


async def run_due(ctx) -> int:
    t = now().isoformat(timespec="minutes")
    r = records
    nra = r.c.data["next_run_at"].astext
    rows = (await ctx.conn.execute(sa.select(r.c.id).where(
        r.c.module == "analytics", r.c.entity == "saved_reports", r.c.deleted_at.is_(None), r.c.status == "Active",
        r.c.data["kind"].astext == "Schedule", nra.isnot(None), nra <= t).order_by(nra).limit(50))).scalars().all()
    done = 0
    for sid in rows:
        sched = await get(ctx, SAVED, str(sid))
        if not sched:
            continue
        try:
            async with ctx.conn.begin_nested():
                await deliver(ctx, sched)
            done += 1
        except Exception as e:  # one failing schedule must not block the others
            log.exception("scheduled report %s failed", sched.get("code"))
            async with ctx.conn.begin_nested():
                await update(ctx, SAVED, sched["id"], {
                    "last_status": f"Failed: {str(e)[:150]}", "last_run_at": now().isoformat(timespec="seconds"),
                    "next_run_at": next_run(sched.get("schedule") or "Daily", sched.get("schedule_time") or "08:00", sched.get("weekday"),
                                            sched.get("month_day"), now()).isoformat(timespec="minutes")})
    return done


async def cron_reports(_arq_ctx) -> int:
    async with system_ctx() as ctx:
        n = await run_due(ctx)
    if n:
        log.info("scheduled reports delivered: %s", n)
    return n


CRON = [(cron_reports, {"minute": {0, 15, 30, 45}})]

__all__ = ["router", "CRON", "execute", "get_visible", "prefs", "toggle_pref", "push_recent", "deliver", "run_due", "next_run",
           "sort_rows", "time", "parse_dt"]
