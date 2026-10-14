"""Queue management: daily tokens per queue (counter queues REG / BILL / PHARM / LAB and doctor
cabins `DR-<employee code>`), priority ordering, call / recall / skip / serve / done at a counter,
the counter console, the public TV board (token numbers and counter names only — DPDP) and
wait-time statistics. Every change is published on the realtime `queue` channel."""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit
from ..core.security import CtxDep, PublicCtxDep
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    is_uuid,
    not_found,
    now,
    parse_date,
    parse_dt,
    to_json_value,
    today,
)
from ..schema import appointments, employees, patients, queue_tokens, records
from ._common import E, create, find, get, live, update

router = APIRouter(prefix="/api/queue", tags=["queue"])
public_router = APIRouter(prefix="/api/public/queue", tags=["public"])

FQN = "queue.tokens"
QUEUE_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,30}$")
PRIORITIES = ("Emergency", "Senior Citizen", "Differently Abled", "Normal")
COUNTER_QUEUE_NAMES = {"REG": "Registration", "BILL": "Billing", "PHARM": "Pharmacy", "LAB": "Sample Collection",
                       "RAD": "Radiology", "HELP": "Help Desk"}
ACTIVE = ("Called", "Serving")
# action → (allowed from-statuses, resulting status)
ACTIONS: dict[str, tuple[tuple[str, ...], str]] = {
    "call": (("Waiting", "Skipped"), "Called"),
    "recall": (("Called",), "Called"),
    "serve": (("Called",), "Serving"),
    "done": (("Called", "Serving"), "Done"),
    "skip": (("Waiting", "Called"), "Skipped"),
}


def _t():
    return queue_tokens


def priority_rank():
    """Emergency first, then senior citizens / differently abled, then everyone else."""
    p = _t().c.data["priority"].astext
    return sa.case((p == "Emergency", 0), (p.in_(["Senior Citizen", "Differently Abled"]), 1), else_=2)


def token_label(queue: str, n: int | None) -> str:
    """REG-007 at counters; doctor cabins show the plain appointment token (007)."""
    if n is None:
        return "—"
    return f"{n:03d}" if queue.startswith("DR-") else f"{queue}-{n:03d}"


def _check_queue_key(queue: str) -> str:
    q = (queue or "").strip().upper()
    if not QUEUE_RE.match(q):
        raise bad_request("Invalid queue key — use REG, BILL, PHARM, LAB or DR-<doctor code>")
    return q


def doctor_queue(doctor_code: str) -> str:
    return f"DR-{doctor_code}".upper()


async def _lock(ctx, key: str) -> None:
    """Serialise numbering for one queue/day across concurrent requests (released at commit)."""
    await ctx.conn.execute(sa.text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": key})


async def _doctor_by_queue(ctx, queue: str) -> dict | None:
    if not queue.startswith("DR-"):
        return None
    row = (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name, employees.c.code, employees.c.department_id).where(
        employees.c.code == queue[3:], employees.c.deleted_at.is_(None)))).first()
    return dict(row._mapping) if row else None


async def _counters(ctx, *, open_only: bool = False) -> list[dict]:
    rows = await find(ctx, "queue.counters", status="Open" if open_only else None, limit=200)
    for r in rows:
        r.pop("_refs", None)
    return sorted(rows, key=lambda c: (c.get("display_order") or 0, c.get("name") or ""))


async def _masters(ctx, *, active_only: bool = True) -> list[dict]:
    """Queue master records (queue.queues), cached per request."""
    key = "_queue_masters_all" if not active_only else "_queue_masters"
    cached = ctx.__dict__.get(key)
    if cached is not None:
        return cached
    rows = await find(ctx, "queue.queues", status="Active" if active_only else None, limit=300)
    for r in rows:
        r.pop("_refs", None)
        r["queue_key"] = (r.get("queue_key") or "").strip().upper()
    ctx.__dict__[key] = rows
    return rows


async def master_for(ctx, queue: str) -> dict | None:
    return next((m for m in await _masters(ctx) if m.get("queue_key") == queue), None)


async def _known_queue(ctx, queue: str) -> bool:
    if queue.startswith("DR-"):
        return await _doctor_by_queue(ctx, queue) is not None
    if await master_for(ctx, queue):
        return True
    return any(c.get("queue_key") == queue for c in await _counters(ctx)) or queue in COUNTER_QUEUE_NAMES


async def default_priority(ctx, patient_id: str | None) -> str:
    if not patient_id:
        return "Normal"
    row = (await ctx.conn.execute(sa.select(patients.c.dob, patients.c.data["category"].astext).where(patients.c.id == patient_id))).first()
    if not row:
        return "Normal"
    if row[1] == "Senior Citizen" or (age_from(row[0]) or 0) >= 60:
        return "Senior Citizen"
    return "Normal"


# ------------------------------------------------------------------ issuing tokens

async def _next_number(ctx, queue: str, d: date) -> int:
    t = _t()
    n = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.max(t.c.token_no), 0)).where(
        t.c.queue == queue, t.c.token_date == d, t.c.deleted_at.is_(None)))).scalar_one()
    doc = await _doctor_by_queue(ctx, queue)
    if doc:  # walk-ins at a doctor cabin must not collide with appointment tokens not yet checked in
        a = appointments
        m = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.max(a.c.token_no), 0)).where(
            a.c.doctor_id == doc["id"], a.c.appt_date == d, a.c.deleted_at.is_(None)))).scalar_one()
        n = max(n, m)
    return int(n) + 1


