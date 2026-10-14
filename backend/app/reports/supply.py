"""Inventory, procurement and pharmacy reports."""

from __future__ import annotations

from datetime import timedelta

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from ..core.util import is_uuid, today
from ..schema import invoices, patients, records, stock, stock_moves
from . import Col, F, Params, Result, category, report
from ._sql import day, f, jnum, jts, pct, rec_live, rows, share, text_between, ts_between

INV = category("Inventory", "Stock valuation, expiry exposure, consumption, ABC / FSN analysis and re-order.", "Warehouse", 16)
PRC = category("Procurement", "Purchase orders, goods receipts, indents and vendor performance.", "Truck", 17)
PHM = category("Pharmacy", "Counter and ward sales, top drugs, returns and the pharmacy takings.", "Pill", 18)

STOCK_ACCESS = ("inventory.stock",)
item = records.alias("item")
ITEM_TYPES = ["Drug", "Consumable", "Surgical", "Implant", "Reagent", "General", "Linen", "Equipment"]


def _item_join(t=stock):
    return t.outerjoin(item, item.c.id == t.c.item_id)


def _stock_filters(p: Params) -> list:
    out = [stock.c.deleted_at.is_(None)]
    if p.get("store"):
        out.append(stock.c.store == p.get("store"))
    if p.get("type"):
        out.append(item.c.data["type"].astext == p.get("type"))
    if p.q:
        out.append(sa.or_(item.c.title.ilike(f"%{p.q}%"), item.c.code.ilike(f"%{p.q}%"), stock.c.batch.ilike(f"%{p.q}%")))
    return out


@report("INV-01", "Stock Valuation by Store", INV,
        "Stock on hand per store — items, batches, quantity, value at purchase rate and at MRP, and how much of it expires within 90 days.",
        [Col("store", "Store"), Col("items", "Items", "number", total=True), Col("batches", "Batches", "number", total=True),
         Col("qty", "Quantity", "number", False, total=True), Col("value", "Value (cost)", "money", total=True),
         Col("mrp_value", "Value (MRP)", "money", total=True), Col("expiring_90", "Expiring ≤ 90 days", "money", total=True),
         Col("share", "Share %", "percent")],
        filters=[F.select("type", "Item type", ITEM_TYPES)], access=STOCK_ACCESS, popular=True, icon="Warehouse", default_period="all",
        chart={"type": "donut", "x": "store", "y": ["value"]})
async def inv_by_store(ctx, p: Params) -> Result:
    val = stock.c.qty * sa.func.coalesce(stock.c.rate, 0)
    soon = sa.and_(stock.c.expiry.isnot(None), stock.c.expiry <= today() + timedelta(days=90))
    stmt = (sa.select(stock.c.store, sa.func.count(sa.distinct(stock.c.item_id)).label("items"), sa.func.count().label("batches"),
                      sa.func.sum(stock.c.qty).label("qty"), sa.func.sum(val).label("value"),
                      sa.func.sum(stock.c.qty * sa.func.coalesce(stock.c.mrp, 0)).label("mrp_value"),
                      sa.func.coalesce(sa.func.sum(val).filter(soon), 0).label("expiring_90"))
            .select_from(_item_join()).where(*_stock_filters(p), stock.c.qty > 0).group_by(stock.c.store).order_by(sa.func.sum(val).desc()))
    out = share(await rows(ctx, stmt), "value")
    return Result(out, [{"label": "Stock value", "value": sum(f(x["value"]) for x in out), "format": "money"},
                        {"label": "MRP value", "value": sum(f(x["mrp_value"]) for x in out), "format": "money"},
                        {"label": "Expiring ≤ 90 days", "value": sum(f(x["expiring_90"]) for x in out), "format": "money"},
                        {"label": "Batches", "value": sum(x["batches"] for x in out), "format": "number"}])


@report("INV-02", "Item-wise Stock Valuation", INV,
        "Every item in stock by store — batches, quantity, cost and MRP value, the nearest expiry and the re-order level.",
        [Col("code", "Item code", "code"), Col("item", "Item"), Col("type", "Type"), Col("store", "Store"), Col("batches", "Batches", "number"),
         Col("qty", "Quantity", "number", total=True), Col("uom", "UoM", default=False), Col("value", "Value (cost)", "money", total=True),
         Col("mrp_value", "Value (MRP)", "money", False, total=True), Col("nearest_expiry", "Nearest expiry", "date"),
         Col("reorder_level", "Re-order level", "number", False)],
        filters=[F.search("Item / batch…"), F.store, F.select("type", "Item type", ITEM_TYPES)], access=STOCK_ACCESS, icon="Boxes",
        default_period="all", handles_q=True)
