"""Roles & permissions matrix — strict role-based feature visibility.

Every role has a level per workspace page and per record type:  none · view · edit.
- view  = open the page / list and read records (no create, edit, delete or transitions)
- edit  = everything the definition allows (transitions keep their own role lists)
A module is visible when any of its pages or record types is visible.

Levels come from explicit DEFAULT PROFILES per role (below) plus admin overrides stored in
`config_entries` (kind "rbac", namespace "role:<key>"). Admins can also create custom roles
(e.g. Ward In-charge, Cashier): a custom role has a *base* built-in role — engines that check
`ctx.role` see the base role — and its own permission set (`users.data.perm_role`).

Effective levels are cached in-process and refreshed when the Redis version key changes, so an
admin's change applies on the next request on every worker.
"""

from __future__ import annotations

import logging
import time
from functools import lru_cache
from typing import Any

import sqlalchemy as sa

from ..redis import PREFIX, get_redis
from ..schema import config_entries

log = logging.getLogger("vlack.permissions")

LEVELS = ("none", "view", "edit")
RANK = {lv: i for i, lv in enumerate(LEVELS)}
SELF_SERVICE = {"level": "none", "pages": ["self-service"]}

# ---------------------------------------------------------------------------------------------
# Default profiles. Per module: "edit" (all record types + every workspace), "view" (record types
# read-only, no workspaces), or {"level", "pages": [...] | {page: level}, "no_pages": [...],
# "entities": {key: level}}. Modules not listed: none — except record types whose definition lists
# the role in `roles` (e.g. nurses raising housekeeping requests), which default to edit.
# ---------------------------------------------------------------------------------------------

_CLINICAL_SPECIALTY = ["oncology", "dialysis", "maternity", "rehab", "dental", "ivf", "psychiatry", "palliative",
                       "transplant", "pathology", "anaesthesia"]

