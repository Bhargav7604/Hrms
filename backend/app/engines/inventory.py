"""Inventory & procurement stock flows: batch/expiry-wise stock primitives (FEFO), every movement
written to the stock ledger (stock_moves), GRN posting with PO receipt tracking, store transfers,
department consumption, approved adjustments, PO approvals and the stock console."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter

from ..config import settings
from ..core import records as rs
from ..core.audit import audit
from ..core.hooks import hook
from ..core.security import CtxDep
from ..core.util import (
    ApiError,
    bad_request,
    conflict,
    forbidden,
    is_uuid,
    money,
    new_id,
    not_found,
    now,
    parse_date,
    to_json_value,
    today,
)
from ..modules.operations.inventory import STORES
from ..schema import stock, stock_moves, users
from ._common import E, create, find, get, live, transition, update
from .workflow import on_decided, request_approval

router = APIRouter(prefix="/api/inventory", tags=["inventory"])

STOCK = "inventory.stock"
ITEMS = "mdm.items"
PO = "procurement.purchase_orders"
GRN = "procurement.grns"
TRANSFER = "inventory.transfers"
CONSUMPTION = "inventory.consumption"
ADJUSTMENT = "inventory.adjustments"

OUT_KINDS = ("DISPENSE", "ISSUE", "CONSUME")  # consumption for the "top movers" view
CHARGEABLE_TYPES = {"Drug", "Consumable", "Implant", "Reagent"}
NEAR_EXPIRY_DAYS = 90
ZERO = Decimal(0)


# ------------------------------------------------------------------ small helpers

def _dec(v: Any) -> Decimal:
    try:
        return Decimal(str(v if v not in (None, "") else 0))
    except ArithmeticError as e:
        raise bad_request(f"Invalid quantity {v!r}") from e


def _qty(v: Any) -> Decimal:
    q = _dec(v)
    if q <= 0:
        raise bad_request("Quantity must be greater than zero")
    return q


def _num(v: Any) -> float:
    return float(to_json_value(v) or 0)


def _store(store: str | None) -> str:
    if store not in STORES:
        raise bad_request(f"Unknown store {store!r}")
    return store


async def items_by_id(ctx, ids) -> dict[str, dict]:
    """mdm.items records keyed by id (one query, cached on the request)."""
    cache: dict[str, dict] = ctx.__dict__.setdefault("_items_cache", {})
    want = [i for i in {str(x) for x in ids if x} if i not in cache and is_uuid(i)]
    if want:
        ent = E(ITEMS)
        rows = (await ctx.conn.execute(sa.select(ent.table).where(ent.table.c.id.in_(want), *rs.base_where(ent)))).all()
        for r in rows:
            cache[str(r.id)] = rs.to_record(r)
    return {i: cache[i] for i in {str(x) for x in ids if x} if i in cache}


async def item_or_404(ctx, item_id: str) -> dict:
    it = (await items_by_id(ctx, [item_id])).get(str(item_id))
    if not it:
        raise not_found("Item not found in the item master")
    return it


def item_label(it: dict | None) -> str:
    if not it:
        return "Unknown item"
    return str(it.get("name") or it.get("title") or it.get("code") or "Item")


def _touch(ctx) -> None:
    """One realtime change event per request for stock screens (row updates bypass the record service)."""
    if ctx.__dict__.get("_stock_touched"):
        return
    ctx.__dict__["_stock_touched"] = True
    live(ctx, "changes", {"fqn": STOCK, "module": "inventory", "entity": "stock", "id": None, "action": "updated"})


async def _lock(ctx, *parts: Any) -> None:
    key = "stock:" + ":".join(str(p or "") for p in parts)
    await ctx.conn.execute(sa.select(sa.func.pg_advisory_xact_lock(sa.func.hashtext(key))))


async def _move(ctx, *, item: dict, store: str, batch: str | None, qty: Decimal, kind: str, ref: str | None,
                ref_fqn: str | None, ref_id: str | None, patient_id: str | None, encounter_id: str | None,
                balance: Decimal, extra: dict) -> None:
    ts = now()
    await ctx.conn.execute(stock_moves.insert().values(
        id=new_id(), status=kind, title=item.get("name") or item.get("code"), item_id=item["id"], store=store,
        batch=batch, qty=qty, kind=kind, ref=ref, patient_id=patient_id if is_uuid(patient_id) else None,
        encounter_id=encounter_id if is_uuid(encounter_id) else None,
        data={"ref_fqn": ref_fqn, "ref_id": ref_id, "balance": float(balance), "uom": item.get("uom"),
              **{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in extra.items() if v is not None}},
        branch_id=settings.branch_id, created_by=ctx.user_id, created_at=ts, updated_by=ctx.user_id, updated_at=ts,
    ))


# ------------------------------------------------------------------ stock primitives

async def stock_in(ctx, *, item_id: str, store: str, qty: Any, batch: str | None, expiry: Any = None, rate: Any = None,
                   mrp: Any = None, kind: str = "GRN", ref: str | None = None, ref_fqn: str | None = None,
                   ref_id: str | None = None, patient_id: str | None = None, encounter_id: str | None = None,
                   extra: dict | None = None) -> dict:
    """Add stock to a batch (created if new) and write the ledger row."""
    q = _qty(qty)
    _store(store)
    item = await item_or_404(ctx, item_id)
    batch = (str(batch).strip() or None) if batch else None
    exp = parse_date(expiry) if expiry else None
    await _lock(ctx, item_id, store, batch)
    t = stock
    row = (await ctx.conn.execute(sa.select(t).where(
        t.c.item_id == item_id, t.c.store == store, t.c.deleted_at.is_(None),
        t.c.batch == batch if batch else t.c.batch.is_(None)).order_by(t.c.created_at).limit(1).with_for_update())).first()
    if row:
        vals: dict[str, Any] = {"qty": t.c.qty + q, "updated_at": now(), "updated_by": ctx.user_id}
        if exp and not row.expiry:
            vals["expiry"] = exp
        if rate not in (None, "") and row.rate is None:
            vals["rate"] = money(rate)
        if mrp not in (None, "") and row.mrp is None:
            vals["mrp"] = money(mrp)
        eff_exp = row.expiry or exp
        if row.status == "Expired" and eff_exp and eff_exp >= today():
            vals["status"] = "Available"
        await ctx.conn.execute(t.update().where(t.c.id == row.id).values(**vals))
        stock_id, balance = str(row.id), _dec(row.qty) + q
        exp = eff_exp
        rate = rate if rate not in (None, "") else row.rate
        mrp = mrp if mrp not in (None, "") else row.mrp
    else:
        rec = await create(ctx, STOCK, {
            "item_id": item_id, "store": store, "batch": batch, "expiry": exp.isoformat() if exp else None,
            "qty": float(q), "rate": _num(rate) if rate not in (None, "") else item.get("purchase_rate"),
            "mrp": _num(mrp) if mrp not in (None, "") else item.get("mrp"),
            "status": "Expired" if exp and exp < today() else "Available", **(extra or {}),
        })
        stock_id, balance = rec["id"], q
        rate, mrp = rec.get("rate"), rec.get("mrp")
    await _move(ctx, item=item, store=store, batch=batch, qty=q, kind=kind, ref=ref, ref_fqn=ref_fqn, ref_id=ref_id,
                patient_id=patient_id, encounter_id=encounter_id, balance=balance,
                extra={"expiry": exp, "rate": _num(rate) if rate is not None else None, "mrp": _num(mrp) if mrp is not None else None})
    _touch(ctx)
    return {"stock_id": stock_id, "item_id": item_id, "store": store, "batch": batch, "expiry": exp.isoformat() if exp else None,
            "qty": float(q), "rate": _num(rate) if rate is not None else None, "mrp": _num(mrp) if mrp is not None else None,
            "balance": float(balance)}


async def available(ctx, item_id: str, store: str, batch: str | None = None, *, allow_expired: bool = False) -> Decimal:
    t = stock
    conds = [t.c.item_id == item_id, t.c.store == store, t.c.deleted_at.is_(None), t.c.qty > 0,
             sa.func.coalesce(t.c.status, "Available") != "Quarantine"]
    if batch:
        conds.append(t.c.batch == batch)
    if not allow_expired:
        conds.append(sa.or_(t.c.expiry.is_(None), t.c.expiry >= today()))
    v = (await ctx.conn.execute(sa.select(sa.func.coalesce(sa.func.sum(t.c.qty), 0)).where(*conds))).scalar_one()
    return _dec(v)


async def stock_out(ctx, *, item_id: str, store: str, qty: Any, batch: str | None = None, kind: str = "ISSUE",
                    ref: str | None = None, ref_fqn: str | None = None, ref_id: str | None = None,
                    patient_id: str | None = None, encounter_id: str | None = None, allow_expired: bool = False,
                    partial: bool = False, extra: dict | None = None) -> list[dict]:
    """Take stock out FEFO (first-expiry-first-out) or from the given batch. Expired and quarantined
    batches are never issued unless `allow_expired` (write-offs). Raises 409 on shortfall unless
    `partial`, in which case whatever is available is allocated."""
    q = _qty(qty)
    _store(store)
    item = await item_or_404(ctx, item_id)
    batch = (str(batch).strip() or None) if batch else None
    t = stock
    conds = [t.c.item_id == item_id, t.c.store == store, t.c.deleted_at.is_(None), t.c.qty > 0,
             sa.func.coalesce(t.c.status, "Available") != "Quarantine"]
    if batch:
        conds.append(t.c.batch == batch)
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(
        t.c.expiry.asc().nulls_last(), t.c.created_at.asc()).with_for_update())).all()
    usable = [r for r in rows if allow_expired or not r.expiry or r.expiry >= today()]
    avail = sum((_dec(r.qty) for r in usable), ZERO)
    name = item_label(item)
    if batch and rows and not usable:
        raise conflict(f"Batch {batch} of {name} expired on {rows[0].expiry:%d %b %Y} and cannot be issued",
                       {"item_id": item_id, "batch": batch, "code": "BATCH_EXPIRED"})
    if avail < q and not partial:
        where = f"batch {batch} in {store}" if batch else store
        raise conflict(f"Insufficient stock of {name}: {q.normalize():f} {item.get('uom') or ''} needed, "
                       f"{avail.normalize():f} available (non-expired) in {where}",
                       {"item_id": item_id, "store": store, "batch": batch, "required": float(q), "available": float(avail),
                        "code": "INSUFFICIENT_STOCK"})
    out, need = [], min(q, avail)
    for r in usable:
        if need <= 0:
            break
        take = min(_dec(r.qty), need)
        need -= take
        bal = _dec(r.qty) - take
        await ctx.conn.execute(t.update().where(t.c.id == r.id).values(qty=t.c.qty - take, updated_at=now(), updated_by=ctx.user_id))
        await _move(ctx, item=item, store=store, batch=r.batch, qty=-take, kind=kind, ref=ref, ref_fqn=ref_fqn, ref_id=ref_id,
                    patient_id=patient_id, encounter_id=encounter_id, balance=bal,
                    extra={"expiry": r.expiry, "rate": _num(r.rate), "mrp": _num(r.mrp), **(extra or {})})
        out.append({"stock_id": str(r.id), "item_id": item_id, "store": store, "batch": r.batch,
                    "expiry": r.expiry.isoformat() if r.expiry else None, "qty": float(take),
                    "rate": _num(r.rate) if r.rate is not None else None,
                    "mrp": _num(r.mrp if r.mrp is not None else item.get("mrp")), "balance": float(bal)})
    if out:
        _touch(ctx)
    return out


async def transfer(ctx, *, item_id: str, from_store: str, to_store: str, qty: Any, batch: str | None = None,
                   ref: str | None = None, ref_fqn: str | None = None, ref_id: str | None = None) -> list[dict]:
    """Move stock between stores batch-for-batch (FEFO when no batch is given)."""
    if from_store == to_store:
        raise bad_request("Choose two different stores")
    allocs = await stock_out(ctx, item_id=item_id, store=from_store, qty=qty, batch=batch, kind="TRANSFER_OUT",
                             ref=ref, ref_fqn=ref_fqn, ref_id=ref_id)
    for a in allocs:
        await stock_in(ctx, item_id=item_id, store=to_store, qty=a["qty"], batch=a["batch"], expiry=a["expiry"],
                       rate=a["rate"], mrp=a["mrp"], kind="TRANSFER_IN", ref=ref, ref_fqn=ref_fqn, ref_id=ref_id)
    return allocs


async def mark_expired(ctx) -> int:
    t = stock
    res = await ctx.conn.execute(t.update().where(
        t.c.deleted_at.is_(None), t.c.expiry < today(), sa.func.coalesce(t.c.status, "Available") == "Available",
    ).values(status="Expired", updated_at=now(), updated_by=ctx.user_id))
    if res.rowcount:
        _touch(ctx)
    return res.rowcount


async def _expire_job(_arq_ctx) -> None:
    from ..db import system_ctx

    async with system_ctx() as ctx:
        await mark_expired(ctx)


CRON = [(_expire_job, {"hour": 0, "minute": 15})]


# ------------------------------------------------------------------ approvals shared by PO / adjustments

async def _close_pending(ctx, subject_id: str, note: str) -> None:
    """A subject decided directly (transition button) must not leave its approval open in the inbox."""
    for a in await find(ctx, "workflow.approvals", status="Pending", subject_id=subject_id, limit=20):
        await update(ctx, "workflow.approvals", a["id"], {"status": "Cancelled", "comments": note,
                                                          "decided_by": ctx.user.get("name"), "decided_at": now().isoformat()})


def _me(ctx) -> str | None:
    return ctx.user.get("employee_id")


# ------------------------------------------------------------------ purchase orders

def _po_totals(rec: dict) -> None:
    sub = gst = ZERO
    lines = []
    for ln in rec.get("items") or []:
        amt = money(_dec(ln.get("qty")) * _dec(ln.get("rate")))
        g = money(amt * _dec(ln.get("gst_percent")) / 100)
        sub += amt
        gst += g
        lines.append({**ln, "amount": float(amt + g)})
    if lines:
        rec["items"] = lines
        rec.update(subtotal=float(sub), gst_amount=float(gst), total=float(money(sub + gst)))


@hook(PO, "before_create")
async def _po_create(ctx, draft):
    vendor = await get(ctx, "procurement.vendors", draft.get("vendor"))
    if vendor and vendor.get("status") != "Active":
        raise conflict(f"Vendor {vendor.get('name')} is {vendor.get('status')} — purchase orders are not allowed")
    _po_totals(draft)


def _po_sig(lines) -> list[tuple]:
    return [(ln.get("item"), _dec(ln.get("qty")), _dec(ln.get("rate")), _dec(ln.get("gst_percent"))) for ln in lines or []]


@hook(PO, "before_update")
async def _po_update(ctx, nxt, prev):
    if prev.get("status") not in ("Draft", None) and _po_sig(nxt.get("items")) != _po_sig(prev.get("items")):
        raise conflict(f"PO {prev.get('code')} is {prev.get('status')}; send it back to Draft to change items or rates")
    _po_totals(nxt)


@hook(PO, "before_transition")
async def _po_before(ctx, nxt, prev):
    if nxt["status"] == "Pending Approval":
        _po_totals(nxt)
        if not nxt.get("items") or _dec(nxt.get("total")) <= 0:
            raise bad_request("Add items with quantity and rate before submitting the PO")


@hook(PO, "after_transition")
async def _po_after(ctx, rec, prev):
    st = rec["status"]
    if st == "Pending Approval":
        vendor = await get(ctx, "procurement.vendors", rec.get("vendor"))
        await request_approval(ctx, "procurement.purchase_order", subject_fqn=PO, subject_id=rec["id"], amount=_num(rec.get("total")),
                               summary=f"PO {rec['code']} · {(vendor or {}).get('name', 'vendor')} · ₹{_num(rec.get('total')):,.2f} "
                                       f"→ {rec.get('delivery_store')}")
    elif st in ("Approved", "Draft", "Cancelled"):
        await _close_pending(ctx, rec["id"], f"PO moved to {st} directly")


@on_decided("procurement.purchase_order")
async def _po_decided(ctx, approval: dict, approved: bool):
    po = await get(ctx, PO, approval["subject_id"])
    if not po or po.get("status") != "Pending Approval":
        return
    if approved:
        await transition(ctx, PO, po["id"], "Approved", note=f"Approved in workflow ({approval.get('code')})")
    else:
        await transition(ctx, PO, po["id"], "Draft", note=f"Rejected in workflow ({approval.get('code')})",
                         values={"send_back_reason": approval.get("comments") or "Rejected by approver"})


# ------------------------------------------------------------------ GRN → stock

def _grn_total(rec: dict) -> None:
    lines = rec.get("items") or []
    if lines:
        rec["total"] = float(money(sum((_dec(ln.get("qty")) * _dec(ln.get("rate")) * (1 + _dec(ln.get("gst_percent")) / 100)
                                        for ln in lines), ZERO)))


@hook(GRN, "before_create")
@hook(GRN, "before_update")
async def _grn_save(ctx, nxt, prev=None):
    if prev and prev.get("status") == "Posted":
        raise conflict("A posted GRN cannot be edited")
    po_id = nxt.get("purchase_order")
    if po_id:
        po = await get(ctx, PO, po_id)
        if not po:
            raise bad_request("Purchase order not found")
        if nxt.get("vendor") and po.get("vendor") and nxt["vendor"] != po["vendor"]:
            raise bad_request("The GRN vendor differs from the purchase order's vendor")
        nxt.setdefault("vendor", po.get("vendor"))
    _grn_total(nxt)


async def _received_by_item(ctx, po_id: str, extra_lines: list[dict] | None = None) -> dict[str, Decimal]:
    got: dict[str, Decimal] = {}
    for g in await find(ctx, GRN, status="Posted", purchase_order=po_id, limit=500):
        for ln in g.get("items") or []:
            got[ln["item"]] = got.get(ln["item"], ZERO) + _dec(ln.get("qty"))
    for ln in extra_lines or []:
        got[ln["item"]] = got.get(ln["item"], ZERO) + _dec(ln.get("qty"))
    return got


@hook(GRN, "before_transition")
async def _grn_post(ctx, nxt, prev):
    if nxt["status"] != "Posted":
        return
    lines = nxt.get("items") or []
    if not lines:
        raise bad_request("Add the received items before posting")
    store = _store(nxt.get("store"))
    items = await items_by_id(ctx, [ln.get("item") for ln in lines])
    for i, ln in enumerate(lines, 1):
        it = items.get(ln.get("item"))
        if not it:
            raise bad_request(f"Line {i}: item not found")
        exp = parse_date(ln.get("expiry")) if ln.get("expiry") else None
        if it.get("type") == "Drug" and not exp:
            raise bad_request(f"Line {i}: enter the expiry date for {it.get('name')} batch {ln.get('batch')}")
        if exp and exp < today():
            raise bad_request(f"Line {i}: batch {ln.get('batch')} of {it.get('name')} expired on {exp:%d %b %Y} — reject it")
        if _dec(ln.get("qty")) + _dec(ln.get("free_qty")) <= 0:
            raise bad_request(f"Line {i}: received quantity must be more than zero")
    po_id = nxt.get("purchase_order")
    if po_id:
        po = await get(ctx, PO, po_id)
        if not po or po.get("status") not in ("Approved", "Sent", "Partially Received"):
            raise conflict(f"Purchase order {po and po.get('code')} is {po and po.get('status')}; goods can only be received "
                           "against an approved / sent PO")
        ordered: dict[str, Decimal] = {}
        for ln in po.get("items") or []:
            ordered[ln["item"]] = ordered.get(ln["item"], ZERO) + _dec(ln.get("qty"))
        got = await _received_by_item(ctx, po_id, lines)
        for item_id, q in got.items():
            if item_id not in ordered:
                raise bad_request(f"{item_label(items.get(item_id))} is not on PO {po['code']}")
            if q > ordered[item_id]:
                raise conflict(f"{item_label(items.get(item_id))}: receiving {q.normalize():f} exceeds the ordered "
                               f"{ordered[item_id].normalize():f} on PO {po['code']}")
    for ln in lines:
        it = items[ln["item"]]
        await stock_in(ctx, item_id=ln["item"], store=store, qty=_dec(ln.get("qty")) + _dec(ln.get("free_qty")),
                       batch=ln.get("batch"), expiry=ln.get("expiry"), rate=ln.get("rate"),
                       mrp=ln.get("mrp") if ln.get("mrp") not in (None, "") else it.get("mrp"),
                       kind="GRN", ref=prev.get("code"), ref_fqn=GRN, ref_id=prev["id"],
                       extra={"grn": prev["id"], "vendor": nxt.get("vendor")})


@hook(GRN, "after_transition")
async def _grn_posted(ctx, rec, prev):
    if rec["status"] != "Posted" or not rec.get("purchase_order"):
        return
    po = await get(ctx, PO, rec["purchase_order"])
    if not po:
        return
    got = await _received_by_item(ctx, po["id"])
    lines, complete = [], True
    for ln in po.get("items") or []:
        rcv = got.get(ln["item"], ZERO)
        complete = complete and rcv >= _dec(ln.get("qty"))
        lines.append({**ln, "received_qty": float(rcv)})
    await update(ctx, PO, po["id"], {"items": lines, "status": "Closed" if complete else "Partially Received",
                                     "last_grn": rec["code"], "last_received_on": rec.get("received_on")})


# ------------------------------------------------------------------ store transfers

@hook(TRANSFER, "before_create")
@hook(TRANSFER, "before_update")
async def _transfer_save(ctx, nxt, prev=None):
    if nxt.get("from_store") and nxt.get("from_store") == nxt.get("to_store"):
        raise bad_request("From and to store must be different", {"fields": {"to_store": "Choose a different store"}})
    if prev and prev.get("status") != "Requested":
        sig = lambda lines: [(ln.get("item"), _dec(ln.get("qty")), ln.get("batch")) for ln in lines or []]  # noqa: E731
        if prev.get("status") != "Issued" or sig(nxt.get("items")) != sig(prev.get("items")) or nxt.get("from_store") != prev.get("from_store") \
                or nxt.get("to_store") != prev.get("to_store"):
            raise conflict(f"Transfer is {prev.get('status')} — only received quantities can be recorded")


@hook(TRANSFER, "before_transition")
async def _transfer_move(ctx, nxt, prev):
    st = nxt["status"]
    if st == "Issued":
        src = _store(nxt.get("from_store"))
        _store(nxt.get("to_store"))
        allocations, lines = [], []
        for i, ln in enumerate(nxt.get("items") or []):
            allocs = await stock_out(ctx, item_id=ln["item"], store=src, qty=ln.get("qty"), batch=ln.get("batch"),
                                     kind="TRANSFER_OUT", ref=prev["code"], ref_fqn=TRANSFER, ref_id=prev["id"],
                                     extra={"to_store": nxt.get("to_store")})
            allocations += [{**a, "line": i} for a in allocs]
            if len(allocs) == 1:
                ln = {**ln, "batch": allocs[0]["batch"], "expiry": allocs[0]["expiry"]}
            lines.append(ln)
        if not allocations:
            raise bad_request("Add items to transfer")
        nxt["items"], nxt["allocations"] = lines, allocations
        nxt["issued_by"] = nxt.get("issued_by") or _me(ctx)
    elif st == "Received":
        dest = _store(nxt.get("to_store"))
        allocs = prev.get("allocations") or []
        lines, shortage = [], []
        for i, ln in enumerate(nxt.get("items") or []):
            mine = [a for a in allocs if a.get("line") == i]
            issued = sum((_dec(a["qty"]) for a in mine), ZERO)
            want = _dec(ln.get("received_qty")) if ln.get("received_qty") not in (None, "") else issued
            if want > issued:
                raise bad_request(f"Line {i + 1}: received quantity cannot exceed the issued {issued.normalize():f}")
            left = want
            for a in mine:
                take = min(_dec(a["qty"]), left)
                if take > 0:
                    await stock_in(ctx, item_id=a["item_id"], store=dest, qty=take, batch=a["batch"], expiry=a["expiry"],
                                   rate=a.get("rate"), mrp=a.get("mrp"), kind="TRANSFER_IN", ref=prev["code"],
                                   ref_fqn=TRANSFER, ref_id=prev["id"])
                left -= take
            if want < issued:
                shortage.append({"line": i + 1, "item": ln["item"], "issued": float(issued), "received": float(want)})
            lines.append({**ln, "received_qty": float(want)})
        nxt["items"] = lines
        nxt["received_by"] = nxt.get("received_by") or _me(ctx)
        if shortage:
            nxt["transit_shortage"] = shortage
            await audit(ctx, "inventory.transit_shortage", module="inventory", entity="transfers", record=prev, after=shortage,
                        note="Received less than issued — raise an adjustment after investigation")


# ------------------------------------------------------------------ department consumption

@hook(CONSUMPTION, "before_transition")
async def _consume(ctx, nxt, prev):
    if nxt["status"] != "Posted":
        return
    from .billing import post_charge

    store = _store(nxt.get("store"))
    lines = nxt.get("items") or []
    if not lines:
        raise bad_request("Add the consumed items before posting")
    items = await items_by_id(ctx, [ln.get("item") for ln in lines])
    pid = nxt.get("patient_id")
    allocations = []
    for i, ln in enumerate(lines):
        allocs = await stock_out(ctx, item_id=ln["item"], store=store, qty=ln.get("qty"), batch=ln.get("batch"), kind="CONSUME",
                                 ref=prev["code"], ref_fqn=CONSUMPTION, ref_id=prev["id"], patient_id=pid,
                                 extra={"department": nxt.get("department"), "ward": nxt.get("ward")})
        allocations += [{**a, "line": i} for a in allocs]
        it = items.get(ln["item"]) or {}
        if pid and it.get("type") in CHARGEABLE_TYPES:
            for a in allocs:
                await post_charge(ctx, patient_id=pid, encounter_id=nxt.get("encounter_id"), qty=a["qty"], rate=a["mrp"] or it.get("mrp"),
                                  description=f"{item_label(it)} · batch {a['batch'] or '—'}", source=CONSUMPTION, source_id=prev["id"])
    nxt["allocations"] = allocations


# ------------------------------------------------------------------ adjustments (approval → apply)

async def _batch_row(ctx, item_id: str, store: str, batch: str | None):
    if not batch:
        return None
    return (await ctx.conn.execute(sa.select(stock).where(stock.c.item_id == item_id, stock.c.store == store, stock.c.batch == batch,
                                                          stock.c.deleted_at.is_(None)).limit(1))).first()


@hook(ADJUSTMENT, "before_create")
async def _adj_validate(ctx, draft):
    change = _dec(draft.get("qty_change"))
    if change == 0:
        raise bad_request("Quantity change cannot be zero", {"fields": {"qty_change": "Enter a positive or negative quantity"}})
    store = _store(draft.get("store"))
    item = await item_or_404(ctx, draft["item"])
    row = await _batch_row(ctx, draft["item"], store, draft.get("batch"))
    if draft.get("batch") and not row:
        raise bad_request(f"Batch {draft['batch']} of {item_label(item)} is not in {store}", {"fields": {"batch": "Unknown batch"}})
    if change > 0 and not row:
        raise bad_request("Choose the batch the count gain belongs to (new batches come in through a GRN)",
                          {"fields": {"batch": "Required for a positive adjustment"}})
    if change < 0:
        have = await available(ctx, draft["item"], store, draft.get("batch"), allow_expired=True)
        if -change > have:
            raise conflict(f"Only {have.normalize():f} of {item_label(item)} on hand in {store} — cannot reduce by {(-change).normalize():f}")
    if draft.get("value_impact") in (None, ""):
        rate = row.rate if row is not None and row.rate is not None else item.get("purchase_rate") or 0
        draft["value_impact"] = float(money(change * _dec(rate)))


@hook(ADJUSTMENT, "after_create")
async def _adj_request(ctx, rec):
    item = await item_or_404(ctx, rec["item"])
    await request_approval(ctx, "inventory.adjustment", subject_fqn=ADJUSTMENT, subject_id=rec["id"],
                           amount=abs(_num(rec.get("value_impact"))),
                           summary=f"Stock adjustment {rec['code']}: {item_label(item)} {_num(rec['qty_change']):+g} in {rec['store']} "
                                   f"({rec.get('reason')}, ₹{_num(rec.get('value_impact')):,.2f})")


@hook(ADJUSTMENT, "before_update")
async def _adj_locked(ctx, nxt, prev):
    if prev.get("status") != "Pending":
        raise conflict(f"Adjustment is {prev.get('status')} and can no longer be edited")
    for k in ("item", "store", "batch", "qty_change"):
        if nxt.get(k) != prev.get(k):
            raise conflict("Item, store, batch and quantity cannot change after the adjustment is raised — reject it and raise a new one")


@hook(ADJUSTMENT, "before_transition")
async def _adj_apply(ctx, nxt, prev):
    if nxt["status"] != "Approved":
        return
    if ctx.role != "admin" and prev.get("created_by") == ctx.user_id:
        raise forbidden("Maker-checker: the person who raised a stock adjustment cannot approve it")
    if prev.get("applied_at"):
        return
    change = _dec(nxt.get("qty_change"))
    common = {"item_id": nxt["item"], "store": nxt["store"], "kind": "ADJUST", "ref": prev["code"], "ref_fqn": ADJUSTMENT, "ref_id": prev["id"]}
    if change > 0:
        row = await _batch_row(ctx, nxt["item"], nxt["store"], nxt.get("batch"))
        if row is None:
            raise conflict(f"Batch {nxt.get('batch')} no longer exists in {nxt['store']}")
        a = await stock_in(ctx, qty=change, batch=row.batch, expiry=row.expiry, rate=row.rate, mrp=row.mrp, **common)
        nxt["allocations"] = [a]
    else:
        nxt["allocations"] = await stock_out(ctx, qty=-change, batch=nxt.get("batch"), allow_expired=True,
                                             extra={"reason": nxt.get("reason")}, **common)
    nxt["applied_at"] = now().isoformat(timespec="seconds")


@hook(ADJUSTMENT, "after_transition")
async def _adj_after(ctx, rec, prev):
    if rec["status"] in ("Approved", "Rejected"):
        await _close_pending(ctx, rec["id"], f"Adjustment {rec['status'].lower()} directly")


@on_decided("inventory.adjustment")
async def _adj_decided(ctx, approval: dict, approved: bool):
    adj = await get(ctx, ADJUSTMENT, approval["subject_id"])
    if not adj or adj.get("status") != "Pending":
        return
    if approved:
        await transition(ctx, ADJUSTMENT, adj["id"], "Approved", note=f"Approved in workflow ({approval.get('code')})")
    else:
        await transition(ctx, ADJUSTMENT, adj["id"], "Rejected", note=f"Rejected in workflow ({approval.get('code')})",
                         values={"rejection_reason": approval.get("comments") or "Rejected by approver"})


# ------------------------------------------------------------------ console & item drill-down

def _read(ctx) -> None:
    rs.ensure_access(ctx, E(STOCK), "read")


def _store_filter(store: str | None) -> list:
    if not store:
        return []
    _store(store)
    return [stock.c.store == store]


async def _reorder_levels(ctx, store: str | None) -> dict[tuple[str, str], dict]:
    out = {}
    for r in await find(ctx, "inventory.reorder_levels", status="Active", limit=2000, **({"store": store} if store else {})):
        out[(r["item"], r["store"])] = r
    return out


@router.get("/console")
async def console(ctx: CtxDep, store: str | None = None):
    _read(ctx)
    t = stock
    live_rows = [t.c.deleted_at.is_(None)]
    sf = _store_filter(store)
    td = today()
    soon = td + timedelta(days=NEAR_EXPIRY_DAYS)
    expired = sa.and_(t.c.expiry.isnot(None), t.c.expiry < td)

    by_store = []
    for r in (await ctx.conn.execute(
        sa.select(t.c.store, sa.func.count(), sa.func.coalesce(sa.func.sum(t.c.qty * t.c.rate), 0),
                  sa.func.coalesce(sa.func.sum(t.c.qty * t.c.mrp), 0),
                  sa.func.coalesce(sa.func.sum(t.c.qty * t.c.rate).filter(expired), 0))
        .where(*live_rows, t.c.qty > 0, *sf).group_by(t.c.store).order_by(t.c.store))).all():
        by_store.append({"store": r[0], "batches": r[1], "value": _num(r[2]), "mrp_value": _num(r[3]), "expired_value": _num(r[4])})

    batch_cols = [t.c.id, t.c.item_id, t.c.store, t.c.batch, t.c.expiry, t.c.qty, t.c.rate, t.c.mrp, t.c.status]
    near = (await ctx.conn.execute(sa.select(*batch_cols).where(*live_rows, *sf, t.c.qty > 0, t.c.expiry >= td, t.c.expiry <= soon)
                                   .order_by(t.c.expiry).limit(300))).all()
    exp_rows = (await ctx.conn.execute(sa.select(*batch_cols).where(*live_rows, *sf, t.c.qty > 0, expired)
                                       .order_by(t.c.expiry).limit(300))).all()

    # reorder: non-expired on-hand per item (per store when filtered) vs store reorder level, else item master level
    group = [t.c.item_id] + ([t.c.store] if store else [])
    onhand = {(str(r[0]), store or ""): _dec(r[-1]) for r in (await ctx.conn.execute(
        sa.select(*group, sa.func.coalesce(sa.func.sum(t.c.qty), 0))
        .where(*live_rows, *sf, sa.or_(t.c.expiry.is_(None), t.c.expiry >= td), sa.func.coalesce(t.c.status, "Available") != "Quarantine")
        .group_by(*group))).all()}
    ient = E(ITEMS)
    item_rows = (await ctx.conn.execute(sa.select(ient.table).where(*rs.base_where(ient), ient.table.c.status == "Active"))).all()
    items = {str(r.id): rs.to_record(r) for r in item_rows}
    ctx.__dict__.setdefault("_items_cache", {}).update(items)
    levels = await _reorder_levels(ctx, store)
    # a store is only judged on items it carries (a batch row, even empty) or has a store-level reorder for
    stocked = {str(i) for (i,) in (await ctx.conn.execute(
        sa.select(t.c.item_id).where(*live_rows, *sf).distinct())).all()} if store else None
    reorder = []
    for iid, it in items.items():
        if it.get("type") not in ("Drug", "Consumable", "Implant", "Reagent"):
            continue
        if stocked is not None and iid not in stocked and (iid, store) not in levels:
            continue
        lvl_rec = levels.get((iid, store)) if store else None
        level = _dec(lvl_rec.get("reorder_level")) if lvl_rec else _dec(it.get("reorder_level"))
        if level <= 0:
            continue
        qty = onhand.get((iid, store or ""), ZERO)
        if qty <= level:
            reorder_qty = _dec(lvl_rec.get("reorder_qty")) if lvl_rec and lvl_rec.get("reorder_qty") else max(level * 2 - qty, level)
            reorder.append({"item_id": iid, "item": item_label(it), "code": it.get("code"), "type": it.get("type"), "uom": it.get("uom"),
                            "store": store, "qty": float(qty), "reorder_level": float(level), "shortfall": float(level - qty),
                            "suggested_qty": float(reorder_qty), "ved": lvl_rec.get("ved_class") if lvl_rec else None})
    reorder.sort(key=lambda r: (r["qty"] > 0, r["qty"] / (r["reorder_level"] or 1)))

    m = stock_moves
    since = now() - timedelta(days=30)
    mf = [m.c.store == store] if store else []
    top = (await ctx.conn.execute(
        sa.select(m.c.item_id, sa.func.sum(-m.c.qty).label("q"), sa.func.count())
        .where(m.c.kind.in_(OUT_KINDS), m.c.created_at >= since, m.c.deleted_at.is_(None), *mf)
        .group_by(m.c.item_id).order_by(sa.desc("q")).limit(10))).all()
    recent = (await ctx.conn.execute(sa.select(m, users.c.name.label("user_name"))
                                     .select_from(m.outerjoin(users, sa.cast(users.c.id, sa.Text) == m.c.created_by))
                                     .where(m.c.deleted_at.is_(None), *mf).order_by(m.c.created_at.desc()).limit(40))).all()
    await items_by_id(ctx, [r.item_id for r in [*near, *exp_rows]] + [r[0] for r in top] + [r.item_id for r in recent])
    cache = ctx.__dict__["_items_cache"]

    def batch(r) -> dict:
        it = cache.get(str(r.item_id))
        return {"id": str(r.id), "item_id": str(r.item_id), "item": item_label(it), "code": (it or {}).get("code"), "store": r.store,
                "batch": r.batch, "expiry": to_json_value(r.expiry), "days_left": (r.expiry - td).days if r.expiry else None,
                "qty": _num(r.qty), "uom": (it or {}).get("uom"), "value": round(_num((r.qty or 0) * (r.rate or 0)), 2), "status": r.status}

    near_l, exp_l = [batch(r) for r in near], [batch(r) for r in exp_rows]
    return {
        "store": store, "stores": STORES, "as_of": now().isoformat(),
        "kpis": {"stock_value": round(sum(s["value"] for s in by_store), 2), "mrp_value": round(sum(s["mrp_value"] for s in by_store), 2),
                 "below_reorder": len(reorder), "near_expiry": len(near_l), "near_expiry_value": round(sum(b["value"] for b in near_l), 2),
                 "expired": len(exp_l), "expired_value": round(sum(b["value"] for b in exp_l), 2)},
        "by_store": by_store, "reorder": reorder[:200], "near_expiry": near_l, "expired": exp_l,
        "top_consumption": [{"item_id": str(r[0]), "item": item_label(cache.get(str(r[0]))), "uom": (cache.get(str(r[0])) or {}).get("uom"),
                             "qty": _num(r[1]), "moves": r[2]} for r in top],
        "recent_moves": [_move_out(r, cache) for r in recent],
    }


def _move_out(r, cache: dict) -> dict:
    it = cache.get(str(r.item_id))
    d = r.data or {}
    return {"id": str(r.id), "at": to_json_value(r.created_at), "item_id": str(r.item_id), "item": item_label(it) if it else r.title,
            "store": r.store, "batch": r.batch, "qty": _num(r.qty), "uom": (it or {}).get("uom"), "kind": r.kind, "ref": r.ref,
            "ref_fqn": d.get("ref_fqn"), "ref_id": d.get("ref_id"), "balance": d.get("balance"),
            "user": getattr(r, "user_name", None) or ("System" if r.created_by == "system" else None)}


@router.get("/items/{item_id}/stock")
async def item_stock(item_id: str, ctx: CtxDep, store: str | None = None, include_empty: bool = False):
    _read(ctx)
    it = await item_or_404(ctx, item_id)
    t = stock
    conds = [t.c.item_id == item_id, t.c.deleted_at.is_(None), *_store_filter(store)]
    if not include_empty:
        conds.append(t.c.qty > 0)
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(t.c.store, t.c.expiry.asc().nulls_last(), t.c.created_at))).all()
    td = today()
    batches, stores_sum = [], {}
    for r in rows:
        exp = r.expiry
        usable = (not exp or exp >= td) and (r.status or "Available") != "Quarantine"
        batches.append({"id": str(r.id), "code": r.code, "store": r.store, "batch": r.batch, "expiry": to_json_value(exp),
                        "days_left": (exp - td).days if exp else None, "qty": _num(r.qty), "rate": _num(r.rate), "mrp": _num(r.mrp),
                        "status": "Expired" if exp and exp < td else (r.status or "Available"), "usable": usable})
        s = stores_sum.setdefault(r.store, {"store": r.store, "qty": 0.0, "usable_qty": 0.0, "value": 0.0, "batches": 0})
        s["qty"] += _num(r.qty)
        s["usable_qty"] += _num(r.qty) if usable else 0
        s["value"] += _num((r.qty or 0) * (r.rate or 0))
        s["batches"] += 1
    m = stock_moves
    moves = (await ctx.conn.execute(sa.select(m, users.c.name.label("user_name"))
                                    .select_from(m.outerjoin(users, sa.cast(users.c.id, sa.Text) == m.c.created_by))
                                    .where(m.c.item_id == item_id, m.c.deleted_at.is_(None), *([m.c.store == store] if store else []))
                                    .order_by(m.c.created_at.desc()).limit(30))).all()
    levels = await find(ctx, "inventory.reorder_levels", status="Active", item=item_id, limit=50)
    return {
        "item": {k: it.get(k) for k in ("id", "code", "name", "type", "generic_name", "strength", "form", "uom", "mrp", "purchase_rate",
                                        "reorder_level", "schedule", "drug_class", "high_alert", "barcode", "status")},
        "batches": batches, "stores": sorted(stores_sum.values(), key=lambda s: s["store"]),
        "fefo_batch": next((b for b in batches if b["usable"] and (not store or b["store"] == store)), None),
        "reorder_levels": [{"store": r.get("store"), "reorder_level": r.get("reorder_level"), "min_level": r.get("min_level"),
                            "max_level": r.get("max_level")} for r in levels],
        "moves": [_move_out(r, {item_id: it}) for r in moves],
    }


@router.get("/moves")
async def moves(ctx: CtxDep, store: str | None = None, kind: str | None = None, item_id: str | None = None, limit: int = 100):
    _read(ctx)
    m = stock_moves
    conds = [m.c.deleted_at.is_(None)]
    if store:
        conds.append(m.c.store == _store(store))
    if kind:
        conds.append(m.c.kind.in_(kind.split(",")))
    if item_id:
        if not is_uuid(item_id):
            raise bad_request("Invalid item")
        conds.append(m.c.item_id == item_id)
    rows = (await ctx.conn.execute(sa.select(m, users.c.name.label("user_name"))
                                   .select_from(m.outerjoin(users, sa.cast(users.c.id, sa.Text) == m.c.created_by))
                                   .where(*conds).order_by(m.c.created_at.desc()).limit(max(1, min(limit, 500))))).all()
    await items_by_id(ctx, [r.item_id for r in rows])
    return [_move_out(r, ctx.__dict__["_items_cache"]) for r in rows]


__all__ = ["router", "stock_in", "stock_out", "transfer", "available", "items_by_id", "item_label", "mark_expired", "CRON",
           "ApiError"]