async def inv_items(ctx, p: Params) -> Result:
    val = stock.c.qty * sa.func.coalesce(stock.c.rate, 0)
    stmt = (sa.select(item.c.code, item.c.title.label("item"), sa.func.max(item.c.data["type"].astext).label("type"), stock.c.store,
                      sa.func.count().label("batches"), sa.func.sum(stock.c.qty).label("qty"), sa.func.max(item.c.data["uom"].astext).label("uom"),
                      sa.func.sum(val).label("value"), sa.func.sum(stock.c.qty * sa.func.coalesce(stock.c.mrp, 0)).label("mrp_value"),
                      sa.func.min(stock.c.expiry).label("nearest_expiry"),
                      sa.func.max(jnum(item.c.data["reorder_level"].astext)).label("reorder_level"))
            .select_from(_item_join()).where(*_stock_filters(p), stock.c.qty > 0)
            .group_by(item.c.code, item.c.title, stock.c.store).order_by(sa.func.sum(val).desc()))
    return Result(await rows(ctx, stmt))


def _expiry_report(expired: bool):
    async def run(ctx, p: Params) -> Result:
        t = today()
        days_ = int((p.get("view") or "Within 90 days").split()[1]) if not expired else 0
        conds = [*_stock_filters(p), stock.c.qty > 0, stock.c.expiry.isnot(None)]
        conds += [stock.c.expiry < t] if expired else [stock.c.expiry >= t, stock.c.expiry <= t + timedelta(days=days_)]
        stmt = (sa.select(item.c.code, item.c.title.label("item"), stock.c.store, stock.c.batch, stock.c.expiry,
                          (stock.c.expiry - t).label("days_left"), stock.c.qty, (stock.c.qty * sa.func.coalesce(stock.c.rate, 0)).label("value"),
                          (stock.c.qty * sa.func.coalesce(stock.c.mrp, 0)).label("mrp_value"))
                .select_from(_item_join()).where(*conds).order_by(stock.c.expiry))
        out = await rows(ctx, stmt)
        tiles = [{"label": "Batches", "value": len(out), "format": "number"},
                 {"label": "Value at cost", "value": sum(f(x["value"]) for x in out), "format": "money"}]
        if not expired:
            tiles += [{"label": "≤ 30 days", "value": sum(f(x["value"]) for x in out if x["days_left"] <= 30), "format": "money"},
                      {"label": "31–90 days", "value": sum(f(x["value"]) for x in out if 30 < x["days_left"] <= 90), "format": "money"}]
        return Result(out, tiles)
    return run


EXP_COLS = [Col("code", "Item code", "code"), Col("item", "Item"), Col("store", "Store"), Col("batch", "Batch", "code"), Col("expiry", "Expiry", "date"),
            Col("days_left", "Days left", "number"), Col("qty", "Quantity", "number", total=True), Col("value", "Value (cost)", "money", total=True),
            Col("mrp_value", "Value (MRP)", "money", False, total=True)]
report("INV-03", "Near-expiry Stock", INV,
       "Batches expiring within 30 / 60 / 90 / 180 days with quantity and value — return to vendor or move to fast-moving locations.",
       EXP_COLS, filters=[F.view(["Within 90 days", "Within 30 days", "Within 60 days", "Within 180 days"]), F.store, F.search("Item / batch…"),
                          F.select("type", "Item type", ITEM_TYPES)],
       access=STOCK_ACCESS, popular=True, icon="CalendarClock", default_period="all", handles_q=True)(_expiry_report(False))
report("INV-04", "Expired Stock on Hand", INV,
       "Batches past their expiry date that still show stock — to quarantine, write off or return.",
       [c for c in EXP_COLS if c.key != "days_left"] + [Col("days_left", "Days since expiry", "number")],
       filters=[F.store, F.search("Item / batch…")], access=STOCK_ACCESS, icon="CalendarX", default_period="all", handles_q=True)(_expiry_report(True))


CONSUME_KINDS = ("ISSUE", "DISPENSE", "CONSUME", "CONSUMPTION")


def _avg_rate():
    return (sa.select(stock.c.item_id, (sa.func.sum(stock.c.qty * stock.c.rate) / sa.func.nullif(sa.func.sum(stock.c.qty), 0)).label("rate"))
            .where(stock.c.deleted_at.is_(None), stock.c.qty > 0).group_by(stock.c.item_id).subquery())


