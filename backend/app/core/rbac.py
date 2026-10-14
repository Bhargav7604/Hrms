"""Role catalogue and access checks (role-based + attribute-based for restricted records)."""

from __future__ import annotations

from dataclasses import dataclass

ROLES: dict[str, str] = {
    "admin": "System Administrator",
    "management": "Management (CEO / CFO / CMO)",
    "doctor": "Doctor",
    "nurse": "Nurse",
    "front_office": "Front Office",
    "billing": "Billing & Insurance",
    "pharmacist": "Pharmacist",
    "lab": "Laboratory",
    "radiology": "Radiology",
    "hr": "HR & Payroll",
    "stores": "Purchase & Stores",
    "quality": "Quality & Patient Safety",
    "support": "Support Services",
    "marketing": "Marketing & CRM",
    "employee": "Employee (self-service only)",
}

CLINICAL_ROLES = {"doctor", "nurse"}


@dataclass
class Access:
    ok: bool
    break_glass: bool = False
    reason: str | None = None


def check_access(user: dict, mod, ent=None, mode: str = "read", break_glass: str | None = None) -> Access:
    """`mod`/`ent` are resolved registry objects. The roles & permissions matrix (core.permissions)
    decides: view → read, edit → read + write. Restricted entities (psychiatry notes, POSH cases)
    additionally need the role to be listed on the definition; clinicians/admins may "break the
    glass" with a recorded reason, which is audited.
    Without `ent`: module-level — read = any page or record type visible, write = any record type editable.
    """
    from .permissions import entity_level, module_levels

    role = user.get("role")
    if ent is not None:
        lv = entity_level(user, ent)
        if ent.restricted:
            roles = (ent.roles if ent.roles else None) or mod.roles
            if role in roles:
                if lv == "none":
                    return Access(False, reason="Your role does not have access to these records")
                if mode != "read" and lv != "edit":
                    return Access(False, reason="View-only access — your role cannot change these records")
                return Access(True)
            if role in CLINICAL_ROLES | {"admin"} and getattr(ent.d, "break_glass", True):
                if break_glass:
                    return Access(True, break_glass=True)
                return Access(False, reason="BREAK_GLASS_REQUIRED")
            return Access(False, reason="Restricted record")
        if lv == "edit" or (mode == "read" and lv == "view"):
            return Access(True)
        if lv == "view":
            return Access(False, reason="View-only access — your role cannot change these records")
        return Access(False, reason="Your role does not have access to these records")
    levels = module_levels(user, mod)
    if mode == "read":
        ok = any(v != "none" for v in (*levels["pages"].values(), *levels["entities"].values()))
    else:
        ok = any(v == "edit" for v in levels["entities"].values())
    return Access(ok, reason=None if ok else "Your role does not have access to this module")


def require_page(ctx, module_id: str, page: str, mode: str = "read") -> None:
    """Engines: refuse a workspace endpoint when the role cannot open that page
    (`mode="edit"` for actions). Example: `require_page(ctx, "billing", "billing-desk", "edit")`."""
    from .permissions import page_level
    from .util import forbidden

    lv = page_level(ctx.user, module_id, page)
    if lv == "none" or (mode != "read" and lv != "edit"):
        raise forbidden("Your role cannot use this workspace" if lv == "none" else "View-only access to this workspace")
