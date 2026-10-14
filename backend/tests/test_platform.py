"""Platform (W1): settings store, field configuration, branches, structured codes, exports, messages,
support tickets and devices & sessions."""

import sqlalchemy as sa

from app.db import engine, system_ctx
from app.engines._common import create
from app.schema import records

from .conftest import PASSWORD


async def _login(client, username: str) -> dict:
    r = await client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


async def test_settings_store_most_specific_wins(client, tokens):
    h = tokens["admin"]
    assert (await client.get("/api/settings/billing.counter", headers=h)).json() == {"namespace": "billing.counter", "values": {}, "scope": "default"}
    r = await client.put("/api/settings/billing.counter", json={"scope": "org", "values": {"print": True, "copies": 1}}, headers=h)
    assert r.status_code == 200
    r = await client.put("/api/settings/billing.counter", json={"scope": "branch", "values": {"copies": 2}}, headers=h)
    eff = (await client.get("/api/settings/billing.counter", headers=tokens["billing"])).json()
    assert eff["values"] == {"print": True, "copies": 2} and eff["scope"] == "branch"
    # only admins write organisation / branch settings; users write their own
    assert (await client.put("/api/settings/billing.counter", json={"scope": "org", "values": {"x": 1}}, headers=tokens["billing"])).status_code == 403
    r = await client.put("/api/settings/billing.counter", json={"scope": "user", "values": {"copies": 3}}, headers=tokens["billing"])
    assert r.status_code == 200
    assert (await client.get("/api/settings/billing.counter", headers=tokens["billing"])).json()["values"]["copies"] == 3
    # prefs
    assert (await client.put("/api/prefs/cols:ipd.admissions", json={"value": ["code", "status"]}, headers=h)).status_code == 200
    assert (await client.get("/api/prefs", headers=h)).json()["prefs"]["cols:ipd.admissions"] == ["code", "status"]


async def test_field_configuration_is_applied_and_enforced(client, tokens):
    h = tokens["admin"]
    scr = (await client.get("/api/fieldconfig/screens/registration", headers=h)).json()
    assert scr["namespace"] == "registration.patients" and scr["fields"]["first_name"]["required"]
    assert scr["settings"]["consult_billing_prompt"] is True
    assert (await client.get("/api/fieldconfig/screens/no.such.screen", headers=h)).status_code == 404
    r = await client.put("/api/fieldconfig/forms/insurance.payers", headers=h, json={
        "scope": "branch", "fields": {"short_name": {"required": True, "label": "Short code"}, "irdai_reg_no": {"visible": False}}})
    assert r.status_code == 200, r.text
    meta = (await client.get("/api/meta", headers=h)).json()
    payers = next(e for m in meta["modules"] for e in m["entities"] if e["fqn"] == "insurance.payers")
    f = {x["key"]: x for x in payers["fields"]}
    assert f["short_name"]["required"] and f["short_name"]["label"] == "Short code"
    assert f["irdai_reg_no"]["hidden"]
    bad = await client.post("/api/m/insurance/payers", json={"name": "Care Health", "payer_type": "Insurer"}, headers=h)
    assert bad.status_code == 400 and "short_name" in bad.json()["details"]["fields"]
    ok = await client.post("/api/m/insurance/payers", json={"name": "Care Health", "payer_type": "Insurer", "short_name": "CARE",
                                                            "irdai_reg_no": "IRDA-123"}, headers=h)
    assert ok.status_code == 201 and ok.json().get("irdai_reg_no") is None  # hidden fields ignore user input
    # system-required fields cannot be hidden; doctors cannot change organisation config
    r = await client.put("/api/fieldconfig/forms/insurance.payers", headers=h, json={"scope": "branch", "fields": {"name": {"visible": False}}})
    assert next(x for s in r.json()["sections"] for x in s["fields"] if x["key"] == "name")["effective"]["visible"] is True
    assert (await client.put("/api/fieldconfig/forms/insurance.payers", headers=tokens["doctor"], json={"scope": "branch", "fields": {}})).status_code == 403
    assert (await client.delete("/api/fieldconfig/forms/insurance.payers?scope=branch", headers=h)).status_code == 200


