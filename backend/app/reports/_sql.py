"""SQL building blocks shared by the curated reports (aggregate in SQL, never per row)."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from ..config import settings
from ..core.util import to_json_value
from ..schema import employees, encounters, invoices, patients, records, services

# Inline the (ZoneInfo-validated) zone name: a bind parameter would differ between SELECT and GROUP BY.
TZ = sa.literal_column("'" + settings.timezone.replace("'", "") + "'")

dept = records.alias("dept")
ward = records.alias("ward")
doc = employees.alias("doc")


def local(col):
    return sa.func.timezone(TZ, col)


def day(col):
    """Hospital-local calendar day of a timestamp column."""
    return sa.func.date(local(col))


def month(col):
    return sa.func.to_char(local(col), "YYYY-MM")


def bucket(col, view: str | None, *, is_date: bool = False):
    expr = col if is_date else local(col)
    if view in ("Month", "month"):
        return sa.func.to_char(expr, "YYYY-MM")
    if view in ("Week", "week"):
        return sa.func.to_char(sa.func.date_trunc("week", expr), "YYYY-MM-DD")
    return sa.func.to_char(expr, "YYYY-MM-DD")


def ts_between(col, p) -> list:
    out = []
    if p.start is not None:
        out.append(col >= p.start)
    if p.end is not None:
        out.append(col < p.end)
    return out


def date_between(col, p) -> list:
    out = []
    if p.d_from:
        out.append(col >= p.d_from)
    if p.d_to:
        out.append(col <= p.d_to)
    return out


def text_between(col_text, p) -> list:
    """For ISO strings stored in JSONB (`data->>'x'`)."""
    out = []
    if p.d_from:
        out.append(col_text >= p.d_from.isoformat())
    if p.d_to:
        out.append(col_text <= f"{p.d_to.isoformat()}T23:59:59")
    return out


def jts(col_text):
    """Cast an ISO string from JSONB to timestamptz (NULL-safe)."""
    return sa.cast(sa.func.nullif(col_text, ""), sa.DateTime(timezone=True))


def jnum(col_text):
    return sa.cast(sa.func.nullif(col_text, ""), sa.Numeric)


def minutes(a, b):
    return sa.extract("epoch", b - a) / 60


def pctile(expr, q: float):
    return sa.func.percentile_cont(q).within_group(expr)


def rec_live(module: str, entity: str, t=records) -> list:
    return [t.c.module == module, t.c.entity == entity, t.c.deleted_at.is_(None)]


def payer_expr(inv=invoices, enc=encounters, pat=patients):
    """Payer category of a bill: the bill's sponsor, else the admission payer, else the patient's payer type."""
    raw = sa.func.coalesce(sa.func.nullif(sa.case((inv.c.payer == "Self", None), else_=inv.c.payer), ""),
                           enc.c.data["payer"].astext, pat.c.data["payer_type"].astext, "Cash")
    return sa.case((raw.in_(["Cash", "Self", "Self / Cash", "Self-pay", "Self pay", "Self Pay"]), "Self / Cash"), else_=raw)


def payer_filter(expr, p) -> list:
    v = p.get("payer")
    return [expr == v] if v else []


def patient_cols(pat=patients) -> list:
    return [pat.c.title.label("patient"), pat.c.code.label("uhid"), pat.c.gender.label("gender"), pat.c.phone.label("mobile"),
            pat.c.data["city"].astext.label("city"), pat.c.data["category"].astext.label("patient_category"),
            sa.func.date_part("year", sa.func.age(pat.c.dob)).label("age")]


def stream_expr(sv=services, enc=encounters, src=None):
    """Revenue stream of a charge line (Inpatient · OP consultations · OP laboratory · OP radiology · Pharmacy · OP procedures · OP other)."""
    from ..schema import charges as ch

    src = src if src is not None else ch.c.source
    return sa.case(
        (enc.c.type.in_(["IPD", "DAYCARE"]), "Inpatient"),
        (sa.or_(sv.c.category == "PHARM", src.like("pharmacy%")), "Pharmacy"),
        (sv.c.category == "CONSULT", "OP consultations"),
        (src == "appointments.appointments", "OP consultations"),
        (sv.c.category == "LAB", "OP laboratory"),
        (sv.c.category == "RAD", "OP radiology"),
        (sv.c.category.in_(["PROC", "OT", "DIALYSIS", "PHYSIO", "DENTAL"]), "OP procedures"),
        else_="OP other services",
    )


async def rows(ctx, stmt) -> list[dict]:
    res = await ctx.conn.execute(stmt)
    return [{k: to_json_value(v) for k, v in m.items()} for m in res.mappings().all()]


async def scalar(ctx, stmt) -> Any:
    return to_json_value((await ctx.conn.execute(stmt)).scalar())


def share(rows_: list[dict], key: str, out: str = "share") -> list[dict]:
    tot = sum(float(r.get(key) or 0) for r in rows_)
    for r in rows_:
        r[out] = round(float(r.get(key) or 0) / tot * 100, 1) if tot else 0.0
    return rows_


def f(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def pct(a: Any, b: Any, digits: int = 1) -> float | None:
    a, b = f(a), f(b)
    return round(a / b * 100, digits) if b else None
