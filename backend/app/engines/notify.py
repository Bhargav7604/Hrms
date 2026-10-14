"""Notifications: domain events → active message templates → outbox → channel adapters.

Event → template `event_key` (Notifications › Message Templates):
    patient.registered → patient.registered      appointment.booked → appointment.booked
    appointment.checked_in → appointment.checked_in  (day-before job) → appointment.reminder
    appointment.doctor_unavailable → appointment.doctor_unavailable
    order.verified → report.ready                bill.created → bill.due (balance > 0)
    payment.received → payment.received          discharge.done → discharge.done
    otp.requested → otp                          queue.called → queue.called
An event without an active template sends nothing (SMS text must match a DLT-registered template).
Opt-outs (TRAI DND / DPDP withdrawal) and the patient's portal channel preferences are respected;
OTPs are always sent. Quiet hours (21:00–09:00) hold promotional / flagged templates.

Delivery: rows are created `Queued`; `dispatch()` sends them (immediately after the request commits,
and every minute from the worker) with retries at +1, +5, +15 min and `Failed` after 3 tries.
OTP text is never stored in the database: the outbox keeps a masked copy and the real text waits
in Redis (10 min) until it is sent.

Plugging a real gateway — `settings.notify_mode` (env NOTIFY_MODE):
  "log"  (default) every channel uses LogAdapter: rendered, logged and marked Sent; nothing leaves.
  "live" each channel uses the adapter registered for it. Built-ins read credentials from env:
         SMS — MSG91 DLT route: MSG91_AUTHKEY, MSG91_SENDER (6-char DLT header), MSG91_ROUTE (4)
         WhatsApp — Meta WhatsApp Cloud API: WA_TOKEN, WA_PHONE_NUMBER_ID, WA_API_VERSION (v20.0);
                    template messages use `wa_template_name`, placeholders become ordered body params
         Email — SMTP: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_STARTTLS (1)
  Other providers (Gupshup, Karix, Twilio, Amazon SES …): implement `async send(msg) -> SendResult`
  and call `register_adapter("WHATSAPP", GupshupAdapter())` at import time of any engine module.
Inbound WhatsApp (chat desk): point the Cloud API webhook at /api/public/notify/whatsapp with
WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET set (signature-checked)."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import re
import smtplib
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from typing import Any, Protocol

import httpx
import orjson
import sqlalchemy as sa
from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.hooks import hook, listen
from ..core.security import CtxDep, PublicCtxDep
from ..core.util import ApiError, bad_request, conflict, is_uuid, not_found, now, parse_date, today
from ..redis import PREFIX, get_redis
from ..schema import appointments, employees, notifications, patients, records, services
from ._common import E, create, find, get, has, live, require_role, transition, update

log = logging.getLogger("vlack.notify")
router = APIRouter(prefix="/api/notify", tags=["notifications"])
public_router = APIRouter(prefix="/api/public/notify", tags=["public"])

OUTBOX = "notifications.outbox"
TICKETS = "notifications.chat_tickets"
MAX_ATTEMPTS = 3
BACKOFF_MIN = (1, 5, 15)
SECRET_TTL = 600
PLACEHOLDER = re.compile(r"\{([a-z_][a-z0-9_]*)\}")
PREF_NAMES = {"SMS": "SMS", "WHATSAPP": "WHATSAPP", "EMAIL": "EMAIL", "PUSH": "PUSH"}
WA_LANG = {"English": "en", "Hindi": "hi", "Telugu": "te", "Tamil": "ta", "Kannada": "kn", "Malayalam": "ml",
           "Marathi": "mr", "Bengali": "bn"}


def _digits10(v: Any) -> str:
    d = re.sub(r"\D", "", str(v or ""))
    return d[-10:] if len(d) >= 10 else d


def mask_phone(p: str | None) -> str:
    p = _digits10(p)
    return f"******{p[-4:]}" if len(p) >= 4 else "—"


def _fmt_date(v: Any) -> str:
    d = parse_date(v) if v else None
    return d.strftime("%d %b %Y") if d else ""


def _fmt_amount(v: Any) -> str:
    try:
        return f"{float(v):,.2f}"
    except (TypeError, ValueError):
        return ""


def render(body: str, values: dict[str, Any]) -> tuple[str, list[str]]:
    """Fill {placeholders}; also returns the values in placeholder order (WhatsApp template params)."""
    vals = {k: "" if v is None else str(v) for k, v in values.items()}
    params = [vals.get(k, "") for k in PLACEHOLDER.findall(body or "")]
    return PLACEHOLDER.sub(lambda m: vals.get(m.group(1), ""), body or "").strip(), params


# ------------------------------------------------------------------ channel adapters

@dataclass
class OutMessage:
    id: str
    channel: str
    recipient: str
    text: str
    subject: str | None = None
    template: str | None = None
    dlt_template_id: str | None = None
    sender_id: str | None = None
    wa_template_name: str | None = None
    language: str | None = None
    params: list[str] = field(default_factory=list)
    sensitive: bool = False


@dataclass
class SendResult:
    provider: str
    provider_msg_id: str | None = None


class ChannelAdapter(Protocol):
    name: str

    async def send(self, msg: OutMessage) -> SendResult: ...


class GatewayNotConfigured(RuntimeError):
    pass


class _Permanent(RuntimeError):
    """Delivery can never succeed (e.g. an OTP that expired before sending) — fail without retries."""


def _intl(phone: str) -> str:
    return f"91{_digits10(phone)}"


class LogAdapter:
    name = "log"

    async def send(self, msg: OutMessage) -> SendResult:
        shown = mask_phone(msg.recipient) if msg.channel != "EMAIL" else msg.recipient
        log.info("[notify:%s] %s → %s: %s", msg.channel, msg.template, shown, "(one-time code — text not logged)" if msg.sensitive else msg.text[:160])
        return SendResult("log", f"LOG-{msg.id[:8].upper()}")


class Msg91SmsAdapter:
    """MSG91 transactional route with TRAI DLT: rendered text + DLT content template ID + header."""

    name = "msg91"

    async def send(self, msg: OutMessage) -> SendResult:
        key, sender = os.environ.get("MSG91_AUTHKEY"), msg.sender_id or os.environ.get("MSG91_SENDER")
        if not key or not sender:
            raise GatewayNotConfigured("SMS gateway (MSG91) is not configured")
        if not msg.dlt_template_id:
            raise _Permanent("SMS template has no DLT template ID — operators reject unregistered content")
        params = {"authkey": key, "mobiles": _intl(msg.recipient), "message": msg.text, "sender": sender,
                  "route": os.environ.get("MSG91_ROUTE", "4"), "country": "91", "DLT_TE_ID": msg.dlt_template_id}
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get("https://api.msg91.com/api/sendhttp.php", params=params)
        r.raise_for_status()
        return SendResult(self.name, r.text.strip()[:80] or None)


class WhatsAppCloudAdapter:
    """Meta WhatsApp Cloud API: approved templates for business-initiated messages, free text for replies."""

    name = "whatsapp-cloud"

    async def send(self, msg: OutMessage) -> SendResult:
        token, phone_id = os.environ.get("WA_TOKEN"), os.environ.get("WA_PHONE_NUMBER_ID")
        if not token or not phone_id:
            raise GatewayNotConfigured("WhatsApp Cloud API is not configured")
        url = f"https://graph.facebook.com/{os.environ.get('WA_API_VERSION', 'v20.0')}/{phone_id}/messages"
        body: dict[str, Any] = {"messaging_product": "whatsapp", "to": _intl(msg.recipient)}
        if msg.wa_template_name:
            tpl: dict[str, Any] = {"name": msg.wa_template_name, "language": {"code": WA_LANG.get(msg.language or "", "en")}}
            if msg.params:
                tpl["components"] = [{"type": "body", "parameters": [{"type": "text", "text": p or "-"} for p in msg.params]}]
            body.update(type="template", template=tpl)
        else:
            body.update(type="text", text={"body": msg.text})
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(url, json=body, headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        return SendResult(self.name, ((r.json().get("messages") or [{}])[0]).get("id"))


class SmtpEmailAdapter:
    name = "smtp"

    async def send(self, msg: OutMessage) -> SendResult:
        host, sender = os.environ.get("SMTP_HOST"), os.environ.get("SMTP_FROM")
        if not host or not sender:
            raise GatewayNotConfigured("SMTP is not configured")

        def _send() -> None:
            m = EmailMessage()
            m["From"], m["To"], m["Subject"] = sender, msg.recipient, msg.subject or settings.hospital_name
            m.set_content(msg.text)
            with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=15) as s:
                if os.environ.get("SMTP_STARTTLS", "1") == "1":
                    s.starttls()
                if os.environ.get("SMTP_USER"):
                    s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
                s.send_message(m)

        await asyncio.to_thread(_send)
        return SendResult(self.name, msg.id)


_LOG = LogAdapter()
_ADAPTERS: dict[str, ChannelAdapter] = {"SMS": Msg91SmsAdapter(), "WHATSAPP": WhatsAppCloudAdapter(), "EMAIL": SmtpEmailAdapter()}


def register_adapter(channel: str, adapter: ChannelAdapter) -> None:
    _ADAPTERS[channel.upper()] = adapter


def adapter_for(channel: str) -> ChannelAdapter:
    if settings.notify_mode == "log":
        return _LOG
    a = _ADAPTERS.get(channel.upper())
    if not a:
        raise GatewayNotConfigured(f"No {channel} gateway is registered")
    return a


# ------------------------------------------------------------------ composing messages

async def _patient(ctx, pid: str | None) -> dict | None:
    if not pid or not is_uuid(pid):
        return None
    row = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.title, patients.c.code, patients.c.phone, patients.c.email,
                                            patients.c.first_name).where(patients.c.id == pid))).first()
    return dict(row._mapping) if row else None


async def _account(ctx, pid: str | None) -> dict | None:
    if not pid or not has("portal.accounts"):
        return None
    rows = await find(ctx, "portal.accounts", patient_id=pid, limit=1)
    return rows[0] if rows else None


async def _opt_outs(ctx, phone: str | None, email: str | None) -> list[dict]:
    if not has("notifications.opt_outs") or not (phone or email):
        return []
    t = records
    conds = []
    if phone:
        conds.append(sa.func.right(sa.func.regexp_replace(t.c.data["phone"].astext, r"\D", "", "g"), 10) == phone)
    if email:
        conds.append(sa.func.lower(t.c.data["email"].astext) == email.lower())
    rows = (await ctx.conn.execute(sa.select(t).where(t.c.module == "notifications", t.c.entity == "opt_outs", t.c.deleted_at.is_(None),
                                                      t.c.status == "Opted Out", sa.or_(*conds)))).all()
    return [rs.to_record(r) for r in rows]


def _blocked_by(opt_outs: list[dict], channel: str, promotional: bool) -> str | None:
    for o in opt_outs:
        if channel in (o.get("channels") or []) and (promotional or o.get("scope") == "All non-critical messages"):
            return o.get("code")
    return None


def _pick_templates(templates: list[dict], language: str) -> dict[str, dict]:
    """One template per channel, in the patient's language when available, else English."""
    out: dict[str, dict] = {}
    for t in templates:
        ch = (t.get("channel") or "").upper()
        cur = out.get(ch)
        rank = 0 if t.get("language") == language else 1 if t.get("language") in (None, "English") else 2
        if cur is None or rank < cur["_rank"]:
            out[ch] = {**t, "_rank": rank}
    return out


