"""OP pharmacy counter: walk-in (OTC), prescription and credit sales from the OP Pharmacy store.

* item search by brand / generic / code / barcode with FEFO batch stock,
* pricing in units or strips, GST per item (MRP is GST-inclusive; CGST + SGST split), discounts governed
  by the margin-discount configuration (never below purchase cost), credit organisations with co-pay
  and credit limits, multiple payment modes, round-off, draft bills,
* drug safety through the pharmacy engine (allergy / interaction / schedule checks with override reasons),
  stock through the inventory engine (FEFO stock_out, batch-wise restock), and a `pharmacy.dispenses`
  record per sale so prescription balances, controlled-drug registers and pharmacy revenue stay whole,
* due collection, cancellation, returns with approval (batch-wise restock, refund or due adjustment),
* counter shifts (open with float, close with a cash count and variance) and the counter reports:
  bills, dues with ageing, and user-wise collections.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core import records as rs
from ..core.audit import audit
from ..core.permissions import page_level
from ..core.rbac import check_access, require_page
from ..core.security import CtxDep
from ..core.sequences import next_code
from ..core.util import (
    ApiError,
    bad_request,
    conflict,
    is_uuid,
    money,
    new_id,
    not_found,
    now,
    parse_date,
    parse_dt,
    today,
)
from ..modules.clinical.pharmacy import COUNTERS, PAY_MODES, SALE_TYPES
from ..schema import employees, stock
from ._common import E, create, find, get, update
from .inventory import item_label, items_by_id, stock_in, stock_out
from .pharmacy import (
    ALERT_TYPE_LABEL,
    CONTROLLED,
    DISPENSE,
    INTERVENTION,
    REGISTER,
    SCHEDULE_LABEL,
    SEVERE,
    _override_text,
    _prescription,
    _refresh_rx_status,
    _rx_lines,
    _rx_quantity_alerts,
    dispensed_by_rx,
    patient_or_404,
    safety_check,
)

router = APIRouter(prefix="/api/op-pharmacy", tags=["op-pharmacy"])

STORE = "OP Pharmacy"
BILLS, RECEIPTS, RETURNS = "pharmacy.counter_bills", "pharmacy.counter_receipts", "pharmacy.counter_returns"
SHIFTS, ORGS, RULES = "pharmacy.shifts", "pharmacy.credit_orgs", "pharmacy.margin_discounts"

COUNTER_PAGE = ("pharmacy", "op-pharmacy")  # selling, collections, returns and shifts need this workspace at "edit"
RETURN_DAYS = 30
NON_CASH_REF = {"CARD", "UPI", "WALLET", "CHEQUE", "BANK"}
ZERO = Decimal(0)
SPECIFICITY = {"Item": 0, "Drug class": 1, "Manufacturer": 1, "Item type": 2, "All items": 3}


def _d(v: Any) -> Decimal:
    return Decimal(str(v if v not in (None, "") else 0))


def _f(v: Decimal) -> float:
    return float(money(v))


def _stamp() -> str:
    return now().isoformat(timespec="seconds")


def _reports(ctx) -> None:
    """Counter reports: whoever may read pharmacy bills (pharmacist, management by default)."""
    rs.ensure_access(ctx, E(BILLS), "read")


def _sell(ctx) -> None:
    require_page(ctx, *COUNTER_PAGE, "edit")
    rs.ensure_access(ctx, E(BILLS), "write")


def can_sell(ctx) -> bool:
    return page_level(ctx.user, *COUNTER_PAGE) == "edit" and check_access(ctx.user, E(BILLS).module, E(BILLS), "write").ok


def pack_size(it: dict) -> int:
    v = it.get("pack_size")
    try:
        if v not in (None, ""):
            return max(1, int(float(v)))
    except (TypeError, ValueError):
        pass
    return 10 if it.get("form") in ("Tablet", "Capsule") else 1


# ================================================================== stock, rules, shifts

async def _batches(ctx, item_ids: list[str]) -> dict[str, list[dict]]:
    ids = [i for i in dict.fromkeys(item_ids) if is_uuid(i)]
    if not ids:
        return {}
    t = stock
    rows = (await ctx.conn.execute(sa.select(t.c.item_id, t.c.batch, t.c.expiry, t.c.qty, t.c.mrp, t.c.rate).where(
        t.c.item_id.in_(ids), t.c.store == STORE, t.c.deleted_at.is_(None), t.c.qty > 0,
        sa.func.coalesce(t.c.status, "Available") != "Quarantine", sa.or_(t.c.expiry.is_(None), t.c.expiry >= today()),
    ).order_by(t.c.expiry.asc().nulls_last(), t.c.created_at))).all()
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[str(r.item_id)].append({"batch": r.batch, "expiry": r.expiry.isoformat() if r.expiry else None,
                                    "days_left": (r.expiry - today()).days if r.expiry else None, "qty": float(r.qty),
                                    "mrp": float(r.mrp) if r.mrp is not None else None, "rate": float(r.rate) if r.rate is not None else None})
    return out


async def _rules(ctx) -> list[dict]:
    rows = await find(ctx, RULES, status="Active", limit=500)
    t = today()
    live = [r for r in rows if (not r.get("valid_from") or parse_date(r["valid_from"]) <= t) and (not r.get("valid_to") or parse_date(r["valid_to"]) >= t)]
    return sorted(live, key=lambda r: (float(r.get("priority") or 10), SPECIFICITY.get(r.get("applies_to") or "All items", 3)))


def _rule_for(rules: list[dict], it: dict, margin: float | None, sale_type: str) -> dict | None:
    for r in rules:
        if r.get("sale_types") and sale_type not in r["sale_types"]:
            continue
        at, mv = r.get("applies_to") or "All items", str(r.get("match_value") or "").strip().lower()
        if at == "Item" and r.get("item") != it["id"]:
            continue
        if at == "Drug class" and (not mv or mv not in str(it.get("drug_class") or "").lower()):
            continue
        if at == "Manufacturer" and mv != str(it.get("manufacturer") or "").strip().lower():
            continue
        if at == "Item type" and mv != str(it.get("type") or "").strip().lower():
            continue
        lo, hi = float(r.get("margin_from") or 0), float(r.get("margin_to") if r.get("margin_to") not in (None, "") else 100)
        if margin is None:
            if lo > 0:
                continue
        elif not (lo <= margin <= hi):
            continue
        return r
    return None


async def current_shift(ctx) -> dict | None:
    rows = await find(ctx, SHIFTS, status="Open", sort="-opened_at", limit=50)
    return next((s for s in rows if s.get("user_id") == ctx.user_id), None)


async def _need_shift(ctx) -> dict:
    s = await current_shift(ctx)
    if not s:
        raise ApiError(409, "Open your counter shift before billing or refunding", code="SHIFT_CLOSED")
    return s


async def _org(ctx, oid: str | None) -> dict | None:
    if not oid:
        return None
    org = await get(ctx, ORGS, oid)
    if not org:
        raise bad_request("Credit organisation not found", {"fields": {"credit_org": "Unknown"}})
    if (org.get("status") or "Active") != "Active":
        raise conflict(f"{org.get('name')} is inactive for credit")
    return org


async def _org_outstanding(ctx, org_id: str, exclude: str | None = None) -> Decimal:
    ent = E(BILLS)
    t = ent.table
    v = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(sa.cast(t.c.data["due"].astext, sa.Numeric)), 0)).where(
        *rs.base_where(ent), t.c.status == "Due", t.c.data["credit_org"].astext == org_id,
        *([t.c.id != exclude] if exclude else [])))).scalar_one()
    return _d(v)


# ================================================================== search & pricing

@router.get("/config")
async def config(ctx: CtxDep):
    rs.ensure_access(ctx, E(BILLS), "read")
    orgs = [{"id": o["id"], "name": o.get("name"), "org_type": o.get("org_type"), "discount_percent": o.get("discount_percent"),
             "copay_percent": o.get("copay_percent"), "credit_limit": o.get("credit_limit"), "credit_days": o.get("credit_days")}
            for o in await find(ctx, ORGS, status="Active", sort="title", limit=500)]
    shift = await current_shift(ctx)
    return {"store": STORE, "counters": COUNTERS, "pay_modes": PAY_MODES, "sale_types": SALE_TYPES, "credit_orgs": orgs,
            "shift": await _shift_view(ctx, shift) if shift else None, "return_days": RETURN_DAYS,
            "can_sell": can_sell(ctx)}


@router.get("/items")
async def search_items(ctx: CtxDep, q: str, limit: int = 20):
    """Brand / generic / code / barcode search with OP Pharmacy stock by batch (first-expiry first)."""
    _sell(ctx)
    term = q.strip()
    if len(term) < 2:
        return {"rows": []}
    ent = E("mdm.items")
    t = ent.table
    like = f"%{rs._escape_like(term.lower())}%"
    rows = (await ctx.conn.execute(sa.select(t).where(
        *rs.base_where(ent), sa.func.coalesce(t.c.status, "Active") != "Banned",
        sa.or_(t.c.search.ilike(like, escape="\\"), sa.func.lower(t.c.data["generic_name"].astext).like(like),
               t.c.data["barcode"].astext == term, sa.func.lower(t.c.code) == term.lower()))
        .order_by(sa.case((sa.func.lower(t.c.title).like(f"{term.lower()}%"), 0), else_=1), t.c.title).limit(max(1, min(limit, 50))))).all()
    items = [rs.to_record(r) for r in rows]
    batches = await _batches(ctx, [i["id"] for i in items])
    rules = await _rules(ctx)
    out = []
    for it in items:
        bs = batches.get(it["id"], [])
        mrp = bs[0]["mrp"] if bs and bs[0]["mrp"] is not None else it.get("mrp")
        rate = bs[0]["rate"] if bs and bs[0]["rate"] is not None else it.get("purchase_rate")
        margin = round((float(mrp) - float(rate)) / float(mrp) * 100, 1) if mrp and rate is not None and float(mrp) > 0 else None
        rule = _rule_for(rules, it, margin, "Walk-in (OTC)")
        out.append({"id": it["id"], "code": it.get("code"), "name": item_label(it), "generic": it.get("generic_name"),
                    "strength": it.get("strength"), "form": it.get("form"), "type": it.get("type"), "uom": it.get("uom"),
                    "manufacturer": it.get("manufacturer"), "schedule": it.get("schedule") or "None", "high_alert": bool(it.get("high_alert")),
                    "status": it.get("status") or "Active", "gst_percent": it.get("gst_percent") if it.get("gst_percent") is not None else 12,
                    "hsn": it.get("hsn"), "mrp": mrp, "pack_size": pack_size(it), "available": round(sum(b["qty"] for b in bs), 3),
                    "batches": [{k: b[k] for k in ("batch", "expiry", "days_left", "qty", "mrp")} for b in bs], "margin_percent": margin,
                    "max_discount_percent": float(rule.get("max_discount_percent") or 0) if rule else 0.0,
                    "default_discount_percent": float(rule.get("default_discount_percent") or 0) if rule else 0.0})
    return {"rows": out}


class LineIn(BaseModel):
    item_id: str
    qty: float = Field(gt=0, le=100000)
    unit: Literal["Unit", "Strip"] = "Unit"
    pack_size: int | None = Field(default=None, ge=1, le=1000)
    batch: str | None = Field(default=None, max_length=60)
    discount_percent: float | None = Field(default=None, ge=0, le=100)


async def price(ctx, lines: list[LineIn], *, sale_type: str, org: dict | None) -> dict:
    """Allocate FEFO batches and price every line. Nothing is written; `problems` lists what blocks a sale."""
    ids = [ln.item_id for ln in lines]
    if not all(is_uuid(i) for i in ids):
        raise bad_request("Invalid item in the bill")
    items = await items_by_id(ctx, ids)
    batches = await _batches(ctx, ids)
    rules = await _rules(ctx)
    used: dict[tuple[str, str | None], Decimal] = defaultdict(Decimal)
    out, problems = [], []
    org_disc = float(org.get("discount_percent") or 0) if org else 0.0
    for i, ln in enumerate(lines, 1):
        it = items.get(ln.item_id)
        if not it:
            raise bad_request(f"Line {i}: item not found in the item master")
        name = item_label(it)
        if (it.get("status") or "Active") == "Banned":
            problems.append({"line": i, "item": name, "message": f"{name} is banned (CDSCO) and cannot be sold", "blocking": True})
            continue
        pk = ln.pack_size or pack_size(it)
        units = _d(ln.qty) * (pk if ln.unit == "Strip" else 1)
        if units != units.to_integral_value():
            problems.append({"line": i, "item": name, "message": f"{name}: enter whole units", "blocking": True})
            continue
        pool = [b for b in batches.get(it["id"], []) if not ln.batch or b["batch"] == ln.batch]
        avail = sum((_d(b["qty"]) - used[(it["id"], b["batch"])] for b in pool), ZERO)
        if units > avail:
            where = f"batch {ln.batch}" if ln.batch else STORE
            problems.append({"line": i, "item": name, "blocking": True,
                             "message": f"Only {avail.normalize():f} {it.get('uom') or 'units'} of {name} in stock ({where}); {units.normalize():f} needed"})
            continue
        need = units
        for b in pool:
            if need <= 0:
                break
            free = _d(b["qty"]) - used[(it["id"], b["batch"])]
            take = min(free, need)
            if take <= 0:
                continue
            need -= take
            used[(it["id"], b["batch"])] += take
            mrp = _d(b["mrp"] if b["mrp"] is not None else it.get("mrp"))
            rate = b["rate"] if b["rate"] is not None else it.get("purchase_rate")
            margin = float((mrp - _d(rate)) / mrp * 100) if mrp > 0 and rate not in (None, "") else None
            rule = _rule_for(rules, it, margin, sale_type)
            max_d = float(rule.get("max_discount_percent") or 0) if rule else 0.0
            def_d = float(rule.get("default_discount_percent") or 0) if rule else 0.0
            if org:
                max_d, def_d = max(max_d, org_disc), max(def_d, org_disc)
            if margin is not None:
                max_d = min(max_d, max(0.0, round(margin, 2)))  # never below purchase cost
            pct = float(ln.discount_percent) if ln.discount_percent is not None else min(def_d, max_d)
            if pct > max_d + 1e-6:
                problems.append({"line": i, "item": name, "blocking": True,
                                 "message": f"Discount on {name} is limited to {max_d:g}%" + (" by the margin discount configuration" if rule else
                                                                                              " — no discount rule covers this item")})
            gst_pct = _d(it.get("gst_percent") if it.get("gst_percent") is not None else 12)
            gross = money(take * mrp)
            disc = money(gross * _d(pct) / 100)
            amount = gross - disc
            taxable = money(amount * 100 / (100 + gst_pct))
            out.append({"line": i, "item_id": it["id"], "name": name, "generic": it.get("generic_name"), "schedule": it.get("schedule") or "None",
                        "batch": b["batch"], "expiry": b["expiry"], "unit": ln.unit, "pack_size": pk, "qty": float(take),
                        "strips": float(take / pk) if pk > 1 else None, "mrp": float(mrp), "gross": float(gross),
                        "discount_percent": round(pct, 2), "max_discount_percent": round(max_d, 2), "discount": float(disc),
                        "gst_percent": float(gst_pct), "hsn": it.get("hsn"), "taxable": float(taxable), "gst": float(amount - taxable),
                        "amount": float(amount), "margin_percent": round(margin, 1) if margin is not None else None,
                        "rule": rule.get("name") if rule else None, "uom": it.get("uom"), "high_alert": bool(it.get("high_alert"))})
    gross = sum((_d(x["gross"]) for x in out), ZERO)
    disc = sum((_d(x["discount"]) for x in out), ZERO)
    taxable = sum((_d(x["taxable"]) for x in out), ZERO)
    gst = sum((_d(x["gst"]) for x in out), ZERO)
    exact = gross - disc
    net = exact.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    cgst = money(gst / 2)
    gst_slabs: dict[str, dict] = {}
    for x in out:
        s = gst_slabs.setdefault(f"{x['gst_percent']:g}", {"gst_percent": x["gst_percent"], "taxable": ZERO, "gst": ZERO})
        s["taxable"] += _d(x["taxable"])
        s["gst"] += _d(x["gst"])
    return {"lines": out, "problems": problems,
            "totals": {"gross": _f(gross), "discount": _f(disc), "taxable": _f(taxable), "cgst": _f(cgst), "sgst": _f(gst - cgst),
                       "gst": _f(gst), "round_off": _f(net - exact), "net": _f(net), "items": len({x["item_id"] for x in out}),
                       "slabs": [{"gst_percent": v["gst_percent"], "taxable": _f(v["taxable"]), "cgst": _f(v["gst"] / 2),
                                  "sgst": _f(v["gst"] - money(v["gst"] / 2))} for v in gst_slabs.values()]}}


class PaymentIn(BaseModel):
    mode: Literal["CASH", "CARD", "UPI", "WALLET", "CHEQUE", "BANK"]
    amount: float = Field(gt=0, le=10_000_000)
    reference: str | None = Field(default=None, max_length=60)


class BillIn(BaseModel):
    draft: bool = False
    draft_id: str | None = None
    patient_id: str | None = None
    customer_name: str | None = Field(default=None, max_length=120)
    customer_phone: str | None = Field(default=None, max_length=20)
    doctor_name: str | None = Field(default=None, max_length=120)
    prescription_id: str | None = None
    sale_type: Literal["Walk-in (OTC)", "Prescription", "Credit"] = "Walk-in (OTC)"
    credit_org: str | None = None
    items: list[LineIn] = Field(min_length=1, max_length=80)
    payments: list[PaymentIn] = Field(default_factory=list, max_length=6)
    override_reason: str | None = Field(default=None, max_length=1000)
    counselled: bool = False
    notes: str | None = Field(default=None, max_length=1000)


async def _context(ctx, body: BillIn) -> tuple[dict | None, dict | None, dict | None]:
    patient = await patient_or_404(ctx, body.patient_id) if body.patient_id else None
    rx = None
    if body.prescription_id:
        rx = await _prescription(ctx, body.prescription_id, body.patient_id)
        if not patient:
            patient = await patient_or_404(ctx, rx["patient_id"])
    org = await _org(ctx, body.credit_org) if body.sale_type == "Credit" else None
    if body.sale_type == "Credit":
        if not org:
            raise bad_request("Choose the credit organisation", {"fields": {"credit_org": "Required"}})
        if not patient:
            raise bad_request("A credit sale needs the registered patient (employee / beneficiary)", {"fields": {"patient_id": "Required"}})
    if body.sale_type == "Prescription" and not (rx or (body.doctor_name or "").strip()):
        raise bad_request("Choose the hospital prescription or enter the prescriber's name", {"fields": {"doctor_name": "Required"}})
    return patient, rx, org


async def _alerts(ctx, body: BillIn, priced: dict, patient: dict | None, rx: dict | None) -> list[dict]:
    """Drug-safety alerts: the pharmacy engine's checks for a registered patient; schedule rules for walk-ins."""
    lines = [{"item_id": x["item_id"], "qty": x["qty"], "batch": x["batch"]} for x in priced["lines"]]
    if not lines:
        return []
    doctor = (body.doctor_name or "").strip()
    items = await items_by_id(ctx, [x["item_id"] for x in lines])
    if patient:
        res = await safety_check(ctx, patient_id=patient["id"], lines=lines, purpose="dispense", store=STORE, prescription=rx)
        alerts = [a for a in res["alerts"] if a["type"] != "stock"]  # stock is checked batch-wise by pricing
        if rx:
            rx_items = await items_by_id(ctx, [ln.get("drug") for ln in rx.get("items") or []])
            rx_lines = _rx_lines(rx, (await dispensed_by_rx(ctx, [rx["id"]])).get(rx["id"], {}), rx_items)
            alerts += _rx_quantity_alerts(lines, rx, rx_lines, items)
        elif doctor:  # outside prescription recorded at the counter covers Schedule H (not H1 / X / narcotics)
            alerts = [{**a, "severity": "Minor", "message": f"{a['item']}: outside prescription by {doctor} recorded."}
                      if a["type"] == "schedule" and (items.get(a["item_id"]) or {}).get("schedule") == "H" else a for a in alerts]
        return alerts
    out = []
    for iid, it in items.items():
        sched, name = it.get("schedule") or "None", item_label(it)
        if sched in CONTROLLED:
            out.append({"type": "controlled", "label": ALERT_TYPE_LABEL["controlled"], "severity": "Contraindicated", "item_id": iid, "item": name,
                        "with": None, "blocking": True,
                        "message": f"{SCHEDULE_LABEL[sched]} drug {name} needs a registered patient and a valid hospital prescription."})
        elif sched == "H" and not doctor:
            out.append({"type": "schedule", "label": "Prescription-only (Schedule H)", "severity": "Major", "item_id": iid, "item": name, "with": None,
                        "blocking": True, "message": f"{name} is a Schedule H (prescription-only) drug — enter the prescriber's name."})
        elif it.get("high_alert"):
            out.append({"type": "high_alert", "label": ALERT_TYPE_LABEL["high_alert"], "severity": "Moderate", "item_id": iid, "item": name,
                        "with": None, "blocking": False, "message": f"{name} is a high-alert medication — counsel the patient."})
    return out


