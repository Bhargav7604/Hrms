"""Front-office computed fields the module definitions mark as system-maintained:

* counseling.estimates  actual_amount / variance — from the linked admission's bills (bill.created)
* referrals.referrals   billed_amount — the patient's bills during the referral episode
* camps.camps           footfall — number of camp registrations
* homecare.remote_vitals alert_level — rule-based thresholds (+ the enrolment's own alert limits)
* marketing.campaigns   leads_generated / conversions / revenue_attributed — CRM leads + camp outreach
* telemedicine.teleconsults meeting_link — generated when the consult is booked
* consents.consents     consent_type / template_version — copied from the (active) template

Each value is recomputed from source rows (idempotent) and only written when it changed; a nightly
job re-derives the counters so deletions can never leave them stale."""

from __future__ import annotations

import logging
import os
import re
import secrets
from decimal import Decimal
from typing import Any

import sqlalchemy as sa

from ..core import records as rs
from ..core.hooks import hook
from ..core.util import bad_request, conflict, day_bounds, now, parse_date
from ..schema import invoices, records
from ._common import find, get, has, update
from .notify import on

log = logging.getLogger("vlack.frontoffice")
BILLABLE = ("Draft", "Final", "Partially Paid", "Paid")


def _num(v: Any) -> Decimal:
    try:
        return Decimal(str(v or 0))
    except ArithmeticError:
        return Decimal(0)


def _changed(rec: dict, patch: dict) -> bool:
    for k, v in patch.items():
        cur = rec.get(k)
        if isinstance(v, (int, float, Decimal)) and cur is not None:
            if _num(cur) != _num(v):
                return True
        elif cur != v:
            return True
    return False


async def _patch(ctx, fqn: str, rec: dict, patch: dict) -> None:
    if _changed(rec, patch):
        await update(ctx, fqn, rec["id"], patch)


def _rows(*conds):
    t = records
    return sa.select(t).where(t.c.deleted_at.is_(None), *conds)


# ------------------------------------------------------------------ counseling: estimate vs actual

async def estimate_actuals(ctx, est: dict) -> None:
    eid = est.get("admission") or est.get("encounter_id")
    if not eid:
        return
    total = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(invoices.c.net), 0)).where(
        invoices.c.encounter_id == eid, invoices.c.deleted_at.is_(None), invoices.c.status.in_(BILLABLE),
        invoices.c.type != "OP"))).scalar_one()
    actual = _num(total)
    if actual == 0 and est.get("actual_amount") in (None, ""):
        return
    await _patch(ctx, "counseling.estimates", est, {"actual_amount": float(actual),
                                                    "variance": float(actual - _num(est.get("estimated_amount")))})


@on("bill.created")
async def _bill_created(ctx, p: dict):
    inv = p.get("invoice") or p
    if has("counseling.estimates") and inv.get("encounter_id"):
        t = records
        rows = (await ctx.conn.execute(_rows(t.c.module == "counseling", t.c.entity == "estimates", sa.or_(
            t.c.data["admission"].astext == inv["encounter_id"], t.c.encounter_id == inv["encounter_id"])))).all()
        for r in rows:
            await estimate_actuals(ctx, rs.to_record(r))
    if has("referrals.referrals") and inv.get("patient_id"):
        for ref in await find(ctx, "referrals.referrals", patient_id=inv["patient_id"], limit=50):
            await referral_revenue(ctx, ref)


@hook("counseling.estimates", "after_update")
@hook("counseling.estimates", "after_transition")
async def _estimate_changed(ctx, rec: dict, prev: dict):
    if rec.get("admission") or rec.get("encounter_id"):
        await estimate_actuals(ctx, rec)


# ------------------------------------------------------------------ referrals: revenue in the episode