async def _consumption(ctx, p: Params, by_store: bool = True) -> list[dict]:
    m = stock_moves
    ar = _avg_rate()
    qty = -m.c.qty
    conds = [m.c.deleted_at.is_(None), m.c.kind.in_(CONSUME_KINDS), *ts_between(m.c.created_at, p)]
    if p.get("store"):
        conds.append(m.c.store == p.get("store"))
    if p.q:
        conds.append(item.c.title.ilike(f"%{p.q}%"))
    keys = [item.c.code, item.c.title] + ([m.c.store] if by_store else [])
    stmt = (sa.select(item.c.code, item.c.title.label("item"), *([m.c.store] if by_store else []), sa.func.sum(qty).label("qty"),
                      sa.func.sum(qty * sa.func.coalesce(ar.c.rate, jnum(item.c.data["purchase_rate"].astext), 0)).label("value"),
                      sa.func.count(sa.distinct(day(m.c.created_at))).label("issue_days"), sa.func.max(m.c.created_at).label("last_issue"))
            .select_from(m.outerjoin(item, item.c.id == m.c.item_id).outerjoin(ar, ar.c.item_id == m.c.item_id))
            .where(*conds).group_by(*keys).order_by(sa.func.sum(qty * sa.func.coalesce(ar.c.rate, 0)).desc()))
    return await rows(ctx, stmt)


@report("INV-05", "Consumption Report", INV,
        "Quantity and value issued, dispensed or consumed per item and store in the window (from the stock ledger), with issue days.",
        [Col("code", "Item code", "code"), Col("item", "Item"), Col("store", "Store"), Col("qty", "Qty consumed", "number", total=True),
         Col("value", "Value", "money", total=True), Col("issue_days", "Issue days", "number"), Col("last_issue", "Last issue", "datetime", False)],
        filters=[F.period, F.store, F.search("Item…")], access=STOCK_ACCESS, icon="PackageMinus", handles_q=True,
        chart={"type": "bar", "x": "item", "y": ["value"], "horizontal": True})
async def inv_consumption(ctx, p: Params) -> Result:
    out = await _consumption(ctx, p)
    return Result(out, note=None if out else "No issues, dispensing or consumption were posted to the stock ledger in this period.")


@report("INV-06", "ABC Analysis", INV,
        "Items ranked by consumption value: A = top 70% of value, B = next 20%, C = last 10%. Falls back to stock-on-hand value when "
        "nothing was consumed in the period.",
        [Col("rank", "Rank", "number"), Col("code", "Item code", "code"), Col("item", "Item"), Col("value", "Value", "money", total=True),
         Col("share", "Share %", "percent"), Col("cumulative", "Cumulative %", "percent"), Col("abc", "Class", "status")],
        filters=[F.period, F.store], access=STOCK_ACCESS, icon="ChartBarDecreasing", default_period="last_30",
        chart={"type": "donut", "x": "abc", "y": ["value"]})
async def inv_abc(ctx, p: Params) -> Result:
    data = await _consumption(ctx, p, by_store=False)
    note = None
    if not data:
        val = stock.c.qty * sa.func.coalesce(stock.c.rate, 0)
        data = await rows(ctx, sa.select(item.c.code, item.c.title.label("item"), sa.func.sum(val).label("value")).select_from(_item_join())
                          .where(*_stock_filters(p), stock.c.qty > 0).group_by(item.c.code, item.c.title).order_by(sa.func.sum(val).desc()))
        note = "No consumption in the period — classified by stock-on-hand value instead."
    data.sort(key=lambda x: -f(x["value"]))
    tot = sum(f(x["value"]) for x in data) or 1
    cum, out = 0.0, []
    for i, x in enumerate(data, 1):
        cum += f(x["value"])
        c = cum / tot * 100
        out.append({"rank": i, "code": x["code"], "item": x["item"], "value": f(x["value"]), "share": round(f(x["value"]) / tot * 100, 2),
                    "cumulative": round(c, 1), "abc": "A" if c <= 70 or i == 1 else "B" if c <= 90 else "C"})
    tiles = [{"label": f"Class {k}", "value": sum(1 for x in out if x["abc"] == k), "format": "number"} for k in "ABC"]
    chart = {"type": "donut", "x": "abc", "y": [{"key": "value", "label": "Value", "type": "money"}],
             "data": [{"abc": f"Class {k}", "value": sum(x["value"] for x in out if x["abc"] == k)} for k in "ABC"]}
    return Result(out, tiles, note, chart)


@report("INV-07", "FSN Analysis (Fast / Slow / Non-moving)", INV,
        "Items in stock classified by movement in the window — Fast (issued on ≥ 25% of days), Slow (some issues) and Non-moving (none) — "
        "with the stock value tied up in each.",
        [Col("code", "Item code", "code"), Col("item", "Item"), Col("qty_on_hand", "On hand", "number"), Col("stock_value", "Stock value", "money", total=True),
         Col("issue_days", "Issue days", "number"), Col("last_issue", "Last issue", "datetime"), Col("fsn", "Class", "status")],
        filters=[F.period, F.store], access=STOCK_ACCESS, icon="Gauge", default_period="last_30",
        chart={"type": "donut", "x": "fsn", "y": ["stock_value"]})
