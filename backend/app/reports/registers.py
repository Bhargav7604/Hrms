"""Auto-generated register reports — one per record type, built from the module metadata.

Filters come from the entity's date_field (else the created date), statuses, patient link and its
doctor / department / ward / first select field; columns from the entity's list (default) plus every
other scalar field (EXTRA, off until chosen in the column chooser)."""

from __future__ import annotations

from collections import Counter

import sqlalchemy as sa

from ..core import records as rs
from ..core.registry import Entity, all_entities, get_module
from ..core.spec import SUITES
from ..core.util import is_uuid
from . import Col, F, Filter, Params, Report, Result, category, register
from ._sql import date_between, text_between, ts_between

ROW_CAP = 5000
HEAVY = {"textarea", "lines", "signature", "file"}
SUITE_CATEGORY = {
    "front-office": ("Front office registers", "Registration, appointments, insurance, CRM, portal and notification records."),
    "clinical": ("Clinical registers", "Every clinical record type — EMR, OPD/IPD, orders, nursing, ICU, OT, ER and more."),
    "operations": ("Operations registers", "Billing, procurement, inventory, assets, support services and finance records."),
    "governance": ("Governance registers", "Analytics, AI, workflow, integration, quality, safety, MRD and committee records."),
    "specialty": ("Specialty registers", "Oncology, dialysis, maternity, IVF, transplant, pathology and other specialty records."),
    "hr": ("HR registers", "Employee master, roster and attendance, payroll, training and self-service records."),
}
SUITE_ORDER = {s["id"]: s["no"] for s in SUITES}

COL_TYPE = {"currency": "money", "number": "number", "percent": "number", "rating": "number", "date": "date",
            "datetime": "datetime", "boolean": "bool"}


def _date_col(ent: Entity) -> tuple[str, str]:
    """(key, label) of the register's date column."""
    if ent.date_field:
        f = ent.field_map.get(ent.date_field)
        return ent.date_field, f.label if f else ent.date_field.replace("_", " ").capitalize()
    return "created_at", "Created"


def _col_for(ent: Entity, key: str, default: bool) -> list[Col]:
    if key == "code":
        return [Col("code", f"{ent.singular} no.", "code", default)]
    if key == "status":
        return [Col("status", "Status", "status", default)]
    if key == "title":
        return [Col("title", "Title", "text", default)]
    if key in ("created_at", "updated_at"):
        return [Col(key, "Created" if key == "created_at" else "Updated", "datetime", default)]
    if key == "patient_id":
        return [Col("patient", "Patient", "text", default), Col("uhid", "UHID", "code", default)]
    f = ent.field_map.get(key)
    if not f:
        return []
    if key in ("employee_id", "encounter_id"):
        return [Col(key, f.label, "text", default)]
    return [Col(key, f.label, COL_TYPE.get(f.type, "text"), default, total=f.type == "currency")]


def _pick(ent: Entity, *kinds: str, keys: tuple[str, ...] = ()) -> str | None:
    for f in ent.fields:
        if f.kind in kinds or f.key in keys:
            return f.key
    return None


