"""Laboratory suite (LIS) on top of the orders engine.

The order lifecycle (Ordered → Collected → In Progress → Resulted → Verified) and its rules live in
`orders.py`; this engine adds the laboratory's own screens and rules:

* test catalogue view, bulk sample collection by patient / ward with tube planning and labels,
* sample acceptance by scan (receive / reject → recollect),
* section / analyser worksheets with age- and sex-specific reference ranges, delta checks against the
  previous result, reflex rules and analyser-output import (interface values),
* the authorised-reports workspace (patient-wise report viewer, print with / without letterhead or as a
  smart report with trends, roll back authorisation with a reason),
* rejected reports, audited result cancellation and re-runs, sample tracking per barcode,
* microbiology culture & sensitivity, and out-sourcing to reference labs.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import hook
from ..core.rbac import check_access, require_page
from ..core.registry import get_entity
from ..core.security import CtxDep
from ..core.sequences import next_seq
from ..core.util import (
    ApiError,
    bad_request,
    conflict,
    day_bounds,
    forbidden,
    is_uuid,
    not_found,
    now,
    parse_date,
    to_json_value,
    today,
)
from ..schema import audit_log, beds, charges, employees, encounters, invoices, orders, patients, records, services
from . import orders as ordx
from ._common import E, create, find, get, has, live, require_role, transition, update

router = APIRouter(prefix="/api/lab", tags=["lab"])

ORD = ordx.ORD
LAB_ORDERS = "lab.lab_orders"
TESTS, SAMPLES = "lab.tests", "lab.samples"
RANGES, REFLEX, DELTA = "lab.ref_ranges", "lab.reflex_rules", "lab.delta_rules"
TEMPLATES, SECTIONS, ANALYZERS = "lab.report_templates", "lab.sections", "lab.analyzers"
ANTIBIOTICS, REF_LABS, SEND_OUTS = "lab.antibiotics", "lab.reference_labs", "lab.send_outs"

PENDING = ("Collected", "In Progress")
IP_TYPES = ("IPD", "DAYCARE")
FLAG_CODE = {"Low": "L", "High": "H", "Critical Low": "LL", "Critical High": "HH", "Abnormal": "A"}
UNIT_DAYS = {"Days": 1.0, "Months": 30.4375, "Years": 365.25}
REJECT_REASONS = ("Haemolysed", "Clotted", "Insufficient quantity", "Wrong container", "Unlabelled", "Delayed transport")
TRANSIT_ALERT_MIN = 120  # tubes not received within 2 hours of collection are flagged (sample stability)

DEFAULT_TEMPLATE = {"name": "Standard laboratory report", "layout": "Tabular", "show_method": True, "show_previous": False,
                    "footer_text": "Results relate only to the sample received. Please correlate clinically. "
                                   "Critical values have been communicated to the treating team."}

ORGANISMS: list[tuple[str, str]] = [
    ("Escherichia coli", "Gram-negative"), ("Klebsiella pneumoniae", "Gram-negative"), ("Proteus mirabilis", "Gram-negative"),
    ("Enterobacter cloacae", "Gram-negative"), ("Citrobacter freundii", "Gram-negative"), ("Salmonella Typhi", "Gram-negative"),
    ("Salmonella Paratyphi A", "Gram-negative"), ("Pseudomonas aeruginosa", "Pseudomonas"), ("Acinetobacter baumannii", "Pseudomonas"),
    ("Burkholderia cepacia", "Pseudomonas"), ("Stenotrophomonas maltophilia", "Pseudomonas"), ("Staphylococcus aureus", "Gram-positive"),
    ("Staphylococcus aureus (MRSA)", "Gram-positive"), ("Coagulase-negative Staphylococcus", "Gram-positive"),
    ("Streptococcus pneumoniae", "Gram-positive"), ("Streptococcus pyogenes", "Gram-positive"), ("Enterococcus faecalis", "Enterococcus"),
    ("Enterococcus faecium", "Enterococcus"), ("Candida albicans", "Fungal"), ("Candida tropicalis", "Fungal"), ("Candida auris", "Fungal"),
]
BUILTIN_PANELS: dict[str, list[str]] = {
    "Gram-negative": ["Ampicillin", "Amoxicillin-clavulanate", "Piperacillin-tazobactam", "Cefuroxime", "Ceftriaxone", "Cefepime",
                      "Cefoperazone-sulbactam", "Ertapenem", "Imipenem", "Meropenem", "Amikacin", "Gentamicin", "Ciprofloxacin",
                      "Levofloxacin", "Trimethoprim-sulfamethoxazole", "Colistin", "Tigecycline"],
    "Pseudomonas": ["Piperacillin-tazobactam", "Ceftazidime", "Cefepime", "Aztreonam", "Imipenem", "Meropenem", "Amikacin",
                    "Gentamicin", "Tobramycin", "Ciprofloxacin", "Levofloxacin", "Colistin"],
    "Gram-positive": ["Penicillin", "Cefoxitin screen", "Erythromycin", "Clindamycin", "Gentamicin", "Ciprofloxacin",
                      "Trimethoprim-sulfamethoxazole", "Doxycycline", "Linezolid", "Vancomycin", "Teicoplanin", "Rifampicin"],
    "Enterococcus": ["Ampicillin", "High-level gentamicin", "Vancomycin", "Teicoplanin", "Linezolid", "Nitrofurantoin", "Ciprofloxacin"],
    "Urinary": ["Nitrofurantoin", "Fosfomycin", "Norfloxacin", "Cefazolin (urinary)"],
    "Fungal": ["Fluconazole", "Voriconazole", "Amphotericin B", "Caspofungin", "Micafungin", "Flucytosine"],
    "Anaerobes": ["Metronidazole", "Clindamycin", "Piperacillin-tazobactam", "Meropenem"],
}
SPECIMENS = ["Blood", "Urine (midstream)", "Urine (catheter)", "Sputum", "Endotracheal aspirate", "BAL", "Pus", "Wound swab",
             "Throat swab", "CSF", "Pleural fluid", "Ascitic fluid", "Stool", "Tissue", "Catheter tip", "Other"]


def _stamp() -> str:
    return now().isoformat(timespec="seconds")


def _read(ctx) -> None:
    rs.ensure_access(ctx, E(LAB_ORDERS), "read")


# Who may use which lab screen (admin always) — the roles & permissions matrix decides, and the orders
# engine's own role rules (collect: lab / nurse; receive, result: lab; authorise: lab / doctor) apply on top.
# The web shows a screen or action only when these checks would pass.
BENCH_PAGE = ("lab", "lab-worklist")


def _bench(ctx, *, edit: bool = False, roles: tuple[str, ...] = ("lab",)) -> None:
    """Bench screens (accept, worksheet, micro, out-sourcing): visible with the worklist page; acting needs edit."""
    require_page(ctx, *BENCH_PAGE, "edit" if edit else "read")
    if edit:
        require_role(ctx, *roles)


def _collector(ctx, *, write: bool = False) -> None:
    require_role(ctx, *ordx.COLLECT_ROLES)
    mode = "write" if write else "read"
    if not any(check_access(ctx.user, E(f).module, E(f), mode).ok for f in (ORD, LAB_ORDERS)):
        raise forbidden("Your role cannot collect samples")


def _name(first: str | None, last: str | None) -> str:
    return " ".join(x for x in (first, last) if x) or "—"


def _sex(g: str | None) -> str | None:
    g = (g or "").strip().lower()
    return "Male" if g.startswith("m") else "Female" if g.startswith("f") else None


def _age_label(dob) -> tuple[str | None, int | None]:
    if not dob:
        return None, None
    d = dob if not isinstance(dob, str) else parse_date(dob)
    days = (today() - d).days
    if days >= 365:
        y = today().year - d.year - ((today().month, today().day) < (d.month, d.day))
        return f"{y}Y", days
    if days >= 31:
        return f"{days // 30}M", days
    return f"{days}D", days


def _num(v: Any) -> float | None:
    return ordx._num(v) if v not in (None, "") else None


def _range_bounds(start: str | None, end: str | None) -> tuple[datetime, datetime]:
    d1 = parse_date(start) if start else today()
    d2 = parse_date(end) if end else d1
    if d2 < d1:
        d1, d2 = d2, d1
    if (d2 - d1).days > 366:
        raise bad_request("Choose a date range of one year or less")
    return day_bounds(d1)[0], day_bounds(d2)[1]


# ================================================================== patients, ranges, parameters

async def _demo(ctx, pids) -> dict[str, dict]:
    ids = [p for p in {str(x) for x in pids if x} if is_uuid(p)]
    if not ids:
        return {}
    p = patients
    rows = (await ctx.conn.execute(sa.select(p.c.id, p.c.code, p.c.first_name, p.c.last_name, p.c.gender, p.c.dob, p.c.phone, p.c.data)
                                   .where(p.c.id.in_(ids)))).all()
    out = {}
    for r in rows:
        label, days = _age_label(r.dob)
        out[str(r.id)] = {"id": str(r.id), "name": _name(r.first_name, r.last_name), "uhid": r.code, "gender": r.gender,
                          "sex": _sex(r.gender), "age": label, "age_days": days, "phone": r.phone,
                          "referred_by": (r.data or {}).get("referred_by")}
    return out


async def _active_rows(ctx, fqn: str, *conds) -> list[dict]:
    ent = get_entity(fqn)
    if not ent:
        return []
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t).where(*rs.base_where(ent), sa.func.coalesce(t.c.status, "Active") == "Active", *conds)
                                   .order_by(t.c.created_at))).all()
    return [rs.to_record(r) for r in rows]


async def _ranges(ctx, service_ids) -> dict[str, list[dict]]:
    ids = [s for s in {str(x) for x in service_ids if x} if is_uuid(s)]
    if not ids:
        return {}
    out: dict[str, list[dict]] = defaultdict(list)
    for r in await _active_rows(ctx, RANGES, records.c.data["test"].astext.in_(ids)):
        out[r.get("test")].append(r)
    return out


def _pick_range(ranges: list[dict], parameter: str, sex: str | None, age_days: int | None) -> dict | None:
    """Most specific matching range: a sex-specific range beats 'Any', then the narrowest age band."""
    best, best_key = None, None
    for r in ranges:
        if str(r.get("parameter") or "").strip().lower() != parameter:
            continue
        rsex = r.get("sex") or "Any"
        if rsex != "Any" and rsex != sex:
            continue
        unit = UNIT_DAYS.get(r.get("age_unit") or "Years", 365.25)
        lo = float(r.get("age_from") or 0) * unit
        hi = float(r["age_to"]) * unit if r.get("age_to") not in (None, "") else 1e9
        if age_days is not None and not (lo <= age_days <= hi):
            continue
        key = (rsex == "Any", hi - lo)
        if best_key is None or key < best_key:
            best, best_key = r, key
    return best


def patient_params(svc: dict | None, ranges: list[dict], sex: str | None, age_days: int | None) -> list[dict]:
    """The test's parameters with the reference / critical limits that apply to this patient (age, sex)."""
    out = []
    for p in (svc or {}).get("parameters") or []:
        name = str(p.get("parameter") or "").strip()
        if not name:
            continue
        m = {**p, "parameter": name}
        r = _pick_range(ranges, name.lower(), sex, age_days)
        if r:
            if r.get("ref_low") not in (None, "") or r.get("ref_high") not in (None, ""):
                m["ref_low"], m["ref_high"] = r.get("ref_low"), r.get("ref_high")
            if r.get("critical_low") not in (None, "") or r.get("critical_high") not in (None, ""):
                m["critical_low"], m["critical_high"] = r.get("critical_low"), r.get("critical_high")
            for k in ("unit", "display_text"):
                if r.get(k):
                    m[k] = r[k]
            if r.get("note") and not m.get("note"):
                m["note"] = r["note"]
            m["range_basis"] = f"{r.get('sex') or 'Any'} · {r.get('age_from') or 0}–{r.get('age_to') or '∞'} {(r.get('age_unit') or 'Years').lower()}"
        m["ref_range"] = m.get("display_text") or ordx.ref_range(m)
        out.append(m)
    return out


async def _services(ctx, ids) -> dict[str, dict]:
    want = [s for s in {str(x) for x in ids if x} if is_uuid(s)]
    if not want:
        return {}
    rows = (await ctx.conn.execute(sa.select(services).where(services.c.id.in_(want)))).all()
    return {str(r.id): rs.to_record(r) for r in rows}


