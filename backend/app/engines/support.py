"""Support: an index of every module/page (route, scope, whether you can open it) and support tickets
raised by any signed-in user (stored as `mdm.support_tickets` records; admins work them in MDM)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.config_store import get_settings
from ..core.permissions import level_for, user_perm_role
from ..core.registry import all_modules, suites
from ..core.security import CtxDep
from ._common import create, find, live

router = APIRouter(prefix="/api/support", tags=["support"])

TICKETS = "mdm.support_tickets"
SUITE_BLURB = {
    "front-office": "The front desk and patient access — registration, appointments, queues, insurance intake, counselling, portal and outreach.",
    "clinical": "Care at the bedside and in the clinic — EMR, OPD, IPD, nursing, orders and results, pharmacy, lab, radiology, ER, ICU and theatre.",
    "operations": "Running the hospital — billing and revenue cycle, purchase and stores, assets, support services, finance.",
    "governance": "Insight and control — dashboards, command centre, AI, approvals, integrations, masters, quality, NABH registers and audit.",
    "specialty": "Specialty programmes — oncology, dialysis, maternity, IVF, transplant, psychiatry and more.",
    "hr": "People — employees, rosters and attendance, payroll, training and employee self-service.",
}


@router.get("/modules")
async def module_index(ctx: CtxDep):
    """Every module with its workspaces and record types, route, scope and the caller's access level."""
    prole = user_perm_role(ctx.user)
    out = []
    for m in all_modules():
        items = []
        for p in m.pages:
            items.append({"kind": "workspace", "key": p.key, "label": p.label, "icon": p.icon or m.icon,
                          "route": f"/m/{m.id}/{p.key}", "access": level_for(prole, "page", m.id, p.key)})
        for e in m.entities:
            items.append({"kind": "records", "key": e.key, "label": e.label, "icon": e.icon or m.icon,
                          "route": f"/m/{m.id}/{e.key}", "access": level_for(prole, "entity", m.id, e.key),
                          "restricted": e.restricted, "shared": e.shared})
        out.append({"id": m.id, "no": m.no, "name": m.name, "icon": m.icon, "suite": m.suite, "summary": m.summary,
                    "scope": "Hospital", "items": items})
    return {"suites": [{**s, "description": SUITE_BLURB.get(s["id"])} for s in suites()], "modules": out}


class TicketIn(BaseModel):
    category: str = Field(default="Question", max_length=60)
    severity: Literal["Low", "Normal", "High", "Critical"] = "Normal"
    subject: str = Field(min_length=3, max_length=200)
    description: str = Field(min_length=5, max_length=8000)
    screen: str | None = Field(default=None, max_length=300)


@router.post("/tickets", status_code=201)
async def raise_ticket(body: TicketIn, request: Request, ctx: CtxDep):
    rec = await create(ctx, TICKETS, {
        "category": body.category, "severity": body.severity, "subject": body.subject.strip(),
        "description": body.description.strip(), "screen": (body.screen or "")[:300] or None,
        "reporter_name": ctx.user.get("name"), "reporter_role": ctx.user.get("perm_role") or ctx.role,
        "reporter_user": ctx.user_id, "browser": request.headers.get("user-agent", "")[:200] or None,
    })
    tone = "error" if body.severity in ("High", "Critical") else "info"
    live(ctx, "alerts", {"type": "support_ticket", "roles": ["admin"], "tone": tone,
                         "message": f"Support ticket {rec['code']} ({body.severity}): {body.subject} — {ctx.user.get('name')}"})
    return rec


@router.get("/tickets")
async def my_tickets(ctx: CtxDep, all: bool = False, limit: int = 20):
    """Recent tickets raised by the caller (admins: everyone's with `all=1`)."""
    kw = {} if (all and ctx.role == "admin") else {"reporter_user": ctx.user_id}
    rows = await find(ctx, TICKETS, limit=max(1, min(limit, 100)), sort="-created_at", **kw)
    keep = ("id", "code", "subject", "category", "severity", "status", "screen", "created_at", "resolution", "reporter_name")
    return [{k: r.get(k) for k in keep} for r in rows]


@router.get("/config")
async def support_config(ctx: CtxDep):
    """Where tickets go (shown on the Support page). Admins set `support.recipients` in the settings store."""
    s = await get_settings(ctx, "support", {"recipients": [], "hours": "24×7 for Critical; next working day otherwise"})
    return {"recipients": s.get("recipients") or [], "hours": s.get("hours")}