def _after_quiet_hours(when: str | None) -> str | None:
    ts = datetime.fromisoformat(when) if when else now()
    if 9 <= ts.hour < 21:
        return when
    nine = ts.replace(hour=9, minute=0, second=0, microsecond=0)
    return (nine if ts.hour < 9 else nine + timedelta(days=1)).isoformat(timespec="seconds")


async def notify(ctx, event_key: str, *, values: dict[str, Any], patient_id: str | None = None, phone: str | None = None,
                 email: str | None = None, ref_id: str | None = None, critical: bool = False, sensitive: bool = False,
                 scheduled_for: str | None = None) -> list[dict]:
    """Render every active template for `event_key` into Queued outbox rows. Returns the rows."""
    templates = await find(ctx, "notifications.templates", status="Active", event_key=event_key, limit=20)
    if not templates:
        log.debug("no active template for %s", event_key)
        return []
    pat = await _patient(ctx, patient_id)
    phone = _digits10(phone or (pat or {}).get("phone")) or None
    email = email or (pat or {}).get("email")
    acct = await _account(ctx, patient_id)
    prefs = {PREF_NAMES.get(p.upper().replace(" ", ""), p.upper()) for p in (acct or {}).get("notification_prefs") or []}
    vals = {"hospital": settings.hospital_name, "patient_name": (pat or {}).get("title") or "", "first_name": (pat or {}).get("first_name") or "",
            "uhid": (pat or {}).get("code") or "", **values}
    opt = [] if critical else await _opt_outs(ctx, phone, email)
    rows: list[dict] = []
    for channel, tpl in _pick_templates(templates, (acct or {}).get("preferred_language") or "English").items():
        recipient = email if channel == "EMAIL" else phone if channel in ("SMS", "WHATSAPP") else None
        if not recipient:
            continue
        if prefs and not critical and channel not in prefs:
            continue
        promotional = tpl.get("trai_category") == "Promotional" or tpl.get("wa_category") == "Marketing"
        blocked = _blocked_by(opt, channel, promotional)
        if blocked:
            log.info("%s via %s suppressed by opt-out %s", event_key, channel, blocked)
            continue
        text, params = render(tpl.get("body") or "", vals)
        when = _after_quiet_hours(scheduled_for) if (tpl.get("respect_quiet_hours") or promotional) else scheduled_for
        stored = text
        if sensitive:  # never persist one-time codes
            for k in ("otp", "code", "password"):
                if values.get(k):
                    stored = stored.replace(str(values[k]), "•" * len(str(values[k])))
        row = await create(ctx, OUTBOX, {
            "patient_id": patient_id if pat else None, "channel": channel, "recipient": recipient, "template": event_key,
            "message": stored, "attempts": 0, "status": "Queued", "template_id": tpl["id"],
            "subject": render(tpl.get("subject") or "", vals)[0] or None, "dlt_template_id": tpl.get("dlt_template_id"),
            "sender_id": tpl.get("sender_id"), "wa_template_name": tpl.get("wa_template_name"), "language": tpl.get("language"),
            "params": None if sensitive else params, "ref_id": ref_id, "scheduled_for": when, "sensitive": sensitive or None,
        })
        if sensitive:
            await get_redis().set(f"{PREFIX}notify:secret:{row['id']}", orjson.dumps({"text": text, "params": params}), ex=SECRET_TTL)
        rows.append(row)
    if rows:
        ids = [r["id"] for r in rows]
        ctx.on_commit(lambda: kick(ids))
    return rows