@router.post("/quote")
async def quote(body: BillIn, ctx: CtxDep):
    """Live bill preview: FEFO batches, discounts, GST, totals, co-pay and safety alerts. Nothing is written."""
    _sell(ctx)
    patient, rx, org = await _context(ctx, body)
    priced = await price(ctx, body.items, sale_type=body.sale_type, org=org)
    alerts = await _alerts(ctx, body, priced, patient, rx)
    net = _d(priced["totals"]["net"])
    copay = money(net * _d(org.get("copay_percent")) / 100) if org else net
    return {**priced, "alerts": alerts, "copay": _f(copay), "org_payable": _f(net - copay) if org else 0,
            "blocking": [a for a in alerts if a.get("blocking")] + [p for p in priced["problems"] if p["blocking"]],
            "requires_override": any(a["severity"] in SEVERE and not a.get("blocking") for a in alerts),
            "prescription": _rx_summary(rx) if rx else None}


def _rx_summary(rx: dict) -> dict:
    return {"id": rx["id"], "code": rx.get("code"), "status": rx.get("status"), "valid_till": rx.get("valid_till"),
            "items": [{"item_id": ln.get("drug"), "qty": ln.get("qty"), "dose": ln.get("dose"), "frequency": ln.get("frequency"),
                       "duration_days": ln.get("duration_days")} for ln in rx.get("items") or [] if ln.get("drug")]}


