"""IP billing and the discharge desk.

* The live **approximate (working) bill** per admission: charges by service search with date, qty,
  rate and ₹/% line discounts; packages with include-in-package / cover-all toggles; inline tariff
  price and discount edits (role-guarded, audited); a bill-level discount after line discounts with
  approval above policy; GST posting; administration charges; no-show items; billing ward changes
  that re-price room rent and ward-specific rates from the change date.
* **Sponsors & tariffs**: sponsor price lists or % on the hospital tariff (billing.tariffs), Change
  Sponsor re-pricing (prices only, or organisation + prices) with per-billing-head status, the
  patient / sponsor split (co-pay %, approved amount from the credit letter / pre-auth), corporate
  package prices and the corporate approximate (pre-auth) estimate.
* **Print formats** rendered as print-optimised HTML (interim receipt, summarised, semi-summarised,
  final, non-medical summary / detail, pharmacy, sponsor formats, detailed GST), case sheet and
  check-out slip.
* **Discharge desk**: queue, discharged list, the settle → details → release-bed wizard with
  split-mode collection, settlement adjustments, discharge types and the hard block on an
  outstanding balance; confirming runs the admission transition so ADT's readiness checks and bed
  release apply. Reopening a settled bill needs approval and is fully audited.

Money model: charges keep `amount = rate × qty` and `discount` (₹) in their columns; IP-bill line
attributes (disc_mode / disc_value, in_package, kind=package, base_rate, price_source, ward_type …)
live in the charge's `data`. Receipts taken before settlement are advances (DEPOSIT, tagged to the
admission); settlement finalises the unbilled lines into an IP invoice, posts the sponsor credit
(ADJUSTMENT · INSURANCE → insurance claim) and adjusts the advance against the patient's share.
"""

from __future__ import annotations

import html
import logging
import math
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit, hook
from ..core.security import CtxDep
from ..core.util import (
    ApiError,
    age_from,
    bad_request,
    conflict,
    forbidden,
    is_uuid,
    money,
    not_found,
    now,
    parse_date,
    parse_dt,
    to_json_value,
    today,
)
from ..schema import (
    beds,
    charges,
    employees,
    encounters,
    files,
    invoices,
    orders,
    patients,
    payments,
    records,
    services,
)
from . import adt, billing
from ._common import E, create, find, first, get, has, live, require_role, transition, update
from .workflow import on_decided, request_approval

Day = date  # alias: request models have a field called "date"
log = logging.getLogger("vlack.ipbilling")
router = APIRouter(prefix="/api/ipbilling", tags=["ipbilling"])

ADM, BILL, CHG, INV, PAY = "ipd.admissions", "billing.ip_bills", "billing.charges", "billing.invoices", "billing.payments"
TARIFF, PKG, PAYER, PREAUTH, CLAIM = "billing.tariffs", "billing.packages", "insurance.payers", "insurance.preauths", "insurance.claims"
ESTIMATE, DOCS, CHK = "counseling.estimates", "documents.documents", "discharge.checklists"

OPEN = ("Admitted", "Discharge Initiated")
WRITE_ROLES = ("billing",)                  # bill edits (admin always allowed)
DESK_ROLES = ("billing", "front_office")    # receipts / advances
APPROVER_ROLES = ("admin", "management")
ICU_CATS = {"ICU", "HDU", "NICU", "PICU"}
PRIVATE_CATS = {"Private", "Deluxe", "Suite"}
WARD_CATEGORIES = ["General", "Semi-Private", "Private", "Deluxe", "ICU", "HDU", "NICU", "PICU", "Isolation", "Day Care", "ER"]
CASH_LIMIT = Decimal(200000)  # s.269ST Income-tax Act: no cash receipt of ₹2 lakh or more per person per day
ROOM_GST_THRESHOLD = Decimal(5000)  # GST 5% on non-ICU rooms charged above ₹5,000/day (notification 04/2022-CT(R))

# Wizard discharge types → ADT admission discharge types.
DISCHARGE_TYPES = {"Normal": "Routine", "DAMA": "DAMA", "LAMA": "LAMA", "Transfer": "Referred", "Absconded": "Absconded", "Death": "Death"}

GROUP_OF = {
    "LAB": "INVESTIGATION", "RAD": "INVESTIGATION", "PROC": "PROCEDURE", "OT": "PROCEDURE", "DIALYSIS": "PROCEDURE",
    "PHYSIO": "PROCEDURE", "DENTAL": "PROCEDURE", "CONSULT": "CONSULTATION", "ROOM": "ROOM & NURSING",
    "NURSING": "ROOM & NURSING", "ICU": "ROOM & NURSING", "PHARM": "PHARMACY", "PACKAGE": "PACKAGE",
}
HEAD_OF = {
    "CONSULT": "Consultation", "LAB": "Laboratory", "RAD": "Radiology", "PROC": "Procedures", "OT": "OT & anaesthesia",
    "ROOM": "Room rent", "NURSING": "Nursing care", "ICU": "ICU care", "PHARM": "Pharmacy", "PACKAGE": "Package",
    "DIALYSIS": "Dialysis", "PHYSIO": "Physiotherapy", "DENTAL": "Dental", "AMBULANCE": "Ambulance",
    "BLOOD": "Blood bank", "DIET": "Dietary", "MISC": "Miscellaneous",
}
GROUP_ORDER = ["PACKAGE", "ROOM & NURSING", "CONSULTATION", "INVESTIGATION", "PROCEDURE", "PHARMACY", "OTHER"]

# Admission keys the IPD admission form may use for sponsor terms (read defensively).
SPONSOR_KEYS = ("sponsor", "sponsor_id", "organisation", "organisation_id", "organization", "payer_id", "insurance_payer", "corporate")
APPROVED_KEYS = ("approved_amount", "sponsor_approved_amount", "credit_limit")
CREDIT_KEYS = ("credit_letter_no", "credit_letter", "authorisation_no", "credit_ref", "preauth_no")

DEFAULT_SETTINGS: dict[str, Any] = {
    "document_types": [
        {"key": "id_proof", "label": "ID Proof", "category": "ID Proof", "formats": ["JPG", "JPEG", "PNG", "PDF"], "max_mb": 10},
        {"key": "insurance", "label": "Insurance", "category": "Insurance Card / Policy", "formats": ["JPG", "JPEG", "PNG", "PDF"], "max_mb": 10},
        {"key": "referral", "label": "Referral", "category": "Referral Letter", "formats": ["JPG", "JPEG", "PNG", "PDF"], "max_mb": 10},
        {"key": "consent", "label": "Consent", "category": "Paper Consent", "formats": ["JPG", "JPEG", "PNG", "PDF"], "max_mb": 10},
        {"key": "discharge_summary", "label": "Discharge Summary", "category": "Other", "formats": ["JPG", "JPEG", "PNG", "PDF"], "max_mb": 10},
    ],
    "print": {"default_format": "summarised", "letterhead": True, "footer": "This is a computer-generated document and does not require a physical signature."},
    "letterhead": {"name": settings.hospital_name, "address": "Guntur, Andhra Pradesh", "gstin": "", "phone": "", "email": "",
                   "tagline": "NABH accredited · 24×7 Emergency"},
    "notify_roles": {"settle": ["billing"], "details": ["doctor", "nurse"], "release": ["nurse", "support"]},
}
MIME_OF = {"JPG": "image/jpeg", "JPEG": "image/jpeg", "PNG": "image/png", "PDF": "application/pdf", "TIFF": "image/tiff",
           "WEBP": "image/webp", "HEIC": "image/heic"}


# ================================================================== small helpers

def D(v: Any) -> Decimal:
    if v in (None, ""):
        return Decimal(0)
    try:
        return Decimal(str(v))
    except Exception:  # noqa: BLE001 — malformed numbers in legacy data count as zero
        return Decimal(0)


def f2(v: Any) -> float:
    return float(money(v))


def _stamp() -> str:
    return now().isoformat(timespec="seconds")


def _d(v: Any) -> date | None:
    try:
        return parse_date(v)
    except (ValueError, TypeError):
        return None


def _los(start: Any, end: Any = None) -> int:
    s, e = parse_dt(start), parse_dt(end) or now()
    if not s:
        return 0
    return max(1, math.ceil((e - s).total_seconds() / 86400))


@contextmanager
def _self_priced(ctx) -> Iterator[None]:
    """Charges this engine posts are already priced — the capture-time pricing hook skips them."""
    d = ctx.__dict__
    d["_ipb_priced"] = d.get("_ipb_priced", 0) + 1
    try:
        yield
    finally:
        d["_ipb_priced"] -= 1


def _can_write(ctx) -> bool:
    return ctx.role == "admin" or ctx.role in WRITE_ROLES


def _need_write(ctx) -> None:
    require_role(ctx, *WRITE_ROLES)


def _read(ctx) -> None:
    rs.ensure_access(ctx, E(INV), "read")


# ================================================================== settings (W1 store, else defaults)

def _merge(base: Any, over: Any) -> Any:
    if isinstance(base, dict) and isinstance(over, dict):
        return {k: _merge(base.get(k), over[k]) if k in base else over[k] for k in over} | {k: v for k, v in base.items() if k not in over}
    return over if over not in (None, "") else base


async def ipb_settings(ctx) -> dict:
    """Effective IP-billing settings: the admin-configured values (W1 settings store, when installed)
    merged over the defaults. Never fails — prints and uploads must work without configuration."""
    cfg = DEFAULT_SETTINGS
    try:
        import importlib

        mod = importlib.import_module("app.engines.settings")
        loader = getattr(mod, "get_settings", None) or getattr(mod, "load_settings", None)
        if loader:
            stored = await loader(ctx, "ipbilling")
            if isinstance(stored, dict):
                cfg = _merge(DEFAULT_SETTINGS, stored.get("value", stored))
    except Exception:  # noqa: BLE001 — settings store missing or not yet configured
        pass
    lh = dict(cfg.get("letterhead") or {})
    lh.setdefault("name", settings.hospital_name)
    if not lh.get("name"):
        lh["name"] = settings.hospital_name
    return {**cfg, "letterhead": lh}


@router.get("/settings")
async def settings_api(ctx: CtxDep):
    _read(ctx)
    return await ipb_settings(ctx)


# ================================================================== loaders

async def _admission(ctx, eid: str) -> dict:
    adm = await get(ctx, ADM, eid)
    if not adm:
        raise not_found("Admission not found")
    return adm


async def _states(ctx, eids: list[str]) -> dict[str, dict]:
    ids = [e for e in eids if is_uuid(e)]
    if not ids:
        return {}
    ent = E(BILL)
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t).where(*rs.base_where(ent), t.c.encounter_id.in_(ids))
                                   .order_by(t.c.created_at.asc()))).all()
    return {str(r.encounter_id): rs.to_record(r) for r in rows}


async def _state(ctx, eid: str) -> dict:
    return (await _states(ctx, [eid])).get(eid) or {}


async def _services(ctx, ids: set[str]) -> dict[str, dict]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(services).where(services.c.id.in_(list(ids))))).all()
    return {str(r.id): rs.to_record(r) for r in rows}


async def _service_by_code(ctx, code: str) -> dict | None:
    row = (await ctx.conn.execute(sa.select(services).where(services.c.code == code, services.c.deleted_at.is_(None)))).first()
    return rs.to_record(row) if row else None


async def _load_lines(ctx, eids: list[str], *, unbilled_only: bool = False) -> dict[str, list[dict]]:
    ids = [e for e in eids if is_uuid(e)]
    out: dict[str, list[dict]] = defaultdict(list)
    if not ids:
        return out
    t = charges
    conds = [t.c.encounter_id.in_(ids), t.c.deleted_at.is_(None)]
    conds.append(t.c.status == "Unbilled" if unbilled_only else t.c.status != "Cancelled")
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(t.c.charged_at.asc().nulls_last(), t.c.created_at.asc()))).all()
    recs = [rs.to_record(r) for r in rows]
    svcs = await _services(ctx, {r.get("service_id") for r in recs})
    for r in recs:
        r["_svc"] = svcs.get(r.get("service_id") or "")
        out[str(r["encounter_id"])].append(r)
    return out


async def _invoices(ctx, eids: list[str]) -> dict[str, list[dict]]:
    ids = [e for e in eids if is_uuid(e)]
    out: dict[str, list[dict]] = defaultdict(list)
    if not ids:
        return out
    t = invoices
    rows = (await ctx.conn.execute(sa.select(t).where(t.c.encounter_id.in_(ids), t.c.deleted_at.is_(None), t.c.status != "Cancelled")
                                   .order_by(t.c.billed_at.asc()))).all()
    for r in rows:
        rec = rs.to_record(r)
        out[str(rec["encounter_id"])].append(rec)
    return out