def _values_map(values: list[dict] | None) -> dict[str, dict]:
    return {str(v.get("parameter") or "").strip().lower(): v for v in values or [] if v.get("parameter")}


async def _previous_results(ctx, pairs: set[tuple[str, str]], *, days: int = 730, per_pair: int = 6,
                            exclude: set[str] | None = None) -> dict[tuple[str, str], list[dict]]:
    """Verified results of the same test for the same patient, newest first."""
    if not pairs:
        return {}
    o = orders
    pids = list({p for p, _ in pairs})
    sids = list({s for _, s in pairs if s})
    rows = (await ctx.conn.execute(sa.select(o.c.id, o.c.code, o.c.patient_id, o.c.service_id, o.c.verified_at, o.c.data).where(
        o.c.deleted_at.is_(None), o.c.category == "LAB", o.c.status == "Verified", o.c.patient_id.in_(pids), o.c.service_id.in_(sids),
        o.c.verified_at >= now() - timedelta(days=days)).order_by(o.c.verified_at.desc()))).all()
    out: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        key = (str(r.patient_id), str(r.service_id))
        if key not in pairs or (exclude and str(r.id) in exclude) or len(out[key]) >= per_pair:
            continue
        out[key].append({"order_id": str(r.id), "code": r.code, "verified_at": to_json_value(r.verified_at),
                         "values": (r.data or {}).get("result_values") or []})
    return out


# ================================================================== delta checks & reflex rules

async def _delta_rules(ctx, svc: dict) -> dict[str, dict]:
    rules: dict[str, dict] = {}
    for p in svc.get("parameters") or []:
        if p.get("parameter") and p.get("delta_percent") not in (None, ""):
            rules[str(p["parameter"]).strip().lower()] = {"max_change_percent": float(p["delta_percent"]), "window_days": 30,
                                                          "action": "Flag for review", "source": "test"}
    for r in await _active_rows(ctx, DELTA):
        if r.get("test") and r.get("test") != svc.get("id"):
            continue
        key = str(r.get("parameter") or "").strip().lower()
        if key and (r.get("test") or key not in rules or rules[key].get("source") == "test"):
            rules[key] = {"max_change_percent": r.get("max_change_percent"), "max_change_absolute": r.get("max_change_absolute"),
                          "window_days": int(r.get("window_days") or 30), "action": r.get("action") or "Flag for review",
                          "source": r.get("code")}
    return rules


def evaluate_deltas(values: list[dict], rules: dict[str, dict], prev: dict | None) -> list[dict]:
    if not rules or not prev:
        return []
    prev_at = datetime.fromisoformat(prev["verified_at"]) if prev.get("verified_at") else None
    pv = _values_map(prev.get("values"))
    out = []
    for v in values:
        key = str(v.get("parameter") or "").strip().lower()
        rule = rules.get(key)
        old = pv.get(key)
        if not rule or not old:
            continue
        if prev_at and prev_at < now() - timedelta(days=int(rule.get("window_days") or 30)):
            continue
        cur_n, old_n = _num(v.get("value")), _num(old.get("value"))
        if cur_n is None or old_n is None:
            continue
        diff = cur_n - old_n
        pct = abs(diff) / abs(old_n) * 100 if old_n else None
        lim_pct, lim_abs = rule.get("max_change_percent"), rule.get("max_change_absolute")
        failed = bool((lim_pct not in (None, "") and pct is not None and pct > float(lim_pct))
                      or (lim_abs not in (None, "") and abs(diff) > float(lim_abs)))
        limit = " / ".join(x for x in (f"{float(lim_pct):g}%" if lim_pct not in (None, "") else None,
                                       f"±{float(lim_abs):g}" if lim_abs not in (None, "") else None) if x)
        out.append({"parameter": v.get("parameter"), "current": v.get("value"), "previous": old.get("value"),
                    "previous_at": prev.get("verified_at"), "previous_order": prev.get("code"), "change": round(diff, 3),
                    "change_percent": round(pct, 1) if pct is not None else None, "limit": limit, "failed": failed,
                    "hold": failed and rule.get("action") == "Hold authorisation", "rule": rule.get("source")})
    return out


def _rule_hit(rule: dict, values: dict[str, dict]) -> dict | None:
    v = values.get(str(rule.get("parameter") or "").strip().lower())
    if not v or v.get("value") in (None, ""):
        return None
    op, target = rule.get("operator") or ">", str(rule.get("value") or "").strip()
    raw = str(v.get("value"))
    if op == "Flag is":
        flag = str(v.get("flag") or "")
        return v if flag and (flag.lower() == target.lower() or target.lower() in flag.lower()) else None
    if op == "Contains":
        return v if target.lower() in raw.lower() else None
    n, t = _num(raw), _num(target)
    if op == "=":
        return v if (n is not None and t is not None and n == t) or raw.strip().lower() == target.lower() else None
    if n is None or t is None:
        return None
    hit = {">": n > t, ">=": n >= t, "<": n < t, "<=": n <= t}.get(op, False)
    return v if hit else None


async def _reflex(ctx, rec: dict, values: list[dict], svc: dict) -> list[dict]:
    existing = {s.get("rule_id"): s for s in rec.get("reflex_suggestions") or [] if s.get("rule_id")}
    vmap = _values_map(values)
    out, seen = [], set()
    rules = [r for r in await _active_rows(ctx, REFLEX, records.c.data["test"].astext == str(svc.get("id")))] if svc.get("id") else []
    targets = await _services(ctx, [r.get("reflex_test") for r in rules])
    for r in rules:
        v = _rule_hit(r, vmap)
        if not v:
            continue
        seen.add(r["id"])
        if r["id"] in existing:
            out.append(existing[r["id"]])
            continue
        t = targets.get(r.get("reflex_test") or "") or {}
        out.append({"rule_id": r["id"], "rule": r.get("name"), "service_id": r.get("reflex_test"), "test": t.get("name") or t.get("title"),
                    "reason": f"{v.get('parameter')} {v.get('value')} ({r.get('operator')} {r.get('value')})",
                    "action": r.get("action") or "Suggest to pathologist", "comment": r.get("comment"), "status": "Suggested"})
    out += [s for rid, s in existing.items() if rid not in seen and s.get("status") == "Ordered"]
    return out


async def annotate(ctx, rec: dict) -> dict | None:
    """Patient-specific flags (age / sex reference ranges), delta checks and reflex suggestions for a lab result."""
    if rec.get("category") != "LAB" or not rec.get("result_values"):
        return None
    sid = rec.get("service_id")
    svc = (await _services(ctx, [sid])).get(str(sid)) or {}
    demo = (await _demo(ctx, [rec.get("patient_id")])).get(str(rec.get("patient_id"))) or {}
    ranges = (await _ranges(ctx, [sid])).get(str(sid), [])
    params = {p["parameter"].lower(): p for p in patient_params(svc, ranges, demo.get("sex"), demo.get("age_days"))}
    values, critical = [], False
    for v in rec["result_values"]:
        name = str(v.get("parameter") or "").strip()
        p = params.get(name.lower())
        computed = ordx.flag_for(v.get("value"), p)
        flag = computed if computed is not None else (v.get("flag") if v.get("flag") in ordx.FLAGS else None)
        values.append({"parameter": name, "value": v.get("value"), "unit": (p or {}).get("unit") or v.get("unit"),
                       "ref_range": (p or {}).get("ref_range") or v.get("ref_range"), "flag": flag})
        critical = critical or str(flag or "").startswith("Critical")
    prev = (await _previous_results(ctx, {(str(rec["patient_id"]), str(sid))}, days=365, per_pair=1, exclude={rec["id"]})).get(
        (str(rec["patient_id"]), str(sid)), [])
    deltas = evaluate_deltas(values, await _delta_rules(ctx, svc), prev[0] if prev else None)
    patch = {"result_values": values, "critical": bool(rec.get("critical") or critical), "delta_checks": deltas,
             "reflex_suggestions": await _reflex(ctx, rec, values, svc)}
    if any(d["hold"] for d in deltas):
        patch.update(delta_reviewed_at=None, delta_reviewed_by=None)
    return patch


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


async def _order_reflex(ctx, rec: dict, s: dict) -> dict:
    """Place the reflex test as a new order on the same patient / visit, attributed to the original prescriber."""
    new = await create(ctx, ORD, {
        "patient_id": rec["patient_id"], "encounter_id": rec.get("encounter_id"), "service_id": s["service_id"], "category": "LAB",
        "priority": rec.get("priority") or "Routine", "ordering_doctor": rec.get("ordering_doctor"),
        "clinical_notes": f"Reflex test ({s.get('rule')}): {s.get('reason')}", "status": "Ordered",
        "reflex_of": rec["id"], "entered_by": ctx.user.get("name") or "LIS reflex rule", "verbal_order": False,
    })
    await audit(ctx, "lab.reflex", module="lab", entity="lab_orders", record=rec, after={"ordered": new.get("code"), "rule": s.get("rule")},
                note=s.get("reason"))
    return {**s, "status": "Ordered", "order_id": new["id"], "order_code": new.get("code"), "ordered_at": _stamp(),
            "ordered_by": ctx.user.get("name")}


async def _after_result(ctx, rec: dict) -> None:
    """Side effects once a lab result is written: alert newly-critical values, place automatic reflex tests."""
    alerts: set = ctx.__dict__.setdefault("_lab_alert", set())
    if rec["id"] in alerts:
        alerts.discard(rec["id"])
        await ordx._alert_critical(ctx, rec)
    sugg = rec.get("reflex_suggestions") or []
    if any(s.get("action") == "Auto-order" and s.get("status") == "Suggested" for s in sugg):
        out = [await _order_reflex(ctx, rec, s) if s.get("action") == "Auto-order" and s.get("status") == "Suggested" else s for s in sugg]
        ctx.__dict__["_lab_annotating"] = True
        try:
            await update(ctx, ORD, rec["id"], {"reflex_suggestions": out})
        finally:
            ctx.__dict__["_lab_annotating"] = False


async def _bu(ctx, nxt: dict, prev: dict) -> None:
    if nxt.get("category") != "LAB" or ctx.__dict__.get("_lab_annotating"):
        return
    if nxt.get("status") not in ("Resulted", "Verified") or _same(nxt.get("result_values"), prev.get("result_values")):
        return
    patch = await annotate(ctx, nxt)
    if not patch:
        return
    if patch["critical"] and not nxt.get("critical_notified_at"):
        patch["critical_notified_at"] = _stamp()
        ctx.__dict__.setdefault("_lab_alert", set()).add(nxt["id"])
    nxt.update(patch)


async def _au(ctx, rec: dict, prev: dict) -> None:
    if rec.get("category") == "LAB" and not ctx.__dict__.get("_lab_annotating"):
        await _after_result(ctx, rec)


async def _bt(ctx, nxt: dict, prev: dict) -> None:
    if nxt.get("category") != "LAB" or nxt.get("status") != "Verified":
        return
    holds = [d for d in nxt.get("delta_checks") or [] if d.get("hold")]
    if holds and not nxt.get("delta_reviewed_at"):
        names = ", ".join(f"{d['parameter']} ({d['previous']} → {d['current']})" for d in holds[:3])
        raise ApiError(409, f"Delta check hold: {names}. Review the delta on the worksheet before authorising.",
                       {"delta_checks": holds}, code="DELTA_HOLD")


async def _at(ctx, rec: dict, prev: dict) -> None:
    if rec.get("category") != "LAB" or rec.get("status") != "Resulted":
        return
    patch = await annotate(ctx, rec)
    if patch and not all(_same(rec.get(k), v) for k, v in patch.items()):
        if patch["critical"] and not rec.get("critical_notified_at"):
            patch["critical_notified_at"] = _stamp()
            ctx.__dict__.setdefault("_lab_alert", set()).add(rec["id"])
        ctx.__dict__["_lab_annotating"] = True
        try:
            rec = await update(ctx, ORD, rec["id"], patch)
        finally:
            ctx.__dict__["_lab_annotating"] = False
    await _after_result(ctx, rec)


for _f in (ORD, LAB_ORDERS):
    hook(_f, "before_update")(_bu)
    hook(_f, "after_update")(_au)
    hook(_f, "before_transition")(_bt)
    hook(_f, "after_transition")(_at)


# ================================================================== row helpers

def _query():
    """Order rows with patient / test / visit / bed — orders' worklist shape plus the ward id."""
    return ordx._order_query().add_columns(beds.c.ward_id, encounters.c.code.label("enc_code"))