# ================================================================== bills

def _bill_lines(priced: dict) -> list[dict]:
    return [{"item": x["item_id"], "batch": x["batch"], "expiry": x["expiry"], "unit": x["unit"], "pack_size": x["pack_size"],
             "qty": x["qty"], "mrp": x["mrp"], "discount_percent": x["discount_percent"], "discount": x["discount"],
             "gst_percent": x["gst_percent"], "hsn": x["hsn"], "taxable": x["taxable"], "gst": x["gst"], "amount": x["amount"]}
            for x in priced["lines"]]


async def _receipt(ctx, bill: dict, *, kind: str, mode: str, amount: Decimal, shift: dict, reference: str | None = None,
                   ret: str | None = None) -> dict:
    return await create(ctx, RECEIPTS, {
        "patient_id": bill.get("patient_id"), "bill": bill["id"], "kind": kind, "mode": mode, "amount": _f(amount),
        "reference": reference, "shift": shift["id"], "counter_return": ret, "received_by": ctx.user.get("name"),
        "received_by_user": ctx.user_id, "received_at": _stamp(), "status": "Success",
    })


def _check_payments(payments: list[PaymentIn]) -> Decimal:
    for p in payments:
        if p.mode in NON_CASH_REF and not (p.reference or "").strip():
            raise bad_request(f"Enter the {p.mode} transaction / cheque reference")
    return sum((_d(p.amount) for p in payments), ZERO)