async def referral_revenue(ctx, ref: dict) -> None:
    if ref.get("status") == "Cancelled" or ref.get("direction") == "Outbound" or not ref.get("patient_id"):
        return
    start = parse_date(ref.get("referral_date"))
    if not start:
        return
    conds = [invoices.c.patient_id == ref["patient_id"], invoices.c.deleted_at.is_(None), invoices.c.status.in_(BILLABLE),
             invoices.c.billed_at >= day_bounds(start)[0]]
    end = parse_date(ref.get("closed_at"))
    if end:
        conds.append(invoices.c.billed_at < day_bounds(end)[1])
    total = _num((await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(invoices.c.net), 0)).where(*conds))).scalar_one())
    if total == 0 and ref.get("billed_amount") in (None, ""):
        return
    await _patch(ctx, "referrals.referrals", ref, {"billed_amount": float(total)})


@hook("referrals.referrals", "after_create")
@hook("referrals.referrals", "after_transition")
async def _referral_changed(ctx, rec: dict, prev: dict | None = None):
    await referral_revenue(ctx, rec)


# ------------------------------------------------------------------ camps: footfall

async def camp_footfall(ctx, camp_id: str | None) -> None:
    camp = await get(ctx, "camps.camps", camp_id) if camp_id else None
    if not camp:
        return
    t = records
    n = (await ctx.conn.execute(sa.select(sa.func.count()).where(
        t.c.module == "camps", t.c.entity == "registrations", t.c.deleted_at.is_(None), t.c.data["camp"].astext == camp_id))).scalar_one()
    await _patch(ctx, "camps.camps", camp, {"footfall": int(n)})


@hook("camps.registrations", "after_create")
@hook("camps.registrations", "after_update")
@hook("camps.registrations", "after_transition")
async def _registration_changed(ctx, rec: dict, prev: dict | None = None):
    camps = {rec.get("camp"), (prev or {}).get("camp")}
    for cid in camps:
        await camp_footfall(ctx, cid)
        await _campaign_for_camp(ctx, cid)


# ------------------------------------------------------------------ marketing: campaign attribution

async def campaign_attribution(ctx, campaign_id: str | None) -> None:
    camp = await get(ctx, "marketing.campaigns", campaign_id) if campaign_id else None
    if not camp:
        return
    t = records
    leads = (await ctx.conn.execute(sa.select(
        sa.func.count(), sa.func.count().filter(t.c.status == "Converted"),
        sa.func.coalesce(sa.func.sum(sa.cast(sa.func.nullif(t.c.data["conversion_value"].astext, ""), sa.Numeric)).filter(t.c.status == "Converted"), 0),
    ).where(t.c.module == "crm", t.c.entity == "leads", t.c.deleted_at.is_(None), t.c.data["campaign"].astext == campaign_id))).one()
    camp_ids = [str(x) for x in (await ctx.conn.execute(sa.select(t.c.id).where(
        t.c.module == "camps", t.c.entity == "camps", t.c.deleted_at.is_(None), t.c.data["campaign"].astext == campaign_id))).scalars()]
    regs, regs_conv, camp_rev = 0, 0, Decimal(0)
    if camp_ids:
        regs, regs_conv = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.count().filter(t.c.status == "Converted")).where(
            t.c.module == "camps", t.c.entity == "registrations", t.c.deleted_at.is_(None), t.c.data["camp"].astext.in_(camp_ids)))).one()
        camp_rev = _num((await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(
            sa.cast(sa.func.nullif(t.c.data["revenue"].astext, ""), sa.Numeric)), 0)).where(
            t.c.module == "camps", t.c.entity == "conversions", t.c.deleted_at.is_(None), t.c.data["camp"].astext.in_(camp_ids)))).scalar_one())
    await _patch(ctx, "marketing.campaigns", camp, {
        "leads_generated": int(leads[0]) + int(regs), "conversions": int(leads[1]) + int(regs_conv),
        "revenue_attributed": float(_num(leads[2]) + camp_rev),
        "attribution": {"leads": int(leads[0]), "converted_leads": int(leads[1]), "camp_registrations": int(regs),
                        "camp_conversions": int(regs_conv), "camps": len(camp_ids)},
    })