async def _invoice_payments(ctx, inv_ids: list[str]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    if not inv_ids:
        return out
    t = payments
    rows = (await ctx.conn.execute(sa.select(t).where(t.c.invoice_id.in_(inv_ids), t.c.deleted_at.is_(None), t.c.status == "Success"))).all()
    for r in rows:
        rec = rs.to_record(r)
        out[str(rec["invoice_id"])].append(rec)
    return out


async def _deposit_balances(ctx, pids: list[str]) -> dict[str, Decimal]:
    ids = [p for p in pids if p and is_uuid(p)]
    if not ids:
        return {}
    t = payments
    signed = sa.case(
        (t.c.kind == "DEPOSIT", t.c.amount),
        (sa.and_(t.c.kind == "ADJUSTMENT", t.c.mode == "DEPOSIT"), -t.c.amount),
        (sa.and_(t.c.kind == "REFUND", t.c.invoice_id.is_(None)), -t.c.amount),
        else_=0,
    )
    rows = (await ctx.conn.execute(sa.select(t.c.patient_id, sa.func.coalesce(sa.func.sum(signed), 0)).where(
        t.c.patient_id.in_(ids), t.c.deleted_at.is_(None), t.c.status == "Success").group_by(t.c.patient_id))).all()
    return {str(pid): Decimal(v) for pid, v in rows}


async def _records_by_ids(ctx, module: str, entity: str, ids: set[str]) -> dict[str, dict]:
    ids = {i for i in ids if i and is_uuid(i)}
    if not ids:
        return {}
    t = records
    rows = (await ctx.conn.execute(sa.select(t).where(t.c.id.in_(list(ids)), t.c.module == module, t.c.entity == entity,
                                                      t.c.deleted_at.is_(None)))).all()
    return {str(r.id): rs.to_record(r) for r in rows}


async def _preauth_approved(ctx, eids: list[str]) -> dict[str, dict]:
    """Latest approved pre-authorisation per admission (amount + payer)."""
    if not has(PREAUTH) or not eids:
        return {}
    ent = E(PREAUTH)
    t = ent.table
    rows = (await ctx.conn.execute(sa.select(t).where(*rs.base_where(ent), t.c.data["admission"].astext.in_(eids),
                                                      t.c.status.in_(["Approved", "Enhancement Requested"]))
                                   .order_by(t.c.created_at.asc()))).all()
    out: dict[str, dict] = {}
    for r in rows:
        rec = rs.to_record(r)
        out[str(rec.get("admission"))] = rec
    return out


async def _info(ctx, adms: list[dict]) -> dict[str, dict]:
    """Patient, bed, ward, consultant and department for each admission (batched)."""
    pids = {a["patient_id"] for a in adms if a.get("patient_id")}
    bids = {a["bed_id"] for a in adms if a.get("bed_id")}
    dids = {a["doctor_id"] for a in adms if a.get("doctor_id")}
    pts = {str(r.id): r for r in (await ctx.conn.execute(sa.select(
        patients.c.id, patients.c.code, patients.c.title, patients.c.first_name, patients.c.last_name, patients.c.gender,
        patients.c.dob, patients.c.phone, patients.c.blood_group, patients.c.data).where(patients.c.id.in_(list(pids))))).all()} if pids else {}
    bds = {str(r.id): r for r in (await ctx.conn.execute(sa.select(
        beds.c.id, beds.c.code, beds.c.bed_no, beds.c.category, beds.c.rate, beds.c.ward_id).where(beds.c.id.in_(list(bids))))).all()} if bids else {}
    wards = await _records_by_ids(ctx, "mdm", "wards", {str(b.ward_id) for b in bds.values() if b.ward_id})
    docs = {str(r.id): r.title for r in (await ctx.conn.execute(sa.select(employees.c.id, employees.c.title).where(
        employees.c.id.in_(list(dids))))).all()} if dids else {}
    depts = await _records_by_ids(ctx, "mdm", "departments", {a.get("department_id") for a in adms})
    out = {}
    for a in adms:
        p = pts.get(a.get("patient_id") or "")
        b = bds.get(a.get("bed_id") or "")
        w = wards.get(str(b.ward_id)) if b and b.ward_id else None
        pdata = (p.data or {}) if p else {}
        out[a["id"]] = {
            "patient": {
                "id": a.get("patient_id"), "uhid": p.code if p else None, "name": (p.title if p else None) or "—",
                "gender": p.gender if p else None, "age": age_from(p.dob) if p else None, "dob": to_json_value(p.dob) if p else None,
                "phone": p.phone if p else None, "blood_group": p.blood_group if p else None,
                "category": pdata.get("category"), "payer_type": pdata.get("payer_type"), "photo": pdata.get("photo"),
                "allergy_tags": pdata.get("allergies") or [],
            },
            "bed": {"id": str(b.id), "bed_no": b.bed_no or b.code, "category": b.category, "rate": to_json_value(b.rate)} if b else None,
            "ward": {"id": w["id"], "name": w.get("name") or w.get("title"), "floor": w.get("floor"), "type": w.get("ward_type")} if w else None,
            "doctor": docs.get(a.get("doctor_id") or ""),
            "department": (depts.get(a.get("department_id") or "") or {}).get("name") or (depts.get(a.get("department_id") or "") or {}).get("title"),
        }
    return out


# ================================================================== sponsor terms & tariffs

def _adm_value(adm: dict, keys: tuple[str, ...]) -> Any:
    for k in keys:
        v = adm.get(k)
        if v not in (None, ""):
            return v
    return None


def _adm_sponsor(adm: dict) -> str | None:
    for k in SPONSOR_KEYS:
        v = adm.get(k)
        if v and is_uuid(v):
            return str(v)
    return None


PAYER_TYPE_OF = {"Insurer": "Insurance", "TPA": "Insurance", "Corporate": "Corporate", "Government Scheme": "Government Scheme"}


def _payer_type(adm: dict, st: dict, payer: dict | None) -> str:
    if st.get("payer_type"):
        return st["payer_type"]
    if payer:
        return PAYER_TYPE_OF.get(payer.get("payer_type") or "", "Insurance")
    p = str(adm.get("payer") or adm.get("category") or "Cash")
    return {"Cash": "Self", "General": "Self", "Self": "Self", "Self-pay": "Self"}.get(p, p)


def _terms(adm: dict, st: dict, payers: dict[str, dict], preauth: dict | None) -> dict:
    sponsor_id = st.get("sponsor") if "sponsor" in st else None
    if not st:
        sponsor_id = _adm_sponsor(adm) or (preauth or {}).get("payer")
    payer = payers.get(sponsor_id or "")
    ptype = _payer_type(adm, st, payer)
    approved = st.get("approved_amount")
    source = "IP bill"
    if approved in (None, ""):
        if preauth and preauth.get("approved_amount") not in (None, ""):
            approved, source = preauth.get("approved_amount"), f"Pre-auth {preauth.get('code')}"
        else:
            approved, source = _adm_value(adm, APPROVED_KEYS), "Admission credit letter"
    copay = st.get("co_pay_percent")
    if copay in (None, ""):
        copay = adm.get("co_pay_percent") or (payer or {}).get("default_co_pay_percent") or 0
    sponsored = ptype != "Self" and bool(sponsor_id or approved)
    return {
        "sponsor_id": sponsor_id, "sponsor_name": (payer or {}).get("name") or (payer or {}).get("title"),
        "payer_type": ptype, "sponsored": sponsored, "approved_amount": f2(approved) if approved not in (None, "") else None,
        "approved_source": source if approved not in (None, "") else None, "co_pay_percent": float(D(copay)),
        "credit_ref": st.get("credit_ref") or _adm_value(adm, CREDIT_KEYS) or (preauth or {}).get("payer_ref"),
        "price_sponsor": st.get("price_sponsor"),
    }


def _sponsor_share(net: Decimal, terms: dict) -> Decimal:
    if not terms["sponsored"] or not terms.get("approved_amount"):
        return Decimal(0)
    share = net * (Decimal(100) - D(terms["co_pay_percent"])) / 100
    return money(max(Decimal(0), min(share, D(terms["approved_amount"]))))


async def _tariff_for(ctx, st: dict, terms: dict | None = None, *, payer_id: str | None = None) -> dict | None:
    """Price tariff for a bill: the tariff picked on the bill, else the price sponsor's / sponsor's
    tariff (payer.tariff or an active tariff for that payer), else the payer's agreed discount."""
    tid = st.get("tariff")
    if tid and not payer_id:
        t = await get(ctx, TARIFF, tid)
        if t and t.get("status") == "Active":
            return t
    pid = payer_id or st.get("price_sponsor") or st.get("sponsor") or (terms or {}).get("sponsor_id")
    if not pid or not has(PAYER):
        return None
    payer = await get(ctx, PAYER, pid)
    if not payer:
        return None
    t = await get(ctx, TARIFF, payer["tariff"]) if payer.get("tariff") else None
    if not t or t.get("status") != "Active":
        t = await first(ctx, TARIFF, payer=pid, status="Active", sort="-created_at")
    if t:
        vt = _d(t.get("valid_till"))
        if not vt or vt >= today():
            return t
    if payer.get("discount_percent"):
        return {"id": None, "code": "AGREED", "name": f"{payer.get('name')} — agreed discount", "basis": "% on base tariff",
                "percent": -float(payer["discount_percent"]), "payer": pid}
    return None


def _ward_base(svc: dict, ward: str | None) -> Decimal:
    if ward in ICU_CATS and svc.get("rate_icu") not in (None, ""):
        return D(svc["rate_icu"])
    if ward in PRIVATE_CATS and svc.get("rate_private") not in (None, ""):
        return D(svc["rate_private"])
    return D(svc.get("rate"))


def _price(svc: dict, tariff: dict | None, ward: str | None) -> tuple[Decimal, str]:
    base = _ward_base(svc, ward)
    plain = "tariff" if base == D(svc.get("rate")) else f"ward:{ward}"
    if not tariff:
        return money(base), plain
    label = f"sponsor:{tariff.get('code') or tariff.get('name')}"
    basis = tariff.get("basis") or "% on base tariff"
    if basis != "% on base tariff":
        for ln in tariff.get("prices") or []:
            if ln.get("service") == svc.get("id"):
                r = ln.get("rate")
                if ward in ICU_CATS and ln.get("rate_icu") not in (None, ""):
                    r = ln["rate_icu"]
                elif ward in PRIVATE_CATS and ln.get("rate_private") not in (None, ""):
                    r = ln["rate_private"]
                return money(D(r)), label
        if basis == "Price list":
            return money(base), plain
    pct = D(tariff.get("percent"))
    for rule in tariff.get("category_rules") or []:
        if rule.get("category") == svc.get("category"):
            pct = D(rule.get("percent"))
    return money(base * (Decimal(100) + pct) / 100), label


def _package_price(pkg: dict, tariff: dict | None) -> Decimal:
    for ln in (tariff or {}).get("package_prices") or []:
        if ln.get("package") == pkg.get("id"):
            return money(D(ln.get("price")))
    return money(D(pkg.get("price")))


async def _room_rates(ctx) -> dict[str, Decimal]:
    cache = ctx.__dict__.get("_ipb_room_rates")
    if cache is None:
        rows = (await ctx.conn.execute(sa.select(beds.c.category, sa.func.percentile_cont(0.5).within_group(beds.c.rate.asc()))
                                       .where(beds.c.deleted_at.is_(None), beds.c.rate.isnot(None)).group_by(beds.c.category))).all()
        cache = {r[0]: money(D(r[1])) for r in rows if r[0]}
        ctx.__dict__["_ipb_room_rates"] = cache
    return cache


async def _room_rate(ctx, category: str, tariff: dict | None) -> Decimal:
    for ln in (tariff or {}).get("room_rates") or []:
        if ln.get("category") == category:
            return money(D(ln.get("rate")))
    rates = await _room_rates(ctx)
    return rates.get(category) or rates.get("General") or Decimal(1500)


def _nursing_code(category: str) -> str:
    return "NICU-DAILY" if category == "NICU" else "ICU-DAILY" if category in ICU_CATS else "NURSING-DAILY"


# ================================================================== line arithmetic

def _is_room(c: dict) -> bool:
    return str(c.get("source") or "").startswith("ipd.daily") and str(c.get("description") or "").lower().startswith("room rent")


def _category(c: dict) -> str:
    if c.get("kind") == "package":
        return "PACKAGE"
    src = str(c.get("source") or "")
    svc = c.get("_svc") or {}
    if src.startswith("pharmacy."):
        return "PHARM"
    if src.startswith("ipd.daily"):
        return "ROOM" if _is_room(c) else svc.get("category") or "NURSING"
    if c.get("category"):
        return c["category"]
    if svc.get("category"):
        return svc["category"]
    if src.startswith("appointments.") or src.startswith("er."):
        return "CONSULT"
    return "MISC"


def _calc(c: dict) -> dict:
    qty, rate = D(c.get("qty") or 1), D(c.get("rate"))
    gross = money(D(c.get("amount")) if c.get("amount") is not None else rate * qty)
    mode = c.get("disc_mode") or "₹"
    val = D(c.get("disc_value")) if c.get("disc_value") not in (None, "") else D(c.get("discount"))
    if gross <= 0 or val <= 0:
        disc = Decimal(0)
    elif mode == "%":
        disc = money(gross * min(val, Decimal(100)) / 100)
    else:
        disc = min(money(val), gross)
    package = c.get("kind") == "package"
    covered = bool(c.get("in_package")) and not package
    taxable = gross - disc
    gst = money(taxable * D(c.get("tax_percent")) / 100)
    cat = _category(c)
    return {"gross": gross, "disc": disc, "taxable": taxable, "gst": gst, "after": Decimal(0) if covered else taxable + gst,
            "covered": covered, "package": package, "category": cat, "group": GROUP_OF.get(cat, "OTHER"),
            "head": HEAD_OF.get(cat, "Miscellaneous")}


def _bill_discount(taxable: Decimal, st: dict) -> Decimal:
    val = D(st.get("bill_discount_value"))
    if val <= 0 or taxable <= 0:
        return Decimal(0)
    if (st.get("bill_discount_mode") or "%") == "%":
        return money(taxable * min(val, Decimal(100)) / 100)
    return min(money(val), taxable)


def _totals(lines: list[dict], st: dict) -> dict:
    calcs = [(c, _calc(c)) for c in lines]
    billable = [x for _, x in calcs if not x["covered"]]
    gross = sum((x["gross"] for x in billable), Decimal(0))
    line_disc = sum((x["disc"] for x in billable), Decimal(0))
    gst = sum((x["gst"] for x in billable), Decimal(0))
    taxable = gross - line_disc
    bd = _bill_discount(taxable, st)
    status = st.get("bill_discount_status") or "None"
    applied = bd if status == "Approved" else Decimal(0)
    pending = bd if status == "Pending" else Decimal(0)
    ratio = (taxable - applied) / taxable if taxable > 0 else Decimal(1)
    gst_net = money(gst * ratio)
    on_top = [x for _, x in calcs if not x["covered"] and not x["package"]]
    return {
        "gross": money(gross), "line_discount": money(line_disc), "bill_discount": money(applied), "bill_discount_pending": money(pending),
        "gst": gst_net, "taxable": money(taxable - applied), "net": money(taxable - applied + gst_net),
        "covered_count": sum(1 for _, x in calcs if x["covered"]),
        "covered_value": money(sum((x["gross"] for _, x in calcs if x["covered"]), Decimal(0))),
        "on_top_count": len(on_top), "on_top_amount": money(sum((x["after"] for x in on_top), Decimal(0))),
        "packages": sum(1 for _, x in calcs if x["package"]), "services": sum(1 for _, x in calcs if not x["package"]),
    }


def _jsonable(d: dict) -> dict:
    return {k: (float(v) if isinstance(v, Decimal) else v) for k, v in d.items()}


# ================================================================== money position (summary)

async def _positions(ctx, adms: list[dict]) -> dict[str, dict]:
    """Net bill, patient / sponsor split, payments and balance for each admission — the shared
    source for lists, the working bill, the discharge desk and other modules (summary endpoint)."""
    if not adms:
        return {}
    eids = [a["id"] for a in adms]
    states = await _states(ctx, eids)
    lines = await _load_lines(ctx, eids, unbilled_only=True)
    invs = await _invoices(ctx, eids)
    pays = await _invoice_payments(ctx, [i["id"] for v in invs.values() for i in v])
    open_pids = [a["patient_id"] for a in adms if a.get("status") in OPEN or (states.get(a["id"]) or {}).get("status") == "Reopened"]
    deposits = await _deposit_balances(ctx, open_pids)
    preauths = await _preauth_approved(ctx, eids)
    payer_ids = {(states.get(a["id"]) or {}).get("sponsor") or _adm_sponsor(a) or (preauths.get(a["id"]) or {}).get("payer") for a in adms}
    payers = await _records_by_ids(ctx, "insurance", "payers", {p for p in payer_ids if p})
    out = {}
    for a in adms:
        eid = a["id"]
        st = states.get(eid) or {}
        work = _totals(lines.get(eid, []), st)
        inv_list = invs.get(eid, [])
        inv_net = sum((D(i.get("net")) for i in inv_list), Decimal(0))
        sponsor_received = patient_paid = Decimal(0)
        for i in inv_list:
            for p in pays.get(i["id"], []):
                amt = D(p.get("amount"))
                if p.get("kind") == "REFUND":
                    patient_paid -= amt
                elif p.get("mode") == "INSURANCE":
                    sponsor_received += amt
                elif p.get("kind") in ("PAYMENT", "ADJUSTMENT"):
                    patient_paid += amt
        terms = _terms(a, st, payers, preauths.get(eid))
        net = money(inv_net + work["net"])
        share = _sponsor_share(net, terms)
        sponsor_payable = min(net, max(share, sponsor_received)) if net > 0 else max(share, sponsor_received)
        patient_payable = net - sponsor_payable
        advance = money(deposits.get(a["patient_id"], Decimal(0))) if a["patient_id"] in open_pids else Decimal(0)
        paid = money(patient_paid + advance)
        balance = money(patient_payable - paid)
        unbilled = len(lines.get(eid, []))
        last_inv = inv_list[-1] if inv_list else None
        if st.get("status"):
            status = st["status"]
            if status == "Final" and a.get("status") == "Discharged" and balance <= 0 and not unbilled:
                status = "Settled"
        elif a.get("status") == "Discharged" and balance <= 0 and not unbilled:
            status = "Settled"
        else:
            status = "Final" if inv_list and not unbilled else "Open"
        pay_status = ("No charges" if net <= 0 else "Paid" if balance <= 0 else "Partial" if paid > 0 or sponsor_received > 0 else "Unpaid")
        out[eid] = {
            "net": f2(net), "patient_payable": f2(patient_payable), "sponsor_payable": f2(sponsor_payable), "paid": f2(paid),
            "advance": f2(advance), "balance": f2(balance), "status": status, "bill_id": last_inv["id"] if last_inv else None,
            # extras
            "bill_code": last_inv.get("code") if last_inv else None, "working_bill_id": st.get("id"), "working_bill_code": st.get("code"),
            "payment_status": pay_status, "paid_on_bills": f2(patient_paid), "sponsor_received": f2(sponsor_received),
            "billed_net": f2(inv_net), "unbilled_net": float(work["net"]), "unbilled_count": unbilled,
            "gross": f2(sum((D(i.get("gross")) for i in inv_list), Decimal(0)) + work["gross"]),
            "discount": f2(sum((D(i.get("discount")) for i in inv_list), Decimal(0)) + work["line_discount"] + work["bill_discount"]),
            "gst": f2(sum((D(i.get("tax")) for i in inv_list), Decimal(0)) + work["gst"]),
            "bill_discount_pending": float(work["bill_discount_pending"]),
            "sponsor": {k: terms[k] for k in ("sponsor_id", "sponsor_name", "payer_type", "approved_amount", "approved_source",
                                              "co_pay_percent", "credit_ref", "sponsored")},
            "percent_paid": round(float(paid / patient_payable * 100), 1) if patient_payable > 0 else (100.0 if net > 0 else 0.0),
        }
    return out


async def _position(ctx, adm: dict) -> dict:
    return (await _positions(ctx, [adm]))[adm["id"]]


@router.get("/admissions/{eid}/summary")
async def summary(eid: str, ctx: CtxDep):
    """Contract for the IP chart / discharge tracker:
    {net, patient_payable, sponsor_payable, paid, advance, balance, status, bill_id} (+ extras)."""
    rs.ensure_access(ctx, E(ADM), "read")
    adm = await _admission(ctx, eid)
    return await _position(ctx, adm)


@router.get("/summaries")
async def summaries(ctx: CtxDep, ids: str):
    """Bulk version of the summary (census / On Bed screens): ?ids=<admission id>,<admission id>…"""
    rs.ensure_access(ctx, E(ADM), "read")
    wanted = [i for i in ids.split(",") if is_uuid(i)][:500]
    if not wanted:
        return {}
    ent = E(ADM)
    rows = (await ctx.conn.execute(sa.select(ent.table).where(*rs.base_where(ent), ent.table.c.id.in_(wanted)))).all()
    return await _positions(ctx, [rs.to_record(r) for r in rows])


# ================================================================== IP bill state

async def _ensure_state(ctx, adm: dict) -> dict:
    st = await _state(ctx, adm["id"])
    if st:
        return st
    pos = await _position(ctx, adm)
    sponsor = _adm_sponsor(adm)
    payer = await get(ctx, PAYER, sponsor) if sponsor and has(PAYER) else None
    status = "Settled" if adm.get("status") == "Discharged" and pos["status"] == "Settled" else ("Final" if pos["bill_id"] and not pos["unbilled_count"] else "Open")
    approved = _adm_value(adm, APPROVED_KEYS)
    data = {
        "patient_id": adm["patient_id"], "encounter_id": adm["id"], "opened_at": _stamp(), "status": status,
        "payer_type": _payer_type(adm, {}, payer), "sponsor": sponsor, "credit_ref": _adm_value(adm, CREDIT_KEYS),
        "approved_amount": float(D(approved)) if approved not in (None, "") else None,
        "bill_discount_mode": "%", "bill_discount_value": 0, "bill_discount_status": "None",
        "invoice": pos["bill_id"], "ward_changes": [], "approx_bills": [], "notifications": [],
    }
    if adm.get("co_pay_percent") not in (None, ""):
        data["co_pay_percent"] = adm["co_pay_percent"]
    return await create(ctx, BILL, data)


async def _snapshot(ctx, adm: dict, st: dict) -> dict:
    """Keep the IP bill register's money columns in step with the live position."""
    pos = await _position(ctx, adm)
    vals = {"net": pos["net"], "patient_payable": pos["patient_payable"], "sponsor_payable": pos["sponsor_payable"], "balance": pos["balance"]}
    if any(float(st.get(k) or 0) != v for k, v in vals.items()):
        await update(ctx, BILL, st["id"], vals)
    return pos


def _editable(adm: dict, st: dict) -> None:
    if adm.get("status") == "Cancelled":
        raise conflict("This admission was cancelled")
    if adm.get("status") == "Discharged" and st.get("status") != "Reopened":
        raise conflict("The patient is discharged and the bill is closed — reopen the bill (with approval) to change it", )
    if st.get("status") == "Reopen Requested":
        raise conflict("A reopen request is awaiting approval")


async def _editable_state(ctx, eid: str) -> tuple[dict, dict]:
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    _editable(adm, st)
    return adm, st


# ================================================================== capture-time pricing hook

@hook(CHG, "before_create")
async def _price_at_capture(ctx, draft: dict) -> None:
    """Charges captured for an inpatient (orders, daily room rent, procedures …) are stamped with the
    billing ward and priced at the bill's sponsor tariff / billing ward category when the bill has one."""
    eid = draft.get("encounter_id")
    if not eid or not is_uuid(eid):
        return
    row = (await ctx.conn.execute(sa.select(encounters.c.type, beds.c.category).select_from(
        encounters.outerjoin(beds, beds.c.id == encounters.c.bed_id)).where(encounters.c.id == eid))).first()
    if not row or row.type != "IPD":
        return
    st = await _state(ctx, eid)
    ward = st.get("ward_category") or row.category or "General"
    draft.setdefault("ward_type", ward)
    if ctx.__dict__.get("_ipb_priced") or not st:
        return
    qty = D(draft.get("qty") or 1)
    tariff = await _tariff_for(ctx, st)
    if _is_room(draft):
        if st.get("ward_category") or any(ln.get("category") == ward for ln in (tariff or {}).get("room_rates") or []):
            rate = await _room_rate(ctx, ward, tariff)
            if rate != D(draft.get("rate")):
                draft.update(base_rate=draft.get("rate"), rate=float(rate), amount=float(money(rate * qty)), price_source=f"ward:{ward}")
        return
    svc_id = draft.get("service_id")
    if not svc_id or (not tariff and not st.get("ward_category")):
        return
    svc = (await _services(ctx, {svc_id})).get(svc_id)
    if not svc or D(svc.get("rate")) <= 0 or money(D(draft.get("rate"))) != money(D(svc.get("rate"))):
        return  # explicitly priced at capture — leave it
    price, src = _price(svc, tariff, ward)
    if price != money(D(draft.get("rate"))):
        draft.update(base_rate=draft.get("rate"), rate=float(price), amount=float(money(price * qty)), price_source=src)


@hook("ipd.transfers", "after_transition")
async def _follow_transfer(ctx, rec: dict, prev: dict) -> None:
    """A completed bed transfer ends any billing-ward override: billing follows the new bed."""
    if rec.get("status") != "Completed" or not rec.get("encounter_id"):
        return
    st = await _state(ctx, rec["encounter_id"])
    if not st:
        return
    b = (await ctx.conn.execute(sa.select(beds.c.category).where(beds.c.id == rec.get("to_bed")))).first() if rec.get("to_bed") else None
    prev_bed = (await ctx.conn.execute(sa.select(beds.c.category).where(beds.c.id == rec.get("from_bed")))).first() if rec.get("from_bed") else None
    changes = list(st.get("ward_changes") or []) + [{
        "from_date": today().isoformat(), "category": b.category if b else None, "source": f"Transfer {rec.get('code')}",
        "from_category": st.get("ward_category") or (prev_bed.category if prev_bed else None),
        "by": ctx.user.get("name"), "at": _stamp()}]
    await update(ctx, BILL, st["id"], {"ward_category": None, "ward_changes": changes})


# ================================================================== list

def _like(q: str) -> str:
    return "%" + q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _row(a: dict, info: dict, pos: dict) -> dict:
    i = info[a["id"]]
    return {
        "id": a["id"], "ip_no": a.get("code"), "status": a.get("status"), "admitted_at": a.get("started_at"),
        "discharged_at": a.get("ended_at") if a.get("status") == "Discharged" else None, "discharge_type": a.get("discharge_type"),
        "patient": i["patient"], "bed": i["bed"], "ward": i["ward"], "doctor": i["doctor"], "department": i["department"],
        "sponsor": pos["sponsor"]["sponsor_name"] or ("Self-pay" if pos["sponsor"]["payer_type"] == "Self" else pos["sponsor"]["payer_type"]),
        "payer_type": pos["sponsor"]["payer_type"], "los_days": _los(a.get("started_at"), a.get("ended_at")),
        "net": pos["net"], "balance": pos["balance"], "paid": pos["paid"], "patient_payable": pos["patient_payable"],
        "bill_status": pos["status"], "payment_status": pos["payment_status"], "bill_id": pos["bill_id"],
    }


async def _page(ctx, conds: list, *, q: str | None, sort: str, page: int, limit: int) -> tuple[list[dict], int]:
    e, p = encounters, patients
    conds = [e.c.type == "IPD", e.c.deleted_at.is_(None), *conds]
    if q and q.strip():
        term = _like(q)
        conds.append(sa.or_(sa.func.lower(e.c.code).like(term, escape="\\"), sa.func.lower(p.c.code).like(term, escape="\\"),
                            sa.func.lower(p.c.title).like(term, escape="\\"), p.c.phone.like(term, escape="\\")))
    j = e.join(p, p.c.id == e.c.patient_id)
    cols = {"admitted": e.c.started_at, "ip": e.c.code, "status": e.c.status, "patient": p.c.title, "discharged": e.c.ended_at}
    desc = sort.startswith("-")
    col = cols.get(sort.lstrip("-"), e.c.started_at)
    order = col.desc().nulls_last() if desc else col.asc().nulls_last()
    total = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(j).where(*conds))).scalar_one()
    limit = max(1, min(limit, 200))
    rows = (await ctx.conn.execute(sa.select(e).select_from(j).where(*conds).order_by(order, e.c.created_at.desc())
                                   .limit(limit).offset((max(1, page) - 1) * limit))).all()
    return [rs.to_record(r) for r in rows], total


async def _rows(ctx, adms: list[dict]) -> list[dict]:
    info = await _info(ctx, adms)
    pos = await _positions(ctx, adms)
    return [_row(a, info, pos[a["id"]]) for a in adms]


@router.get("/admissions")
async def list_admissions(ctx: CtxDep, tab: Literal["admitted", "all", "discharged"] = "admitted", q: str | None = None,
                          sort: str = "-admitted", page: int = 1, limit: int = 10):
    _read(ctx)
    e = encounters
    conds = {"admitted": [e.c.status.in_(OPEN)], "discharged": [e.c.status == "Discharged"], "all": [e.c.status != "Cancelled"]}
    adms, total = await _page(ctx, conds[tab], q=q, sort=sort, page=page, limit=limit)
    base = [e.c.type == "IPD", e.c.deleted_at.is_(None)]
    counts = {}
    for k, c in conds.items():
        counts[k] = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(e).where(*base, *c))).scalar_one()
    return {"rows": await _rows(ctx, adms), "total": total, "page": page, "limit": limit, "counts": counts, "permissions": _role_perms(ctx)}


# ================================================================== the working bill