@router.post("/bills", status_code=201)
async def create_bill(body: BillIn, ctx: CtxDep):
    _sell(ctx)
    draft = None
    if body.draft_id:
        draft = await get(ctx, BILLS, body.draft_id)
        if not draft or draft.get("status") != "Draft":
            raise conflict("That draft has already been billed or discarded")
    patient, rx, org = await _context(ctx, body)
    prescriber = (body.doctor_name or "").strip() or None
    if not prescriber and rx and is_uuid(rx.get("doctor")):
        prescriber = (await ctx.conn.execute(sa.select(employees.c.name).where(employees.c.id == rx["doctor"]))).scalar_one_or_none()
    customer = (body.customer_name or "").strip() or ((patient or {}).get("title")) or "Walk-in customer"
    phone = (body.customer_phone or "").strip() or (patient or {}).get("phone")
    common = {"patient_id": (patient or {}).get("id"), "customer_name": customer, "customer_phone": phone or None,
              "doctor_name": prescriber,
              "prescription": (rx or {}).get("id"), "sale_type": body.sale_type, "credit_org": (org or {}).get("id"),
              "payer": "Credit organisation" if org else "Self", "notes": (body.notes or "").strip() or None}

    if body.draft:  # park the bill: no stock, no money
        priced = await price(ctx, body.items, sale_type=body.sale_type, org=org)
        data = {**common, "items": [{"item": ln.item_id, "batch": ln.batch, "unit": ln.unit, "pack_size": ln.pack_size, "qty": ln.qty,
                                     "discount_percent": ln.discount_percent} for ln in body.items],
                **{k: priced["totals"][k] for k in ("gross", "discount", "taxable", "cgst", "sgst", "round_off", "net")},
                "paid": 0, "due": 0, "billed_at": _stamp(), "billed_by": ctx.user.get("name"), "status": "Draft"}
        rec = await (update(ctx, BILLS, draft["id"], data) if draft else create(ctx, BILLS, data))
        return {"bill": rec, "draft": True}

    shift = await _need_shift(ctx)
    priced = await price(ctx, body.items, sale_type=body.sale_type, org=org)
    blocking = [p for p in priced["problems"] if p["blocking"]]
    if blocking:
        raise ApiError(409, blocking[0]["message"], {"problems": priced["problems"]}, code="BILL_BLOCKED")
    alerts = await _alerts(ctx, body, priced, patient, rx)
    if [a for a in alerts if a.get("blocking")]:
        raise ApiError(409, next(a for a in alerts if a.get("blocking"))["message"], {"alerts": alerts}, code="DISPENSE_BLOCKED")
    severe = [a for a in alerts if a["severity"] in SEVERE]
    reason = (body.override_reason or "").strip()
    if severe and len(reason) < 5:
        raise ApiError(409, f"{len(severe)} serious alert(s) need an override reason before billing", {"alerts": alerts},
                       code="OVERRIDE_REQUIRED")

    t = priced["totals"]
    net = _d(t["net"])
    paid = _check_payments(body.payments)
    if paid > net + Decimal("0.01"):
        raise bad_request(f"Payments (₹{paid}) exceed the bill amount (₹{net})")
    due = net - paid
    if org:
        copay = money(net * _d(org.get("copay_percent")) / 100)
        if paid + Decimal("0.01") < copay:
            raise bad_request(f"Collect the patient's co-pay of ₹{copay} ({org.get('copay_percent')}%) — the rest is billed to {org.get('name')}")
        limit = org.get("credit_limit")
        if limit not in (None, "") and due > 0:
            outstanding = await _org_outstanding(ctx, org["id"], exclude=(draft or {}).get("id"))
            if outstanding + due > _d(limit):
                raise ApiError(409, f"{org.get('name')} credit limit ₹{_d(limit):,.0f} exceeded (outstanding ₹{outstanding:,.0f})",
                               code="CREDIT_LIMIT")
    elif due > Decimal("0.01") and not (patient or phone):
        raise bad_request("Collect the full amount, or record the patient / mobile number to keep the balance as due")

    ent = E(BILLS)
    bid = (draft or {}).get("id") or new_id()
    code = (draft or {}).get("code") or await next_code(ctx.conn, ent.prefix, ent.code_digits, ent.code_sep)
    did = new_id()
    dcode = await next_code(ctx.conn, E(DISPENSE).prefix, E(DISPENSE).code_digits, E(DISPENSE).code_sep)
    items = await items_by_id(ctx, [x["item_id"] for x in priced["lines"]])
    disp_lines, register = [], []
    pid = (patient or {}).get("id")
    for x in priced["lines"]:
        allocs = await stock_out(ctx, item_id=x["item_id"], store=STORE, qty=x["qty"], batch=x["batch"], kind="DISPENSE", ref=code,
                                 ref_fqn=BILLS, ref_id=bid, patient_id=pid, extra={"counter_bill": code})
        unit_net = _d(x["amount"]) / _d(x["qty"])
        for a in allocs:
            disp_lines.append({"item": x["item_id"], "batch": a["batch"], "expiry": a["expiry"], "qty": a["qty"],
                               "rate": _f(unit_net), "amount": _f(unit_net * _d(a["qty"]))})
            it = items.get(x["item_id"]) or {}
            if it.get("schedule") in CONTROLLED:
                register.append({"register": REGISTER[it["schedule"]], "item": x["item_id"], "drug": item_label(it), "batch": a["batch"],
                                 "qty": a["qty"], "balance_after": a["balance"], "patient": (patient or {}).get("title"),
                                 "uhid": (patient or {}).get("code"), "prescription": (rx or {}).get("code"), "prescriber": common["doctor_name"],
                                 "dispensed_by": ctx.user.get("name"), "at": _stamp()})
    disp = await create(ctx, DISPENSE, {
        "id": did, "code": dcode, "patient_id": pid, "prescription": (rx or {}).get("id"), "store": STORE, "items": disp_lines,
        "total": _f(net), "pharmacist": ctx.user.get("employee_id"), "dispensed_at": _stamp(), "counselled": body.counselled,
        "status": "Dispensed", "alerts_overridden": _override_text(severe, reason), "controlled_register": bool(register),
        "register_entries": register or None, "counter_bill": bid, "customer_name": customer,
    })
    data = {**common, "items": _bill_lines(priced), **{k: t[k] for k in ("gross", "discount", "taxable", "cgst", "sgst", "round_off", "net")},
            "gst_slabs": t["slabs"], "paid": _f(paid), "due": _f(due), "returned_amount": 0,
            "payments": [{"mode": p.mode, "amount": p.amount, "reference": (p.reference or "").strip() or None} for p in body.payments],
            "counter": shift.get("counter"), "shift": shift["id"], "dispense": did, "billed_at": _stamp(), "billed_by": ctx.user.get("name"),
            "billed_by_user": ctx.user_id, "status": "Due" if due > Decimal("0.01") else "Paid", "counselled": body.counselled,
            "alerts_overridden": _override_text(severe, reason)}
    bill = await (update(ctx, BILLS, bid, data) if draft else create(ctx, BILLS, {"id": bid, "code": code, **data}))
    for p in body.payments:
        await _receipt(ctx, bill, kind="Sale", mode=p.mode, amount=_d(p.amount), shift=shift, reference=(p.reference or "").strip() or None)
    if rx:
        await _refresh_rx_status(ctx, rx)
    if severe:
        await audit(ctx, "pharmacy.override", module="pharmacy", entity="counter_bills", record=bill, note=reason,
                    after={"alerts": [{k: a.get(k) for k in ("type", "severity", "item", "with", "message")} for a in severe]})
        if pid:
            for a in severe:
                await create(ctx, INTERVENTION, {
                    "patient_id": pid, "prescription": (rx or {}).get("id"),
                    "alert_type": ALERT_TYPE_LABEL.get(a["type"], "Drug–drug interaction"), "severity": a["severity"], "drug": a["item_id"],
                    "interacting_with": a.get("with"), "message": a["message"], "override_reason": reason[:1000],
                    "resolved_by": ctx.user.get("employee_id"), "resolved_at": _stamp(), "dispense": disp["id"], "status": "Overridden"})
    return {"bill": await _bill_view(ctx, bill), "alerts": alerts, "change_due": 0}