async def _rows(ctx, stmt, limit: int = 3000) -> list[dict]:
    ts = now()
    rows = (await ctx.conn.execute(stmt.limit(limit))).all()
    names = await ordx._employee_names(ctx, rows)
    out = []
    for r in rows:
        x = ordx._row(r, ts, ctx.user_id, names)
        x["ward_id"] = str(r.ward_id) if r.ward_id else None
        x["ward"] = r.ward if r.enc_type in IP_TYPES and r.enc_status in ordx.OPEN_IPD else None
        x["bed"] = r.bed_no if x["ward"] else None
        x["ip_no"] = r.enc_code if r.enc_type in IP_TYPES else None
        x["patient_type"] = "IP" if r.enc_type in IP_TYPES else "ER" if r.enc_type == "ER" else "OP"
        d = r.data or {}
        for k in ("recollect_reason", "recollect_count", "delta_checks", "reflex_suggestions", "interface_values", "param_notes",
                  "micro", "send_out", "outsourced_to", "print_count", "last_printed_at", "delta_reviewed_at", "delta_reviewed_by",
                  "rollbacks", "reflex_of"):
            if d.get(k) is not None:
                x[k] = d[k]
        x["_svc"] = r.svc_data or {}
        out.append(x)
    return out


def _strip(x: dict) -> dict:
    x.pop("_svc", None)
    return x


def _tube_key(x: dict) -> str:
    t = x["test"]
    return str(t.get("container") or t.get("sample_type") or x["id"])


# ================================================================== desk summary & catalogue

@router.get("/desk")
async def desk(ctx: CtxDep):
    require_page(ctx, "lab", "lab-desk")
    o = orders
    start, _ = day_bounds(today())
    base = [o.c.deleted_at.is_(None), o.c.category == "LAB"]

    async def n(*conds) -> int:
        return (await ctx.conn.execute(sa.select(sa.func.count()).select_from(o).where(*base, *conds))).scalar_one()

    out = {
        "to_collect": await n(o.c.status == "Ordered"),
        "recollect": await n(o.c.status == "Ordered", o.c.data["recollect_reason"].astext.isnot(None)),
        "in_transit": await n(o.c.status == "Collected"),
        "in_process": await n(o.c.status == "In Progress"),
        "to_verify": await n(o.c.status == "Resulted"),
        "authorised_today": await n(o.c.status == "Verified", o.c.verified_at >= start),
        "critical_unack": await n(o.c.critical.is_(True), o.c.acknowledged_at.is_(None), o.c.status.in_(["Resulted", "Verified"]),
                                  o.c.ordered_at >= now() - timedelta(days=7)),
        "delta_holds": await n(o.c.status == "Resulted", o.c.data["delta_checks"].astext.like('%"hold": true%'),
                               o.c.data["delta_reviewed_at"].astext.is_(None)),
    }
    q = sa.select(sa.func.count()).select_from(audit_log).where(audit_log.c.at >= start, audit_log.c.module.in_(["lab", "orders"]))
    out["rejected_today"] = (await ctx.conn.execute(q.where(audit_log.c.action == "sample.reject"))).scalar_one()
    out["cancelled_today"] = (await ctx.conn.execute(q.where(audit_log.c.action.in_(["lab.result_cancel", "lab.rollback"])))).scalar_one()
    if has(SEND_OUTS):
        out["outsourced_pending"] = len(await find(ctx, SEND_OUTS, status=["To dispatch", "Dispatched"], limit=500))
    wl = await ordx.worklist(ctx, category="LAB")
    out["overdue"] = wl["overdue"]
    out["stat"] = wl["stat"]
    out["micro_pending"] = sum(1 for x in wl["rows"] if x["test"]["section"] == "Microbiology" and x["status"] in PENDING)
    out["generated_at"] = _stamp()
    return out


@router.get("/services")
async def lab_services(ctx: CtxDep, q: str | None = None, section: str | None = None, status: str | None = None):
    rs.ensure_access(ctx, E(TESTS), "read")
    s = services
    stmt = sa.select(s).where(s.c.deleted_at.is_(None), s.c.category == "LAB").order_by(s.c.title)
    if status:
        stmt = stmt.where(sa.func.coalesce(s.c.status, "Active") == status)
    rows = [rs.to_record(r) for r in (await ctx.conn.execute(stmt)).all()]
    refs = await rs.resolve_refs(ctx, E(TESTS), rows)
    out, counts = [], defaultdict(int)
    term = (q or "").strip().lower()
    for r in rows:
        sec = ordx.section_of(r, "LAB")
        if term and not any(term in str(v or "").lower() for v in (r.get("code"), r.get("name"), r.get("short_name"), r.get("method"))):
            continue
        counts[sec or "—"] += 1
        if section and sec != section:
            continue
        params = r.get("parameters") or []
        out.append({"id": r["id"], "code": r.get("code"), "name": r.get("name") or r.get("title"), "short_name": r.get("short_name"),
                    "section": sec, "method": r.get("method"), "sample_type": r.get("sample_type"), "container": r.get("container"),
                    "sample_volume": r.get("sample_volume"), "tat_minutes": r.get("tat_minutes"), "rate": r.get("rate"),
                    "status": r.get("status") or "Active", "outsourced": bool(r.get("outsourced")),
                    "reference_lab": refs.get(r.get("reference_lab") or ""), "analyzer": refs.get(r.get("analyzer") or ""),
                    "department": refs.get(r.get("department_id") or ""), "prep_instructions": r.get("prep_instructions"),
                    "parameters": params, "parameter_count": len(params)})
    return {"rows": out, "sections": dict(sorted(counts.items())), "total": len(out)}


# ================================================================== sample collection (bulk, by patient / ward)

@router.get("/collection")
async def collection(ctx: CtxDep, ward: str | None = None, location: Literal["all", "IP", "OP", "ER"] = "all", q: str | None = None,
                     priority: str | None = None):
    _collector(ctx)
    o = orders
    stmt = _query().where(o.c.category == "LAB", o.c.status == "Ordered", o.c.ordered_at >= now() - timedelta(days=14))
    rows = await _rows(ctx, stmt.order_by(o.c.ordered_at.asc()))
    wards: dict[str, dict] = {}
    for x in rows:
        if x["ward_id"] and x["ward"]:
            w = wards.setdefault(x["ward_id"], {"id": x["ward_id"], "name": x["ward"], "orders": 0, "patients": set()})
            w["orders"] += 1
            w["patients"].add(x["patient"]["id"])
    term = (q or "").strip().lower()
    if ward:
        rows = [x for x in rows if x["ward_id"] == ward]
    if location != "all":
        rows = [x for x in rows if x["patient_type"] == location]
    if priority:
        rows = [x for x in rows if x["priority"] == priority]
    if term:
        rows = [x for x in rows if any(term in str(v or "").lower() for v in (x["patient"]["name"], x["patient"]["uhid"], x["code"],
                                                                              x["test"]["name"], x["bed"], x["ip_no"]))]
    groups: dict[str, dict] = {}
    for x in rows:
        g = groups.setdefault(x["patient"]["id"], {"patient": x["patient"], "location": x["location"], "ward": x["ward"], "bed": x["bed"],
                                                   "ward_id": x["ward_id"], "ip_no": x["ip_no"], "patient_type": x["patient_type"],
                                                   "orders": [], "priority": "Routine", "oldest": x["ordered_at"], "recollect": False})
        g["orders"].append(x)
        if ordx.PRIORITY_RANK.get(x["priority"], 3) < ordx.PRIORITY_RANK.get(g["priority"], 3):
            g["priority"] = x["priority"]
        g["recollect"] = g["recollect"] or bool(x.get("recollect_reason"))
    out = []
    for g in groups.values():
        tubes: dict[str, dict] = {}
        for x in g["orders"]:
            t = tubes.setdefault(_tube_key(x), {"container": x["test"]["container"], "sample_type": x["test"]["sample_type"],
                                                "volume": x["_svc"].get("sample_volume"), "tests": [], "order_ids": []})
            t["tests"].append(x["test"]["name"])
            t["order_ids"].append(x["id"])
        g["tubes"] = list(tubes.values())
        g["tube_count"] = len(tubes)
        g["orders"] = [_strip(x) for x in g["orders"]]
        out.append(g)
    out.sort(key=lambda g: (ordx.PRIORITY_RANK.get(g["priority"], 3), not g["recollect"], g["oldest"] or ""))
    return {"patients": out, "wards": sorted(({**w, "patients": len(w["patients"])} for w in wards.values()), key=lambda w: w["name"]),
            "totals": {"patients": len(out), "orders": sum(len(g["orders"]) for g in out), "tubes": sum(g["tube_count"] for g in out),
                       "stat": sum(1 for g in out for x in g["orders"] if x["priority"] == "STAT"),
                       "recollect": sum(1 for g in out if g["recollect"])},
            "generated_at": _stamp()}


class BulkCollectIn(BaseModel):
    order_ids: list[str] = Field(min_length=1, max_length=300)
    collection_point: str | None = Field(default=None, max_length=120)


@router.post("/collection/bulk")
async def bulk_collect(body: BulkCollectIn, ctx: CtxDep):
    """Collect for several patients in one round (e.g. the morning ward round): one call per patient so that
    tests sharing a container share a tube, then labels for every tube in collection order."""
    _collector(ctx, write=True)
    ids = [i for i in dict.fromkeys(body.order_ids) if is_uuid(i)]
    rows = (await ctx.conn.execute(sa.select(orders.c.id, orders.c.patient_id, orders.c.status, orders.c.code, orders.c.category)
                                   .where(orders.c.id.in_(ids), orders.c.deleted_at.is_(None)))).all()
    if len(rows) != len(ids):
        raise not_found("One or more orders were not found")
    by_patient: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        if r.category != "LAB":
            raise bad_request(f"{r.code} is not a laboratory order")
        if r.status != "Ordered":
            raise conflict(f"{r.code} is already {r.status}")
        by_patient[str(r.patient_id)].append(str(r.id))
    labels = []
    for oids in by_patient.values():
        res = await ordx.collect(ordx.CollectIn(order_ids=oids), ctx)
        labels += res["labels"]
    if body.collection_point and has(SAMPLES):
        for lb in labels:
            s = await _sample(ctx, lb["barcode"])
            if s:
                await update(ctx, SAMPLES, s["id"], {"collection_point": body.collection_point.strip()})
    return {"labels": labels, "patients": len(by_patient), "tubes": len(labels), "orders": len(ids)}


async def _sample(ctx, barcode: str | None) -> dict | None:
    if not barcode or not has(SAMPLES):
        return None
    rows = await find(ctx, SAMPLES, barcode=barcode, limit=1)
    return rows[0] if rows else None


# ================================================================== accept samples (scan to receive, reject → recollect)

@router.get("/accept")
async def accept_list(ctx: CtxDep, section: str | None = None):
    _bench(ctx)
    o = orders
    start, _ = day_bounds(today())
    rows = await _rows(ctx, _query().where(o.c.category == "LAB", o.c.status == "Collected").order_by(o.c.collected_at.asc()))
    ts = now()
    tubes: dict[str, dict] = {}
    for x in rows:
        if section and x["test"]["section"] != section:
            continue
        key = x["sample_barcode"] or x["id"]
        mins = round((ts - datetime.fromisoformat(x["collected_at"])).total_seconds() / 60) if x["collected_at"] else None
        t = tubes.setdefault(key, {"barcode": x["sample_barcode"], "patient": x["patient"], "location": x["location"],
                                   "collected_at": x["collected_at"], "minutes": mins, "delayed": bool(mins and mins > TRANSIT_ALERT_MIN),
                                   "priority": x["priority"], "sample_type": x["test"]["sample_type"], "container": x["test"]["container"],
                                   "tests": []})
        t["tests"].append({"id": x["id"], "code": x["code"], "name": x["test"]["name"], "section": x["test"]["section"]})
        if ordx.PRIORITY_RANK.get(x["priority"], 3) < ordx.PRIORITY_RANK.get(t["priority"], 3):
            t["priority"] = x["priority"]
    pending = sorted(tubes.values(), key=lambda t: (ordx.PRIORITY_RANK.get(t["priority"], 3), t["collected_at"] or ""))
    received = []
    if has(SAMPLES):
        ent = E(SAMPLES)
        recs = (await ctx.conn.execute(sa.select(records).where(*rs.base_where(ent), records.c.status.in_(["Received", "Processed", "Rejected"]),
                                                                records.c.updated_at >= start).order_by(records.c.updated_at.desc()).limit(60))).all()
        recs = [rs.to_record(r) for r in recs]
        demo = await _demo(ctx, [r.get("patient_id") for r in recs])
        received = [{"barcode": r.get("barcode"), "status": r.get("status"), "at": r.get("received_at") or r.get("updated_at"),
                     "by": r.get("received_by") or r.get("rejected_by"), "reason": r.get("rejection_reason"),
                     "patient": demo.get(str(r.get("patient_id"))), "sample_type": r.get("sample_type")} for r in recs]
    return {"pending": pending, "received": received,
            "counts": {"tubes": len(pending), "tests": sum(len(t["tests"]) for t in pending), "delayed": sum(1 for t in pending if t["delayed"]),
                       "stat": sum(1 for t in pending if t["priority"] == "STAT")},
            "transit_alert_minutes": TRANSIT_ALERT_MIN, "generated_at": _stamp()}