def _source_label(c: dict) -> str:
    src = str(c.get("source") or "")
    if c.get("kind") == "package":
        return "Package"
    if src.startswith("ipd.daily"):
        return "Daily room & nursing"
    if src.startswith("pharmacy.indents"):
        return "Ward indent"
    if src.startswith("pharmacy.returns"):
        return "Pharmacy return"
    if src.startswith("pharmacy."):
        return "Pharmacy"
    if src.startswith("orders."):
        return "Order"
    if src.startswith("appointments.") or src.startswith("er."):
        return "Consultation"
    if src.startswith("ipbilling.admin"):
        return "Administration"
    if src.startswith("ipbilling") or src.startswith("billing."):
        return "Added on bill"
    return src.split(".")[0].capitalize() or "Manual"


def _line_view(c: dict, calc: dict, *, ward_default: str | None, inv_codes: dict[str, str], closed: bool) -> dict:
    svc = c.get("_svc") or {}
    billed = c.get("status") == "Billed"
    lock = ("Billed on " + inv_codes.get(c.get("invoice_id") or "", "the final bill")) if billed else (
        "Bill closed" if closed else "Covered by package" if calc["covered"] else None)
    return {
        "id": c["id"], "code": c.get("code"), "date": c.get("charged_at"), "service_id": c.get("service_id"),
        "service_code": svc.get("code"), "name": c.get("description") or svc.get("name") or "Charge",
        "group": calc["group"], "head": calc["head"], "category": calc["category"], "ward_type": c.get("ward_type") or ward_default,
        "qty": float(D(c.get("qty") or 1)), "rate": float(D(c.get("rate"))), "base_rate": c.get("base_rate"),
        "gross": float(calc["gross"]), "disc_mode": c.get("disc_mode") or "₹",
        "disc_value": float(D(c.get("disc_value"))) if c.get("disc_value") not in (None, "") else float(calc["disc"]),
        "discount": float(calc["disc"]), "tax_percent": float(D(c.get("tax_percent"))), "gst": float(calc["gst"]),
        "after_total": float(calc["after"]), "covered": calc["covered"], "covered_by": c.get("covered_by"),
        "kind": c.get("kind") or "service", "package_id": c.get("package_id"), "status": c.get("status"),
        "invoice_id": c.get("invoice_id"), "invoice_code": inv_codes.get(c.get("invoice_id") or ""),
        "source": c.get("source"), "source_label": _source_label(c), "price_source": c.get("price_source") or "tariff",
        "price_overridden": bool(c.get("price_overridden")), "locked": bool(lock), "lock_reason": lock, "tab": c.get("tab"),
        "unpriced": D(c.get("rate")) == 0 and c.get("kind") != "package", "doctor": c.get("doctor_name"),
    }


async def _allergies(ctx, pid: str, tags: list[str]) -> list[str]:
    names = list(tags or [])
    if has("emr.allergies"):
        for a in await find(ctx, "emr.allergies", patient_id=pid, status="Active", limit=30):
            if a.get("allergen") and a["allergen"] not in names:
                names.append(a["allergen"])
    return names


async def _receipts(ctx, adm: dict, inv_ids: list[str]) -> list[dict]:
    t = payments
    start = parse_dt(adm.get("started_at"))
    end = parse_dt(adm.get("ended_at")) if adm.get("status") == "Discharged" else None
    window = [t.c.encounter_id.is_(None), t.c.invoice_id.is_(None), t.c.kind.in_(["DEPOSIT", "REFUND"])]
    if start:
        window.append(t.c.paid_at >= start - timedelta(days=2))
    if end:
        window.append(t.c.paid_at <= end + timedelta(days=1))
    conds = [t.c.encounter_id == adm["id"], sa.and_(*window)]
    if inv_ids:
        conds.append(t.c.invoice_id.in_(inv_ids))
    rows = (await ctx.conn.execute(sa.select(t).where(t.c.patient_id == adm["patient_id"], t.c.deleted_at.is_(None), sa.or_(*conds))
                                   .order_by(t.c.paid_at.desc()).limit(200))).all()
    return [rs.to_record(r) for r in rows]


def _role_perms(ctx) -> dict:
    """What the signed-in role may do anywhere in IP billing (screens hide everything else)."""
    w = _can_write(ctx)
    desk = ctx.role == "admin" or ctx.role in DESK_ROLES
    return {"write": w, "collect": desk, "refund": w, "approx": desk, "notify": desk, "discharge": w, "reopen": w,
            "documents": desk or ctx.role == "nurse", "estimate": desk, "preauth": w, "approve": ctx.role in APPROVER_ROLES,
            "line_discount_limit": None if ctx.role in APPROVER_ROLES else settings.discount_approval_percent}


def _permissions(ctx, adm: dict, st: dict) -> dict:
    closed = adm.get("status") in ("Discharged", "Cancelled") and st.get("status") != "Reopened"
    r = _role_perms(ctx)
    adm_open = adm.get("status") in OPEN
    return {
        **r, "edit": r["write"] and not closed and st.get("status") != "Reopen Requested", "price": r["write"] and not closed,
        "collect": r["collect"] and adm.get("status") != "Cancelled",
        "refund": r["refund"] and adm.get("status") != "Cancelled",
        "discount_limit": settings.discount_approval_percent,
        "reopen": r["reopen"] and adm.get("status") == "Discharged" and (st.get("status") or "Settled") in ("Settled", "Final"),
        "discharge": r["discharge"] and adm_open, "initiate": r["discharge"] and adm.get("status") == "Admitted",
        "settle": r["write"] and adm.get("status") == "Discharged" and st.get("status") == "Reopened",
        "finalise": r["write"] and not closed, "closed": closed,
    }


async def _bill_view(ctx, adm: dict) -> dict:
    eid = adm["id"]
    info = (await _info(ctx, [adm]))[eid]
    st = await _state(ctx, eid)
    lines = (await _load_lines(ctx, [eid])).get(eid, [])
    invs = (await _invoices(ctx, [eid])).get(eid, [])
    pos = await _position(ctx, adm)
    inv_codes = {i["id"]: i.get("code") for i in invs}
    closed = adm.get("status") in ("Discharged", "Cancelled") and st.get("status") != "Reopened"
    ward_default = st.get("ward_category") or (info["bed"] or {}).get("category")
    unbilled = [c for c in lines if c.get("status") == "Unbilled"]
    bed_cat = (info["bed"] or {}).get("category")
    views = [_line_view(c, _calc(c), ward_default=_ward_at(st, (parse_dt(c.get("charged_at")) or now()).date(), bed_cat),
                        inv_codes=inv_codes, closed=closed) for c in lines]
    work = _totals(unbilled, st)
    # packages with their inclusions and what each covers
    svc_names = await _services(ctx, {s.get("service_id") for c in lines if c.get("kind") == "package" for s in c.get("package_services") or []})
    pkgs = []
    for c in lines:
        if c.get("kind") != "package":
            continue
        cov = [v for v in views if v["covered"] and v["covered_by"] == c["id"]]
        used = defaultdict(float)
        for v in cov:
            if v["service_id"]:
                used[v["service_id"]] += v["qty"]
        pkgs.append({
            "line_id": c["id"], "package_id": c.get("package_id"), "name": c.get("package_name") or c.get("description"),
            "price": float(D(c.get("rate")) * D(c.get("qty") or 1)), "los_days": c.get("los_days"), "room_category": c.get("room_category"),
            "status": c.get("status"), "covered_count": len(cov), "covered_value": sum(v["gross"] for v in cov),
            "services": [{"service_id": s.get("service_id"), "name": (svc_names.get(s.get("service_id") or "") or {}).get("name") or s.get("name"),
                          "qty": s.get("qty") or 1, "used": used.get(s.get("service_id") or "", 0)} for s in c.get("package_services") or []],
        })
    payer = await get(ctx, PAYER, pos["sponsor"]["sponsor_id"]) if pos["sponsor"]["sponsor_id"] and has(PAYER) else None
    tariff = await _tariff_for(ctx, st, pos["sponsor"])
    price_payer = await get(ctx, PAYER, st["price_sponsor"]) if st.get("price_sponsor") and has(PAYER) else None
    receipts = await _receipts(ctx, adm, list(inv_codes))
    allergies = await _allergies(ctx, adm["patient_id"], info["patient"].get("allergy_tags"))
    approval = None
    if st.get("bill_discount_approval"):
        a = await get(ctx, "workflow.approvals", st["bill_discount_approval"])
        approval = {k: a.get(k) for k in ("id", "code", "status", "approver_role", "comments")} if a else None
    return {
        "admission": {
            "id": eid, "ip_no": adm.get("code"), "status": adm.get("status"), "admitted_at": adm.get("started_at"),
            "discharged_at": adm.get("ended_at") if adm.get("status") == "Discharged" else None, "diagnosis": adm.get("diagnosis"),
            "discharge_type": adm.get("discharge_type"), "discharge_initiated_at": adm.get("discharge_initiated_at"),
            "los_days": _los(adm.get("started_at"), adm.get("ended_at") if adm.get("status") == "Discharged" else None),
            "doctor": info["doctor"], "department": info["department"], "bed": info["bed"], "ward": info["ward"],
            "payer": adm.get("payer"), "package": adm.get("package"), "admission_type": adm.get("admission_type"),
        },
        "patient": {**info["patient"], "allergies": allergies},
        "state": {k: v for k, v in st.items() if not k.startswith("_")} if st else None,
        "sponsor": {**pos["sponsor"], "payer_kind": (payer or {}).get("payer_type"),
                    "tariff": {k: tariff.get(k) for k in ("id", "code", "name", "basis", "percent")} if tariff else None,
                    "price_sponsor_name": (price_payer or {}).get("name")},
        "ward_category": ward_default, "lines": views, "packages": pkgs,
        "totals": _jsonable(work), "position": pos,
        "invoices": [{k: i.get(k) for k in ("id", "code", "type", "payer", "gross", "discount", "tax", "net", "paid", "balance", "status", "billed_at")} for i in invs],
        "receipts": [{k: r.get(k) for k in ("id", "code", "kind", "mode", "amount", "reference", "remarks", "paid_at", "status", "invoice_id", "received_by")} for r in receipts],
        "stats": {"los_days": _los(adm.get("started_at"), adm.get("ended_at") if adm.get("status") == "Discharged" else None),
                  "since": adm.get("started_at"), "packages": work["packages"] + sum(1 for c in lines if c.get("kind") == "package" and c.get("status") == "Billed"),
                  "services": sum(1 for v in views if v["kind"] != "package"), "payment_status": pos["payment_status"]},
        "approx_bills": list(reversed((st or {}).get("approx_bills") or []))[:20],
        "ward_changes": (st or {}).get("ward_changes") or [], "sponsor_history": (st or {}).get("sponsor_history") or [],
        "bill_discount": {"mode": st.get("bill_discount_mode") or "%", "value": float(D(st.get("bill_discount_value"))),
                          "reason": st.get("bill_discount_reason"), "status": st.get("bill_discount_status") or "None", "approval": approval},
        "permissions": _permissions(ctx, adm, st), "policy": {"discount_approval_percent": settings.discount_approval_percent},
    }


@router.get("/admissions/{eid}/bill")
async def bill(eid: str, ctx: CtxDep):
    _read(ctx)
    return await _bill_view(ctx, await _admission(ctx, eid))


async def _done(ctx, adm: dict, st: dict) -> dict:
    await _snapshot(ctx, adm, st)
    return await _bill_view(ctx, adm)


# ================================================================== charge lines

def _ward_at(st: dict, d: date | None, fallback: str | None) -> str | None:
    """Billing ward category in force on a date (ward-change history, else the bed's category)."""
    changes = sorted(st.get("ward_changes") or [], key=lambda x: x.get("from_date") or "")
    if not changes or not d:
        return st.get("ward_category") or fallback
    cat = None
    for ch in changes:
        fd = _d(ch.get("from_date"))
        if fd and fd <= d:
            cat = ch.get("category")
    return cat or changes[0].get("from_category") or fallback


def _charge_time(d: date | None, adm: dict) -> str:
    """Service date → timestamp: today keeps the current time, earlier dates use midday."""
    if not d or d == today():
        return _stamp()
    return datetime(d.year, d.month, d.day, 12, 0, tzinfo=settings.tz).isoformat(timespec="seconds")


def _check_date(d: date | None, adm: dict) -> date:
    d = d or today()
    start = parse_dt(adm.get("started_at"))
    if d > today():
        raise bad_request("The service date cannot be in the future", {"fields": {"date": "Future date"}})
    if start and d < start.date():
        raise bad_request(f"The service date is before admission ({start.date():%d/%m/%Y})", {"fields": {"date": "Before admission"}})
    return d


def _discount_amount(gross: Decimal, mode: str, value: Decimal) -> Decimal:
    if value < 0:
        raise bad_request("Discount cannot be negative")
    if mode == "%":
        if value > 100:
            raise bad_request("Discount % cannot exceed 100")
        return money(gross * value / 100)
    if gross > 0 and value > gross:
        raise bad_request(f"Discount cannot exceed the line amount ₹{gross}")
    return money(value)


def _check_line_discount(ctx, gross: Decimal, disc: Decimal) -> None:
    if gross <= 0 or disc <= 0 or ctx.role in APPROVER_ROLES:
        return
    pct = disc / gross * 100
    if pct > Decimal(str(settings.discount_approval_percent)):
        raise forbidden(f"Line discounts above {settings.discount_approval_percent:g}% need management — "
                        "use the bill discount, which goes for approval")


class AddLineIn(BaseModel):
    service_id: str
    date: Day | None = None
    qty: float = Field(default=1, gt=0, le=1000)
    rate: float | None = Field(default=None, ge=0)
    disc_mode: Literal["₹", "%"] = "₹"
    disc_value: float = Field(default=0, ge=0)
    tab: Literal["orders", "consultation", "package"] = "orders"
    doctor_id: str | None = None
    note: str | None = Field(default=None, max_length=200)
    in_package: bool = False


@router.post("/admissions/{eid}/lines", status_code=201)
async def add_line(eid: str, body: AddLineIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    svc = (await _services(ctx, {body.service_id})).get(body.service_id)
    if not svc or svc.get("deleted_at"):
        raise not_found("Service not found in the tariff")
    if svc.get("status") == "Inactive":
        raise conflict(f"{svc.get('name')} is inactive in the tariff")
    d = _check_date(body.date, adm)
    info = (await _info(ctx, [adm]))[eid]
    ward = _ward_at(st, d, (info["bed"] or {}).get("category")) or "General"
    tariff = await _tariff_for(ctx, st)
    price, src = _price(svc, tariff, ward)
    rate = price
    if body.rate is not None and money(D(body.rate)) != price:
        if not _can_write(ctx):
            raise forbidden("Your role cannot change tariff prices")
        rate, src = money(D(body.rate)), "manual"
    qty = D(body.qty)
    gross = money(rate * qty)
    disc = _discount_amount(gross, body.disc_mode, D(body.disc_value))
    _check_line_discount(ctx, gross, disc)
    desc = svc.get("name") or svc.get("title") or "Service"
    doctor = None
    if body.doctor_id and is_uuid(body.doctor_id):
        r = (await ctx.conn.execute(sa.select(employees.c.title).where(employees.c.id == body.doctor_id))).first()
        doctor = r.title if r else None
        if doctor:
            desc = f"{desc} — {doctor}"
    if body.note:
        desc = f"{desc} ({body.note.strip()})"
    if body.in_package and not any(c.get("kind") == "package" for c in (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])):
        raise conflict("Apply a package before marking services as included")
    with _self_priced(ctx):
        ch = await billing.post_charge(ctx, patient_id=adm["patient_id"], encounter_id=eid, service_id=svc["id"], qty=float(qty),
                                       rate=float(rate), description=desc, source="ipbilling.manual")
    await update(ctx, CHG, ch["id"], {
        "charged_at": _charge_time(d, adm), "discount": float(disc), "disc_mode": body.disc_mode, "disc_value": body.disc_value,
        "tab": body.tab, "base_rate": float(D(svc.get("rate"))), "price_source": src, "price_overridden": src == "manual",
        "ward_type": ward, "doctor_id": body.doctor_id if doctor else None, "doctor_name": doctor, "in_package": body.in_package or None,
    })
    if src == "manual":
        await audit(ctx, "ipbill.price_override", module="billing", entity="charges", record=ch,
                    before={"rate": float(price)}, after={"rate": float(rate)}, note=f"Added at a manual price on {adm.get('code')}")
    return await _done(ctx, adm, st)


class LineIn(BaseModel):
    rate: float | None = Field(default=None, ge=0)
    qty: float | None = Field(default=None, gt=0, le=1000)
    disc_mode: Literal["₹", "%"] | None = None
    disc_value: float | None = Field(default=None, ge=0)
    in_package: bool | None = None
    date: Day | None = None
    reason: str | None = Field(default=None, max_length=300)


async def _line(ctx, eid: str, cid: str) -> dict:
    c = await get(ctx, CHG, cid)
    if not c or c.get("encounter_id") != eid:
        raise not_found("Charge not found on this bill")
    if c.get("status") == "Cancelled":
        raise conflict("This charge was voided")
    if c.get("status") == "Billed":
        raise conflict("This charge is on the final bill — reopen the bill to change it")
    c["_svc"] = (await _services(ctx, {c.get("service_id")})).get(c.get("service_id") or "")
    return c


