"""AI Engine (module 53) under AI governance (module 54).

Summarises patient changes, drafts progress notes and discharge summaries, prioritises ward
tasks, detects TAT bottlenecks and operational anomalies, and clusters feedback into themes —
every output is a draft (`ai.drafts`) that a human reviews before it touches the record.

Governance (`aigov.policies`, one per use case) is enforced on every call:
  * Disabled / Prohibited use cases are blocked (403) and the block itself is audited.
  * `allowed_roles` limits who may invoke; `reviewer_roles` limits who may approve or reject.
  * `data_scope` limits which data categories are collected (and therefore sent to a model).
  * `review_required` keeps output in "Pending Review"; only non-clinical use cases whose policy
    says "Suggest" / "Auto-apply with audit" without review are applied immediately.
  * Clinical documentation (summary, progress note, discharge summary) ALWAYS needs review,
    whatever the policy says — a hard safety floor.

Drafting: with settings.anthropic_api_key the engine calls Claude through the official SDK
with a de-identified context (pseudonymous label, age/sex, relative times — no name, UHID,
phone or address) and a system prompt that forbids inventing facts. Without a key, or when
the call fails / times out, deterministic rule-based drafting from the same structured data
is used. Structured outputs (task lists, findings, themes) are always rule-based so they are
reproducible and auditable; the model only writes narrative text. Every generation and review
decision is written to the core audit trail and to `aigov.audit_log`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from statistics import mean, pstdev
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import hook
from ..core.registry import get_entity
from ..core.security import CtxDep
from ..core.util import age_from, bad_request, conflict, forbidden, is_uuid, not_found, now, parse_date, parse_dt, today
from ..modules.clinical.opd import FREQUENCIES
from ..modules.governance.ai import REVIEWER_ROLES, USE_CASES
from ..modules.governance.aigov import DATA_SCOPE
from ..schema import beds, charges, employees, encounters, invoices, orders, patients, payments, records, services
from . import metrics
from ._common import E, create, find, get, has, update

log = logging.getLogger("vlack.ai")
router = APIRouter(prefix="/api/ai", tags=["ai"])

CLINICAL = {"Patient Summary", "Progress Note", "Discharge Summary"}
RULE_MODEL = "vlack-rules-1.0"
LLM_TIMEOUT_S = 45.0
# Models that accept the server-side refusal fallback (`fallbacks: "default"`).
SERVER_FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}
ACTIVE_ENC = ("Admitted", "Discharge Initiated", "Waiting", "In Treatment", "Observation", "Open")


# ====================================================================== small helpers

def _ts(v: Any) -> datetime | None:
    try:
        return parse_dt(v) if v else None
    except (ValueError, TypeError):
        return None


def _clock(v: Any) -> str:
    d = _ts(v)
    return d.astimezone(settings.tz).strftime("%d %b %H:%M") if d else "—"


def _rel(v: Any) -> str | None:
    """Relative time for the model context (absolute dates are quasi-identifiers)."""
    d = _ts(v)
    if not d:
        return None
    h = (now() - d).total_seconds() / 3600
    return f"{h:.1f}h ago" if abs(h) < 48 else f"{h / 24:.1f}d ago"


def _num(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _fmt(v: float | None, nd: int = 0) -> str:
    if v is None:
        return "—"
    return f"{v:.{nd}f}" if nd else (str(int(v)) if float(v).is_integer() else f"{v:.1f}")


def _dur(minutes: float) -> str:
    m = max(0.0, minutes)
    return f"{m:.0f} min" if m < 90 else f"{m / 60:.1f} h" if m < 48 * 60 else f"{m / 1440:.1f} d"


def _clip(s: Any, n: int = 220) -> str:
    t = " ".join(str(s or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def _scrubber(p: dict | None) -> Callable[[str], str]:
    """Remove the patient's direct identifiers from free text before it leaves the record."""
    pats: list[re.Pattern] = [re.compile(r"\b\d{10,14}\b"), re.compile(r"\bUH\d{6,}\b", re.I)]
    for k in ("first_name", "last_name"):
        v = (p or {}).get(k)
        if v and len(str(v)) >= 3:
            pats.append(re.compile(rf"\b{re.escape(str(v))}\b", re.I))

    def scrub(text: str) -> str:
        out = str(text or "")
        for rx in pats:
            out = rx.sub("[redacted]", out)
        return out

    return scrub


def _hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


# ====================================================================== data access

async def _recs(ctx, fqn: str, *, patient_ids: list[str] | None = None, encounter_id: str | None = None,
                status: list[str] | None = None, since: datetime | None = None, date_key: str | None = None,
                where: dict | None = None, limit: int = 3000) -> list[dict]:
    """Bulk read of any entity (engine-internal, no access check) with a coarse date filter."""
    ent = get_entity(fqn)
    if not ent:
        return []
    t = ent.table
    conds = rs.base_where(ent)
    if patient_ids is not None:
        if not patient_ids:
            return []
        conds.append(t.c.patient_id.in_(patient_ids))
    if encounter_id:
        conds.append(t.c.encounter_id == encounter_id)
    if status:
        conds.append(t.c.status.in_(status))
    dk = date_key or ent.date_field
    if since and dk:
        col = rs.col_expr(ent, dk)
        if dk in ent.physical:
            conds.append(col >= since)
        else:
            conds.append(col >= since.date().isoformat())
    for k, v in (where or {}).items():
        conds.append(rs.eq_cond(ent, k, v))
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(t.c.created_at.desc()).limit(limit))).all()
    out = [rs.to_record(r) for r in rows]
    if since and dk:
        out = [r for r in out if (_ts(r.get(dk)) or _ts(r.get("created_at")) or now()) >= since]
    if out:
        refs = await rs.resolve_refs(ctx, ent, out)
        for r in out:
            r["_refs"] = refs
    return out


async def _patient(ctx, pid: str) -> dict:
    if not is_uuid(pid):
        raise not_found("Patient not found")
    row = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid, patients.c.deleted_at.is_(None)))).first()
    if not row:
        raise not_found("Patient not found")
    p = rs.to_record(row)
    p["age"] = age_from(p.get("dob"))
    return p


async def _enc_info(ctx, eid: str) -> dict:
    if not is_uuid(eid):
        raise not_found("Encounter not found")
    w, d = records.alias("w"), records.alias("d")
    stmt = (
        sa.select(encounters, beds.c.bed_no, beds.c.category.label("bed_category"), beds.c.ward_id,
                  w.c.title.label("ward"), w.c.data["ward_type"].astext.label("ward_type"),
                  d.c.title.label("department"), employees.c.name.label("doctor"))
        .select_from(encounters.outerjoin(beds, beds.c.id == encounters.c.bed_id)
                     .outerjoin(w, w.c.id == beds.c.ward_id)
                     .outerjoin(d, d.c.id == encounters.c.department_id)
                     .outerjoin(employees, employees.c.id == encounters.c.doctor_id))
        .where(encounters.c.id == eid, encounters.c.deleted_at.is_(None))
    )
    row = (await ctx.conn.execute(stmt)).first()
    if not row:
        raise not_found("Encounter not found")
    e = rs.to_record(row)
    start = _ts(e.get("started_at"))
    e["day"] = ((today() - start.astimezone(settings.tz).date()).days + 1) if start else None
    return e


async def _active_encounter(ctx, pid: str) -> dict | None:
    row = (await ctx.conn.execute(
        sa.select(encounters.c.id).where(encounters.c.patient_id == pid, encounters.c.deleted_at.is_(None),
                                         encounters.c.status.in_(ACTIVE_ENC))
        .order_by(encounters.c.started_at.desc().nulls_last()).limit(1))).first()
    return await _enc_info(ctx, str(row.id)) if row else None


async def _orders(ctx, *, patient_ids: list[str], encounter_id: str | None = None, since: datetime | None = None) -> list[dict]:
    o = orders
    conds = [o.c.deleted_at.is_(None), o.c.patient_id.in_(patient_ids), o.c.status != "Cancelled"]
    if encounter_id:
        conds.append(o.c.encounter_id == encounter_id)
    if since:
        conds.append(sa.or_(o.c.ordered_at >= since, o.c.resulted_at >= since, o.c.verified_at >= since,
                            o.c.status.in_(["Ordered", "Collected", "In Progress"])))
    stmt = (sa.select(o, services.c.title.label("service_name"), services.c.tat_minutes.label("service_tat"))
            .select_from(o.outerjoin(services, services.c.id == o.c.service_id)).where(*conds)
            .order_by(o.c.ordered_at.asc().nulls_last()).limit(1000))
    return [rs.to_record(r) for r in (await ctx.conn.execute(stmt)).all()]


async def _names(ctx, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(employees.c.id, employees.c.name).where(employees.c.id.in_(list(ids))))).all()
    return {str(r.id): r.name for r in rows}


# ====================================================================== clinical interpretation

VITAL_PARAMS = [("pulse", "HR", "bpm"), ("resp_rate", "RR", "/min"), ("spo2", "SpO2", "%"), ("temperature", "Temp", "°F"),
                ("bp_systolic", "SBP", "mmHg"), ("bp_diastolic", "DBP", "mmHg"), ("pain_score", "Pain", "/10"),
                ("gcs", "GCS", ""), ("blood_sugar", "CBG", "mg/dL")]


def news2(v: dict) -> int | None:
    """NEWS2 (RCP 2017, SpO2 scale 1). GCS < 15 is treated as new confusion (ACVPU 'C')."""
    rr, spo2, sbp, hr = _num(v.get("resp_rate")), _num(v.get("spo2")), _num(v.get("bp_systolic")), _num(v.get("pulse"))
    temp_f, gcs = _num(v.get("temperature")), _num(v.get("gcs"))
    if sum(x is not None for x in (rr, spo2, sbp, hr, temp_f)) < 3:
        return None
    s = 0
    if rr is not None:
        s += 3 if rr <= 8 else 1 if rr <= 11 else 0 if rr <= 20 else 2 if rr <= 24 else 3
    if spo2 is not None:
        s += 3 if spo2 <= 91 else 2 if spo2 <= 93 else 1 if spo2 <= 95 else 0
    if v.get("o2_support") and v.get("o2_support") != "Room air":
        s += 2
    if sbp is not None:
        s += 3 if sbp <= 90 else 2 if sbp <= 100 else 1 if sbp <= 110 else 0 if sbp <= 219 else 3
    if hr is not None:
        s += 3 if hr <= 40 else 1 if hr <= 50 else 0 if hr <= 90 else 1 if hr <= 110 else 2 if hr <= 130 else 3
    if gcs is not None and gcs < 15:
        s += 3
    if temp_f is not None:
        c = (temp_f - 32) * 5 / 9 if temp_f > 45 else temp_f
        s += 3 if c <= 35.0 else 1 if c <= 36.0 else 0 if c <= 38.0 else 1 if c <= 39.0 else 2
    return s


def _news(v: dict) -> int | None:
    n = _num(v.get("news2"))
    return int(n) if n is not None else news2(v)


def vital_flags(v: dict) -> list[str]:
    f = []
    hr, sbp, rr, spo2, t, cbg = (_num(v.get(k)) for k in ("pulse", "bp_systolic", "resp_rate", "spo2", "temperature", "blood_sugar"))
    if hr is not None and (hr > 120 or hr < 50):
        f.append(f"HR {_fmt(hr)}")
    if sbp is not None and (sbp < 90 or sbp > 180):
        f.append(f"SBP {_fmt(sbp)}")
    if rr is not None and (rr > 24 or rr < 10):
        f.append(f"RR {_fmt(rr)}")
    if spo2 is not None and spo2 < 92:
        f.append(f"SpO2 {_fmt(spo2)}%")
    if t is not None and (t >= 100.4 or t < 96):
        f.append(f"Temp {_fmt(t, 1)}°F")
    if cbg is not None and (cbg < 70 or cbg > 300):
        f.append(f"CBG {_fmt(cbg)}")
    n = _news(v)
    if n is not None and n >= 5:
        f.append(f"NEWS2 {n}")
    return f


# Clinically meaningful change per parameter (absolute units) before a trend arrow is shown.
TREND_DELTA = {"HR": 8, "RR": 3, "SpO2": 2, "Temp": 0.5, "SBP": 10, "DBP": 8, "Pain": 2, "GCS": 1, "CBG": 30}


def _trend(label: str, series: list[float]) -> str:
    if len(series) < 2:
        return ""
    ch = series[-1] - series[0]
    lim = TREND_DELTA.get(label, abs(series[0]) * 0.1 or 1)
    return "↑" if ch >= lim else "↓" if ch <= -lim else "→"


def vitals_digest(rows: list[dict]) -> dict:
    """Latest reading, 24 h range and trend per parameter."""
    rows = sorted(rows, key=lambda r: _ts(r.get("recorded_at")) or now())
    if not rows:
        return {}
    latest = rows[-1]
    out: dict[str, Any] = {"readings": len(rows), "latest_at": latest.get("recorded_at"), "params": {}}
    for k, label, unit in VITAL_PARAMS:
        vals = [_num(r.get(k)) for r in rows if _num(r.get(k)) is not None]
        if not vals:
            continue
        out["params"][label] = {"latest": vals[-1], "min": min(vals), "max": max(vals), "trend": _trend(label, vals), "unit": unit}
    out["o2_support"] = latest.get("o2_support")
    out["news2"] = _news(latest)
    out["flags"] = vital_flags(latest)
    return out