class ScanIn(BaseModel):
    barcode: str = Field(min_length=4, max_length=40)


async def _mark_received(ctx, barcode: str) -> None:
    s = await _sample(ctx, barcode)
    if s:
        await update(ctx, SAMPLES, s["id"], {"received_by": ctx.user.get("name"), "received_at": s.get("received_at") or _stamp()})


@router.post("/accept/scan")
async def accept_scan(body: ScanIn, ctx: CtxDep):
    _bench(ctx, edit=True)
    code = body.barcode.strip()
    found = await find(ctx, ORD, sample_barcode=code, limit=5)
    o = found[0] if found else None
    if not o:
        raise not_found(f"No sample with barcode {code}")
    if o["status"] != "Collected":
        siblings = await find(ctx, ORD, sample_barcode=code, status="Collected", limit=5)
        if not siblings:
            raise conflict(f"Tube {code} was already received ({o['status']})", {"code": "ALREADY_RECEIVED", "status": o["status"]})
    res = await ordx.receive_by_barcode(ordx.ReceiveIn(barcode=code), ctx)
    await _mark_received(ctx, code)
    demo = (await _demo(ctx, [o["patient_id"]])).get(o["patient_id"])
    return {"barcode": code, "patient": demo, "orders": [{"id": r["id"], "code": r["code"], "status": r["status"]} for r in res["orders"]]}


class BulkScanIn(BaseModel):
    barcodes: list[str] = Field(min_length=1, max_length=200)


@router.post("/accept/bulk")
async def accept_bulk(body: BulkScanIn, ctx: CtxDep):
    _bench(ctx, edit=True)
    done, skipped = [], []
    for code in dict.fromkeys(b.strip() for b in body.barcodes if b.strip()):
        if not await find(ctx, ORD, sample_barcode=code, status="Collected", limit=1):
            skipped.append(code)
            continue
        res = await ordx.receive_by_barcode(ordx.ReceiveIn(barcode=code), ctx)
        await _mark_received(ctx, code)
        done.append({"barcode": code, "orders": len(res["orders"])})
    return {"received": done, "skipped": skipped}


class RejectTubeIn(BaseModel):
    barcode: str = Field(min_length=4, max_length=40)
    reason: Literal["Haemolysed", "Clotted", "Insufficient quantity", "Wrong container", "Unlabelled", "Delayed transport"]
    note: str | None = Field(default=None, max_length=300)


@router.post("/accept/reject")
async def accept_reject(body: RejectTubeIn, ctx: CtxDep):
    """Reject an unfit tube: every test on it returns to the collection list flagged for recollection."""
    _bench(ctx, edit=True)
    code = body.barcode.strip()
    rows = await find(ctx, ORD, sample_barcode=code, status=["Collected", "In Progress"], limit=5)
    if not rows:
        raise not_found(f"No sample in transit or in process with barcode {code}")
    s = await _sample(ctx, code)
    res = await ordx.reject_sample(rows[0]["id"], ordx.RejectIn(reason=body.reason), ctx)
    if s:
        await update(ctx, SAMPLES, s["id"], {"rejected_by": ctx.user.get("name"), "rejected_at": _stamp(),
                                             "rejection_note": (body.note or "").strip() or None})
    for r in res["orders"]:
        if body.note:
            await update(ctx, ORD, r["id"], {"recollect_note": body.note.strip()})
    live(ctx, "alerts", {"type": "sample_rejected", "barcode": code, "reason": body.reason, "patient_id": rows[0]["patient_id"],
                         "tests": [r["code"] for r in res["orders"]]})
    return {"barcode": code, "reason": body.reason, "orders": [{"id": r["id"], "code": r["code"], "status": r["status"]} for r in res["orders"]]}


# ================================================================== worksheet: result entry & verification

async def _enrich(ctx, rows: list[dict], *, with_previous: bool = True) -> list[dict]:
    """Patient-specific parameters, previous result and live delta evaluation for worksheet / report rows."""
    demo = await _demo(ctx, [x["patient"]["id"] for x in rows])
    sids = {x["test"]["id"] for x in rows if x["test"]["id"]}
    svcs = await _services(ctx, sids)
    ranges = await _ranges(ctx, sids)
    prev = await _previous_results(ctx, {(x["patient"]["id"], x["test"]["id"]) for x in rows if x["test"]["id"]},
                                   exclude={x["id"] for x in rows}) if with_previous else {}
    rule_cache: dict[str, dict] = {}
    for x in rows:
        sid = x["test"]["id"]
        d = demo.get(x["patient"]["id"]) or {}
        svc = svcs.get(sid or "") or {}
        x["patient"] = {**x["patient"], "sex": d.get("sex"), "age_label": d.get("age"), "phone": d.get("phone")}
        x["parameters"] = patient_params(svc, ranges.get(sid or "", []), d.get("sex"), d.get("age_days"))
        x["method"] = svc.get("method")
        x["interpretation"] = svc.get("interpretation")
        p = prev.get((x["patient"]["id"], sid), [])
        x["previous"] = p
        if sid and sid not in rule_cache:
            rule_cache[sid] = await _delta_rules(ctx, svc)
        x["delta_rules"] = {k: {kk: vv for kk, vv in v.items() if kk != "source"} for k, v in rule_cache.get(sid or "", {}).items()}
        if x["result_values"] and not x.get("delta_checks"):
            x["delta_checks"] = evaluate_deltas(x["result_values"], rule_cache.get(sid or "", {}), p[0] if p else None)
    return rows


@router.get("/worksheet")
async def worksheet(ctx: CtxDep, section: str | None = None, analyzer: str | None = None,
                    stage: Literal["entry", "verify", "all"] = "entry", q: str | None = None):
    _bench(ctx)
    o = orders
    statuses = {"entry": ["Collected", "In Progress"], "verify": ["Resulted"], "all": ["Collected", "In Progress", "Resulted"]}[stage]
    stmt = _query().where(o.c.category == "LAB", o.c.status.in_(statuses))
    if analyzer and is_uuid(analyzer):
        stmt = stmt.where(services.c.data["analyzer"].astext == analyzer)
    rows = await _rows(ctx, stmt.order_by(o.c.ordered_at.asc()), limit=1500)
    sections = sorted({x["test"]["section"] for x in rows if x["test"]["section"]})
    if section:
        rows = [x for x in rows if x["test"]["section"] == section]
    term = (q or "").strip().lower()
    if term:
        rows = [x for x in rows if any(term in str(v or "").lower() for v in (x["code"], x["sample_barcode"], x["patient"]["uhid"],
                                                                              x["patient"]["name"], x["test"]["name"]))]
    rows.sort(key=ordx._sort_key)
    rows = rows[:400]
    await _enrich(ctx, rows)
    analyzers = [{"id": a["id"], "name": a.get("name"), "section": a.get("section"), "status": a.get("status")}
                 for a in await find(ctx, ANALYZERS, limit=100)] if has(ANALYZERS) else []
    return {"rows": [_strip(x) for x in rows], "sections": sections, "analyzers": analyzers,
            "counts": {"entry": sum(1 for x in rows if x["status"] in PENDING), "verify": sum(1 for x in rows if x["status"] == "Resulted"),
                       "not_received": sum(1 for x in rows if x["status"] == "Collected"),
                       "delta_flags": sum(1 for x in rows if any(d.get("failed") for d in x.get("delta_checks") or []))},
            "generated_at": _stamp()}


class SheetValue(BaseModel):
    parameter: str = Field(min_length=1, max_length=120)
    value: str | float | int | None = None


class SheetEntry(BaseModel):
    order_id: str
    values: list[SheetValue] = Field(default_factory=list, max_length=80)
    interface_values: dict[str, str] | None = None
    param_notes: dict[str, str] | None = None
    result: str | None = Field(default=None, max_length=20000)
    impression: str | None = Field(default=None, max_length=2000)


class SheetSaveIn(BaseModel):
    entries: list[SheetEntry] = Field(min_length=1, max_length=100)
    verify: bool = False


def _clean_map(m: dict[str, str] | None, limit: int = 300) -> dict[str, str] | None:
    if not m:
        return None
    out = {str(k).strip()[:120]: str(v).strip()[:limit] for k, v in m.items() if str(k).strip() and str(v or "").strip()}
    return out or None


@router.post("/worksheet/save")
async def worksheet_save(body: SheetSaveIn, ctx: CtxDep):
    """Save a batch of results from the worksheet (all or nothing); optionally authorise them in the same step."""
    _bench(ctx, edit=True, roles=ordx.RESULT_ROLES["LAB"])
    if body.verify:
        require_role(ctx, *ordx.VERIFY_ROLES["LAB"])
    saved = []
    for e in body.entries:
        o = await get(ctx, ORD, e.order_id)
        if not o or o.get("category") != "LAB":
            raise not_found("Lab order not found")
        label = f"{o['code']}: "
        try:
            extra = {k: v for k, v in (("interface_values", _clean_map(e.interface_values)), ("param_notes", _clean_map(e.param_notes)))
                     if v is not None}
            if extra:
                await update(ctx, ORD, o["id"], extra)
            values = [ordx.ValueIn(parameter=v.parameter, value=v.value) for v in e.values if v.value not in (None, "") and str(v.value).strip()]
            if values or (e.result or "").strip():
                await ordx.enter_results(o["id"], ordx.ResultsIn(values=values, result=e.result, impression=e.impression), ctx)
            if body.verify:
                await ordx.verify(o["id"], ordx.VerifyIn(comment="Authorised from worksheet"), ctx)
        except ApiError as err:
            detail = err.detail if isinstance(err.detail, dict) else {"message": str(err.detail)}
            raise ApiError(err.status_code, label + str(detail.get("message")), {**(detail.get("details") or {}), "order_id": o["id"]},
                           code=detail.get("code")) from None
        cur = await get(ctx, ORD, o["id"])
        saved.append({"id": cur["id"], "code": cur["code"], "status": cur["status"], "critical": bool(cur.get("critical")),
                      "delta_checks": cur.get("delta_checks") or [], "reflex_suggestions": cur.get("reflex_suggestions") or []})
    return {"saved": saved, "count": len(saved)}


class ReviewIn(BaseModel):
    note: str = Field(min_length=3, max_length=500)


@router.post("/worksheet/{oid}/delta-review")
async def delta_review(oid: str, body: ReviewIn, ctx: CtxDep):
    _bench(ctx, edit=True, roles=ordx.VERIFY_ROLES["LAB"])
    o = await get(ctx, ORD, oid)
    if not o or o.get("category") != "LAB":
        raise not_found("Lab order not found")
    if not any(d.get("failed") for d in o.get("delta_checks") or []):
        raise conflict(f"{o['code']} has no failed delta check")
    rec = await update(ctx, ORD, oid, {"delta_reviewed_at": _stamp(), "delta_reviewed_by": f"{ctx.user.get('name')} ({ctx.role})",
                                       "delta_review_note": body.note.strip()})
    await audit(ctx, "lab.delta_review", module="lab", entity="lab_orders", record=rec, note=body.note.strip(),
                after={"delta_checks": [d for d in rec.get("delta_checks") or [] if d.get("failed")]})
    return {"id": oid, "delta_reviewed_at": rec.get("delta_reviewed_at")}


class ReflexIn(BaseModel):
    rule_id: str
    action: Literal["order", "dismiss"]