def _make(ent: Entity) -> Report:
    mod = get_module(ent.module_id)
    dkey, dlabel = _date_col(ent)
    cols: list[Col] = [Col("code", f"{ent.singular} no.", "code")]
    seen = {"code"}
    if dkey not in ent.list_cols:
        cols += [Col(dkey, dlabel, "date" if (ent.field_map.get(dkey) and ent.field_map[dkey].type == "date") else "datetime")]
        seen.add(dkey)
    for k in ent.list_cols:
        if k in seen:
            continue
        seen.add(k)
        cols += _col_for(ent, k, True)
    for f in ent.fields:
        if f.key in seen or f.type in HEAVY or f.hidden or f.key == "photo":
            continue
        seen.add(f.key)
        cols += _col_for(ent, f.key, False)
    if "created_at" not in seen:
        cols.append(Col("created_at", "Created", "datetime", False))
    if ent.statuses and "status" not in seen:
        cols.append(Col("status", "Status", "status", True))

    filters: list[Filter] = [F.period, F.search(f"{ent.singular} no. / name…")]
    if ent.statuses:
        filters.append(F.status(list(ent.statuses)))
    if ent.d.patient:
        filters.append(F.patient)
    doctor_key = _pick(ent, "doctor", keys=("doctor_id", "surgeon", "consultant", "treating_doctor", "ordering_doctor"))
    dept_key = _pick(ent, "department", keys=("department_id",))
    ward_key = _pick(ent, "ward", keys=("ward_id",))
    if doctor_key:
        filters.append(Filter("doctor", ent.field_map[doctor_key].label if doctor_key in ent.field_map else "Doctor", "ref",
                              ref="employees.employees", ref_filter={"category": "Doctor"}, placeholder="All doctors"))
    if dept_key:
        filters.append(F.department)
    if ward_key:
        filters.append(F.ward)
    sel = next((f for f in ent.fields if f.type == "select" and f.options and len(f.options) <= 30
                and f.key not in (doctor_key, dept_key, ward_key)), None)
    if sel:
        filters.append(F.select(f"f_{sel.key}", sel.label, list(sel.options or [])))

    async def run(ctx, p: Params) -> Result:
        t = ent.table
        conds = rs.scoped_where(ctx, ent) if hasattr(rs, "scoped_where") else rs.base_where(ent)  # active branch
        if dkey in ent.physical:
            col = t.c[dkey]
            conds += ts_between(col, p) if isinstance(col.type, sa.DateTime) else date_between(col, p)
            order = col.desc().nulls_last()
        else:
            col = t.c.data[dkey].astext
            conds += text_between(col, p)
            order = col.desc().nulls_last()
        if p.get("status"):
            conds.append(t.c.status == p.get("status"))
        if p.get("patient") and is_uuid(p.get("patient")):
            conds.append(t.c.patient_id == p.get("patient"))
        for fk, key in (("doctor", doctor_key), ("department", dept_key), ("ward", ward_key)):
            if key and p.get(fk) and is_uuid(p.get(fk)):
                conds.append(rs.eq_cond(ent, key, p.get(fk)))
        if sel and p.get(f"f_{sel.key}"):
            conds.append(rs.eq_cond(ent, sel.key, p.get(f"f_{sel.key}")))
        if p.q:
            q = p.q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            conds.append(t.c.search.ilike(f"%{q}%", escape="\\"))
        res = await ctx.conn.execute(sa.select(t).where(*conds).order_by(order, t.c.created_at.desc()).limit(ROW_CAP + 1))
        recs = [rs.to_record(r) for r in res.all()]
        capped = len(recs) > ROW_CAP
        recs = recs[:ROW_CAP]
        refs = await rs.resolve_refs(ctx, ent, recs)
        out = []
        for r in recs:
            row: dict = {}
            for c in cols:
                k = c.key
                if k in ("patient", "uhid"):
                    label = refs.get(r.get("patient_id") or "", "")
                    name, _, uhid = label.partition(" · ")
                    row["patient"], row["uhid"] = name or None, uhid or None
                    continue
                v = r.get(k)
                f = ent.field_map.get(k)
                if f is not None and f.type == "ref" and v:
                    v = refs.get(str(v), v)
                elif isinstance(v, list):
                    v = ", ".join(str(x) for x in v)
                elif isinstance(v, bool):
                    v = "Yes" if v else "No"
                row[k] = v
            row["_link"] = f"/patients/{r['id']}" if ent.fqn == "registration.patients" else f"/m/{ent.module_id}/{ent.key}?r={r['id']}"
            out.append(row)
        tiles = [{"label": "Rows", "value": len(out), "format": "number"}]
        by = Counter(r.get("status") for r in out if r.get("status"))
        for s, n in by.most_common(3):
            tiles.append({"label": s, "value": n, "format": "number"})
        for c in cols:
            if c.type == "money" and len(tiles) < 7:
                tiles.append({"label": c.label, "value": round(sum(float(r.get(c.key) or 0) for r in out), 2), "format": "money"})
        chart = None
        if by:
            chart = {"type": "donut", "x": "status", "y": [{"key": "count", "label": "Records", "type": "number"}],
                     "data": [{"status": s, "count": n} for s, n in by.most_common()]}
        note = f"Showing the latest {ROW_CAP:,} rows — narrow the period or filters to see the rest." if capped else None
        return Result(out, tiles, note, chart)

    cat_name, cat_desc = SUITE_CATEGORY.get(mod.suite if mod else "", ("Registers", "Record registers."))
    category(cat_name, cat_desc, "TableProperties", 200 + SUITE_ORDER.get(mod.suite if mod else "", 9))
    list_labels = [c.label for c in cols if c.default][:6]
    return Report(
        code=f"REG-{ent.prefix}", name=f"{ent.label} register", category=cat_name,
        description=(ent.d.description or f"Every {ent.singular.lower()} record in the period")
        + f" — {', '.join(list_labels)}. Source: {mod.name if mod else ent.module_id}.",
        columns=cols, run=run, filters=filters, access=(ent.fqn,), icon=(mod.icon if mod else "TableProperties"),
        default_period="this_month" if ent.date_field else "all", max_days=3700, kind="register",
        handles_q=True, tags=(ent.module_id, ent.fqn),
    )


def build_registers() -> int:
    n = 0
    for ent in all_entities():
        register(_make(ent))
        n += 1
    return n