async def issue_token(ctx, *, queue: str, patient_id: str | None = None, priority: str | None = None,
                      appointment_id: str | None = None, token_no: int | None = None, counter_id: str | None = None,
                      source: str = "Walk-in", extra: dict | None = None) -> dict:
    """Issue today's next token in `queue`. Doctor queues reuse the appointment token number.
    A queue master's daily capacity is enforced for walk-in / kiosk tokens (never for emergencies or
    checked-in appointments)."""
    queue = _check_queue_key(queue)
    if not await _known_queue(ctx, queue):
        raise not_found(f"No counter or doctor cabin uses queue {queue}")
    if priority and priority not in PRIORITIES:
        raise bad_request(f"Priority must be one of {', '.join(PRIORITIES)}")
    d = today()
    await _lock(ctx, f"queue:{queue}:{d}")
    t = _t()
    master = await master_for(ctx, queue)
    if master and master.get("daily_capacity") and source in ("Walk-in", "Kiosk") and priority != "Emergency":
        issued = (await ctx.conn.execute(sa.select(sa.func.count()).where(
            t.c.queue == queue, t.c.token_date == d, t.c.deleted_at.is_(None)))).scalar_one()
        if issued >= int(master["daily_capacity"]):
            raise conflict(f"{master.get('name') or queue} has reached today's capacity of {int(master['daily_capacity'])} tokens",
                           {"code": "AT_CAPACITY"})
    if appointment_id:
        existing = (await ctx.conn.execute(sa.select(t.c.id).where(
            t.c.data["appointment"].astext == appointment_id, t.c.token_date == d, t.c.deleted_at.is_(None),
            t.c.status.in_(["Waiting", "Called", "Serving"])).limit(1))).first()
        if existing:
            return await get(ctx, FQN, str(existing.id))
    if token_no:
        clash = (await ctx.conn.execute(sa.select(t.c.id).where(
            t.c.queue == queue, t.c.token_date == d, t.c.token_no == token_no, t.c.deleted_at.is_(None)).limit(1))).first()
        if clash:
            token_no = None
    n = token_no or await _next_number(ctx, queue, d)
    rec = await create(ctx, FQN, {
        "queue": queue, "token_no": n, "token_date": d.isoformat(), "patient_id": patient_id,
        "priority": priority or await default_priority(ctx, patient_id), "appointment": appointment_id,
        "counter": counter_id, "status": "Waiting", "source": source, **(extra or {}),
    })
    live(ctx, "queue", {"type": "issued", "queue": queue, "token_no": n, "label": token_label(queue, n)})
    return rec


# ------------------------------------------------------------------ counter actions

async def _target(ctx, counter_id: str | None, queue: str | None) -> dict:
    """A physical counter, or a doctor cabin addressed by its queue key."""
    if counter_id:
        c = await get(ctx, "queue.counters", counter_id)
        if not c:
            raise not_found("Counter not found")
        if c.get("status") != "Open":
            raise conflict(f"{c.get('name')} is closed — open the counter first")
        return {"counter_id": c["id"], "queue": c["queue_key"].upper(), "name": c.get("name") or c["queue_key"], "counter": c}
    if not queue:
        raise bad_request("Choose a counter or a doctor queue")
    q = _check_queue_key(queue)
    doc = await _doctor_by_queue(ctx, q)
    if not doc:
        cs = [c for c in await _counters(ctx, open_only=True) if c.get("queue_key") == q]
        if len(cs) == 1:
            return await _target(ctx, cs[0]["id"], None)
        raise bad_request("Choose the counter you are calling from")
    room = await _doctor_room(ctx, doc["id"])
    return {"counter_id": None, "queue": q, "name": f"{doc['name']}{f' · {room}' if room else ''}", "counter": None, "doctor": doc}


async def _doctor_room(ctx, doctor_id: str) -> str | None:
    wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][today().weekday()]
    for s in await find(ctx, "appointments.schedules", status="Active", doctor=doctor_id, limit=10):
        if wd in (s.get("weekdays") or []) and s.get("room"):
            return s["room"]
    return None


resolve_target = _target


def _scope(tg: dict) -> list:
    t = _t()
    conds = [t.c.token_date == today(), t.c.deleted_at.is_(None), t.c.queue == tg["queue"]]
    if tg["counter_id"]:
        conds.append(t.c.data["counter"].astext == tg["counter_id"])
    return conds


async def _current(ctx, tg: dict) -> list[dict]:
    t = _t()
    rows = (await ctx.conn.execute(sa.select(t).where(*_scope(tg), t.c.status.in_(ACTIVE)).order_by(t.c.called_at.desc()))).all()
    return [rs.to_record(r) for r in rows]


async def act(ctx, token_id: str, action: str, tg: dict | None = None) -> dict:
    """Apply one counter action to a token (trusted write: status, stamps and counter in one audit entry)."""
    if action not in ACTIONS:
        raise bad_request(f"Unknown action {action}")
    tok = await get(ctx, FQN, token_id)
    if not tok:
        raise not_found("Token not found")
    allowed, to = ACTIONS[action]
    if tok.get("status") not in allowed:
        raise conflict(f"Token {token_label(tok['queue'], tok.get('token_no'))} is {tok.get('status')} — cannot {action}")
    ts = now().isoformat(timespec="seconds")
    patch: dict[str, Any] = {"status": to}
    if action in ("call", "recall"):
        patch["called_at"] = tok.get("called_at") or ts
        patch["last_called_at"] = ts
        patch["call_count"] = int(tok.get("call_count") or 0) + 1
        if tg:
            patch["counter"] = tg["counter_id"]
            patch["counter_name"] = tg["name"]
    elif action == "serve":
        patch["serving_at"] = ts
    elif action == "done":
        patch["served_at"] = ts
    elif action == "skip":
        patch["skipped_at"] = ts
    rec = await update(ctx, FQN, token_id, patch)
    label = token_label(rec["queue"], rec.get("token_no"))
    counter_name = rec.get("counter_name") or (tg or {}).get("name")
    payload = {"type": "called" if action in ("call", "recall") else action, "queue": rec["queue"], "token_no": rec.get("token_no"),
               "label": label, "counter": counter_name, "recall": action == "recall"}
    live(ctx, "queue", payload)
    if action in ("call", "recall"):
        await emit("queue.called", ctx, {"token": rec, "label": label, "counter": counter_name, "recall": action == "recall"})
    return rec


async def call_next(ctx, tg: dict) -> dict | None:
    """Finish whoever is at the counter, then call the highest-priority waiting token."""
    for cur in await _current(ctx, tg):
        await act(ctx, cur["id"], "done", tg)
    t = _t()
    row = (await ctx.conn.execute(
        sa.select(t.c.id).where(*_scope({**tg, "counter_id": None}), t.c.status == "Waiting")
        .order_by(priority_rank(), t.c.token_no.asc()).limit(1).with_for_update(skip_locked=True))).first()
    if not row:
        return None
    return await act(ctx, str(row.id), "call", tg)


