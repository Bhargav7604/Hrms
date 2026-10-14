"""Internal messages — staff-only inbox (nothing here is ever sent to a patient).

Folders: inbox, tasks, sent, drafts, pinned, archived. Compose to people, departments or roles
(departments and roles are expanded to their active members when the message is sent), with
priority LOW/NORMAL/HIGH/URGENT, type MESSAGE/ALERT/NOTICE, an optional patient (+ admission /
visit) tag, and an optional "task somebody has to close". Replies keep the thread. @username in
the text marks (and adds) that person as mentioned.

Charts read patient-tagged messages with `GET /api/messages?patient_id=…&encounter_id=…`.
Delivery is realtime over the SSE per-user channel (event "me": {type: "message", ...}).
"""

from __future__ import annotations

import re
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core.audit import audit
from ..core.rbac import ROLES
from ..core.security import CtxDep
from ..core.sequences import next_code
from ..core.util import bad_request, forbidden, is_uuid, new_id, not_found, now, to_json_value
from ..redis import publish
from ..schema import employees, encounters, message_recipients, messages, patients, records, users

router = APIRouter(prefix="/api/messages", tags=["messages"])

PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"]
TYPES = ["MESSAGE", "ALERT", "NOTICE"]
FOLDERS = ["inbox", "tasks", "sent", "drafts", "pinned", "archived"]
CHART_ROLES = {"admin", "doctor", "nurse", "management", "quality"}
MENTION_RE = re.compile(r"(?<![\w.])@([A-Za-z0-9_.-]{2,60})")

m, r = messages, message_recipients


class Recipient(BaseModel):
    type: Literal["user", "department", "role"]
    id: str = Field(min_length=1, max_length=80)
    label: str | None = Field(default=None, max_length=200)


class MessageIn(BaseModel):
    to: list[Recipient] = []
    subject: str = Field(default="", max_length=200)
    body: str = Field(default="", max_length=20000)
    priority: Literal["LOW", "NORMAL", "HIGH", "URGENT"] = "NORMAL"
    type: Literal["MESSAGE", "ALERT", "NOTICE"] = "MESSAGE"
    patient_id: str | None = None
    encounter_id: str | None = None
    is_task: bool = False
    draft: bool = False
    reply_to: str | None = None


# ------------------------------------------------------------------ helpers

async def _expand(ctx, to: list[Recipient]) -> dict[str, str]:
    """{user_id: via} for the audience (people, department members, role members); active users only."""
    out: dict[str, str] = {}
    u = users
    for rc in to:
        if rc.type == "user":
            if is_uuid(rc.id):
                out.setdefault(rc.id, "person")
        elif rc.type == "role":
            if rc.id not in ROLES:
                raise bad_request(f"Unknown role {rc.id}")
            ids = (await ctx.conn.execute(sa.select(u.c.id).where(u.c.role == rc.id, u.c.active.is_(True)))).scalars().all()
            for i in ids:
                out.setdefault(str(i), f"role:{rc.id}")
        elif rc.type == "department":
            if not is_uuid(rc.id):
                raise bad_request("Unknown department")
            ids = (await ctx.conn.execute(
                sa.select(u.c.id).select_from(u.join(employees, employees.c.id == u.c.employee_id))
                .where(employees.c.department_id == rc.id, u.c.active.is_(True)))).scalars().all()
            for i in ids:
                out.setdefault(str(i), f"department:{rc.id}")
    if out:
        valid = set((await ctx.conn.execute(sa.select(u.c.id).where(u.c.id.in_(list(out)), u.c.active.is_(True)))).scalars().all())
        out = {k: v for k, v in out.items() if k in {str(x) for x in valid}}
    return out


async def _mentions(ctx, body: str) -> dict[str, str]:
    names = {n.lower().rstrip(".") for n in MENTION_RE.findall(body or "")}
    if not names:
        return {}
    rows = (await ctx.conn.execute(sa.select(users.c.id, users.c.username).where(
        sa.func.lower(users.c.username).in_(list(names)), users.c.active.is_(True)))).all()
    return {str(x.id): x.username for x in rows}