def vitals_line(dig: dict) -> str:
    if not dig:
        return "No vitals recorded."
    p = dig["params"]
    parts = []
    for label in ("HR", "RR", "SpO2", "Temp", "Pain", "GCS", "CBG"):
        if label in p:
            x = p[label]
            nd = 1 if label == "Temp" else 0
            rng = f" ({_fmt(x['min'], nd)}–{_fmt(x['max'], nd)})" if x["min"] != x["max"] else ""
            parts.append(f"{label} {_fmt(x['latest'], nd)}{x['unit'] if label in ('SpO2',) else ''}{x['trend']}{rng}")
    if "SBP" in p:
        bp = f"BP {_fmt(p['SBP']['latest'])}/{_fmt(p['DBP']['latest']) if 'DBP' in p else '—'}{p['SBP']['trend']}"
        parts.insert(1, bp)
    if dig.get("o2_support"):
        parts.append(f"on {dig['o2_support']}")
    if dig.get("news2") is not None:
        n = dig["news2"]
        parts.append(f"NEWS2 {n} ({'high' if n >= 7 else 'medium' if n >= 5 else 'low-medium' if n >= 1 else 'low'} risk)")
    return ", ".join(parts)


def result_line(o: dict) -> str:
    name = o.get("service_name") or o.get("title") or "Test"
    vals = o.get("result_values") or []
    abn = [f"{v.get('parameter')} {v.get('value')}{(' ' + v['unit']) if v.get('unit') else ''} ({v.get('flag')})"
           for v in vals if v.get("flag") and v.get("flag") != "Normal"]
    crit = " — CRITICAL" + (", acknowledged" if o.get("acknowledged_at") else ", NOT acknowledged") if o.get("critical") else ""
    if abn:
        return f"{name}: {'; '.join(abn[:6])}{crit}"
    if o.get("impression") or o.get("result"):
        return f"{name}: {_clip(o.get('impression') or o.get('result'), 160)}{crit}"
    return f"{name}: all parameters within reference range{crit}" if vals else f"{name}: resulted{crit}"


def _rx_lines(rxs: list[dict]) -> list[dict]:
    """Flatten active prescriptions into medication lines with resolved drug names."""
    out = []
    for rx in rxs:
        refs = rx.get("_refs") or {}
        for it in rx.get("items") or []:
            if not it.get("drug"):
                continue
            out.append({"drug": it["drug"], "name": refs.get(it["drug"], "Drug"), "dose": it.get("dose"), "route": it.get("route"),
                        "frequency": it.get("frequency"), "duration_days": it.get("duration_days"), "instructions": it.get("instructions"),
                        "prescribed_at": rx.get("prescribed_at")})
    return out


def _med_text(m: dict) -> str:
    bits = [m["name"], m.get("dose"), m.get("route"), m.get("frequency")]
    s = " ".join(str(b) for b in bits if b)
    if m.get("duration_days"):
        s += f" × {_fmt(_num(m['duration_days']))} days"
    return s


# ====================================================================== generation plumbing

@dataclass
class Gen:
    """What a use-case builder produces before the drafting step."""
    context: dict                        # de-identified, scope-limited data (what a model would see)
    draft: str                           # rule-based text
    categories: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    output: dict = field(default_factory=dict)   # structured payload applied on approval
    target: str | None = None
    confidence: float = 60.0
    instructions: str = ""               # use-case-specific instructions for the model


@dataclass
class LlmResult:
    ok: bool = False
    text: str = ""
    model: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    latency_ms: int | None = None
    error: str | None = None


class PolicyBlocked(Exception):
    pass


async def policy_for(ctx, use_case: str) -> dict | None:
    rows = await find(ctx, "aigov.policies", use_case=use_case, limit=10, sort="-updated_at")
    active = [r for r in rows if r.get("status") == "Active"]
    return (active or rows or [None])[0]


def _check_policy(ctx, use_case: str, pol: dict | None) -> None:
    if not pol:
        raise PolicyBlocked(f"No AI policy is defined for '{use_case}'. Ask Quality to configure one in AI Governance.")
    if pol.get("status") != "Active":
        raise PolicyBlocked(f"'{use_case}' is disabled by AI policy {pol.get('code')}.")
    if pol.get("risk_class") == "Prohibited":
        raise PolicyBlocked(f"'{use_case}' is classed as Prohibited by AI policy {pol.get('code')}.")
    allowed = pol.get("allowed_roles") or []
    if allowed:
        if ctx.role != "admin" and ctx.role not in allowed:
            raise PolicyBlocked(f"Your role may not invoke '{use_case}' (policy {pol.get('code')}).")
    else:
        rs.ensure_access(ctx, E("ai.drafts"), "write")


def _scope(pol: dict) -> set[str]:
    # An unconfigured scope means the policy author did not restrict categories.
    return set(pol.get("data_scope") or DATA_SCOPE)


async def _ai_log(ctx, event: str, use_case: str, *, policy: dict | None = None, draft: dict | None = None,
                  patient_id: str | None = None, model: str | None = None, categories: list[str] | None = None,
                  input_hash: str | None = None, excerpt: str | None = None, llm: LlmResult | None = None) -> None:
    if not has("aigov.audit_log"):
        return
    await create(ctx, "aigov.audit_log", {
        "occurred_at": now().isoformat(timespec="seconds"), "event": event, "use_case": use_case,
        "draft": draft["id"] if draft else None, "policy": policy["id"] if policy else None,
        "risk_class": (policy or {}).get("risk_class"), "model": model, "actor": ctx.user.get("employee_id"),
        "actor_role": ctx.role, "data_categories": categories or None, "input_hash": input_hash,
        "output_excerpt": _clip(excerpt, 500) if excerpt else None,
        "tokens_in": llm.tokens_in if llm else None, "tokens_out": llm.tokens_out if llm else None,
        "latency_ms": llm.latency_ms if llm else None, "ip_address": ctx.ip,
        "patient_id": patient_id or (draft or {}).get("patient_id"),
    })


async def _active_template(ctx, use_case: str) -> dict | None:
    rows = await find(ctx, "ai.prompts", use_case=use_case, status="Active", limit=5, sort="-updated_at")
    return rows[0] if rows else None


# ---------------------------------------------------------------------- LLM

SYSTEM_PROMPT = (
    "You draft clinical and operational documents for staff of an Indian multispecialty hospital (NABH-accredited). "
    "Every draft is reviewed and edited by a qualified clinician or manager before it is used; say nothing that "
    "suggests otherwise.\n"
    "Rules:\n"
    "1. Use ONLY facts present in the JSON context. Never invent findings, diagnoses, doses, dates, results or plans.\n"
    "2. When something a reader would expect is missing, write a bracketed prompt such as [Not documented — clinician to complete].\n"
    "3. The patient is identified only by a pseudonymous label. Do not guess or add identifiers.\n"
    "4. Times in the context are relative (e.g. '5.0h ago'); keep them relative.\n"
    "5. Use the section headings requested, in plain text (no Markdown tables), concise clinical English, "
    "SI / Indian units as given (temperature in °F, money in ₹).\n"
    "6. Flag critical or abnormal values first. Do not give treatment recommendations beyond what is documented."
)

_client = None


def _anthropic():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key, timeout=LLM_TIMEOUT_S, max_retries=1)
    return _client


def _llm_allowed(pol: dict) -> tuple[bool, str | None]:
    if not settings.anthropic_api_key:
        return False, None
    approved = [m.strip() for m in (pol.get("approved_models") or []) if m]
    if approved and settings.ai_model not in approved:
        return False, f"{settings.ai_model} is not an approved model for this use case; rule-based draft used."
    if pol.get("consent_required"):
        return False, "Policy requires patient consent before data leaves the hospital; rule-based draft used."
    return True, None


async def llm_draft(use_case: str, gen: Gen, template: dict | None) -> LlmResult:
    import anthropic

    instructions = gen.instructions
    if template:
        instructions += f"\n\nHospital template '{template.get('name')}' v{template.get('version')}:\n{template.get('instructions')}"
        if template.get("max_words"):
            instructions += f"\nKeep it under {int(template['max_words'])} words."
    user = (f"Task: {use_case}.\n{instructions}\n\nContext (JSON):\n"
            f"{json.dumps(gen.context, ensure_ascii=False, sort_keys=True, default=str)}")
    kwargs: dict[str, Any] = {
        "model": settings.ai_model, "max_tokens": 8000, "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user}], "output_config": {"effort": "medium"},
    }
    if settings.ai_model in SERVER_FALLBACK_MODELS:
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    t0 = time.perf_counter()
    try:
        resp = await _anthropic().beta.messages.create(**kwargs)
    except anthropic.APITimeoutError:
        return LlmResult(error=f"model timed out after {LLM_TIMEOUT_S:.0f}s")
    except anthropic.RateLimitError:
        return LlmResult(error="model rate-limited")
    except anthropic.APIStatusError as e:
        log.warning("AI %s: model API error %s %s", use_case, e.status_code, e.message)
        return LlmResult(error=f"model API error {e.status_code}")
    except anthropic.APIConnectionError:
        return LlmResult(error="could not reach the model service")
    latency = int((time.perf_counter() - t0) * 1000)
    if resp.stop_reason == "refusal":
        return LlmResult(error="model declined the request", latency_ms=latency)
    if resp.stop_reason == "max_tokens":
        return LlmResult(error="model output was truncated", latency_ms=latency)
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if not text:
        return LlmResult(error="model returned no text", latency_ms=latency)
    return LlmResult(ok=True, text=text, model=resp.model, tokens_in=resp.usage.input_tokens,
                     tokens_out=resp.usage.output_tokens, latency_ms=latency)


# ---------------------------------------------------------------------- run a use case

async def _blocked(ctx, use_case: str, pol: dict | None, message: str, patient_id: str | None) -> JSONResponse:
    await audit(ctx, "ai.blocked", module="ai", entity="drafts", record={"patient_id": patient_id},
                after={"use_case": use_case, "policy": (pol or {}).get("code")}, note=message)
    await _ai_log(ctx, "Blocked by policy", use_case, policy=pol, patient_id=patient_id, excerpt=message)
    # Returned (not raised) so the audit rows above are committed with the response.
    return JSONResponse({"message": message, "code": "AI_POLICY_BLOCKED"}, status_code=403)


async def run_use_case(ctx, use_case: str, build: Callable[[set[str]], Awaitable[Gen]], *,
                       patient_id: str | None = None, encounter_id: str | None = None):
    pol = await policy_for(ctx, use_case)
    try:
        _check_policy(ctx, use_case, pol)
    except PolicyBlocked as b:
        return await _blocked(ctx, use_case, pol, str(b), patient_id)
    gen = await build(_scope(pol))
    text, source, model, llm, notices = gen.draft, "Rule-based", RULE_MODEL, None, []
    use_llm, why = _llm_allowed(pol)
    if why:
        notices.append(why)
    template = await _active_template(ctx, use_case)
    if use_llm:
        llm = await llm_draft(use_case, gen, template)
        if llm.ok:
            text, source, model = llm.text, "LLM", llm.model or settings.ai_model
        else:
            notices.append(f"Model unavailable ({llm.error}); rule-based draft used.")
    review = bool(pol.get("review_required", True)) or use_case in CLINICAL or pol.get("ai_may") == "Draft only"
    status = "Pending Review" if review else "Approved"
    h = _hash(gen.context)
    draft = await create(ctx, "ai.drafts", {
        "draft_type": use_case, "source": source, "model": model, "policy": pol["id"], "content": text[:20000],
        "context_summary": "; ".join(gen.sources)[:2000] or "No records in scope", "target": gen.target,
        "confidence": round(gen.confidence, 0), "requested_by": ctx.user.get("employee_id"),
        "patient_id": patient_id, "encounter_id": encounter_id, "status": status,
        "context": gen.context, "output": gen.output, "generated_text": text[:20000], "input_hash": h,
        "data_categories": gen.categories, "notice": " ".join(notices) or None,
        "prompt_template": template.get("code") if template and source == "LLM" else None,
        "risk_class": pol.get("risk_class"),
    })
    await audit(ctx, "ai.generate", module="ai", entity="drafts", record=draft,
                after={"use_case": use_case, "source": source, "model": model, "status": status, "categories": gen.categories,
                       "input_hash": h, "tokens_in": llm.tokens_in if llm else None, "tokens_out": llm.tokens_out if llm else None})
    await _ai_log(ctx, "Generated", use_case, policy=pol, draft=draft, model=model, categories=gen.categories,
                  input_hash=h, excerpt=text, llm=llm if source == "LLM" else None)
    applied = None
    if status == "Approved":
        applied = await apply_draft(ctx, draft)
        draft = await update(ctx, "ai.drafts", draft["id"], {"reviewed_at": now().isoformat(timespec="seconds"),
                                                             "review_notes": "Auto-applied under AI policy (no review required)",
                                                             "applied_target": applied})
        await _ai_log(ctx, "Auto-applied", use_case, policy=pol, draft=draft, model=model, categories=gen.categories,
                      input_hash=h, excerpt=applied)
    return {"draft": _public(draft), "context": gen.context, "output": gen.output, "applied": applied,
            "review_required": review, "notice": " ".join(notices) or None}


def _public(d: dict, full: bool = True) -> dict:
    out = {k: v for k, v in d.items() if k != "_refs"}
    if not full:
        out.pop("context", None)
        out.pop("output", None)
        out.pop("generated_text", None)
    return out


# ====================================================================== use case: patient summary