# ------------------------------------------------------------------ console & statistics

async def wait_stats(ctx, d: date | None = None, queues: list[str] | None = None) -> dict[str, dict]:
    t = _t()
    conds = [t.c.token_date == (d or today()), t.c.deleted_at.is_(None)]
    if queues:
        conds.append(t.c.queue.in_(queues))
    wait = sa.func.avg(sa.extract("epoch", t.c.called_at - t.c.created_at) / 60).filter(t.c.called_at.isnot(None))
    service = sa.func.avg(sa.extract("epoch", t.c.served_at - t.c.called_at) / 60).filter(t.c.served_at.isnot(None), t.c.called_at.isnot(None))
    rows = (await ctx.conn.execute(sa.select(
        t.c.queue, sa.func.count(), sa.func.count().filter(t.c.status == "Waiting"), sa.func.count().filter(t.c.status.in_(ACTIVE)),
        sa.func.count().filter(t.c.status == "Done"), sa.func.count().filter(t.c.status == "Skipped"), wait, service,
    ).where(*conds).group_by(t.c.queue))).all()
    return {q: {"issued": n, "waiting": w, "in_service": a, "served": dn, "skipped": sk,
                "avg_wait_min": max(0.0, round(float(aw), 1)) if aw is not None else None,
                "avg_service_min": max(0.0, round(float(asv), 1)) if asv is not None else None}
            for q, n, w, a, dn, sk, aw, asv in rows}


async def _patient_labels(ctx, ids: set[str]) -> dict[str, dict]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.title, patients.c.code, patients.c.dob, patients.c.gender)
                                   .where(patients.c.id.in_(ids)))).all()
    return {str(r.id): {"name": r.title, "uhid": r.code, "age": age_from(r.dob), "gender": r.gender} for r in rows}


def _token_out(rec: dict, pats: dict[str, dict] | None = None) -> dict:
    ts = now()
    created = rec.get("created_at")
    wait = None
    if created:
        end = parse_dt(rec.get("called_at")) or ts
        wait = max(0, round((end - parse_dt(created)).total_seconds() / 60))
    out = {k: rec.get(k) for k in ("id", "code", "queue", "token_no", "status", "priority", "called_at", "served_at",
                                    "counter", "counter_name", "call_count", "appointment", "source", "created_at")}
    out["label"] = token_label(rec["queue"], rec.get("token_no"))
    out["wait_min"] = wait
    if pats is not None:
        out["patient_id"] = rec.get("patient_id")
        out["patient"] = pats.get(rec.get("patient_id") or "")
    return out


@router.get("/queues")
async def queues(ctx: CtxDep):
    """Counters and today's doctor cabins with live counts — the console's chooser."""
    rs.ensure_access(ctx, E(FQN), "read")
    stats = await wait_stats(ctx)
    counters = []
    for c in await _counters(ctx):
        q = (c.get("queue_key") or "").upper()
        counters.append({"id": c["id"], "code": c["code"], "name": c.get("name"), "queue": q, "type": c.get("counter_type"),
                         "location": c.get("location"), "status": c.get("status"), **stats.get(q, {})})
    wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][today().weekday()]
    doc_ids = {s.get("doctor") for s in await find(ctx, "appointments.schedules", status="Active", limit=1000)
               if wd in (s.get("weekdays") or [])}
    doc_queues = {q for q in stats if q.startswith("DR-")}
    rows = (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name, employees.c.code, employees.c.department_id).where(
        sa.or_(employees.c.id.in_([i for i in doc_ids if i and is_uuid(i)]), employees.c.code.in_([q[3:] for q in doc_queues]))))).all()
    depts = await _titles(ctx, {str(r.department_id) for r in rows if r.department_id})
    doctors = sorted(({"queue": doctor_queue(r.code), "doctor_id": str(r.id), "name": r.name,
                       "department": depts.get(str(r.department_id)), **stats.get(doctor_queue(r.code), {})} for r in rows),
                     key=lambda x: (x["department"] or "", x["name"] or ""))
    return {"counters": counters, "doctors": doctors}


async def _titles(ctx, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(records.c.id, records.c.title).where(records.c.id.in_(ids)))).all()
    return {str(r.id): r.title for r in rows}


@router.get("/console")
async def console(ctx: CtxDep, counter_id: str | None = None, queue: str | None = None):
    rs.ensure_access(ctx, E(FQN), "read")
    tg = await _target_for_view(ctx, counter_id, queue)
    t = _t()
    base = [t.c.token_date == today(), t.c.deleted_at.is_(None), t.c.queue == tg["queue"]]
    waiting = [rs.to_record(r) for r in (await ctx.conn.execute(
        sa.select(t).where(*base, t.c.status == "Waiting").order_by(priority_rank(), t.c.token_no.asc()).limit(200))).all()]
    skipped = [rs.to_record(r) for r in (await ctx.conn.execute(
        sa.select(t).where(*base, t.c.status == "Skipped").order_by(t.c.token_no.desc()).limit(50))).all()]
    active = [rs.to_record(r) for r in (await ctx.conn.execute(
        sa.select(t).where(*base, t.c.status.in_(ACTIVE)).order_by(t.c.called_at.desc()))).all()]
    recent = [rs.to_record(r) for r in (await ctx.conn.execute(
        sa.select(t).where(*base, t.c.status == "Done").order_by(t.c.served_at.desc().nulls_last()).limit(10))).all()]
    mine = [a for a in active if not tg["counter_id"] or a.get("counter") == tg["counter_id"]]
    others = [a for a in active if a not in mine]
    pats = await _patient_labels(ctx, {r.get("patient_id") for r in [*waiting, *skipped, *active, *recent]})
    stats = (await wait_stats(ctx, queues=[tg["queue"]])).get(tg["queue"], {})
    return {
        "queue": tg["queue"], "name": tg["name"], "counter": tg.get("counter"), "doctor": tg.get("doctor"),
        "queue_name": await queue_name(ctx, tg["queue"]),
        "current": _token_out(mine[0], pats) if mine else None,
        "others": [_token_out(a, pats) for a in others],
        "waiting": [_token_out(r, pats) for r in waiting],
        "skipped": [_token_out(r, pats) for r in skipped],
        "recent": [_token_out(r, pats) for r in recent],
        "stats": stats,
    }