async def _campaign_for_camp(ctx, camp_id: str | None) -> None:
    camp = await get(ctx, "camps.camps", camp_id) if camp_id else None
    if camp and camp.get("campaign"):
        await campaign_attribution(ctx, camp["campaign"])


@hook("crm.leads", "after_create")
@hook("crm.leads", "after_update")
@hook("crm.leads", "after_transition")
async def _lead_changed(ctx, rec: dict, prev: dict | None = None):
    for cid in {rec.get("campaign"), (prev or {}).get("campaign")}:
        await campaign_attribution(ctx, cid)


@hook("camps.conversions", "after_create")
@hook("camps.conversions", "after_update")
async def _conversion_changed(ctx, rec: dict, prev: dict | None = None):
    for cid in {rec.get("camp"), (prev or {}).get("camp")}:
        await _campaign_for_camp(ctx, cid)


@hook("camps.camps", "after_update")
async def _camp_changed(ctx, rec: dict, prev: dict):
    if rec.get("campaign") != prev.get("campaign"):
        for cid in {rec.get("campaign"), prev.get("campaign")}:
            await campaign_attribution(ctx, cid)


# ------------------------------------------------------------------ home care: remote vitals alert level

DEFAULT_RULES: list[tuple[str, str, str, float]] = [
    ("spo2", "Critical", "<", 90), ("spo2", "Warning", "<", 94),
    ("bp_systolic", "Critical", ">=", 180), ("bp_systolic", "Critical", "<", 90),
    ("bp_systolic", "Warning", ">=", 160), ("bp_systolic", "Warning", "<", 100),
    ("bp_diastolic", "Critical", ">=", 120), ("bp_diastolic", "Warning", ">=", 100),
    ("pulse", "Critical", ">", 130), ("pulse", "Critical", "<", 40), ("pulse", "Warning", ">", 110), ("pulse", "Warning", "<", 50),
    ("temperature", "Critical", ">=", 104), ("temperature", "Critical", "<", 95), ("temperature", "Warning", ">=", 100.4),
    ("resp_rate", "Critical", ">", 30), ("resp_rate", "Critical", "<", 8), ("resp_rate", "Warning", ">", 24), ("resp_rate", "Warning", "<", 10),
    ("blood_sugar", "Critical", ">", 400), ("blood_sugar", "Critical", "<", 54),
    ("blood_sugar", "Warning", ">", 250), ("blood_sugar", "Warning", "<", 70),
    ("pain_score", "Warning", ">=", 7),
]
NAMES = [("spo", "spo2"), ("sat", "spo2"), ("sbp", "bp_systolic"), ("systolic", "bp_systolic"), ("dbp", "bp_diastolic"),
         ("diastolic", "bp_diastolic"), ("bp", "bp_systolic"), ("pulse", "pulse"), ("hr", "pulse"), ("heart", "pulse"),
         ("temp", "temperature"), ("rr", "resp_rate"), ("resp", "resp_rate"), ("cbg", "blood_sugar"), ("grbs", "blood_sugar"),
         ("rbs", "blood_sugar"), ("sugar", "blood_sugar"), ("glucose", "blood_sugar"), ("pain", "pain_score")]
LABELS = {"spo2": "SpO₂", "bp_systolic": "SBP", "bp_diastolic": "DBP", "pulse": "Pulse", "temperature": "Temp", "resp_rate": "RR",
          "blood_sugar": "CBG", "pain_score": "Pain"}
COMPARE = re.compile(r"(<=|>=|≤|≥|<|>)\s*(\d+(?:\.\d+)?)")
OPS = {"<": lambda a, b: a < b, "<=": lambda a, b: a <= b, ">": lambda a, b: a > b, ">=": lambda a, b: a >= b}


def parse_thresholds(text: str | None) -> list[tuple[str, str, str, float]]:
    """'SpO₂ < 92%, SBP > 180 or < 90, CBG > 300 or < 70' → doctor-set limits (breach = Critical)."""
    rules = []
    for part in re.split(r"[,;\n]+", text or ""):
        low = part.lower().replace("₂", "2")
        key = next((k for word, k in NAMES if re.search(rf"\b{word}", low)), None)
        if not key:
            continue
        for op, num in COMPARE.findall(low):
            rules.append((key, "Critical", {"≤": "<=", "≥": ">="}.get(op, op), float(num)))
    return rules