@router.post("/worksheet/{oid}/reflex")
async def reflex_action(oid: str, body: ReflexIn, ctx: CtxDep):
    _bench(ctx, edit=True, roles=ordx.VERIFY_ROLES["LAB"])
    o = await get(ctx, ORD, oid)
    if not o or o.get("category") != "LAB":
        raise not_found("Lab order not found")
    sugg = list(o.get("reflex_suggestions") or [])
    idx = next((i for i, s in enumerate(sugg) if s.get("rule_id") == body.rule_id), None)
    if idx is None:
        raise not_found("No such reflex suggestion on this order")
    if sugg[idx].get("status") != "Suggested":
        raise conflict(f"Reflex test already {sugg[idx].get('status', '').lower()}")
    if body.action == "order":
        sugg[idx] = await _order_reflex(ctx, o, sugg[idx])
    else:
        sugg[idx] = {**sugg[idx], "status": "Dismissed", "dismissed_by": ctx.user.get("name"), "dismissed_at": _stamp()}
    ctx.__dict__["_lab_annotating"] = True
    try:
        await update(ctx, ORD, oid, {"reflex_suggestions": sugg})
    finally:
        ctx.__dict__["_lab_annotating"] = False
    return {"suggestion": sugg[idx]}


class ImportIn(BaseModel):
    text: str = Field(min_length=3, max_length=200_000)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


@router.post("/import")
async def import_results(body: ImportIn, ctx: CtxDep):
    """Parse an analyser / middleware export (`barcode, parameter, value` per line — comma, tab, pipe or
    semicolon separated, or whitespace with the value last) and match it to tubes awaiting results.
    Nothing is saved: the worksheet shows the values as interface values for review."""
    _bench(ctx, edit=True, roles=ordx.RESULT_ROLES["LAB"])
    parsed: list[tuple[str, str, str, str]] = []
    unmatched: list[dict] = []
    for raw in body.text.splitlines()[:5000]:
        line = raw.strip()
        if not line or line.startswith(("#", "H|", "L|")):
            continue
        parts = [p.strip() for p in re.split(r"[,\t|;]", line) if p.strip()]
        if len(parts) < 3:
            ws = line.split()
            parts = [ws[0], " ".join(ws[1:-1]), ws[-1]] if len(ws) >= 3 else parts
        if len(parts) < 3:
            unmatched.append({"line": line, "reason": "Expected barcode, parameter and value"})
            continue
        parsed.append((parts[0], parts[1], parts[2], line))
    codes = list({p[0] for p in parsed})
    found = await _rows(ctx, _query().where(orders.c.category == "LAB", orders.c.status.in_(["Collected", "In Progress", "Resulted"]),
                                            orders.c.data["sample_barcode"].astext.in_(codes))) if codes else []
    by_code: dict[str, list[dict]] = defaultdict(list)
    for x in found:
        by_code[x["sample_barcode"]].append(x)
    matched: dict[str, dict] = {}
    for code, param, value, line in parsed:
        cands = by_code.get(code)
        if not cands:
            unmatched.append({"line": line, "reason": f"No tube {code} awaiting results"})
            continue
        hit = None
        for x in cands:
            names = [str(p.get("parameter") or "") for p in x["_svc"].get("parameters") or []]
            exact = [n for n in names if _norm(n) == _norm(param)]
            prefix = [n for n in names if _norm(n).startswith(_norm(param)) or _norm(param).startswith(_norm(n))]
            name = exact[0] if exact else prefix[0] if len(prefix) == 1 else None
            if name:
                hit = (x, name)
                break
        if not hit:
            unmatched.append({"line": line, "reason": f"Parameter '{param}' is not on any test in tube {code}"})
            continue
        x, name = hit
        m = matched.setdefault(x["id"], {"order_id": x["id"], "code": x["code"], "barcode": code, "test": x["test"]["name"],
                                         "patient": x["patient"]["name"], "values": {}})
        m["values"][name] = value
    return {"matched": list(matched.values()), "unmatched": unmatched[:200], "lines": len(parsed)}


# ================================================================== result rejection (re-run) and audited cancellation