# ------------------------------------------------------------------ delivery

_background: set[asyncio.Task] = set()


async def kick(ids: list[str]) -> None:
    """Deliver these rows right after commit without delaying the response (worker retries the rest)."""
    task = asyncio.create_task(_dispatch_now(ids))
    _background.add(task)
    task.add_done_callback(_background.discard)


async def _dispatch_now(ids: list[str]) -> None:
    from ..db import system_ctx

    try:
        async with system_ctx() as ctx:
            await dispatch(ctx, ids=ids)
    except Exception:
        log.exception("immediate dispatch failed; the worker will retry")


async def _secret(oid: str) -> tuple[str, list[str]] | None:
    raw = await get_redis().get(f"{PREFIX}notify:secret:{oid}")
    if not raw:
        return None
    d = orjson.loads(raw)
    return d["text"], d.get("params") or []


async def _deliver(ctx, rec: dict) -> str:
    attempts = int(rec.get("attempts") or 0) + 1
    ts = now().isoformat(timespec="seconds")
    try:
        text, params = rec.get("message") or "", rec.get("params") or []
        if rec.get("sensitive"):
            secret = await _secret(rec["id"])
            if not secret:
                raise _Permanent("Expired before it could be delivered — the patient must request a new code")
            text, params = secret
        res = await adapter_for(rec["channel"]).send(OutMessage(
            id=rec["id"], channel=rec["channel"], recipient=rec["recipient"], text=text, subject=rec.get("subject"),
            template=rec.get("template"), dlt_template_id=rec.get("dlt_template_id"), sender_id=rec.get("sender_id"),
            wa_template_name=rec.get("wa_template_name"), language=rec.get("language"), params=params,
            sensitive=bool(rec.get("sensitive"))))
    except Exception as e:  # noqa: BLE001 — every gateway error becomes a retry / failure on the row
        err = (str(e) or e.__class__.__name__)[:300]
        if isinstance(e, _Permanent) or attempts >= MAX_ATTEMPTS:
            await update(ctx, OUTBOX, rec["id"], {"status": "Failed", "attempts": attempts, "error": err, "next_attempt_at": None})
            log.warning("message %s failed permanently: %s", rec.get("code"), err)
            return "failed"
        nxt = (now() + timedelta(minutes=BACKOFF_MIN[min(attempts - 1, len(BACKOFF_MIN) - 1)])).isoformat(timespec="seconds")
        await update(ctx, OUTBOX, rec["id"], {"attempts": attempts, "error": err, "next_attempt_at": nxt})
        return "retry"
    await update(ctx, OUTBOX, rec["id"], {"status": "Sent", "sent_at": ts, "attempts": attempts, "provider": res.provider,
                                          "provider_msg_id": res.provider_msg_id, "error": None, "next_attempt_at": None})
    if rec.get("sensitive"):
        await get_redis().delete(f"{PREFIX}notify:secret:{rec['id']}")
    return "sent"