async def _check_patient(ctx, patient_id: str | None, encounter_id: str | None) -> tuple[str | None, str | None]:
    if patient_id and not is_uuid(patient_id):
        raise bad_request("Invalid patient")
    if encounter_id:
        if not is_uuid(encounter_id):
            raise bad_request("Invalid admission / visit")
        enc = (await ctx.conn.execute(sa.select(encounters.c.patient_id).where(encounters.c.id == encounter_id))).first()
        if not enc:
            raise bad_request("Admission / visit not found")
        if patient_id and str(enc.patient_id) != patient_id:
            raise bad_request("That admission belongs to another patient")
        patient_id = str(enc.patient_id)
    if patient_id:
        ok = (await ctx.conn.execute(sa.select(patients.c.id).where(patients.c.id == patient_id))).first()
        if not ok:
            raise bad_request("Patient not found")
    return patient_id, encounter_id


def _search(subject: str, body: str, sender: str) -> str:
    return f"{subject} {body} {sender}".lower()[:4000]


async def _participants(ctx, thread_id: str) -> set[str]:
    rows = (await ctx.conn.execute(sa.select(r.c.user_id).select_from(r.join(m, m.c.id == r.c.message_id))
                                   .where(m.c.thread_id == thread_id, m.c.is_draft.is_(False)))).scalars().all()
    return {str(x) for x in rows}


async def _my_row(ctx, mid: str):
    return (await ctx.conn.execute(sa.select(r).where(r.c.message_id == mid, r.c.user_id == ctx.user_id))).mappings().first()


async def _load(ctx, mid: str, *, for_write: bool = False) -> dict:
    if not is_uuid(mid):
        raise not_found("Message not found")
    row = (await ctx.conn.execute(sa.select(m).where(m.c.id == mid, m.c.deleted_at.is_(None)))).mappings().first()
    if not row:
        raise not_found("Message not found")
    mine = await _my_row(ctx, mid)
    if row["is_draft"] and str(row["sender_id"]) != ctx.user_id:
        raise not_found("Message not found")
    if not mine and not (not for_write and row["patient_id"] and ctx.role in CHART_ROLES):
        raise forbidden("This message was not sent to you")
    return dict(row)


def _out(row: dict, mine: dict | None = None, labels: dict | None = None) -> dict:
    d = {k: to_json_value(v) for k, v in row.items() if k not in ("search", "deleted_at")}
    if mine is not None:
        d.update(read=mine.get("read_at") is not None or mine.get("via") == "sender", pinned=bool(mine.get("pinned")),
                 archived=bool(mine.get("archived")), mentioned=bool(mine.get("mentioned")), via=mine.get("via"))
    if labels:
        d["patient_label"] = labels.get(str(row.get("patient_id") or ""))
        d["encounter_label"] = labels.get(str(row.get("encounter_id") or ""))
    return d


async def _labels(ctx, rows: list[dict]) -> dict[str, str]:
    pids = {str(x["patient_id"]) for x in rows if x.get("patient_id")}
    eids = {str(x["encounter_id"]) for x in rows if x.get("encounter_id")}
    out: dict[str, str] = {}
    if pids:
        for p in (await ctx.conn.execute(sa.select(patients.c.id, patients.c.code, patients.c.title).where(patients.c.id.in_(pids)))).all():
            out[str(p.id)] = f"{p.title} · {p.code}"
    if eids:
        for e in (await ctx.conn.execute(sa.select(encounters.c.id, encounters.c.code, encounters.c.type).where(encounters.c.id.in_(eids)))).all():
            out[str(e.id)] = f"{e.type} {e.code}"
    return out


def _notify(ctx, recipients: list[str], payload: dict) -> None:
    for uid in recipients:
        ctx.on_commit(lambda uid=uid: publish(f"u:{uid}", payload))


# ------------------------------------------------------------------ directory

