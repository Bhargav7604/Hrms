"""Core platform: registry, auth, generic records, workflows, RBAC, audit, MPI and billing."""

from app.core.registry import all_entities, all_modules, load_registry


def test_all_80_modules_are_valid():
    modules, errors = load_registry(strict=False)
    assert errors == []
    assert sorted(m.no for m in modules) == list(range(1, 81))
    assert len(all_entities()) >= 300
    assert {m.suite for m in all_modules()} == {"front-office", "clinical", "operations", "governance", "specialty", "hr"}


async def test_login_rejects_bad_password(client):
    r = await client.post("/api/auth/login", json={"username": "t_admin", "password": "wrong"})
    assert r.status_code == 401


async def test_meta_is_role_filtered(client, tokens):
    admin = (await client.get("/api/meta", headers=tokens["admin"])).json()
    nurse = (await client.get("/api/meta", headers=tokens["nurse"])).json()
    assert len(admin["modules"]) == 80
    assert 0 < len(nurse["modules"]) < 80
    billing = next(m for m in nurse["modules"] if m["id"] == "billing") if any(m["id"] == "billing" for m in nurse["modules"]) else None
    assert billing is None or billing["access"]["write"] is False


async def test_generic_crud_validation_and_audit(client, tokens):
    h = tokens["admin"]
    bad = await client.post("/api/m/insurance/payers", json={}, headers=h)
    assert bad.status_code == 400
    assert "name" in bad.json()["details"]["fields"]

    r = await client.post("/api/m/insurance/payers", json={"name": "Star Health", "payer_type": "Insurer"}, headers=h)
    assert r.status_code == 201, r.text
    rec = r.json()
    assert rec["code"].startswith("INP-") and rec["status"]

    u = await client.put(f"/api/m/insurance/payers/{rec['id']}", json={"short_name": "STAR"}, headers=h)
    assert u.status_code == 200 and u.json()["short_name"] == "STAR"

    lst = (await client.get("/api/m/insurance/payers", params={"q": "star"}, headers=h)).json()
    assert lst["total"] == 1

    trail = (await client.get(f"/api/m/insurance/payers/{rec['id']}/audit", headers=h)).json()["rows"]
    assert [a["action"] for a in trail][-1] == "create"
    assert any(a["action"] == "update" and a["after"] == {"short_name": "STAR"} for a in trail)


async def test_status_workflow_enforces_transitions(client, tokens):
    h = tokens["admin"]
    pt = (await client.post("/api/patients/register", json={"patient": {"first_name": "Ravi", "last_name": "Kumar", "gender": "Male",
                                                                         "phone": "9000000001", "dob": "1980-01-01"}}, headers=h)).json()
    bad = await client.post(f"/api/m/registration/patients/{pt['id']}/transition", json={"to": "Merged"}, headers=h)
    assert bad.status_code == 409
    need = await client.post(f"/api/m/registration/patients/{pt['id']}/transition", json={"to": "Deceased"}, headers=h)
    assert need.status_code == 400  # date_of_death is required
    ok = await client.post(f"/api/m/registration/patients/{pt['id']}/transition",
                           json={"to": "Deceased", "values": {"date_of_death": "2026-10-01T10:00"}, "note": "test"}, headers=h)
    assert ok.status_code == 200 and ok.json()["status"] == "Deceased"


async def test_registration_masks_id_and_detects_duplicates(client, tokens):
    h = tokens["front_office"]
    body = {"patient": {"first_name": "anitha  ", "last_name": "reddy", "gender": "Female", "phone": "+91 98480 12345",
                        "dob": "1990-05-05", "id_type": "Aadhaar", "id_number": "1234 5678 9012"}}
    first = await client.post("/api/patients/register", json=body, headers=h)
    assert first.status_code == 201, first.text
    p = first.json()
    # structured UHID: 2-digit branch + 2-digit year + 6-digit sequence, still 10 characters
    assert len(p["code"]) == 10 and p["code"].startswith("01") and p["code"].isdigit()
    assert p["id_number"] == "XXXXXXXX9012"
    assert p["phone"] == "9848012345" and p["first_name"] == "Anitha"

    dup = await client.post("/api/patients/register", json=body, headers=h)
    assert dup.status_code == 409 and dup.json()["code"] == "DUPLICATE"
    forced = await client.post("/api/patients/register", json={**body, "force": True}, headers=h)
    assert forced.status_code == 201


async def test_rbac_blocks_writes_outside_role(client, tokens):
    r = await client.post("/api/m/billing/services", json={"name": "X", "category": "MISC", "rate": 1}, headers=tokens["nurse"])
    assert r.status_code == 403
    r = await client.post("/api/m/mdm/departments", json={"name": "X", "dept_type": "Clinical"}, headers=tokens["management"])
    assert r.status_code == 403  # management is read-only by default