@router.patch("/admissions/{eid}/lines/{cid}")
async def edit_line(eid: str, cid: str, body: LineIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    c = await _line(ctx, eid, cid)
    package = c.get("kind") == "package"
    patch: dict[str, Any] = {}
    covered = bool(c.get("in_package")) and not package
    if body.in_package is not None and not package and body.in_package != covered:
        if body.in_package:
            pk = [x for x in (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, []) if x.get("kind") == "package"]
            if not pk:
                raise conflict("Apply a package first — there is nothing to include this service in")
            patch.update(in_package=True, covered_by=pk[0]["id"])
        else:
            patch.update(in_package=False, covered_by=None)
        covered = body.in_package
    price_change = body.rate is not None and money(D(body.rate)) != money(D(c.get("rate")))
    if (price_change or body.disc_value is not None or body.qty is not None) and covered and body.in_package is None:
        raise conflict("Covered by the package — exclude it from the package to change its price or discount")
    rate, qty = D(c.get("rate")), D(c.get("qty") or 1)
    if price_change:
        if not _can_write(ctx):
            raise forbidden("Your role cannot change tariff prices")
        if D(c.get("qty") or 1) < 0:
            raise conflict("Returns are priced from the original issue")
        rate = money(D(body.rate))
        patch.update(rate=float(rate), price_overridden=True, price_source="manual")
        if c.get("base_rate") in (None, ""):
            patch["base_rate"] = float(D(c.get("rate")))
    if body.qty is not None and D(body.qty) != qty:
        if str(c.get("source") or "").startswith(("pharmacy.", "ipd.daily")) or package:
            raise conflict("Quantity of pharmacy, daily and package lines comes from their source")
        qty = D(body.qty)
        patch["qty"] = float(qty)
    gross = money(rate * qty)
    if price_change or "qty" in patch:
        patch["amount"] = float(gross)
    mode = body.disc_mode or c.get("disc_mode") or "₹"
    val = D(body.disc_value) if body.disc_value is not None else D(c.get("disc_value") if c.get("disc_value") not in (None, "") else c.get("discount"))
    if body.disc_value is not None or body.disc_mode is not None or "amount" in patch:
        disc = _discount_amount(gross, mode, val) if gross > 0 else Decimal(0)
        if body.disc_value is not None or body.disc_mode is not None:
            _check_line_discount(ctx, gross, disc)
        patch.update(discount=float(disc), disc_mode=mode, disc_value=float(val))
    if body.date is not None:
        patch["charged_at"] = _charge_time(_check_date(body.date, adm), adm)
    if not patch:
        return await _bill_view(ctx, adm)
    rec = await update(ctx, CHG, cid, patch)
    if price_change:
        await audit(ctx, "ipbill.price_override", module="billing", entity="charges", record=rec,
                    before={"rate": float(D(c.get("rate")))}, after={"rate": float(rate)}, note=body.reason or f"Tariff price edited on {adm.get('code')}")
    return await _done(ctx, adm, st)


class VoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/admissions/{eid}/lines/{cid}/void")
async def void_line(eid: str, cid: str, body: VoidIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    c = await _line(ctx, eid, cid)
    rec = await update(ctx, CHG, cid, {"status": "Cancelled", "void_reason": body.reason, "voided_by": ctx.user.get("name"), "voided_at": _stamp()})
    await audit(ctx, "charge.cancel", module="billing", entity="charges", record=rec, note=body.reason)
    if c.get("kind") == "package":
        await _uncover(ctx, eid, package_line=cid)
    return await _done(ctx, adm, st)


async def _uncover(ctx, eid: str, *, package_line: str | None = None) -> int:
    lines = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    remaining = [c for c in lines if c.get("kind") == "package"]
    n = 0
    for c in lines:
        if c.get("in_package") and c.get("kind") != "package" and (not remaining or c.get("covered_by") == package_line):
            if remaining and c.get("covered_by") == package_line:
                await update(ctx, CHG, c["id"], {"covered_by": remaining[0]["id"]})
            else:
                await update(ctx, CHG, c["id"], {"in_package": False, "covered_by": None})
            n += 1
    return n


class CoverAllIn(BaseModel):
    covered: bool


@router.post("/admissions/{eid}/cover-all")
async def cover_all(eid: str, body: CoverAllIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    lines = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    pk = [c for c in lines if c.get("kind") == "package"]
    if body.covered and not pk:
        raise conflict("Apply a package first — there is nothing to cover the services")
    n = 0
    for c in lines:
        if c.get("kind") == "package" or bool(c.get("in_package")) == body.covered:
            continue
        await update(ctx, CHG, c["id"], {"in_package": body.covered, "covered_by": pk[0]["id"] if body.covered else None})
        n += 1
    await audit(ctx, "ipbill.cover_all", module="billing", entity="ip_bills", record=st,
                after={"covered": body.covered, "lines": n}, note=f"{'Covered' if body.covered else 'Uncovered'} {n} line(s) on {adm.get('code')}")
    return await _done(ctx, adm, st)


# ================================================================== packages

class PackageIn(BaseModel):
    package_id: str
    price: float | None = Field(default=None, ge=0)
    date: Day | None = None
    auto_cover: bool = True


@router.get("/packages")
async def package_list(ctx: CtxDep, admission: str | None = None, q: str | None = None):
    _read(ctx)
    st = await _state(ctx, admission) if admission and is_uuid(admission) else {}
    tariff = await _tariff_for(ctx, st) if st else None
    rows = await find(ctx, PKG, status="Active", q=q, limit=100, sort="title")
    svc = await _services(ctx, {ln.get("service") for p in rows for ln in p.get("inclusions") or []})
    return [{
        "id": p["id"], "code": p.get("code"), "name": p.get("name"), "specialty": p.get("specialty"), "price": f2(p.get("price")),
        "sponsor_price": f2(_package_price(p, tariff)) if tariff else None, "los_days": p.get("los_days"),
        "room_category": p.get("room_category"), "exclusions": p.get("exclusions"), "valid_till": p.get("valid_till"),
        "inclusions": [{"service_id": ln.get("service"), "name": (svc.get(ln.get("service") or "") or {}).get("name"), "qty": ln.get("qty") or 1}
                       for ln in p.get("inclusions") or []],
    } for p in rows]


@router.post("/admissions/{eid}/packages", status_code=201)
async def apply_package(eid: str, body: PackageIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    pkg = await get(ctx, PKG, body.package_id)
    if not pkg or pkg.get("status") != "Active":
        raise not_found("Package not found or inactive")
    vt = _d(pkg.get("valid_till"))
    if vt and vt < today():
        raise conflict(f"Package {pkg.get('name')} expired on {vt:%d/%m/%Y}")
    tariff = await _tariff_for(ctx, st)
    price = _package_price(pkg, tariff)
    src = f"sponsor:{tariff.get('code')}" if tariff and price != money(D(pkg.get("price"))) else "package"
    if body.price is not None and money(D(body.price)) != price:
        price, src = money(D(body.price)), "manual"
    d = _check_date(body.date, adm)
    with _self_priced(ctx):
        ch = await billing.post_charge(ctx, patient_id=adm["patient_id"], encounter_id=eid, qty=1, rate=float(price),
                                       description=f"Package — {pkg.get('name')}", source="ipbilling.package", source_id=pkg["id"])
    inclusions = [{"service_id": ln.get("service"), "qty": ln.get("qty") or 1} for ln in pkg.get("inclusions") or []]
    await update(ctx, CHG, ch["id"], {
        "kind": "package", "package_id": pkg["id"], "package_name": pkg.get("name"), "package_services": inclusions,
        "los_days": pkg.get("los_days"), "room_category": pkg.get("room_category"), "category": "PACKAGE", "tab": "package",
        "charged_at": _charge_time(d, adm), "base_rate": f2(pkg.get("price")), "price_source": src, "price_overridden": src == "manual",
    })
    covered = 0
    if body.auto_cover:
        covered = await _auto_cover(ctx, adm, ch["id"], inclusions, pkg.get("los_days"))
    await audit(ctx, "ipbill.package", module="billing", entity="ip_bills", record=st,
                after={"package": pkg.get("name"), "price": float(price), "covered": covered}, note=f"Package applied on {adm.get('code')}")
    return await _done(ctx, adm, st)


async def _auto_cover(ctx, adm: dict, package_line: str, inclusions: list[dict], los_days: Any) -> int:
    """Cover the package's included services (up to their quantities) and the room & nursing days of
    the package length of stay."""
    lines = (await _load_lines(ctx, [adm["id"]], unbilled_only=True)).get(adm["id"], [])
    left = defaultdict(float)
    for inc in inclusions:
        if inc.get("service_id"):
            left[inc["service_id"]] += float(inc.get("qty") or 1)
    start = parse_dt(adm.get("started_at"))
    last_day = (start.date() + timedelta(days=max(int(los_days or 0), 0))) if start and los_days not in (None, "") else None
    n = 0
    for c in lines:
        if c.get("kind") == "package" or c.get("in_package"):
            continue
        sid = c.get("service_id")
        hit = False
        if sid and left.get(sid, 0) > 0:
            left[sid] -= float(c.get("qty") or 1)
            hit = True
        elif last_day and str(c.get("source") or "").startswith("ipd.daily"):
            cd = parse_dt(c.get("charged_at"))
            hit = bool(cd and cd.date() < last_day)
        if hit:
            await update(ctx, CHG, c["id"], {"in_package": True, "covered_by": package_line})
            n += 1
    return n


class RemoveIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/admissions/{eid}/packages/{cid}/remove")
async def remove_package(eid: str, cid: str, body: RemoveIn, ctx: CtxDep):
    c = await get(ctx, CHG, cid)
    if not c or c.get("kind") != "package":
        raise not_found("Package line not found")
    return await void_line(eid, cid, VoidIn(reason=body.reason), ctx)


# ================================================================== bill discount (approval above policy)

class BillDiscountIn(BaseModel):
    mode: Literal["%", "₹"] = "%"
    value: float = Field(ge=0)
    reason: str | None = Field(default=None, max_length=300)


@router.put("/admissions/{eid}/bill-discount")
async def bill_discount(eid: str, body: BillDiscountIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    if body.mode == "%" and body.value > 100:
        raise bad_request("Discount % cannot exceed 100")
    unbilled = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    work = _totals(unbilled, {})
    taxable = D(work["taxable"])
    amount = _bill_discount(taxable, {"bill_discount_mode": body.mode, "bill_discount_value": body.value})
    if body.mode == "₹" and D(body.value) > taxable:
        raise bad_request(f"Bill discount cannot exceed the bill after line discounts (₹{taxable})")
    if body.value <= 0:
        rec = await update(ctx, BILL, st["id"], {"bill_discount_mode": body.mode, "bill_discount_value": 0, "bill_discount_status": "None",
                                                 "bill_discount_reason": None, "bill_discount_approval": None})
        return await _done(ctx, adm, rec)
    if not (body.reason or "").strip():
        raise bad_request("Give a reason for the bill discount", {"fields": {"reason": "Required"}})
    pct = float(amount / taxable * 100) if taxable > 0 else 0
    needs = pct > settings.discount_approval_percent and ctx.role not in APPROVER_ROLES
    patch = {"bill_discount_mode": body.mode, "bill_discount_value": body.value, "bill_discount_reason": body.reason.strip(),
             "bill_discount_status": "Pending" if needs else "Approved", "bill_discount_approval": None}
    rec = await update(ctx, BILL, st["id"], patch)
    if needs:
        appr = await request_approval(ctx, "ipbilling.discount", subject_fqn=BILL, subject_id=st["id"], amount=float(amount), force=True,
                                      summary=f"Bill discount ₹{amount} ({pct:.1f}%) on IP bill {adm.get('code')}: {body.reason.strip()}")
        if appr:
            rec = await update(ctx, BILL, st["id"], {"bill_discount_approval": appr["id"]})
    await audit(ctx, "ipbill.discount", module="billing", entity="ip_bills", record=rec,
                after={"mode": body.mode, "value": body.value, "amount": float(amount), "status": patch["bill_discount_status"]}, note=body.reason)
    return await _done(ctx, adm, rec)


@on_decided("ipbilling.discount")
async def _discount_decided(ctx, approval: dict, approved: bool):
    st = await get(ctx, BILL, approval["subject_id"])
    if not st or st.get("bill_discount_approval") != approval["id"] or st.get("bill_discount_status") != "Pending":
        return
    if approved:
        await update(ctx, BILL, st["id"], {"bill_discount_status": "Approved"})
    else:
        await update(ctx, BILL, st["id"], {"bill_discount_status": "Rejected", "bill_discount_value": 0,
                                           "bill_discount_reason": f"Rejected: {approval.get('comments') or ''}".strip()})


# ================================================================== change ward (billing category) → re-price

class WardIn(BaseModel):
    category: str
    from_date: date
    room_rate: float | None = Field(default=None, ge=0)
    reprice_services: bool = True
    reason: str | None = Field(default=None, max_length=300)


@router.post("/admissions/{eid}/ward")
async def change_ward(eid: str, body: WardIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    if body.category not in WARD_CATEGORIES:
        raise bad_request("Choose a ward category from the list")
    d = _check_date(body.from_date, adm)
    tariff = await _tariff_for(ctx, st)
    room = money(D(body.room_rate)) if body.room_rate is not None else await _room_rate(ctx, body.category, tariff)
    nursing = await _service_by_code(ctx, _nursing_code(body.category))
    lines = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    changed, delta = 0, Decimal(0)
    for c in lines:
        cd = parse_dt(c.get("charged_at"))
        if not cd or cd.date() < d or c.get("kind") == "package":
            continue
        qty = D(c.get("qty") or 1)
        patch: dict[str, Any] = {"ward_type": body.category}
        old_amt = D(c.get("amount"))
        if _is_room(c):
            desc = f"Room rent — {body.category} ({cd.date().isoformat()})"
            patch.update(rate=float(room), amount=float(money(room * qty)), description=desc, price_source=f"ward:{body.category}")
            if c.get("base_rate") in (None, ""):
                patch["base_rate"] = float(D(c.get("rate")))
        elif str(c.get("source") or "").startswith("ipd.daily") and nursing:
            price, src = _price(nursing, tariff, body.category)
            patch.update(service_id=nursing["id"], rate=float(price), amount=float(money(price * qty)), description=nursing.get("name"),
                         price_source=src, tax_percent=float(D(nursing.get("tax_percent"))))
        elif body.reprice_services and c.get("_svc") and not c.get("price_overridden") and qty > 0:
            price, src = _price(c["_svc"], tariff, body.category)
            if price != money(D(c.get("rate"))):
                patch.update(rate=float(price), amount=float(money(price * qty)), price_source=src)
                if c.get("base_rate") in (None, ""):
                    patch["base_rate"] = float(D(c.get("rate")))
        if "amount" in patch and c.get("disc_mode") == "%":
            patch["discount"] = float(money(D(patch["amount"]) * D(c.get("disc_value")) / 100))
        if "amount" in patch or c.get("ward_type") != body.category:
            await update(ctx, CHG, c["id"], patch)
            if "amount" in patch:
                changed += 1
                delta += D(patch["amount"]) - old_amt
    info = (await _info(ctx, [adm]))[eid]
    changes = list(st.get("ward_changes") or []) + [{
        "from_date": d.isoformat(), "category": body.category, "room_rate": float(room), "source": "Billing",
        "from_category": _ward_at(st, d - timedelta(days=1), (info["bed"] or {}).get("category")),
        "reason": body.reason, "by": ctx.user.get("name"), "at": _stamp(), "lines": changed, "delta": float(delta)}]
    rec = await update(ctx, BILL, st["id"], {"ward_category": body.category, "ward_changes": changes})
    await audit(ctx, "ipbill.ward_change", module="billing", entity="ip_bills", record=rec,
                after={"category": body.category, "from": d.isoformat(), "room_rate": float(room), "lines": changed, "delta": float(delta)},
                note=body.reason)
    return {"changed": changed, "delta": float(delta), "bill": await _done(ctx, adm, rec)}


# ================================================================== sponsors: Change Sponsor re-pricing, terms

@router.get("/sponsors")
async def sponsors(ctx: CtxDep, q: str | None = None):
    _read(ctx)
    if not has(PAYER):
        return []
    rows = await find(ctx, PAYER, q=q, status="Active", limit=50, sort="title")
    tids = {r.get("tariff") for r in rows if r.get("tariff")}
    tariffs = await _records_by_ids(ctx, "billing", "tariffs", tids)
    by_payer = {t.get("payer"): t for t in await find(ctx, TARIFF, status="Active", limit=500) if t.get("payer")}
    out = []
    for r in rows:
        t = tariffs.get(r.get("tariff") or "") or by_payer.get(r["id"])
        out.append({"id": r["id"], "code": r.get("code"), "name": r.get("name"), "payer_type": r.get("payer_type"),
                    "scheme": r.get("scheme"), "discount_percent": r.get("discount_percent"), "co_pay_percent": r.get("default_co_pay_percent"),
                    "tariff": {"id": t["id"], "code": t.get("code"), "name": t.get("name"), "basis": t.get("basis"), "percent": t.get("percent")} if t else None})
    return out


class SponsorIn(BaseModel):
    sponsor_id: str | None = None           # None → self-pay / hospital tariff
    mode: Literal["prices", "organisation"] = "prices"
    approved_amount: float | None = Field(default=None, ge=0)
    co_pay_percent: float | None = Field(default=None, ge=0, le=100)
    credit_ref: str | None = Field(default=None, max_length=80)
    reason: str | None = Field(default=None, max_length=300)


async def _reprice_plan(ctx, adm: dict, st: dict, tariff: dict | None) -> tuple[list[tuple[dict, Decimal | None, str, str]], list[dict]]:
    """Per unbilled line: (line, new rate | None, price source, outcome) and the per-billing-head status."""
    lines = (await _load_lines(ctx, [adm["id"]], unbilled_only=True)).get(adm["id"], [])
    info = (await _info(ctx, [adm]))[adm["id"]]
    pkgs = {p["id"]: p for p in await find(ctx, PKG, limit=500)} if any(c.get("kind") == "package" for c in lines) else {}
    plan = []
    for c in lines:
        cd = parse_dt(c.get("charged_at"))
        ward = c.get("ward_type") or _ward_at(st, cd.date() if cd else None, (info["bed"] or {}).get("category"))
        old = money(D(c.get("rate")))
        if c.get("price_overridden"):
            plan.append((c, None, "", "skipped"))
        elif c.get("kind") == "package":
            pkg = pkgs.get(c.get("package_id") or "")
            new = _package_price(pkg, tariff) if pkg else old
            plan.append((c, new, f"sponsor:{tariff.get('code')}" if tariff else "package", "converted" if new != old else "unchanged"))
        elif _is_room(c):
            new = await _room_rate(ctx, ward or "General", tariff) if any(ln.get("category") == ward for ln in (tariff or {}).get("room_rates") or []) else None
            if new is None:
                plan.append((c, None, "", "unchanged"))
            else:
                plan.append((c, new, f"sponsor:{tariff.get('code')}", "converted" if new != old else "unchanged"))
        elif c.get("_svc") and D(c.get("qty") or 1) > 0:
            new, src = _price(c["_svc"], tariff, ward)
            plan.append((c, new, src, "converted" if new != old else "unchanged"))
        else:
            plan.append((c, None, "", "unchanged"))
    heads: dict[str, dict] = {}
    for c, new, _, outcome in plan:
        calc = _calc(c)
        h = heads.setdefault(calc["group"], {"head": calc["group"], "lines": 0, "converted": 0, "unchanged": 0, "skipped": 0, "before": Decimal(0), "after": Decimal(0)})
        h["lines"] += 1
        h[outcome] += 1
        qty = D(c.get("qty") or 1)
        h["before"] += calc["gross"]
        h["after"] += money((new if new is not None else D(c.get("rate"))) * qty)
    out = []
    for g in sorted(heads.values(), key=lambda x: GROUP_ORDER.index(x["head"]) if x["head"] in GROUP_ORDER else 99):
        status = ("Converted" if g["converted"] == g["lines"] else "Partly converted" if g["converted"] else
                  "Skipped (manual prices)" if g["skipped"] == g["lines"] else "No change")
        out.append({**g, "before": f2(g["before"]), "after": f2(g["after"]), "status": status})
    return plan, out


async def _payer_or_404(ctx, pid: str | None) -> dict | None:
    if not pid:
        return None
    if not has(PAYER):
        raise ApiError(503, "The Insurance / TPA module is not installed")
    p = await get(ctx, PAYER, pid)
    if not p:
        raise not_found("Sponsor not found")
    if p.get("status") != "Active":
        raise conflict(f"{p.get('name')} is {p.get('status')} — no new sponsored bills")
    return p


@router.post("/admissions/{eid}/sponsor/preview")
async def sponsor_preview(eid: str, body: SponsorIn, ctx: CtxDep):
    _read(ctx)
    adm = await _admission(ctx, eid)
    st = await _state(ctx, eid)
    payer = await _payer_or_404(ctx, body.sponsor_id)
    tariff = await _tariff_for(ctx, {}, payer_id=payer["id"]) if payer else None
    _, heads = await _reprice_plan(ctx, adm, st, tariff)
    return {"tariff": {k: tariff.get(k) for k in ("id", "code", "name", "basis", "percent")} if tariff else None,
            "sponsor": {"id": payer["id"], "name": payer.get("name"), "payer_type": payer.get("payer_type")} if payer else None, "heads": heads}


@router.post("/admissions/{eid}/sponsor")
async def change_sponsor(eid: str, body: SponsorIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    payer = await _payer_or_404(ctx, body.sponsor_id)
    tariff = await _tariff_for(ctx, {}, payer_id=payer["id"]) if payer else None
    plan, heads = await _reprice_plan(ctx, adm, st, tariff)
    n = 0
    for c, new, src, outcome in plan:
        if outcome != "converted" or new is None:
            continue
        qty = D(c.get("qty") or 1)
        amount = money(new * qty)
        patch: dict[str, Any] = {"rate": float(new), "amount": float(amount), "price_source": src}
        if c.get("base_rate") in (None, ""):
            patch["base_rate"] = float(D(c.get("rate")))
        if c.get("disc_mode") == "%":
            patch["discount"] = float(money(amount * D(c.get("disc_value")) / 100))
        elif D(c.get("discount")) > amount:
            patch["discount"] = float(amount)
        await update(ctx, CHG, c["id"], patch)
        n += 1
    before = {k: st.get(k) for k in ("sponsor", "payer_type", "tariff", "price_sponsor")}
    patch = {"tariff": tariff.get("id") if tariff else None, "price_sponsor": payer["id"] if payer else None}
    if body.mode == "organisation":
        patch.update(sponsor=payer["id"] if payer else None,
                     payer_type=PAYER_TYPE_OF.get(payer.get("payer_type") or "", "Insurance") if payer else "Self")
        if body.approved_amount is not None or not payer:
            patch["approved_amount"] = body.approved_amount if payer else None
        if body.co_pay_percent is not None or payer:
            patch["co_pay_percent"] = body.co_pay_percent if body.co_pay_percent is not None else (payer or {}).get("default_co_pay_percent")
        if body.credit_ref is not None or not payer:
            patch["credit_ref"] = body.credit_ref if payer else None
    hist = list(st.get("sponsor_history") or []) + [{
        "at": _stamp(), "by": ctx.user.get("name"), "mode": body.mode, "sponsor": (payer or {}).get("name") or "Self-pay",
        "tariff": (tariff or {}).get("name") or "Hospital tariff", "lines": n, "reason": body.reason}]
    patch["sponsor_history"] = hist
    rec = await update(ctx, BILL, st["id"], patch)
    await audit(ctx, "ipbill.sponsor_change", module="billing", entity="ip_bills", record=rec, before=before,
                after={**{k: patch.get(k) for k in before}, "lines_repriced": n}, note=body.reason or f"Change sponsor ({body.mode})")
    return {"heads": heads, "repriced": n, "bill": await _done(ctx, adm, rec)}


class TermsIn(BaseModel):
    approved_amount: float | None = Field(default=None, ge=0)
    co_pay_percent: float | None = Field(default=None, ge=0, le=100)
    credit_ref: str | None = Field(default=None, max_length=80)
    reason: str | None = Field(default=None, max_length=300)


@router.put("/admissions/{eid}/sponsor-terms")
async def sponsor_terms(eid: str, body: TermsIn, ctx: CtxDep):
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    if st.get("status") in ("Settled",) and adm.get("status") == "Discharged":
        raise conflict("The bill is settled — reopen it to change sponsor terms")
    patch = {k: v for k, v in body.model_dump(exclude={"reason"}).items() if k in body.model_fields_set}
    if not patch:
        raise bad_request("Nothing to change")
    before = {k: st.get(k) for k in patch}
    rec = await update(ctx, BILL, st["id"], patch)
    await audit(ctx, "ipbill.sponsor_terms", module="billing", entity="ip_bills", record=rec, before=before, after=patch, note=body.reason)
    return await _done(ctx, adm, rec)


# ================================================================== GST posting, no-show items, administration charges

def _gst_rate(c: dict) -> Decimal:
    cat = _category(c)
    if cat == "PHARM":
        return D(c.get("tax_percent"))
    if _is_room(c):
        ward = c.get("ward_type") or ""
        return Decimal(5) if ward not in ICU_CATS and D(c.get("rate")) > ROOM_GST_THRESHOLD else Decimal(0)
    svc = c.get("_svc") or {}
    return D(svc.get("tax_percent")) if svc else D(c.get("tax_percent"))


@router.get("/admissions/{eid}/gst")
async def gst_preview(eid: str, ctx: CtxDep):
    _read(ctx)
    adm = await _admission(ctx, eid)
    lines = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    out = []
    for c in lines:
        new = _gst_rate(c)
        old = D(c.get("tax_percent"))
        if new != old:
            calc = _calc(c)
            out.append({"id": c["id"], "name": c.get("description"), "date": c.get("charged_at"), "head": calc["head"],
                        "taxable": float(calc["taxable"]), "old_percent": float(old), "new_percent": float(new),
                        "gst_change": f2(calc["taxable"] * (new - old) / 100),
                        "hsn_sac": (c.get("_svc") or {}).get("hsn_sac") or ("996311" if _is_room(c) else "9993")})
    st = await _state(ctx, eid)
    return {"changes": out, "posted_at": st.get("gst_posted_at"), "admission": adm.get("code"),
            "rule": "Healthcare services are exempt (SAC 9993); rooms above ₹5,000/day outside ICU attract 5% GST; pharmacy keeps the item's GST."}


@router.post("/admissions/{eid}/gst")
async def gst_post(eid: str, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    lines = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    n = 0
    for c in lines:
        new = _gst_rate(c)
        if new != D(c.get("tax_percent")):
            await update(ctx, CHG, c["id"], {"tax_percent": float(new), "gst_posted": True})
            n += 1
    rec = await update(ctx, BILL, st["id"], {"gst_posted_at": _stamp(), "gst_posted_by": ctx.user.get("name")})
    await audit(ctx, "ipbill.gst_posting", module="billing", entity="ip_bills", record=rec, after={"lines": n})
    return {"updated": n, "bill": await _done(ctx, adm, rec)}


@router.get("/admissions/{eid}/no-show")
async def no_show(eid: str, ctx: CtxDep):
    """Services charged but not rendered: orders still un-collected / not started, older than 12 hours."""
    _read(ctx)
    await _admission(ctx, eid)
    lines = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    src_ids = [c["source_id"] for c in lines if str(c.get("source") or "").startswith("orders.") and c.get("source_id")]
    ords = {}
    if src_ids:
        rows = (await ctx.conn.execute(sa.select(orders.c.id, orders.c.code, orders.c.status, orders.c.ordered_at, orders.c.category)
                                       .where(orders.c.id.in_(src_ids)))).all()
        ords = {str(r.id): r for r in rows}
    cutoff = now() - timedelta(hours=12)
    out = []
    for c in lines:
        o = ords.get(c.get("source_id") or "")
        if o and o.status == "Ordered" and (o.ordered_at is None or o.ordered_at < cutoff):
            out.append({"id": c["id"], "name": c.get("description"), "date": c.get("charged_at"), "amount": f2(c.get("amount")),
                        "order_code": o.code, "order_status": o.status, "category": o.category, "ordered_at": to_json_value(o.ordered_at)})
    return out


class AdminChargeIn(BaseModel):
    mode: Literal["percent", "amount"] = "percent"
    value: float = Field(gt=0)
    label: str = Field(default="Administration charges", max_length=80)
    reason: str | None = Field(default=None, max_length=300)


@router.post("/admissions/{eid}/admin-charges", status_code=201)
async def admin_charges(eid: str, body: AdminChargeIn, ctx: CtxDep):
    adm, st = await _editable_state(ctx, eid)
    lines = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    base = sum((_calc(c)["gross"] for c in lines if not _calc(c)["covered"] and _category(c) != "PHARM"
                and not str(c.get("source") or "").startswith("ipbilling.admin")), Decimal(0))
    if body.mode == "percent":
        if body.value > 25:
            raise bad_request("Administration charges above 25% of the bill are not allowed")
        amount = money(base * D(body.value) / 100)
        desc = f"{body.label} ({body.value:g}% of ₹{base:,.2f})"
    else:
        amount = money(D(body.value))
        desc = body.label
    if amount <= 0:
        raise conflict("Nothing to charge — the bill has no chargeable services yet")
    with _self_priced(ctx):
        ch = await billing.post_charge(ctx, patient_id=adm["patient_id"], encounter_id=eid, qty=1, rate=float(amount),
                                       description=desc, source="ipbilling.admin")
    await update(ctx, CHG, ch["id"], {"category": "MISC", "tab": "orders", "price_source": "admin", "admin_basis": body.mode,
                                      "admin_value": body.value})
    await audit(ctx, "ipbill.admin_charges", module="billing", entity="charges", record=ch, after={"amount": float(amount)}, note=body.reason)
    return await _done(ctx, adm, st)


# ================================================================== receipts (split modes), refunds

class ReceiptLine(BaseModel):
    mode: Literal["CASH", "CARD", "UPI", "WALLET", "BANK", "CHEQUE"]
    amount: float = Field(gt=0)
    reference: str | None = Field(default=None, max_length=80)


class ReceiptIn(BaseModel):
    lines: list[ReceiptLine] = Field(min_length=1, max_length=6)
    remarks: str | None = Field(default=None, max_length=200)
    purpose: Literal["advance", "settlement"] = "advance"


async def _cash_today(ctx, pid: str) -> Decimal:
    start = datetime.combine(today(), datetime.min.time(), tzinfo=settings.tz)
    t = payments
    v = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(t.c.amount), 0)).where(
        t.c.patient_id == pid, t.c.mode == "CASH", t.c.kind.in_(["PAYMENT", "DEPOSIT"]), t.c.status == "Success",
        t.c.deleted_at.is_(None), t.c.paid_at >= start))).scalar_one()
    return Decimal(v)


@router.post("/admissions/{eid}/receipts", status_code=201)
async def receipts(eid: str, body: ReceiptIn, ctx: CtxDep):
    require_role(ctx, *DESK_ROLES)
    adm = await _admission(ctx, eid)
    if adm.get("status") == "Cancelled":
        raise conflict("This admission was cancelled")
    st = await _ensure_state(ctx, adm)
    cash = sum((D(x.amount) for x in body.lines if x.mode == "CASH"), Decimal(0))
    if cash and await _cash_today(ctx, adm["patient_id"]) + cash >= CASH_LIMIT:
        raise bad_request("Cash of ₹2,00,000 or more from one person in a day is not permitted (s.269ST) — take the rest by card, UPI or bank transfer")
    for x in body.lines:
        if x.mode != "CASH" and not (x.reference or "").strip():
            raise bad_request(f"Enter the transaction / UTR / cheque reference for the {x.mode} payment")
    closed = adm.get("status") == "Discharged" and st.get("status") != "Reopened"
    invs = [i for i in (await _invoices(ctx, [eid])).get(eid, []) if i.get("status") in ("Final", "Partially Paid") and D(i.get("balance")) > 0]
    made = []
    for x in body.lines:
        left = D(x.amount)
        # after discharge (bill closed) money goes against the outstanding bill; before, it is an advance
        if closed:
            for inv in invs:
                bal = D(inv.get("balance"))
                if left <= 0 or bal <= 0:
                    continue
                amt = min(left, bal)
                pay = await billing.collect(billing.PaymentIn(patient_id=adm["patient_id"], invoice_id=inv["id"], kind="PAYMENT", mode=x.mode,
                                                              amount=float(amt), reference=x.reference), ctx)
                made.append(await update(ctx, PAY, pay["id"], {"encounter_id": eid, "remarks": body.remarks, "purpose": body.purpose}))
                inv["balance"] = float(bal - amt)
                left -= amt
        if left > 0:
            pay = await billing.collect(billing.PaymentIn(patient_id=adm["patient_id"], kind="DEPOSIT", mode=x.mode, amount=float(left),
                                                          reference=x.reference), ctx)
            made.append(await update(ctx, PAY, pay["id"], {"encounter_id": eid, "remarks": body.remarks, "purpose": body.purpose}))
    if closed and st.get("status") == "Final":
        due = sum((D(i.get("balance")) for i in (await _invoices(ctx, [eid])).get(eid, []) if i.get("status") in ("Final", "Partially Paid")), Decimal(0))
        if due <= Decimal("0.009"):
            st = await update(ctx, BILL, st["id"], {"status": "Settled", "settled_at": _stamp()})
    pos = await _snapshot(ctx, adm, st)
    return {"receipts": [{k: r.get(k) for k in ("id", "code", "kind", "mode", "amount", "reference", "remarks", "paid_at")} for r in made],
            "position": pos}


class RefundIn(BaseModel):
    amount: float = Field(gt=0)
    mode: Literal["CASH", "CARD", "UPI", "BANK", "CHEQUE"] = "CASH"
    reason: str = Field(min_length=3, max_length=300)


@router.post("/admissions/{eid}/refund", status_code=201)
async def refund(eid: str, body: RefundIn, ctx: CtxDep):
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    pos = await _position(ctx, adm)
    surplus = max(Decimal(0), -D(pos["balance"]))
    avail = await billing.deposit_balance(ctx, adm["patient_id"])
    limit = min(surplus, avail) if adm.get("status") in OPEN or st.get("status") == "Reopened" else avail
    if D(body.amount) > limit:
        raise bad_request(f"Only the surplus advance of ₹{money(limit):,.2f} can be refunded"
                          + (" while the patient's share is still open" if adm.get("status") in OPEN else ""))
    res = await billing.refund(billing.RefundIn(patient_id=adm["patient_id"], invoice_id=None, amount=body.amount, mode=body.mode,
                                                reason=f"{body.reason} ({adm.get('code')})"), ctx)
    await update(ctx, PAY, res["id"], {"encounter_id": eid})
    await _snapshot(ctx, adm, st)
    return {"refund": {k: res.get(k) for k in ("id", "code", "amount", "mode", "status")}, "approval": res.get("approval"),
            "position": await _position(ctx, adm)}


# ================================================================== approximate bill, finalisation, estimates

@router.post("/admissions/{eid}/approx", status_code=201)
async def approx_bill(eid: str, ctx: CtxDep):
    require_role(ctx, *DESK_ROLES)
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    pos = await _position(ctx, adm)
    items = list(st.get("approx_bills") or [])
    snap = {"no": f"{st.get('code')}/A{len(items) + 1:02d}", "at": _stamp(), "by": ctx.user.get("name"), "net": pos["net"],
            "patient_payable": pos["patient_payable"], "sponsor_payable": pos["sponsor_payable"], "paid": pos["paid"], "balance": pos["balance"]}
    rec = await update(ctx, BILL, st["id"], {"approx_bills": (items + [snap])[-50:]})
    await audit(ctx, "ipbill.approx", module="billing", entity="ip_bills", record=rec, after=snap)
    return snap


async def _finalise(ctx, adm: dict, st: dict) -> dict | None:
    """Unbilled lines → one IP invoice (line discounts, package cover and bill discount honoured)."""
    eid = adm["id"]
    lines = (await _load_lines(ctx, [eid], unbilled_only=True)).get(eid, [])
    if not lines:
        return None
    if (st.get("bill_discount_status") or "None") == "Pending":
        raise conflict("The bill discount is awaiting approval — finalise after it is decided")
    tot = _totals(lines, st)
    pos = await _position(ctx, adm)
    ptype = pos["sponsor"]["payer_type"] if pos["sponsor"]["sponsored"] else "Self"
    reason = st.get("bill_discount_reason") if tot["bill_discount"] > 0 else ("Line discounts" if tot["line_discount"] > 0 else None)
    inv = await create(ctx, INV, {
        "patient_id": adm["patient_id"], "encounter_id": eid, "type": "IP", "payer": ptype if ptype in ("Insurance", "Corporate", "Government Scheme") else "Self",
        "gross": float(tot["gross"]), "tax": float(tot["gst"]), "discount": float(tot["line_discount"] + tot["bill_discount"]),
        "net": float(tot["net"]), "paid": 0, "balance": float(tot["net"]), "billed_at": now().isoformat(),
        "discount_reason": reason, "discount_approval": st.get("bill_discount_approval") if tot["bill_discount"] > 0 else None,
        "status": "Final", "line_discount": float(tot["line_discount"]), "bill_discount": float(tot["bill_discount"]),
        "covered_value": float(tot["covered_value"]), "ip_bill": st.get("id"), "sponsor": pos["sponsor"]["sponsor_id"],
    })
    await ctx.conn.execute(charges.update().where(charges.c.id.in_([c["id"] for c in lines])).values(
        status="Billed", invoice_id=inv["id"], updated_at=now(), updated_by=ctx.user_id))
    await audit(ctx, "ipbill.finalise", module="billing", entity="invoices", record=inv,
                after={"lines": len(lines), "net": float(tot["net"])}, note=f"IP bill {adm.get('code')}")
    inv = await billing._recalc(ctx, inv["id"])
    await update(ctx, BILL, st["id"], {"invoice": inv["id"], "final_at": _stamp(), "status": "Final" if st.get("status") in (None, "Open") else st.get("status")})
    await emit("bill.created", ctx, {"invoice": inv})
    return inv


@router.post("/admissions/{eid}/finalise", status_code=201)
async def finalise(eid: str, ctx: CtxDep):
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    if adm.get("status") == "Discharged" and st.get("status") != "Reopened":
        raise conflict("The bill is closed — reopen it first")
    inv = await _finalise(ctx, adm, st)
    if not inv:
        raise conflict("There are no unbilled charges to finalise")
    return {"invoice": inv, "bill": await _done(ctx, adm, await _state(ctx, eid))}


async def _head_breakup(ctx, adm: dict) -> list[dict]:
    lines = (await _load_lines(ctx, [adm["id"]])).get(adm["id"], [])
    heads: dict[str, Decimal] = defaultdict(Decimal)
    for c in lines:
        x = _calc(c)
        if not x["covered"]:
            heads[x["head"]] += x["after"]
    return [{"head": h, "amount": f2(v)} for h, v in sorted(heads.items(), key=lambda kv: -kv[1]) if v]


class PreauthIn(BaseModel):
    expected_los: int | None = Field(default=None, ge=0, le=365)
    policy_no: str | None = Field(default=None, max_length=60)
    procedure: str | None = Field(default=None, max_length=200)


async def _projection(ctx, adm: dict, st: dict, expected_los: int | None) -> tuple[Decimal, int, Decimal]:
    pos = await _position(ctx, adm)
    los = expected_los if expected_los is not None else int(adm.get("expected_los") or 0)
    stayed = _los(adm.get("started_at"))
    remaining = max(0, los - stayed)
    info = (await _info(ctx, [adm]))[adm["id"]]
    ward = st.get("ward_category") or (info["bed"] or {}).get("category") or "General"
    tariff = await _tariff_for(ctx, st)
    nursing = await _service_by_code(ctx, _nursing_code(ward))
    daily = await _room_rate(ctx, ward, tariff) + (_price(nursing, tariff, ward)[0] if nursing else Decimal(0))
    return money(D(pos["net"]) + daily * remaining), remaining, daily


@router.post("/admissions/{eid}/preauth-estimate", status_code=201)
async def preauth_estimate(eid: str, body: PreauthIn, ctx: CtxDep):
    """Corporate approximate (pre-auth): the projected bill goes to the sponsor as a pre-authorisation request."""
    _need_write(ctx)
    if not has(PREAUTH):
        raise ApiError(503, "The Insurance / TPA module is not installed")
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    pos = await _position(ctx, adm)
    sponsor = pos["sponsor"]["sponsor_id"]
    if not sponsor:
        raise conflict("Set the sponsor on the bill first (Change Sponsor → organisation + prices)")
    projected, remaining, daily = await _projection(ctx, adm, st, body.expected_los)
    breakup = await _head_breakup(ctx, adm)
    if remaining:
        breakup.append({"head": f"Expected stay — {remaining} more day(s) × ₹{daily:,.2f}", "amount": f2(daily * remaining)})
    existing = await first(ctx, PREAUTH, admission=eid, status=["Draft", "Query"], sort="-created_at")
    data = {"requested_amount": float(projected), "estimate_breakup": breakup, "estimated_at": _stamp(),
            "expected_los": body.expected_los if body.expected_los is not None else adm.get("expected_los")}
    if body.procedure:
        data["procedure"] = body.procedure
    if existing:
        rec = await update(ctx, PREAUTH, existing["id"], data)
    else:
        policy = body.policy_no or pos["sponsor"].get("credit_ref")
        if not policy:
            raise bad_request("Enter the policy / card / employee number for the pre-authorisation", {"fields": {"policy_no": "Required"}})
        rec = await create(ctx, PREAUTH, {
            **data, "patient_id": adm["patient_id"], "encounter_id": eid, "payer": sponsor, "policy_no": policy, "admission": eid,
            "treating_doctor": adm.get("doctor_id"), "diagnosis": adm.get("diagnosis") or "As per admission notes",
            "package": (next((c.get("package_id") for c in (await _load_lines(ctx, [eid])).get(eid, []) if c.get("kind") == "package"), None)),
            "expected_admission": (parse_dt(adm.get("started_at")) or now()).date().isoformat(), "status": "Draft",
        })
    await audit(ctx, "ipbill.preauth_estimate", module="billing", entity="ip_bills", record=st,
                after={"preauth": rec.get("code"), "requested": float(projected)})
    return {"preauth": {k: rec.get(k) for k in ("id", "code", "status", "requested_amount", "approved_amount")}, "projected": f2(projected),
            "remaining_days": remaining, "breakup": breakup}


class CostEstimateIn(BaseModel):
    expected_los: int | None = Field(default=None, ge=0, le=365)
    deposit_amount: float | None = Field(default=None, ge=0)


@router.post("/admissions/{eid}/cost-estimate", status_code=201)
async def cost_estimate(eid: str, body: CostEstimateIn, ctx: CtxDep):
    """Package approximate billing: save the projection as a financial-counselling estimate
    (estimate vs actual is closed when the bill settles)."""
    require_role(ctx, *DESK_ROLES)
    if not has(ESTIMATE):
        raise ApiError(503, "The Financial Counselling module is not installed")
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    projected, remaining, daily = await _projection(ctx, adm, st, body.expected_los)
    pos = await _position(ctx, adm)
    lines = (await _load_lines(ctx, [eid])).get(eid, [])
    pkg = next((c for c in lines if c.get("kind") == "package"), None)
    heads = {"Room rent": "Room rent", "Nursing care": "Nursing", "ICU care": "ICU charges", "Consultation": "Doctor / surgeon fees",
             "OT & anaesthesia": "OT charges", "Pharmacy": "Pharmacy", "Laboratory": "Investigations", "Radiology": "Investigations",
             "Blood bank": "Blood products", "Physiotherapy": "Physiotherapy", "Dietary": "Diet"}
    breakup: dict[str, Decimal] = defaultdict(Decimal)
    for h in await _head_breakup(ctx, adm):
        breakup[heads.get(h["head"], "Miscellaneous")] += D(h["amount"])
    if remaining:
        breakup["Room rent"] += daily * remaining
    share = _sponsor_share(projected, pos["sponsor"] | {"sponsored": pos["sponsor"]["sponsored"]})
    rec = await create(ctx, ESTIMATE, {
        "patient_id": adm["patient_id"], "encounter_id": eid, "estimate_date": today().isoformat(), "admission": eid, "ip_bill": st["id"],
        "package": pkg.get("package_id") if pkg else None, "procedure": (pkg or {}).get("package_name") or adm.get("diagnosis"),
        "treating_doctor": adm.get("doctor_id"), "expected_los": body.expected_los if body.expected_los is not None else adm.get("expected_los"),
        "payer_type": {"Self": "Cash"}.get(pos["sponsor"]["payer_type"], pos["sponsor"]["payer_type"]), "payer": pos["sponsor"]["sponsor_id"],
        "breakup": [{"head": h, "amount": f2(v)} for h, v in breakup.items() if v],
        "estimated_amount": float(projected), "deposit_amount": body.deposit_amount, "expected_cover": float(share),
        "patient_share": float(projected - share), "status": "Draft",
        "exclusions": "Projected from the IP working bill; implants, blood products and complications are billed extra.",
    })
    return {"estimate": {k: rec.get(k) for k in ("id", "code", "status", "estimated_amount")}, "projected": f2(projected)}


# ================================================================== settlement & discharge

async def _settle(ctx, adm: dict, st: dict, *, recovery: dict | None = None) -> Decimal:
    """Finalise unbilled lines, post the sponsor credit (→ claim), adjust the advance and any employee
    recovery against the bill. Returns what the patient still owes on the encounter's bills."""
    eid = adm["id"]
    await _finalise(ctx, adm, st)
    pos = await _position(ctx, adm)
    invs = [i for i in (await _invoices(ctx, [eid])).get(eid, []) if i.get("status") in ("Final", "Partially Paid") and D(i.get("balance")) > 0]
    # 1. sponsor credit — the sponsor's share leaves the patient's account and becomes a receivable (claim)
    delta = D(pos["sponsor_payable"]) - D(pos["sponsor_received"])
    sponsor_name = pos["sponsor"].get("sponsor_name") or pos["sponsor"]["payer_type"]
    for inv in invs:
        bal = D(inv.get("balance"))
        if delta <= 0 or bal <= 0:
            continue
        amt = money(min(delta, bal))
        await create(ctx, PAY, {"patient_id": adm["patient_id"], "encounter_id": eid, "invoice_id": inv["id"], "kind": "ADJUSTMENT",
                                "mode": "INSURANCE", "amount": float(amt), "paid_at": now().isoformat(), "status": "Success",
                                "reference": f"Sponsor credit — {sponsor_name}", "received_by": ctx.user.get("name"), "sponsor_credit": True})
        inv.update(await billing._recalc(ctx, inv["id"]))
        delta -= amt
        if has(CLAIM) and pos["sponsor"]["sponsor_id"]:
            pre = await first(ctx, PREAUTH, admission=eid, status=["Approved", "Enhancement Requested"], sort="-created_at") if has(PREAUTH) else None
            await create(ctx, CLAIM, {
                "patient_id": adm["patient_id"], "encounter_id": eid, "payer": pos["sponsor"]["sponsor_id"], "invoice": inv["id"],
                "preauth": pre["id"] if pre else None, "claimed_amount": float(amt), "status": "Draft",
                "claim_type": {"Corporate": "Corporate credit", "Government Scheme": "Government scheme"}.get(pos["sponsor"]["payer_type"], "Cashless"),
            })
    # 2. advance (deposits) against the patient's share, oldest bill first
    avail = await billing.deposit_balance(ctx, adm["patient_id"])
    for inv in invs:
        bal = D(inv.get("balance"))
        if avail <= 0 or bal <= 0:
            continue
        amt = money(min(avail, bal))
        await create(ctx, PAY, {"patient_id": adm["patient_id"], "encounter_id": eid, "invoice_id": inv["id"], "kind": "ADJUSTMENT",
                                "mode": "DEPOSIT", "amount": float(amt), "paid_at": now().isoformat(), "status": "Success",
                                "reference": "Advance adjusted", "received_by": ctx.user.get("name")})
        inv.update(await billing._recalc(ctx, inv["id"]))
        avail -= amt
    # 3. employee recovery (salary deduction through payroll)
    if recovery and D(recovery.get("amount")) > 0:
        left = money(D(recovery["amount"]))
        due = sum((D(i.get("balance")) for i in invs), Decimal(0))
        if left > due:
            raise bad_request(f"Employee recovery cannot exceed the balance due (₹{due:,.2f})")
        emp = (await ctx.conn.execute(sa.select(employees.c.id, employees.c.code, employees.c.title).where(
            employees.c.id == recovery.get("employee_id"), employees.c.deleted_at.is_(None)))).first() if is_uuid(recovery.get("employee_id")) else None
        if not emp:
            raise bad_request("Choose the employee whose salary the amount is recovered from", {"fields": {"employee_id": "Required"}})
        for inv in invs:
            bal = D(inv.get("balance"))
            if left <= 0 or bal <= 0:
                continue
            amt = money(min(left, bal))
            await create(ctx, PAY, {"patient_id": adm["patient_id"], "encounter_id": eid, "invoice_id": inv["id"], "kind": "ADJUSTMENT",
                                    "mode": "SALARY", "amount": float(amt), "paid_at": now().isoformat(), "status": "Success",
                                    "reference": f"Salary recovery — {emp.title} ({emp.code})", "received_by": ctx.user.get("name"),
                                    "employee_id": str(emp.id)})
            inv.update(await billing._recalc(ctx, inv["id"]))
            left -= amt
        if has("payroll.advances"):
            await create(ctx, "payroll.advances", {
                "employee_id": str(emp.id), "advance_type": "Medical emergency loan", "requested_on": today().isoformat(),
                "amount": float(money(D(recovery["amount"]))), "reason": f"Hospital bill recovery — {adm.get('code')}", "status": "Requested",
                "remarks": recovery.get("remarks") or "Raised by the discharge desk; HR to set the monthly recovery",
            })
    return money(sum((D(i.get("balance")) for i in (await _invoices(ctx, [eid])).get(eid, [])
                      if i.get("status") in ("Final", "Partially Paid", "Draft")), Decimal(0)))


async def _close_estimates(ctx, adm: dict, st: dict, net: float) -> None:
    if not has(ESTIMATE):
        return
    for e in await find(ctx, ESTIMATE, admission=adm["id"], limit=10):
        if e.get("status") in ("Closed",):
            continue
        await update(ctx, ESTIMATE, e["id"], {"actual_amount": net, "variance": f2(D(net) - D(e.get("estimated_amount"))), "ip_bill": st["id"]})


async def _sign_billing_clearance(ctx, eid: str) -> None:
    chk = await first(ctx, CHK, encounter_id=eid, status="Open", sort="-created_at") if has(CHK) else None
    if chk and not chk.get("billing_cleared") and (ctx.role == "admin" or ctx.role in WRITE_ROLES):
        await update(ctx, CHK, chk["id"], {"billing_cleared": True})


class RecoveryIn(BaseModel):
    employee_id: str
    amount: float = Field(gt=0)
    remarks: str | None = Field(default=None, max_length=200)


class DischargeIn(BaseModel):
    discharge_type: Literal["Normal", "DAMA", "LAMA", "Transfer", "Absconded", "Death"] = "Normal"
    remarks: str | None = Field(default=None, max_length=500)
    employee_recovery: RecoveryIn | None = None


def _adt_discharge_type(kind: str) -> str:
    want = DISCHARGE_TYPES.get(kind, "Routine")
    f = E(ADM).field_map.get("discharge_type")
    opts = (f.options if f else None) or []
    if not opts or want in opts:
        return want
    return kind if kind in opts else opts[0]


async def _readiness(ctx, adm: dict) -> dict:
    r = await adt.readiness(ctx, adm)
    return {"ready": r["ready"], "pending": r["pending"], "items": r["items"], "checklist": r["checklist"], "billing": r["billing"],
            "pharmacy_returns": r["pharmacy_returns"], "summary": r["summary"], "tat_minutes": r["tat_minutes"], "target_minutes": r["target_minutes"]}


@router.get("/admissions/{eid}/discharge")
async def discharge_data(eid: str, ctx: CtxDep):
    _read(ctx)
    adm = await _admission(ctx, eid)
    view = await _bill_view(ctx, adm)
    ready = await _readiness(ctx, adm) if adm.get("status") in OPEN else None
    bill_item = next((f"Checklist: {i['label']}" for i in (ready or {}).get("items", []) if i["key"] == "billing_cleared"), None)
    clinical = [p for p in (ready or {}).get("pending", []) if not p.startswith("Billing:") and p != bill_item]
    st = await _state(ctx, eid)
    cfg = await ipb_settings(ctx)
    return {**view, "readiness": ready, "clinical_pending": clinical, "notifications": list(reversed((st or {}).get("notifications") or []))[:30],
            "discharge_types": list(DISCHARGE_TYPES), "notify_roles": cfg.get("notify_roles") or DEFAULT_SETTINGS["notify_roles"],
            "draft": {"discharge_type": (st or {}).get("discharge_type") or "Normal", "remarks": (st or {}).get("discharge_remarks")}}


class InitiateIn(BaseModel):
    discharge_type: Literal["Normal", "DAMA", "LAMA", "Transfer", "Absconded", "Death"] = "Normal"
    remarks: str | None = Field(default=None, max_length=500)


@router.post("/admissions/{eid}/initiate-discharge")
async def initiate_discharge(eid: str, body: InitiateIn, ctx: CtxDep):
    """The discharge desk may start the discharge (the clinical checklist opens for sign-off)."""
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    if adm.get("status") != "Admitted":
        raise conflict(f"Admission is {adm.get('status')}")
    st = await _ensure_state(ctx, adm)
    await update(ctx, BILL, st["id"], {"discharge_type": body.discharge_type, "discharge_remarks": body.remarks})
    await transition(ctx, ADM, eid, "Discharge Initiated", note=body.remarks or "Initiated from the discharge desk",
                     values={"discharge_type": _adt_discharge_type(body.discharge_type)})
    return await discharge_data(eid, ctx)


class DraftIn(BaseModel):
    discharge_type: Literal["Normal", "DAMA", "LAMA", "Transfer", "Absconded", "Death"]
    remarks: str | None = Field(default=None, max_length=500)


@router.put("/admissions/{eid}/discharge-draft")
async def discharge_draft(eid: str, body: DraftIn, ctx: CtxDep):
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    await update(ctx, BILL, st["id"], {"discharge_type": body.discharge_type, "discharge_remarks": body.remarks})
    return {"ok": True}


class NotifyIn(BaseModel):
    step: Literal["settle", "details", "release"]
    roles: list[str] | None = None
    message: str | None = Field(default=None, max_length=300)


@router.post("/admissions/{eid}/notify")
async def notify(eid: str, body: NotifyIn, ctx: CtxDep):
    require_role(ctx, *DESK_ROLES)
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    cfg = await ipb_settings(ctx)
    roles = [r for r in (body.roles or (cfg.get("notify_roles") or {}).get(body.step) or []) if isinstance(r, str)][:8]
    if not roles:
        raise bad_request("Choose who to notify")
    info = (await _info(ctx, [adm]))[eid]
    label = {"settle": "Bill settlement", "details": "Discharge details", "release": "Bed release"}[body.step]
    bed = (info["bed"] or {}).get("bed_no")
    msg = body.message or f"{label}: {info['patient']['name']} ({adm.get('code')}{', bed ' + bed if bed else ''})"
    live(ctx, "alerts", {"type": "discharge_step", "roles": roles, "message": msg, "admission_id": eid, "step": body.step})
    await emit("ipbilling.notify", ctx, {"admission_id": eid, "patient_id": adm["patient_id"], "roles": roles, "message": msg, "step": body.step})
    log_row = {"at": _stamp(), "by": ctx.user.get("name"), "step": body.step, "roles": roles, "message": msg}
    await update(ctx, BILL, st["id"], {"notifications": (list(st.get("notifications") or []) + [log_row])[-100:]})
    return log_row


@router.post("/admissions/{eid}/discharge")
async def confirm_discharge(eid: str, body: DischargeIn, ctx: CtxDep):
    """Confirm discharge & release bed: settle the bill (hard block while the patient's share is
    outstanding), then run the admission transitions so ADT's readiness checks and bed release apply."""
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    if adm.get("status") not in OPEN:
        raise conflict(f"Admission is {adm.get('status')}")
    st = await _ensure_state(ctx, adm)
    if st.get("status") == "Reopen Requested":
        raise conflict("A reopen request is awaiting approval")
    await update(ctx, BILL, st["id"], {"discharge_type": body.discharge_type, "discharge_remarks": body.remarks})
    st = await _state(ctx, eid)
    pos = await _position(ctx, adm)
    if D(pos["balance"]) > Decimal("0.009") and not body.employee_recovery:
        raise ApiError(409, f"Outstanding balance ₹{D(pos['balance']):,.2f} — collect it, adjust the settlement or record the sponsor's approved amount before discharge",
                       {"balance": pos["balance"]}, code="BALANCE_OUTSTANDING")
    due = await _settle(ctx, adm, st, recovery=body.employee_recovery.model_dump() if body.employee_recovery else None)
    if due > Decimal("0.009"):
        raise ApiError(409, f"Outstanding balance ₹{due:,.2f} — collect it before discharge", {"balance": float(due)}, code="BALANCE_OUTSTANDING")
    kind = _adt_discharge_type(body.discharge_type)
    if adm.get("status") == "Admitted":
        adm = await transition(ctx, ADM, eid, "Discharge Initiated", note="Initiated at the discharge desk", values={"discharge_type": kind})
    await _sign_billing_clearance(ctx, eid)
    note = f"{body.discharge_type}" + (f" — {body.remarks}" if body.remarks else "")
    rec = await transition(ctx, ADM, eid, "Discharged", note=note, values={"discharge_type": kind})
    final = await _position(ctx, rec)
    st = await update(ctx, BILL, st["id"], {"status": "Settled", "settled_at": _stamp(), "net": final["net"], "balance": final["balance"],
                                             "patient_payable": final["patient_payable"], "sponsor_payable": final["sponsor_payable"]})
    final["status"] = "Settled"
    await _close_estimates(ctx, rec, st, final["net"])
    hk = await first(ctx, "housekeeping.requests", source_encounter=eid, sort="-created_at") if has("housekeeping.requests") else None
    live(ctx, "alerts", {"type": "discharge_done", "roles": ["nurse", "support", "front_office"],
                         "message": f"Discharged {rec.get('code')} — bed released for cleaning"})
    await audit(ctx, "ipbill.discharge", module="billing", entity="ip_bills", record=st,
                after={"discharge_type": body.discharge_type, "net": final["net"], "balance": final["balance"]}, note=body.remarks)
    return {"admission": {k: rec.get(k) for k in ("id", "code", "status", "ended_at", "discharge_type")}, "position": final,
            "turnaround_request": {"id": hk["id"], "code": hk.get("code")} if hk else None}


@router.post("/admissions/{eid}/settle")
async def settle(eid: str, body: DischargeIn, ctx: CtxDep):
    """Re-settle a reopened bill after discharge (finalise changes, adjust advance / sponsor, close)."""
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    st = await _ensure_state(ctx, adm)
    if adm.get("status") != "Discharged" or st.get("status") != "Reopened":
        raise conflict("Only a reopened bill of a discharged patient is settled here — use the discharge wizard otherwise")
    due = await _settle(ctx, adm, st, recovery=body.employee_recovery.model_dump() if body.employee_recovery else None)
    pos = await _position(ctx, adm)
    status = "Settled" if due <= Decimal("0.009") else "Final"
    st = await update(ctx, BILL, st["id"], {"status": status, "settled_at": _stamp() if status == "Settled" else None, "net": pos["net"],
                                             "balance": pos["balance"], "patient_payable": pos["patient_payable"], "sponsor_payable": pos["sponsor_payable"]})
    await _close_estimates(ctx, adm, st, pos["net"])
    await audit(ctx, "ipbill.resettle", module="billing", entity="ip_bills", record=st, after={"due": float(due), "net": pos["net"]})
    return {"due": float(due), "status": status, "bill": await _bill_view(ctx, adm)}


# ================================================================== reopen (approval + audit)

class ReopenIn(BaseModel):
    reason: str = Field(min_length=5, max_length=300)


@router.post("/admissions/{eid}/reopen")
async def reopen(eid: str, body: ReopenIn, ctx: CtxDep):
    _need_write(ctx)
    adm = await _admission(ctx, eid)
    if adm.get("status") != "Discharged":
        raise conflict("Only a discharged patient's bill is reopened — the bill of an admitted patient is still open")
    st = await _ensure_state(ctx, adm)
    if st.get("status") in ("Reopen Requested", "Reopened"):
        raise conflict(f"The bill is already {st['status'].lower()}")
    appr = await request_approval(ctx, "ipbilling.reopen", subject_fqn=BILL, subject_id=st["id"], amount=float(D(st.get("net"))), force=True,
                                  summary=f"Reopen IP bill {adm.get('code')} after discharge: {body.reason}")
    rec = await update(ctx, BILL, st["id"], {"status": "Reopen Requested", "reopen_reason": body.reason, "reopen_approval": (appr or {}).get("id"),
                                             "status_before_reopen": st.get("status")})
    await audit(ctx, "ipbill.reopen_request", module="billing", entity="ip_bills", record=rec, note=body.reason)
    return {"state": rec, "approval": {k: appr.get(k) for k in ("id", "code", "status", "approver_role")} if appr else None}


@on_decided("ipbilling.reopen")
async def _reopen_decided(ctx, approval: dict, approved: bool):
    st = await get(ctx, BILL, approval["subject_id"])
    if not st or st.get("status") != "Reopen Requested" or st.get("reopen_approval") != approval["id"]:
        return
    if not approved:
        await update(ctx, BILL, st["id"], {"status": st.get("status_before_reopen") or "Settled",
                                           "reopen_reason": f"Rejected: {approval.get('comments') or ''}".strip()})
        return
    await _reopen(ctx, st, approval)


async def _reopen(ctx, st: dict, approval: dict) -> None:
    """Cancel the encounter's IP bills and return their lines to the working bill. Money received is
    preserved: patient payments become advance again, advance adjustments and sponsor credits are
    reversed, refunds against the bill move to the advance account."""
    eid = st["encounter_id"]
    invs = (await _invoices(ctx, [eid])).get(eid, [])
    pays = await _invoice_payments(ctx, [i["id"] for i in invs])
    moved = Decimal(0)
    for inv in invs:
        for p in pays.get(inv["id"], []):
            amt = D(p.get("amount"))
            await update(ctx, PAY, p["id"], {"status": "Reversed", "reversed_reason": f"Bill {inv.get('code')} reopened", "reversed_at": _stamp()})
            if p.get("kind") == "PAYMENT" and p.get("mode") != "INSURANCE":
                await create(ctx, PAY, {"patient_id": st["patient_id"], "encounter_id": eid, "kind": "DEPOSIT", "mode": p.get("mode"),
                                        "amount": float(amt), "paid_at": p.get("paid_at") or now().isoformat(), "status": "Success",
                                        "reference": f"Re-credited from {p.get('code')} (bill {inv.get('code')} reopened)",
                                        "received_by": ctx.user.get("name")})
                moved += amt
            elif p.get("kind") == "REFUND":
                await create(ctx, PAY, {"patient_id": st["patient_id"], "encounter_id": eid, "kind": "REFUND", "mode": p.get("mode"),
                                        "amount": float(amt), "paid_at": p.get("paid_at") or now().isoformat(), "status": "Success",
                                        "reference": f"Carried from {p.get('code')} (bill {inv.get('code')} reopened)", "received_by": ctx.user.get("name")})
            elif p.get("mode") == "SALARY" and p.get("employee_id") and has("payroll.advances"):
                for a in await find(ctx, "payroll.advances", employee_id=p["employee_id"], status="Requested", limit=10):
                    if (a.get("reason") or "").endswith(str(st.get("code") or "~")) or "Hospital bill recovery" in (a.get("reason") or ""):
                        await transition(ctx, "payroll.advances", a["id"], "Rejected", values={"remarks": f"Bill {inv.get('code')} reopened"})
                        break
        await ctx.conn.execute(charges.update().where(charges.c.invoice_id == inv["id"]).values(
            status="Unbilled", invoice_id=None, updated_at=now(), updated_by=ctx.user_id))
        rec = await update(ctx, INV, inv["id"], {"status": "Cancelled", "balance": 0, "cancel_reason": f"Reopened: {st.get('reopen_reason')}"})
        await audit(ctx, "bill.cancel", module="billing", entity="invoices", record=rec, note=f"IP bill reopened ({approval.get('code')})")
    if has(CLAIM):
        for c in await find(ctx, CLAIM, encounter_id=eid, status="Draft", limit=20):
            await update(ctx, CLAIM, c["id"], {"status": "Rejected", "rejection_reason": "IP bill reopened — claim to be re-raised on settlement"})
    rec = await update(ctx, BILL, st["id"], {"status": "Reopened", "reopened_at": _stamp(), "invoice": None, "settled_at": None})
    await audit(ctx, "ipbill.reopen", module="billing", entity="ip_bills", record=rec,
                after={"bills_cancelled": [i.get("code") for i in invs], "re_credited": float(moved)}, note=st.get("reopen_reason"))


# ================================================================== discharge desk lists

@router.get("/discharge/queue")
async def discharge_queue(ctx: CtxDep, q: str | None = None):
    _read(ctx)
    e = encounters
    adms, total = await _page(ctx, [e.c.status == "Discharge Initiated"], q=q, sort="started_at", page=1, limit=200)
    rows = await _rows(ctx, adms)
    for r, a in zip(rows, adms, strict=True):
        r["initiated_at"] = a.get("discharge_initiated_at")
    return {"rows": rows, "total": total, "permissions": _role_perms(ctx)}


@router.get("/discharge/discharged")
async def discharged(ctx: CtxDep, q: str | None = None, date_from: date | None = None, date_to: date | None = None,
                     page: int = 1, limit: int = 10, sort: str = "-discharged"):
    _read(ctx)
    e = encounters
    conds = [e.c.status == "Discharged"]
    if date_from:
        conds.append(e.c.ended_at >= datetime.combine(date_from, datetime.min.time(), tzinfo=settings.tz))
    if date_to:
        conds.append(e.c.ended_at < datetime.combine(date_to + timedelta(days=1), datetime.min.time(), tzinfo=settings.tz))
    adms, total = await _page(ctx, conds, q=q, sort=sort, page=page, limit=limit)
    return {"rows": await _rows(ctx, adms), "total": total, "page": page, "limit": limit, "permissions": _role_perms(ctx)}


# ================================================================== documents

@router.get("/admissions/{eid}/documents")
async def documents(eid: str, ctx: CtxDep):
    _read(ctx)
    adm = await _admission(ctx, eid)
    cfg = await ipb_settings(ctx)
    rows = await find(ctx, DOCS, encounter_id=eid, limit=100) if has(DOCS) else []
    fids = [r.get("file") for r in rows if is_uuid(r.get("file"))]
    meta = {str(f.id): f for f in (await ctx.conn.execute(sa.select(files.c.id, files.c.name, files.c.mime, files.c.size)
                                                           .where(files.c.id.in_(fids)))).all()} if fids else {}
    return {"types": cfg.get("document_types") or DEFAULT_SETTINGS["document_types"], "patient_id": adm["patient_id"],
            "can_upload": _role_perms(ctx)["documents"],
            "documents": [{"id": r["id"], "code": r.get("code"), "type": r.get("ipb_doc_type") or r.get("category"), "category": r.get("category"),
                           "name": r.get("document_name"), "file": r.get("file"), "status": r.get("status"), "uploaded_at": r.get("created_at"),
                           "mime": meta[r["file"]].mime if r.get("file") in meta else None,
                           "size": meta[r["file"]].size if r.get("file") in meta else None} for r in rows]}


class DocumentIn(BaseModel):
    type: str = Field(min_length=1, max_length=40)
    file_id: str
    name: str | None = Field(default=None, max_length=200)


@router.post("/admissions/{eid}/documents", status_code=201)
async def add_document(eid: str, body: DocumentIn, ctx: CtxDep):
    require_role(ctx, *DESK_ROLES, "nurse")
    if not has(DOCS):
        raise ApiError(503, "The Documents module is not installed")
    adm = await _admission(ctx, eid)
    cfg = await ipb_settings(ctx)
    dtype = next((t for t in cfg.get("document_types") or [] if t.get("key") == body.type or t.get("label") == body.type), None)
    if not dtype:
        raise bad_request("Unknown document type")
    if not is_uuid(body.file_id):
        raise bad_request("Upload the file first")
    f = (await ctx.conn.execute(sa.select(files.c.id, files.c.name, files.c.mime, files.c.size, files.c.patient_id)
                                .where(files.c.id == body.file_id, files.c.deleted_at.is_(None)))).first()
    if not f:
        raise not_found("File not found")
    allowed = {MIME_OF.get(str(x).upper(), "") for x in dtype.get("formats") or []}
    if allowed - {""} and f.mime not in allowed:
        raise bad_request(f"{dtype.get('label')}: only {', '.join(dtype.get('formats') or [])} files are accepted")
    max_mb = float(dtype.get("max_mb") or 10)
    if (f.size or 0) > max_mb * 1024 * 1024:
        raise bad_request(f"{dtype.get('label')}: the file is larger than {max_mb:g} MB")
    rec = await create(ctx, DOCS, {
        "patient_id": adm["patient_id"], "encounter_id": eid, "category": dtype.get("category") or "Other",
        "document_name": body.name or f"{dtype.get('label')} — {adm.get('code')}", "document_date": today().isoformat(),
        "file": body.file_id, "source": "Generated internally" if dtype.get("key") == "discharge_summary" else "Scanned at desk",
        "ipb_doc_type": dtype.get("key"), "status": "Uploaded",
    })
    return {"id": rec["id"], "code": rec.get("code"), "type": dtype.get("key"), "name": rec.get("document_name")}


# ================================================================== payment desk

@router.get("/payment-desk")
async def payment_desk(ctx: CtxDep, date_from: date | None = None, date_to: date | None = None, q: str | None = None,
                       kind: str | None = None, mode: str | None = None):
    """Advances and receipts across admissions for a period, with mode totals, plus the in-house
    patients whose share is not covered by their advance."""
    _read(ctx)
    d1, d2 = date_from or today(), date_to or date_from or today()
    if (d2 - d1).days > 92:
        raise bad_request("Choose a range of at most 3 months")
    start = datetime.combine(d1, datetime.min.time(), tzinfo=settings.tz)
    end = datetime.combine(d2 + timedelta(days=1), datetime.min.time(), tzinfo=settings.tz)
    t, e, p = payments, encounters, patients
    ip_inv = sa.select(invoices.c.id).where(invoices.c.type == "IP")
    conds = [t.c.deleted_at.is_(None), t.c.paid_at >= start, t.c.paid_at < end,
             sa.or_(t.c.encounter_id.isnot(None), t.c.invoice_id.in_(ip_inv), t.c.kind == "DEPOSIT")]
    if kind:
        conds.append(t.c.kind == kind.upper())
    if mode:
        conds.append(t.c.mode == mode.upper())
    j = t.join(p, p.c.id == t.c.patient_id).outerjoin(e, e.c.id == t.c.encounter_id)
    if q and q.strip():
        term = _like(q)
        conds.append(sa.or_(sa.func.lower(p.c.title).like(term, escape="\\"), sa.func.lower(p.c.code).like(term, escape="\\"),
                            p.c.phone.like(term, escape="\\"), sa.func.lower(t.c.code).like(term, escape="\\"),
                            sa.func.lower(e.c.code).like(term, escape="\\")))
    rows = (await ctx.conn.execute(sa.select(t, p.c.title.label("p_name"), p.c.code.label("p_uhid"), e.c.code.label("ip_no"))
                                   .select_from(j).where(*conds).order_by(t.c.paid_at.desc()).limit(500))).all()
    recs = []
    by_mode: dict[str, Decimal] = defaultdict(Decimal)
    totals = {"advances": Decimal(0), "receipts": Decimal(0), "refunds": Decimal(0), "adjusted": Decimal(0)}
    for r in rows:
        rec = rs.to_record(r)
        amt = D(rec.get("amount"))
        if rec.get("status") == "Success":
            if rec.get("kind") == "DEPOSIT":
                totals["advances"] += amt
                by_mode[rec.get("mode") or "—"] += amt
            elif rec.get("kind") == "PAYMENT":
                totals["receipts"] += amt
                by_mode[rec.get("mode") or "—"] += amt
            elif rec.get("kind") == "REFUND":
                totals["refunds"] += amt
                by_mode[rec.get("mode") or "—"] -= amt
            elif rec.get("kind") == "ADJUSTMENT":
                totals["adjusted"] += amt
        recs.append({k: rec.get(k) for k in ("id", "code", "kind", "mode", "amount", "reference", "remarks", "paid_at", "status",
                                             "received_by", "invoice_id", "encounter_id", "patient_id", "p_name", "p_uhid", "ip_no")})
    # in-house patients with an uncovered share (top 50 by balance)
    ent = E(ADM)
    open_rows = (await ctx.conn.execute(sa.select(ent.table).where(*rs.base_where(ent), ent.table.c.status.in_(OPEN))
                                        .order_by(ent.table.c.started_at.asc()).limit(1000))).all()
    adms = [rs.to_record(r) for r in open_rows]
    pos = await _positions(ctx, adms)
    due = sorted((a for a in adms if pos[a["id"]]["balance"] > 0), key=lambda a: -pos[a["id"]]["balance"])[:50]
    return {
        "range": {"from": d1.isoformat(), "to": d2.isoformat()}, "rows": recs,
        "totals": {k: f2(v) for k, v in totals.items()} | {"net_collection": f2(totals["advances"] + totals["receipts"] - totals["refunds"])},
        "by_mode": [{"mode": m, "amount": f2(v)} for m, v in sorted(by_mode.items(), key=lambda kv: -kv[1])],
        "inhouse": {"admissions": len(adms), "billed": f2(sum((D(v["net"]) for v in pos.values()), Decimal(0))),
                    "advance": f2(sum((D(v["advance"]) for v in pos.values()), Decimal(0))),
                    "to_collect": f2(sum((D(v["balance"]) for v in pos.values() if v["balance"] > 0), Decimal(0)))},
        "due": await _rows(ctx, due), "permissions": _role_perms(ctx),
    }


# ================================================================== prints (print-optimised HTML)

FORMATS: dict[str, tuple[str, str]] = {
    "interim": ("Interim Receipt", "Receipts collected so far against the running bill."),
    "summarised": ("Summarised Bill", "One line per billing head."),
    "semi": ("Semi Summarised Bill", "Each head broken into its service categories, with no individual charge lines."),
    "final": ("Final Bill", "Every charge line, settled against the receipts collected."),
    "nonmed_summary": ("Non Medical Bill Summary (For Patient Use only)", "Services and stay charges only, totalled per head, GST inclusive."),
    "nonmed": ("Non Medical Bill (For Patient Use only)", "Services and stay charges line by line, without medicines or consumables."),
    "pharmacy": ("Pharmacy Bill", "Every pharmacy issue and return with batch and expiry."),
    "sponsor_tpa": ("Insurance / TPA Bill", "Head-wise bill with policy, pre-authorisation, co-pay and the insurer's share."),
    "sponsor_corporate": ("Corporate Bill", "Credit bill to the organisation at the corporate tariff, with the employee's share."),
    "sponsor_govt": ("Government Scheme Bill", "Scheme claim statement with beneficiary details and package codes."),
    "detailed_gst": ("Detailed Bill with GST", "Every line with SAC / HSN, taxable value and CGST / SGST."),
    "estimate": ("Approximate Bill (Estimate)", "Running estimate of the stay — not a final bill."),
}
SPONSOR_FORMATS = ("sponsor_tpa", "sponsor_corporate", "sponsor_govt", "detailed_gst")

_CSS = """
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { font: 12px/1.45 "Inter", "Segoe UI", system-ui, sans-serif; color: #0f172a; margin: 0; background: #e2e8f0; }
.sheet { background: #fff; width: 210mm; min-height: 297mm; margin: 12px auto; padding: 14mm 12mm; box-shadow: 0 2px 12px rgb(0 0 0 / .12); }
.lh { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1e3a8a; padding-bottom: 8px; margin-bottom: 10px; }
.lh .name { font-size: 18px; font-weight: 700; color: #1e3a8a; }
.lh .sub { font-size: 10.5px; color: #475569; }
.lh .right { text-align: right; font-size: 10.5px; color: #475569; }
.plain-top { height: 28mm; }
h1 { font-size: 14px; letter-spacing: .08em; text-transform: uppercase; margin: 6px 0 2px; }
.doc-sub { color: #64748b; font-size: 10.5px; margin-bottom: 8px; }
.meta { display: flex; justify-content: space-between; align-items: baseline; }
.box { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 16px; }
.grid div span { display: block; font-size: 9.5px; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
.grid div b { font-weight: 600; }
table { width: 100%; border-collapse: collapse; margin: 6px 0; }
th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: #475569; border-bottom: 1.5px solid #334155; padding: 4px 5px; }
td { border-bottom: 1px solid #e2e8f0; padding: 4px 5px; vertical-align: top; }
td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
tr.group td { background: #f1f5f9; font-weight: 600; }
tr.covered td { color: #047857; }
.tot { width: 55%; margin-left: auto; }
.tot td { border: none; padding: 2px 5px; }
.tot tr.big td { border-top: 1.5px solid #334155; font-weight: 700; font-size: 13px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #1e3a8a; border-bottom: 1px solid #1e3a8a; padding-bottom: 2px; margin: 14px 0 4px; }
.muted { color: #64748b; }
.tag { display: inline-block; font-size: 9px; padding: 0 4px; border: 1px solid #10b981; color: #047857; border-radius: 3px; margin-left: 4px; }
.water { position: fixed; top: 40%; left: 0; right: 0; text-align: center; font-size: 64px; color: rgb(30 58 138 / .07); transform: rotate(-24deg); pointer-events: none; font-weight: 800; }
.sign { display: flex; justify-content: space-between; margin-top: 34px; gap: 24px; }
.sign div { flex: 1; border-top: 1px solid #334155; text-align: center; padding-top: 3px; font-size: 10.5px; color: #475569; }
.foot { margin-top: 14px; border-top: 1px solid #cbd5e1; padding-top: 4px; font-size: 9.5px; color: #64748b; text-align: center; }
.band { background: #1e3a8a; color: #fff; padding: 5px 10px; display: flex; justify-content: space-between; font-weight: 600; letter-spacing: .05em; margin-top: 6px; }
.slip + .slip { margin-top: 10mm; padding-top: 6mm; border-top: 1px dashed #94a3b8; }
@media print { body { background: #fff; } .sheet { box-shadow: none; margin: 0; width: auto; min-height: auto; padding: 0; } .water { position: fixed; } }
"""


def _e(v: Any) -> str:
    return html.escape("" if v is None else str(v))


def _m(v: Any) -> str:
    n = float(D(v))
    s = f"{abs(n):,.2f}"
    # Indian digit grouping (12,34,567.89)
    whole, frac = s.replace(",", "").split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join(parts + [tail])
    return ("-" if n < 0 else "") + "₹" + whole + "." + frac


def _dt(v: Any, with_time: bool = True) -> str:
    d = parse_dt(v) if v else None
    if not d:
        return "—"
    d = d.astimezone(settings.tz)
    return d.strftime("%d/%m/%Y %I:%M %p") if with_time else d.strftime("%d/%m/%Y")


def _letterhead(cfg: dict, show: bool, right: str = "") -> str:
    if not show:
        return '<div class="plain-top"></div>'
    lh = cfg.get("letterhead") or {}
    sub = " · ".join(_e(x) for x in (lh.get("address"), lh.get("tagline")) if x)
    contact = " · ".join(_e(x) for x in (lh.get("phone"), lh.get("email")) if x)
    gst = f"GSTIN {_e(lh.get('gstin'))}" if lh.get("gstin") else ""
    logo = f'<img src="{_e(lh["logo_url"])}" alt="" style="height:38px;margin-right:10px">' if lh.get("logo_url") else ""
    return (f'<div class="lh"><div style="display:flex;align-items:center">{logo}<div><div class="name">{_e(lh.get("name"))}</div>'
            f'<div class="sub">{sub}</div><div class="sub">{contact}{" · " if contact and gst else ""}{gst}</div></div></div>'
            f'<div class="right">{right}</div></div>')


def _html_page(title: str, body: str, *, water: str | None = None) -> str:
    wm = f'<div class="water">{_e(water)}</div>' if water else ""
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>{_e(title)}</title><style>{_CSS}</style></head><body>{wm}{body}</body></html>')


def _patient_box(v: dict, extra: list[tuple[str, Any]] | None = None) -> str:
    p, a = v["patient"], v["admission"]
    bed = a.get("bed") or {}
    ward = (a.get("ward") or {}).get("name")
    cells = [("Patient", p.get("name")), ("UHID", p.get("uhid")), ("Age / Gender", f"{p.get('age') if p.get('age') is not None else '—'} / {p.get('gender') or '—'}"),
             ("IP No", a.get("ip_no")), ("Admitted on", _dt(a.get("admitted_at"))), ("Discharged on", _dt(a.get("discharged_at")) if a.get("discharged_at") else "—"),
             ("Consultant", a.get("doctor")), ("Department", a.get("department")), ("Ward / Bed", " · ".join(x for x in (ward, bed.get("bed_no")) if x) or "—"),
             ("Payer", v["sponsor"].get("sponsor_name") or ("Self-pay" if v["sponsor"]["payer_type"] == "Self" else v["sponsor"]["payer_type"])),
             ("Mobile", p.get("phone")), ("Length of stay", f"{a.get('los_days')} day(s)")]
    cells += extra or []
    return '<div class="box grid">' + "".join(f"<div><span>{_e(k)}</span><b>{_e(v_ if v_ not in (None, '') else '—')}</b></div>" for k, v_ in cells) + "</div>"


def _totals_block(v: dict, *, gst_inclusive: bool = False) -> str:
    pos, t = v["position"], v["totals"]
    rows = [("Gross charges", pos["gross"]), ("Discount", -pos["discount"])]
    if not gst_inclusive:
        rows.append(("GST", pos["gst"]))
    rows.append(("Net bill", pos["net"]))
    if pos["sponsor_payable"]:
        rows.append(("Payable by sponsor", -pos["sponsor_payable"]))
        rows.append(("Patient payable", pos["patient_payable"]))
    rows.append(("Received (incl. advance)", -pos["paid"]))
    rows.append(("Balance due" if pos["balance"] >= 0 else "Refundable to patient", abs(pos["balance"])))
    if t.get("covered_value"):
        rows.insert(1, ("Covered by package (not billed separately)", None))
    out = ['<table class="tot">']
    for i, (k, val) in enumerate(rows):
        big = ' class="big"' if k in ("Net bill",) or i == len(rows) - 1 else ""
        out.append(f"<tr{big}><td>{_e(k)}</td><td class='r'>{'' if val is None else _m(val)}</td></tr>")
    out.append("</table>")
    return "".join(out)


def _billable(v: dict, *, nonmed: bool = False) -> list[dict]:
    return [ln for ln in v["lines"] if not (nonmed and ln["category"] == "PHARM")]


def _render_bill(fmt: str, v: dict, cfg: dict, *, letterhead: bool, extra: dict) -> str:
    title, sub = FORMATS[fmt]
    pos = v["position"]
    no = extra.get("no") or (v["position"].get("bill_code") if fmt in ("final", "detailed_gst") or fmt in SPONSOR_FORMATS else None) or v["admission"]["ip_no"]
    right = f"No. <b>{_e(no)}</b><br>Date {_e(_dt(now().isoformat()))}"
    parts = [_letterhead(cfg, letterhead, right), f'<div class="meta"><div><h1>{_e(title)}</h1><div class="doc-sub">{_e(sub)}</div></div></div>']
    sponsor_extra: list[tuple[str, Any]] = []
    sp = v["sponsor"]
    if fmt in SPONSOR_FORMATS and fmt != "detailed_gst":
        sponsor_extra = [("Sponsor", sp.get("sponsor_name") or sp.get("payer_type")), ("Credit letter / pre-auth", sp.get("credit_ref")),
                         ("Approved amount", _m(sp["approved_amount"]) if sp.get("approved_amount") is not None else "—"),
                         ("Co-pay", f"{sp.get('co_pay_percent') or 0:g}%"), ("Diagnosis", v["admission"].get("diagnosis")),
                         ("Tariff", (sp.get("tariff") or {}).get("name") or "Hospital tariff")]
    parts.append(_patient_box(v, sponsor_extra))
    lines = v["lines"]
    if fmt == "interim":
        parts.append("<h2>Receipts</h2><table><tr><th>Receipt</th><th>Date</th><th>Type</th><th>Mode</th><th>Reference</th><th class='r'>Amount</th></tr>")
        total = Decimal(0)
        for r in sorted(v["receipts"], key=lambda x: x.get("paid_at") or ""):
            if r.get("status") != "Success" or r.get("kind") == "ADJUSTMENT":
                continue
            sign = -1 if r.get("kind") == "REFUND" else 1
            total += D(r.get("amount")) * sign
            parts.append(f"<tr><td>{_e(r.get('code'))}</td><td>{_e(_dt(r.get('paid_at')))}</td><td>{_e({'DEPOSIT': 'Advance', 'PAYMENT': 'Payment', 'REFUND': 'Refund'}.get(r.get('kind'), r.get('kind')))}</td>"
                         f"<td>{_e(r.get('mode'))}</td><td>{_e(r.get('reference') or r.get('remarks') or '')}</td><td class='r'>{_m(D(r.get('amount')) * sign)}</td></tr>")
        parts.append(f"<tr class='group'><td colspan='5'>Total received</td><td class='r'>{_m(total)}</td></tr></table>")
        parts.append(f"<p class='muted'>Running bill to date {_m(pos['net'])} · patient share {_m(pos['patient_payable'])} · balance {_m(pos['balance'])}. "
                     "This receipt is not a final bill.</p>")
    elif fmt in ("summarised", "nonmed_summary", "estimate", "sponsor_tpa", "sponsor_corporate", "sponsor_govt"):
        groups: dict[str, dict[str, Decimal]] = defaultdict(lambda: {"amount": Decimal(0), "disc": Decimal(0), "n": Decimal(0)})
        for ln in _billable(v, nonmed=fmt == "nonmed_summary"):
            if ln["covered"]:
                continue
            key = ln["head"] if fmt not in ("summarised", "estimate") else ln["group"].title()
            g = groups[key]
            g["amount"] += D(ln["after_total"]) if fmt == "nonmed_summary" else D(ln["gross"])
            g["disc"] += D(ln["discount"])
            g["n"] += 1
        parts.append("<table><tr><th>Billing head</th><th class='r'>Items</th><th class='r'>Amount</th><th class='r'>Discount</th><th class='r'>Net</th></tr>")
        for k, g in sorted(groups.items(), key=lambda kv: -kv[1]["amount"]):
            net = g["amount"] - (Decimal(0) if fmt == "nonmed_summary" else g["disc"])
            parts.append(f"<tr><td>{_e(k)}</td><td class='r'>{int(g['n'])}</td><td class='r'>{_m(g['amount'])}</td>"
                         f"<td class='r'>{_m(g['disc']) if fmt != 'nonmed_summary' else '—'}</td><td class='r'>{_m(net)}</td></tr>")
        parts.append("</table>")
        if v["packages"]:
            parts.append("<p class='muted'>" + "; ".join(f"{_e(p['name'])}: {p['covered_count']} service(s) included" for p in v["packages"]) + ".</p>")
        if fmt in ("sponsor_tpa", "sponsor_corporate", "sponsor_govt"):
            parts.append(f"<table class='tot'><tr><td>Net bill</td><td class='r'>{_m(pos['net'])}</td></tr>"
                         f"<tr><td>Payable by {_e(sp.get('sponsor_name') or 'sponsor')}</td><td class='r'>{_m(pos['sponsor_payable'])}</td></tr>"
                         f"<tr><td>Patient share (co-pay / non-payables / excess)</td><td class='r'>{_m(pos['patient_payable'])}</td></tr>"
                         f"<tr class='big'><td>Amount claimed</td><td class='r'>{_m(pos['sponsor_payable'])}</td></tr></table>")
            if fmt == "sponsor_govt":
                parts.append("<p class='muted'>Beneficiary entitlement and package codes as per the scheme's health benefit package; "
                             "the hospital certifies that no amount beyond the patient share has been collected from the beneficiary.</p>")
        else:
            parts.append(_totals_block(v, gst_inclusive=fmt == "nonmed_summary"))
    elif fmt == "semi":
        tree: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
        for ln in lines:
            if not ln["covered"]:
                tree[ln["group"]][ln["head"]] += D(ln["after_total"])
        parts.append("<table><tr><th>Billing head / category</th><th class='r'>Amount</th></tr>")
        for g in sorted(tree, key=lambda x: GROUP_ORDER.index(x) if x in GROUP_ORDER else 99):
            parts.append(f"<tr class='group'><td>{_e(g.title())}</td><td class='r'>{_m(sum(tree[g].values(), Decimal(0)))}</td></tr>")
            for h, amt in sorted(tree[g].items(), key=lambda kv: -kv[1]):
                parts.append(f"<tr><td style='padding-left:18px'>{_e(h)}</td><td class='r'>{_m(amt)}</td></tr>")
        parts.append("</table>" + _totals_block(v))
    elif fmt == "pharmacy":
        ph = [ln for ln in lines if ln["category"] == "PHARM"]
        parts.append("<table><tr><th>Date</th><th>Item · batch</th><th>Expiry</th><th>Source</th><th class='r'>Qty</th><th class='r'>Rate</th><th class='r'>GST %</th><th class='r'>Amount</th></tr>")
        total = Decimal(0)
        for ln in ph:
            total += D(ln["after_total"])
            parts.append(f"<tr><td>{_e(_dt(ln['date'], False))}</td><td>{_e(ln['name'])}</td><td>{_e(extra.get('expiry', {}).get(ln['id'], '—'))}</td>"
                         f"<td>{_e(ln['source_label'])}</td><td class='r'>{ln['qty']:g}</td><td class='r'>{_m(ln['rate'])}</td>"
                         f"<td class='r'>{ln['tax_percent']:g}</td><td class='r'>{_m(ln['after_total'])}</td></tr>")
        if not ph:
            parts.append("<tr><td colspan='8' class='muted'>No pharmacy issues on this stay.</td></tr>")
        parts.append(f"<tr class='group'><td colspan='7'>Pharmacy total (bill of supply, returns netted)</td><td class='r'>{_m(total)}</td></tr></table>")
    else:  # final, nonmed, detailed_gst — line by line
        nonmed = fmt == "nonmed"
        gst_cols = fmt == "detailed_gst"
        head = ("<tr><th>#</th><th>Date</th><th>Service</th>" + ("<th>SAC/HSN</th>" if gst_cols else "") +
                "<th class='r'>Qty</th><th class='r'>Rate</th><th class='r'>Disc.</th>" +
                ("<th class='r'>Taxable</th><th class='r'>CGST</th><th class='r'>SGST</th>" if gst_cols else "<th class='r'>GST</th>") +
                "<th class='r'>Amount</th></tr>")
        parts.append("<table>" + head)
        by_group: dict[str, list[dict]] = defaultdict(list)
        for ln in _billable(v, nonmed=nonmed):
            by_group[ln["group"]].append(ln)
        i = 0
        cols = 11 if gst_cols else 8
        for g in sorted(by_group, key=lambda x: GROUP_ORDER.index(x) if x in GROUP_ORDER else 99):
            sub_total = sum((D(x["after_total"]) for x in by_group[g]), Decimal(0))
            parts.append(f"<tr class='group'><td colspan='{cols - 1}'>{_e(g.title())}</td><td class='r'>{_m(sub_total)}</td></tr>")
            for ln in by_group[g]:
                i += 1
                cov = "<span class='tag'>Included in package</span>" if ln["covered"] else ""
                gst_cells = (f"<td class='r'>{_m(D(ln['gross']) - D(ln['discount']))}</td><td class='r'>{_m(D(ln['gst']) / 2)}</td><td class='r'>{_m(D(ln['gst']) / 2)}</td>"
                             if gst_cols else f"<td class='r'>{_m(ln['gst']) if ln['gst'] else '—'}</td>")
                sac = f"<td>{_e(extra.get('sac', {}).get(ln['id'], '9993'))}</td>" if gst_cols else ""
                parts.append(f"<tr class='{'covered' if ln['covered'] else ''}'><td>{i}</td><td>{_e(_dt(ln['date'], False))}</td><td>{_e(ln['name'])}{cov}</td>{sac}"
                             f"<td class='r'>{ln['qty']:g}</td><td class='r'>{_m(ln['rate'])}</td><td class='r'>{_m(ln['discount']) if ln['discount'] else '—'}</td>"
                             f"{gst_cells}<td class='r'>{_m(ln['after_total'])}</td></tr>")
        parts.append("</table>")
        if fmt == "final" and v["receipts"]:
            parts.append("<h2>Receipts & adjustments</h2><table><tr><th>Receipt</th><th>Date</th><th>Type</th><th>Mode</th><th class='r'>Amount</th></tr>")
            for r in sorted(v["receipts"], key=lambda x: x.get("paid_at") or ""):
                if r.get("status") != "Success":
                    continue
                kind = {"DEPOSIT": "Advance", "PAYMENT": "Payment", "REFUND": "Refund", "ADJUSTMENT": "Adjusted"}.get(r.get("kind"), r.get("kind"))
                parts.append(f"<tr><td>{_e(r.get('code'))}</td><td>{_e(_dt(r.get('paid_at')))}</td><td>{_e(kind)}</td><td>{_e(r.get('mode'))}</td>"
                             f"<td class='r'>{_m(r.get('amount'))}</td></tr>")
            parts.append("</table>")
        parts.append(_totals_block(v))
    if v["totals"].get("bill_discount") or (v["bill_discount"]["status"] == "Approved" and v["bill_discount"]["value"]):
        parts.append(f"<p class='muted'>Bill discount: {_e(v['bill_discount']['reason'] or '')}</p>")
    parts.append('<div class="sign"><div>Prepared by</div><div>Billing in-charge</div><div>Patient / Attendant</div></div>')
    parts.append(f'<div class="foot">{_e((cfg.get("print") or {}).get("footer") or DEFAULT_SETTINGS["print"]["footer"])} · Printed by {_e(extra.get("user"))}</div>')
    water = "ESTIMATE" if fmt in ("estimate",) or (fmt != "interim" and v["admission"]["status"] in OPEN and fmt not in SPONSOR_FORMATS + ("final", "pharmacy")) else None
    if fmt == "final" and v["admission"]["status"] in OPEN and not v["invoices"]:
        water = "PROVISIONAL"
    return _html_page(f"{title} · {v['patient']['name']}", f'<div class="sheet">{"".join(parts)}</div>', water=water)


async def _case_sheet(ctx, adm: dict, v: dict, cfg: dict, letterhead: bool) -> str:
    pid, eid = adm["patient_id"], adm["id"]
    p = v["patient"]
    parts = [_letterhead(cfg, letterhead, f"No. <b>{_e(p.get('uhid'))}</b><br>Date {_e(_dt(now().isoformat()))}"),
             '<h1>Patient Case Sheet</h1><div class="doc-sub">Complete clinical record</div>']
    parts.append('<div class="box grid">' + "".join(f"<div><span>{k}</span><b>{_e(val or '—')}</b></div>" for k, val in [
        ("Patient", p.get("name")), ("UHID", p.get("uhid")), ("Age / Gender", f"{p.get('age') if p.get('age') is not None else '—'} / {p.get('gender') or '—'}"),
        ("Mobile", p.get("phone")), ("Blood group", p.get("blood_group")), ("Category", (v["sponsor"]["payer_type"] or "General").upper() if v["sponsor"]["payer_type"] != "Self" else "GENERAL"),
    ]) + "</div>")
    # labs during the stay
    start = parse_dt(adm.get("started_at")) or now()
    end = parse_dt(adm.get("ended_at")) or now()
    o = orders
    lab_rows = (await ctx.conn.execute(sa.select(o).where(o.c.patient_id == pid, o.c.deleted_at.is_(None), o.c.category.in_(["LAB", "RAD"]),
                                                          o.c.status != "Cancelled", sa.or_(o.c.encounter_id == eid, sa.and_(
                                                              o.c.ordered_at >= start - timedelta(hours=12), o.c.ordered_at <= end + timedelta(hours=1))))
                                       .order_by(o.c.ordered_at.asc()).limit(60))).all()
    labs = [rs.to_record(r) for r in lab_rows]
    svc = await _services(ctx, {x.get("service_id") for x in labs})
    if labs:
        for x in labs:
            name = (svc.get(x.get("service_id") or "") or {}).get("name") or x.get("title") or "Investigation"
            parts.append(f"<h2>{'Lab' if x.get('category') == 'LAB' else 'Imaging'} · {_e(x.get('code'))} · {_e(_dt(x.get('ordered_at'), False))}</h2>")
            vals = x.get("result_values") or []
            parts.append("<table><tr><th>Investigation</th><th>Result</th><th>Unit</th><th>Biological reference interval</th></tr>")
            if vals:
                for rv in vals:
                    flag = f" ({_e(rv.get('flag'))})" if rv.get("flag") not in (None, "", "Normal") else ""
                    parts.append(f"<tr><td>{_e(rv.get('parameter'))}</td><td><b>{_e(rv.get('value'))}</b>{flag}</td><td>{_e(rv.get('unit'))}</td><td>{_e(rv.get('ref_range'))}</td></tr>")
            else:
                parts.append(f"<tr><td>{_e(name)}</td><td>{_e((x.get('result') or x.get('status') or '').upper()[:80])}</td><td></td><td>{_e(x.get('impression') or '')}</td></tr>")
            parts.append("</table>")
    else:
        parts.append("<h2>Investigations</h2><p>No investigations recorded.</p>")
    allergies = p.get("allergies") or []
    parts.append("<h2>Allergies</h2>" + (f"<p>{_e(', '.join(allergies))}</p>" if allergies else "<p>No known allergies recorded.</p>"))
    meds: list[str] = []
    if has("pharmacy.dispenses"):
        for d in await find(ctx, "pharmacy.dispenses", encounter_id=eid, limit=50):
            refs = d.get("_refs") or {}
            for it in d.get("items") or []:
                label = refs.get(it.get("item") or "") or "Item"
                meds.append(f"{label} × {it.get('qty')}" + (f" (batch {it.get('batch')})" if it.get("batch") else ""))
    parts.append("<h2>Medications</h2>" + ("<table><tr><th>Medicine issued on this stay</th></tr>" + "".join(f"<tr><td>{_e(m)}</td></tr>" for m in meds[:80]) + "</table>"
                                           if meds else "<p>No medications recorded.</p>"))
    vit = await find(ctx, "emr.vitals", patient_id=pid, encounter_id=eid, limit=12, sort="-recorded_at") if has("emr.vitals") else []
    if vit:
        parts.append("<h2>Vitals</h2><table><tr><th>Recorded</th><th>Temp</th><th>Pulse</th><th>BP</th><th>RR</th><th>SpO₂</th><th>NEWS2</th></tr>")
        for x in vit:
            bp = f"{x.get('bp_systolic')}/{x.get('bp_diastolic')}" if x.get("bp_systolic") else "—"
            parts.append(f"<tr><td>{_e(_dt(x.get('recorded_at')))}</td><td>{_e(x.get('temperature') or '—')}</td><td>{_e(x.get('pulse') or '—')}</td>"
                         f"<td>{_e(bp)}</td><td>{_e(x.get('resp_rate') or '—')}</td><td>{_e(x.get('spo2') or '—')}</td><td>{_e(x.get('news2') if x.get('news2') is not None else '—')}</td></tr>")
        parts.append("</table>")
    else:
        parts.append("<h2>Vitals</h2><p>No vitals recorded.</p>")
    e = encounters
    visits = (await ctx.conn.execute(sa.select(e).where(e.c.patient_id == pid, e.c.deleted_at.is_(None)).order_by(e.c.started_at.desc().nulls_last()).limit(15))).all()
    vrecs = [rs.to_record(r) for r in visits]
    vinfo = await _info(ctx, vrecs)
    parts.append("<h2>Visit history</h2><table>")
    for x in vrecs:
        i = vinfo[x["id"]]
        where = " · ".join(str(s) for s in ((i["ward"] or {}).get("name"), (i["bed"] or {}).get("bed_no"), i["department"] or i["doctor"]) if s)
        dis = f" · discharged {_dt(x.get('ended_at'), False)}" if x.get("status") == "Discharged" and x.get("ended_at") else f" · {x.get('status')}"
        parts.append(f"<tr><td style='width:90px'>{_e(_dt(x.get('started_at') or x.get('created_at'), False))}</td><td>{_e(x.get('type'))} {_e(x.get('code'))}"
                     f"{' · ' + _e(where) if where else ''}{_e(dis)}</td></tr>")
    parts.append("</table>")
    inv_rows = (await ctx.conn.execute(sa.select(invoices).where(invoices.c.patient_id == pid, invoices.c.deleted_at.is_(None),
                                                                 invoices.c.status != "Cancelled").order_by(invoices.c.billed_at.desc()).limit(30))).all()
    invs = [rs.to_record(r) for r in inv_rows]
    agg: dict[str, list[Decimal]] = {"Outpatient": [Decimal(0), Decimal(0)], "Inpatient": [Decimal(0), Decimal(0)], "Emergency / other": [Decimal(0), Decimal(0)]}
    for i in invs:
        k = "Outpatient" if i.get("type") == "OP" else "Inpatient" if i.get("type") in ("IP", "PACKAGE", "DAYCARE") else "Emergency / other"
        agg[k][0] += D(i.get("net"))
        agg[k][1] += D(i.get("balance"))
    parts.append("<h2>Billing summary</h2><table>" + "".join(f"<tr><td>{k} billed</td><td class='r'>{_m(a[0])}</td><td>due</td><td class='r'>{_m(a[1])}</td></tr>" for k, a in agg.items()) + "</table>")
    if invs:
        parts.append("<table><tr><th>Date</th><th>Bill</th><th class='r'>Net</th><th class='r'>Paid</th><th class='r'>Due</th><th>Status</th></tr>" + "".join(
            f"<tr><td>{_e(_dt(i.get('billed_at'), False))}</td><td>{_e(i.get('code'))}</td><td class='r'>{_m(i.get('net'))}</td><td class='r'>{_m(i.get('paid'))}</td>"
            f"<td class='r'>{_m(i.get('balance'))}</td><td>{_e((i.get('status') or '').upper())}</td></tr>" for i in invs) + "</table>")
    parts.append(f'<div class="foot">{_e((cfg.get("print") or {}).get("footer") or DEFAULT_SETTINGS["print"]["footer"])}</div>')
    await audit(ctx, "print", module="billing", entity="ip_bills", record={"id": eid, "patient_id": pid, "code": adm.get("code")}, note="Case sheet")
    return _html_page(f"Case Sheet · {p.get('name')}", f'<div class="sheet">{"".join(parts)}</div>')


def _checkout(v: dict, cfg: dict, letterhead: bool) -> str:
    p, a, pos = v["patient"], v["admission"], v["position"]
    bed = " / ".join(str(x) for x in ((a.get("ward") or {}).get("name"), (a.get("bed") or {}).get("bed_no")) if x) or "—"
    dtype = (v.get("state") or {}).get("discharge_type") or {"Routine": "Normal", "Referred": "Transfer"}.get(a.get("discharge_type") or "", a.get("discharge_type")) or "Normal"
    status = "SETTLED" if pos["balance"] <= 0.009 else "OUTSTANDING"
    rows = [("Patient", p.get("name"), "UHID", p.get("uhid")),
            ("Age / Gender", f"{p.get('age') if p.get('age') is not None else '—'} / {p.get('gender') or '—'}", "Mobile", p.get("phone")),
            ("IP No", a.get("ip_no"), "Admitted on", _dt(a.get("admitted_at"))),
            ("Discharged on", _dt(a.get("discharged_at")) if a.get("discharged_at") else "—", "Consultant", a.get("doctor")),
            ("Ward / Bed released", bed, "Length of stay", f"{a.get('los_days')} day(s)"),
            ("Discharge type", str(dtype).upper(), "Payer", v["sponsor"].get("sponsor_name") or ("Self-pay" if v["sponsor"]["payer_type"] == "Self" else v["sponsor"]["payer_type"])),
            ("Bill No", pos.get("bill_code") or "—", "Bill amount", _m(pos["net"])),
            ("Received", _m(pos["paid"] + pos["sponsor_received"]), "Balance due", _m(max(0, pos["balance"]))),
            ("Account status", status, "", "")]
    table = "<table>" + "".join(f"<tr><td class='muted' style='width:22%'>{_e(a1)}</td><td style='width:28%'><b>{_e(b1 or '—')}</b></td>"
                                  f"<td class='muted' style='width:20%'>{_e(a2)}</td><td><b>{_e(b2 if a2 else '')}</b></td></tr>" for a1, b1, a2, b2 in rows) + "</table>"
    copies = []
    for copy in ("HOSPITAL COPY", "PATIENT COPY"):
        copies.append(f'<div class="slip">{_letterhead(cfg, letterhead)}<div class="band"><span>CHECK-OUT SLIP — {copy}</span>'
                      f'<span>No. {_e(a.get("ip_no"))} · {_e(_dt(now().isoformat()))}</span></div>{table}'
                      '<div class="sign"><div>Billing Desk</div><div>Ward Nurse</div><div>Patient / Attendant</div></div>'
                      f'<div class="foot">{_e((cfg.get("print") or {}).get("footer") or DEFAULT_SETTINGS["print"]["footer"])}</div></div>')
    return _html_page(f"Check-out Slip · {p.get('name')}", f'<div class="sheet">{"".join(copies)}</div>')


async def _pharmacy_expiry(ctx, v: dict) -> dict[str, str]:
    """Expiry per pharmacy line from the dispense / indent it came from (matched on batch)."""
    ids = {ln["id"] for ln in v["lines"] if ln["category"] == "PHARM"}
    if not ids:
        return {}
    rows = (await ctx.conn.execute(sa.select(charges.c.id, charges.c.source, charges.c.source_id, charges.c.data).where(charges.c.id.in_(list(ids))))).all()
    srcs = defaultdict(set)
    for r in rows:
        if r.source and r.source_id:
            srcs[r.source].add(str(r.source_id))
    expiry: dict[tuple[str, str], str] = {}
    for fqn, sids in srcs.items():
        if not has(fqn):
            continue
        ent = E(fqn)
        t = ent.table
        for rec in (await ctx.conn.execute(sa.select(t).where(t.c.id.in_(list(sids))))).all():
            r = rs.to_record(rec)
            for key in ("items", "lines", "allocations"):
                for it in r.get(key) or []:
                    if isinstance(it, dict) and it.get("batch") and it.get("expiry"):
                        expiry[(r["id"], str(it["batch"]))] = str(it["expiry"])[:10]
    out = {}
    for ln, r in ((ln, next((x for x in rows if str(x.id) == ln["id"]), None)) for ln in v["lines"] if ln["id"] in ids):
        if r and r.source_id and "batch " in ln["name"]:
            batch = ln["name"].split("batch ", 1)[1].split()[0].strip("()")
            if (str(r.source_id), batch) in expiry:
                out[ln["id"]] = _dt(expiry[(str(r.source_id), batch)], False)
    return out


@router.get("/print/{eid}/{fmt}", response_class=HTMLResponse)
async def print_doc(eid: str, fmt: str, ctx: CtxDep, letterhead: bool = True, download: bool = False, no: str | None = None):
    _read(ctx)
    adm = await _admission(ctx, eid)
    cfg = await ipb_settings(ctx)
    v = await _bill_view(ctx, adm)
    if fmt == "casesheet":
        body = await _case_sheet(ctx, adm, v, cfg, letterhead)
        name = f"case-sheet-{adm.get('code')}"
    elif fmt == "checkout":
        body = _checkout(v, cfg, letterhead)
        name = f"checkout-slip-{adm.get('code')}"
        await audit(ctx, "print", module="billing", entity="ip_bills", record={"id": eid, "patient_id": adm["patient_id"], "code": adm.get("code")}, note="Check-out slip")
    elif fmt in FORMATS:
        extra: dict[str, Any] = {"user": ctx.user.get("name"), "no": no}
        if fmt == "pharmacy":
            extra["expiry"] = await _pharmacy_expiry(ctx, v)
        if fmt == "detailed_gst":
            lines = (await _load_lines(ctx, [eid])).get(eid, [])
            extra["sac"] = {c["id"]: ((c.get("_svc") or {}).get("hsn_sac") or ("3004" if _category(c) == "PHARM" else "996311" if _is_room(c) else "9993")) for c in lines}
        body = _render_bill(fmt, v, cfg, letterhead=letterhead, extra=extra)
        name = f"{fmt}-{adm.get('code')}"
        await audit(ctx, "print", module="billing", entity="ip_bills", record={"id": eid, "patient_id": adm["patient_id"], "code": adm.get("code")},
                    note=FORMATS[fmt][0])
    else:
        raise not_found("Unknown print format")
    headers = {"Content-Disposition": f'attachment; filename="{name}.html"'} if download else {}
    return HTMLResponse(body, headers=headers)


@router.get("/formats")
async def formats(ctx: CtxDep):
    _read(ctx)
    return [{"key": k, "title": t, "description": d, "sponsor": k in SPONSOR_FORMATS} for k, (t, d) in FORMATS.items()]


__all__ = ["router", "summary", "ipb_settings"]