async def build_patient_summary(ctx, pid: str, scope: set[str]) -> Gen:
    p = await _patient(ctx, pid)
    scrub = _scrubber(p)
    since = now() - timedelta(hours=24)
    enc = await _active_encounter(ctx, pid)
    cats: list[str] = []
    ctxd: dict[str, Any] = {"patient": {"label": "Patient A"}, "window": "last 24 hours"}
    lines: list[str] = []
    sources: list[str] = []
    alerts: list[str] = []
    head = "24-hour summary"
    if "Demographics" in scope:
        cats.append("Demographics")
        ctxd["patient"].update(age=p.get("age"), sex=p.get("gender"))
        head += f" — {p.get('age') if p.get('age') is not None else '?'}y {p.get('gender') or ''}".rstrip()
        if enc:
            ctxd["encounter"] = {"type": enc.get("type"), "day": enc.get("day"), "ward_type": enc.get("ward_type"),
                                 "department": enc.get("department"), "status": enc.get("status")}
            head += f", {enc.get('type')} day {enc.get('day')}" + (f" ({enc.get('ward')})" if enc.get("ward") else "")
    if "Notes" in scope and enc and enc.get("diagnosis"):
        ctxd.setdefault("encounter", {})["admission_diagnosis"] = enc["diagnosis"]
        head += f", admitted for {enc['diagnosis']}"
    lines.append(head + ".")

    if "Medications" in scope:
        cats.append("Medications")
        allergies = list(p.get("allergies") or [])
        for a in await _recs(ctx, "emr.allergies", patient_ids=[pid], status=["Active"]):
            if a.get("allergen") and a["allergen"] not in allergies:
                allergies.append(a["allergen"])
        ctxd["allergies"] = allergies
        if allergies:
            alerts.append(f"Allergy: {', '.join(allergies)}")

    if "Vitals" in scope:
        cats.append("Vitals")
        vit = await _recs(ctx, "emr.vitals", patient_ids=[pid], since=since, status=["Recorded"])
        dig = vitals_digest(vit)
        ctxd["vitals"] = {**dig, "latest_at": _rel(dig.get("latest_at"))} if dig else {"readings": 0}
        sources.append(f"{len(vit)} vitals")
        lines.append("")
        lines.append(f"VITALS ({len(vit)} readings{', latest ' + _clock(dig.get('latest_at')) if dig else ''})")
        lines.append(f"• {vitals_line(dig)}")
        if dig.get("flags"):
            alerts.append(f"Abnormal vitals: {', '.join(dig['flags'])}")

    if "Orders & Results" in scope:
        cats.append("Orders & Results")
        ords = await _orders(ctx, patient_ids=[pid], since=since)
        resulted = [o for o in ords if (_ts(o.get("resulted_at")) or _ts(o.get("verified_at")) or datetime.min.replace(tzinfo=settings.tz)) >= since
                    and o.get("status") in ("Resulted", "Verified")]
        new = [o for o in ords if (_ts(o.get("ordered_at")) or since) >= since]
        pending = [o for o in ords if o.get("status") in ("Ordered", "Collected", "In Progress")]
        crit = [o for o in ords if o.get("critical") and not o.get("acknowledged_at")]
        for o in crit:
            alerts.insert(0, f"Critical result NOT acknowledged: {result_line(o)}")
        ctxd["results"] = [{"test": o.get("service_name"), "status": o.get("status"), "critical": bool(o.get("critical")),
                            "acknowledged": bool(o.get("acknowledged_at")), "resulted": _rel(o.get("resulted_at")),
                            "values": [{k: v.get(k) for k in ("parameter", "value", "unit", "flag")} for v in (o.get("result_values") or [])],
                            "impression": o.get("impression")} for o in resulted]
        ctxd["new_orders"] = [{"test": o.get("service_name"), "category": o.get("category"), "priority": o.get("priority"),
                               "status": o.get("status"), "ordered": _rel(o.get("ordered_at"))} for o in new]
        ctxd["pending_orders"] = len(pending)
        sources.append(f"{len(resulted)} results, {len(new)} new orders")
        lines += ["", f"NEW RESULTS ({len(resulted)})"]
        lines += [f"• {result_line(o)}" for o in resulted] or ["• None in the last 24 h."]
        lines += ["", f"NEW ORDERS ({len(new)}) · {len(pending)} pending overall"]
        lines += [f"• {o.get('service_name') or o.get('category')} ({o.get('priority') or 'Routine'}) — {o.get('status')}" for o in new] or ["• None."]

    if "Medications" in scope:
        rxs = await _recs(ctx, "opd.prescriptions", patient_ids=[pid], status=["Active", "Partially Dispensed"])
        meds = _rx_lines(rxs)
        mar = await _recs(ctx, "nursing.mar", patient_ids=[pid], since=since)
        mar_by = Counter(m.get("status") for m in mar)
        new_meds = [m for m in meds if (_ts(m.get("prescribed_at")) or since) >= since]
        ctxd["medications"] = {"active": [_med_text(m) for m in meds], "started_last_24h": [_med_text(m) for m in new_meds],
                               "mar_counts": dict(mar_by)}
        sources.append(f"{len(meds)} active medicines, {len(mar)} MAR entries")
        lines += ["", f"MEDICATIONS ({len(meds)} active)"]
        lines += [f"• {_med_text(m)}{' — NEW' if m in new_meds else ''}" for m in meds[:15]] or ["• No active prescriptions."]
        if mar:
            lines.append("• MAR (24 h): " + ", ".join(f"{n} {s.lower()}" for s, n in mar_by.items()))
            missed = [m for m in mar if m.get("status") in ("Held", "Refused", "Missed")]
            for m in missed[:5]:
                lines.append(f"  – {(m.get('_refs') or {}).get(m.get('drug'), 'Dose')} {m.get('status').lower()} at {_clock(m.get('scheduled_at'))}"
                             + (f" ({m.get('held_reason')})" if m.get("held_reason") else ""))

    if "Notes" in scope:
        cats.append("Notes")
        notes = await _recs(ctx, "emr.notes", patient_ids=[pid], since=since)
        notes.sort(key=lambda n: _ts(n.get("noted_at")) or now())
        names = await _names(ctx, {n.get("author") for n in notes})
        ctxd["notes"] = [{"type": n.get("note_type"), "at": _rel(n.get("noted_at")), "status": n.get("status"),
                          "text": _clip(scrub(n.get("note")), 600)} for n in notes]
        sources.append(f"{len(notes)} notes")
        lines += ["", f"NOTES ({len(notes)})"]
        lines += [f"• {n.get('note_type') or 'Note'} by {names.get(n.get('author'), 'staff')} at {_clock(n.get('noted_at'))}: "
                  f"“{_clip(scrub(n.get('note')), 180)}”" for n in notes[-6:]] or ["• No notes in the last 24 h."]

    if alerts:
        lines[1:1] = ["", "ALERTS"] + [f"• {a}" for a in alerts]
    lines += ["", "AI draft generated from structured data for clinician review — verify before relying on it."]
    filled = sum(1 for k in ("vitals", "results", "medications", "notes") if ctxd.get(k))
    return Gen(context=ctxd, draft="\n".join(lines), categories=cats, sources=sources, target=f"registration.patients:{pid}",
               confidence=40 + 15 * filled, output={"alerts": alerts},
               instructions="Write a concise 24-hour change summary with headings ALERTS, VITALS, NEW RESULTS, NEW ORDERS, "
                            "MEDICATIONS, NOTES. Lead with anything critical or deteriorating.")


# ====================================================================== use case: progress note (SOAP)

async def build_progress_note(ctx, eid: str, scope: set[str]) -> Gen:
    enc = await _enc_info(ctx, eid)
    pid = str(enc["patient_id"])
    p = await _patient(ctx, pid)
    scrub = _scrubber(p)
    last_pn = [n for n in await _recs(ctx, "emr.notes", encounter_id=eid, where={"note_type": "Progress Note"})
               if n.get("status") in ("Signed", "Amended")]
    last_at = max((_ts(n.get("noted_at")) for n in last_pn if _ts(n.get("noted_at"))), default=None)
    since = max(last_at or now() - timedelta(hours=24), now() - timedelta(hours=72))
    cats, sources = [], []
    ctxd: dict[str, Any] = {"patient": {"label": "Patient A"}, "since_last_progress_note": _rel(since)}
    subj, obj, assess, plan = [], [], [], []
    if "Demographics" in scope:
        cats.append("Demographics")
        ctxd["patient"].update(age=p.get("age"), sex=p.get("gender"))
        ctxd["encounter"] = {"type": enc.get("type"), "day": enc.get("day"), "ward_type": enc.get("ward_type"), "status": enc.get("status")}
    if "Notes" in scope:
        cats.append("Notes")
        probs = await _recs(ctx, "emr.problems", patient_ids=[pid], status=["Active"])
        ctxd["admission_diagnosis"] = enc.get("diagnosis")
        ctxd["active_problems"] = [x.get("problem") for x in probs if x.get("problem")]
        dx = enc.get("diagnosis") or "[admission diagnosis not documented]"
        assess.append(f"Day {enc.get('day') or '?'} of {enc.get('type') or ''} stay for {dx}.".replace("  ", " "))
        if ctxd["active_problems"]:
            assess.append("Active problems: " + "; ".join(ctxd["active_problems"][:8]) + ".")
        nn = [n for n in await _recs(ctx, "emr.notes", encounter_id=eid, since=since) if n.get("note_type") == "Nursing Note"]
        nn.sort(key=lambda n: _ts(n.get("noted_at")) or now())
        ctxd["nursing_notes"] = [{"at": _rel(n.get("noted_at")), "text": _clip(scrub(n.get("note")), 400)} for n in nn[-4:]]
        for n in nn[-2:]:
            subj.append(f"Nursing ({_clock(n.get('noted_at'))}): “{_clip(scrub(n.get('note')), 200)}”")
        sources.append(f"{len(probs)} problems, {len(nn)} nursing notes")
    subj.insert(0, "[Patient-reported symptoms — clinician to document at the bedside.]")
    if "Vitals" in scope:
        cats.append("Vitals")
        vit = await _recs(ctx, "emr.vitals", patient_ids=[pid], since=since, status=["Recorded"])
        dig = vitals_digest(vit)
        ctxd["vitals"] = {**dig, "latest_at": _rel(dig.get("latest_at"))} if dig else {"readings": 0}
        obj.append(f"Vitals ({len(vit)} readings): {vitals_line(dig)}.")
        if dig.get("params", {}).get("Pain"):
            subj.append(f"Pain score {_fmt(dig['params']['Pain']['latest'])}/10 (range {_fmt(dig['params']['Pain']['min'])}–{_fmt(dig['params']['Pain']['max'])}).")
        tmax = dig.get("params", {}).get("Temp", {}).get("max")
        if tmax and tmax >= 100.4:
            assess.append(f"Febrile in this period (max {_fmt(tmax, 1)} °F).")
        if dig.get("flags"):
            assess.append("Abnormal vitals: " + ", ".join(dig["flags"]) + ".")
        io = await _recs(ctx, "nursing.io_charts", patient_ids=[pid], since=since)
        if io:
            ti = sum(_num(r.get("total_intake")) or 0 for r in io)
            to = sum(_num(r.get("total_output")) or 0 for r in io)
            ctxd["intake_output_ml"] = {"intake": ti, "output": to, "balance": ti - to}
            obj.append(f"Intake/output: {ti:.0f} / {to:.0f} ml (balance {ti - to:+.0f} ml).")
        sources.append(f"{len(vit)} vitals, {len(io)} I/O entries")
    obj.append("[Examination findings — clinician to document.]")
    pending: list[dict] = []
    if "Orders & Results" in scope:
        cats.append("Orders & Results")
        ords = await _orders(ctx, patient_ids=[pid], encounter_id=eid, since=since)
        resulted = [o for o in ords if o.get("status") in ("Resulted", "Verified") and (_ts(o.get("resulted_at")) or now()) >= since]
        pending = [o for o in ords if o.get("status") in ("Ordered", "Collected", "In Progress")]
        ctxd["results"] = [{"test": o.get("service_name"), "critical": bool(o.get("critical")),
                            "values": [{k: v.get(k) for k in ("parameter", "value", "unit", "flag")} for v in (o.get("result_values") or [])],
                            "impression": o.get("impression")} for o in resulted]
        ctxd["pending"] = [{"test": o.get("service_name"), "status": o.get("status"), "ordered": _rel(o.get("ordered_at"))} for o in pending]
        for o in resulted:
            obj.append(f"Result — {result_line(o)}")
        for o in [o for o in resulted if o.get("critical")]:
            assess.append(f"Critical result: {result_line(o)}.")
        sources.append(f"{len(resulted)} results, {len(pending)} pending orders")
    if "Medications" in scope:
        cats.append("Medications")
        meds = _rx_lines(await _recs(ctx, "opd.prescriptions", patient_ids=[pid], status=["Active", "Partially Dispensed"]))
        ctxd["active_medications"] = [_med_text(m) for m in meds]
        if meds:
            plan.append("Continue current medications: " + "; ".join(_med_text(m) for m in meds[:12]) + ". [Review and adjust.]")
        sources.append(f"{len(meds)} active medicines")
    if pending:
        plan.append("Follow up pending investigations: " + ", ".join(f"{o.get('service_name')} ({o.get('status')})" for o in pending[:10]) + ".")
    if enc.get("status") == "Discharge Initiated":
        plan.append("Discharge initiated — complete discharge summary, medication reconciliation and billing clearance.")
    plan.append("[Plan to be confirmed by the treating clinician.]")
    text = "\n".join([
        f"PROGRESS NOTE (SOAP) — AI draft for clinician review · covers {_clock(since)} to {_clock(now())}",
        "", "S:", *[f"• {x}" for x in subj], "", "O:", *[f"• {x}" for x in obj], "", "A:", *[f"• {x}" for x in assess or ['[Assessment — clinician to document.]']],
        "", "P:", *[f"• {x}" for x in plan],
    ])
    return Gen(context=ctxd, draft=text, categories=cats, sources=sources, target=f"ipd.encounters:{eid}",
               confidence=35 + 10 * len(cats), output={"encounter_id": eid, "patient_id": pid},
               instructions="Write a SOAP progress note with the headings S:, O:, A:, P: (in that order). Keep bracketed "
                            "placeholders for anything that must be examined or decided at the bedside.")


# ====================================================================== use case: discharge summary