def assess(vitals: dict, custom: list[tuple[str, str, str, float]]) -> tuple[str, list[str]]:
    """Worst level breached. The enrolment's own limits replace the default critical limits for that vital."""
    keys_with_custom = {k for k, *_ in custom}
    rules = custom + [r for r in DEFAULT_RULES if r[0] not in keys_with_custom or r[1] == "Warning"]
    rank = {"Normal": 0, "Warning": 1, "Critical": 2}
    level, reasons, flagged = "Normal", [], set()
    for key, lvl, op, limit in rules:  # rules are ordered most severe first per vital
        v = vitals.get(key)
        if v in (None, "") or key in flagged or not OPS[op](float(v), limit):
            continue
        flagged.add(key)
        reasons.append(f"{LABELS.get(key, key)} {float(v):g} {op} {limit:g}")
        if rank[lvl] > rank[level]:
            level = lvl
    return level, reasons


@hook("homecare.remote_vitals", "before_create")
@hook("homecare.remote_vitals", "before_update")
async def _vitals_alert(ctx, nxt: dict, prev: dict | None = None):
    enrol = await get(ctx, "homecare.enrolments", nxt["enrolment"]) if nxt.get("enrolment") else None
    if not enrol and nxt.get("patient_id"):
        found = await find(ctx, "homecare.enrolments", patient_id=nxt["patient_id"], status="Active", limit=1)
        enrol = found[0] if found else None
        if enrol and not nxt.get("enrolment"):
            nxt["enrolment"] = enrol["id"]
    level, reasons = assess(nxt, parse_thresholds((enrol or {}).get("alert_thresholds")))
    nxt["alert_level"], nxt["alert_reasons"] = level, reasons


# ------------------------------------------------------------------ telemedicine & consents

def meeting_link() -> str:
    """Unguessable video room per consult (set TELECONSULT_MEET_BASE for a self-hosted Jitsi / other bridge)."""
    base = os.environ.get("TELECONSULT_MEET_BASE", "https://meet.jit.si").rstrip("/")
    return f"{base}/vlack-{secrets.token_hex(10)}"


@hook("telemedicine.teleconsults", "before_create")
async def _teleconsult_link(ctx, draft: dict):
    if not draft.get("meeting_link"):
        draft["meeting_link"] = meeting_link()


@hook("consents.consents", "before_create")
async def _consent_from_template(ctx, draft: dict):
    tpl = await get(ctx, "consents.templates", draft["template"]) if draft.get("template") else None
    if not tpl:
        raise bad_request("Choose a consent template")
    if tpl.get("status") != "Active":
        raise conflict(f"Template '{tpl.get('name')}' is {tpl.get('status', '').lower()} — use the active version")
    if not draft.get("consent_type"):
        draft["consent_type"] = tpl.get("consent_type")
    draft["template_version"] = tpl.get("version")


# ------------------------------------------------------------------ nightly re-derivation

async def recompute_counters(arq_ctx: dict | None = None) -> dict:
    from ..db import system_ctx

    out = {"campaigns": 0, "camps": 0}
    async with system_ctx() as ctx:
        if has("marketing.campaigns"):
            for c in await find(ctx, "marketing.campaigns", limit=1000):
                await campaign_attribution(ctx, c["id"])
                out["campaigns"] += 1
        if has("camps.camps"):
            for c in await find(ctx, "camps.camps", limit=1000):
                await camp_footfall(ctx, c["id"])
                out["camps"] += 1
    log.info("recomputed front-office counters %s at %s", out, now().isoformat(timespec="seconds"))
    return out


CRON = [(recompute_counters, {"hour": 1, "minute": 30})]

__all__ = ["meeting_link", "assess", "parse_thresholds", "campaign_attribution", "camp_footfall", "estimate_actuals",
           "referral_revenue", "CRON"]