async def inv_fsn(ctx, p: Params) -> Result:
    moved = {x["code"]: x for x in await _consumption(ctx, p, by_store=False)}
    val = stock.c.qty * sa.func.coalesce(stock.c.rate, 0)
    on_hand = await rows(ctx, sa.select(item.c.code, item.c.title.label("item"), sa.func.sum(stock.c.qty).label("qty_on_hand"),
                                        sa.func.sum(val).label("stock_value")).select_from(_item_join())
                         .where(*_stock_filters(p), stock.c.qty > 0).group_by(item.c.code, item.c.title))
    days_ = max(1, p.days or 30)
    out = []
    for x in on_hand:
        m = moved.get(x["code"]) or {}
        d = int(m.get("issue_days") or 0)
        out.append({**x, "issue_days": d, "last_issue": m.get("last_issue"),
                    "fsn": "Fast" if d >= days_ * 0.25 else "Slow" if d > 0 else "Non-moving"})
    out.sort(key=lambda x: ({"Non-moving": 0, "Slow": 1, "Fast": 2}[x["fsn"]], -f(x["stock_value"])))
    tiles = [{"label": k, "value": sum(f(x["stock_value"]) for x in out if x["fsn"] == k), "format": "money"} for k in ("Fast", "Slow", "Non-moving")]
    chart = {"type": "donut", "x": "fsn", "y": [{"key": "stock_value", "label": "Stock value", "type": "money"}],
             "data": [{"fsn": k, "stock_value": t["value"]} for k, t in zip(("Fast", "Slow", "Non-moving"), tiles, strict=True)]}
    return Result(out, tiles, chart=chart)


@report("INV-08", "Below Re-order Level", INV,
        "Items whose stock across stores has fallen to or below the re-order level — shortfall to the maximum, re-order quantity and lead time.",
        [Col("code", "Item code", "code"), Col("item", "Item"), Col("type", "Type"), Col("on_hand", "On hand", "number"),
         Col("reorder_level", "Re-order level", "number"), Col("shortfall", "Shortfall", "number"), Col("status", "Status", "status")],
        filters=[F.search("Item…"), F.select("type", "Item type", ITEM_TYPES)], access=STOCK_ACCESS, popular=True, icon="PackageX",
        default_period="all", handles_q=True)