DX_ADVICE = [
    (("diabet", "dm "), "Diabetic diet: avoid sugar and refined carbohydrates; small frequent meals.", "Check capillary blood sugar as advised."),
    (("ckd", "renal", "kidney", "hd"), "Renal diet: restrict salt, potassium-rich fruits and fluids as advised.", "Follow the dialysis schedule."),
    (("coronary", "acs", "cardiac", "heart", "hypertens", "mi "), "Low-salt, low-fat diet.", "Avoid exertion until review; no driving for 1 week."),
    (("fracture", "femur", "appendic", "surgery", "post-op"), "Normal diet with adequate protein.", "Mobilise as taught by the physiotherapist; keep the wound dry."),
    (("dengue",), "Oral fluids 2.5–3 L/day; avoid NSAIDs.", "Rest; avoid strenuous activity for 2 weeks."),
    (("pneumonia", "copd", "asthma"), "Normal diet; adequate fluids.", "Breathing exercises; avoid smoke and dust."),
    (("gastroenteritis",), "Light diet; ORS after each loose stool.", "Hand hygiene; rest for 2–3 days."),
]
RED_FLAGS = ["Fever above 101 °F", "breathlessness or chest pain", "bleeding", "reduced urine output", "severe abdominal pain or persistent vomiting",
             "drowsiness, confusion or seizures"]


def _advice(dx: str) -> tuple[str, str]:
    d = (dx or "").lower()
    for keys, diet, act in DX_ADVICE:
        if any(re.search(rf"\b{re.escape(k.strip())}", d) for k in keys):
            return diet, act
    return "Normal diet as tolerated.", "Gradual return to routine activity."


DISCHARGE_SECTIONS = [
    ("ADMISSION DIAGNOSIS", "admission_diagnosis"), ("FINAL DIAGNOSIS", "final_diagnosis"), ("PROCEDURES", "procedures"),
    ("HOSPITAL COURSE", "hospital_course"), ("INVESTIGATIONS", "investigations_summary"),
    ("CONDITION AT DISCHARGE", "condition_at_discharge"), ("DISCHARGE MEDICATIONS", None), ("FOLLOW-UP", "follow_up"),
    ("DIET ADVICE", "diet_advice"), ("ACTIVITY ADVICE", "activity_advice"), ("WARNING SIGNS", "warning_signs"),
]
_HEAD_RX = re.compile(r"^\s*(?:#+\s*)?\**\s*(" + "|".join(re.escape(h) for h, _ in DISCHARGE_SECTIONS)
                      + r")\s*\**\s*:\s*\**\s*(.*)$", re.I)


def parse_sections(text: str) -> dict[str, str]:
    out: dict[str, list[str]] = {}
    cur = None
    for line in (text or "").splitlines():
        m = _HEAD_RX.match(line)
        if m:
            cur = m.group(1).upper()
            out[cur] = [m.group(2)] if m.group(2).strip() else []
        elif cur:
            out[cur].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


async def build_discharge_summary(ctx, eid: str, scope: set[str]) -> Gen:
    enc = await _enc_info(ctx, eid)
    if enc.get("type") not in ("IPD", "DAYCARE"):
        raise bad_request("A discharge summary needs an inpatient or day-care encounter")
    pid = str(enc["patient_id"])
    p = await _patient(ctx, pid)
    scrub = _scrubber(p)
    cats, sources = [], []
    existing = await find(ctx, "discharge.summaries", encounter_id=eid, limit=1)
    if existing and existing[0].get("status") not in ("Draft",):
        raise conflict(f"Discharge summary {existing[0]['code']} is already {existing[0]['status']}; it cannot be redrafted")
    ctxd: dict[str, Any] = {"patient": {"label": "Patient A"}}
    f: dict[str, Any] = {}
    filled = 0
    if "Demographics" in scope:
        cats.append("Demographics")
        ctxd["patient"].update(age=p.get("age"), sex=p.get("gender"))
        ctxd["stay"] = {"type": enc.get("type"), "length_days": enc.get("day"), "department": enc.get("department"),
                        "ward_type": enc.get("ward_type"), "admission_type": enc.get("admission_type"),
                        "admission_source": enc.get("admission_source"), "status": enc.get("status")}
    course: list[str] = []
    start = _ts(enc.get("started_at"))
    course.append(f"Admitted on {_clock(start)} ({enc.get('admission_type') or 'admission'} via {enc.get('admission_source') or '—'}) "
                  f"under {enc.get('doctor') or 'the treating consultant'}, {enc.get('department') or ''}"
                  + (f", {enc['ward']}" if enc.get("ward") else "") + ".")
    if "Notes" in scope:
        cats.append("Notes")
        probs = await _recs(ctx, "emr.problems", patient_ids=[pid], status=["Active"])
        dx_probs = [x for x in probs if x.get("problem_type") in (None, "", "Diagnosis")]
        f["admission_diagnosis"] = enc.get("diagnosis") or None
        f["final_diagnosis"] = "; ".join(x["problem"] for x in dx_probs if x.get("problem")) or enc.get("diagnosis") or None
        f["icd_codes"] = [x["icd_code"] for x in dx_probs if x.get("icd_code")] or None
        ctxd["admission_diagnosis"] = f["admission_diagnosis"]
        ctxd["problems"] = [{"problem": x.get("problem"), "icd": x.get("icd_code"), "type": x.get("problem_type")} for x in probs]
        notes = await _recs(ctx, "emr.notes", encounter_id=eid)
        notes = sorted([n for n in notes if n.get("status") != "Entered in Error"], key=lambda n: _ts(n.get("noted_at")) or now())
        by_day: dict[date, dict] = {}
        for n in notes:
            if n.get("note_type") in ("Progress Note", "Ward Round", "Consult Note", "Procedure Note") and _ts(n.get("noted_at")):
                by_day[_ts(n["noted_at"]).astimezone(settings.tz).date()] = n
        ctxd["daily_notes"] = [{"day": (d - start.astimezone(settings.tz).date()).days + 1 if start else None, "type": n.get("note_type"),
                                "text": _clip(scrub(n.get("note")), 500)} for d, n in sorted(by_day.items())]
        for d, n in sorted(by_day.items()):
            day_no = max(1, (d - start.astimezone(settings.tz).date()).days + 1) if start else "?"
            course.append(f"Day {day_no} ({n.get('note_type')}): {_clip(scrub(n.get('note')), 220)}")
        transfers = await _recs(ctx, "ipd.transfers", encounter_id=eid, status=["Completed"])
        for t in sorted(transfers, key=lambda r: r.get("created_at") or ""):
            course.append(f"{t.get('transfer_type') or 'Transfer'} on {_clock(t.get('created_at'))}: {t.get('reason') or ''}".strip())
        sources.append(f"{len(probs)} problems, {len(notes)} notes, {len(transfers)} transfers")
        filled += bool(f.get("final_diagnosis")) + bool(by_day)
    procs: list[str] = []
    if "Orders & Results" in scope:
        cats.append("Orders & Results")
        ots = await _recs(ctx, "ot.bookings", encounter_id=eid, status=["Surgery Completed", "Shifted Out"])
        surg = await _names(ctx, {o.get("surgeon") for o in ots})
        for o in ots:
            procs.append(f"{_clock(o.get('incision_at') or o.get('scheduled_at'))}: {o.get('procedure')} "
                         f"({o.get('anaesthesia_type') or 'anaesthesia not recorded'}) — {surg.get(o.get('surgeon'), 'surgeon not recorded')}")
        ords = await _orders(ctx, patient_ids=[pid], encounter_id=eid)
        procs += [f"{_clock(o.get('ordered_at'))}: {o.get('service_name')}" for o in ords if o.get("category") == "PROC" and o.get("status") in ("Resulted", "Verified")]
        done = [o for o in ords if o.get("status") in ("Resulted", "Verified")]
        latest: dict[str, dict] = {}
        for o in done:
            latest[o.get("service_name") or o["id"]] = o
        abnormal = [result_line(o) for o in latest.values() if o.get("category") == "LAB"
                    and any(v.get("flag") not in (None, "", "Normal") for v in (o.get("result_values") or []))]
        normal = [k for k, o in latest.items() if o.get("category") == "LAB" and not any(v.get("flag") not in (None, "", "Normal") for v in (o.get("result_values") or []))]
        imaging = [result_line(o) for o in latest.values() if o.get("category") == "RAD"]
        inv = abnormal + imaging + ([f"Within normal limits: {', '.join(normal)}"] if normal else [])
        pend = [o.get("service_name") for o in ords if o.get("status") in ("Ordered", "Collected", "In Progress")]
        if pend:
            inv.append(f"Pending at discharge: {', '.join(x for x in pend if x)} — results to be reviewed at follow-up.")
        f["investigations_summary"] = "\n".join(inv) or None
        f["procedures"] = "\n".join(procs) or "None"
        ctxd["procedures"] = procs
        ctxd["investigations"] = [{"test": o.get("service_name"), "category": o.get("category"),
                                   "values": [{k: v.get(k) for k in ("parameter", "value", "unit", "flag")} for v in (o.get("result_values") or [])],
                                   "impression": o.get("impression")} for o in latest.values()]
        ctxd["pending_investigations"] = pend
        sources.append(f"{len(ots)} surgeries, {len(done)} results")
        filled += bool(inv)
    cond = None
    if "Vitals" in scope:
        cats.append("Vitals")
        vit = sorted(await _recs(ctx, "emr.vitals", encounter_id=eid, status=["Recorded"]), key=lambda r: _ts(r.get("recorded_at")) or now())
        if not vit:
            vit = sorted(await _recs(ctx, "emr.vitals", patient_ids=[pid], since=start or now() - timedelta(days=10), status=["Recorded"]),
                         key=lambda r: _ts(r.get("recorded_at")) or now())
        if vit:
            first_v, last_v = vit[0], vit[-1]
            ctxd["vitals_admission"] = vitals_digest([first_v])
            ctxd["vitals_latest"] = vitals_digest([last_v])
            course.append(f"Vitals at admission: {vitals_line(vitals_digest([first_v]))}. Latest: {vitals_line(vitals_digest([last_v]))}.")
            cond = "Stable" if not vital_flags(last_v) else None
            filled += 1
        sources.append(f"{len(vit)} vitals")
    meds: list[dict] = []
    if "Medications" in scope:
        cats.append("Medications")
        meds = _rx_lines(await _recs(ctx, "opd.prescriptions", patient_ids=[pid], status=["Active", "Partially Dispensed"]))
        ctxd["discharge_medications"] = [_med_text(m) for m in meds]
        sources.append(f"{len(meds)} active medicines")
        filled += bool(meds)
    course.append("[Consultant to review and complete the clinical course.]")
    f["hospital_course"] = "\n".join(course)
    f["condition_at_discharge"] = cond
    dx = f.get("final_diagnosis") or enc.get("diagnosis") or ""
    diet, act = _advice(dx)
    fu_date = today() + timedelta(days=7)
    if fu_date.weekday() == 6:
        fu_date += timedelta(days=1)
    f["follow_up"] = (f"Review in {enc.get('department') or 'the treating department'} OPD"
                      + (f" with {enc['doctor']}" if enc.get("doctor") else "") + " after 7 days with reports (suggested — confirm).")
    f["diet_advice"] = f"{diet} (suggested — confirm)"
    f["activity_advice"] = f"{act} (suggested — confirm)"
    f["warning_signs"] = "Return to the Emergency department immediately for: " + "; ".join(RED_FLAGS) + "."
    med_lines = [{"drug": m["drug"], "dose": m.get("dose"), "frequency": m.get("frequency") if m.get("frequency") in FREQUENCIES else None,
                  "duration_days": _num(m.get("duration_days")), "instructions": m.get("instructions")} for m in meds]
    sec = {
        "ADMISSION DIAGNOSIS": f.get("admission_diagnosis") or "[Not documented]",
        "FINAL DIAGNOSIS": f.get("final_diagnosis") or "[Consultant to confirm final diagnosis]",
        "PROCEDURES": f.get("procedures") or "None",
        "HOSPITAL COURSE": f["hospital_course"],
        "INVESTIGATIONS": f.get("investigations_summary") or "[No resulted investigations in scope]",
        "CONDITION AT DISCHARGE": cond or "[Consultant to assess]",
        "DISCHARGE MEDICATIONS": "\n".join(f"{i + 1}. {_med_text(m)}" for i, m in enumerate(meds)) or "[No active prescriptions — reconcile medicines]",
        "FOLLOW-UP": f["follow_up"], "DIET ADVICE": f["diet_advice"], "ACTIVITY ADVICE": f["activity_advice"],
        "WARNING SIGNS": f["warning_signs"],
    }
    text = "DISCHARGE SUMMARY — AI draft for consultant review\n\n" + "\n\n".join(f"{h}:\n{sec[h]}" for h, _ in DISCHARGE_SECTIONS)
    ctxd["discharge_type"] = enc.get("discharge_type")
    return Gen(context=ctxd, draft=text, categories=cats, sources=sources,
               target=f"discharge.summaries:{existing[0]['id']}" if existing else f"ipd.encounters:{eid}",
               confidence=min(95, 30 + 13 * filled),
               output={"encounter_id": eid, "patient_id": pid, "summary_id": existing[0]["id"] if existing else None,
                       "fields": f, "discharge_medications": med_lines, "follow_up_date": fu_date.isoformat(),
                       "consultant": str(enc["doctor_id"]) if enc.get("doctor_id") else None,
                       "discharge_type": enc.get("discharge_type") or "Routine"},
               instructions="Write an NABH-style discharge summary using EXACTLY these headings, each on its own line followed by a colon: "
                            + ", ".join(h for h, _ in DISCHARGE_SECTIONS)
                            + ". Keep '(suggested — confirm)' markers on advice that is not documented in the context.")


# ====================================================================== use case: task prioritisation

P_LABEL = [(85, "P1 Critical"), (65, "P2 High"), (40, "P3 Medium"), (0, "P4 Low")]