async def test_structured_codes_and_branch_stamp(client, tokens, world):
    r = await client.post("/api/patients/register", headers=tokens["front_office"], json={"patient": {
        "first_name": "Ravi", "last_name": "Kumar", "gender": "Male", "phone": "9849011111", "dob": "1980-01-01"}})
    assert r.status_code == 201, r.text
    p = r.json()
    assert len(p["code"]) == 10 and p["code"].startswith("01") and p["branch_id"] == "MAIN"
    async with system_ctx() as ctx:
        adm = await create(ctx, "ipd.admissions", {"patient_id": p["id"], "doctor_id": world["doctor"], "department_id": world["dept"],
                                                   "bed_id": world["bed"], "diagnosis": "Fever", "status": "Admitted"})
    assert adm["code"].startswith("01IP") and len(adm["code"]) == 13


async def test_exports_excel_csv_json(client, tokens):
    h = tokens["admin"]
    x = await client.get("/api/m/mdm/departments/export.xlsx", headers=h)
    assert x.status_code == 200 and x.content[:2] == b"PK"  # a real .xlsx (zip)
    c = await client.get("/api/m/mdm/departments/export.csv", headers=h)
    assert c.status_code == 200 and "General Medicine" in c.text
    j = await client.get("/api/m/mdm/departments/export.json?cols=code,name,status", headers=h)
    body = j.json()
    assert [c["key"] for c in body["columns"]] == ["code", "name", "status"] and body["rows"][0]["name"]


async def test_messages_inbox_tasks_and_patient_tag(client, tokens, world):
    doc, nurse = tokens["doctor"], tokens["nurse"]
    people = (await client.get("/api/messages/directory?kind=people&q=nurse", headers=doc)).json()
    nurse_id = next(p["id"] for p in people if p["username"] == "t_nurse")
    async with system_ctx() as ctx:
        pt = await create(ctx, "registration.patients", {"first_name": "Msg", "last_name": "Patient", "gender": "Female",
                                                         "phone": "9000000001", "category": "General"})
    r = await client.post("/api/messages", headers=doc, json={
        "to": [{"type": "user", "id": nurse_id}, {"type": "role", "id": "billing"}], "subject": "Check vitals",
        "body": "Two-hourly vitals tonight @t_nurse", "priority": "URGENT", "patient_id": pt["id"], "is_task": True})
    assert r.status_code == 201, r.text
    mid = r.json()["id"]
    counts = (await client.get("/api/messages/counts", headers=nurse)).json()
    assert counts["unread"] == 1 and counts["mentions"] == 1 and counts["urgent"] == 1 and counts["tasks_open"] == 1
    assert (await client.get("/api/messages?folder=inbox", headers=tokens["billing"])).json()["total"] == 1  # role expanded
    chart = (await client.get(f"/api/messages?patient_id={pt['id']}", headers=nurse)).json()
    assert chart["total"] == 1 and chart["folder"] == "patient"
    one = (await client.get(f"/api/messages/{mid}", headers=nurse)).json()
    assert one["message"]["read"] is True and one["can_reply"]
    assert (await client.post(f"/api/messages/{mid}/reply", json={"body": "On it"}, headers=nurse)).status_code == 201
    r = await client.post(f"/api/messages/{mid}/task", json={"action": "close"}, headers=nurse)
    assert r.json()["task_status"] == "Closed"
    assert (await client.get("/api/messages/counts", headers=doc)).json()["unread"] == 1  # the reply
    # drafts are private; others cannot open someone else's message
    d = (await client.post("/api/messages", json={"subject": "draft", "draft": True}, headers=doc)).json()
    assert (await client.get("/api/messages?folder=drafts", headers=doc)).json()["total"] == 1
    assert (await client.get(f"/api/messages/{d['id']}", headers=nurse)).status_code == 404
    assert (await client.get(f"/api/messages/{mid}", headers=tokens["hr"])).status_code == 403


