"""Billing / revenue cycle: charge capture at the point of service, OP/IP bills from unbilled
charges, discounts with approval, deposits, multi-mode payments, refunds, daily room charges
and discharge billing clearance."""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import emit, hook
from ..core.security import CtxDep
from ..core.util import ApiError, bad_request, conflict, is_uuid, money, not_found, now, to_json_value, today
from ..schema import beds, charges, encounters, invoices, patients, payments, services
from ._common import E, create, find, get, require_role, update
from .workflow import on_decided, request_approval

log = logging.getLogger("vlack.billing")
router = APIRouter(prefix="/api/billing", tags=["billing"])

BILLING_ROLES = ("billing", "front_office")


# ------------------------------------------------------------------ charge capture

async def _service(ctx, service_id: str | None = None, code: str | None = None) -> dict | None:
    t = services
    if service_id and is_uuid(service_id):
        row = (await ctx.conn.execute(sa.select(t).where(t.c.id == service_id))).first()
    elif code:
        row = (await ctx.conn.execute(sa.select(t).where(t.c.code == code, t.c.deleted_at.is_(None)))).first()
    else:
        row = None
    return rs.to_record(row) if row else None


async def post_charge(ctx, *, patient_id: str, encounter_id: str | None = None, service_id: str | None = None,
                      service_code: str | None = None, qty: float = 1, rate: Any = None, description: str | None = None,
                      source: str = "manual", source_id: str | None = None, ref_code: str | None = None,
                      fallback: str | None = None) -> dict:
    svc = await _service(ctx, service_id, service_code)
    unit = Decimal(str(rate)) if rate not in (None, "") else (Decimal(str(svc["rate"])) if svc and svc.get("rate") is not None else Decimal(0))
    qty_d = Decimal(str(qty or 1))
    desc = description or (svc.get("name") or svc.get("title") if svc else None) or fallback or "Charge"
    if ref_code and ref_code not in desc:
        desc = f"{desc} · {ref_code}"
    if unit == 0:
        desc = f"{desc} (unpriced — review tariff)"
        log.warning("unpriced charge %s for %s", service_code or service_id, source)
    if not encounter_id:
        enc = (await ctx.conn.execute(sa.select(encounters.c.id).where(
            encounters.c.patient_id == patient_id, encounters.c.deleted_at.is_(None),
            encounters.c.status.in_(["Admitted", "Discharge Initiated"])).limit(1))).first()
        encounter_id = str(enc.id) if enc else None
    return await create(ctx, "billing.charges", {
        "patient_id": patient_id, "encounter_id": encounter_id, "service_id": svc["id"] if svc else None,
        "description": desc[:300], "qty": float(qty_d), "rate": float(unit), "amount": float(money(unit * qty_d)),
        "discount": 0, "source": source, "source_id": source_id, "charged_at": now().isoformat(),
        "tax_percent": float(svc.get("tax_percent") or 0) if svc else 0, "status": "Unbilled",
    })


@hook("charge", "capture")
async def _capture(ctx, payload: dict):
    await post_charge(ctx, patient_id=payload["patient_id"], encounter_id=payload.get("encounter_id"),
                      service_id=payload.get("service_id"), service_code=payload.get("service_code"),
                      qty=payload.get("qty") or 1, rate=payload.get("rate"), description=payload.get("description"),
                      source=payload.get("source") or "auto", source_id=payload.get("source_id"),
                      ref_code=payload.get("ref_code"), fallback=payload.get("fallback"))


# ------------------------------------------------------------------ account

async def deposit_balance(ctx, pid: str) -> Decimal:
    t = payments
    base = [t.c.patient_id == pid, t.c.deleted_at.is_(None), t.c.status == "Success"]
    dep = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(t.c.amount), 0)).where(*base, t.c.kind == "DEPOSIT"))).scalar_one()
    used = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(t.c.amount), 0)).where(
        *base, t.c.kind == "ADJUSTMENT", t.c.mode == "DEPOSIT"))).scalar_one()
    refunded = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(t.c.amount), 0)).where(
        *base, t.c.kind == "REFUND", t.c.invoice_id.is_(None)))).scalar_one()
    return Decimal(dep) - Decimal(used) - Decimal(refunded)


