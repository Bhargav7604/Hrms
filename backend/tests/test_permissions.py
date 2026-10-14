"""Strict role-based feature visibility: the roles & permissions matrix, custom roles, enforcement."""

import sqlalchemy as sa

from app.core.security import hash_password
from app.core.util import new_id, now
from app.db import engine
from app.schema import users

from .conftest import PASSWORD


def _mods(meta: dict) -> dict:
    return {m["id"]: m for m in meta["modules"]}


async def _login(client, username: str) -> dict:
    r = await client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


async def test_doctor_cannot_open_billing(client, tokens, world):
    meta = (await client.get("/api/meta", headers=tokens["doctor"])).json()
    mods = _mods(meta)
    assert "billing" not in mods  # no Billing desk / IP billing / bills for doctors by default
    assert "doctor-workbench" in mods["opd"]["access"]["pages"]
    assert "nurse-worklist" not in mods["opd"]["access"]["pages"]
    r = await client.get("/api/m/billing/invoices", headers=tokens["doctor"])
    assert r.status_code == 403
    r = await client.get(f"/api/billing/patients/{new_id()}/account", headers=tokens["doctor"])
    assert r.status_code == 403
    # billing staff can
    assert (await client.get("/api/m/billing/invoices", headers=tokens["billing"])).status_code == 200


async def test_front_office_has_no_nursing_station(client, tokens):
    mods = _mods((await client.get("/api/meta", headers=tokens["front_office"])).json())
    assert "nursing" not in mods
    assert "patient-registration" in mods["registration"]["access"]["pages"]
    assert "doctor-workbench" not in (mods.get("opd", {}).get("access", {}).get("pages") or [])
    nurse = _mods((await client.get("/api/meta", headers=tokens["nurse"])).json())
    assert "nursing-station" in nurse["nursing"]["access"]["pages"]
    assert "doctor-workbench" not in nurse["opd"]["access"]["pages"]


async def test_employee_sees_only_self_service(client, world):
    async with engine.begin() as conn:
        await conn.execute(users.insert().values(id=new_id(), username="t_employee", name="Test employee", role="employee",
                                                 password_hash=hash_password(PASSWORD), active=True, created_at=now()))
    h = await _login(client, "t_employee")
    mods = _mods((await client.get("/api/meta", headers=h)).json())
    assert list(mods) == ["ess"]
    assert mods["ess"]["access"]["pages"] == ["self-service"]
    assert mods["ess"]["entities"] == []
    assert (await client.get("/api/m/registration/patients", headers=h)).status_code == 403


async def test_management_is_view_only(client, tokens):
    meta = (await client.get("/api/meta", headers=tokens["management"])).json()
    mods = _mods(meta)
    assert len(mods) == 80
    # view-only everywhere except approvals and the asset register (decommission / disposal decisions)
    allowed = {("workflow", "approvals"), ("assets", "assets")}
    assert not any(e["write"] for m in mods.values() for k, e in m["access"]["entities"].items() if (m["id"], k) not in allowed)
    assert "billing-desk" not in mods["billing"]["access"]["pages"]
    assert "approvals-inbox" in mods["workflow"]["access"]["pages"]
    assert (await client.get("/api/m/mdm/departments", headers=tokens["management"])).status_code == 200
    r = await client.post("/api/m/mdm/departments", json={"name": "X", "dept_type": "Clinical"}, headers=tokens["management"])
    assert r.status_code == 403


async def test_admin_overrides_apply_immediately(client, tokens):
    h = tokens["admin"]
    r = await client.put("/api/admin/roles/doctor", json={"changes": {"entity:billing.invoices": "view"}}, headers=h)
    assert r.status_code == 200, r.text
    assert (await client.get("/api/m/billing/invoices", headers=tokens["doctor"])).status_code == 200
    mods = _mods((await client.get("/api/meta", headers=tokens["doctor"])).json())
    assert mods["billing"]["access"]["entities"]["invoices"] == {"read": True, "write": False, "break_glass": False, "level": "view"}
    assert mods["billing"]["access"]["pages"] == []
    # reset to defaults
    r = await client.delete("/api/admin/roles/doctor/overrides", headers=h)
    assert r.status_code == 200
    assert (await client.get("/api/m/billing/invoices", headers=tokens["doctor"])).status_code == 403
    # only admins manage roles; the admin role itself is locked
    assert (await client.get("/api/admin/roles", headers=tokens["management"])).status_code == 403
    assert (await client.put("/api/admin/roles/admin", json={"changes": {}}, headers=h)).status_code == 400


async def test_custom_role_maps_users_to_a_permission_set(client, tokens):
    h = tokens["admin"]
    r = await client.post("/api/admin/roles", json={"key": "cashier", "label": "Cashier", "base": "billing", "copy_from": "billing"},
                          headers=h)
    assert r.status_code == 201, r.text
    r = await client.put("/api/admin/roles/cashier", json={"changes": {"page:billing.ip-billing": "none",
                                                                       "entity:insurance.claims": "none"}}, headers=h)
    assert r.status_code == 200
    r = await client.post("/api/admin/users", json={"username": "t_cashier", "name": "Test cashier", "role": "cashier",
                                                     "password": PASSWORD}, headers=h)
    assert r.status_code == 201, r.text
    async with engine.connect() as conn:
        row = (await conn.execute(sa.select(users.c.role, users.c.data).where(users.c.username == "t_cashier"))).first()
    assert row.role == "billing" and row.data["perm_role"] == "cashier"  # engines see the base role
    ch = await _login(client, "t_cashier")
    mods = _mods((await client.get("/api/meta", headers=ch)).json())
    assert "billing-desk" in mods["billing"]["access"]["pages"]
    assert "ip-billing" not in mods["billing"]["access"]["pages"]
    assert (await client.get("/api/m/insurance/claims", headers=ch)).status_code == 403
    roles = (await client.get("/api/admin/roles", headers=h)).json()
    assert next(x for x in roles if x["key"] == "cashier")["users"] == 1
    assert (await client.delete("/api/admin/roles/cashier", headers=h)).status_code == 409
