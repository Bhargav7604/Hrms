"""NABH quality indicators, patient safety, infection control and patient experience reports."""

from __future__ import annotations

from datetime import timedelta

import sqlalchemy as sa

from ..core.util import today
from ..schema import appointments, encounters, orders, records
from . import Col, F, Params, Result, category, report
from ._sql import f, jnum, jts, minutes, pct, pctile, rec_live, rows, text_between, ts_between

NABH = category("NABH Quality Indicators", "NABH indicators — mortality, infections, returns to ICU, incidents — against target.", "Award", 11)
QUALITY_ACCESS = ("quality.indicators", "quality.measurements", "safety.incidents")


def _span(p: Params):
    end = p.d_to or today()
    start = p.d_from or end.replace(day=1)
    from . import Params as P

    return P(p.period, start, end, None, {})


async def patient_days(ctx, p: Params) -> float:
    en = encounters
    lo, hi = sa.literal(p.start), sa.literal(p.end)
    span = sa.func.least(sa.func.coalesce(en.c.ended_at, sa.func.now()), hi) - sa.func.greatest(en.c.started_at, lo)
    v = (await ctx.conn.execute(sa.select(sa.func.sum(sa.extract("epoch", span) / 86400)).where(
        en.c.type == "IPD", en.c.deleted_at.is_(None), en.c.status != "Cancelled", en.c.started_at < hi,
        sa.or_(en.c.ended_at.is_(None), en.c.ended_at > lo)))).scalar()
    return max(0.0, f(v))


async def _count(ctx, module: str, entity: str, date_key: str, p: Params, *extra) -> int:
    r = records
    col = r.c.data[date_key].astext
    return int((await ctx.conn.execute(sa.select(sa.func.count()).select_from(r).where(
        *rec_live(module, entity), *text_between(col, p), *extra))).scalar() or 0)


async def _sum(ctx, module: str, entity: str, key: str, date_key: str, p: Params) -> float:
    r = records
    return f((await ctx.conn.execute(sa.select(sa.func.sum(jnum(r.c.data[key].astext))).where(
        *rec_live(module, entity), *text_between(r.c.data[date_key].astext, p)))).scalar())


@report("NABH-01", "Core Quality Indicators (computed)", NABH,
        "NABH key performance indicators computed from live records for the period — assessment and reporting times, critical-result "
        "communication, mortality, returns to ICU, medication errors, falls, device-associated infections, hand hygiene, LAMA and "
        "patient experience — each against its benchmark.",
        [Col("chapter", "NABH chapter"), Col("indicator", "Indicator"), Col("numerator", "Numerator", "number"),
         Col("denominator", "Denominator", "number"), Col("value", "Value", "number"), Col("unit", "Unit"),
         Col("benchmark", "Benchmark"), Col("status", "Status", "status")],
        filters=[F.period], access=QUALITY_ACCESS, popular=True, icon="Award")