async def test_support_ticket_and_module_index(client, tokens):
    r = await client.post("/api/support/tickets", headers=tokens["nurse"], json={
        "category": "Something is broken", "severity": "High", "subject": "Printer not printing wristbands",
        "description": "Ward 3 printer shows offline since morning.", "screen": "/m/ipd/bed-board"})
    assert r.status_code == 201 and r.json()["code"].startswith("SUP-")
    mine = (await client.get("/api/support/tickets", headers=tokens["nurse"])).json()
    assert mine[0]["subject"].startswith("Printer") and mine[0]["status"] == "Open"
    assert (await client.get("/api/support/tickets", headers=tokens["doctor"])).json() == []
    idx = (await client.get("/api/support/modules", headers=tokens["nurse"])).json()
    items = [i for m in idx["modules"] for i in m["items"]]
    assert len(idx["modules"]) == 80 and any(i["access"] == "none" for i in items) and any(i["access"] == "edit" for i in items)


async def test_sessions_limit_and_remote_sign_out(client, tokens):
    h1 = await _login(client, "t_hr")
    h2 = await _login(client, "t_hr")
    h3 = await _login(client, "t_hr")  # default limit 2 → the least recently used session is signed out
    sessions = (await client.get("/api/auth/sessions", headers=h3)).json()
    assert sessions["limit"] == 2 and len(sessions["sessions"]) == 2
    assert sum(1 for s in sessions["sessions"] if s["current"]) == 1
    statuses = [(await client.get("/api/auth/me", headers=h)).status_code for h in (tokens["hr"], h1, h2, h3)]
    assert statuses.count(401) == 2 and statuses[-1] == 200
    other = next(s for s in sessions["sessions"] if not s["current"])
    assert (await client.post(f"/api/auth/sessions/{other['id']}/revoke", headers=h3)).status_code == 200
    assert len((await client.get("/api/auth/sessions", headers=h3)).json()["sessions"]) == 1


async def test_branch_header_scopes_lists(client, tokens):
    async with engine.begin() as conn:
        await conn.execute(records.insert().values(
            id="11111111-1111-4111-8111-111111111111", module="mdm", entity="branches", code="CITY", title="City Clinic",
            status="Active", data={"name": "City Clinic", "branch_no": 2}, branch_id="MAIN"))
    from app.core import branches

    branches.forget_branches()
    h = {**tokens["admin"], "X-Branch": "CITY"}
    meta = (await client.get("/api/meta", headers=h)).json()
    assert meta["branch"] == "CITY" and {b["code"] for b in meta["branches"]} == {"MAIN", "CITY"}
    r = await client.post("/api/m/mdm/wards", json={"code": "C1", "name": "City ward", "ward_type": "General"}, headers=h)
    assert r.status_code == 201 and r.json()["branch_id"] == "CITY"
    city = (await client.get("/api/m/mdm/wards", headers=h)).json()
    main = (await client.get("/api/m/mdm/wards", headers=tokens["admin"])).json()
    assert [w["code"] for w in city["rows"]] == ["C1"] and "C1" not in [w["code"] for w in main["rows"]]
    # masters stay shared
    assert (await client.get("/api/m/mdm/departments", headers=h)).json()["total"] >= 1
    # a branch the user may not open is refused for writes
    r = await client.post("/api/m/mdm/wards", json={"name": "X", "ward_type": "General"}, headers={**tokens["front_office"], "X-Branch": "CITY"})
    assert r.status_code == 403
    async with engine.begin() as conn:
        await conn.execute(sa.delete(records).where(records.c.id == "11111111-1111-4111-8111-111111111111"))
    branches.forget_branches()