async def _bill_or_404(ctx, bid: str) -> dict:
    b = await get(ctx, BILLS, bid)
    if not b:
        raise not_found("Pharmacy bill not found")
    return b


async def _returned(ctx, bill_id: str, statuses=("Requested", "Approved"), exclude: str | None = None) -> dict[tuple, Decimal]:
    out: dict[tuple, Decimal] = defaultdict(Decimal)
    for r in await find(ctx, RETURNS, bill=bill_id, status=list(statuses), limit=200):
        if r["id"] == exclude:
            continue
        for ln in r.get("items") or []:
            out[(ln.get("item"), ln.get("batch"))] += _d(ln.get("qty"))
    return out


async def _bill_view(ctx, b: dict) -> dict:
    refs = await rs.resolve_refs(ctx, E(BILLS), [b])
    items = await items_by_id(ctx, [ln.get("item") for ln in b.get("items") or []])
    returned = await _returned(ctx, b["id"]) if b.get("status") != "Draft" else {}
    lines = []
    for ln in b.get("items") or []:
        it = items.get(ln.get("item")) or {}
        k = (ln.get("item"), ln.get("batch"))
        done = min(returned.get(k, ZERO), _d(ln.get("qty")))
        returned[k] = returned.get(k, ZERO) - done
        lines.append({**ln, "name": item_label(it), "generic": it.get("generic_name"), "schedule": it.get("schedule"), "uom": it.get("uom"),
                      "returned": float(done), "returnable": float(_d(ln.get("qty")) - done)})
    org = await get(ctx, ORGS, b["credit_org"]) if b.get("credit_org") else None
    return {**{k: v for k, v in b.items() if k != "items"}, "lines": lines, "patient": refs.get(b.get("patient_id") or ""),
            "credit_org_name": (org or {}).get("name"), "prescription_code": refs.get(b.get("prescription") or ""),
            "age_days": (today() - parse_dt(b["billed_at"]).date()).days if b.get("billed_at") else None}


@router.get("/bills/{bid}")
async def bill_detail(bid: str, ctx: CtxDep):
    _reports(ctx)
    b = await _bill_or_404(ctx, bid)
    view = await _bill_view(ctx, b)
    view["receipts"] = [{k: r.get(k) for k in ("id", "code", "kind", "mode", "amount", "reference", "received_by", "received_at")}
                        for r in await find(ctx, RECEIPTS, bill=bid, sort="received_at", limit=100)]
    view["returns"] = [{k: r.get(k) for k in ("id", "code", "status", "reason", "refund_amount", "adjusted_to_due", "requested_at",
                                              "requested_by", "approved_by")} for r in await find(ctx, RETURNS, bill=bid, limit=50)]
    return view


@router.get("/bills")
async def bills(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None, status: str | None = None,
                sale_type: str | None = None, payer: str | None = None, user: str | None = None, q: str | None = None, limit: int = 300):
    """Bills report (and the drafts / due lists) with totals."""
    _reports(ctx)
    d1 = date_from or today().isoformat()
    d2 = date_to or d1
    filters: dict[str, Any] = {}
    if sale_type:
        filters["sale_type"] = sale_type
    if payer:
        filters["payer"] = payer
    rows = await find(ctx, BILLS, status=[s for s in (status or "").split(",") if s] or None, date_from=None if status == "Draft" else d1,
                      date_to=None if status == "Draft" else d2, q=q or None, sort="-billed_at", limit=max(1, min(limit, 2000)), **filters)
    if user:
        rows = [r for r in rows if r.get("billed_by") == user]
    refs = rows[0]["_refs"] if rows else {}
    orgs = {o["id"]: o.get("name") for o in await find(ctx, ORGS, limit=500)}
    out = [{k: r.get(k) for k in ("id", "code", "status", "patient_id", "customer_name", "customer_phone", "sale_type", "payer", "gross",
                                  "discount", "taxable", "cgst", "sgst", "net", "paid", "due", "returned_amount", "billed_at", "billed_by",
                                  "counter", "doctor_name")}
           | {"patient": refs.get(r.get("patient_id") or ""), "credit_org": orgs.get(r.get("credit_org") or ""), "items": len(r.get("items") or [])}
           for r in rows]
    live = [r for r in out if r["status"] in ("Paid", "Due")]
    total = {k: _f(sum((_d(r.get(k)) for r in live), ZERO)) for k in ("gross", "discount", "taxable", "cgst", "sgst", "net", "paid", "due",
                                                                       "returned_amount")}
    by_day: dict[str, dict] = {}
    for r in live:
        day = str(r["billed_at"] or "")[:10]
        g = by_day.setdefault(day, {"date": day, "bills": 0, "net": ZERO, "paid": ZERO, "due": ZERO})
        g["bills"] += 1
        for k in ("net", "paid", "due"):
            g[k] += _d(r.get(k))
    return {"rows": out, "totals": {**total, "bills": len(live), "cancelled": sum(1 for r in out if r["status"] == "Cancelled"),
                                     "drafts": sum(1 for r in out if r["status"] == "Draft")},
            "by_day": [{**g, "net": _f(g["net"]), "paid": _f(g["paid"]), "due": _f(g["due"])} for g in sorted(by_day.values(), key=lambda g: g["date"])],
            "users": sorted({r["billed_by"] for r in out if r.get("billed_by")}), "from": d1, "to": d2}


class CollectIn(BaseModel):
    payments: list[PaymentIn] = Field(min_length=1, max_length=6)


@router.post("/bills/{bid}/collect")
async def collect_due(bid: str, body: CollectIn, ctx: CtxDep):
    _sell(ctx)
    shift = await _need_shift(ctx)
    b = await _bill_or_404(ctx, bid)
    if b.get("status") != "Due":
        raise conflict(f"{b['code']} has no balance due ({b.get('status')})")
    amt = _check_payments(body.payments)
    due = _d(b.get("due"))
    if amt > due + Decimal("0.01"):
        raise bad_request(f"Amount exceeds the balance of ₹{due}")
    for p in body.payments:
        await _receipt(ctx, b, kind="Due collection", mode=p.mode, amount=_d(p.amount), shift=shift, reference=(p.reference or "").strip() or None)
    left = due - amt
    rec = await update(ctx, BILLS, bid, {
        "paid": _f(_d(b.get("paid")) + amt), "due": _f(max(left, ZERO)), "status": "Due" if left > Decimal("0.01") else "Paid",
        "payments": [*(b.get("payments") or []), *({"mode": p.mode, "amount": p.amount, "reference": p.reference} for p in body.payments)],
        "last_collection_at": _stamp()})
    return {"bill": await _bill_view(ctx, rec), "collected": _f(amt)}


