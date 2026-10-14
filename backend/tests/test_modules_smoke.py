"""Smoke-test every record type of all 80 modules through the public API.

For each entity a valid payload is generated from its definition (required fields plus a few
optional ones, references resolved to real records), then: create → read → list → first
transition that needs no extra input. Business-rule rejections from engine hooks (4xx with a
message) are allowed; server errors (5xx) and generic-engine failures are not.
"""

from datetime import date
from typing import Any

import pytest

from app.core.registry import all_entities, get_entity

pytestmark = pytest.mark.asyncio(loop_scope="session")

SAMPLE_PHONE = "9876500000"


def _value(f, refs: dict[str, str | None]) -> Any:
    t = f.type
    if t in ("number", "rating"):
        lo = f.min if f.min is not None else 1
        return int(lo) if t == "rating" else max(lo, 1) if f.max is None or f.max >= 1 else lo
    if t in ("currency",):
        return 100.0
    if t == "percent":
        return 10
    if t == "date":
        return date.today().isoformat()
    if t == "datetime":
        return f"{date.today().isoformat()}T10:00"
    if t == "time":
        return "10:00"
    if t == "select":
        return f.options[0]
    if t == "multiselect":
        return f.options[:1]
    if t == "tags":
        return ["test"]
    if t == "boolean":
        return True
    if t == "phone":
        return SAMPLE_PHONE
    if t == "email":
        return "test@example.com"
    if t == "ref":
        return refs.get(f.ref)
    if t == "lines":
        return [{sf.key: _value(sf, refs) for sf in (f.fields or []) if sf.required or sf.type in ("number", "currency")}]
    if t == "signature":
        return "data:image/png;base64,iVBORw0KGgo="
    if t == "file":
        return None
    if t == "textarea":
        return "Smoke test note"
    return f"Test {f.key}"


async def _ensure_ref(client, h, fqn: str, refs: dict, depth: int = 0) -> str | None:
    if fqn in refs and refs[fqn]:
        return refs[fqn]
    mod, ent_key = fqn.split(".")
    existing = (await client.get(f"/api/lookup/{mod}/{ent_key}", params={"limit": 1}, headers=h)).json()
    if isinstance(existing, list) and existing:
        refs[fqn] = existing[0]["id"]
        return refs[fqn]
    ent = get_entity(fqn)
    if depth > 2 or ent is None or ent.readonly:
        refs[fqn] = None
        return None
    payload = await _payload(client, h, ent, refs, depth + 1)
    r = await client.post(f"/api/m/{mod}/{ent_key}", json=payload, headers=h)
    refs[fqn] = r.json().get("id") if r.status_code == 201 else None
    return refs[fqn]


async def _payload(client, h, ent, refs: dict, depth: int = 0) -> dict:
    body: dict[str, Any] = {}
    for f in ent.fields:
        if f.readonly or f.type == "file":
            continue
        wanted = f.required or f.type in ("select", "number", "currency", "date")
        if not wanted:
            continue
        if f.type == "ref":
            await _ensure_ref(client, h, f.ref, refs, depth)
        if f.type == "lines":
            for sf in f.fields or []:
                if sf.type == "ref":
                    await _ensure_ref(client, h, sf.ref, refs, depth)
        v = _value(f, refs)
        if v is not None:
            body[f.key] = v
    if ent.code_editable:
        body["code"] = f"T{abs(hash(ent.fqn)) % 10**8}"
    return body


async def test_every_entity_round_trips(client, tokens, world):
    h = tokens["admin"]
    pt = (await client.post("/api/patients/register", json={"force": True, "patient": {
        "first_name": "Smoke", "last_name": "Patient", "gender": "Female", "phone": "9000011111", "dob": "1985-03-03"}}, headers=h)).json()
    refs: dict[str, str | None] = {"registration.patients": pt["id"], "employees.employees": world["doctor"],
                                   "mdm.departments": world["dept"], "mdm.wards": world["ward"], "billing.services": world["service"],
                                   "ipd.beds": world["bed"]}
    results = {"created": 0, "rejected": [], "server_errors": [], "skipped": 0}
    for ent in all_entities():
        mod, key = ent.module_id, ent.key
        listed = await client.get(f"/api/m/{mod}/{key}", headers=h if not ent.restricted else {**h, "X-Break-Glass": "smoke test"})
        if listed.status_code >= 500:
            results["server_errors"].append(f"LIST {ent.fqn}: {listed.text[:200]}")
        if ent.readonly:
            results["skipped"] += 1
            continue
        payload = await _payload(client, h, ent, refs)
        if ent.d.patient:
            payload["patient_id"] = pt["id"]
        r = await client.post(f"/api/m/{mod}/{key}", json=payload,
                              headers=h if not ent.restricted else {**h, "X-Break-Glass": "smoke test"})
        if r.status_code >= 500:
            results["server_errors"].append(f"CREATE {ent.fqn}: {r.text[:300]}")
            continue
        if r.status_code != 201:
            results["rejected"].append(f"{ent.fqn}: {r.status_code} {r.json().get('message')} {r.json().get('details')}")
            continue
        results["created"] += 1
        rec = r.json()
        refs.setdefault(ent.fqn, rec["id"])
        one = await client.get(f"/api/m/{mod}/{key}/{rec['id']}", headers={**h, "X-Break-Glass": "smoke test"})
        assert one.status_code == 200, f"{ent.fqn}: {one.text[:200]}"
        for t in one.json().get("_transitions", []):
            if t.get("require") or t.get("fields"):
                continue
            tr = await client.post(f"/api/m/{mod}/{key}/{rec['id']}/transition", json={"to": t["to"]},
                                   headers={**h, "X-Break-Glass": "smoke test"})
            if tr.status_code >= 500:
                results["server_errors"].append(f"TRANSITION {ent.fqn} → {t['to']}: {tr.text[:300]}")
            break
    total = results["created"] + len(results["rejected"])
    print(f"\ncreated {results['created']}/{total} writable entities, skipped {results['skipped']} engine-managed")
    for line in results["rejected"]:
        print("  rejected:", line[:240])
    assert not results["server_errors"], "\n".join(results["server_errors"])
    assert results["created"] >= total * 0.9, f"too many rejections: {len(results['rejected'])}"