async def _rows(ctx, table, *conds, order=None, limit=500) -> list[dict]:
    stmt = sa.select(table).where(table.c.deleted_at.is_(None), *conds)
    if order is not None:
        stmt = stmt.order_by(order)
    return [rs.to_record(r) for r in (await ctx.conn.execute(stmt.limit(limit))).all()]


@router.get("/patients/{pid}/account")
async def account(pid: str, ctx: CtxDep, encounter_id: str | None = None):
    rs.ensure_access(ctx, E("billing.invoices"), "read")
    p = (await ctx.conn.execute(sa.select(patients).where(patients.c.id == pid))).first()
    if not p:
        raise not_found("Patient not found")
    ch_conds = [charges.c.patient_id == pid, charges.c.status == "Unbilled"]
    if encounter_id:
        ch_conds.append(charges.c.encounter_id == encounter_id)
    unbilled = await _rows(ctx, charges, *ch_conds, order=charges.c.charged_at.asc())
    invs = await _rows(ctx, invoices, invoices.c.patient_id == pid, order=invoices.c.billed_at.desc(), limit=50)
    pays = await _rows(ctx, payments, payments.c.patient_id == pid, order=payments.c.paid_at.desc(), limit=100)
    encs = await _rows(ctx, encounters, encounters.c.patient_id == pid, order=encounters.c.started_at.desc().nulls_last(), limit=10)
    refs = await rs.resolve_refs(ctx, E("billing.charges"), unbilled)
    return {
        "patient": rs.to_record(p), "unbilled": unbilled, "invoices": invs, "payments": pays, "encounters": encs, "refs": refs,
        "totals": {
            "unbilled": float(sum(Decimal(str(c.get("amount") or 0)) for c in unbilled)),
            "outstanding": float(sum(Decimal(str(i.get("balance") or 0)) for i in invs if i.get("status") in ("Final", "Partially Paid"))),
            "deposit_balance": float(await deposit_balance(ctx, pid)),
        },
    }


# ------------------------------------------------------------------ invoices

class InvoiceIn(BaseModel):
    patient_id: str
    encounter_id: str | None = None
    charge_ids: list[str] | None = None
    type: Literal["OP", "IP", "PHARMACY", "PACKAGE", "DAYCARE"] = "OP"
    payer: Literal["Self", "Insurance", "Corporate", "Government Scheme"] = "Self"
    discount_amount: float = Field(default=0, ge=0)
    discount_percent: float = Field(default=0, ge=0, le=100)
    discount_reason: str | None = None
    apply_deposit: bool = True


async def _recalc(ctx, inv_id: str) -> dict:
    inv = await get(ctx, "billing.invoices", inv_id)
    paid = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(payments.c.amount), 0)).where(
        payments.c.invoice_id == inv_id, payments.c.deleted_at.is_(None), payments.c.status == "Success",
        payments.c.kind.in_(["PAYMENT", "ADJUSTMENT"])))).scalar_one()
    refunded = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(payments.c.amount), 0)).where(
        payments.c.invoice_id == inv_id, payments.c.deleted_at.is_(None), payments.c.status == "Success",
        payments.c.kind == "REFUND"))).scalar_one()
    net = Decimal(str(inv.get("net") or 0))
    paid_d = Decimal(paid) - Decimal(refunded)
    balance = money(net - paid_d)
    status = inv["status"]
    if status not in ("Draft", "Cancelled"):
        status = "Paid" if balance <= 0 else ("Partially Paid" if paid_d > 0 else "Final")
    return await update(ctx, "billing.invoices", inv_id, {"paid": float(money(paid_d)), "balance": float(balance), "status": status})