async def nabh_core(ctx, p0: Params) -> Result:
    p = _span(p0)
    en, o, a, r = encounters, orders, appointments, records
    pdays = await patient_days(ctx, p)
    out: list[dict] = []

    def add(chapter, name, num, den, value, unit, bench, good):
        st = "No data" if value is None else ("Met" if good(value) else "Not met")
        out.append({"chapter": chapter, "indicator": name, "numerator": num, "denominator": den,
                    "value": round(value, 2) if isinstance(value, float) else value, "unit": unit, "benchmark": bench, "status": st})

    # AAC — OP initial assessment time
    chk, seen = jts(a.c.data["checked_in_at"].astext), jts(a.c.data["consult_started_at"].astext)
    ok = sa.and_(chk.isnot(None), seen.isnot(None))
    n, med = (await ctx.conn.execute(sa.select(sa.func.count().filter(ok), pctile(minutes(chk, seen), 0.5).filter(ok)).where(
        a.c.deleted_at.is_(None), a.c.appt_date >= p.d_from, a.c.appt_date <= p.d_to))).one()
    add("AAC", "Time for initial assessment of OP patients (median)", n, None, f(med) if med is not None else None, "min", "≤ 30 min",
        lambda v: v <= 30)
    # AAC.6 — lab reporting time and critical results
    done = sa.func.coalesce(o.c.verified_at, o.c.resulted_at)
    okl = sa.and_(o.c.collected_at.isnot(None), done.isnot(None))
    n, med = (await ctx.conn.execute(sa.select(sa.func.count().filter(okl), pctile(minutes(o.c.collected_at, done), 0.5).filter(okl)).where(
        o.c.category == "LAB", o.c.deleted_at.is_(None), *ts_between(o.c.ordered_at, p)))).one()
    add("AAC", "Lab reporting time — collection to release (median)", n, None, f(med) if med is not None else None, "min", "≤ 120 min",
        lambda v: v <= 120)
    res = sa.func.coalesce(o.c.resulted_at, o.c.verified_at)
    crit, within = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.count().filter(
        o.c.acknowledged_at.isnot(None), minutes(res, o.c.acknowledged_at) <= 30)).where(
        o.c.critical.is_(True), o.c.deleted_at.is_(None), *ts_between(res, p)))).one()
    add("AAC", "Critical results communicated within 30 min", within, crit, pct(within, crit), "%", "≥ 90%", lambda v: v >= 90)
    # COP — mortality, LAMA, returns to ICU
    dis_t = en.c.data["discharge_type"].astext
    tot, deaths, lama = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.count().filter(dis_t.in_(["Death", "Expired"])),
                                                          sa.func.count().filter(dis_t.in_(["LAMA", "DAMA"]))).where(
        en.c.type == "IPD", en.c.status == "Discharged", *ts_between(en.c.ended_at, p)))).one()
    add("COP", "Gross mortality rate", deaths, tot, pct(deaths, tot, 2) if tot else None, "%", "≤ 2%", lambda v: v <= 2)
    add("PRE", "Discharge against medical advice (LAMA / DAMA)", lama, tot, pct(lama, tot, 2) if tot else None, "%", "≤ 1%", lambda v: v <= 1)
    icu_n = await _count(ctx, "icu", "stays", "admitted_at", p)
    icu_ret = await _count(ctx, "icu", "stays", "admitted_at", p, r.c.data["readmission_48h"].astext == "true")
    add("COP", "Return to ICU within 48 hours", icu_ret, icu_n, pct(icu_ret, icu_n, 2) if icu_n else None, "%", "≤ 3%", lambda v: v <= 3)
    # PSQ / MOM — incidents per 1000 patient-days
    it = r.c.data["incident_type"].astext
    med_err = await _count(ctx, "safety", "incidents", "occurred_at", p, it.ilike("%medication%"))
    falls = await _count(ctx, "safety", "incidents", "occurred_at", p, it.ilike("%fall%"))
    per = (lambda x: round(x / pdays * 1000, 2) if pdays else None)  # noqa: E731
    add("MOM", "Medication errors per 1,000 patient-days", med_err, round(pdays), per(med_err), "per 1,000", "≤ 1", lambda v: v <= 1)
    add("PSQ", "Patient falls per 1,000 patient-days", falls, round(pdays), per(falls), "per 1,000", "≤ 0.5", lambda v: v <= 0.5)
    # HIC — device-associated infections per 1000 device-days, hand hygiene
    for typ, key, label, bench in (("CLABSI", "central_line_days", "CLABSI per 1,000 central-line days", 2.0),
                                   ("CAUTI", "urinary_catheter_days", "CAUTI per 1,000 catheter days", 3.0),
                                   ("VAP", "ventilator_days", "VAP per 1,000 ventilator days", 5.0)):
        ev = await _count(ctx, "infection", "events", "onset_date", p, r.c.status == "Confirmed", r.c.data["infection_type"].astext.ilike(f"%{typ}%"))
        dd = await _sum(ctx, "infection", "device_days", key, "census_date", p)
        add("HIC", label, ev, dd or None, round(ev / dd * 1000, 2) if dd else None, "per 1,000", f"≤ {bench:g}", lambda v, b=bench: v <= b)
    ssi = await _count(ctx, "infection", "events", "onset_date", p, r.c.status == "Confirmed", r.c.data["infection_type"].astext.ilike("%SSI%"))
    surg = await _count(ctx, "ot", "bookings", "scheduled_at", p, r.c.status.in_(["Surgery Completed", "Shifted Out"]))
    add("HIC", "Surgical site infection rate", ssi, surg, pct(ssi, surg, 2) if surg else None, "%", "≤ 2%", lambda v: v <= 2)
    opp = await _sum(ctx, "infection", "hand_hygiene", "opportunities", "audited_at", p)
    comp = await _sum(ctx, "infection", "hand_hygiene", "compliant_actions", "audited_at", p)
    add("HIC", "Hand hygiene compliance", comp, opp or None, pct(comp, opp) if opp else None, "%", "≥ 80%", lambda v: v >= 80)
    # PRE — patient experience
    fb = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.avg(jnum(r.c.data["rating"].astext))).where(
        *rec_live("feedback", "feedback"), *text_between(r.c.data["submitted_at"].astext, p)))).one()
    add("PRE", "Patient satisfaction (average rating out of 5)", fb[0], None, round(f(fb[1]), 2) if fb[1] is not None else None, "/ 5",
        "≥ 4", lambda v: v >= 4)
    rec_at, res_at = jts(r.c.data["received_at"].astext), jts(r.c.data["resolved_at"].astext)
    gr = (await ctx.conn.execute(sa.select(sa.func.count(), sa.func.count().filter(res_at.isnot(None), res_at - rec_at <= sa.text("interval '7 days'"))).where(
        *rec_live("feedback", "grievances"), *text_between(r.c.data["received_at"].astext, p)))).one()
    add("PRE", "Complaints resolved within 7 days", gr[1], gr[0], pct(gr[1], gr[0]) if gr[0] else None, "%", "≥ 90%", lambda v: v >= 90)
    met = sum(1 for x in out if x["status"] == "Met")
    nm = sum(1 for x in out if x["status"] == "Not met")
    return Result(out, [{"label": "Indicators", "value": len(out), "format": "number"}, {"label": "Met", "value": met, "format": "number"},
                        {"label": "Not met", "value": nm, "format": "number"},
                        {"label": "Patient-days", "value": round(pdays), "format": "number"}],
                  note=f"Period {p.label()}. Rates per 1,000 patient-days use in-patient days within the period.")