class ReasonIn(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


@router.post("/bills/{bid}/discard")
async def discard_draft(bid: str, ctx: CtxDep):
    _sell(ctx)
    b = await _bill_or_404(ctx, bid)
    if b.get("status") != "Draft":
        raise conflict(f"{b['code']} is not a draft")
    rec = await update(ctx, BILLS, bid, {"status": "Cancelled", "cancel_reason": "Draft discarded"})
    return {"id": rec["id"], "status": rec["status"]}


@router.post("/bills/{bid}/cancel")
async def cancel_bill(bid: str, body: ReasonIn, ctx: CtxDep):
    """Same-day cancellation of a wrong bill: every batch goes back to stock and what was paid is refunded
    in the same modes. Older bills, or bills with returns, use the return workflow."""
    _sell(ctx)
    shift = await _need_shift(ctx)
    b = await _bill_or_404(ctx, bid)
    if b.get("status") not in ("Paid", "Due"):
        raise conflict(f"{b['code']} is {b.get('status')}")
    if parse_dt(b["billed_at"]).date() != today():
        raise conflict("Only today's bills can be cancelled — use a return for older bills")
    if await find(ctx, RETURNS, bill=bid, status=["Requested", "Approved"], limit=1):
        raise conflict("This bill has returns — cancel is not possible; return the remaining items instead")
    for ln in b.get("items") or []:
        await stock_in(ctx, item_id=ln["item"], store=STORE, qty=ln["qty"], batch=ln.get("batch"), expiry=ln.get("expiry"), mrp=ln.get("mrp"),
                       kind="RETURN", ref=b["code"], ref_fqn=BILLS, ref_id=bid, patient_id=b.get("patient_id"), extra={"reason": "Bill cancelled"})
    paid_by_mode: dict[str, Decimal] = defaultdict(Decimal)
    for r in await find(ctx, RECEIPTS, bill=bid, limit=100):
        paid_by_mode[r["mode"]] += _d(r.get("amount"))
    for mode, amt in paid_by_mode.items():
        if amt > 0:
            await _receipt(ctx, b, kind="Refund", mode=mode, amount=-amt, shift=shift, reference=f"Cancel {b['code']}")
    rec = await update(ctx, BILLS, bid, {"status": "Cancelled", "cancel_reason": body.reason.strip(), "due": 0,
                                         "cancelled_by": ctx.user.get("name"), "cancelled_at": _stamp()})
    if b.get("dispense"):
        await update(ctx, DISPENSE, b["dispense"], {"status": "Cancelled"})
    await audit(ctx, "pharmacy.bill_cancel", module="pharmacy", entity="counter_bills", record=rec, note=body.reason.strip(),
                after={"refunded": {m: _f(a) for m, a in paid_by_mode.items()}})
    return {"id": bid, "status": rec["status"], "refunded": _f(sum(paid_by_mode.values(), ZERO))}


# ================================================================== returns (request → approve: restock + refund / due adjustment)

class ReturnLine(BaseModel):
    item_id: str
    batch: str | None = None
    qty: float = Field(gt=0, le=100000)


class ReturnIn(BaseModel):
    bill_id: str
    items: list[ReturnLine] = Field(min_length=1, max_length=80)
    reason: Literal["Doctor changed the prescription", "Excess purchased", "Adverse drug reaction", "Wrong item billed", "Patient expired", "Other"]
    refund_mode: Literal["CASH", "CARD", "UPI", "WALLET", "CHEQUE", "BANK"] = "CASH"
    notes: str | None = Field(default=None, max_length=500)


async def _match(ctx, b: dict, lines: list[dict], exclude: str | None) -> list[dict]:
    already = await _returned(ctx, b["id"], exclude=exclude)
    pool = []
    for ln in b.get("items") or []:
        k = (ln.get("item"), ln.get("batch"))
        done = min(already.get(k, ZERO), _d(ln.get("qty")))
        already[k] = already.get(k, ZERO) - done
        pool.append({**ln, "left": _d(ln.get("qty")) - done, "unit_net": _d(ln.get("amount")) / _d(ln.get("qty")) if _d(ln.get("qty")) else ZERO})
    items = await items_by_id(ctx, [ln["item_id"] for ln in lines])
    out = []
    for i, ln in enumerate(lines, 1):
        name = item_label(items.get(ln["item_id"]))
        q = _d(ln["qty"])
        if q != q.to_integral_value():
            raise bad_request(f"Line {i}: return whole units of {name}")
        cands = [p for p in pool if p.get("item") == ln["item_id"] and (not ln.get("batch") or p.get("batch") == ln["batch"])]
        if not cands:
            raise bad_request(f"Line {i}: {name} was not sold on {b['code']}")
        need = q
        for p in cands:
            take = min(p["left"], need)
            if take <= 0:
                continue
            if p.get("expiry") and parse_date(p["expiry"]) < today():
                raise conflict(f"{name} batch {p.get('batch')} has expired — it cannot be taken back into saleable stock")
            p["left"] -= take
            need -= take
            out.append({"item": ln["item_id"], "batch": p.get("batch"), "expiry": p.get("expiry"), "qty": float(take),
                        "rate": _f(p["unit_net"]), "amount": _f(p["unit_net"] * take)})
        if need > 0:
            raise conflict(f"Line {i}: only {(q - need).normalize():f} of {name} can still be returned against {b['code']}")
    return out


@router.post("/returns", status_code=201)
async def request_return(body: ReturnIn, ctx: CtxDep):
    _sell(ctx)
    b = await _bill_or_404(ctx, body.bill_id)
    if b.get("status") not in ("Paid", "Due"):
        raise conflict(f"{b['code']} is {b.get('status')} — returns are taken only against billed sales")
    age = (today() - parse_dt(b["billed_at"]).date()).days
    if age > RETURN_DAYS:
        raise conflict(f"{b['code']} is {age} days old — returns are accepted within {RETURN_DAYS} days")
    lines = await _match(ctx, b, [ln.model_dump() for ln in body.items], None)
    total = sum((_d(x["amount"]) for x in lines), ZERO)
    rec = await create(ctx, RETURNS, {
        "patient_id": b.get("patient_id"), "bill": b["id"], "items": lines, "reason": body.reason, "refund_mode": body.refund_mode,
        "refund_amount": _f(total), "requested_by": ctx.user.get("name"), "requested_by_user": ctx.user_id, "requested_at": _stamp(),
        "notes": (body.notes or "").strip() or None, "bill_code": b["code"], "customer_name": b.get("customer_name"), "status": "Requested"})
    return {"return": rec}


@router.get("/returns")
async def returns(ctx: CtxDep, status: str | None = "Requested", date_from: str | None = None, date_to: str | None = None):
    _reports(ctx)
    rows = await find(ctx, RETURNS, status=[s for s in (status or "").split(",") if s] or None, date_from=date_from, date_to=date_to,
                      sort="-requested_at", limit=300)
    items = await items_by_id(ctx, [ln.get("item") for r in rows for ln in r.get("items") or []])
    return {"rows": [{**{k: r.get(k) for k in ("id", "code", "status", "bill", "bill_code", "customer_name", "patient_id", "reason", "refund_mode",
                                               "refund_amount", "adjusted_to_due", "requested_by", "requested_at", "approved_by", "approved_at",
                                               "rejection_reason", "notes")},
                      "patient": (r.get("_refs") or {}).get(r.get("patient_id") or ""),
                      "lines": [{**ln, "name": item_label(items.get(ln.get("item")))} for ln in r.get("items") or []]} for r in rows]}


@router.post("/returns/{rid}/approve")
async def approve_return(rid: str, ctx: CtxDep):
    """Restock batch-wise, then settle: the bill's balance due is reduced first, the rest is refunded in the chosen mode."""
    _sell(ctx)
    shift = await _need_shift(ctx)
    r = await get(ctx, RETURNS, rid)
    if not r:
        raise not_found("Return not found")
    if r.get("status") != "Requested":
        raise conflict(f"{r['code']} is already {r.get('status')}")
    b = await _bill_or_404(ctx, r["bill"])
    if b.get("status") not in ("Paid", "Due"):
        raise conflict(f"{b['code']} is {b.get('status')}")
    lines = await _match(ctx, b, [{"item_id": ln["item"], "batch": ln.get("batch"), "qty": ln["qty"]} for ln in r.get("items") or []], rid)
    for ln in lines:
        await stock_in(ctx, item_id=ln["item"], store=STORE, qty=ln["qty"], batch=ln.get("batch"), expiry=ln.get("expiry"), kind="RETURN",
                       ref=r["code"], ref_fqn=RETURNS, ref_id=rid, patient_id=b.get("patient_id"), extra={"bill": b["code"]})
    total = sum((_d(x["amount"]) for x in lines), ZERO)
    due = _d(b.get("due"))
    adjust = min(due, total)
    refund = total - adjust
    if refund > 0:
        await _receipt(ctx, b, kind="Refund", mode=r.get("refund_mode") or "CASH", amount=-refund, shift=shift, reference=f"Return {r['code']}", ret=rid)
    returned = _d(b.get("returned_amount")) + total
    patch = {"returned_amount": _f(returned), "due": _f(due - adjust), "refunded_amount": _f(_d(b.get("refunded_amount")) + refund),
             "return_status": "Returned" if returned >= _d(b.get("net")) - Decimal("0.5") else "Partially Returned"}
    if due > 0 and due - adjust <= Decimal("0.01"):
        patch["status"] = "Paid"
    await update(ctx, BILLS, b["id"], patch)
    rec = await update(ctx, RETURNS, rid, {"status": "Approved", "items": lines, "refund_amount": _f(refund), "adjusted_to_due": _f(adjust),
                                           "approved_by": ctx.user.get("name"), "approved_at": _stamp()})
    if b.get("dispense"):
        disp = await get(ctx, DISPENSE, b["dispense"])
        if disp:
            await update(ctx, DISPENSE, disp["id"], {"status": patch["return_status"]})
    await audit(ctx, "pharmacy.return_approve", module="pharmacy", entity="counter_returns", record=rec,
                after={"refund": _f(refund), "adjusted_to_due": _f(adjust), "mode": r.get("refund_mode")})
    return {"return": rec, "refund": _f(refund), "adjusted_to_due": _f(adjust)}


@router.post("/returns/{rid}/reject")
async def reject_return(rid: str, body: ReasonIn, ctx: CtxDep):
    _sell(ctx)
    r = await get(ctx, RETURNS, rid)
    if not r:
        raise not_found("Return not found")
    if r.get("status") != "Requested":
        raise conflict(f"{r['code']} is already {r.get('status')}")
    rec = await update(ctx, RETURNS, rid, {"status": "Rejected", "rejection_reason": body.reason.strip(), "approved_by": ctx.user.get("name"),
                                           "approved_at": _stamp()})
    return {"return": rec}


# ================================================================== shifts

async def shift_summary(ctx, shift: dict) -> dict:
    receipts = await find(ctx, RECEIPTS, shift=shift["id"], limit=10000)
    modes: dict[str, dict[str, Decimal]] = {}
    for r in receipts:
        m = modes.setdefault(r["mode"], {"sales": ZERO, "due_collections": ZERO, "refunds": ZERO})
        key = {"Sale": "sales", "Due collection": "due_collections", "Refund": "refunds"}.get(r.get("kind"), "sales")
        m[key] += _d(r.get("amount"))
    collections = [{"mode": k, **{kk: _f(vv) for kk, vv in v.items()}, "net": _f(sum(v.values(), ZERO))} for k, v in sorted(modes.items())]
    cash = sum((sum(v.values(), ZERO) for k, v in modes.items() if k == "CASH"), ZERO)
    ent = E(BILLS)
    t = ent.table
    stats = (await ctx.conn.execute(sa.select(t.c.status, sa.func.count(), sa.func.coalesce(sa.func.sum(sa.cast(t.c.data["net"].astext, sa.Numeric)), 0))
                                    .where(*rs.base_where(ent), t.c.data["shift"].astext == shift["id"]).group_by(t.c.status))).all()
    by_status = {s: {"count": n, "net": float(v)} for s, n, v in stats}
    return {"collections": collections, "cash_net": _f(cash), "expected_cash": _f(_d(shift.get("opening_cash")) + cash),
            "total": _f(sum((sum(v.values(), ZERO) for v in modes.values()), ZERO)),
            "refunds": _f(sum((v["refunds"] for v in modes.values()), ZERO)),
            "bills": sum(v["count"] for k, v in by_status.items() if k in ("Paid", "Due", "Cancelled")),
            "sales": round(sum(v["net"] for k, v in by_status.items() if k in ("Paid", "Due")), 2),
            "cancelled": by_status.get("Cancelled", {}).get("count", 0), "due_bills": by_status.get("Due", {}).get("count", 0),
            "receipts": len(receipts)}


async def _shift_view(ctx, s: dict) -> dict:
    return {**{k: s.get(k) for k in ("id", "code", "status", "counter", "user_name", "opened_at", "opening_cash", "closed_at", "expected_cash",
                                     "cash_counted", "variance", "denominations", "remarks")},
            "summary": await shift_summary(ctx, s) if s.get("status") == "Open" else
            {"collections": s.get("collections") or [], "expected_cash": s.get("expected_cash"), "bills": s.get("bills_count"),
             "total": s.get("total_collected"), "sales": s.get("sales"), "refunds": s.get("refunds")},
            "mine": s.get("user_id")}


@router.get("/shift")
async def shift_state(ctx: CtxDep):
    rs.ensure_access(ctx, E(SHIFTS), "read")
    cur = await current_shift(ctx)
    recent = await find(ctx, SHIFTS, sort="-opened_at", limit=20)
    open_counters = {s.get("counter"): s.get("user_name") for s in recent if s.get("status") == "Open"}
    return {"current": await _shift_view(ctx, cur) if cur else None, "open_counters": open_counters, "counters": COUNTERS,
            "recent": [await _shift_view(ctx, s) for s in recent[:12]]}


class OpenIn(BaseModel):
    counter: str
    opening_cash: float = Field(ge=0, le=1_000_000)


@router.post("/shift/open", status_code=201)
async def open_shift(body: OpenIn, ctx: CtxDep):
    _sell(ctx)
    if body.counter not in COUNTERS:
        raise bad_request("Choose a counter")
    if await current_shift(ctx):
        raise conflict("You already have an open shift — close it first")
    for s in await find(ctx, SHIFTS, status="Open", limit=50):
        if s.get("counter") == body.counter:
            raise conflict(f"{body.counter} is open by {s.get('user_name')} — close that shift first")
    rec = await create(ctx, SHIFTS, {"counter": body.counter, "user_name": ctx.user.get("name"), "user_id": ctx.user_id,
                                     "opened_at": _stamp(), "opening_cash": body.opening_cash, "status": "Open"})
    return await _shift_view(ctx, rec)


class Denomination(BaseModel):
    note: float = Field(gt=0, le=2000)
    count: int = Field(ge=0, le=100000)


class CloseIn(BaseModel):
    denominations: list[Denomination] = Field(default_factory=list, max_length=20)
    cash_counted: float | None = Field(default=None, ge=0)
    remarks: str | None = Field(default=None, max_length=1000)


@router.post("/shift/close")
async def close_shift(body: CloseIn, ctx: CtxDep):
    _sell(ctx)
    s = await current_shift(ctx)
    if not s:
        raise conflict("You have no open shift")
    summ = await shift_summary(ctx, s)
    dens = [{"note": d.note, "count": d.count, "amount": _f(_d(d.note) * d.count)} for d in body.denominations if d.count]
    counted = sum((_d(d["amount"]) for d in dens), ZERO) if dens else _d(body.cash_counted) if body.cash_counted is not None else None
    if counted is None:
        raise bad_request("Count the cash in the drawer (denominations or total)")
    variance = counted - _d(summ["expected_cash"])
    if abs(variance) >= 1 and len((body.remarks or "").strip()) < 5:
        raise bad_request(f"Cash differs from expected by ₹{variance:,.2f} — explain the variance in remarks")
    drafts = await find(ctx, BILLS, status="Draft", limit=200)
    rec = await update(ctx, SHIFTS, s["id"], {
        "status": "Closed", "closed_at": _stamp(), "expected_cash": summ["expected_cash"], "cash_counted": _f(counted), "variance": _f(variance),
        "denominations": dens, "collections": summ["collections"], "bills_count": summ["bills"], "sales": summ["sales"], "refunds": summ["refunds"],
        "total_collected": summ["total"], "remarks": (body.remarks or "").strip() or None,
        "open_drafts": sum(1 for d in drafts if d.get("billed_by") == ctx.user.get("name"))})
    if abs(variance) >= 1:
        await audit(ctx, "pharmacy.shift_variance", module="pharmacy", entity="shifts", record=rec, note=(body.remarks or "").strip(),
                    after={"expected": summ["expected_cash"], "counted": _f(counted), "variance": _f(variance)})
    return await _shift_view(ctx, rec)


@router.get("/shifts/{sid}")
async def shift_detail(sid: str, ctx: CtxDep):
    _reports(ctx)
    s = await get(ctx, SHIFTS, sid)
    if not s:
        raise not_found("Shift not found")
    view = await _shift_view(ctx, s)
    view["live"] = await shift_summary(ctx, s)
    return view


# ================================================================== reports

def _bucket(days: int) -> str:
    return "0–30" if days <= 30 else "31–60" if days <= 60 else "61–90" if days <= 90 else "90+"


@router.get("/reports/dues")
async def dues(ctx: CtxDep, payer: Literal["all", "self", "credit"] = "all", credit_org: str | None = None, q: str | None = None):
    _reports(ctx)
    rows = await find(ctx, BILLS, status="Due", sort="billed_at", limit=5000, q=q or None)
    orgs = {o["id"]: o for o in await find(ctx, ORGS, limit=500)}
    out, buckets, by_org = [], defaultdict(Decimal), defaultdict(lambda: {"bills": 0, "due": ZERO})
    for r in rows:
        is_credit = bool(r.get("credit_org"))
        if (payer == "self" and is_credit) or (payer == "credit" and not is_credit) or (credit_org and r.get("credit_org") != credit_org):
            continue
        days = (today() - parse_dt(r["billed_at"]).date()).days if r.get("billed_at") else 0
        org = orgs.get(r.get("credit_org") or "")
        terms = int((org or {}).get("credit_days") or 0)
        b = _bucket(days)
        buckets[b] += _d(r.get("due"))
        key = (org or {}).get("name") or "Self-pay (patients)"
        by_org[key]["bills"] += 1
        by_org[key]["due"] += _d(r.get("due"))
        out.append({k: r.get(k) for k in ("id", "code", "customer_name", "customer_phone", "patient_id", "net", "paid", "due", "billed_at",
                                          "billed_by", "sale_type")}
                   | {"patient": (r.get("_refs") or {}).get(r.get("patient_id") or ""), "credit_org": (org or {}).get("name"), "age_days": days,
                      "bucket": b, "overdue": bool(org and terms and days > terms)})
    return {"rows": out, "total": _f(sum((_d(r["due"]) for r in out), ZERO)), "count": len(out),
            "buckets": [{"bucket": k, "due": _f(buckets.get(k, ZERO))} for k in ("0–30", "31–60", "61–90", "90+")],
            "by_payer": sorted(({"payer": k, "bills": v["bills"], "due": _f(v["due"])} for k, v in by_org.items()), key=lambda x: -x["due"])}


@router.get("/reports/collections")
async def user_collections(ctx: CtxDep, date_from: str | None = None, date_to: str | None = None):
    """User-wise collections by payment mode: sales, due collections, refunds and net."""
    _reports(ctx)
    d1 = date_from or today().isoformat()
    d2 = date_to or d1
    rows = await find(ctx, RECEIPTS, date_from=d1, date_to=d2, status="Success", limit=20000)
    users: dict[str, dict] = {}
    modes = set()
    for r in rows:
        u = users.setdefault(r.get("received_by") or "—", {"user": r.get("received_by") or "—", "by_mode": defaultdict(Decimal),
                                                         "sales": ZERO, "due_collections": ZERO, "refunds": ZERO, "receipts": 0, "bills": set()})
        amt = _d(r.get("amount"))
        modes.add(r["mode"])
        u["by_mode"][r["mode"]] += amt
        u[{"Sale": "sales", "Due collection": "due_collections", "Refund": "refunds"}.get(r.get("kind"), "sales")] += amt
        u["receipts"] += 1
        u["bills"].add(r.get("bill"))
    out = [{"user": u["user"], "by_mode": {k: _f(v) for k, v in u["by_mode"].items()}, "sales": _f(u["sales"]),
            "due_collections": _f(u["due_collections"]), "refunds": _f(u["refunds"]),
            "net": _f(u["sales"] + u["due_collections"] + u["refunds"]), "receipts": u["receipts"], "bills": len(u["bills"])}
           for u in users.values()]
    out.sort(key=lambda x: -x["net"])
    totals = {"sales": sum(x["sales"] for x in out), "due_collections": sum(x["due_collections"] for x in out),
              "refunds": sum(x["refunds"] for x in out), "net": sum(x["net"] for x in out)}
    by_mode = defaultdict(float)
    for x in out:
        for k, v in x["by_mode"].items():
            by_mode[k] += v
    return {"rows": out, "modes": sorted(modes), "totals": {k: round(v, 2) for k, v in totals.items()},
            "by_mode": {k: round(v, 2) for k, v in by_mode.items()}, "from": d1, "to": d2}


@router.get("/summary")
async def summary(ctx: CtxDep):
    """Today at the counter (hub tiles)."""
    rs.ensure_access(ctx, E(BILLS), "read")
    t = today().isoformat()
    bills_today = await find(ctx, BILLS, date_from=t, date_to=t, limit=5000)
    live = [b for b in bills_today if b.get("status") in ("Paid", "Due")]
    receipts = await find(ctx, RECEIPTS, date_from=t, date_to=t, status="Success", limit=20000)
    dues_all = await find(ctx, BILLS, status="Due", limit=5000)
    shift = await current_shift(ctx)
    return {"bills": len(live), "sales": _f(sum((_d(b.get("net")) for b in live), ZERO)),
            "collected": _f(sum((_d(r.get("amount")) for r in receipts), ZERO)),
            "refunds": _f(-sum((_d(r.get("amount")) for r in receipts if r.get("kind") == "Refund"), ZERO)),
            "due_bills": len(dues_all), "due_amount": _f(sum((_d(b.get("due")) for b in dues_all), ZERO)),
            "drafts": len(await find(ctx, BILLS, status="Draft", limit=500)),
            "returns_pending": len(await find(ctx, RETURNS, status="Requested", limit=500)),
            "open_shifts": len(await find(ctx, SHIFTS, status="Open", limit=50)),
            "my_shift": {"id": shift["id"], "counter": shift.get("counter"), "opened_at": shift.get("opened_at")} if shift else None}


__all__ = ["router", "price", "pack_size", "current_shift", "shift_summary"]