async def dispatch(ctx, *, ids: list[str] | None = None, limit: int = 200) -> dict[str, int]:
    """Send due Queued messages (row-locked so the worker and immediate sends never double-send)."""
    t = notifications
    ts = now().isoformat(timespec="seconds")
    conds = [t.c.status == "Queued", t.c.deleted_at.is_(None),
             sa.or_(t.c.data["next_attempt_at"].astext.is_(None), t.c.data["next_attempt_at"].astext <= ts),
             sa.or_(t.c.data["scheduled_for"].astext.is_(None), t.c.data["scheduled_for"].astext <= ts)]
    if ids:
        conds.append(t.c.id.in_(ids))
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(t.c.created_at.asc()).limit(limit)
                                   .with_for_update(skip_locked=True))).all()
    counts = {"sent": 0, "retry": 0, "failed": 0}
    for row in rows:
        counts[await _deliver(ctx, rs.to_record(row))] += 1
    if rows:
        log.info("dispatch: %s", counts)
    return counts


@hook(OUTBOX, "before_transition")
async def _retry(ctx, nxt: dict, prev: dict):
    if nxt.get("status") == "Queued" and prev.get("status") == "Failed":
        if prev.get("sensitive"):
            raise conflict("One-time passwords cannot be re-sent — ask the patient to request a new code")
        nxt.update(attempts=0, next_attempt_at=None, error=None)
        ctx.on_commit(lambda: kick([nxt["id"]]))