async def _target_for_view(ctx, counter_id: str | None, queue: str | None) -> dict:
    """Like _target but read-only: a closed counter or a whole counter queue can still be viewed."""
    if counter_id:
        c = await get(ctx, "queue.counters", counter_id)
        if not c:
            raise not_found("Counter not found")
        return {"counter_id": c["id"], "queue": (c.get("queue_key") or "").upper(), "name": c.get("name"), "counter": c}
    if not queue:
        raise bad_request("Choose a counter or a doctor queue")
    q = _check_queue_key(queue)
    doc = await _doctor_by_queue(ctx, q)
    if doc:
        return await _target(ctx, None, q)
    return {"counter_id": None, "queue": q, "name": await queue_name(ctx, q), "counter": None}


async def queue_name(ctx, queue: str) -> str:
    master = await master_for(ctx, queue)
    if master and master.get("name"):
        return master["name"]
    doc = await _doctor_by_queue(ctx, queue)
    if doc:
        return doc["name"]
    for c in await _counters(ctx):
        if (c.get("queue_key") or "").upper() == queue:
            return COUNTER_QUEUE_NAMES.get(queue) or c.get("counter_type") or queue
    return COUNTER_QUEUE_NAMES.get(queue, queue)


class TargetIn(BaseModel):
    counter_id: str | None = None
    queue: str | None = None


@router.post("/next")
async def next_api(body: TargetIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(FQN), "write")
    tg = await _target(ctx, body.counter_id, body.queue)
    rec = await call_next(ctx, tg)
    if not rec:
        return {"token": None, "message": f"No one is waiting in {tg['queue']}"}
    return {"token": _token_out(rec, await _patient_labels(ctx, {rec.get("patient_id")}))}


@router.post("/tokens/{token_id}/{action}")
async def token_action(token_id: str, action: Literal["call", "recall", "serve", "done", "skip"], body: TargetIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(FQN), "write")
    tok = await get(ctx, FQN, token_id)
    if not tok:
        raise not_found("Token not found")
    tg = None
    if action in ("call", "recall"):
        tg = await _target(ctx, body.counter_id or tok.get("counter"), body.queue or tok["queue"])
        if tg["queue"] != tok["queue"]:
            raise conflict(f"Token belongs to queue {tok['queue']}, not {tg['queue']}")
        if action == "call":
            for cur in await _current(ctx, tg):  # one patient at a counter at a time
                if cur["id"] != token_id:
                    await act(ctx, cur["id"], "done", tg)
    rec = await act(ctx, token_id, action, tg)
    return {"token": _token_out(rec, await _patient_labels(ctx, {rec.get("patient_id")}))}


class IssueIn(BaseModel):
    queue: str
    patient_id: str | None = None
    priority: Literal["Normal", "Senior Citizen", "Differently Abled", "Emergency"] | None = None
    counter_id: str | None = None
    source: Literal["Walk-in", "Kiosk"] = "Walk-in"
    mobile: str | None = Field(default=None, max_length=15)


@router.post("/tokens", status_code=201)
async def issue_api(body: IssueIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(FQN), "write")
    if body.patient_id and not is_uuid(body.patient_id):
        raise bad_request("Invalid patient")
    mobile = re.sub(r"\D", "", body.mobile or "")[-10:] or None
    if mobile and not re.match(r"^[6-9]\d{9}$", mobile):
        raise bad_request("Enter a valid 10-digit mobile number")
    rec = await issue_token(ctx, queue=body.queue, patient_id=body.patient_id, priority=body.priority, source=body.source,
                            extra={"mobile": mobile} if mobile else None)
    pats = await _patient_labels(ctx, {rec.get("patient_id")})
    ahead = (await ctx.conn.execute(sa.select(sa.func.count()).where(
        _t().c.queue == rec["queue"], _t().c.token_date == today(), _t().c.status == "Waiting",
        _t().c.deleted_at.is_(None), _t().c.id != rec["id"]))).scalar_one()
    return {"token": _token_out(rec, pats), "ahead": ahead, "queue_name": await queue_name(ctx, rec["queue"]),
            "hospital": settings.hospital_name}


@router.get("/stats")
async def stats_api(ctx: CtxDep, on: str | None = None):
    rs.ensure_access(ctx, E(FQN), "read")
    d = parse_date(on) if on else today()
    st = await wait_stats(ctx, d)
    return [{"queue": q, "name": await queue_name(ctx, q), **v} for q, v in sorted(st.items())]


# ------------------------------------------------------------------ public TV board (no patient data)

def _parse_queues(raw: str) -> list[str]:
    out = []
    for q in (raw or "").split(","):
        q = q.strip().upper()
        if q and QUEUE_RE.match(q) and q not in out:
            out.append(q)
    return out[:12]


async def display_state(ctx, keys: list[str], next_n: int = 6) -> dict:
    t = _t()
    stats = await wait_stats(ctx, queues=keys)
    boards = []
    for q in keys:
        base = [t.c.token_date == today(), t.c.deleted_at.is_(None), t.c.queue == q]
        serving = (await ctx.conn.execute(sa.select(t.c.token_no, t.c.status, t.c.called_at, t.c.data["counter_name"].astext)
                                          .where(*base, t.c.status.in_(ACTIVE)).order_by(t.c.called_at.desc()).limit(8))).all()
        nxt = (await ctx.conn.execute(sa.select(t.c.token_no).where(*base, t.c.status == "Waiting")
                                      .order_by(priority_rank(), t.c.token_no.asc()).limit(next_n))).all()
        doc = await _doctor_by_queue(ctx, q)
        room = await _doctor_room(ctx, doc["id"]) if doc else None
        boards.append({
            "queue": q, "name": await queue_name(ctx, q), "room": room, "kind": "doctor" if doc else "counter",
            "serving": [{"label": token_label(q, n), "status": s, "called_at": to_json_value(c), "counter": (room if doc else cn) or cn}
                        for n, s, c, cn in serving],
            "next": [token_label(q, r[0]) for r in nxt],
            "waiting": stats.get(q, {}).get("waiting", 0),
            "avg_wait_min": stats.get(q, {}).get("avg_wait_min"),
        })
    last = (await ctx.conn.execute(sa.select(t.c.queue, t.c.token_no, t.c.data["counter_name"].astext, t.c.data["last_called_at"].astext)
                                   .where(t.c.token_date == today(), t.c.queue.in_(keys), t.c.status.in_(ACTIVE),
                                          t.c.data["last_called_at"].astext.isnot(None))
                                   .order_by(t.c.data["last_called_at"].astext.desc()).limit(1))).first()
    return {"hospital": settings.hospital_name, "time": now().isoformat(timespec="seconds"), "queues": boards,
            "last_called": {"queue": last[0], "label": token_label(last[0], last[1]), "counter": last[2], "at": last[3]} if last else None}