@router.post("/invoices", status_code=201)
async def create_invoice(body: InvoiceIn, ctx: CtxDep):
    require_role(ctx, *BILLING_ROLES)
    conds = [charges.c.patient_id == body.patient_id, charges.c.status == "Unbilled"]
    if body.charge_ids:
        conds.append(charges.c.id.in_([c for c in body.charge_ids if is_uuid(c)]))
    elif body.encounter_id:
        conds.append(charges.c.encounter_id == body.encounter_id)
    lines = await _rows(ctx, charges, *conds)
    if not lines:
        raise bad_request("There are no unbilled charges to bill")
    gross = sum(Decimal(str(c.get("amount") or 0)) for c in lines)
    tax = sum(money(Decimal(str(c.get("amount") or 0)) * Decimal(str(c.get("tax_percent") or 0)) / 100) for c in lines)
    discount = money(Decimal(str(body.discount_amount)) + gross * Decimal(str(body.discount_percent)) / 100)
    if discount > gross:
        raise bad_request("Discount cannot exceed the bill amount")
    if discount and not (body.discount_reason or "").strip():
        raise bad_request("Give a reason for the discount")
    net = money(gross + tax - discount)
    pct = float(discount / gross * 100) if gross else 0
    needs_approval = discount > 0 and pct > settings.discount_approval_percent
    inv = await create(ctx, "billing.invoices", {
        "patient_id": body.patient_id, "encounter_id": body.encounter_id or lines[0].get("encounter_id"),
        "type": body.type, "payer": body.payer, "gross": float(money(gross)), "tax": float(tax), "discount": float(discount),
        "net": float(net), "paid": 0, "balance": float(net), "billed_at": now().isoformat(),
        "discount_reason": body.discount_reason, "status": "Draft" if needs_approval else "Final",
    })
    await ctx.conn.execute(charges.update().where(charges.c.id.in_([c["id"] for c in lines])).values(
        status="Billed", invoice_id=inv["id"], updated_at=now(), updated_by=ctx.user_id))
    if needs_approval:
        appr = await request_approval(ctx, "billing.discount", subject_fqn="billing.invoices", subject_id=inv["id"],
                                      amount=float(discount), force=True,
                                      summary=f"Discount ₹{discount} ({pct:.1f}%) on bill {inv['code']}: {body.discount_reason}")
        if appr:
            inv = await update(ctx, "billing.invoices", inv["id"], {"discount_approval": appr["id"]})
    elif body.apply_deposit:
        await _apply_deposit(ctx, inv)
    inv = await _recalc(ctx, inv["id"])
    await emit("bill.created", ctx, {"invoice": inv})
    return inv


async def _apply_deposit(ctx, inv: dict) -> None:
    avail = await deposit_balance(ctx, inv["patient_id"])
    use = min(avail, Decimal(str(inv.get("net") or 0)))
    if use > 0:
        await create(ctx, "billing.payments", {
            "patient_id": inv["patient_id"], "invoice_id": inv["id"], "kind": "ADJUSTMENT", "mode": "DEPOSIT",
            "amount": float(money(use)), "paid_at": now().isoformat(), "reference": "Deposit adjusted",
            "received_by": ctx.user.get("name"), "status": "Success",
        })


@on_decided("billing.discount")
async def _discount_decided(ctx, approval: dict, approved: bool):
    inv = await get(ctx, "billing.invoices", approval["subject_id"])
    if not inv or inv.get("status") != "Draft":
        return
    if approved:
        await update(ctx, "billing.invoices", inv["id"], {"status": "Final"})
        await _apply_deposit(ctx, inv)
    else:
        net = money(Decimal(str(inv["gross"])) + Decimal(str(inv.get("tax") or 0)))
        await update(ctx, "billing.invoices", inv["id"], {"discount": 0, "net": float(net), "status": "Final",
                                                          "discount_reason": f"Rejected: {approval.get('comments') or ''}"})
    await _recalc(ctx, inv["id"])


class CancelIn(BaseModel):
    reason: str = Field(min_length=3)


@router.post("/invoices/{inv_id}/cancel")
async def cancel_invoice(inv_id: str, body: CancelIn, ctx: CtxDep):
    require_role(ctx, "billing")
    inv = await get(ctx, "billing.invoices", inv_id)
    if not inv:
        raise not_found("Bill not found")
    if float(inv.get("paid") or 0) > 0:
        raise conflict("Refund or reverse the payments before cancelling this bill")
    await ctx.conn.execute(charges.update().where(charges.c.invoice_id == inv_id).values(status="Unbilled", invoice_id=None, updated_at=now()))
    rec = await update(ctx, "billing.invoices", inv_id, {"status": "Cancelled", "balance": 0})
    await audit(ctx, "bill.cancel", module="billing", entity="invoices", record=rec, note=body.reason)
    return rec