@router.get("/directory")
async def directory(ctx: CtxDep, kind: Literal["people", "departments", "roles"] = "people", q: str | None = None, limit: int = 20):
    q = (q or "").strip().lower()
    limit = max(1, min(limit, 50))
    if kind == "roles":
        counts = dict((await ctx.conn.execute(sa.select(users.c.role, sa.func.count()).where(users.c.active.is_(True))
                                              .group_by(users.c.role))).all())
        return [{"type": "role", "id": k, "label": v, "members": counts.get(k, 0)} for k, v in ROLES.items()
                if not q or q in f"{k} {v}".lower()]
    if kind == "departments":
        t = records
        conds = [t.c.module == "mdm", t.c.entity == "departments", t.c.deleted_at.is_(None)]
        if q:
            conds.append(t.c.search.ilike(f"%{q}%"))
        depts = (await ctx.conn.execute(sa.select(t.c.id, t.c.title, t.c.code).where(*conds).order_by(t.c.title).limit(limit))).all()
        counts = dict((await ctx.conn.execute(
            sa.select(employees.c.department_id, sa.func.count()).select_from(users.join(employees, employees.c.id == users.c.employee_id))
            .where(users.c.active.is_(True)).group_by(employees.c.department_id))).all())
        return [{"type": "department", "id": str(d.id), "label": d.title, "code": d.code, "members": counts.get(d.id, 0)} for d in depts]
    u, e = users, employees
    stmt = (sa.select(u.c.id, u.c.username, u.c.name, u.c.role, e.c.designation, e.c.department_id)
            .select_from(u.outerjoin(e, e.c.id == u.c.employee_id)).where(u.c.active.is_(True)))
    if q:
        stmt = stmt.where(sa.or_(sa.func.lower(u.c.name).like(f"%{q}%"), sa.func.lower(u.c.username).like(f"%{q}%"),
                                 sa.func.lower(e.c.designation).like(f"%{q}%")))
    rows = (await ctx.conn.execute(stmt.order_by(u.c.name).limit(limit))).all()
    return [{"type": "user", "id": str(x.id), "label": x.name, "username": x.username, "role": x.role,
             "role_label": ROLES.get(x.role, x.role), "designation": x.designation} for x in rows]


# ------------------------------------------------------------------ list / counts

@router.get("")
async def list_messages(ctx: CtxDep, folder: str | None = None, q: str | None = None, unread: bool = False,
                        mentions: bool = False, priority: str | None = None, type: str | None = None,
                        patient_id: str | None = None, encounter_id: str | None = None, page: int = 1, limit: int = 30):
    limit = max(1, min(limit, 100))
    page = max(1, page)
    me = ctx.user_id
    chart = (patient_id or encounter_id) and not folder
    if folder and folder not in FOLDERS:
        raise bad_request(f"folder must be one of {', '.join(FOLDERS)}")
    folder = folder or "inbox"
    conds = [m.c.deleted_at.is_(None)]
    join = m.outerjoin(r, sa.and_(r.c.message_id == m.c.id, r.c.user_id == me))
    if chart:
        for k, v in (("patient_id", patient_id), ("encounter_id", encounter_id)):
            if v and not is_uuid(v):
                raise bad_request(f"Invalid {k}")
        conds.append(m.c.is_draft.is_(False))
        if patient_id:
            conds.append(m.c.patient_id == patient_id)
        if encounter_id:
            conds.append(m.c.encounter_id == encounter_id)
        if ctx.role not in CHART_ROLES:
            conds.append(r.c.user_id.is_not(None))
    elif folder == "drafts":
        conds += [m.c.sender_id == me, m.c.is_draft.is_(True)]
    elif folder == "sent":
        conds += [m.c.sender_id == me, m.c.is_draft.is_(False), r.c.archived.is_(False)]
    else:
        conds += [r.c.user_id.is_not(None), m.c.is_draft.is_(False)]
        if folder == "inbox":
            conds += [r.c.via != "sender", r.c.archived.is_(False)]
        elif folder == "pinned":
            conds += [r.c.pinned.is_(True), r.c.archived.is_(False)]
        elif folder == "archived":
            conds.append(r.c.archived.is_(True))
        elif folder == "tasks":
            conds += [m.c.is_task.is_(True), r.c.archived.is_(False)]
    if q:
        conds.append(m.c.search.ilike(f"%{q.strip().lower()}%"))
    if unread:
        conds += [r.c.read_at.is_(None), r.c.via != "sender"]
    if mentions:
        conds.append(r.c.mentioned.is_(True))
    if priority:
        conds.append(m.c.priority.in_([p for p in priority.upper().split(",") if p in PRIORITIES]))
    if type:
        conds.append(m.c.type.in_([t for t in type.upper().split(",") if t in TYPES]))
    order = [m.c.task_status.desc().nulls_last()] if folder == "tasks" else []
    order.append(sa.func.coalesce(m.c.sent_at, m.c.updated_at, m.c.created_at).desc())
    stmt = sa.select(m, r.c.read_at, r.c.pinned, r.c.archived, r.c.mentioned, r.c.via).select_from(join).where(*conds)
    rows = (await ctx.conn.execute(stmt.order_by(*order).limit(limit).offset((page - 1) * limit))).mappings().all()
    total = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(join).where(*conds))).scalar_one()
    items = [dict(x) for x in rows]
    labels = await _labels(ctx, items)
    out = []
    for x in items:
        mine = {k: x.pop(k) for k in ("read_at", "pinned", "archived", "mentioned", "via")}
        d = _out({k: v for k, v in x.items()}, mine if mine["via"] else None, labels)
        d["body_preview"] = (x.get("body") or "")[:160]
        d.pop("body", None)
        out.append(d)
    return {"rows": out, "total": total, "page": page, "limit": limit, "folder": "patient" if chart else folder}