PROFILES: dict[str, dict[str, Any]] = {
    "doctor": {
        **{m: "edit" for m in ["emr", "orders", "discharge", "icu", "ot", "ipd", "consents", "documents",
                               "telemedicine", "homecare", "caremgmt", "codeblue", "terminology", "devices", "safety",
                               "research", "ai", *_CLINICAL_SPECIALTY]},
        "opd": {"level": "edit", "no_pages": ["nurse-worklist"]},
        "er": {"level": "edit", "no_pages": ["er-billing"]},
        "registration": {"level": "view", "pages": ["patient-search"]},
        "appointments": {"level": "view", "pages": []},
        "queue": {"level": "view", "pages": ["queue-console"], "entities": {"tokens": "edit"}},
        "nursing": "view", "lab": "view", "radiology": "view", "pharmacy": "view", "bloodbank": "view",
        "infection": "view",
        "ess": SELF_SERVICE,
    },
    "nurse": {
        **{m: "edit" for m in ["nursing", "emr", "ipd", "discharge", "orders", "icu", "ot", "codeblue", "devices",
                               "consents", "documents", "homecare", "caremgmt", "cssd", "infection", "transport",
                               "safety", "ai", "roster", *[s for s in _CLINICAL_SPECIALTY if s != "pathology"]]},
        "opd": {"level": "edit", "no_pages": ["doctor-workbench", "my-clinic", "consultation-format"]},
        "er": {"level": "edit", "no_pages": ["er-billing"]},
        "registration": {"level": "view", "pages": ["patient-search"]},
        "appointments": {"level": "view", "pages": []},
        "queue": {"level": "view", "pages": ["queue-console"], "entities": {"tokens": "edit"}},
        "lab": "view", "radiology": "view", "pharmacy": "view", "bloodbank": "view",
        "ess": SELF_SERVICE,
    },
    "front_office": {
        **{m: "edit" for m in ["registration", "appointments", "queue", "referrals", "visitors", "crm", "portal",
                               "notifications", "camps", "tourism", "counseling", "feedback", "mrd", "ambulance"]},
        "consents": {"level": "edit"}, "documents": {"level": "edit"},
        "telemedicine": {"level": "view", "entities": {"teleconsults": "edit", "payment_links": "edit"}},
        "homecare": {"level": "view", "entities": {"enrolments": "edit", "visits": "edit"}},
        "ipd": {"level": "view", "pages": ["bed-board"], "entities": {"admissions": "edit", "bed_requests": "edit"}},
        "insurance": {"level": "view", "entities": {"eligibility": "edit"}},
        "safety": {"level": "none", "entities": {"incidents": "edit"}},
        "ess": SELF_SERVICE,
    },
    "billing": {
        "billing": "edit", "insurance": "edit", "counseling": "edit", "finance": "edit",
        "appointments": {"level": "none", "pages": ["op-billing", "op-bills"]},
        "registration": {"level": "view", "pages": ["patient-search"]},
        "ipd": {"level": "view", "pages": []},
        "dialysis": {"level": "view", "pages": ["dialysis-desk"]},
        "queue": {"level": "view", "pages": ["queue-console"], "entities": {"tokens": "edit"}},
        "ess": SELF_SERVICE,
    },
    "pharmacist": {
        "pharmacy": "edit", "inventory": "edit",
        "registration": {"level": "view", "pages": ["patient-search"]},
        "opd": {"level": "none", "entities": {"prescriptions": "view"}},
        "emr": {"level": "none", "entities": {"allergies": "view", "problems": "view"}},
        "orders": "view",
        "queue": {"level": "view", "pages": ["queue-console"], "entities": {"tokens": "edit"}},
        "safety": {"level": "none", "entities": {"incidents": "edit"}},
        "ess": SELF_SERVICE,
    },
    "lab": {
        "lab": "edit", "bloodbank": "edit", "pathology": "edit",
        "ivf": {"level": "none", "entities": {"embryology": "edit", "cryo_storage": "edit"}},
        "registration": {"level": "view", "pages": ["patient-search"]},
        "orders": "view",
        "queue": {"level": "view", "pages": ["queue-console"], "entities": {"tokens": "edit"}},
        "safety": {"level": "none", "entities": {"incidents": "edit"}},
        "ess": SELF_SERVICE,
    },
    "radiology": {
        "radiology": "edit",
        "registration": {"level": "view", "pages": ["patient-search"]},
        "orders": "view",
        "safety": {"level": "none", "entities": {"incidents": "edit"}},
        "ess": SELF_SERVICE,
    },
    "hr": {
        "employees": "edit", "roster": "edit", "payroll": "edit", "training": "edit", "occhealth": "edit", "ess": "edit",
    },
    "stores": {
        "procurement": "edit", "inventory": "edit", "assets": "view",
        "ess": SELF_SERVICE,
    },
    "quality": {
        **{m: "edit" for m in ["quality", "registers", "committees", "safety", "infection", "mrd", "feedback", "analytics",
                               "aigov", "ai", "occhealth", "consents"]},
        **{m: "view" for m in ["emr", "opd", "ipd", "discharge", "nursing", "orders", "lab", "radiology", "pharmacy", "er",
                               "icu", "ot", "cssd", "codeblue", "devices", "bloodbank", "transport", "dietary",
                               "housekeeping", "linen", "bmw", "firesafety", "documents", "terminology", "visitors"]},
        "ess": SELF_SERVICE,
    },
    "support": {
        **{m: "edit" for m in ["assets", "dietary", "housekeeping", "linen", "bmw", "firesafety", "ambulance", "mortuary",
                               "cssd", "transport", "visitors"]},
        "safety": {"level": "none", "entities": {"incidents": "edit"}},
        "ess": SELF_SERVICE,
    },
    "marketing": {
        **{m: "edit" for m in ["marketing", "crm", "camps", "referrals", "notifications", "tourism"]},
        "feedback": "view",
        "analytics": {"level": "view", "pages": {"analytics": "view"}},
        "ess": SELF_SERVICE,
    },
    "employee": {
        "ess": SELF_SERVICE,
    },
    "management": {
        # view on every record type (see default_level); workspaces: insight and approval screens only
        "workflow": {"level": "view", "pages": {"approvals-inbox": "edit"}, "entities": {"approvals": "edit"}},
        # asset decommission / disposal are management decisions
        "assets": {"level": "view", "pages": {"asset-dashboard": "view"}, "entities": {"assets": "edit"}},
        "ess": SELF_SERVICE,
    },
}

# Insight pages management can open (view) in any module.
MANAGEMENT_PAGES = {"command-center", "analytics", "finance-console", "bed-board", "queue-monitor", "registers",
                    "ai-audit", "er-tracking", "discharge-board", "dashboards", "reports", "asset-dashboard",
                    "dialysis-desk"}


def _spec(role: str, module_id: str) -> dict | None:
    s = PROFILES.get(role, {}).get(module_id)
    if s is None:
        return None
    return {"level": s} if isinstance(s, str) else s


def _min(a: str, b: str) -> str:
    return a if RANK[a] <= RANK[b] else b


@lru_cache(maxsize=20000)
def default_level(role: str, kind: str, module_id: str, key: str) -> str:
    """Built-in default for a role (kind: "page" | "entity")."""
    from .registry import get_module

    if role == "admin":
        return "edit"
    mod = get_module(module_id)
    if not mod:
        return "none"
    spec = _spec(role, module_id)
    if spec is None and role == "management":
        spec = {"level": "view"}
    level = (spec or {}).get("level", "none")
    if kind == "page":
        page = next((p for p in mod.pages if p.key == key), None)
        if not page:
            return "none"
        pages = (spec or {}).get("pages")
        if isinstance(pages, dict) and key in pages:
            return pages[key]
        if isinstance(pages, list) and key in pages:
            return "edit"
        if role == "management":
            return "view" if key in MANAGEMENT_PAGES else "none"
        if pages is None and level == "edit" and key not in (spec or {}).get("no_pages", []):
            return "edit"
        if page.roles and role in page.roles and key not in (spec or {}).get("no_pages", []):
            return "edit"
        return "none"
    ent = mod.entity_map.get(key)
    if not ent:
        return "none"
    explicit = (spec or {}).get("entities", {})
    if key in explicit:
        return explicit[key]
    if ent.d.roles:  # the definition names who operates this record type
        if role in ent.d.roles:
            return "view" if role == "management" else "edit"  # management is view-only unless granted
        if level != "none" and (role in (ent.d.read_roles or []) or role == "management"):
            return _min(level, "view")
        return "none"
    if ent.restricted and role not in mod.roles:
        return "none"
    return level