@public_router.get("/display")
async def public_display(ctx: PublicCtxDep, queues: str = "REG,BILL,PHARM,LAB", next_n: int = 6):
    keys = _parse_queues(queues)
    if not keys:
        raise ApiError(400, "Give one or more queue keys, e.g. ?queues=REG,BILL")
    return await display_state(ctx, keys, max(1, min(next_n, 10)))


class CounterStateIn(BaseModel):
    open: bool = Field(description="Open or close the counter")


@router.post("/counters/{counter_id}/state")
async def counter_state(counter_id: str, body: CounterStateIn, ctx: CtxDep):
    rs.ensure_access(ctx, E("queue.counters"), "write")
    c = await get(ctx, "queue.counters", counter_id)
    if not c:
        raise not_found("Counter not found")
    rec = await update(ctx, "queue.counters", counter_id, {"status": "Open" if body.open else "Closed"})
    live(ctx, "queue", {"type": "counter", "queue": (rec.get("queue_key") or "").upper(), "counter": rec.get("name"), "open": body.open})
    return rec


# ------------------------------------------------------------------ queue monitor (every line side by side)

KIND_BY_COUNTER = {"Registration": "Registration", "Billing": "Billing", "Pharmacy": "Pharmacy", "Lab Collection": "Sample Collection",
                   "Radiology": "Radiology", "Doctor Cabin": "Consultation", "Help Desk": "Help Desk"}
KIND_BY_KEY = {"REG": "Registration", "BILL": "Billing", "PHARM": "Pharmacy", "LAB": "Sample Collection", "RAD": "Radiology", "HELP": "Help Desk"}


async def _today_doctors(ctx) -> dict[str, dict]:
    """Doctor cabins consulting today (schedules) keyed by queue key, with department and room."""
    wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][today().weekday()]
    scheds = [x for x in await find(ctx, "appointments.schedules", status="Active", limit=2000) if wd in (x.get("weekdays") or [])]
    ids = {x.get("doctor") for x in scheds if is_uuid(x.get("doctor"))}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name, employees.c.code, employees.c.department_id).where(
        employees.c.id.in_(ids), employees.c.deleted_at.is_(None)))).all()
    out = {}
    for r in rows:
        mine = [x for x in scheds if x.get("doctor") == str(r.id)]
        dept = next((x.get("department") for x in mine if x.get("department")), None) or (str(r.department_id) if r.department_id else None)
        out[doctor_queue(r.code)] = {"doctor_id": str(r.id), "doctor": r.name, "department_id": dept,
                                     "room": next((x.get("room") for x in mine if x.get("room")), None),
                                     "sessions": [f"{x.get('start_time')}–{x.get('end_time')}" for x in mine if x.get("start_time")]}
    return out