def _priority(score: float) -> str:
    return next(lbl for th, lbl in P_LABEL if score >= th)


async def build_task_priorities(ctx, ward_id: str, scope: set[str]) -> Gen:
    ward = await get(ctx, "mdm.wards", ward_id)
    if not ward:
        raise not_found("Ward not found")
    icu = (ward.get("ward_type") or "") in ("ICU", "HDU", "NICU", "PICU")
    rows = (await ctx.conn.execute(
        sa.select(encounters.c.id, encounters.c.patient_id, encounters.c.status, encounters.c.started_at, beds.c.bed_no, beds.c.code)
        .select_from(encounters.join(beds, beds.c.id == encounters.c.bed_id))
        .where(beds.c.ward_id == ward_id, encounters.c.status.in_(["Admitted", "Discharge Initiated"]), encounters.c.deleted_at.is_(None))
    )).all()
    pts = {str(r.patient_id): {"encounter_id": str(r.id), "bed": r.bed_no or r.code, "status": r.status} for r in rows}
    pids = list(pts)
    tasks: list[dict] = []
    cats: list[str] = []
    sources = [f"{len(pids)} inpatients in {ward.get('name') or ward.get('title')}"]
    t_now = now()

    def add(pid: str | None, task: str, ttype: str, score: float, reason: str, role: str, source: str | None = None, due: Any = None):
        score = max(0, min(100, round(score)))
        tasks.append({"patient_id": pid, "bed": pts.get(pid, {}).get("bed") if pid else None, "task": task[:300], "task_type": ttype,
                      "priority": _priority(score), "priority_score": score, "reason": reason, "assigned_role": role,
                      "source_record": source, "due_at": (_ts(due) or t_now).isoformat(timespec="minutes"), "ward": ward_id})

    if pids and "Orders & Results" in scope:
        cats.append("Orders & Results")
        ords = await _orders(ctx, patient_ids=pids)
        for o in ords:
            pid = str(o["patient_id"])
            if o.get("critical") and not o.get("acknowledged_at") and o.get("status") in ("Resulted", "Verified"):
                age_h = (t_now - (_ts(o.get("resulted_at")) or t_now)).total_seconds() / 3600
                add(pid, f"Acknowledge critical result: {result_line(o)}", "Critical result acknowledgement", 92 + min(8, age_h * 2),
                    f"Critical value unacknowledged for {_dur(age_h * 60)} (NABH: inform within 30 min)", "doctor", f"orders.orders:{o['id']}", o.get("resulted_at"))
            elif o.get("category") == "LAB" and o.get("status") == "Ordered":
                stat = o.get("priority") in ("STAT", "Urgent")
                wait = (t_now - (_ts(o.get("ordered_at")) or t_now)).total_seconds() / 60
                add(pid, f"Collect sample: {o.get('service_name')} ({o.get('priority') or 'Routine'})", "Sample pending collection",
                    (62 if stat else 35) + min(20, wait / 15), f"Ordered {_dur(wait)} ago, not yet collected", "nurse", f"orders.orders:{o['id']}", o.get("ordered_at"))
        tasks_n = await _recs(ctx, "nursing.tasks", patient_ids=pids, status=["Pending"])
        tasks_n += [t for t in await _recs(ctx, "nursing.tasks", where={"ward": ward_id}, status=["Pending"]) if not t.get("patient_id")]
        for t in tasks_n:
            due = _ts(t.get("due_at"))
            overdue = due is not None and due < t_now
            base = {"STAT": 80, "Urgent": 60}.get(t.get("priority"), 38)
            mins_over = (t_now - due).total_seconds() / 60 if overdue and due else 0
            add(t.get("patient_id"), t.get("task") or "Nursing task", "Consult pending" if t.get("category") == "Other" else "Medication due"
                if t.get("category") == "Medication" else "Vitals overdue" if t.get("category") == "Vitals" else "Sample pending collection"
                if t.get("category") == "Sample collection" else "Discharge pending" if t.get("category") == "Discharge preparation" else "Consult pending",
                base + min(15, mins_over / 10), f"{t.get('priority') or 'Routine'} {t.get('category') or 'task'}" + (f", overdue {_dur(mins_over)}" if overdue else ""),
                "nurse", f"nursing.tasks:{t['id']}", t.get("due_at"))
        sources.append(f"{len(ords)} orders, {len(tasks_n)} nursing tasks")
    if pids and "Vitals" in scope:
        cats.append("Vitals")
        vit = await _recs(ctx, "emr.vitals", patient_ids=pids, since=t_now - timedelta(hours=24), status=["Recorded"])
        latest: dict[str, dict] = {}
        for v in sorted(vit, key=lambda r: _ts(r.get("recorded_at")) or t_now):
            latest[str(v["patient_id"])] = v
        limit_h = 1 if icu else 4
        for pid in pids:
            v = latest.get(pid)
            if v:
                n = _news(v)
                if n is not None and n >= 5:
                    add(pid, f"Escalate: NEWS2 {n} — doctor review and increase monitoring", "Deterioration risk (EWS)",
                        90 if n >= 7 else 72, f"Latest vitals {_clock(v.get('recorded_at'))}: {', '.join(vital_flags(v)) or 'NEWS2 ' + str(n)}",
                        "doctor", f"emr.vitals:{v['id']}", v.get("recorded_at"))
                age_h = (t_now - (_ts(v.get("recorded_at")) or t_now)).total_seconds() / 3600
                if age_h > limit_h:
                    add(pid, f"Record vitals (last {age_h:.1f} h ago)", "Vitals overdue", 45 + min(25, (age_h - limit_h) * 5) + (10 if (n or 0) >= 3 else 0),
                        f"{'ICU' if icu else 'Ward'} standard is every {limit_h} h", "nurse", f"emr.vitals:{v['id']}")
            else:
                add(pid, "Record vitals (none in the last 24 h)", "Vitals overdue", 60 if icu else 50, "No vitals documented in 24 h", "nurse")
        sources.append(f"{len(vit)} vitals")
    if pids and "Medications" in scope:
        cats.append("Medications")
        mar = await _recs(ctx, "nursing.mar", patient_ids=pids, status=["Scheduled"], since=t_now - timedelta(hours=12))
        for m in mar:
            due = _ts(m.get("scheduled_at"))
            if not due or due > t_now + timedelta(minutes=60):
                continue
            mins = (t_now - due).total_seconds() / 60
            drug = (m.get("_refs") or {}).get(m.get("drug"), "medication")
            add(str(m["patient_id"]), f"Give {drug} {m.get('dose') or ''} {m.get('route') or ''}".strip(), "Medication due",
                (70 if m.get("high_alert") else 50) + (min(25, mins / 4) if mins > 0 else 0),
                ("High-alert drug; " if m.get("high_alert") else "") + (f"overdue {_dur(mins)}" if mins > 0 else f"due in {_dur(-mins)}"),
                "nurse", f"nursing.mar:{m['id']}", m.get("scheduled_at"))
        sources.append(f"{len(mar)} scheduled doses")
    for pid, info in pts.items():
        if info["status"] == "Discharge Initiated":
            add(pid, "Complete discharge: summary, medicines, billing clearance", "Discharge pending", 48,
                "Discharge initiated — bed turnaround depends on it", "nurse", f"ipd.encounters:{info['encounter_id']}")
            if "Billing" in scope:
                add(pid, "Clear the bill for discharge", "Bill clearance", 42, "Discharge initiated", "billing", f"ipd.encounters:{info['encounter_id']}")
    if "Billing" in scope:
        cats.append("Billing")
    tasks.sort(key=lambda t: -t["priority_score"])
    ctxd = {"ward": {"name": ward.get("name"), "type": ward.get("ward_type"), "inpatients": len(pids)},
            "tasks": [{k: t[k] for k in ("bed", "task", "task_type", "priority", "priority_score", "reason")} for t in tasks[:60]]}
    by_p = Counter(t["priority"] for t in tasks)
    lines = [f"PRIORITISED WORKLIST — {ward.get('name')} ({len(pids)} inpatients) · {_clock(t_now)}",
             "Counts: " + (", ".join(f"{k}: {by_p[k]}" for _, k in P_LABEL if by_p.get(k)) or "no open tasks"), ""]
    for i, t in enumerate(tasks[:40], 1):
        lines.append(f"{i:>2}. [{t['priority']} · {t['priority_score']}] Bed {t['bed'] or '—'} — {t['task']}  ({t['reason']})")
    if len(tasks) > 40:
        lines.append(f"… and {len(tasks) - 40} lower-priority items")
    lines += ["", "Suggestions only — the nurse in charge confirms the order of work."]
    return Gen(context=ctxd, draft="\n".join(lines), categories=cats, sources=sources, target=f"mdm.wards:{ward_id}",
               confidence=70 if tasks else 50, output={"ward_id": ward_id, "tasks": tasks[:80]},
               instructions="Write a short shift-briefing paragraph for the nurse in charge, then the ranked worklist as numbered lines "
                            "'[priority] Bed — task (reason)'. Keep the ranking exactly as given in the context.")


# ====================================================================== use case: TAT bottlenecks

TARGETS = {"er_door_to_doctor": 10, "opd_wait": 30, "discharge_tat": 180, "verification": 60, "collection": 45}


def _sev(dev: float) -> str:
    return "High" if dev >= 50 else "Medium" if dev >= 20 else "Low"


def _finding(headline, ttype, area, metric, observed, expected, explanation, action, *, severity: str | None = None) -> dict:
    """expected=None marks a count-type finding (anything above zero is the deviation)."""
    dev = 100.0 if not expected else round((observed - expected) / expected * 100, 1)
    return {"headline": headline, "insight_type": ttype, "area": area, "metric": metric, "observed_value": round(float(observed), 1),
            "expected_value": round(float(expected or 0), 1), "deviation_percent": dev, "severity": severity or _sev(abs(dev)),
            "explanation": explanation, "suggested_action": action}


async def _order_tat(ctx, cat: str, s: datetime, e: datetime) -> dict:
    o = orders
    done_at = sa.func.coalesce(o.c.verified_at, o.c.resulted_at)
    total = sa.extract("epoch", done_at - o.c.ordered_at) / 60
    base = [o.c.category == cat, o.c.ordered_at >= s, o.c.ordered_at < e, o.c.deleted_at.is_(None), o.c.status != "Cancelled"]
    stage = (await ctx.conn.execute(sa.select(
        sa.func.count(),
        sa.func.avg(sa.extract("epoch", o.c.collected_at - o.c.ordered_at) / 60).filter(o.c.collected_at.isnot(None)),
        sa.func.avg(sa.extract("epoch", o.c.resulted_at - sa.func.coalesce(o.c.collected_at, o.c.ordered_at)) / 60).filter(o.c.resulted_at.isnot(None)),
        sa.func.avg(sa.extract("epoch", o.c.verified_at - o.c.resulted_at) / 60).filter(o.c.verified_at.isnot(None), o.c.resulted_at.isnot(None)),
        sa.func.avg(total).filter(done_at.isnot(None)),
    ).where(*base))).one()
    per_test = (await ctx.conn.execute(sa.select(
        services.c.title, services.c.tat_minutes, sa.func.count().filter(done_at.isnot(None)), sa.func.avg(total).filter(done_at.isnot(None)),
        sa.func.percentile_cont(0.9).within_group(total).filter(done_at.isnot(None)),
        sa.func.count().filter(done_at.isnot(None), total > services.c.tat_minutes),
    ).select_from(o.join(services, services.c.id == o.c.service_id)).where(*base).group_by(services.c.title, services.c.tat_minutes))).all()
    overdue = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(o.join(services, services.c.id == o.c.service_id)).where(
        o.c.category == cat, o.c.deleted_at.is_(None), o.c.status.in_(["Ordered", "Collected", "In Progress"]),
        sa.extract("epoch", sa.func.now() - o.c.ordered_at) / 60 > sa.func.coalesce(services.c.tat_minutes, 240)))).scalar_one()
    tests = [{"test": t, "target": tat, "done": n, "avg": float(a) if a is not None else None, "p90": float(p) if p is not None else None,
              "breached": b, "breach_pct": round(b / n * 100, 1) if n else 0} for t, tat, n, a, p, b in per_test]
    f = lambda v: round(float(v), 1) if v is not None else None  # noqa: E731
    return {"orders": stage[0], "collect_min": f(stage[1]), "process_min": f(stage[2]), "verify_min": f(stage[3]), "total_min": f(stage[4]),
            "tests": tests, "overdue_pending": overdue}