@router.get("/counts")
async def counts(ctx: CtxDep):
    me = ctx.user_id
    base = m.join(r, sa.and_(r.c.message_id == m.c.id, r.c.user_id == me))
    live = [m.c.deleted_at.is_(None), m.c.is_draft.is_(False)]
    row = (await ctx.conn.execute(sa.select(
        sa.func.count().filter(sa.and_(r.c.read_at.is_(None), r.c.via != "sender", r.c.archived.is_(False))).label("unread"),
        sa.func.count().filter(sa.and_(r.c.read_at.is_(None), r.c.mentioned.is_(True))).label("mentions"),
        sa.func.count().filter(sa.and_(r.c.read_at.is_(None), r.c.via != "sender", m.c.priority == "URGENT")).label("urgent"),
        sa.func.count().filter(sa.and_(m.c.is_task.is_(True), m.c.task_status == "Open", r.c.archived.is_(False))).label("tasks_open"),
    ).select_from(base).where(*live))).mappings().first()
    drafts = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(m).where(
        m.c.sender_id == me, m.c.is_draft.is_(True), m.c.deleted_at.is_(None)))).scalar_one()
    return {**dict(row), "drafts": drafts}


# ------------------------------------------------------------------ read one (thread)

@router.get("/{mid}")
async def read_message(mid: str, ctx: CtxDep):
    row = await _load(ctx, mid)
    thread_id = row["thread_id"] or row["id"]
    thread = (await ctx.conn.execute(sa.select(m).where(m.c.thread_id == thread_id, m.c.deleted_at.is_(None),
                                                        sa.or_(m.c.is_draft.is_(False), m.c.id == row["id"]))
                                     .order_by(sa.func.coalesce(m.c.sent_at, m.c.created_at)))).mappings().all()
    ids = [x["id"] for x in thread]
    ts = now()
    await ctx.conn.execute(r.update().where(r.c.message_id.in_(ids), r.c.user_id == ctx.user_id, r.c.read_at.is_(None))
                           .values(read_at=ts))
    recips = (await ctx.conn.execute(
        sa.select(r.c.message_id, r.c.user_id, r.c.via, r.c.read_at, r.c.mentioned, users.c.name, users.c.role)
        .select_from(r.join(users, users.c.id == r.c.user_id)).where(r.c.message_id.in_(ids)))).mappings().all()
    by_msg: dict[str, list[dict]] = {}
    for x in recips:
        if x["via"] == "sender":
            continue
        by_msg.setdefault(str(x["message_id"]), []).append({
            "user_id": str(x["user_id"]), "name": x["name"], "role": x["role"], "via": x["via"],
            "read_at": to_json_value(x["read_at"]), "mentioned": x["mentioned"]})
    mine = await _my_row(ctx, mid)
    labels = await _labels(ctx, [dict(x) for x in thread])
    if row["patient_id"] and not mine:
        await audit(ctx, "message.view", module="messages", record={"id": str(row["id"]), "patient_id": str(row["patient_id"])})
    return {
        "message": _out(row, dict(mine) if mine else None, labels),
        "thread": [{**_out(dict(x), None, labels), "recipients": by_msg.get(str(x["id"]), [])} for x in thread],
        "can_reply": bool(mine) and not row["is_draft"],
    }