async def queue_lines(ctx) -> list[dict]:
    """Every line known today: queue masters, counter queues, today's doctor cabins and any queue that issued tokens."""
    t = _t()
    d = today()
    masters = {m["queue_key"]: m for m in await _masters(ctx)}
    counters = await _counters(ctx)
    docs = await _today_doctors(ctx)
    used = {q for (q,) in (await ctx.conn.execute(sa.select(t.c.queue).where(t.c.token_date == d, t.c.deleted_at.is_(None)).distinct())).all()}
    keys = list(dict.fromkeys([*masters, *[(c.get("queue_key") or "").upper() for c in counters], *docs, *sorted(used)]))
    stats = await wait_stats(ctx)
    # live counts by status and the oldest waiting token
    rows = (await ctx.conn.execute(sa.select(t.c.queue, t.c.status, sa.func.count(), sa.func.min(t.c.created_at)).where(
        t.c.token_date == d, t.c.deleted_at.is_(None)).group_by(t.c.queue, t.c.status))).all()
    live: dict[str, dict] = {}
    for q, st, n, oldest in rows:
        x = live.setdefault(q, {})
        x[st] = n
        if st == "Waiting":
            x["oldest"] = oldest
    last_issued = {q: (n, at) for q, n, at in (await ctx.conn.execute(
        sa.select(t.c.queue, t.c.token_no, t.c.created_at).where(t.c.token_date == d, t.c.deleted_at.is_(None))
        .distinct(t.c.queue).order_by(t.c.queue, t.c.created_at.desc()))).all()}
    last_called = {q: (n, at, cn) for q, n, at, cn in (await ctx.conn.execute(
        sa.select(t.c.queue, t.c.token_no, t.c.data["last_called_at"].astext, t.c.data["counter_name"].astext)
        .where(t.c.token_date == d, t.c.deleted_at.is_(None), t.c.data["last_called_at"].astext.isnot(None))
        .distinct(t.c.queue).order_by(t.c.queue, t.c.data["last_called_at"].astext.desc()))).all()}
    dept_ids = {m.get("department") for m in masters.values()} | {v.get("department_id") for v in docs.values()}
    depts = await _titles(ctx, {x for x in dept_ids if x})
    master_docs = {m.get("doctor") for m in masters.values() if is_uuid(m.get("doctor"))}
    doc_names = {str(i): n for i, n in (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name).where(
        employees.c.id.in_(master_docs)))).all()} if master_docs else {}
    ts = now()
    out = []
    for i, q in enumerate(keys):
        m = masters.get(q) or {}
        cs = [c for c in counters if (c.get("queue_key") or "").upper() == q]
        doc = docs.get(q) or {}
        kind = m.get("kind") or ("Consultation" if q.startswith("DR-") else KIND_BY_COUNTER.get(cs[0].get("counter_type") or "") if cs else None) \
            or KIND_BY_KEY.get(q, "Other")
        lv = live.get(q, {})
        st = stats.get(q, {})
        waiting = lv.get("Waiting", 0)
        open_counters = sum(1 for c in cs if c.get("status") == "Open") or (1 if q.startswith("DR-") else 0)
        svc = st.get("avg_service_min") or float(m.get("avg_service_minutes") or (cs[0].get("avg_service_minutes") if cs else None) or 5)
        oldest = lv.get("oldest")
        cap = int(m["daily_capacity"]) if m.get("daily_capacity") else None
        issued = st.get("issued", 0)
        li, lc = last_issued.get(q), last_called.get(q)
        dept = m.get("department") or doc.get("department_id")
        out.append({
            "queue": q, "code": m.get("code") or f"{i + 1:02d}", "name": m.get("name") or (doc.get("doctor") if doc else None) or await queue_name(ctx, q),
            "kind": kind, "department_id": dept, "department": depts.get(dept or ""),
            "owner": doc_names.get(m.get("doctor") or "") or doc.get("doctor"), "room": doc.get("room"),
            "waiting": waiting, "called": lv.get("Called", 0), "in_service": lv.get("Serving", 0), "held": lv.get("Skipped", 0),
            "served": lv.get("Done", 0), "issued": issued,
            "longest_wait_min": max(0, round((ts - oldest).total_seconds() / 60)) if oldest else None,
            "est_wait_min": round(waiting * svc / max(1, open_counters)) if waiting else 0,
            "avg_wait_min": st.get("avg_wait_min"), "avg_service_min": st.get("avg_service_min"),
            "last_issued": {"label": token_label(q, li[0]), "at": to_json_value(li[1])} if li else None,
            "last_called": {"label": token_label(q, lc[0]), "at": lc[1], "counter": lc[2]} if lc else None,
            "counters": len(cs), "open_counters": sum(1 for c in cs if c.get("status") == "Open"), "capacity": cap,
            "at_capacity": bool(cap and issued >= cap), "master_id": m.get("id"), "kiosk": m.get("kiosk", not q.startswith("DR-")) if m else not q.startswith("DR-"),
            "display_order": m.get("display_order") or 99,
        })
    return out


@router.get("/monitor")
async def monitor(ctx: CtxDep, kind: str | None = None, department_id: str | None = None):
    rs.ensure_access(ctx, E(FQN), "read")
    lines = await queue_lines(ctx)
    kinds = sorted({x["kind"] for x in lines})
    departments = sorted({(x["department_id"], x["department"]) for x in lines if x["department_id"]}, key=lambda d: d[1] or "")
    if kind:
        lines = [x for x in lines if x["kind"] == kind]
    if department_id:
        lines = [x for x in lines if x["department_id"] == department_id]
    lines.sort(key=lambda x: (-(x["waiting"] + x["called"] + x["in_service"] > 0), x["display_order"], x["kind"], x["name"] or ""))
    waits = [x["longest_wait_min"] for x in lines if x["longest_wait_min"] is not None]
    return {
        "lines": lines, "kinds": kinds, "departments": [{"id": i, "name": n} for i, n in departments],
        "kpis": {"waiting": sum(x["waiting"] for x in lines), "called": sum(x["called"] for x in lines),
                 "in_service": sum(x["in_service"] for x in lines), "held": sum(x["held"] for x in lines),
                 "longest_wait_min": max(waits) if waits else None, "at_capacity": sum(1 for x in lines if x["at_capacity"]),
                 "issued": sum(x["issued"] for x in lines)},
        "updated_at": now().isoformat(timespec="seconds"),
    }


@router.get("/kiosk")
async def kiosk(ctx: CtxDep):
    """Lines a token can be issued for from the kiosk / issue-token screen, with live waiting counts."""
    rs.ensure_access(ctx, E(FQN), "read")
    lines = [x for x in await queue_lines(ctx) if x["kiosk"] or x["queue"].startswith("DR-")]
    lines.sort(key=lambda x: (x["queue"].startswith("DR-"), x["display_order"], x["department"] or "", x["name"] or ""))
    return {"lines": [{k: x[k] for k in ("queue", "name", "kind", "department_id", "department", "owner", "room", "waiting",
                                          "est_wait_min", "capacity", "at_capacity", "issued")} for x in lines],
            "hospital": settings.hospital_name}


class TransferIn(BaseModel):
    queue: str
    reason: str | None = Field(default=None, max_length=200)


@router.post("/transfer/{token_id}", status_code=201)
async def transfer(token_id: str, body: TransferIn, ctx: CtxDep):
    """Send a token to another line (e.g. registration → billing): the old token closes as transferred and
    the patient gets the next number in the new line with the same priority."""
    rs.ensure_access(ctx, E(FQN), "write")
    tok = await get(ctx, FQN, token_id)
    if not tok:
        raise not_found("Token not found")
    if tok.get("status") not in ("Waiting", "Called", "Serving", "Skipped"):
        raise conflict(f"Token {token_label(tok['queue'], tok.get('token_no'))} is {tok.get('status')}")
    target = _check_queue_key(body.queue)
    if target == tok["queue"]:
        raise bad_request("Choose a different queue")
    new = await issue_token(ctx, queue=target, patient_id=tok.get("patient_id"), priority=tok.get("priority"), source="Transfer",
                            extra={"transferred_from": tok["id"], "transfer_reason": body.reason})
    ts = now().isoformat(timespec="seconds")
    await update(ctx, FQN, token_id, {"status": "Done", "served_at": tok.get("served_at") or ts, "transferred_to": target,
                                      "transferred_token": new["id"], "transfer_reason": body.reason})
    live(ctx, "queue", {"type": "transfer", "queue": tok["queue"], "to": target, "label": token_label(target, new.get("token_no"))})
    pats = await _patient_labels(ctx, {new.get("patient_id")})
    return {"token": _token_out(new, pats), "from": token_label(tok["queue"], tok.get("token_no")), "queue_name": await queue_name(ctx, target)}