async def build_tat(ctx, d_from: date, d_to: date, scope: set[str]) -> Gen:
    s, e = metrics._rng(d_from, d_to)
    findings: list[dict] = []
    ctxd: dict[str, Any] = {"period": {"days": (d_to - d_from).days + 1}}
    for cat, area, label in (("LAB", "Lab", "Lab"), ("RAD", "Radiology", "Radiology")):
        t = await _order_tat(ctx, cat, s, e)
        ctxd[label.lower()] = {k: v for k, v in t.items() if k != "tests"}
        tests = [x for x in t["tests"] if x["done"] >= 5 and x["target"]]
        if tests:
            w_target = sum(x["target"] * x["done"] for x in tests) / sum(x["done"] for x in tests)
            w_avg = sum((x["avg"] or 0) * x["done"] for x in tests) / sum(x["done"] for x in tests)
            if w_avg > w_target * 1.1:
                findings.append(_finding(f"{label} TAT above target", "TAT Bottleneck", area, f"{label} order → report (min, volume-weighted)",
                                         w_avg, w_target, f"{t['orders']} orders; stage averages: collection {t['collect_min']} min, "
                                         f"processing {t['process_min']} min, verification {t['verify_min']} min.",
                                         "Review the slowest stage below with the section head; check staffing against peak hours."))
        worst = sorted([x for x in tests if x["breach_pct"] >= 30], key=lambda x: -x["breach_pct"])[:5]
        for x in worst:
            findings.append(_finding(f"{x['test']}: {x['breach_pct']:.0f}% of reports beyond {x['target']} min", "TAT Bottleneck", area,
                                     f"{x['test']} TAT (min)", x["avg"] or 0, x["target"],
                                     f"{x['breached']} of {x['done']} reports late; 90th percentile {x['p90']:.0f} min.",
                                     "Check batching, analyser uptime and reporting rota for this test."))
        if t["verify_min"] and t["verify_min"] > TARGETS["verification"]:
            findings.append(_finding(f"{label} verification backlog", "TAT Bottleneck", area, "Result → verification (min)", t["verify_min"],
                                     TARGETS["verification"], "Results wait for authorisation longer than the processing itself.",
                                     "Add a verifying pathologist / radiologist slot at peak; enable auto-verification for normal panels."))
        if t["collect_min"] and t["collect_min"] > TARGETS["collection"]:
            findings.append(_finding(f"{label} sample collection delay", "TAT Bottleneck", area, "Order → collection (min)", t["collect_min"],
                                     TARGETS["collection"], "Orders wait for phlebotomy / scheduling.", "Review phlebotomy rounds and STAT collection workflow."))
        if t["overdue_pending"]:
            findings.append(_finding(f"{t['overdue_pending']} {label.lower()} orders pending beyond target", "TAT Bottleneck", area,
                                     "Pending orders past TAT", t["overdue_pending"], None, "Open orders older than the test's TAT.",
                                     "Work the overdue list in the lab / radiology worklist today.",
                                     severity="High" if t["overdue_pending"] >= 20 else "Medium"))
        if "Orders & Results" in scope:
            ctxd[label.lower()]["slowest_tests"] = sorted(tests, key=lambda x: -(x["breach_pct"]))[:8]
    d2d = await metrics.er_door_to_doctor(ctx, d_from, d_to)
    ctxd["er_door_to_doctor_min"] = d2d
    if d2d is not None and d2d > TARGETS["er_door_to_doctor"]:
        findings.append(_finding("ER door-to-doctor time above target", "TAT Bottleneck", "ER", "Door → doctor (min)", d2d,
                                 TARGETS["er_door_to_doctor"], "Average time from ER arrival to first doctor contact.",
                                 "Check triage-to-doctor handoff and ER doctor roster at peak hours."))
    waits = [w for w in [await metrics.opd_wait(ctx, d_from + timedelta(days=i)) for i in range((d_to - d_from).days + 1)] if w is not None]
    ctxd["opd_wait_min"] = round(mean(waits), 1) if waits else None
    if waits and mean(waits) > TARGETS["opd_wait"]:
        findings.append(_finding("OPD waiting time above target", "TAT Bottleneck", "OPD", "Token → called (min)", mean(waits),
                                 TARGETS["opd_wait"], "Average wait from token to consultation call.", "Balance slots across doctors; review late starts."))
    chk = await _recs(ctx, "discharge.checklists", since=s, date_key="discharge_ordered_at")
    tats = [_num(c.get("tat_minutes")) for c in chk if _num(c.get("tat_minutes")) is not None]
    reasons = Counter(c.get("delay_reason") for c in chk if c.get("delay_reason") not in (None, "", "None"))
    pending_dis = (await metrics.admissions(ctx, d_to, d_to))["discharge_pending"]
    ctxd["discharge"] = {"completed": len(tats), "avg_tat_min": round(mean(tats), 1) if tats else None,
                         "top_delay_reasons": reasons.most_common(4), "pending_now": pending_dis}
    if tats and mean(tats) > TARGETS["discharge_tat"]:
        top = ", ".join(f"{r} ({n})" for r, n in reasons.most_common(3)) or "no reasons recorded"
        findings.append(_finding("Discharge TAT above target", "TAT Bottleneck", "Discharge", "Discharge order → cleared (min)", mean(tats),
                                 TARGETS["discharge_tat"], f"Top delay reasons: {top}.", "Start summaries and TPA final bills the evening before planned discharges."))
    findings.sort(key=lambda x: ({"High": 0, "Medium": 1, "Low": 2}[x["severity"]], -abs(x["deviation_percent"])))
    lines = [f"TAT BOTTLENECKS — {d_from:%d %b} to {d_to:%d %b %Y}", ""]
    for lbl in ("lab", "radiology"):
        t = ctxd[lbl]
        lines.append(f"{lbl.title()}: {t['orders']} orders · avg {t['total_min'] or '—'} min "
                     f"(collect {t['collect_min'] or '—'} · process {t['process_min'] or '—'} · verify {t['verify_min'] or '—'}) · {t['overdue_pending']} overdue pending")
    lines.append(f"ER door-to-doctor: {d2d if d2d is not None else '—'} min (target {TARGETS['er_door_to_doctor']}) · "
                 f"OPD wait: {ctxd['opd_wait_min'] if ctxd['opd_wait_min'] is not None else 'no queue data'} · "
                 f"Discharge TAT: {ctxd['discharge']['avg_tat_min'] or '—'} min ({pending_dis} pending now)")
    lines += ["", f"FINDINGS ({len(findings)})"]
    lines += [f"• [{x['severity']}] {x['headline']} — observed {x['observed_value']} vs {x['expected_value']} ({x['deviation_percent']:+.0f}%). "
              f"{x['explanation']} Suggested: {x['suggested_action']}" for x in findings] or ["• No bottlenecks beyond tolerance in this period."]
    ctxd["findings"] = findings
    return Gen(context=ctxd, draft="\n".join(lines), categories=["Orders & Results"] if "Orders & Results" in scope else [],
               sources=[f"orders {ctxd['lab']['orders'] + ctxd['radiology']['orders']}, discharge checklists {len(chk)}"],
               target="ai.insights", confidence=75, output={"findings": findings, "insight_type": "TAT Bottleneck"},
               instructions="Write a management briefing: one paragraph overview, then each finding as a bullet with severity, the number, "
                            "the likely bottleneck stage and the suggested action. Use only the numbers in the context.")


# ====================================================================== use case: anomaly alerts

def _z(obs: float, base: list[float]) -> tuple[float, float, float]:
    m = mean(base) if base else 0.0
    sd = max(pstdev(base) if len(base) > 1 else 0.0, abs(m) * 0.05, 1.0)
    return m, sd, (obs - m) / sd


async def _by_day_until(ctx, col, amount, conds: list, start: date, end: date, until_tod) -> dict[date, float]:
    local = sa.func.timezone(settings.timezone, col)
    day = sa.func.date(local)
    s, e = metrics._rng(start, end)
    stmt = sa.select(day, sa.func.coalesce(sa.func.sum(amount), 0)).where(col >= s, col < e, *conds)
    if until_tod is not None:
        stmt = stmt.where(sa.cast(local, sa.Time) <= until_tod)
    return {d: float(v) for d, v in (await ctx.conn.execute(stmt.group_by(day))).all()}


def _comparable(days: list[date], ref: date) -> list[date]:
    """Sundays (OPD closed) are only compared with Sundays."""
    return [d for d in days if (d.weekday() == 6) == (ref.weekday() == 6)]


async def build_anomalies(ctx, scope: set[str]) -> Gen:
    t_now = now()
    d0 = today()
    hist = [d0 - timedelta(days=i) for i in range(1, 15)]
    tod = t_now.timetz().replace(tzinfo=None)
    inv, pay = invoices, payments
    inv_c = [inv.c.status != "Cancelled", inv.c.deleted_at.is_(None)]
    pay_c = [pay.c.status == "Success", pay.c.deleted_at.is_(None), pay.c.kind.in_(["PAYMENT", "DEPOSIT"])]
    findings: list[dict] = []
    ctxd: dict[str, Any] = {"as_of": "now", "baseline_days": 14}

    async def check(metric: str, area: str, col, amount, conds, label: str):
        today_v = (await _by_day_until(ctx, col, amount, conds, d0, d0, tod)).get(d0, 0.0)
        partial = await _by_day_until(ctx, col, amount, conds, hist[-1], hist[0], tod)
        base = [partial.get(d, 0.0) for d in _comparable(hist, d0)]
        m, sd, z = _z(today_v, base)
        ctxd[metric] = {"today_so_far": round(today_v), "baseline_same_time": round(m), "z": round(z, 2)}
        if z <= -2 and today_v < m * 0.85:
            findings.append(_finding(f"{label} dip today", "Anomaly", area, f"{label} so far today (₹)", today_v, m,
                                     f"₹{today_v:,.0f} by {t_now:%H:%M} vs a typical ₹{m:,.0f} by this time (z = {z:.1f}).",
                                     "Check counters, gateway / UPI uptime and OPD footfall; confirm bills are being finalised."))
        elif z >= 2.5 and today_v > m * 1.25:
            findings.append(_finding(f"{label} unusually high today", "Anomaly", area, f"{label} so far today (₹)", today_v, m,
                                     f"₹{today_v:,.0f} vs a typical ₹{m:,.0f} by this time (z = {z:.1f}).", "Verify large bills / bulk deposits are genuine."))
        yday = hist[0]
        full = await _by_day_until(ctx, col, amount, conds, hist[-1], yday, None)
        prev = [d for d in hist[1:]]
        yb = [full.get(d, 0.0) for d in _comparable(prev, yday)]
        ym, ysd, yz = _z(full.get(yday, 0.0), yb)
        ctxd[metric]["yesterday"] = round(full.get(yday, 0.0))
        ctxd[metric]["yesterday_baseline"] = round(ym)
        if yz <= -2 and full.get(yday, 0.0) < ym * 0.85:
            findings.append(_finding(f"{label} dip yesterday", "Anomaly", area, f"{label} {yday:%d %b} (₹)", full.get(yday, 0.0), ym,
                                     f"Full-day {label.lower()} ₹{full.get(yday, 0.0):,.0f} vs baseline ₹{ym:,.0f} (z = {yz:.1f}).",
                                     "Reconcile yesterday's day-end report with counters and departments."))

    await check("revenue", "Billing", inv.c.billed_at, inv.c.net, inv_c, "Revenue")
    await check("collections", "Billing", pay.c.paid_at, pay.c.amount, pay_c, "Collections")

    # discount %
    s14, _ = metrics._rng(hist[-1], d0)
    rows = (await ctx.conn.execute(sa.select(inv.c.id, inv.c.code, inv.c.gross, inv.c.discount, inv.c.billed_at).where(
        inv.c.billed_at >= s14, *inv_c, inv.c.gross > 0))).all()
    recent_cut = t_now - timedelta(hours=24)
    old = [float(r.discount or 0) / float(r.gross) * 100 for r in rows if r.billed_at < recent_cut]
    new = [r for r in rows if r.billed_at >= recent_cut]
    new_rate = (sum(float(r.discount or 0) for r in new) / sum(float(r.gross) for r in new) * 100) if new else 0.0
    old_rate = (sum(float(r.discount or 0) for r in rows if r.billed_at < recent_cut)
                / max(1.0, sum(float(r.gross) for r in rows if r.billed_at < recent_cut)) * 100)
    ctxd["discount"] = {"last_24h_pct": round(new_rate, 2), "baseline_pct": round(old_rate, 2), "bills_last_24h": len(new)}
    if new and new_rate > max(old_rate * 1.5, old_rate + 2):
        findings.append(_finding("Discount rate unusually high", "Anomaly", "Billing", "Discount as % of gross (24 h)", new_rate, old_rate,
                                 f"{len(new)} bills in 24 h carry {new_rate:.1f}% discount vs {old_rate:.1f}% baseline.",
                                 "Review discount approvals and reasons for the last 24 h."))
    thresh = max(settings.discount_approval_percent, (mean(old) * 2 if old else 0))
    heavy = [r for r in new if float(r.discount or 0) / float(r.gross) * 100 > thresh]
    if heavy:
        detail = (": " + ", ".join(f"{r.code} ({float(r.discount) / float(r.gross) * 100:.0f}%)" for r in heavy[:8])) if "Billing" in scope else ""
        findings.append(_finding(f"{len(heavy)} bills with discount above {thresh:.0f}%", "Anomaly", "Billing", "Bills above discount threshold",
                                 len(heavy), None, f"High individual discounts in the last 24 h{detail}.", "Confirm each has an approved reason.",
                                 severity="Medium"))
    # refunds
    refunds = await _by_day_until(ctx, pay.c.paid_at, pay.c.amount, [pay.c.kind == "REFUND", pay.c.deleted_at.is_(None),
                                                                    pay.c.status.in_(["Success", "Pending"])], hist[-1], d0, None)
    rb = [refunds.get(d, 0.0) for d in hist]
    rm, rsd, rz = _z(refunds.get(d0, 0.0), rb)
    ctxd["refunds"] = {"today": round(refunds.get(d0, 0.0)), "daily_mean": round(rm)}
    if refunds.get(d0, 0.0) > 5000 and rz >= 2:
        findings.append(_finding("Refund spike today", "Anomaly", "Billing", "Refunds today (₹)", refunds.get(d0, 0.0), rm,
                                 f"₹{refunds.get(d0, 0.0):,.0f} refunded / pending today vs ₹{rm:,.0f} daily average.",
                                 "Review refund approvals and their reasons; check for duplicate payments."))
    # unbilled ageing
    ch = charges
    age_h = sa.extract("epoch", sa.func.now() - ch.c.charged_at) / 3600
    bucket = sa.case((age_h <= 24, "0-1 d"), (age_h <= 72, "1-3 d"), (age_h <= 168, "3-7 d"), else_=">7 d")
    ub = (await ctx.conn.execute(sa.select(bucket, sa.func.count(), sa.func.coalesce(sa.func.sum(ch.c.amount), 0))
                                 .where(ch.c.status == "Unbilled", ch.c.deleted_at.is_(None)).group_by(bucket))).all()
    ctxd["unbilled_ageing"] = {b: {"charges": n, "amount": float(a)} for b, n, a in ub}
    leak = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.coalesce(sa.func.sum(ch.c.amount), 0)).select_from(
        ch.outerjoin(encounters, encounters.c.id == ch.c.encounter_id)).where(
        ch.c.status == "Unbilled", ch.c.deleted_at.is_(None),
        sa.or_(encounters.c.status.in_(["Discharged", "Closed", "Cancelled"]), sa.and_(ch.c.encounter_id.is_(None), age_h > 24)))
    )).one()
    ctxd["unbilled_leakage"] = {"charges": leak[0], "amount": float(leak[1])}
    if leak[0]:
        findings.append(_finding("Unbilled charges after discharge / OP visit", "Revenue Leakage", "Billing",
                                 "Unbilled on closed encounters (₹)", float(leak[1]), None,
                                 f"{leak[0]} charges worth ₹{float(leak[1]):,.0f} are unbilled although the visit or stay has ended.",
                                 "Raise supplementary bills or cancel with reason; check charge capture timing.",
                                 severity="High" if float(leak[1]) >= 50000 else "Medium"))
    # occupancy
    wards = await metrics.occupancy_by_ward(ctx)
    census = await metrics.bed_census(ctx)
    ctxd["occupancy"] = {"hospital_pct": census["occupancy_pct"], "wards_over_95": []}
    for w in wards:
        pct = w["occupied"] / w["total"] * 100 if w["total"] else 0
        if w["total"] >= 4 and pct >= 95:
            ctxd["occupancy"]["wards_over_95"].append({"ward": w["ward"], "pct": round(pct, 1)})
            findings.append(_finding(f"{w['ward']} at {pct:.0f}% occupancy", "Anomaly", "IPD", "Ward occupancy %", pct, census["occupancy_pct"] or 1,
                                     f"{w['occupied']} of {w['total']} beds occupied (hospital {census['occupancy_pct']}%).",
                                     "Expedite planned discharges; divert elective admissions to sister wards.",
                                     severity="High" if pct >= 100 else "Medium"))
    snaps = await _recs(ctx, "command.snapshots", since=t_now - timedelta(days=7))
    occ_hist = [_num(sn.get("occupancy_percent")) for sn in snaps if _num(sn.get("occupancy_percent")) is not None]
    if len(occ_hist) >= 6:
        m, sd, z = _z(census["occupancy_pct"], occ_hist)
        if z >= 2:
            findings.append(_finding("Bed occupancy spike", "Anomaly", "IPD", "Hospital occupancy %", census["occupancy_pct"], m,
                                     f"Occupancy {census['occupancy_pct']}% vs 7-day mean {m:.1f}% (z = {z:.1f}).", "Activate the bed-crunch protocol."))
    findings.sort(key=lambda x: ({"High": 0, "Medium": 1, "Low": 2}[x["severity"]], -abs(x["deviation_percent"])))
    ctxd["findings"] = findings
    lines = [f"ANOMALY SCAN — {_clock(t_now)} (baseline: previous 14 days, same time of day)", "",
             f"Revenue so far ₹{ctxd['revenue']['today_so_far']:,} vs typical ₹{ctxd['revenue']['baseline_same_time']:,} · "
             f"Collections ₹{ctxd['collections']['today_so_far']:,} vs ₹{ctxd['collections']['baseline_same_time']:,}",
             f"Discount 24 h {ctxd['discount']['last_24h_pct']}% (baseline {ctxd['discount']['baseline_pct']}%) · Refunds today ₹{ctxd['refunds']['today']:,} · "
             f"Occupancy {census['occupancy_pct']}%", "", f"FINDINGS ({len(findings)})"]
    lines += [f"• [{x['severity']}] {x['headline']} — {x['explanation']} Suggested: {x['suggested_action']}" for x in findings] \
        or ["• Nothing outside normal variation."]
    return Gen(context=ctxd, draft="\n".join(lines), categories=["Billing"] if "Billing" in scope else [],
               sources=[f"{len(rows)} bills, {len(wards)} wards, {len(snaps)} snapshots"], target="ai.insights", confidence=70,
               output={"findings": findings, "insight_type": "Anomaly"},
               instructions="Write a short anomaly briefing for management: overview sentence, then one bullet per finding with the number, "
                            "the comparison baseline and the suggested check. Do not speculate about causes beyond the context.")