@report("NABH-02", "Quality Indicator Measurements vs Target", NABH,
        "Indicator values submitted by departments (Quality › Measurements) for the period — value against target, met / not met, and the action plan.",
        [Col("period", "Period"), Col("indicator", "Indicator"), Col("chapter", "Chapter"), Col("department", "Department"),
         Col("value", "Value", "number"), Col("target", "Target", "number"), Col("met", "Met target", "status"),
         Col("action_plan", "Action plan", default=False), Col("status", "Status", "status")],
        filters=[F.period, F.department, F.select("met", "Met target", ["Yes", "No"])], access=("quality.measurements",), icon="Target")
async def nabh_measurements(ctx, p: Params) -> Result:
    r = records
    ind, dpt = records.alias("ind"), records.alias("dpt")
    conds = [*rec_live("quality", "measurements"), *text_between(r.c.data["period_start"].astext, p)]
    if p.get("department"):
        conds.append(r.c.data["department"].astext == p.get("department"))
    if p.get("met"):
        conds.append(r.c.data["met_target"].astext == p.get("met"))
    stmt = (sa.select(r.c.data["period"].astext.label("period"), ind.c.title.label("indicator"), ind.c.data["chapter"].astext.label("chapter"),
                      dpt.c.title.label("department"), jnum(r.c.data["value"].astext).label("value"),
                      jnum(r.c.data["target"].astext).label("target"), r.c.data["met_target"].astext.label("met"),
                      r.c.data["action_plan"].astext.label("action_plan"), r.c.status)
            .select_from(r.outerjoin(ind, sa.cast(ind.c.id, sa.Text) == r.c.data["indicator"].astext)
                         .outerjoin(dpt, sa.cast(dpt.c.id, sa.Text) == r.c.data["department"].astext))
            .where(*conds).order_by(r.c.data["period_start"].astext.desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["met"] = {"Yes": "Met", "No": "Not met"}.get(x["met"] or "", x["met"])
    return Result(out)


@report("NABH-03", "Incident Summary", NABH,
        "Patient-safety incidents in the window by type and severity — reported, under review / RCA / CAPA and closed — with near misses.",
        [Col("incident_type", "Incident type"), Col("total", "Reported", "number", total=True), Col("near_miss", "Near miss / no harm", "number", total=True),
         Col("harm", "Harm (moderate+)", "number", total=True), Col("sentinel", "Sentinel", "number", total=True), Col("open", "Open", "number", total=True),
         Col("closed", "Closed", "number", total=True), Col("median_close_days", "Median days to close", "days")],
        filters=[F.period, F.department], access=("safety.incidents",), icon="ShieldAlert",
        chart={"type": "bar", "x": "incident_type", "y": ["near_miss", "harm", "sentinel"], "horizontal": True, "stacked": True})
async def nabh_incidents(ctx, p: Params) -> Result:
    r = records
    sev = r.c.data["severity"].astext
    occ, closed = jts(r.c.data["occurred_at"].astext), jts(r.c.data["closed_at"].astext)
    conds = [*rec_live("safety", "incidents"), *text_between(r.c.data["occurred_at"].astext, p)]
    if p.get("department"):
        conds.append(r.c.data["department"].astext == p.get("department"))
    typ = sa.func.coalesce(r.c.data["incident_type"].astext, "Unclassified")
    stmt = (sa.select(typ.label("incident_type"), sa.func.count().label("total"),
                      sa.func.count().filter(sa.or_(sev.ilike("%near%"), sev.ilike("%no harm%"))).label("near_miss"),
                      sa.func.count().filter(sa.or_(sev.ilike("%moderate%"), sev.ilike("%severe%"), sev.ilike("%major%"))).label("harm"),
                      sa.func.count().filter(sa.or_(sev.ilike("%sentinel%"), sev.ilike("%death%"))).label("sentinel"),
                      sa.func.count().filter(r.c.status != "Closed").label("open"), sa.func.count().filter(r.c.status == "Closed").label("closed"),
                      pctile(sa.extract("epoch", closed - occ) / 86400, 0.5).filter(closed.isnot(None)).label("median_close_days"))
            .where(*conds).group_by(typ).order_by(sa.func.count().desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["median_close_days"] = round(f(x["median_close_days"]), 1) if x["median_close_days"] is not None else None
    return Result(out)


@report("NABH-04", "Hospital-acquired Infections", NABH,
        "Confirmed and suspected HAIs by type and ward, with device-days and the rate per 1,000 device-days (CLABSI, CAUTI, VAP) or per 100 surgeries (SSI).",
        [Col("ward", "Ward"), Col("infection_type", "Infection"), Col("suspected", "Suspected", "number", total=True),
         Col("confirmed", "Confirmed", "number", total=True), Col("ruled_out", "Ruled out", "number", total=True),
         Col("top_organism", "Commonest organism")],
        filters=[F.period, F.ward], access=("infection.events",), icon="Bug")
async def nabh_hai(ctx, p: Params) -> Result:
    r = records
    w = records.alias("w")
    conds = [*rec_live("infection", "events"), *text_between(r.c.data["onset_date"].astext, p)]
    if p.get("ward"):
        conds.append(r.c.data["ward"].astext == p.get("ward"))
    typ = sa.func.coalesce(r.c.data["infection_type"].astext, "Unclassified")
    stmt = (sa.select(sa.func.coalesce(w.c.title, "Unassigned").label("ward"), typ.label("infection_type"),
                      sa.func.count().filter(r.c.status == "Suspected").label("suspected"),
                      sa.func.count().filter(r.c.status == "Confirmed").label("confirmed"),
                      sa.func.count().filter(r.c.status == "Ruled Out").label("ruled_out"),
                      sa.func.mode().within_group(r.c.data["organism"].astext).label("top_organism"))
            .select_from(r.outerjoin(w, sa.cast(w.c.id, sa.Text) == r.c.data["ward"].astext)).where(*conds)
            .group_by(w.c.title, typ).order_by(sa.func.count().desc()))
    return Result(await rows(ctx, stmt))


@report("NABH-05", "Patient Feedback & Grievances", NABH,
        "Patient feedback by department — responses, average rating, NPS, detractors — and grievances received, resolved and average days to resolve.",
        [Col("department", "Department"), Col("responses", "Responses", "number", total=True), Col("avg_rating", "Avg rating", "number"),
         Col("nps", "NPS", "number"), Col("detractors", "Detractors", "number", total=True), Col("grievances", "Grievances", "number", total=True),
         Col("resolved", "Resolved", "number", total=True), Col("avg_resolve_days", "Avg days to resolve", "days")],
        filters=[F.period], access=("feedback.feedback", "feedback.grievances"), icon="MessageSquareHeart")
async def nabh_feedback(ctx, p: Params) -> Result:
    r = records
    dpt = records.alias("dpt")
    nps = jnum(r.c.data["nps"].astext)
    fb = await rows(ctx, sa.select(sa.func.coalesce(dpt.c.title, "Hospital-wide").label("department"), sa.func.count().label("responses"),
                                   sa.func.round(sa.cast(sa.func.avg(jnum(r.c.data["rating"].astext)), sa.Numeric), 2).label("avg_rating"),
                                   sa.func.count().filter(nps >= 9).label("_pro"), sa.func.count().filter(nps <= 6).label("detractors"),
                                   sa.func.count().filter(nps.isnot(None)).label("_n"))
                    .select_from(r.outerjoin(dpt, sa.cast(dpt.c.id, sa.Text) == r.c.data["department"].astext))
                    .where(*rec_live("feedback", "feedback"), *text_between(r.c.data["submitted_at"].astext, p)).group_by(dpt.c.title))
    rec_at, res_at = jts(r.c.data["received_at"].astext), jts(r.c.data["resolved_at"].astext)
    gr = await rows(ctx, sa.select(sa.func.coalesce(dpt.c.title, "Hospital-wide").label("department"), sa.func.count().label("grievances"),
                                   sa.func.count().filter(res_at.isnot(None)).label("resolved"),
                                   sa.func.round(sa.cast(sa.func.avg(sa.extract("epoch", res_at - rec_at) / 86400), sa.Numeric), 1).label("avg_resolve_days"))
                    .select_from(r.outerjoin(dpt, sa.cast(dpt.c.id, sa.Text) == r.c.data["department"].astext))
                    .where(*rec_live("feedback", "grievances"), *text_between(r.c.data["received_at"].astext, p)).group_by(dpt.c.title))
    by: dict[str, dict] = {}
    for x in fb:
        n = x.pop("_n")
        pro = x.pop("_pro")
        x["nps"] = round((pro - x["detractors"]) / n * 100) if n else None
        by[x["department"]] = x
    for g in gr:
        by.setdefault(g["department"], {"department": g["department"], "responses": 0, "avg_rating": None, "nps": None, "detractors": 0}).update(g)
    return Result(sorted(by.values(), key=lambda x: -(x.get("responses") or 0)))


@report("NABH-06", "Hand Hygiene Compliance", NABH,
        "WHO five-moments hand-hygiene audits by ward and staff category — opportunities observed, compliant actions and compliance %.",
        [Col("ward", "Ward"), Col("staff_category", "Staff category"), Col("audits", "Audits", "number", total=True),
         Col("opportunities", "Opportunities", "number", total=True), Col("compliant", "Compliant", "number", total=True),
         Col("compliance_pct", "Compliance %", "percent")],
        filters=[F.period], access=("infection.hand_hygiene",), icon="HandHeart",
        chart={"type": "bar", "x": "ward", "y": ["compliance_pct"], "horizontal": True})
async def nabh_hand_hygiene(ctx, p: Params) -> Result:
    r = records
    w = records.alias("w")
    sc = r.c.data["staff_category"].astext
    stmt = (sa.select(sa.func.coalesce(w.c.title, "Unassigned").label("ward"), sc.label("staff_category"),
                      sa.func.count().label("audits"), sa.func.sum(jnum(r.c.data["opportunities"].astext)).label("opportunities"),
                      sa.func.sum(jnum(r.c.data["compliant_actions"].astext)).label("compliant"))
            .select_from(r.outerjoin(w, sa.cast(w.c.id, sa.Text) == r.c.data["ward"].astext))
            .where(*rec_live("infection", "hand_hygiene"), *text_between(r.c.data["audited_at"].astext, p))
            .group_by(w.c.title, sc))
    out = await rows(ctx, stmt)
    for x in out:
        x["compliance_pct"] = pct(x["compliant"], x["opportunities"])
    return Result(out)


__all__ = ["patient_days", "timedelta"]
