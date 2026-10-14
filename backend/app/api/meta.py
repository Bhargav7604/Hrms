from __future__ import annotations

from fastapi import APIRouter

from ..config import settings
from ..core.branches import active_branches, branch_info
from ..core.config_store import apply_field, effective_fields_all
from ..core.permissions import custom_roles, module_levels
from ..core.rbac import ROLES, check_access
from ..core.registry import all_modules, suites
from ..core.security import CtxDep
from ..core.spec import FIELD_TYPE_NAMES

router = APIRouter(prefix="/api/meta", tags=["meta"])


def module_access(user: dict, m) -> dict:
    """Effective access from the roles & permissions matrix: view/edit per record type and page."""
    levels = module_levels(user, m)
    ents = {}
    for e in m.entities:
        r = check_access(user, m, e, "read", "probe")
        w = check_access(user, m, e, "write", "probe")
        lv = levels["entities"][e.key]
        ents[e.key] = {"read": r.ok, "write": w.ok and not r.break_glass and not e.readonly, "break_glass": r.break_glass,
                       "level": lv if r.ok else "none"}
    pages = {k: v for k, v in levels["pages"].items() if v != "none"}
    read = any(v["read"] and not v["break_glass"] for v in ents.values()) or bool(pages)
    write = any(v["write"] for v in ents.values())
    return {"read": read, "write": write, "entities": ents, "pages": list(pages), "page_levels": pages}


def _configure(pub: dict, fc: dict[str, dict[str, dict]]) -> dict:
    """Apply the user's effective field configuration (labels, required, hidden, defaults, masking…)."""
    for e in pub["entities"]:
        cfg = fc.get(e["fqn"])
        if not cfg:
            continue
        e["fields"] = [apply_field(f, cfg.get(f["key"])) for f in e["fields"]]
        if any("order" in f for f in e["fields"]):
            pos = {f["key"]: i for i, f in enumerate(e["fields"])}
            e["fields"].sort(key=lambda f: (f.get("order", pos[f["key"]]), pos[f["key"]]))
    return pub


@router.get("")
async def meta(ctx: CtxDep):
    fc = await effective_fields_all(ctx)
    mods = []
    labels: dict[str, str] = {}
    for m in all_modules():
        for e in m.entities:
            labels[e.fqn] = e.label
        acc = module_access(ctx.user, m)
        if not acc["read"]:
            continue  # strict role-based visibility: only modules the role can use
        pub = _configure(m.public(), fc)
        pub["pages"] = [p for p in pub["pages"] if p["key"] in acc["page_levels"]]
        pub["entities"] = [e for e in pub["entities"] if acc["entities"][e["key"]]["read"]]
        mods.append({**pub, "access": acc})
    allowed = set(ctx.user.get("branches") or [])
    branches = [b for b in await active_branches(ctx.conn) if b["code"] in allowed]
    current = await branch_info(ctx.conn, ctx.branch)
    return {
        "hospital": {"name": settings.hospital_name, "branch": ctx.branch or settings.branch_id,
                     "branch_name": current["name"], "timezone": settings.timezone},
        "branch": ctx.branch or settings.branch_id,
        "branches": branches,
        "suites": suites(),
        "roles": {**ROLES, **{k: v.get("label") or k for k, v in custom_roles().items()}},
        "entity_labels": labels,
        "field_types": FIELD_TYPE_NAMES,
        "modules": mods,
        "user": {k: v for k, v in ctx.user.items() if k not in ("jti", "exp")},
        "features": {"ai_llm": bool(settings.anthropic_api_key), "notify_mode": settings.notify_mode},
    }