# ------------------------------------------------------------------ compose / drafts / reply

async def _write(ctx, body: MessageIn, existing: dict | None = None) -> dict:
    pid, eid = await _check_patient(ctx, body.patient_id, body.encounter_id)
    subject = body.subject.strip()
    text = body.body.strip()
    thread_id = None
    if body.reply_to:
        parent = await _load(ctx, body.reply_to, for_write=True)
        thread_id = parent["thread_id"] or parent["id"]
        if not subject:
            subject = parent["subject"] if (parent["subject"] or "").lower().startswith("re:") else f"Re: {parent['subject'] or ''}".strip()
        pid = pid or (str(parent["patient_id"]) if parent["patient_id"] else None)
        eid = eid or (str(parent["encounter_id"]) if parent["encounter_id"] else None)
    audience = [x.model_dump() for x in body.to]
    if not body.draft:
        if not subject:
            raise bad_request("Add a subject", {"fields": {"subject": "Required"}})
        if not text:
            raise bad_request("Write a message", {"fields": {"body": "Required"}})
    ts = now()
    values = dict(subject=subject[:200], body=text, priority=body.priority, type=body.type, patient_id=pid, encounter_id=eid,
                  is_task=body.is_task, task_status="Open" if body.is_task else None, audience=audience,
                  search=_search(subject, text, ctx.user.get("name") or ""), updated_at=ts)
    if existing:
        mid = existing["id"]
        await ctx.conn.execute(m.update().where(m.c.id == mid).values(**values))
    else:
        mid = new_id()
        code = await next_code(ctx.conn, "MSG")
        await ctx.conn.execute(m.insert().values(id=mid, code=code, thread_id=thread_id or mid, sender_id=ctx.user_id,
                                                 sender_name=ctx.user.get("name"), is_draft=True, branch_id=ctx.branch,
                                                 created_at=ts, **values))
        await ctx.conn.execute(r.insert().values(message_id=mid, user_id=ctx.user_id, via="sender", read_at=ts, created_at=ts))
    if body.draft:
        return await _reload(ctx, mid)
    return await _send(ctx, mid, body.to, text, thread_id)


async def _send(ctx, mid: str, to: list[Recipient], text: str, thread_id: str | None) -> dict:
    targets = await _expand(ctx, to)
    if thread_id:  # replies go to everybody in the conversation
        for uid in await _participants(ctx, thread_id):
            targets.setdefault(uid, "person")
    mentioned = await _mentions(ctx, text)
    for uid in mentioned:
        targets.setdefault(uid, "mention")
    targets.pop(ctx.user_id, None)
    if not targets:
        raise bad_request("Choose at least one recipient (person, department or role with active members)",
                          {"fields": {"to": "Required"}})
    ts = now()
    await ctx.conn.execute(r.insert().values([
        {"message_id": mid, "user_id": uid, "via": via, "mentioned": uid in mentioned, "created_at": ts}
        for uid, via in targets.items()]))
    await ctx.conn.execute(m.update().where(m.c.id == mid).values(is_draft=False, sent_at=ts, updated_at=ts))
    row = await _reload(ctx, mid)
    await audit(ctx, "message.send", module="messages", record={"id": mid, "code": row["code"], "patient_id": row.get("patient_id")},
                note=f"{row['priority']} {row['type']} to {len(targets)} recipient(s)")
    _notify(ctx, list(targets), {"type": "message", "id": mid, "subject": row["subject"], "from": ctx.user.get("name"),
                                 "priority": row["priority"], "kind": row["type"], "is_task": row["is_task"]})
    row["recipient_count"] = len(targets)
    return row