@router.get("/invoices/{inv_id}/print")
async def invoice_print(inv_id: str, ctx: CtxDep):
    rs.ensure_access(ctx, E("billing.invoices"), "read")
    inv = await get(ctx, "billing.invoices", inv_id)
    if not inv:
        raise not_found("Bill not found")
    lines = await _rows(ctx, charges, charges.c.invoice_id == inv_id, order=charges.c.charged_at.asc())
    pays = await _rows(ctx, payments, payments.c.invoice_id == inv_id, order=payments.c.paid_at.asc())
    p = rs.to_record((await ctx.conn.execute(sa.select(patients).where(patients.c.id == inv["patient_id"]))).first())
    await audit(ctx, "print", module="billing", entity="invoices", record=inv)
    return {"invoice": inv, "lines": lines, "payments": pays, "patient": p, "hospital": settings.hospital_name}


# ------------------------------------------------------------------ payments, deposits, refunds

class PaymentIn(BaseModel):
    patient_id: str
    invoice_id: str | None = None
    kind: Literal["PAYMENT", "DEPOSIT"] = "PAYMENT"
    mode: Literal["CASH", "CARD", "UPI", "WALLET", "BANK", "CHEQUE", "INSURANCE"]
    amount: float = Field(gt=0)
    reference: str | None = None


@router.post("/payments", status_code=201)
async def collect(body: PaymentIn, ctx: CtxDep):
    require_role(ctx, *BILLING_ROLES)
    if body.kind == "PAYMENT" and not body.invoice_id:
        raise bad_request("Choose the bill this payment is for (or collect a deposit)")
    if body.invoice_id:
        inv = await get(ctx, "billing.invoices", body.invoice_id)
        if not inv or inv["patient_id"] != body.patient_id:
            raise not_found("Bill not found for this patient")
        if inv["status"] in ("Draft", "Cancelled"):
            raise conflict(f"Bill is {inv['status']}; payments are not allowed")
        if Decimal(str(body.amount)) > Decimal(str(inv.get("balance") or 0)) + Decimal("0.01"):
            raise bad_request(f"Amount exceeds the bill balance of ₹{inv.get('balance')}")
    if body.mode in ("CARD", "UPI", "WALLET", "BANK", "CHEQUE") and not body.reference:
        raise bad_request("Enter the transaction / cheque reference")
    pay = await create(ctx, "billing.payments", {
        **body.model_dump(), "kind": body.kind, "paid_at": now().isoformat(), "received_by": ctx.user.get("name"), "status": "Success",
    })
    if body.invoice_id:
        await _recalc(ctx, body.invoice_id)
    await emit("payment.received", ctx, {"payment": pay})
    return pay


class RefundIn(BaseModel):
    patient_id: str
    invoice_id: str | None = None
    amount: float = Field(gt=0)
    mode: Literal["CASH", "CARD", "UPI", "BANK", "CHEQUE"] = "CASH"
    reason: str = Field(min_length=3)


@router.post("/refunds", status_code=201)
async def refund(body: RefundIn, ctx: CtxDep):
    require_role(ctx, "billing")
    amt = Decimal(str(body.amount))
    if body.invoice_id:
        inv = await get(ctx, "billing.invoices", body.invoice_id)
        if not inv:
            raise not_found("Bill not found")
        if amt > Decimal(str(inv.get("paid") or 0)):
            raise bad_request("Refund exceeds what was paid on this bill")
    elif amt > await deposit_balance(ctx, body.patient_id):
        raise bad_request("Refund exceeds the unused deposit")
    pay = await create(ctx, "billing.payments", {
        "patient_id": body.patient_id, "invoice_id": body.invoice_id, "kind": "REFUND", "mode": body.mode,
        "amount": float(amt), "paid_at": now().isoformat(), "reference": body.reason, "received_by": ctx.user.get("name"),
        "status": "Pending",
    })
    appr = await request_approval(ctx, "billing.refund", subject_fqn="billing.payments", subject_id=pay["id"],
                                  amount=float(amt), summary=f"Refund ₹{amt} to patient: {body.reason}")
    if not appr:
        pay = await update(ctx, "billing.payments", pay["id"], {"status": "Success"})
        if body.invoice_id:
            await _recalc(ctx, body.invoice_id)
    return {**pay, "approval": appr}


