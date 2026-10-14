"""Workflow Builder engine: configurable multi-step approvals (discounts, refunds, purchase
orders, credit notes, stock adjustments, leave …) defined as data in workflow.flows."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter
from pydantic import BaseModel

from ..core.audit import audit
from ..core.registry import get_entity
from ..core.security import CtxDep
from ..core.util import ApiError, conflict, forbidden, not_found, now
from ..schema import approvals
from ._common import create, find, get, live, update

router = APIRouter(prefix="/api/workflow", tags=["workflow"])

# flow_key → callbacks(ctx, approval, approved: bool)
_deciders: dict[str, list[Callable[..., Awaitable[None]]]] = defaultdict(list)


def on_decided(flow_key: str):
    def deco(fn):
        _deciders[flow_key].append(fn)
        return fn

    return deco


async def _flow(ctx, flow_key: str, amount: float | None) -> dict | None:
    for f in await find(ctx, "workflow.flows", status="Active", flow_key=flow_key, limit=20):
        if f.get("min_amount") in (None, "") or (amount or 0) >= float(f["min_amount"]):
            return f
    return None


def _steps(flow: dict) -> list[dict]:
    steps = sorted(flow.get("steps") or [], key=lambda s: s.get("step_no") or 0)
    return steps or [{"step_no": 1, "approver_role": "management"}]


async def request_approval(ctx, flow_key: str, *, subject_fqn: str, subject_id: str, amount: float | None,
                           summary: str, force: bool = False) -> dict | None:
    """Open an approval if an active flow applies; returns None when no approval is needed.
    `force=True` creates a single-step management approval even without a configured flow."""
    if not get_entity("workflow.approvals"):
        return None
    flow = await _flow(ctx, flow_key, amount)
    if not flow and not force:
        return None
    step = _steps(flow)[0] if flow else {"step_no": 1, "approver_role": "management"}
    mod, ent = subject_fqn.split(".")
    rec = await create(ctx, "workflow.approvals", {
        "flow": flow_key, "subject_module": mod, "subject_entity": ent, "subject_id": subject_id,
        "summary": summary, "step": step.get("step_no") or 1, "approver_role": step.get("approver_role") or "management",
        "amount": amount, "requested_by": ctx.user.get("name"), "status": "Pending",
    })
    live(ctx, "approvals", {"id": rec["id"], "role": rec.get("approver_role")})
    return rec


async def pending_for(ctx, subject_id: str) -> dict | None:
    rows = await find(ctx, "workflow.approvals", status="Pending", subject_id=subject_id, limit=1)
    return rows[0] if rows else None


@router.get("/inbox")
async def inbox(ctx: CtxDep, status: str = "Pending"):
    t = approvals
    conds = [t.c.deleted_at.is_(None), t.c.status == status]
    if ctx.role != "admin":
        conds.append(t.c.data["approver_role"].astext == ctx.role)
    rows = (await ctx.conn.execute(sa.select(t).where(*conds).order_by(t.c.created_at.desc()).limit(200))).all()
    from ..core.records import to_record

    return [to_record(r) for r in rows]


@router.get("/inbox/count")
async def inbox_count(ctx: CtxDep):
    t = approvals
    conds = [t.c.deleted_at.is_(None), t.c.status == "Pending"]
    if ctx.role != "admin":
        conds.append(t.c.data["approver_role"].astext == ctx.role)
    n = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(t).where(*conds))).scalar_one()
    return {"pending": n}


class DecideIn(BaseModel):
    approve: bool
    comments: str | None = None


@router.post("/approvals/{aid}/decide")
async def decide(aid: str, body: DecideIn, ctx: CtxDep):
    a = await get(ctx, "workflow.approvals", aid)
    if not a:
        raise not_found("Approval not found")
    if a.get("status") != "Pending":
        raise conflict(f"Already {a.get('status')}")
    if ctx.role != "admin" and ctx.role != a.get("approver_role"):
        raise forbidden(f"This step needs a {a.get('approver_role')} approver")
    if not body.approve and not (body.comments or "").strip():
        raise ApiError(400, "Give a reason when rejecting")
    decided = await update(ctx, "workflow.approvals", aid, {
        "status": "Approved" if body.approve else "Rejected", "decided_by": ctx.user.get("name"),
        "decided_at": now().isoformat(), "comments": body.comments,
    })
    await audit(ctx, "approval.decide", module="workflow", entity="approvals", record=decided,
                after={"approve": body.approve, "flow": a.get("flow")}, note=body.comments)
    # next step?
    if body.approve:
        flow = await _flow(ctx, a["flow"], a.get("amount"))
        if flow:
            nxt = [s for s in _steps(flow) if (s.get("step_no") or 0) > (a.get("step") or 1)]
            if nxt:
                s = nxt[0]
                rec = await create(ctx, "workflow.approvals", {
                    **{k: a.get(k) for k in ("flow", "subject_module", "subject_entity", "subject_id", "summary", "amount", "requested_by")},
                    "step": s.get("step_no"), "approver_role": s.get("approver_role") or "management", "status": "Pending",
                })
                live(ctx, "approvals", {"id": rec["id"], "role": rec.get("approver_role")})
                return {"approval": decided, "next_step": rec}
    for fn in _deciders.get(a["flow"], []):
        await fn(ctx, decided, body.approve)
    live(ctx, "approvals", {"id": aid, "decided": True})
    return {"approval": decided, "final": True}


__all__ = ["router", "request_approval", "on_decided", "pending_for", "Any"]