# ------------------------------------------------------------------ token register & reports

def _range(date_from: str | None, date_to: str | None, max_days: int = 92) -> tuple[date, date]:
    d_from = parse_date(date_from) or today()
    d_to = parse_date(date_to) or d_from
    if d_to < d_from:
        raise bad_request("'To' date is before 'From' date")
    if (d_to - d_from).days > max_days:
        raise bad_request(f"Choose a range of at most {max_days} days")
    return d_from, d_to


@router.get("/register")
async def token_register(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None, queue: str | None = None,
                         status: str | None = None, priority: str | None = None, source: str | None = None, q: str | None = None,
                         page: int = 1, limit: int = 50, format: Literal["json", "csv"] = "json"):
    rs.ensure_access(ctx, E(FQN), "read")
    d_from, d_to = _range(date_from, date_to)
    t, p = _t(), patients
    conds = [t.c.deleted_at.is_(None), t.c.token_date >= d_from, t.c.token_date <= d_to]
    if queue:
        conds.append(t.c.queue == queue.strip().upper())
    if status:
        conds.append(t.c.status.in_([x for x in status.split(",") if x]))
    if priority:
        conds.append(t.c.data["priority"].astext == priority)
    if source:
        conds.append(t.c.data["source"].astext == source)
    if q and q.strip():
        term = q.strip()
        like = f"%{term}%"
        conds_q = [p.c.title.ilike(like), p.c.code.ilike(like), t.c.code.ilike(like)]
        if term.isdigit():
            conds_q.append(t.c.token_no == int(term))
        conds.append(sa.or_(*conds_q))
    base = t.outerjoin(p, p.c.id == t.c.patient_id)
    total = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(base).where(*conds))).scalar_one()
    lim = 20000 if format == "csv" else max(1, min(limit, 200))
    off = 0 if format == "csv" else (max(1, page) - 1) * lim
    rows = (await ctx.conn.execute(sa.select(t, p.c.title.label("p_name"), p.c.code.label("p_uhid")).select_from(base).where(*conds)
                                   .order_by(t.c.token_date.desc(), t.c.created_at.desc()).limit(lim).offset(off))).all()
    names: dict[str, str] = {}
    out = []
    for r in rows:
        m = dict(r._mapping)
        pn, pu = m.pop("p_name"), m.pop("p_uhid")
        rec = rs.to_record(m)
        qk = rec["queue"]
        if qk not in names:
            names[qk] = await queue_name(ctx, qk)
        created, called, served = parse_dt(rec.get("created_at")), parse_dt(rec.get("called_at")), parse_dt(rec.get("served_at"))
        out.append({"id": rec["id"], "code": rec.get("code"), "date": rec.get("token_date"), "label": token_label(qk, rec.get("token_no")),
                    "queue": qk, "queue_name": names[qk], "status": rec.get("status"), "priority": rec.get("priority"),
                    "source": rec.get("source"), "patient_id": rec.get("patient_id"), "patient": pn, "uhid": pu,
                    "issued_at": rec.get("created_at"), "called_at": rec.get("called_at"), "served_at": rec.get("served_at"),
                    "counter": rec.get("counter_name"), "calls": rec.get("call_count"), "transferred_to": rec.get("transferred_to"),
                    "wait_min": max(0, round((called - created).total_seconds() / 60)) if created and called else None,
                    "service_min": max(0, round((served - called).total_seconds() / 60)) if called and served else None})
    if format == "csv":
        import csv
        import io

        from fastapi.responses import Response

        buf = io.StringIO()
        w = csv.writer(buf)
        cols = [("date", "Date"), ("label", "Token"), ("queue_name", "Queue"), ("status", "Status"), ("priority", "Priority"),
                ("source", "Source"), ("patient", "Patient"), ("uhid", "UHID"), ("issued_at", "Issued"), ("called_at", "Called"),
                ("served_at", "Done"), ("counter", "Counter"), ("wait_min", "Wait (min)"), ("service_min", "Service (min)")]
        w.writerow([c[1] for c in cols])
        for r in out:
            w.writerow(["" if r.get(k) is None else r.get(k) for k, _ in cols])
        await audit(ctx, "export", module="queue", entity="tokens", note=f"Token register {d_from}–{d_to} ({len(out)} rows)")
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="token-register-{d_from}-{d_to}.csv"'})
    return {"rows": out, "total": total, "page": page, "limit": lim}


