"""Test harness: a dedicated PostgreSQL database (vlack_hrms_test) and Redis DB 15.

Run:  .venv/bin/pytest -q
The schema is migrated once per session and every table is truncated before each test module.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://vlack:vlack@127.0.0.1:5432/vlack_hrms_test")
os.environ.setdefault("REDIS_URL", "redis://127.0.0.1:6379/15")
os.environ["ENV"] = "development"
os.environ["AUTO_MIGRATE"] = "false"

import logging  # noqa: E402

import pytest  # noqa: E402
import sqlalchemy as sa  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.core.security import hash_password  # noqa: E402
from app.core.util import new_id, now  # noqa: E402
from app.db import engine, system_ctx  # noqa: E402
from app.engines._common import create  # noqa: E402
from app.main import app, run_migrations  # noqa: E402
from app.schema import ENTITY_TABLES, users  # noqa: E402

logging.getLogger("httpx").setLevel(logging.WARNING)

PASSWORD = "Test-pass-123"
ROLES = ["admin", "doctor", "nurse", "front_office", "billing", "management", "hr"]
PLATFORM_TABLES = ["config_entries", "user_sessions", "messages", "message_recipients"]


@pytest.fixture(scope="session", autouse=True)
def _migrate():
    run_migrations()


@pytest.fixture(scope="module")
async def world():
    """Fresh database with users for every role and a minimal set of masters."""
    async with engine.begin() as conn:
        await conn.execute(sa.text(f"TRUNCATE {', '.join([*ENTITY_TABLES, 'users', 'audit_log', 'sequences', *PLATFORM_TABLES])}"))
    from app.core import branches, permissions
    from app.redis import get_redis

    await get_redis().flushdb()
    permissions._State.loaded = False
    branches.forget_branches()
    ids: dict = {}
    async with system_ctx() as ctx:
        dept = await create(ctx, "mdm.departments", {"code": "GMED", "name": "General Medicine", "dept_type": "Clinical", "status": "Active"})
        ward = await create(ctx, "mdm.wards", {"code": "M1", "name": "Medical Ward", "ward_type": "General", "status": "Active"})
        doc = await create(ctx, "employees.employees", {"name": "Dr. Test Doctor", "category": "Doctor", "designation": "Consultant",
                                                         "phone": "9876543210", "department_id": dept["id"], "consult_fee": 700, "status": "Active"})
        svc = await create(ctx, "billing.services", {"code": "LAB-CBC", "name": "Complete Blood Count", "category": "LAB", "rate": 350, "status": "Active"})
        await create(ctx, "billing.services", {"code": "CONS-OPD", "name": "OPD consultation", "category": "CONSULT", "rate": 600, "status": "Active"})
        bed = await create(ctx, "ipd.beds", {"code": "M1-01", "bed_no": "M1-01", "ward_id": ward["id"], "category": "General", "rate": 1500, "status": "Vacant"})
        for role in ROLES:
            await ctx.conn.execute(users.insert().values(
                id=new_id(), username=f"t_{role}", name=f"Test {role}", role=role, password_hash=hash_password(PASSWORD),
                employee_id=doc["id"] if role == "doctor" else None, active=True, created_at=now()))
        ids.update(dept=dept["id"], ward=ward["id"], doctor=doc["id"], service=svc["id"], bed=bed["id"])
    return ids


@pytest.fixture(scope="module")
async def client(world):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(scope="module")
async def tokens(client):
    out = {}
    for role in ROLES:
        r = await client.post("/api/auth/login", json={"username": f"t_{role}", "password": PASSWORD})
        assert r.status_code == 200, r.text
        out[role] = {"Authorization": f"Bearer {r.json()['token']}"}
    return out