# ====================================================================== use case: feedback themes

THEMES = [
    ("Long waiting time", "Waiting Time", ["wait", "waiting", "waited", "delay", "delayed", "late", "queue", "long time", "slow", "hours"]),
    ("Billing & charges", "Billing", ["bill", "billing", "charge", "charges", "charged", "expensive", "costly", "overcharg", "refund", "estimate",
                                       "insurance", "tpa", "cashless", "deposit", "payment"]),
    ("Doctor communication", "Clinical Care", ["doctor", "consultant", "explain", "explained", "diagnosis", "treatment", "rounds", "surgeon"]),
    ("Nursing care", "Nursing", ["nurse", "nurses", "nursing", "sister", "call bell", "injection", "drip", "responsive"]),
    ("Food quality", "Food", ["food", "meal", "meals", "diet", "breakfast", "lunch", "dinner", "canteen", "tea", "coffee"]),
    ("Cleanliness & hygiene", "Housekeeping", ["clean", "cleanliness", "dirty", "toilet", "washroom", "bathroom", "hygiene", "smell", "dust",
                                                "linen", "bedsheet", "mosquito", "cockroach", "housekeeping"]),
    ("Staff behaviour", "Staff Behaviour", ["rude", "behaviour", "behavior", "polite", "courteous", "attitude", "staff", "security",
                                             "reception", "helpful", "friendly", "arrogant"]),
    ("Discharge process", "Other", ["discharge", "discharged"]),
    ("Facilities & amenities", "Facilities", ["parking", "lift", "elevator", "ac", "air conditioning", "water", "wifi", "seating", "wheelchair",
                                              "signage", "fan", "noise", "noisy", "room"]),
    ("Pharmacy & medicines", "Other", ["pharmacy", "medicine", "medicines", "tablets", "drug", "out of stock"]),
    ("Reports & diagnostics", "Clinical Care", ["report", "reports", "lab", "test", "tests", "scan", "x-ray", "xray", "mri", "ct", "sample"]),
]
POS = {"good", "great", "excellent", "clean", "caring", "helpful", "kind", "polite", "thank", "thanks", "thankful", "satisfied", "best", "nice",
       "prompt", "quick", "friendly", "professional", "recommend", "happy", "bagundi", "baagundi", "accha", "achha", "super", "wonderful", "courteous"}
NEG = {"bad", "poor", "worst", "rude", "dirty", "delay", "delayed", "late", "slow", "expensive", "overcharged", "unhappy", "disappointed",
       "careless", "waited", "cold", "smell", "smelly", "problem", "issue", "complaint", "pathetic", "horrible", "terrible", "unprofessional",
       "arrogant", "noisy", "costly", "never", "waste", "ignored"}
_WORD = re.compile(r"[a-z][a-z'-]*")


def classify_feedback(comment: str | None, rating: Any) -> tuple[list[str], str]:
    text = f" {(comment or '').lower()} "
    themes = []
    for name, _, kws in THEMES:
        if any(re.search(rf"\b{re.escape(k)}", text) for k in kws):
            themes.append(name)
    words = _WORD.findall(text)
    score = sum(w in POS for w in words) - sum(w in NEG for w in words)
    r = _num(rating)
    if r is not None:
        score += 1.5 if r >= 4 else -1.5 if r <= 2 else 0
    sentiment = "Positive" if score > 0.5 else "Negative" if score < -0.5 else "Neutral"
    return themes, sentiment


async def build_feedback_themes(ctx, d_from: date, d_to: date, scope: set[str]) -> Gen:
    rows = await _recs(ctx, "feedback.feedback", since=metrics._rng(d_from, d_to)[0], limit=5000)
    end = metrics._rng(d_from, d_to)[1]
    rows = [r for r in rows if (_ts(r.get("submitted_at")) or _ts(r.get("created_at")) or now()) < end]
    scrub = _scrubber(None)
    assignments, agg = [], defaultdict(lambda: {"mentions": 0, "negative": 0, "departments": Counter(), "samples": []})
    sentiments = Counter()
    for r in rows:
        themes, sent = classify_feedback(r.get("comments"), r.get("rating"))
        sentiments[sent] += 1
        assignments.append({"id": r["id"], "themes": themes, "sentiment": sent})
        dept = (r.get("_refs") or {}).get(r.get("department"))
        for t in themes:
            a = agg[t]
            a["mentions"] += 1
            if sent == "Negative":
                a["negative"] += 1
                if r.get("comments") and len(a["samples"]) < 3:
                    a["samples"].append(_clip(scrub(r["comments"]), 200))
            if dept:
                a["departments"][dept] += 1
    cat = {n: c for n, c, _ in THEMES}
    themes = sorted(([{"theme": t, "category": cat.get(t, "Other"), "mentions": a["mentions"],
                       "negative_share": round(a["negative"] / a["mentions"] * 100, 1) if a["mentions"] else 0,
                       "departments": [d for d, _ in a["departments"].most_common(4)], "sample_comments": a["samples"]}
                      for t, a in agg.items()]), key=lambda x: (-x["mentions"] * (1 + x["negative_share"] / 100)))
    week_start = d_to - timedelta(days=d_to.weekday())
    ratings = [_num(r.get("rating")) for r in rows if _num(r.get("rating")) is not None]
    nps_vals = [_num(r.get("nps")) for r in rows if _num(r.get("nps")) is not None]
    nps = round((sum(v >= 9 for v in nps_vals) - sum(v <= 6 for v in nps_vals)) / len(nps_vals) * 100) if nps_vals else None
    ctxd = {"period_days": (d_to - d_from).days + 1, "responses": len(rows), "avg_rating": round(mean(ratings), 2) if ratings else None,
            "nps": nps, "sentiment": dict(sentiments), "themes": themes}
    lines = [f"FEEDBACK THEMES — {d_from:%d %b} to {d_to:%d %b %Y} · {len(rows)} responses"
             + (f" · avg rating {ctxd['avg_rating']}★" if ratings else "") + (f" · NPS {nps:+d}" if nps is not None else ""),
             "Sentiment: " + (", ".join(f"{k} {v}" for k, v in sentiments.most_common()) or "no responses"), ""]
    for t in themes:
        lines.append(f"• {t['theme']} ({t['category']}): {t['mentions']} mentions, {t['negative_share']:.0f}% negative"
                     + (f" — {', '.join(t['departments'])}" if t["departments"] else ""))
        for sc in t["sample_comments"][:2]:
            lines.append(f"    “{sc}”")
    if not themes:
        lines.append("• No recurring themes detected in this period.")
    return Gen(context=ctxd, draft="\n".join(lines), categories=[], sources=[f"{len(rows)} feedback responses"],
               target="feedback.themes", confidence=65 if rows else 30,
               output={"assignments": assignments, "themes": themes, "week_start": week_start.isoformat()},
               instructions="Write a quality-team digest: overall sentiment in one sentence, then the top themes with mention counts, "
                            "negative share and one representative (already anonymised) comment each, then 2-3 suggested focus areas "
                            "that follow directly from the numbers.")


# ====================================================================== applying approved drafts

async def apply_draft(ctx, draft: dict) -> str | None:
    """Write an approved draft to its target. Returns 'module.entity:id' (or a summary) of what changed."""
    uc = draft.get("draft_type")
    out = draft.get("output") or {}
    if uc == "Discharge Summary":
        return await _apply_discharge(ctx, draft, out)
    if uc == "Progress Note":
        note = await create(ctx, "emr.notes", {
            "patient_id": draft.get("patient_id") or out.get("patient_id"), "encounter_id": draft.get("encounter_id") or out.get("encounter_id"),
            "note_type": "Progress Note", "noted_at": now().isoformat(timespec="minutes"), "author": ctx.user.get("employee_id"),
            "note": draft.get("content"), "status": "Draft", "ai_drafted": True, "ai_draft": draft["id"],
        })
        return f"emr.notes:{note['id']}"
    if uc == "Task Prioritisation":
        n = 0
        for t in out.get("tasks") or []:
            await create(ctx, "ai.tasks", {k: t.get(k) for k in ("task", "task_type", "priority", "priority_score", "reason", "ward",
                                                                  "assigned_role", "source_record", "due_at", "patient_id")}
                         | {"status": "Suggested", "draft": draft["id"]})
            n += 1
        return f"ai.tasks: {n} suggestions"
    if uc in ("TAT Bottlenecks", "Anomaly Alert"):
        n = 0
        for x in out.get("findings") or []:
            await create(ctx, "ai.insights", {k: x.get(k) for k in ("headline", "insight_type", "area", "metric", "observed_value",
                                                                     "expected_value", "deviation_percent", "severity", "explanation",
                                                                     "suggested_action")}
                         | {"detected_at": now().isoformat(timespec="minutes"), "status": "New", "draft": draft["id"]})
            n += 1
        return f"ai.insights: {n} findings"
    if uc == "Feedback Themes":
        return await _apply_feedback(ctx, draft, out)
    return None