# ------------------------------------------------------------------ event listeners

def on(event: str):
    """Listener inside a SAVEPOINT: a notification problem never breaks the clinical transaction."""
    def deco(fn):
        async def wrapped(ctx, payload: dict):
            async with ctx.conn.begin_nested():
                await fn(ctx, payload)
        wrapped.__name__ = fn.__name__
        listen(event)(wrapped)
        return fn
    return deco


def _dig(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        if obj.get(key) not in (None, ""):
            return obj[key]
        for v in obj.values():
            found = _dig(v, key)
            if found not in (None, ""):
                return found
    return None


async def _employee_name(ctx, eid: str | None) -> str:
    if not eid:
        return ""
    return (await ctx.conn.execute(sa.select(employees.c.name).where(employees.c.id == eid))).scalar() or ""


async def appointment_values(ctx, a: dict) -> dict[str, Any]:
    dept = (await ctx.conn.execute(sa.select(records.c.title).where(records.c.id == a["department_id"]))).scalar() if a.get("department_id") else None
    return {"date": _fmt_date(a.get("appt_date")), "time": a.get("slot") or "", "doctor": await _employee_name(ctx, a.get("doctor_id")),
            "token": a.get("token_no") or "", "department": dept or "", "appointment": a.get("code") or ""}


@on("patient.registered")
async def _registered(ctx, p: dict):
    pat = p.get("patient") or {}
    if pat.get("id"):
        await notify(ctx, "patient.registered", patient_id=pat["id"], values={}, ref_id=pat["id"])


@on("appointment.booked")
async def _booked(ctx, p: dict):
    a = p.get("appointment") or {}
    if a.get("patient_id"):
        await notify(ctx, "appointment.booked", patient_id=a["patient_id"], values=await appointment_values(ctx, a), ref_id=a.get("id"))


@on("appointment.checked_in")
async def _checked_in(ctx, p: dict):
    a = p.get("appointment") or {}
    if a.get("patient_id"):
        vals = await appointment_values(ctx, a)
        vals["token"] = p.get("label") or vals["token"]
        await notify(ctx, "appointment.checked_in", patient_id=a["patient_id"], values=vals, ref_id=a.get("id"))


@on("appointment.doctor_unavailable")
async def _doctor_unavailable(ctx, p: dict):
    a, leave = p.get("appointment") or {}, p.get("leave") or {}
    if a.get("patient_id"):
        vals = {**await appointment_values(ctx, a), "reason": leave.get("reason") or "", "from_date": _fmt_date(leave.get("from_date")),
                "to_date": _fmt_date(leave.get("to_date"))}
        await notify(ctx, "appointment.doctor_unavailable", patient_id=a["patient_id"], values=vals, ref_id=a.get("id"))


@on("order.verified")
async def _report_ready(ctx, p: dict):
    o = p.get("order") or p
    pid = o.get("patient_id") or _dig(p, "patient_id")
    if not pid or (o.get("category") and o["category"] not in ("LAB", "RAD")):
        return
    sid = o.get("service_id")
    test = (await ctx.conn.execute(sa.select(services.c.title).where(services.c.id == sid))).scalar() if sid else None
    await notify(ctx, "report.ready", patient_id=pid, values={"test": test or "test", "order": o.get("code") or ""}, ref_id=o.get("id"))


@on("bill.created")
async def _bill_due(ctx, p: dict):
    inv = p.get("invoice") or p
    if not inv.get("patient_id") or inv.get("status") not in ("Final", "Partially Paid"):
        return
    if float(inv.get("balance") or 0) <= 0:
        return
    await notify(ctx, "bill.due", patient_id=inv["patient_id"], ref_id=inv.get("id"),
                 values={"amount": _fmt_amount(inv.get("balance")), "bill": inv.get("code") or "", "date": _fmt_date(inv.get("billed_at"))})


@on("payment.received")
async def _payment(ctx, p: dict):
    pay = p.get("payment") or p
    if not pay.get("patient_id") or pay.get("kind") not in ("PAYMENT", "DEPOSIT") or pay.get("status") != "Success":
        return
    await notify(ctx, "payment.received", patient_id=pay["patient_id"], ref_id=pay.get("id"),
                 values={"amount": _fmt_amount(pay.get("amount")), "receipt": pay.get("code") or "", "mode": pay.get("mode") or "",
                         "date": _fmt_date(pay.get("paid_at"))})


@on("discharge.done")
async def _discharged(ctx, p: dict):
    pid = _dig(p, "patient_id")
    if pid:
        follow = _dig(p, "follow_up_date") or _dig(p, "follow_up")
        await notify(ctx, "discharge.done", patient_id=pid, ref_id=_dig(p, "id"),
                     values={"date": _fmt_date(follow) or "the date advised", "doctor": await _employee_name(ctx, _dig(p, "doctor_id"))})


@on("otp.requested")
async def _otp(ctx, p: dict):
    if p.get("phone") and p.get("otp"):
        await notify(ctx, "otp", phone=p["phone"], patient_id=p.get("patient_id"), critical=True, sensitive=True,
                     values={"otp": p["otp"], "purpose": p.get("purpose") or ""})


@on("queue.called")
async def _queue_called(ctx, p: dict):
    tok = p.get("token") or {}
    if tok.get("patient_id") and not p.get("recall") and int(tok.get("call_count") or 1) <= 1:
        await notify(ctx, "queue.called", patient_id=tok["patient_id"], ref_id=tok.get("id"),
                     values={"token": p.get("label") or tok.get("token_no"), "counter": p.get("counter") or ""})


# ------------------------------------------------------------------ day-before reminders (worker, 18:00)

async def queue_reminders(ctx, for_date: date | None = None) -> int:
    d = for_date or today() + timedelta(days=1)
    a = appointments
    rows = [rs.to_record(r) for r in (await ctx.conn.execute(sa.select(a).where(
        a.c.appt_date == d, a.c.status == "Booked", a.c.deleted_at.is_(None)))).all()]
    if not rows:
        return 0
    t = notifications
    done = set((await ctx.conn.execute(sa.select(t.c.data["ref_id"].astext).where(
        t.c.template == "appointment.reminder", t.c.data["ref_id"].astext.in_([r["id"] for r in rows])))).scalars().all())
    n = 0
    for r in rows:
        if r["id"] in done or not r.get("patient_id"):
            continue
        n += len(await notify(ctx, "appointment.reminder", patient_id=r["patient_id"], values=await appointment_values(ctx, r), ref_id=r["id"]))
    log.info("queued %s appointment reminders for %s", n, d)
    return n


# ------------------------------------------------------------------ WhatsApp chat desk

CATEGORY_WORDS: list[tuple[str, tuple[str, ...]]] = [
    ("Emergency", ("emergency", "ambulance", "chest pain", "accident", "unconscious", "bleeding", "not breathing", "breathless")),
    ("Appointment", ("appointment", "book", "slot", "reschedule", "opd", "doctor available", "timing")),
    ("Reports", ("report", "result", "scan", "x-ray", "xray", "mri", "ct ", "blood test")),
    ("Billing / payment", ("bill", "payment", "refund", "paid", "amount", "invoice", "receipt", "upi")),
    ("Insurance", ("insurance", "claim", "tpa", "cashless", "policy", "ayushman", "aarogyasri", "pmjay")),
    ("Prescription / pharmacy", ("medicine", "prescription", "pharmacy", "tablet", "refill")),
    ("Home care", ("home care", "home visit", "nurse at home", "home collection")),
    ("Complaint", ("complain", "worst", "rude", "bad service", "not happy", "disappointed", "pathetic")),
    ("Feedback", ("thank", "feedback", "great service", "excellent")),
]
STOP_WORDS = {"STOP", "STOP ALL", "UNSUBSCRIBE", "OPT OUT", "OPTOUT"}


def classify(text: str) -> tuple[str, str]:
    low = f" {text.lower()} "
    for cat, words in CATEGORY_WORDS:
        if any(w in low for w in words):
            return cat, "Urgent" if cat == "Emergency" else "High" if cat == "Complaint" else "Normal"
    return "General enquiry", "Normal"


async def inbound_message(ctx, *, phone: str, text: str, name: str | None = None, channel: str = "WhatsApp",
                          provider_msg_id: str | None = None) -> dict:
    """Open a chat ticket for a new conversation, or append to the open one for this number."""
    p10 = _digits10(phone)
    if len(p10) != 10:
        raise bad_request("A 10-digit mobile number is required")
    text = (text or "").strip()[:4000]
    if not text:
        raise bad_request("The message is empty")
    if text.upper() in STOP_WORDS and has("notifications.opt_outs"):
        existing = await _opt_outs(ctx, p10, None)
        if not existing:
            await create(ctx, "notifications.opt_outs", {"phone": p10, "channels": ["WHATSAPP", "SMS"], "scope": "All non-critical messages",
                                                         "source": "STOP reply", "opted_out_at": now().isoformat(timespec="seconds"),
                                                         "status": "Opted Out"})
        return {"opted_out": True}
    ts = now().isoformat(timespec="seconds")
    msg = {"dir": "in", "text": text, "at": ts, "provider_msg_id": provider_msg_id}
    t = records
    open_row = (await ctx.conn.execute(sa.select(t.c.id).where(
        t.c.module == "notifications", t.c.entity == "chat_tickets", t.c.deleted_at.is_(None), t.c.data["phone"].astext == p10,
        t.c.status.in_(["Open", "In Progress"])).order_by(t.c.created_at.desc()).limit(1))).first()
    if open_row:
        cur = await get(ctx, TICKETS, str(open_row.id))
        rec = await update(ctx, TICKETS, cur["id"], {"last_message": text, "messages": [*(cur.get("messages") or [])[-199:], msg],
                                                     "unread": True, "last_inbound_at": ts})
        return {"ticket": rec, "created": False}
    pats = (await ctx.conn.execute(sa.select(patients.c.id, patients.c.title).where(
        patients.c.phone == p10, patients.c.deleted_at.is_(None), patients.c.status == "Active").limit(2))).all()
    category, priority = classify(text)
    rec = await create(ctx, TICKETS, {
        "phone": p10, "contact_name": name or (pats[0].title if len(pats) == 1 else None), "channel": channel,
        "subject": (text[:77] + "…") if len(text) > 80 else text, "category": category, "priority": priority,
        "patient_id": str(pats[0].id) if len(pats) == 1 else None, "last_message": text, "messages": [msg],
        "unread": True, "last_inbound_at": ts, "status": "Open",
    })
    if priority == "Urgent":
        live(ctx, "alerts", {"type": "chat_urgent", "message": f"Urgent {channel} message ({rec['code']}): {rec.get('subject')}"})
    return {"ticket": rec, "created": True}


class InboundIn(BaseModel):
    phone: str
    text: str = Field(min_length=1, max_length=4000)
    contact_name: str | None = None
    channel: str = "WhatsApp"


@router.post("/inbound", status_code=201)
async def inbound_api(body: InboundIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(TICKETS), "write")
    if body.channel not in ("WhatsApp", "SMS", "Email", "Web chat"):
        raise bad_request("Unknown channel")
    return await inbound_message(ctx, phone=body.phone, text=body.text, name=body.contact_name, channel=body.channel)


class ReplyIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@router.post("/chat-tickets/{tid}/reply", status_code=201)
async def reply_api(tid: str, body: ReplyIn, ctx: CtxDep):
    rs.ensure_access(ctx, E(TICKETS), "write")
    tk = await get(ctx, TICKETS, tid)
    if not tk:
        raise not_found("Chat ticket not found")
    if tk.get("status") == "Closed":
        raise conflict("This conversation is closed")
    channel = {"WhatsApp": "WHATSAPP", "SMS": "SMS", "Email": "EMAIL"}.get(tk.get("channel") or "WhatsApp", "WHATSAPP")
    out = await create(ctx, OUTBOX, {"patient_id": tk.get("patient_id"), "channel": channel, "recipient": tk["phone"], "template": "chat.reply",
                                     "message": body.text.strip(), "attempts": 0, "status": "Queued", "ref_id": tid})
    ts = now().isoformat(timespec="seconds")
    msgs = [*(tk.get("messages") or [])[-199:], {"dir": "out", "text": body.text.strip(), "at": ts, "by": ctx.user.get("name"), "outbox": out["id"]}]
    rec = await update(ctx, TICKETS, tid, {"messages": msgs, "unread": False, "last_reply_at": ts})
    if rec.get("status") == "Open":
        rec = await transition(ctx, TICKETS, tid, "In Progress", values={"assigned_to": ctx.user.get("employee_id")} if ctx.user.get("employee_id") else None)
    ctx.on_commit(lambda: kick([out["id"]]))
    return {"ticket": rec, "message": out}


@router.post("/dispatch")
async def dispatch_api(ctx: CtxDep):
    require_role(ctx, "front_office", "marketing")
    return await dispatch(ctx)


@public_router.get("/whatsapp", response_class=PlainTextResponse)
async def whatsapp_verify(request: Request):
    """Meta webhook verification handshake."""
    q = request.query_params
    expected = os.environ.get("WHATSAPP_VERIFY_TOKEN")
    if not expected or q.get("hub.mode") != "subscribe" or not hmac.compare_digest(q.get("hub.verify_token") or "", expected):
        raise ApiError(403, "Verification failed")
    return PlainTextResponse(q.get("hub.challenge") or "")


@public_router.post("/whatsapp")
async def whatsapp_inbound(request: Request, ctx: PublicCtxDep):
    """WhatsApp Cloud API webhook: inbound messages → chat desk; delivery receipts → outbox."""
    secret = os.environ.get("WHATSAPP_APP_SECRET")
    if not secret:
        raise ApiError(503, "WhatsApp webhook is not configured")
    raw = await request.body()
    sig = request.headers.get("x-hub-signature-256", "")
    if not hmac.compare_digest(sig, "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()):
        raise ApiError(401, "Bad signature")
    try:
        payload = orjson.loads(raw)
    except orjson.JSONDecodeError as e:
        raise bad_request("Invalid JSON") from e
    received = delivered = 0
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            v = change.get("value") or {}
            names = {c.get("wa_id"): (c.get("profile") or {}).get("name") for c in v.get("contacts") or []}
            for m in v.get("messages") or []:
                text = (m.get("text") or {}).get("body") or (m.get("button") or {}).get("text") \
                    or ((m.get("interactive") or {}).get("button_reply") or {}).get("title")
                if text and m.get("from"):
                    await inbound_message(ctx, phone=m["from"], text=text, name=names.get(m["from"]), provider_msg_id=m.get("id"))
                    received += 1
            for s in v.get("statuses") or []:
                if s.get("status") in ("delivered", "read") and s.get("id"):
                    delivered += await _mark_delivered(ctx, s["id"])
    return {"ok": True, "received": received, "delivered": delivered}


async def _mark_delivered(ctx, provider_msg_id: str) -> int:
    t = notifications
    row = (await ctx.conn.execute(sa.select(t.c.id).where(t.c.data["provider_msg_id"].astext == provider_msg_id, t.c.status == "Sent").limit(1))).first()
    if not row:
        return 0
    await update(ctx, OUTBOX, str(row.id), {"status": "Delivered", "delivered_at": now().isoformat(timespec="seconds")})
    return 1


__all__ = ["router", "public_router", "notify", "dispatch", "queue_reminders", "register_adapter", "ChannelAdapter", "OutMessage",
           "SendResult", "inbound_message", "render", "mask_phone", "appointment_values"]
