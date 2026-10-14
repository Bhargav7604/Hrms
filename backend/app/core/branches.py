"""Branches (multi-site tenancy).

A branch is an `mdm.branches` record; its code (e.g. "MAIN") is what every row stores in
`branch_id`. The active branch of a request comes from the `X-Branch` header and must be one of
the user's allowed branches: admin may open every active branch, other users the list in
`users.data.branches` (default: the home branch from settings).
"""

from __future__ import annotations

import re
import time

import sqlalchemy as sa

from ..config import settings
from ..schema import records

BRANCH_RE = re.compile(r"^[A-Za-z0-9_-]{1,20}$")
_TTL = 30.0
_cache: dict[str, tuple[float, list[dict]]] = {}


async def active_branches(conn) -> list[dict]:
    """[{code, name, no, status}] of active branches, cached for 30 s per process."""
    hit = _cache.get("all")
    if hit and time.monotonic() - hit[0] < _TTL:
        return hit[1]
    rows = (await conn.execute(
        sa.select(records.c.code, records.c.title, records.c.status, records.c.data)
        .where(records.c.module == "mdm", records.c.entity == "branches", records.c.deleted_at.is_(None))
        .order_by(records.c.created_at)
    )).all()
    out: list[dict] = []
    for i, r in enumerate(rows, start=1):
        if r.status and r.status != "Active" or not r.code:
            continue
        data = r.data or {}
        no = data.get("branch_no")
        try:
            no = int(no) if no not in (None, "") else (1 if r.code == settings.branch_id else i)
        except (TypeError, ValueError):
            no = i
        out.append({"code": r.code, "name": r.title or data.get("name") or r.code, "no": no,
                    "city": data.get("city"), "state": data.get("state"), "gstin": data.get("gstin")})
    if not any(b["code"] == settings.branch_id for b in out):
        out.insert(0, {"code": settings.branch_id, "name": settings.hospital_name, "no": 1})
    _cache["all"] = (time.monotonic(), out)
    return out


def forget_branches() -> None:
    _cache.clear()


async def allowed_branches(conn, role: str, user_data: dict | None) -> list[str]:
    codes = [b["code"] for b in await active_branches(conn)]
    if role == "admin":
        return codes
    assigned = [b for b in ((user_data or {}).get("branches") or []) if b in codes]
    return assigned or [settings.branch_id]


async def branch_info(conn, code: str | None) -> dict:
    code = code or settings.branch_id
    for b in await active_branches(conn):
        if b["code"] == code:
            return b
    return {"code": code, "name": code, "no": 1}