@on_decided("billing.refund")
async def _refund_decided(ctx, approval: dict, approved: bool):
    pay = await get(ctx, "billing.payments", approval["subject_id"])
    if not pay or pay.get("status") != "Pending":
        return
    await update(ctx, "billing.payments", pay["id"], {"status": "Success" if approved else "Failed"})
    if pay.get("invoice_id"):
        await _recalc(ctx, pay["invoice_id"])


# ------------------------------------------------------------------ daily IP charges & clearance

async def post_daily_charges(ctx, for_date=None) -> int:
    """Room + nursing charges for every admitted patient (run nightly by the worker)."""
    d = (for_date or today()).isoformat()
    rows = (await ctx.conn.execute(
        sa.select(encounters.c.id, encounters.c.patient_id, encounters.c.bed_id, beds.c.rate, beds.c.category, beds.c.code)
        .select_from(encounters.outerjoin(beds, beds.c.id == encounters.c.bed_id))
        .where(encounters.c.type == "IPD", encounters.c.status.in_(["Admitted", "Discharge Initiated"]), encounters.c.deleted_at.is_(None))
    )).all()
    n = 0
    for r in rows:
        src = f"ipd.daily:{d}"
        exists = (await ctx.conn.execute(sa.select(charges.c.id).where(charges.c.encounter_id == r.id, charges.c.source == src).limit(1))).first()
        if exists:
            continue
        cat = r.category or "General"
        await post_charge(ctx, patient_id=str(r.patient_id), encounter_id=str(r.id), rate=r.rate,
                          service_code="ROOM-GENERAL" if r.rate is None else None,
                          description=f"Room rent — {cat} bed {r.code or ''} ({d})", source=src)
        code = "ICU-DAILY" if cat in ("ICU", "HDU", "PICU") else "NICU-DAILY" if cat == "NICU" else "NURSING-DAILY"
        await post_charge(ctx, patient_id=str(r.patient_id), encounter_id=str(r.id), service_code=code,
                          description=None, source=src)
        n += 1
    return n


@router.post("/run-daily-charges")
async def run_daily(ctx: CtxDep):
    require_role(ctx, "billing")
    return {"admissions_charged": await post_daily_charges(ctx)}


async def clearance(ctx, encounter_id: str) -> dict:
    unbilled = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.coalesce(sa.func.sum(charges.c.amount), 0)).where(
        charges.c.encounter_id == encounter_id, charges.c.status == "Unbilled", charges.c.deleted_at.is_(None)))).one()
    due = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(invoices.c.balance), 0)).where(
        invoices.c.encounter_id == encounter_id, invoices.c.status.in_(["Final", "Partially Paid", "Draft"]), invoices.c.deleted_at.is_(None)))).scalar_one()
    ok = unbilled[0] == 0 and Decimal(due) <= 0
    return {"cleared": ok, "unbilled_count": unbilled[0], "unbilled_amount": to_json_value(unbilled[1]), "balance_due": to_json_value(due)}


@router.get("/encounters/{eid}/clearance")
async def clearance_api(eid: str, ctx: CtxDep):
    return await clearance(ctx, eid)


class ManualChargeIn(BaseModel):
    patient_id: str
    encounter_id: str | None = None
    service_id: str
    qty: float = Field(default=1, gt=0)
    rate: float | None = None


@router.post("/charges", status_code=201)
async def add_charge(body: ManualChargeIn, ctx: CtxDep):
    require_role(ctx, *BILLING_ROLES, "nurse")
    return await post_charge(ctx, patient_id=body.patient_id, encounter_id=body.encounter_id, service_id=body.service_id,
                             qty=body.qty, rate=body.rate, source="billing.manual")


@router.post("/charges/{cid}/cancel")
async def cancel_charge(cid: str, body: CancelIn, ctx: CtxDep):
    require_role(ctx, "billing")
    c = await get(ctx, "billing.charges", cid)
    if not c or c.get("status") != "Unbilled":
        raise conflict("Only unbilled charges can be cancelled")
    rec = await update(ctx, "billing.charges", cid, {"status": "Cancelled"})
    await audit(ctx, "charge.cancel", module="billing", entity="charges", record=rec, note=body.reason)
    return rec


__all__ = ["router", "post_charge", "deposit_balance", "clearance", "post_daily_charges", "find", "ApiError"]