class ReasonIn(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


def _result_snapshot(o: dict) -> dict:
    return {"at": _stamp(), "values": o.get("result_values") or [], "result": o.get("result"),
            "impression": o.get("impression"), "resulted_at": o.get("resulted_at"), "resulted_by": o.get("resulted_by"),
            "verified_at": o.get("verified_at"), "verified_by": o.get("verified_by")}


async def _reopen(ctx, oid: str, *, allowed: tuple[str, ...], history_key: str, action: str, reason: str, label: str) -> dict:
    _bench(ctx, edit=True)
    o = await get(ctx, ORD, oid)
    if not o or o.get("category") != "LAB":
        raise not_found("Lab order not found")
    if o["status"] not in allowed:
        raise conflict(f"{o['code']} is {o['status']} — only {' / '.join(allowed).lower()} results can be {label}")
    snap = {**_result_snapshot(o), "by": f"{ctx.user.get('name')} ({ctx.role})", "reason": reason.strip(), "status_before": o["status"]}
    ctx.__dict__["_lab_annotating"] = True
    try:
        rec = await update(ctx, ORD, oid, {
            "status": "In Progress", "result_values": [], "result": None, "impression": None, "resulted_at": None, "verified_at": None,
            "verified_by": None, "tat_minutes": None, "delta_checks": [], "delta_reviewed_at": None, "interface_values": None,
            history_key: [*(o.get(history_key) or []), snap],
        })
    finally:
        ctx.__dict__["_lab_annotating"] = False
    await audit(ctx, action, module="lab", entity="lab_orders", record=rec, before={"status": o["status"], "result_values": o.get("result_values"),
                                                                                    "verified_by": o.get("verified_by")},
                after={"status": "In Progress"}, note=reason.strip())
    if o["status"] == "Verified":
        live(ctx, "alerts", {"type": "report_withdrawn", "order_id": oid, "code": o["code"], "patient_id": o["patient_id"],
                             "reason": reason.strip()})
    return rec


@router.post("/results/{oid}/reject")
async def reject_result(oid: str, body: ReasonIn, ctx: CtxDep):
    """Pathologist sends a resulted (not yet authorised) test back to the bench for a re-run."""
    rec = await _reopen(ctx, oid, allowed=("Resulted",), history_key="reruns", action="lab.result_reject", reason=body.reason,
                        label="sent for re-run")
    return {"id": rec["id"], "code": rec["code"], "status": rec["status"]}


@router.post("/results/{oid}/cancel")
async def cancel_result(oid: str, body: ReasonIn, ctx: CtxDep):
    """Result cancellation: the values are withdrawn (kept in the order's history and the audit trail) and the
    test returns to the bench. An authorised report is withdrawn and the clinicians are alerted."""
    rec = await _reopen(ctx, oid, allowed=("Resulted", "Verified"), history_key="cancelled_results", action="lab.result_cancel",
                        reason=body.reason, label="cancelled")
    return {"id": rec["id"], "code": rec["code"], "status": rec["status"]}


# ================================================================== authorised reports workspace

def _report_query():
    o, p, s, e, b = orders, patients, services, encounters, beds
    w = records.alias("w")
    dept = records.alias("dept")
    doc = employees.alias("doc")
    return (sa.select(o.c.id, o.c.code, o.c.status, o.c.priority, o.c.patient_id, o.c.encounter_id, o.c.service_id, o.c.ordered_at,
                      o.c.collected_at, o.c.resulted_at, o.c.verified_at, o.c.critical, o.c.acknowledged_at, o.c.data, o.c.created_by,
                      s.c.title.label("svc_name"), s.c.data.label("svc_data"), s.c.tat_minutes.label("svc_tat"),
                      p.c.code.label("uhid"), p.c.first_name, p.c.last_name, p.c.gender, p.c.dob, p.c.phone, p.c.data.label("p_data"),
                      e.c.code.label("enc_code"), e.c.type.label("enc_type"), e.c.status.label("enc_status"), e.c.started_at.label("enc_start"),
                      e.c.data.label("enc_data"), b.c.bed_no, w.c.title.label("ward"), dept.c.title.label("enc_dept"), doc.c.name.label("consultant"))
            .select_from(o.join(p, p.c.id == o.c.patient_id).outerjoin(s, s.c.id == o.c.service_id)
                         .outerjoin(e, e.c.id == o.c.encounter_id).outerjoin(b, b.c.id == e.c.bed_id).outerjoin(w, w.c.id == b.c.ward_id)
                         .outerjoin(dept, dept.c.id == e.c.department_id).outerjoin(doc, doc.c.id == e.c.doctor_id))
            .where(o.c.deleted_at.is_(None), o.c.category == "LAB"))


def _ptype(enc_type: str | None) -> str:
    return "IP" if enc_type in IP_TYPES else "ER" if enc_type == "ER" else "OP"


def _abnormal(values: list[dict]) -> int:
    return sum(1 for v in values or [] if v.get("flag") and v.get("flag") != "Normal")


@router.get("/authorized")
async def authorized(ctx: CtxDep, q: str | None = None, date_from: str | None = None, date_to: str | None = None,
                     patient_type: Literal["all", "OP", "IP", "ER"] = "all",
                     status: Literal["all", "released", "printed", "abnormal", "critical"] = "all",
                     section: str | None = None, page: int = 1, limit: int = 25):
    _read(ctx)
    o, p, e = orders, patients, encounters
    start, end = _range_bounds(date_from, date_to)
    stmt = _report_query().where(o.c.status == "Verified", o.c.verified_at >= start, o.c.verified_at < end)
    if patient_type == "IP":
        stmt = stmt.where(e.c.type.in_(IP_TYPES))
    elif patient_type == "ER":
        stmt = stmt.where(e.c.type == "ER")
    elif patient_type == "OP":
        stmt = stmt.where(sa.or_(e.c.type.is_(None), e.c.type.notin_([*IP_TYPES, "ER"])))
    if status == "critical":
        stmt = stmt.where(o.c.critical.is_(True))
    elif status == "printed":
        stmt = stmt.where(o.c.data["print_count"].astext.isnot(None))
    elif status == "released":
        stmt = stmt.where(o.c.data["print_count"].astext.is_(None))
    term = (q or "").strip()
    if term:
        like = f"%{term.lower()}%"
        bill = (sa.select(charges.c.source_id).select_from(charges.join(invoices, invoices.c.id == charges.c.invoice_id))
                .where(sa.func.lower(invoices.c.code) == term.lower()))
        ward = records.alias("wq")
        bed_enc = (sa.select(e.c.id).select_from(e.join(beds, beds.c.id == e.c.bed_id).outerjoin(ward, ward.c.id == beds.c.ward_id))
                   .where(e.c.type.in_(IP_TYPES), sa.or_(sa.func.lower(ward.c.title).like(like), sa.func.lower(beds.c.bed_no) == term.lower())))
        stmt = stmt.where(sa.or_(
            sa.func.lower(o.c.code) == term.lower(), o.c.data["sample_barcode"].astext == term, sa.func.upper(p.c.code) == term.upper(),
            sa.func.lower(sa.func.concat(p.c.first_name, " ", p.c.last_name)).like(like), sa.func.lower(e.c.code) == term.lower(),
            o.c.encounter_id.in_(bed_enc), o.c.id.in_(bill), p.c.phone == term))
    rows = (await ctx.conn.execute(stmt.order_by(o.c.verified_at.desc()).limit(5000))).all()
    names = await ordx._employee_names(ctx, rows)
    reports = []
    for r in rows:
        d, sd = r.data or {}, r.svc_data or {}
        sec = ordx.section_of({**sd, "name": r.svc_name}, "LAB")
        if section and sec != section:
            continue
        vals = d.get("result_values") or []
        if status == "abnormal" and not _abnormal(vals) and not r.critical:
            continue
        reports.append((r, sec, vals, d))
    patients_map: dict[str, dict] = {}
    for r, sec, vals, d in reports:
        pid = str(r.patient_id)
        label, _ = _age_label(r.dob)
        g = patients_map.setdefault(pid, {
            "patient": {"id": pid, "name": _name(r.first_name, r.last_name), "uhid": r.uhid, "gender": r.gender, "age": label},
            "patient_type": _ptype(r.enc_type), "ip_no": r.enc_code if r.enc_type in IP_TYPES else None,
            "ward": r.ward if r.enc_type in IP_TYPES and r.enc_status in ordx.OPEN_IPD else None,
            "bed": r.bed_no if r.enc_type in IP_TYPES and r.enc_status in ordx.OPEN_IPD else None, "reports": [], "latest": None})
        g["reports"].append({"id": str(r.id), "code": r.code, "test": r.svc_name, "section": sec, "verified_at": to_json_value(r.verified_at),
                             "ordered_at": to_json_value(r.ordered_at), "doctor": names.get(d.get("ordering_doctor") or ""),
                             "critical": bool(r.critical), "abnormal": _abnormal(vals), "print_count": int(d.get("print_count") or 0),
                             "status": "Released", "verified_by": d.get("verified_by")})
        g["latest"] = max(g["latest"] or "", to_json_value(r.verified_at) or "")
    groups = sorted(patients_map.values(), key=lambda g: g["latest"] or "", reverse=True)
    limit = max(5, min(limit, 100))
    pages = max(1, -(-len(groups) // limit))
    page = max(1, min(page, pages))
    chunk = groups[(page - 1) * limit: page * limit]
    sections = sorted({sec for _, sec, _, _ in reports if sec})
    return {"patients": chunk, "page": page, "pages": pages, "total_patients": len(groups),
            "kpis": {"reports": len(reports), "patients": len(chunk), "in_patients": sum(1 for g in chunk if g["patient_type"] == "IP"),
                     "out_patients": sum(1 for g in chunk if g["patient_type"] == "OP"), "er": sum(1 for g in chunk if g["patient_type"] == "ER")},
            "sections": sections, "from": start.date().isoformat(), "to": (end - timedelta(days=1)).date().isoformat()}


async def _template_for(ctx, svc: dict, section: str | None) -> dict:
    if not has(TEMPLATES):
        return dict(DEFAULT_TEMPLATE)
    if svc.get("report_template"):
        t = await get(ctx, TEMPLATES, svc["report_template"])
        if t and (t.get("status") or "Active") == "Active":
            return t
    ts = await _active_rows(ctx, TEMPLATES)
    for want in (section, "All sections", None):
        for t in ts:
            if (t.get("section") or "All sections") == (want or "All sections"):
                return t
    return dict(DEFAULT_TEMPLATE)


def _report_rows(values: list[dict], params: list[dict], iface: dict, notes: dict, deltas: list[dict], show_method: bool) -> list[dict]:
    pmap = {p["parameter"].lower(): p for p in params}
    dmap = {str(d.get("parameter") or "").lower(): d for d in deltas or []}
    order = {p["parameter"].lower(): i for i, p in enumerate(params)}
    rows = []
    for v in sorted(values or [], key=lambda v: order.get(str(v.get("parameter") or "").lower(), 999)):
        name = str(v.get("parameter") or "")
        p = pmap.get(name.lower()) or {}
        flag = v.get("flag")
        dl = dmap.get(name.lower())
        alarm = "Critical" if str(flag or "").startswith("Critical") else ("Delta" if dl and dl.get("failed") else None)
        rng = v.get("ref_range") or p.get("ref_range")
        unit = v.get("unit") or p.get("unit")
        rows.append({"parameter": name, "value": v.get("value"), "interface_value": (iface or {}).get(name),
                     "normal": " ".join(x for x in (rng, unit) if x) or None, "unit": unit, "ref_range": rng,
                     "method": (p.get("method") if show_method else None), "note": (notes or {}).get(name) or p.get("note"),
                     "alarm": alarm, "flag": flag, "flag_code": FLAG_CODE.get(flag or ""),
                     "abnormal": bool(flag and flag != "Normal")})
    return rows


@router.get("/authorized/view")
async def authorized_view(ctx: CtxDep, ids: str):
    """Everything the report viewer / printer needs for the ticked tests (grouped by patient)."""
    _read(ctx)
    want = [i for i in dict.fromkeys(ids.split(",")) if is_uuid(i)][:60]
    if not want:
        raise bad_request("Tick at least one report")
    rows = (await ctx.conn.execute(_report_query().where(orders.c.id.in_(want)))).all()
    if not rows:
        raise not_found("Reports not found")
    names = await ordx._employee_names(ctx, rows)
    sids = {str(r.service_id) for r in rows if r.service_id}
    svcs = await _services(ctx, sids)
    ranges = await _ranges(ctx, sids)
    demo = await _demo(ctx, [str(r.patient_id) for r in rows])
    prev = await _previous_results(ctx, {(str(r.patient_id), str(r.service_id)) for r in rows if r.service_id}, per_pair=8)
    refs: dict[str, dict] = {}
    if has(SEND_OUTS):
        so_ids = [(r.data or {}).get("send_out") for r in rows if (r.data or {}).get("send_out")]
        for so in [await get(ctx, SEND_OUTS, i) for i in so_ids]:
            if so:
                refs[so["order"]] = so
    by_patient: dict[str, dict] = {}
    order_index = {i: n for n, i in enumerate(want)}
    for r in sorted(rows, key=lambda r: order_index.get(str(r.id), 0)):
        pid = str(r.patient_id)
        dm = demo.get(pid) or {}
        ed = r.enc_data or {}
        g = by_patient.setdefault(pid, {
            "patient": {"id": pid, "name": dm.get("name"), "uhid": r.uhid, "gender": r.gender, "age": dm.get("age"), "phone": r.phone},
            "patient_type": _ptype(r.enc_type),
            "encounter": {"ip_no": r.enc_code if r.enc_type in IP_TYPES else None, "visit_no": r.enc_code, "type": r.enc_type,
                          "status": r.enc_status, "ward": r.ward, "bed": r.bed_no, "consultant": r.consultant, "department": r.enc_dept,
                          "admitted_at": to_json_value(r.enc_start) if r.enc_type in IP_TYPES else None,
                          "ref_doctor": ed.get("referring_doctor") or ed.get("referred_by") or dm.get("referred_by")},
            "reports": []})
        d = r.data or {}
        svc = svcs.get(str(r.service_id)) or {}
        sec = ordx.section_of({**(r.svc_data or {}), "name": r.svc_name}, "LAB")
        params = patient_params(svc, ranges.get(str(r.service_id), []), dm.get("sex"), dm.get("age_days"))
        tpl = await _template_for(ctx, svc, sec)
        show_method = tpl.get("show_method", True) is not False
        values = d.get("result_values") or []
        rows_out = _report_rows(values, params, d.get("interface_values") or {}, d.get("param_notes") or {}, d.get("delta_checks") or [],
                                show_method)
        so = refs.get(str(r.id))
        g["reports"].append({
            "id": str(r.id), "code": r.code, "test": r.svc_name, "short_name": svc.get("short_name"), "section": sec,
            "method": svc.get("method") if show_method else None, "sample_type": svc.get("sample_type"), "barcode": d.get("sample_barcode"),
            "priority": r.priority, "ordered_at": to_json_value(r.ordered_at), "collected_at": to_json_value(r.collected_at),
            "resulted_at": to_json_value(r.resulted_at), "verified_at": to_json_value(r.verified_at), "status": r.status,
            "released": r.status == "Verified", "resulted_by": d.get("resulted_by"), "verified_by": d.get("verified_by"),
            "ordering_doctor": names.get(d.get("ordering_doctor") or ""), "critical": bool(r.critical),
            "acknowledged_by": d.get("acknowledged_by"), "rows": rows_out, "abnormal": sum(1 for x in rows_out if x["abnormal"]),
            "result": d.get("result"), "impression": d.get("impression"), "interpretation": svc.get("interpretation"),
            "micro": d.get("micro"), "print_count": int(d.get("print_count") or 0), "last_printed_at": d.get("last_printed_at"),
            "rollbacks": d.get("rollbacks") or [], "amended_at": d.get("amended_at"), "tat_minutes": d.get("tat_minutes"),
            "outsourced": {"lab": so.get("lab_name"), "external_ref": so.get("external_ref"), "report_file": so.get("report_file")} if so else None,
            "previous": [h for h in prev.get((pid, str(r.service_id)), [])
                         if h["order_id"] != str(r.id) and (not r.verified_at or (h["verified_at"] or "") < to_json_value(r.verified_at))][:6],
            "template": {k: tpl.get(k) for k in ("name", "layout", "header_note", "signatory_1_name", "signatory_1_designation",
                                                 "signatory_2_name", "signatory_2_designation", "footer_text", "show_previous")},
        })
    return {"groups": list(by_patient.values()), "hospital": {"name": settings.hospital_name, "branch": settings.branch_id},
            "generated_at": _stamp()}


@router.get("/authorized/trend")
async def authorized_trend(ctx: CtxDep, order_id: str, limit: int = 10):
    """Previous verified results of the same test for the same patient, as one series per numeric parameter."""
    _read(ctx)
    o = await get(ctx, ORD, order_id)
    if not o or o.get("category") != "LAB":
        raise not_found("Lab order not found")
    key = (o["patient_id"], o["service_id"])
    hist = (await _previous_results(ctx, {key}, days=1825, per_pair=max(2, min(limit, 30)))).get(key, [])
    if o["status"] == "Verified" and not any(h["order_id"] == o["id"] for h in hist):
        hist = [{"order_id": o["id"], "code": o["code"], "verified_at": o.get("verified_at"), "values": o.get("result_values") or []}, *hist]
    hist = sorted(hist, key=lambda h: h["verified_at"] or "")
    series: dict[str, dict] = {}
    for h in hist:
        for v in h["values"]:
            name = str(v.get("parameter") or "")
            n = _num(v.get("value"))
            s = series.setdefault(name, {"parameter": name, "unit": v.get("unit"), "ref_range": v.get("ref_range"), "points": []})
            s["points"].append({"at": h["verified_at"], "code": h["code"], "value": v.get("value"), "numeric": n, "flag": v.get("flag"),
                                "current": h["order_id"] == o["id"]})
    return {"order_id": o["id"], "results": len(hist), "series": list(series.values())}


class PrintIn(BaseModel):
    order_ids: list[str] = Field(min_length=1, max_length=60)
    format: Literal["letterhead", "plain", "smart"] = "letterhead"


@router.post("/authorized/print")
async def authorized_print(body: PrintIn, ctx: CtxDep):
    """Record the print (audit + print count) — the browser renders the report."""
    _read(ctx)
    done = []
    for oid in dict.fromkeys(body.order_ids):
        o = await get(ctx, ORD, oid)
        if not o or o.get("category") != "LAB":
            raise not_found("Lab report not found")
        if o["status"] != "Verified":
            raise conflict(f"{o['code']} is not authorised — only released reports can be printed")
        ctx.__dict__["_lab_annotating"] = True
        try:
            rec = await update(ctx, ORD, oid, {"print_count": int(o.get("print_count") or 0) + 1, "last_printed_at": _stamp(),
                                               "last_printed_by": ctx.user.get("name"), "last_print_format": body.format})
        finally:
            ctx.__dict__["_lab_annotating"] = False
        await audit(ctx, "print", module="lab", entity="lab_orders", record=rec, note=f"Lab report printed ({body.format})")
        done.append({"id": oid, "print_count": rec.get("print_count")})
    return {"printed": done}


@router.post("/authorized/{oid}/rollback")
async def rollback(oid: str, body: ReasonIn, ctx: CtxDep):
    """Withdraw an authorisation: the report goes back to 'Resulted' (values kept) for correction and re-authorisation."""
    _bench(ctx, edit=True)
    o = await get(ctx, ORD, oid)
    if not o or o.get("category") != "LAB":
        raise not_found("Lab order not found")
    if o["status"] != "Verified":
        raise conflict(f"{o['code']} is {o['status']} — only authorised reports can be rolled back")
    entry = {"at": _stamp(), "by": f"{ctx.user.get('name')} ({ctx.role})", "reason": body.reason.strip(),
             "verified_by": o.get("verified_by"), "verified_at": o.get("verified_at"), "print_count": o.get("print_count")}
    ctx.__dict__["_lab_annotating"] = True
    try:
        rec = await update(ctx, ORD, oid, {"status": "Resulted", "verified_at": None, "verified_by": None, "tat_minutes": None,
                                           "rollbacks": [*(o.get("rollbacks") or []), entry], "delta_reviewed_at": None})
    finally:
        ctx.__dict__["_lab_annotating"] = False
    await audit(ctx, "lab.rollback", module="lab", entity="lab_orders", record=rec, before={"status": "Verified", "verified_by": o.get("verified_by")},
                after={"status": "Resulted"}, note=body.reason.strip())
    live(ctx, "alerts", {"type": "report_withdrawn", "order_id": oid, "code": o["code"], "patient_id": o["patient_id"],
                         "reason": body.reason.strip()})
    return {"id": oid, "code": rec["code"], "status": rec["status"]}


# ================================================================== rejected reports & cancellations register

EVENT_KINDS = {"sample.reject": "sample", "lab.result_reject": "rerun", "lab.result_cancel": "cancelled", "lab.rollback": "rollback"}


@router.get("/rejected")
async def rejected(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None,
                   kind: Literal["all", "sample", "rerun", "cancelled", "rollback"] = "all", q: str | None = None):
    rs.ensure_access(ctx, E(SAMPLES), "read")
    start, end = _range_bounds(date_from or (today() - timedelta(days=6)).isoformat(), date_to or today().isoformat())
    a = audit_log
    actions = [k for k, v in EVENT_KINDS.items() if kind in ("all", v)]
    rows = (await ctx.conn.execute(sa.select(a).where(a.c.action.in_(actions), a.c.at >= start, a.c.at < end)
                                   .order_by(a.c.at.desc()).limit(1000))).all()
    ids = list({r.record_id for r in rows if r.record_id and is_uuid(r.record_id)})
    cur = {x["id"]: x for x in await _rows(ctx, _query().where(orders.c.id.in_(ids)))} if ids else {}
    term = (q or "").strip().lower()
    out, counts = [], defaultdict(int)
    for r in rows:
        x = cur.get(r.record_id)
        if not x:
            continue
        if term and not any(term in str(v or "").lower() for v in (x["code"], x["patient"]["name"], x["patient"]["uhid"], x["test"]["name"],
                                                                   r.note, (r.before or {}).get("sample_barcode"))):
            continue
        k = EVENT_KINDS[r.action]
        counts[k] += 1
        out.append({"id": str(r.id), "kind": k, "at": to_json_value(r.at), "by": r.user_name, "role": r.role, "reason": r.note,
                    "order": {"id": x["id"], "code": x["code"], "status": x["status"], "sample_barcode": x["sample_barcode"],
                              "recollect_count": x.get("recollect_count")},
                    "patient": x["patient"], "location": x["location"], "test": x["test"]["name"], "section": x["test"]["section"],
                    "previous_values": (r.before or {}).get("result_values") or [], "verified_by": (r.before or {}).get("verified_by")})
    return {"rows": out, "counts": {"all": sum(counts.values()), **counts}, "from": start.date().isoformat(),
            "to": (end - timedelta(days=1)).date().isoformat()}


# ================================================================== sample tracking (timeline per barcode)

def _event_label(r) -> tuple[str, str] | None:
    after, before = r.after or {}, r.before or {}
    act = r.action
    if act == "create":
        return ("Sample collected", "collect") if r.entity == "samples" else ("Ordered", "order")
    if act == "status":
        to = after.get("status")
        if r.entity == "samples":
            return {"Received": ("Tube received in lab", "receive"), "Rejected": ("Tube rejected", "reject"),
                    "Processed": ("Tube processed", "process")}.get(to, (f"Tube {to}", "status"))
        return {"Collected": ("Sample collected", "collect"), "In Progress": ("Received / processing", "receive"),
                "Resulted": ("Result entered", "result"), "Verified": ("Authorised — report released", "verify"),
                "Cancelled": ("Order cancelled", "cancel")}.get(to, (f"Status → {to}", "status"))
    if act == "update":
        if after.get("result_values") and before.get("result_values"):
            def vals(x):
                return {str(v.get("parameter")): str(v.get("value")) for v in x or []}
            if vals(after["result_values"]) != vals(before["result_values"]):  # not just a re-flag
                return ("Results corrected", "amend")
        if after.get("status") == "Ordered" and before.get("status") in ("Collected", "In Progress"):
            return ("Returned for recollection", "reject")
        return None
    return {"print": ("Report printed", "print"), "lab.rollback": ("Authorisation rolled back", "rollback"),
            "lab.result_cancel": ("Result cancelled", "cancel"), "lab.result_reject": ("Sent for re-run", "rerun"),
            "sample.reject": ("Sample rejected", "reject"), "critical.notified": ("Critical value notified", "critical"),
            "critical.acknowledge": ("Critical value acknowledged", "critical"), "lab.delta_review": ("Delta check reviewed", "review"),
            "lab.reflex": ("Reflex test ordered", "reflex"), "lab.outsource": ("Sent to reference lab", "outsource"),
            "lab.outsource_receive": ("Reference lab report received", "outsource")}.get(act)


@router.get("/track")
async def track(ctx: CtxDep, q: str):
    """Chain of custody for a tube (barcode), an order number or a patient's recent tubes (UHID)."""
    _read(ctx)
    term = q.strip()
    if len(term) < 3:
        raise bad_request("Scan a barcode or enter an order number / UHID")
    o = orders
    cond = sa.or_(o.c.data["sample_barcode"].astext == term, sa.func.lower(o.c.code) == term.lower(),
                  sa.func.upper(patients.c.code) == term.upper())
    rows = await _rows(ctx, _query().where(o.c.category == "LAB", cond, o.c.ordered_at >= now() - timedelta(days=90))
                       .order_by(o.c.ordered_at.desc()), limit=60)
    if not rows and has(SAMPLES):
        s = await _sample(ctx, term)
        if s:  # a rejected tube: its tests were sent back for recollection and no longer carry the barcode
            ids = [i for i in (s.get("orders") or [s.get("order")]) if i]
            rows = await _rows(ctx, _query().where(o.c.id.in_(ids)))
            for x in rows:
                if x["sample_barcode"] != s.get("barcode"):
                    x["current_barcode"] = x["sample_barcode"]
                    x["sample_barcode"] = s.get("barcode")
    if not rows:
        raise not_found(f"Nothing found for “{term}”")
    tubes: dict[str, dict] = {}
    for x in rows:
        key = x["sample_barcode"] or f"order:{x['id']}"
        t = tubes.setdefault(key, {"barcode": x["sample_barcode"], "patient": x["patient"], "location": x["location"], "orders": []})
        t["orders"].append(_strip(x))
    for t in list(tubes.values())[:20]:
        order_ids = [x["id"] for x in t["orders"]]
        s = await _sample(ctx, t["barcode"]) if t["barcode"] else None
        t["sample"] = {k: s.get(k) for k in ("id", "code", "status", "sample_type", "container", "collected_at", "received_at",
                                             "received_by", "rejection_reason", "rejected_by", "collection_point")} if s else None
        ids = order_ids + ([s["id"]] if s else [])
        so = await find(ctx, SEND_OUTS, order=order_ids[0], limit=5) if has(SEND_OUTS) else []
        ids += [x["id"] for x in so]
        a = audit_log
        evs = (await ctx.conn.execute(sa.select(a).where(a.c.record_id.in_(ids)).order_by(a.c.at.asc()).limit(400))).all()
        code_of = {x["id"]: (x["code"], x["test"]["name"]) for x in t["orders"]}
        events, seen = [], set()
        for r in evs:
            lab = _event_label(r)
            if not lab:
                continue
            label, kind = lab
            code, test = code_of.get(r.record_id, (r.record_code, None))
            key = (label, r.at.replace(microsecond=0), r.record_id if kind in ("order", "result", "verify", "print") else None)
            if key in seen:
                continue
            seen.add(key)
            events.append({"at": to_json_value(r.at), "label": label, "kind": kind, "by": r.user_name, "role": r.role, "note": r.note,
                           "order": code, "test": test})
        ts = now()
        start = min((x["ordered_at"] for x in t["orders"] if x["ordered_at"]), default=None)
        t["events"] = events
        t["elapsed_minutes"] = round((ts - datetime.fromisoformat(start)).total_seconds() / 60) if start else None
        t["status"] = min((x["status"] for x in t["orders"]),
                          key=lambda s: ["Ordered", "Collected", "In Progress", "Resulted", "Verified", "Cancelled"].index(s)
                          if s in ("Ordered", "Collected", "In Progress", "Resulted", "Verified", "Cancelled") else 9)
    return {"tubes": list(tubes.values())[:20], "query": term}


# ================================================================== microbiology (culture & sensitivity)

@router.get("/micro/meta")
async def micro_meta(ctx: CtxDep):
    _bench(ctx)
    panels: dict[str, list[str]] = {}
    if has(ANTIBIOTICS):
        master = await _active_rows(ctx, ANTIBIOTICS)
        for ab in sorted(master, key=lambda a: (float(a.get("sort_order") or 10), str(a.get("name") or ""))):
            for pnl in ab.get("panels") or []:
                panels.setdefault(pnl, []).append(ab["name"])
    source = "master" if panels else "built-in"
    for k, v in BUILTIN_PANELS.items():
        panels.setdefault(k, v)
    return {"organisms": [{"name": n, "panel": p} for n, p in ORGANISMS], "panels": panels, "panel_source": source,
            "specimens": SPECIMENS, "culture_results": ["No growth", "Growth", "Normal flora", "Contaminated — repeat sample"],
            "colony_counts": ["<10^3 CFU/mL", "10^3 CFU/mL", "10^4 CFU/mL", "≥10^5 CFU/mL", "Scanty growth", "Moderate growth", "Heavy growth"],
            "interpretations": ["S", "I", "R"]}


@router.get("/micro")
async def micro_list(ctx: CtxDep, stage: Literal["pending", "resulted", "all"] = "pending", q: str | None = None):
    _bench(ctx)
    o = orders
    start, _ = day_bounds(today() - timedelta(days=2))
    statuses = {"pending": list(PENDING), "resulted": ["Resulted"], "all": [*PENDING, "Resulted", "Verified"]}[stage]
    stmt = _query().where(o.c.category == "LAB", o.c.status.in_(statuses))
    if stage == "all":
        stmt = stmt.where(sa.or_(o.c.status != "Verified", o.c.verified_at >= start))
    rows = [x for x in await _rows(ctx, stmt.order_by(o.c.ordered_at.asc())) if x["test"]["section"] == "Microbiology"]
    term = (q or "").strip().lower()
    if term:
        rows = [x for x in rows if any(term in str(v or "").lower() for v in (x["code"], x["sample_barcode"], x["patient"]["uhid"],
                                                                              x["patient"]["name"], x["test"]["name"]))]
    rows.sort(key=ordx._sort_key)
    demo = await _demo(ctx, [x["patient"]["id"] for x in rows])
    for x in rows:
        x["patient"]["age_label"] = (demo.get(x["patient"]["id"]) or {}).get("age")
        x["hours_incubated"] = round((now() - datetime.fromisoformat(x["collected_at"])).total_seconds() / 3600) if x["collected_at"] else None
    return {"rows": [_strip(x) for x in rows], "counts": {"pending": sum(1 for x in rows if x["status"] in PENDING),
                                                          "preliminary": sum(1 for x in rows if (x.get("micro") or {}).get("preliminary_at")),
                                                          "resulted": sum(1 for x in rows if x["status"] == "Resulted")}}


class Sensitivity(BaseModel):
    antibiotic: str = Field(min_length=2, max_length=80)
    interpretation: Literal["S", "I", "R"]
    mic: str | None = Field(default=None, max_length=20)


class Organism(BaseModel):
    organism: str = Field(min_length=2, max_length=120)
    colony_count: str | None = Field(default=None, max_length=40)
    significance: str | None = Field(default=None, max_length=120)
    resistance: list[Literal["ESBL", "MRSA", "VRE", "CRE", "MDR", "XDR", "Carbapenemase"]] = Field(default_factory=list)
    sensitivity: list[Sensitivity] = Field(default_factory=list, max_length=40)


class MicroIn(BaseModel):
    specimen: str | None = Field(default=None, max_length=80)
    gram_stain: str | None = Field(default=None, max_length=500)
    culture_result: Literal["No growth", "Growth", "Normal flora", "Contaminated — repeat sample"]
    incubation_hours: int | None = Field(default=None, ge=0, le=720)
    organisms: list[Organism] = Field(default_factory=list, max_length=4)
    comments: str | None = Field(default=None, max_length=2000)
    final: bool = False


def _micro_text(m: MicroIn) -> tuple[list[dict], str]:
    values: list[dict] = []
    lines = []
    if m.specimen:
        lines.append(f"Specimen: {m.specimen}")
    if m.gram_stain:
        lines.append(f"Gram stain: {m.gram_stain}")
    inc = f" after {m.incubation_hours} hours of incubation" if m.incubation_hours else ""
    if m.culture_result != "Growth":
        values.append({"parameter": "Culture", "value": f"{m.culture_result}{inc}"})
        lines.append(f"Culture: {m.culture_result}{inc}.")
    else:
        values.append({"parameter": "Culture", "value": f"Growth of {len(m.organisms)} organism{'s' if len(m.organisms) > 1 else ''}{inc}"})
        for i, org in enumerate(m.organisms, 1):
            tag = f" [{', '.join(org.resistance)}]" if org.resistance else ""
            values.append({"parameter": f"Organism {i}", "value": f"Isolated: {org.organism}{' — ' + org.colony_count if org.colony_count else ''}{tag}"})
            lines.append(f"Organism {i}: {org.organism}{' (' + org.colony_count + ')' if org.colony_count else ''}{tag}")
            if org.sensitivity:
                for key, label in (("S", "Sensitive"), ("I", "Intermediate"), ("R", "Resistant")):
                    abx = [s.antibiotic + (f" (MIC {s.mic})" if s.mic else "") for s in org.sensitivity if s.interpretation == key]
                    if abx:
                        lines.append(f"  {label}: {', '.join(abx)}")
    if m.comments:
        lines.append(f"Comments: {m.comments}")
    return values, "\n".join(lines)


@router.post("/micro/{oid}")
async def micro_save(oid: str, body: MicroIn, ctx: CtxDep):
    """Save a culture & sensitivity report. A preliminary report keeps the test at the bench; the final
    report is resulted through the orders engine (flags, critical alerts) for pathologist authorisation."""
    _bench(ctx, edit=True)
    o = await get(ctx, ORD, oid)
    if not o or o.get("category") != "LAB":
        raise not_found("Lab order not found")
    if o["status"] not in (*PENDING, "Resulted"):
        raise conflict(f"{o['code']} is {o['status']} — culture reports can be entered only before authorisation")
    if body.culture_result == "Growth" and not body.organisms:
        raise bad_request("Add at least one isolated organism (or choose No growth)")
    if body.culture_result != "Growth" and body.organisms:
        raise bad_request("Organisms can be recorded only when the culture shows growth")
    for org in body.organisms:
        names = [s.antibiotic.lower() for s in org.sensitivity]
        if len(names) != len(set(names)):
            raise bad_request(f"{org.organism}: an antibiotic is listed twice")
    micro = {**body.model_dump(exclude={"final"}), "updated_at": _stamp(), "updated_by": ctx.user.get("name")}
    prev = o.get("micro") or {}
    if not body.final:
        micro["preliminary_at"] = prev.get("preliminary_at") or _stamp()
        micro["preliminary_by"] = prev.get("preliminary_by") or ctx.user.get("name")
    else:
        micro.update(preliminary_at=prev.get("preliminary_at"), preliminary_by=prev.get("preliminary_by"), final_at=_stamp())
    await update(ctx, ORD, oid, {"micro": micro})
    if body.final:
        values, text = _micro_text(body)
        await ordx.enter_results(oid, ordx.ResultsIn(values=[ordx.ValueIn(**v) for v in values], result=text,
                                                     impression=body.comments, critical=False), ctx)
    elif o["status"] == "Collected":
        await ordx._receive_tube(ctx, o)
    cur = await get(ctx, ORD, oid)
    return {"id": oid, "code": cur["code"], "status": cur["status"], "micro": cur.get("micro"), "final": body.final}


# ================================================================== out-sourcing to reference labs

async def _lab_or_404(ctx, lid: str) -> dict:
    lab = await get(ctx, REF_LABS, lid) if has(REF_LABS) else None
    if not lab:
        raise bad_request("Choose a reference lab", {"fields": {"reference_lab": "Required"}})
    if (lab.get("status") or "Active") != "Active":
        raise conflict(f"{lab.get('name')} is inactive")
    return lab


@router.get("/outsourcing")
async def outsourcing(ctx: CtxDep, status: str | None = None):
    _bench(ctx)
    o = orders
    cand = await _rows(ctx, _query().where(o.c.category == "LAB", o.c.status.in_(list(PENDING)), o.c.data["send_out"].astext.is_(None))
                       .order_by(o.c.ordered_at.asc()), limit=1500)
    candidates = [_strip({**x, "suggested_lab": x["_svc"].get("reference_lab")}) for x in cand if x["_svc"].get("outsourced")]
    others = [_strip(x) for x in cand if not x["_svc"].get("outsourced")][:300]
    rows = []
    if has(SEND_OUTS):
        recs = await find(ctx, SEND_OUTS, status=[s for s in (status or "").split(",") if s] or None, sort="-created_at", limit=300)
        demo = await _demo(ctx, [r.get("patient_id") for r in recs])
        for r in recs:
            refs = r.get("_refs") or {}
            exp = parse_date(r.get("expected_by")) if r.get("expected_by") else None
            rows.append({**{k: r.get(k) for k in ("id", "code", "status", "order", "manifest_no", "dispatched_at", "courier", "docket_no",
                                                   "expected_by", "received_at", "external_ref", "report_file", "cost", "remarks",
                                                   "sample_barcode", "order_code", "test_name", "lab_name", "created_at", "reference_lab")},
                         "patient": demo.get(str(r.get("patient_id"))), "lab": refs.get(r.get("reference_lab") or "") or r.get("lab_name"),
                         "overdue": bool(exp and r.get("status") == "Dispatched" and exp < today())})
    labs = [{"id": x["id"], "name": x.get("name"), "turnaround_days": x.get("turnaround_days"), "accreditation": x.get("accreditation")}
            for x in await _active_rows(ctx, REF_LABS)] if has(REF_LABS) else []
    counts = defaultdict(int)
    for r in rows:
        counts[r["status"]] += 1
    counts["overdue"] = sum(1 for r in rows if r["overdue"])
    return {"candidates": candidates, "others": others, "rows": rows, "labs": labs, "counts": counts}


class SendOutIn(BaseModel):
    order_ids: list[str] = Field(min_length=1, max_length=100)
    reference_lab: str
    dispatch_now: bool = True
    courier: str | None = Field(default=None, max_length=80)
    docket_no: str | None = Field(default=None, max_length=60)
    expected_by: str | None = None
    remarks: str | None = Field(default=None, max_length=300)


@router.post("/outsourcing", status_code=201)
async def send_out(body: SendOutIn, ctx: CtxDep):
    _bench(ctx, edit=True)
    lab = await _lab_or_404(ctx, body.reference_lab)
    day = now().strftime("%Y%m%d")
    manifest = f"OSM-{day}-{await next_seq(ctx.conn, f'lab-manifest:{day}'):03d}"
    expected = parse_date(body.expected_by) if body.expected_by else today() + timedelta(days=int(lab.get("turnaround_days") or 3))
    created = []
    for oid in dict.fromkeys(body.order_ids):
        o = await get(ctx, ORD, oid)
        if not o or o.get("category") != "LAB":
            raise not_found("Lab order not found")
        if o["status"] not in PENDING:
            raise conflict(f"{o['code']} is {o['status']} — only collected samples can be sent out")
        if o.get("send_out"):
            raise conflict(f"{o['code']} has already been sent to a reference lab")
        svc = (await _services(ctx, [o.get("service_id")])).get(str(o.get("service_id"))) or {}
        if o["status"] == "Collected":
            await transition(ctx, ORD, oid, "In Progress", note=f"Sent to reference lab {lab.get('name')}")
        rec = await create(ctx, SEND_OUTS, {
            "patient_id": o["patient_id"], "order": oid, "test": o.get("service_id"), "reference_lab": lab["id"],
            "sample_barcode": o.get("sample_barcode"), "manifest_no": manifest, "expected_by": expected.isoformat(),
            "courier": body.courier, "docket_no": body.docket_no, "remarks": body.remarks,
            "dispatched_at": _stamp() if body.dispatch_now else None, "status": "Dispatched" if body.dispatch_now else "To dispatch",
            "order_code": o["code"], "test_name": svc.get("name") or svc.get("title"), "lab_name": lab.get("name"),
            "sent_by": ctx.user.get("name"),
        })
        await update(ctx, ORD, oid, {"send_out": rec["id"], "outsourced_to": lab.get("name")})
        await audit(ctx, "lab.outsource", module="lab", entity="lab_orders", record=o, note=f"{lab.get('name')} · manifest {manifest}")
        created.append({"id": rec["id"], "code": rec["code"], "order_code": o["code"], "status": rec["status"]})
    return {"manifest_no": manifest, "send_outs": created, "expected_by": expected.isoformat()}


async def _send_out(ctx, sid: str) -> dict:
    so = await get(ctx, SEND_OUTS, sid) if has(SEND_OUTS) else None
    if not so:
        raise not_found("Send-out not found")
    return so


class DispatchIn(BaseModel):
    courier: str | None = Field(default=None, max_length=80)
    docket_no: str | None = Field(default=None, max_length=60)
    expected_by: str | None = None


@router.post("/outsourcing/{sid}/dispatch")
async def dispatch(sid: str, body: DispatchIn, ctx: CtxDep):
    _bench(ctx, edit=True)
    so = await _send_out(ctx, sid)
    if so["status"] != "To dispatch":
        raise conflict(f"{so['code']} is {so['status']}")
    patch = {"status": "Dispatched", "dispatched_at": _stamp(), "courier": body.courier or so.get("courier"),
             "docket_no": body.docket_no or so.get("docket_no")}
    if body.expected_by:
        patch["expected_by"] = parse_date(body.expected_by).isoformat()
    rec = await update(ctx, SEND_OUTS, sid, patch)
    return {"id": sid, "status": rec["status"]}


class ReceiveReportIn(BaseModel):
    external_ref: str | None = Field(default=None, max_length=60)
    report_file: str | None = None
    values: list[SheetValue] = Field(default_factory=list, max_length=80)
    result: str | None = Field(default=None, max_length=20000)
    impression: str | None = Field(default=None, max_length=2000)
    cost: float | None = Field(default=None, ge=0)


@router.post("/outsourcing/{sid}/receive")
async def receive_report(sid: str, body: ReceiveReportIn, ctx: CtxDep):
    """Reference lab report received: attach it and result the order (values and / or narrative) for authorisation."""
    _bench(ctx, edit=True)
    so = await _send_out(ctx, sid)
    if so["status"] not in ("Dispatched", "To dispatch"):
        raise conflict(f"{so['code']} is {so['status']}")
    if body.report_file and not is_uuid(body.report_file):
        raise bad_request("Invalid report file")
    values = [ordx.ValueIn(parameter=v.parameter, value=v.value) for v in body.values if v.value not in (None, "") and str(v.value).strip()]
    text = (body.result or "").strip()
    if not values and not text and not body.report_file:
        raise bad_request("Enter the result values, the report text or attach the reference lab's report")
    if not values and not text:
        text = f"Report from {so.get('lab_name')}{' (ref. ' + body.external_ref + ')' if body.external_ref else ''} — see the attached report."
    o = await get(ctx, ORD, so["order"])
    if not o:
        raise not_found("The order for this send-out no longer exists")
    if o["status"] in ("Verified", "Cancelled"):
        raise conflict(f"{o['code']} is already {o['status']}")
    await ordx.enter_results(o["id"], ordx.ResultsIn(values=values, result=text, impression=body.impression), ctx)
    rec = await update(ctx, SEND_OUTS, sid, {"status": "Report received", "received_at": _stamp(), "external_ref": body.external_ref,
                                             "report_file": body.report_file, "received_by": ctx.user.get("name"),
                                             **({"cost": body.cost} if body.cost is not None else {})})
    await audit(ctx, "lab.outsource_receive", module="lab", entity="lab_orders", record=o, note=f"{so.get('lab_name')} {body.external_ref or ''}".strip())
    return {"id": sid, "status": rec["status"], "order_id": o["id"]}


@router.post("/outsourcing/{sid}/cancel")
async def cancel_send_out(sid: str, body: ReasonIn, ctx: CtxDep):
    _bench(ctx, edit=True)
    so = await _send_out(ctx, sid)
    if so["status"] not in ("To dispatch", "Dispatched"):
        raise conflict(f"{so['code']} is {so['status']}")
    rec = await update(ctx, SEND_OUTS, sid, {"status": "Cancelled", "cancel_reason": body.reason.strip()})
    o = await get(ctx, ORD, so["order"])
    if o and o.get("send_out") == sid:
        await update(ctx, ORD, o["id"], {"send_out": None, "outsourced_to": None})
    await audit(ctx, "lab.outsource_cancel", module="lab", entity="send_outs", record=rec, note=body.reason.strip())
    return {"id": sid, "status": rec["status"]}


__all__ = ["router", "annotate", "patient_params", "evaluate_deltas"]