async def _apply_discharge(ctx, draft: dict, out: dict) -> str:
    sec = parse_sections(draft.get("content") or "")
    f = dict(out.get("fields") or {})
    if sec:
        for head, key in DISCHARGE_SECTIONS:
            if key and head in sec and sec[head]:
                f[key] = sec[head]
    else:
        f["hospital_course"] = draft.get("content")
    cond = str(f.get("condition_at_discharge") or "").strip()
    opts = ["Stable", "Improved", "Unchanged", "Deteriorated", "Referred", "Expired"]
    f["condition_at_discharge"] = next((o for o in opts if cond.lower().startswith(o.lower())), None)
    for k in ("admission_diagnosis", "final_diagnosis", "follow_up", "diet_advice", "activity_advice"):
        if f.get(k):
            f[k] = " ".join(str(f[k]).split())[:1000]
            if f[k].startswith("["):
                f[k] = None
    payload = {**f, "discharge_medications": out.get("discharge_medications") or None, "follow_up_date": out.get("follow_up_date"),
               "ai_drafted": True, "ai_draft": draft["id"]}
    payload = {k: v for k, v in payload.items() if v is not None}  # never blank out what the clinician already wrote
    sid = out.get("summary_id")
    existing = await get(ctx, "discharge.summaries", sid) if sid else None
    if not existing:
        found = await find(ctx, "discharge.summaries", encounter_id=out.get("encounter_id") or draft.get("encounter_id"), limit=1)
        existing = found[0] if found else None
    if existing:
        if existing.get("status") != "Draft":
            raise conflict(f"Discharge summary {existing['code']} is {existing['status']}; it can no longer be overwritten")
        rec = await update(ctx, "discharge.summaries", existing["id"], payload)
    else:
        rec = await create(ctx, "discharge.summaries", {
            **payload, "patient_id": draft.get("patient_id") or out.get("patient_id"),
            "encounter_id": draft.get("encounter_id") or out.get("encounter_id"),
            "consultant": out.get("consultant") or ctx.user.get("employee_id"), "discharge_date": today().isoformat(),
            "discharge_type": out.get("discharge_type") or "Routine", "status": "Draft",
            "final_diagnosis": payload.get("final_diagnosis") or payload.get("admission_diagnosis") or "To be confirmed",
        })
    return f"discharge.summaries:{rec['id']}"


async def _apply_feedback(ctx, draft: dict, out: dict) -> str:
    changed = 0
    for a in out.get("assignments") or []:
        fb = await get(ctx, "feedback.feedback", a["id"])
        if not fb:
            continue
        if sorted(fb.get("themes") or []) != sorted(a["themes"]) or fb.get("sentiment") != a["sentiment"]:
            await update(ctx, "feedback.feedback", a["id"], {"themes": a["themes"] or None, "sentiment": a["sentiment"]})
            changed += 1
    week = parse_date(out.get("week_start")) or (today() - timedelta(days=today().weekday()))
    prev_week = (week - timedelta(days=7)).isoformat()
    made = 0
    for t in out.get("themes") or []:
        prev = await find(ctx, "feedback.themes", theme=t["theme"], week_start=prev_week, limit=1)
        pm = _num(prev[0].get("mentions")) if prev else None
        trend = "New" if not pm else "Rising" if t["mentions"] >= pm * 1.2 else "Falling" if t["mentions"] <= pm * 0.8 else "Stable"
        data = {"theme": t["theme"], "category": t["category"], "week_start": week.isoformat(), "mentions": t["mentions"],
                "negative_share": t["negative_share"], "trend": trend, "departments": t["departments"] or None,
                "sample_comments": "\n".join(f"“{s}”" for s in t["sample_comments"]) or None, "draft": draft["id"]}
        cur = await find(ctx, "feedback.themes", theme=t["theme"], week_start=week.isoformat(), limit=1)
        if cur:
            await update(ctx, "feedback.themes", cur[0]["id"], data)
        else:
            await create(ctx, "feedback.themes", {**data, "status": "New"})
            made += 1
    return f"feedback.feedback: {changed} tagged; feedback.themes: {len(out.get('themes') or [])} for week of {week:%d %b}"


# ====================================================================== review (hooks guard every path)

async def _policy_of(ctx, d: dict) -> dict | None:
    pol = await get(ctx, "aigov.policies", d.get("policy")) if d.get("policy") else None
    return pol or await policy_for(ctx, d.get("draft_type") or "")


@hook("ai.drafts", "before_transition")
async def _guard_review(ctx, nxt: dict, prev: dict):
    if prev.get("status") != "Pending Review" or nxt.get("status") not in ("Approved", "Rejected"):
        return
    pol = await _policy_of(ctx, prev)
    roles = (pol or {}).get("reviewer_roles") or REVIEWER_ROLES
    if ctx.role not in roles:
        raise forbidden(f"AI policy {(pol or {}).get('code', '')} allows only {', '.join(roles)} to review {prev.get('draft_type')} drafts")
    if nxt["status"] == "Rejected" and not (nxt.get("review_notes") or "").strip():
        raise bad_request("Give a reason when rejecting an AI draft", {"fields": {"review_notes": "Required"}})
    nxt["reviewer"] = ctx.user.get("employee_id")


@hook("ai.drafts", "after_transition")
async def _on_review(ctx, rec: dict, prev: dict):
    if prev.get("status") != "Pending Review" or rec.get("status") not in ("Approved", "Rejected"):
        return
    pol = await _policy_of(ctx, rec)
    uc = rec.get("draft_type") or ""
    if rec["status"] == "Approved":
        target = await apply_draft(ctx, rec)
        await update(ctx, "ai.drafts", rec["id"], {"applied_target": target})
        await audit(ctx, "ai.approve", module="ai", entity="drafts", record=rec, after={"use_case": uc, "applied": target,
                                                                                        "edited": rec.get("content") != rec.get("generated_text")},
                    note=rec.get("review_notes"))
        await _ai_log(ctx, "Approved", uc, policy=pol, draft=rec, model=rec.get("model"), excerpt=target or rec.get("review_notes"))
    else:
        await audit(ctx, "ai.reject", module="ai", entity="drafts", record=rec, after={"use_case": uc}, note=rec.get("review_notes"))
        await _ai_log(ctx, "Rejected", uc, policy=pol, draft=rec, model=rec.get("model"), excerpt=rec.get("review_notes"))


# ====================================================================== endpoints

class RangeIn(BaseModel):
    date_from: str | None = Field(default=None, alias="from")
    date_to: str | None = Field(default=None, alias="to")

    model_config = {"populate_by_name": True}

    def bounds(self, default_days: int) -> tuple[date, date]:
        try:
            d_to = parse_date(self.date_to) or today()
            d_from = parse_date(self.date_from) or d_to - timedelta(days=default_days - 1)
        except ValueError as e:
            raise bad_request("Dates must be YYYY-MM-DD") from e
        if d_from > d_to:
            raise bad_request("'from' must be on or before 'to'")
        if (d_to - d_from).days > 92:
            raise bad_request("Choose a range of at most 92 days")
        return d_from, d_to


@router.post("/patients/{pid}/summary")
async def patient_summary(pid: str, ctx: CtxDep):
    await _patient(ctx, pid)
    return await run_use_case(ctx, "Patient Summary", lambda sc: build_patient_summary(ctx, pid, sc), patient_id=pid)


@router.post("/encounters/{eid}/progress-note")
async def progress_note(eid: str, ctx: CtxDep):
    enc = await _enc_info(ctx, eid)
    return await run_use_case(ctx, "Progress Note", lambda sc: build_progress_note(ctx, eid, sc),
                              patient_id=str(enc["patient_id"]), encounter_id=eid)


@router.post("/encounters/{eid}/discharge-summary")
async def discharge_summary(eid: str, ctx: CtxDep):
    enc = await _enc_info(ctx, eid)
    return await run_use_case(ctx, "Discharge Summary", lambda sc: build_discharge_summary(ctx, eid, sc),
                              patient_id=str(enc["patient_id"]), encounter_id=eid)


@router.post("/wards/{ward_id}/prioritise")
async def prioritise(ward_id: str, ctx: CtxDep):
    if not is_uuid(ward_id) or not await get(ctx, "mdm.wards", ward_id):
        raise not_found("Ward not found")
    return await run_use_case(ctx, "Task Prioritisation", lambda sc: build_task_priorities(ctx, ward_id, sc))


@router.post("/ops/tat")
async def ops_tat(ctx: CtxDep, body: RangeIn | None = None):
    d_from, d_to = (body or RangeIn()).bounds(7)
    return await run_use_case(ctx, "TAT Bottlenecks", lambda sc: build_tat(ctx, d_from, d_to, sc))


@router.post("/ops/anomalies")
async def ops_anomalies(ctx: CtxDep):
    return await run_use_case(ctx, "Anomaly Alert", lambda sc: build_anomalies(ctx, sc))


@router.post("/feedback/themes")
async def feedback_themes(ctx: CtxDep, body: RangeIn | None = None):
    d_from, d_to = (body or RangeIn()).bounds(30)
    return await run_use_case(ctx, "Feedback Themes", lambda sc: build_feedback_themes(ctx, d_from, d_to, sc))


@router.get("/drafts")
async def drafts(ctx: CtxDep, status: str | None = None, draft_type: str | None = None, patient_id: str | None = None,
                 page: int = 1, limit: int = 50):
    filters = {"draft_type": draft_type} if draft_type else None
    res = await rs.list_records(ctx, E("ai.drafts"), status=status, filters=filters, patient_id=patient_id, sort="-created_at",
                                page=page, limit=min(limit, 200))
    res["rows"] = [_public(r, full=False) for r in res["rows"]]
    return res


@router.get("/drafts/{did}")
async def draft_detail(did: str, ctx: CtxDep):
    d = await rs.get_record(ctx, E("ai.drafts"), did)
    pol = await _policy_of(ctx, d)
    if d.get("status") == "Pending Review":
        await _ai_log(ctx, "Viewed", d.get("draft_type") or "", policy=pol, draft=d, model=d.get("model"))
    d["_transitions"] = rs.allowed_transitions(E("ai.drafts"), d, ctx.role)
    return {"draft": d, "policy": pol, "can_review": ctx.role in ((pol or {}).get("reviewer_roles") or REVIEWER_ROLES)}


class ReviewIn(BaseModel):
    approve: bool
    edited_content: str | None = Field(default=None, max_length=20000)
    notes: str | None = Field(default=None, max_length=2000)


@router.post("/drafts/{did}/review")
async def review(did: str, body: ReviewIn, ctx: CtxDep):
    d = await get(ctx, "ai.drafts", did)
    if not d:
        raise not_found("AI draft not found")
    if d.get("status") != "Pending Review":
        raise conflict(f"This draft is already {d.get('status')}")
    pol = await _policy_of(ctx, d)
    roles = (pol or {}).get("reviewer_roles") or REVIEWER_ROLES
    if ctx.role not in roles:
        raise forbidden(f"Only {', '.join(roles)} may review {d.get('draft_type')} drafts")
    if not body.approve and not (body.notes or "").strip():
        raise bad_request("Give a reason when rejecting an AI draft")
    if body.approve and body.edited_content is not None and body.edited_content.strip() != (d.get("content") or "").strip():
        if not body.edited_content.strip():
            raise bad_request("The edited draft is empty")
        d = await update(ctx, "ai.drafts", did, {"content": body.edited_content.strip()})
        await _ai_log(ctx, "Edited", d.get("draft_type") or "", policy=pol, draft=d, model=d.get("model"), excerpt=d["content"])
    rec = await rs.transition_record(ctx, E("ai.drafts"), did, "Approved" if body.approve else "Rejected",
                                     values={"review_notes": body.notes} if body.notes else None, check=False)
    rec = await get(ctx, "ai.drafts", did)
    return {"draft": _public(rec), "applied": rec.get("applied_target")}


@router.get("/use-cases")
async def use_cases(ctx: CtxDep):
    """Policy summary per use case for the console and the governance page."""
    pols = await find(ctx, "aigov.policies", limit=100)
    by: dict[str, dict] = {}
    for p in sorted(pols, key=lambda r: r.get("status") != "Active"):
        by.setdefault(p.get("use_case"), p)
    out = []
    for uc in USE_CASES:
        p = by.get(uc)
        allowed = (p or {}).get("allowed_roles") or []
        out.append({
            "use_case": uc, "policy": p and {k: p.get(k) for k in ("id", "code", "status", "risk_class", "ai_may", "review_required",
                                                                    "reviewer_roles", "allowed_roles", "data_scope", "deidentify",
                                                                    "consent_required", "approved_models", "retention_days", "review_due")},
            "enabled": bool(p) and p.get("status") == "Active" and p.get("risk_class") != "Prohibited",
            "can_invoke": bool(p) and (ctx.role == "admin" or ctx.role in allowed or (not allowed and ctx.role in ("doctor", "nurse", "management", "quality"))),
            "can_review": bool(p) and ctx.role in ((p or {}).get("reviewer_roles") or REVIEWER_ROLES),
            "review_always": uc in CLINICAL,
        })
    return {"use_cases": out, "llm": {"configured": bool(settings.anthropic_api_key), "model": settings.ai_model if settings.anthropic_api_key else RULE_MODEL}}


@router.get("/audit")
async def ai_audit(ctx: CtxDep, use_case: str | None = None, event: str | None = None, actor: str | None = None,
                   date_from: str | None = None, date_to: str | None = None, page: int = 1, limit: int = 50):
    filters = {k: v for k, v in (("use_case", use_case), ("event", event), ("actor", actor)) if v}
    res = await rs.list_records(ctx, E("aigov.audit_log"), filters=filters or None, date_from=date_from, date_to=date_to,
                                sort="-occurred_at", page=page, limit=min(limit, 200))
    since = now() - timedelta(days=30)
    t = records
    base = [t.c.module == "aigov", t.c.entity == "audit_log", t.c.deleted_at.is_(None), t.c.created_at >= since]
    by = (await ctx.conn.execute(sa.select(t.c.data["use_case"].astext, t.c.data["event"].astext, sa.func.count())
                                 .where(*base).group_by(sa.text("1"), sa.text("2")))).all()
    stats: dict[str, dict[str, int]] = defaultdict(dict)
    for uc, ev, n in by:
        stats[uc or "—"][ev or "—"] = n
    res["stats_30d"] = stats
    return res


__all__ = ["router", "run_use_case", "apply_draft", "policy_for", "news2", "vital_flags", "classify_feedback", "parse_sections"]