@router.get("/reports")
async def token_reports(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None, queue: str | None = None):
    """Volumes and waits: by day, by hour of issue, by queue (avg / p90 / max wait, service time), by source and priority."""
    rs.ensure_access(ctx, E(FQN), "read")
    d_from, d_to = _range(date_from or (today() - timedelta(days=6)).isoformat(), date_to or today().isoformat())
    t = _t()
    conds = [t.c.deleted_at.is_(None), t.c.token_date >= d_from, t.c.token_date <= d_to]
    if queue:
        conds.append(t.c.queue == queue.strip().upper())
    wait = sa.extract("epoch", t.c.called_at - t.c.created_at) / 60
    svc = sa.extract("epoch", t.c.served_at - t.c.called_at) / 60
    tz = sa.literal_column("'" + settings.timezone.replace("'", "") + "'")
    hour = sa.extract("hour", sa.func.timezone(tz, t.c.created_at))
    avg_wait = sa.func.avg(wait).filter(t.c.called_at.isnot(None))
    avg_svc = sa.func.avg(svc).filter(t.c.served_at.isnot(None), t.c.called_at.isnot(None))
    p90 = sa.func.percentile_cont(0.9).within_group(wait).filter(t.c.called_at.isnot(None))

    def f(v):
        return round(float(v), 1) if v is not None else None

    by_day = [{"date": to_json_value(d), "issued": n, "served": sv, "skipped": sk, "avg_wait_min": f(aw)} for d, n, sv, sk, aw in (await ctx.conn.execute(
        sa.select(t.c.token_date, sa.func.count(), sa.func.count().filter(t.c.status == "Done"), sa.func.count().filter(t.c.status == "Skipped"),
                  avg_wait).where(*conds).group_by(t.c.token_date).order_by(t.c.token_date))).all()]
    by_hour = [{"hour": int(h), "label": f"{int(h):02d}:00", "issued": n, "avg_wait_min": f(aw), "avg_service_min": f(asv)}
               for h, n, aw, asv in (await ctx.conn.execute(sa.select(hour, sa.func.count(), avg_wait, avg_svc).where(*conds)
                                                            .group_by(hour).order_by(hour))).all()]
    by_queue = []
    for q, n, sv, sk, aw, p, mx, asv in (await ctx.conn.execute(sa.select(
            t.c.queue, sa.func.count(), sa.func.count().filter(t.c.status == "Done"), sa.func.count().filter(t.c.status == "Skipped"),
            avg_wait, p90, sa.func.max(wait), avg_svc).where(*conds).group_by(t.c.queue).order_by(sa.func.count().desc()))).all():
        by_queue.append({"queue": q, "name": await queue_name(ctx, q), "issued": n, "served": sv, "skipped": sk, "avg_wait_min": f(aw),
                         "p90_wait_min": f(p), "max_wait_min": f(mx), "avg_service_min": f(asv)})
    src = t.c.data["source"].astext
    pri = t.c.data["priority"].astext
    by_source = [{"source": s_ or "Walk-in", "issued": n} for s_, n in (await ctx.conn.execute(
        sa.select(src, sa.func.count()).where(*conds).group_by(src))).all()]
    by_priority = [{"priority": p_ or "Normal", "issued": n, "avg_wait_min": f(aw)} for p_, n, aw in (await ctx.conn.execute(
        sa.select(pri, sa.func.count(), avg_wait).where(*conds).group_by(pri))).all()]
    tot = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.count().filter(t.c.status == "Done"),
                                            sa.func.count().filter(t.c.status == "Skipped"), avg_wait, p90, avg_svc).where(*conds))).one()
    return {"from": d_from.isoformat(), "to": d_to.isoformat(), "by_day": by_day, "by_hour": by_hour, "by_queue": by_queue,
            "by_source": by_source, "by_priority": by_priority,
            "totals": {"issued": tot[0], "served": tot[1], "skipped": tot[2], "avg_wait_min": f(tot[3]), "p90_wait_min": f(tot[4]),
                       "avg_service_min": f(tot[5])}}


# ------------------------------------------------------------------ public display boards & department screens

async def _board(ctx, code: str) -> dict:
    ent = E("queue.display_boards")
    t = ent.table
    row = (await ctx.conn.execute(sa.select(t).where(*rs.base_where(ent), sa.func.upper(t.c.code) == code.strip().upper()))).first()
    if not row:
        raise not_found("Display board not found")
    b = rs.to_record(row)
    if b.get("status") == "Inactive":
        raise not_found("This display board is switched off")
    return b


async def department_queues(ctx, dept_id: str) -> list[str]:
    docs = await _today_doctors(ctx)
    keys = [q for q, d in docs.items() if d.get("department_id") == dept_id]
    keys += [m["queue_key"] for m in await _masters(ctx) if m.get("department") == dept_id and m["queue_key"] not in keys]
    return keys[:12]


async def _department(ctx, dept: str) -> dict:
    ent = E("mdm.departments")
    t = ent.table
    cond = t.c.id == dept if is_uuid(dept) else sa.func.upper(t.c.code) == dept.strip().upper()
    row = (await ctx.conn.execute(sa.select(t.c.id, t.c.code, t.c.title).where(*rs.base_where(ent), cond))).first()
    if not row:
        raise not_found("Department not found")
    return {"id": str(row.id), "code": row.code, "name": row.title}


@public_router.get("/board/{code}")
async def public_board(code: str, ctx: PublicCtxDep):
    """A configured display board (queue.display_boards) — token numbers and counters only."""
    b = await _board(ctx, code)
    keys = _parse_queues(",".join(b.get("queues") or []))
    if b.get("department"):
        keys = list(dict.fromkeys([*keys, *(await department_queues(ctx, b["department"]))]))[:12]
    if not keys:
        raise ApiError(400, "This board has no queues configured")
    state = await display_state(ctx, keys, max(1, min(int(b.get("next_count") or 6), 10)))
    return {**state, "board": {"code": b.get("code"), "name": b.get("name"), "location": b.get("location"),
                               "ticker": b.get("ticker"), "announce": b.get("announce", True)}}


@public_router.get("/department/{dept}")
async def public_department(dept: str, ctx: PublicCtxDep):
    """Department screen: every doctor cabin of the department consulting today (doctor, room, now serving,
    next tokens) — no patient names."""
    d = await _department(ctx, dept)
    docs = await _today_doctors(ctx)
    keys = await department_queues(ctx, d["id"])
    state = await display_state(ctx, keys, 5) if keys else {"hospital": settings.hospital_name, "time": now().isoformat(timespec="seconds"),
                                                             "queues": [], "last_called": None}
    for qd in state["queues"]:
        doc = docs.get(qd["queue"]) or {}
        qd["doctor"] = doc.get("doctor")
        qd["sessions"] = doc.get("sessions")
    return {**state, "department": d}


@router.get("/boards")
async def boards(ctx: CtxDep):
    """Display boards with their public links (for the Display Boards page)."""
    rs.ensure_access(ctx, E("queue.display_boards"), "read")
    rows = await find(ctx, "queue.display_boards", limit=200, sort="title")
    out = []
    for b in rows:
        refs = b.pop("_refs", {}) or {}
        out.append({**{k: b.get(k) for k in ("id", "code", "name", "location", "department", "queues", "next_count", "announce", "ticker", "status")},
                    "department_name": refs.get(b.get("department") or "")})
    return out


__all__ = ["router", "public_router", "issue_token", "act", "call_next", "resolve_target", "token_label", "doctor_queue", "wait_stats",
           "default_priority", "display_state", "queue_lines", "master_for"]