async def inv_reorder(ctx, p: Params) -> Result:
    soh = sa.select(stock.c.item_id, sa.func.sum(stock.c.qty).label("qty")).where(stock.c.deleted_at.is_(None)).group_by(stock.c.item_id).subquery()
    rl = jnum(item.c.data["reorder_level"].astext)
    on_hand = sa.func.coalesce(soh.c.qty, 0)
    conds = [item.c.module == "mdm", item.c.entity == "items", item.c.deleted_at.is_(None), item.c.status == "Active", rl.isnot(None), on_hand <= rl]
    if p.get("type"):
        conds.append(item.c.data["type"].astext == p.get("type"))
    if p.q:
        conds.append(item.c.title.ilike(f"%{p.q}%"))
    stmt = (sa.select(item.c.code, item.c.title.label("item"), item.c.data["type"].astext.label("type"), on_hand.label("on_hand"),
                      rl.label("reorder_level"), (rl - on_hand).label("shortfall"))
            .select_from(item.outerjoin(soh, soh.c.item_id == item.c.id)).where(*conds).order_by((rl - on_hand).desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["status"] = "Stock-out" if f(x["on_hand"]) <= 0 else "Below re-order"
    return Result(out, [{"label": "Items to re-order", "value": len(out), "format": "number"},
                        {"label": "Stock-outs", "value": sum(1 for x in out if x["status"] == "Stock-out"), "format": "number"}])


# ====================================================================== procurement

vendor = records.alias("vendor")


def _vjoin(r):
    return r.outerjoin(vendor, sa.cast(vendor.c.id, sa.Text) == r.c.data["vendor"].astext)


PO_STATUSES = ["Draft", "Pending Approval", "Approved", "Sent", "Partially Received", "Closed", "Cancelled"]


@report("PRC-01", "Purchase Order Status", PRC,
        "Purchase orders in the window — vendor, type, delivery store, value, expected delivery and how overdue the open ones are.",
        [Col("po_date", "PO date", "date"), Col("po", "PO no", "code"), Col("vendor", "Vendor"), Col("po_type", "Type"),
         Col("store", "Delivery store"), Col("total", "Value", "money", total=True), Col("expected", "Expected delivery", "date"),
         Col("overdue_days", "Overdue (days)", "number"), Col("status", "Status", "status")],
        filters=[F.period, F.search("PO / vendor…"), F.status(PO_STATUSES)], access=("procurement.purchase_orders",), popular=True,
        icon="FileStack", handles_q=True, chart={"type": "donut", "x": "status", "y": ["total"]})
async def prc_po(ctx, p: Params) -> Result:
    r = records
    exp = r.c.data["expected_delivery"].astext
    open_ = r.c.status.in_(["Approved", "Sent", "Partially Received"])
    overdue = sa.case((sa.and_(open_, sa.cast(sa.func.nullif(exp, ""), sa.Date) < sa.func.current_date()),
                       sa.func.current_date() - sa.cast(sa.func.nullif(exp, ""), sa.Date)), else_=None)
    conds = [*rec_live("procurement", "purchase_orders"), *text_between(r.c.data["po_date"].astext, p)]
    if p.get("status"):
        conds.append(r.c.status == p.get("status"))
    if p.q:
        conds.append(sa.or_(r.c.code.ilike(f"%{p.q}%"), vendor.c.title.ilike(f"%{p.q}%")))
    stmt = (sa.select(r.c.data["po_date"].astext.label("po_date"), r.c.code.label("po"), vendor.c.title.label("vendor"),
                      r.c.data["po_type"].astext.label("po_type"), r.c.data["delivery_store"].astext.label("store"),
                      jnum(r.c.data["total"].astext).label("total"), exp.label("expected"), overdue.label("overdue_days"), r.c.status,
                      r.c.id.label("_id"))
            .select_from(_vjoin(r)).where(*conds).order_by(r.c.data["po_date"].astext.desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["_link"] = f"/m/procurement/purchase_orders?r={x.pop('_id')}"
    return Result(out, [{"label": "POs", "value": len(out), "format": "number"},
                        {"label": "PO value", "value": sum(f(x["total"]) for x in out), "format": "money"},
                        {"label": "Open", "value": sum(1 for x in out if x["status"] in ("Approved", "Sent", "Partially Received")), "format": "number"},
                        {"label": "Overdue", "value": sum(1 for x in out if x["overdue_days"]), "format": "number"},
                        {"label": "Awaiting approval", "value": sum(1 for x in out if x["status"] == "Pending Approval"), "format": "number"}])


@report("PRC-02", "Vendor Performance Scorecard", PRC,
        "Per supplier: POs and value, GRNs received, on-time delivery %, average lead time, quality deviations at inspection and the rating.",
        [Col("vendor", "Vendor"), Col("pos", "POs", "number", total=True), Col("po_value", "PO value", "money", total=True),
         Col("grns", "GRNs", "number", total=True), Col("grn_value", "Received value", "money", total=True),
         Col("fill_rate", "Fill rate %", "percent"), Col("on_time_pct", "On-time %", "percent"), Col("avg_lead_days", "Avg lead (days)", "days"),
         Col("deviations", "Quality deviations", "number", total=True), Col("rating", "Rating", "number")],
        filters=[F.period], access=("procurement.vendors", "procurement.purchase_orders"), icon="Medal",
        chart={"type": "bar", "x": "vendor", "y": ["on_time_pct", "fill_rate"], "horizontal": True})
async def prc_vendors(ctx, p: Params) -> Result:
    po, g = records.alias("po"), records.alias("g")
    pvid = po.c.data["vendor"].astext
    pos = await rows(ctx, sa.select(pvid.label("vid"), sa.func.count().label("pos"),
                                    sa.func.sum(jnum(po.c.data["total"].astext)).label("po_value"))
                     .where(*rec_live("procurement", "purchase_orders", po), po.c.status != "Cancelled",
                            *text_between(po.c.data["po_date"].astext, p)).group_by(pvid))
    rd, pd_, ed = (sa.cast(sa.func.nullif(g.c.data["received_on"].astext, ""), sa.Date), sa.cast(sa.func.nullif(po.c.data["po_date"].astext, ""), sa.Date),
                   sa.cast(sa.func.nullif(po.c.data["expected_delivery"].astext, ""), sa.Date))
    vid = g.c.data["vendor"].astext
    grns = await rows(ctx, sa.select(vid.label("vid"), sa.func.count().label("grns"), sa.func.sum(jnum(g.c.data["total"].astext)).label("grn_value"),
                                     sa.func.count().filter(ed.isnot(None)).label("_with_due"), sa.func.count().filter(rd <= ed).label("_on_time"),
                                     sa.func.avg(rd - pd_).label("avg_lead_days"),
                                     sa.func.count().filter(g.c.data["inspection"].astext.notin_(["Accepted"])).label("deviations"))
                      .select_from(g.outerjoin(po, sa.cast(po.c.id, sa.Text) == g.c.data["purchase_order"].astext))
                      .where(*rec_live("procurement", "grns", g), g.c.status == "Posted", *text_between(g.c.data["received_on"].astext, p))
                      .group_by(vid))
    vendors = {str(r_.id): (r_.title, r_.data) for r_ in (await ctx.conn.execute(sa.select(vendor.c.id, vendor.c.title, vendor.c.data).where(
        *rec_live("procurement", "vendors", vendor)))).all()}
    by: dict[str, dict] = {}
    for x in pos:
        by[x["vid"]] = {"pos": x["pos"], "po_value": x["po_value"], "grns": 0, "grn_value": 0}
    for x in grns:
        d = by.setdefault(x["vid"], {"pos": 0, "po_value": 0})
        d.update(grns=x["grns"], grn_value=x["grn_value"], deviations=x["deviations"], on_time_pct=pct(x["_on_time"], x["_with_due"]),
                 avg_lead_days=round(f(x["avg_lead_days"]), 1) if x["avg_lead_days"] is not None else None)
    out = []
    for vid, d in by.items():
        name, data = vendors.get(vid or "", ("Unknown vendor", {}))
        out.append({"vendor": name, "pos": d.get("pos", 0), "po_value": d.get("po_value"), "grns": d.get("grns", 0), "grn_value": d.get("grn_value"),
                    "fill_rate": pct(d.get("grn_value"), d.get("po_value")), "on_time_pct": d.get("on_time_pct"),
                    "avg_lead_days": d.get("avg_lead_days"), "deviations": d.get("deviations", 0), "rating": (data or {}).get("rating")})
    out.sort(key=lambda x: -f(x["po_value"]))
    return Result(out)


@report("PRC-03", "GRN Register", PRC,
        "Goods received in the window — vendor, PO, store, supplier invoice, value, inspection result and who received it.",
        [Col("received_on", "Received on", "date"), Col("grn", "GRN no", "code"), Col("vendor", "Vendor"), Col("po", "PO no", "code"),
         Col("store", "Store"), Col("invoice_no", "Supplier invoice"), Col("total", "Value", "money", total=True),
         Col("inspection", "Inspection"), Col("status", "Status", "status")],
        filters=[F.period, F.search("GRN / invoice / vendor…"), F.status(["Draft", "Posted", "Cancelled"])], access=("procurement.grns",),
        icon="PackageCheck", handles_q=True)
async def prc_grn(ctx, p: Params) -> Result:
    r = records
    po = records.alias("po")
    conds = [*rec_live("procurement", "grns"), *text_between(r.c.data["received_on"].astext, p)]
    if p.get("status"):
        conds.append(r.c.status == p.get("status"))
    if p.q:
        conds.append(sa.or_(r.c.code.ilike(f"%{p.q}%"), r.c.data["invoice_no"].astext.ilike(f"%{p.q}%"), vendor.c.title.ilike(f"%{p.q}%")))
    stmt = (sa.select(r.c.data["received_on"].astext.label("received_on"), r.c.code.label("grn"), vendor.c.title.label("vendor"),
                      po.c.code.label("po"), r.c.data["store"].astext.label("store"), r.c.data["invoice_no"].astext.label("invoice_no"),
                      jnum(r.c.data["total"].astext).label("total"), r.c.data["inspection"].astext.label("inspection"), r.c.status)
            .select_from(_vjoin(r).outerjoin(po, sa.cast(po.c.id, sa.Text) == r.c.data["purchase_order"].astext))
            .where(*conds).order_by(r.c.data["received_on"].astext.desc()))
    return Result(await rows(ctx, stmt))


@report("PRC-04", "Pending Indents", PRC,
        "Department purchase indents raised or approved but not yet ordered — priority, required-by date and how long they have waited.",
        [Col("indent_date", "Indent date", "date"), Col("indent", "Indent no", "code"), Col("department", "Department"),
         Col("indent_type", "Type"), Col("priority", "Priority"), Col("required_by", "Required by", "date"), Col("lines", "Lines", "number"),
         Col("age_days", "Age (days)", "number"), Col("status", "Status", "status")],
        filters=[F.status(["Raised", "Approved"]), F.department], access=("procurement.indents",), icon="ClipboardPen", default_period="all")
async def prc_indents(ctx, p: Params) -> Result:
    r = records
    dpt = records.alias("dpt")
    conds = [*rec_live("procurement", "indents"), r.c.status.in_([p.get("status")] if p.get("status") else ["Raised", "Approved"])]
    if p.get("department"):
        conds.append(r.c.data["department"].astext == p.get("department"))
    idate = sa.cast(sa.func.nullif(r.c.data["indent_date"].astext, ""), sa.Date)
    stmt = (sa.select(r.c.data["indent_date"].astext.label("indent_date"), r.c.code.label("indent"), dpt.c.title.label("department"),
                      r.c.data["indent_type"].astext.label("indent_type"), r.c.data["priority"].astext.label("priority"),
                      r.c.data["required_by"].astext.label("required_by"), sa.func.jsonb_array_length(sa.func.coalesce(r.c.data["items"], sa.cast("[]", JSONB))).label("lines"),
                      (sa.func.current_date() - idate).label("age_days"), r.c.status)
            .select_from(r.outerjoin(dpt, sa.cast(dpt.c.id, sa.Text) == r.c.data["department"].astext)).where(*conds).order_by(idate))
    return Result(await rows(ctx, stmt))


# ====================================================================== pharmacy

def _disp_base(p: Params):
    r = records
    dt = jts(r.c.data["dispensed_at"].astext)
    conds = [*rec_live("pharmacy", "dispenses"), *ts_between(dt, p)]
    if p.get("store"):
        conds.append(r.c.data["store"].astext == p.get("store"))
    return r, dt, conds


@report("PHM-01", "Pharmacy Sales Register", PHM,
        "Every dispense / pharmacy sale — date, store, patient, prescription, lines, amount, pharmacist and whether it is on a bill.",
        [Col("dispensed_at", "Date & time", "datetime"), Col("dispense", "Dispense no", "code"), Col("store", "Store"), Col("uhid", "UHID", "code"),
         Col("patient", "Patient"), Col("lines", "Lines", "number"), Col("total", "Amount", "money", total=True), Col("billed", "On a bill", "bool"),
         Col("pharmacist", "Pharmacist", default=False), Col("status", "Status", "status")],
        filters=[F.period, F.store, F.search("Dispense / patient…"), F.status(["Dispensed", "Partially Returned", "Returned", "Cancelled"])],
        access=("pharmacy.dispenses",), popular=True, icon="Pill", handles_q=True)
async def phm_sales(ctx, p: Params) -> Result:
    from ..schema import employees

    r, dt, conds = _disp_base(p)
    pat = patients
    if p.get("status"):
        conds.append(r.c.status == p.get("status"))
    if p.q:
        conds.append(sa.or_(r.c.code.ilike(f"%{p.q}%"), pat.c.title.ilike(f"%{p.q}%"), pat.c.code.ilike(f"%{p.q}%")))
    stmt = (sa.select(dt.label("dispensed_at"), r.c.code.label("dispense"), r.c.data["store"].astext.label("store"), pat.c.code.label("uhid"),
                      pat.c.title.label("patient"), sa.func.jsonb_array_length(sa.func.coalesce(r.c.data["items"], sa.cast("[]", JSONB))).label("lines"),
                      jnum(r.c.data["total"].astext).label("total"), r.c.data["invoice"].astext.isnot(None).label("billed"),
                      employees.c.name.label("pharmacist"), r.c.status)
            .select_from(r.outerjoin(pat, pat.c.id == r.c.patient_id).outerjoin(employees, sa.cast(employees.c.id, sa.Text) == r.c.data["pharmacist"].astext))
            .where(*conds).order_by(dt.desc()))
    out = await rows(ctx, stmt)
    return Result(out, [{"label": "Dispenses", "value": len(out), "format": "number"},
                        {"label": "Sales", "value": sum(f(x["total"]) for x in out if x["status"] != "Cancelled"), "format": "money"},
                        {"label": "Not yet billed", "value": sum(f(x["total"]) for x in out if not x["billed"] and x["status"] != "Cancelled"),
                         "format": "money"}])


@report("PHM-02", "Pharmacy Takings by Day & Store", PHM,
        "Pharmacy sales per day and store — dispenses, amount — plus pharmacy bills raised at the counter, for the shift / day summary.",
        [Col("date", "Date", "date"), Col("store", "Store"), Col("dispenses", "Dispenses", "number", total=True),
         Col("amount", "Dispensed value", "money", total=True), Col("bills", "Pharmacy bills", "number", total=True),
         Col("billed", "Billed value", "money", total=True)],
        filters=[F.period, F.store], access=("pharmacy.dispenses",), finance=True, icon="CalendarDays",
        chart={"type": "bar", "x": "date", "y": ["amount", "billed"]})
async def phm_daily(ctx, p: Params) -> Result:
    r, dt, conds = _disp_base(p)
    st = r.c.data["store"].astext
    disp = await rows(ctx, sa.select(day(dt).label("date"), st.label("store"), sa.func.count().label("dispenses"),
                                     sa.func.sum(jnum(r.c.data["total"].astext)).label("amount"))
                      .where(*conds, r.c.status != "Cancelled").group_by(day(dt), st))
    inv = invoices
    bills = await rows(ctx, sa.select(day(inv.c.billed_at).label("date"), sa.func.count().label("bills"), sa.func.sum(inv.c.net).label("billed"))
                       .where(inv.c.type == "PHARMACY", inv.c.deleted_at.is_(None), inv.c.status != "Cancelled", *ts_between(inv.c.billed_at, p))
                       .group_by(day(inv.c.billed_at)))
    out = {(x["date"], x["store"]): {**x, "bills": 0, "billed": 0.0} for x in disp}
    for b in bills:
        out.setdefault((b["date"], "Counter bills"), {"date": b["date"], "store": "Counter bills", "dispenses": 0, "amount": 0.0}).update(b)
    return Result(sorted(out.values(), key=lambda x: (x["date"] or "", x["store"] or ""), reverse=True))


@report("PHM-03", "Top Drugs by Sales", PHM,
        "Drugs ranked by value dispensed in the window — quantity, value, number of dispenses and share of pharmacy sales.",
        [Col("code", "Item code", "code"), Col("item", "Drug"), Col("qty", "Qty", "number", total=True), Col("value", "Value", "money", total=True),
         Col("dispenses", "Dispenses", "number", total=True), Col("share", "Share %", "percent")],
        filters=[F.period, F.store], access=("pharmacy.dispenses",), icon="TrendingUp",
        chart={"type": "bar", "x": "item", "y": ["value"], "horizontal": True})
async def phm_top(ctx, p: Params) -> Result:
    r, dt, conds = _disp_base(p)
    line = sa.func.jsonb_array_elements(r.c.data["items"]).table_valued(sa.column("value", JSONB)).render_derived(name="line")
    lv = line.c.value
    amt = sa.func.coalesce(jnum(lv["amount"].astext), jnum(lv["qty"].astext) * jnum(lv["rate"].astext), 0)
    stmt = (sa.select(item.c.code, sa.func.coalesce(item.c.title, "Unknown").label("item"), sa.func.sum(jnum(lv["qty"].astext)).label("qty"),
                      sa.func.sum(amt).label("value"), sa.func.count(sa.distinct(r.c.id)).label("dispenses"))
            .select_from(r.join(line, sa.true()).outerjoin(item, sa.cast(item.c.id, sa.Text) == lv["item"].astext))
            .where(*conds, r.c.status != "Cancelled", sa.func.jsonb_typeof(r.c.data["items"]) == "array")
            .group_by(item.c.code, item.c.title).order_by(sa.func.sum(amt).desc()).limit(200))
    return Result(share(await rows(ctx, stmt), "value"))


@report("PHM-04", "Pharmacy Returns", PHM,
        "Medicines returned from wards and patients — reason, ward, refund value and the accept / reject decision.",
        [Col("date", "Date", "datetime"), Col("return_no", "Return no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("reason", "Reason"), Col("ward", "Ward"), Col("lines", "Lines", "number"), Col("refund", "Refund value", "money", total=True),
         Col("status", "Status", "status")],
        filters=[F.period, F.status(["Requested", "Accepted", "Rejected"])], access=("pharmacy.returns",), icon="Undo2")
async def phm_returns(ctx, p: Params) -> Result:
    r, pat = records, patients
    w = records.alias("w")
    conds = [*rec_live("pharmacy", "returns"), *ts_between(r.c.created_at, p)]
    if p.get("status"):
        conds.append(r.c.status == p.get("status"))
    stmt = (sa.select(r.c.created_at.label("date"), r.c.code.label("return_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      r.c.data["reason"].astext.label("reason"), w.c.title.label("ward"),
                      sa.func.jsonb_array_length(sa.func.coalesce(r.c.data["items"], sa.cast("[]", JSONB))).label("lines"),
                      jnum(r.c.data["refund_amount"].astext).label("refund"), r.c.status)
            .select_from(r.outerjoin(pat, pat.c.id == r.c.patient_id).outerjoin(w, sa.cast(w.c.id, sa.Text) == r.c.data["ward"].astext))
            .where(*conds).order_by(r.c.created_at.desc()))
    return Result(await rows(ctx, stmt))


__all__ = ["is_uuid"]