# ---------------------------------------------------------------- overrides & custom roles (cache)

class _State:
    roles: dict[str, dict] = {}  # key → {label, base, custom, description, perms: {perm_key: level}}
    version: str | None = None
    checked: float = 0.0
    loaded: bool = False


VERSION_KEY = f"{PREFIX}rbac:version"
CHECK_EVERY = 2.0


async def refresh(conn, force: bool = False) -> None:
    """Reload overrides when another worker changed them (cheap: one Redis GET every 2 s)."""
    now_ = time.monotonic()
    if not force and _State.loaded and now_ - _State.checked < CHECK_EVERY:
        return
    _State.checked = now_
    try:
        ver = await get_redis().get(VERSION_KEY)
    except Exception:  # Redis down: keep what we have (or load once)
        ver = _State.version
    if not force and _State.loaded and ver == _State.version:
        return
    rows = (await conn.execute(sa.select(config_entries.c.namespace, config_entries.c.value)
                               .where(config_entries.c.kind == "rbac"))).all()
    roles: dict[str, dict] = {}
    for r in rows:
        if r.namespace.startswith("role:"):
            v = dict(r.value or {})
            v["perms"] = {k: lv for k, lv in (v.get("perms") or {}).items() if lv in LEVELS}
            roles[r.namespace[5:]] = v
    _State.roles, _State.version, _State.loaded = roles, ver, True


async def bump(conn) -> None:
    """Call after changing overrides: reload here, invalidate other workers."""
    try:
        await get_redis().incr(VERSION_KEY)
    except Exception as e:
        log.warning("rbac version bump failed: %s", e)
    _State.loaded = False
    await refresh(conn, force=True)


def custom_roles() -> dict[str, dict]:
    return {k: v for k, v in _State.roles.items() if v.get("custom")}


def base_role(perm_role: str) -> str:
    r = _State.roles.get(perm_role)
    if r and r.get("custom"):
        return r.get("base") or "employee"
    return perm_role


def perm_key(kind: str, module_id: str, key: str) -> str:
    return f"{kind}:{module_id}.{key}"


def level_for(perm_role: str, kind: str, module_id: str, key: str) -> str:
    """Effective level: override → (custom role: base role's default) → built-in default."""
    r = _State.roles.get(perm_role)
    if r:
        lv = r["perms"].get(perm_key(kind, module_id, key))
        if lv:
            return lv
        if r.get("custom"):
            base = r.get("base") or "employee"
            if base == perm_role or _State.roles.get(base, {}).get("custom"):
                return "none"  # custom roles build on built-in roles only
            return level_for(base, kind, module_id, key)
    return default_level(perm_role, kind, module_id, key)


def user_perm_role(user: dict) -> str:
    return user.get("perm_role") or user.get("role") or ""


def entity_level(user: dict, ent) -> str:
    return level_for(user_perm_role(user), "entity", ent.module_id, ent.key)


def page_level(user: dict, module_id: str, page: str) -> str:
    return level_for(user_perm_role(user), "page", module_id, page)


def module_levels(user: dict, mod) -> dict:
    prole = user_perm_role(user)
    pages = {p.key: level_for(prole, "page", mod.id, p.key) for p in mod.pages}
    ents = {e.key: level_for(prole, "entity", mod.id, e.key) for e in mod.entities}
    return {"pages": pages, "entities": ents}


def role_matrix(perm_role: str) -> dict[str, str]:
    """{perm_key: effective level} for every page and record type."""
    from .registry import all_modules

    out = {}
    for m in all_modules():
        for p in m.pages:
            out[perm_key("page", m.id, p.key)] = level_for(perm_role, "page", m.id, p.key)
        for e in m.entities:
            out[perm_key("entity", m.id, e.key)] = level_for(perm_role, "entity", m.id, e.key)
    return out


def defaults_for(perm_role: str) -> dict[str, str]:
    """Defaults a role falls back to (custom role → its base role's effective matrix)."""
    from .registry import all_modules

    r = _State.roles.get(perm_role)
    base = (r or {}).get("base") if r and r.get("custom") else None
    out = {}
    for m in all_modules():
        for kind, keys in (("page", [p.key for p in m.pages]), ("entity", [e.key for e in m.entities])):
            for k in keys:
                out[perm_key(kind, m.id, k)] = level_for(base, kind, m.id, k) if base else default_level(perm_role, kind, m.id, k)
    return out