async def test_restricted_records_need_break_glass(client, tokens, world):
    h = tokens["admin"]
    pt = (await client.post("/api/patients/register", json={"patient": {"first_name": "Mind", "gender": "Male", "phone": "9000000099"}},
                            headers=h)).json()
    nurse = tokens["nurse"]
    blocked = await client.get("/api/m/psychiatry/therapy_notes", params={"patient_id": pt["id"]}, headers=nurse)
    assert blocked.status_code == 403 and blocked.json()["code"] == "BREAK_GLASS_REQUIRED"
    opened = await client.get("/api/m/psychiatry/therapy_notes", params={"patient_id": pt["id"]},
                              headers={**nurse, "X-Break-Glass": "Patient deteriorating, need psychiatric history"})
    assert opened.status_code == 200
    trail = (await client.get("/api/audit", params={"action": "break_glass"}, headers=h)).json()
    assert trail["total"] >= 1


async def test_charge_capture_bill_and_payment(client, tokens, world):
    h_doc, h_bill = tokens["doctor"], tokens["billing"]
    pt = (await client.post("/api/patients/register", json={"patient": {"first_name": "Bill", "last_name": "Payer", "gender": "Male",
                                                                         "phone": "9000000002"}}, headers=tokens["front_office"])).json()
    order = await client.post("/api/m/orders/orders", json={"patient_id": pt["id"], "category": "LAB", "service_id": world["service"]}, headers=h_doc)
    assert order.status_code == 201, order.text
    acct = (await client.get(f"/api/billing/patients/{pt['id']}/account", headers=h_bill)).json()
    assert acct["totals"]["unbilled"] == 350.0
    assert acct["unbilled"][0]["description"].startswith("Complete Blood Count")

    dep = await client.post("/api/billing/payments", json={"patient_id": pt["id"], "kind": "DEPOSIT", "mode": "CASH", "amount": 100}, headers=h_bill)
    assert dep.status_code == 201
    inv = await client.post("/api/billing/invoices", json={"patient_id": pt["id"], "type": "OP"}, headers=h_bill)
    assert inv.status_code == 201, inv.text
    inv = inv.json()
    assert inv["net"] == 350.0 and inv["paid"] == 100.0 and inv["balance"] == 250.0 and inv["status"] == "Partially Paid"

    over = await client.post("/api/billing/payments", json={"patient_id": pt["id"], "invoice_id": inv["id"], "mode": "CASH", "amount": 999}, headers=h_bill)
    assert over.status_code == 400
    pay = await client.post("/api/billing/payments", json={"patient_id": pt["id"], "invoice_id": inv["id"], "mode": "UPI", "amount": 250,
                                                           "reference": "UTR123"}, headers=h_bill)
    assert pay.status_code == 201
    final = (await client.get(f"/api/m/billing/invoices/{inv['id']}", headers=h_bill)).json()
    assert final["status"] == "Paid" and final["balance"] == 0


async def test_large_discount_requires_approval(client, tokens, world):
    h_bill = tokens["billing"]
    pt = (await client.post("/api/patients/register", json={"patient": {"first_name": "Disc", "gender": "Female", "phone": "9000000003"}},
                            headers=tokens["front_office"])).json()
    await client.post("/api/m/orders/orders", json={"patient_id": pt["id"], "category": "LAB", "service_id": world["service"]}, headers=tokens["doctor"])
    inv = (await client.post("/api/billing/invoices", json={"patient_id": pt["id"], "discount_percent": 50, "discount_reason": "Hardship"},
                             headers=h_bill)).json()
    assert inv["status"] == "Draft"
    inbox = (await client.get("/api/workflow/inbox", headers=tokens["management"])).json()
    appr = next(a for a in inbox if a["subject_id"] == inv["id"])
    d = await client.post(f"/api/workflow/approvals/{appr['id']}/decide", json={"approve": True}, headers=tokens["management"])
    assert d.status_code == 200
    after = (await client.get(f"/api/m/billing/invoices/{inv['id']}", headers=h_bill)).json()
    assert after["status"] == "Final" and after["net"] == 175.0


async def test_posh_cases_cannot_be_opened_by_break_glass(client, tokens):
    r = await client.get("/api/m/ess/posh_complaints", headers={**tokens["doctor"], "X-Break-Glass": "curious about a colleague"})
    assert r.status_code == 403 and r.json()["code"] != "BREAK_GLASS_REQUIRED"
    assert (await client.get("/api/m/ess/posh_complaints", headers=tokens["hr"])).status_code == 200