async def _reload(ctx, mid: str) -> dict:
    row = (await ctx.conn.execute(sa.select(m).where(m.c.id == mid))).mappings().first()
    return _out(dict(row))


@router.post("", status_code=201)
async def compose(body: MessageIn, ctx: CtxDep):
    return await _write(ctx, body)


@router.put("/{mid}")
async def update_draft(mid: str, body: MessageIn, ctx: CtxDep):
    row = await _load(ctx, mid, for_write=True)
    if not row["is_draft"] or str(row["sender_id"]) != ctx.user_id:
        raise bad_request("Only your own drafts can be edited")
    return await _write(ctx, body, existing=row)


@router.delete("/{mid}")
async def discard_draft(mid: str, ctx: CtxDep):
    row = await _load(ctx, mid, for_write=True)
    if not row["is_draft"] or str(row["sender_id"]) != ctx.user_id:
        raise bad_request("Sent messages cannot be deleted — archive them instead")
    await ctx.conn.execute(m.update().where(m.c.id == mid).values(deleted_at=now()))
    return {"ok": True}


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=20000)
    priority: Literal["LOW", "NORMAL", "HIGH", "URGENT"] | None = None


@router.post("/{mid}/reply", status_code=201)
async def reply(mid: str, body: ReplyIn, ctx: CtxDep):
    parent = await _load(ctx, mid, for_write=True)
    return await _write(ctx, MessageIn(body=body.body, priority=body.priority or parent["priority"], type="MESSAGE", reply_to=mid))


# ------------------------------------------------------------------ per-user state & tasks

class StateIn(BaseModel):
    read: bool | None = None
    pinned: bool | None = None
    archived: bool | None = None


@router.post("/{mid}/state")
async def set_state(mid: str, body: StateIn, ctx: CtxDep):
    await _load(ctx, mid, for_write=True)
    values: dict[str, Any] = {}
    if body.read is not None:
        values["read_at"] = now() if body.read else None
    if body.pinned is not None:
        values["pinned"] = body.pinned
    if body.archived is not None:
        values["archived"] = body.archived
    if values:
        await ctx.conn.execute(r.update().where(r.c.message_id == mid, r.c.user_id == ctx.user_id).values(**values))
    mine = await _my_row(ctx, mid)
    return {"ok": True, "read": mine["read_at"] is not None, "pinned": mine["pinned"], "archived": mine["archived"]}


class TaskIn(BaseModel):
    action: Literal["convert", "close", "reopen"]
    note: str | None = Field(default=None, max_length=500)


@router.post("/{mid}/task")
async def task(mid: str, body: TaskIn, ctx: CtxDep):
    row = await _load(ctx, mid, for_write=True)
    if row["is_draft"]:
        raise bad_request("Send the message first")
    ts = now()
    if body.action == "convert":
        values = dict(is_task=True, task_status="Open", task_closed_at=None, task_closed_by=None)
    elif not row["is_task"]:
        raise bad_request("This message is not a task")
    elif body.action == "close":
        values = dict(task_status="Closed", task_closed_at=ts, task_closed_by=ctx.user.get("name"))
    else:
        values = dict(task_status="Open", task_closed_at=None, task_closed_by=None)
    await ctx.conn.execute(m.update().where(m.c.id == mid).values(updated_at=ts, **values))
    await audit(ctx, f"message.task_{body.action}", module="messages", record={"id": mid, "code": row["code"]}, note=body.note)
    participants = await _participants(ctx, row["thread_id"] or row["id"])
    participants.discard(ctx.user_id)
    _notify(ctx, list(participants), {"type": "task", "id": mid, "action": body.action, "subject": row["subject"],
                                      "by": ctx.user.get("name")})
    return await _reload(ctx, mid)
