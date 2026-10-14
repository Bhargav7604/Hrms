"""Operational and clinical reports: OP, IP, ER, OT, clinical / MRD, lab & radiology and the statutory registers."""

from __future__ import annotations

from datetime import timedelta

import sqlalchemy as sa

from ..core.util import is_uuid, today
from ..schema import appointments, beds, employees, encounters, orders, patients, queue_tokens, records, services
from . import Col, F, Params, Result, buckets, category, report
from ._sql import (
    date_between,
    day,
    dept,
    f,
    jnum,
    jts,
    local,
    minutes,
    pct,
    pctile,
    rec_live,
    rows,
    share,
    text_between,
    ts_between,
)

OPD = category("Outpatient (OP)", "OP visits, new vs revisit, no-shows, waiting time and doctor-wise consultations.", "Stethoscope", 6)
IPD = category("Inpatient (IP)", "Census, admissions and discharges, ALOS, discharge TAT, bed turnover and long stays.", "BedDouble", 7)
ER = category("Emergency (ER)", "ER volumes, triage, door-to-doctor time and disposition.", "Siren", 8)
OT = category("Operation Theatre", "OT utilisation, surgery register, cancellations and delays.", "Scissors", 9)
MRD = category("Clinical & MRD", "Diagnoses (ICD-10), mortality, readmissions, case-file completeness and coding.", "FileHeart", 10)
LAB = category("Lab & Radiology", "Test and study volumes, turnaround against each test's SLA, critical values and backlog.", "FlaskConical", 12)
STAT = category("Statutory Registers", "Registers required by law — admission, discharge, MLC, birth, death, OT, transfusion, BMW, NDPS, restraint.",
                "BookCheck", 13)

OP_SEEN = ("Checked-in", "In Consultation", "Completed")


def _uuid(p: Params, key: str) -> str | None:
    v = p.get(key)
    return v if v and is_uuid(v) else None


def _search(p: Params, *cols) -> list:
    if not p.q:
        return []
    like = f"%{p.q}%"
    return [sa.or_(*[c.ilike(like) for c in cols])]


# ====================================================================== OP

@report("OPD-01", "OP Visits Register", OPD,
        "Every OP appointment / visit in the window — date, slot, token, patient, doctor, department, visit type, source and outcome.",
        [Col("appt_date", "Date", "date"), Col("slot", "Slot"), Col("token_no", "Token", "number"), Col("visit_no", "Visit no", "code", False),
         Col("uhid", "UHID", "code"), Col("patient", "Patient"), Col("gender", "Gender", default=False), Col("mobile", "Mobile", default=False),
         Col("doctor", "Doctor"), Col("department", "Department"), Col("type", "Visit type"), Col("source", "Booking source", default=False),
         Col("reason", "Reason", default=False), Col("status", "Status", "status")],
        filters=[F.period, F.search("Visit / UHID / name…"), F.doctor, F.department,
                 F.status(["Booked", "Checked-in", "In Consultation", "Completed", "Cancelled", "No-show"]),
                 F.select("type", "Visit type", ["New", "Follow-up", "Review with reports"])],
        access=("appointments.appointments",), popular=True, icon="CalendarCheck", handles_q=True)
async def opd_register(ctx, p: Params) -> Result:
    a, pat = appointments, patients
    conds = [a.c.deleted_at.is_(None), *date_between(a.c.appt_date, p), *_search(p, a.c.code, pat.c.code, pat.c.title)]
    for k, col in (("doctor", a.c.doctor_id), ("department", a.c.department_id)):
        if _uuid(p, k):
            conds.append(col == _uuid(p, k))
    for k, col in (("status", a.c.status), ("type", a.c.type)):
        if p.get(k):
            conds.append(col == p.get(k))
    stmt = (sa.select(a.c.appt_date, a.c.slot, a.c.token_no, a.c.code.label("visit_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      pat.c.gender, pat.c.phone.label("mobile"), employees.c.name.label("doctor"), dept.c.title.label("department"), a.c.type,
                      a.c.data["booking_source"].astext.label("source"), a.c.data["reason"].astext.label("reason"), a.c.status, a.c.id.label("_id"))
            .select_from(a.join(pat, pat.c.id == a.c.patient_id).outerjoin(employees, employees.c.id == a.c.doctor_id)
                         .outerjoin(dept, dept.c.id == a.c.department_id))
            .where(*conds).order_by(a.c.appt_date.desc(), a.c.slot))
    out = await rows(ctx, stmt)
    for r in out:
        r["_link"] = f"/m/appointments/appointments?r={r.pop('_id')}"
    seen = sum(1 for r in out if r["status"] in OP_SEEN)
    return Result(out, [{"label": "Visits", "value": len(out), "format": "number"}, {"label": "Seen", "value": seen, "format": "number"},
                        {"label": "New", "value": sum(1 for r in out if r["type"] == "New"), "format": "number"},
                        {"label": "No-show", "value": sum(1 for r in out if r["status"] == "No-show"), "format": "number"},
                        {"label": "Cancelled", "value": sum(1 for r in out if r["status"] == "Cancelled"), "format": "number"}])


@report("OPD-02", "New vs Revisit Analysis", OPD,
        "OP visits seen per department (or per day): new patients, follow-ups and review-with-reports visits, and the share of new visits.",
        [Col("group", "Department / date"), Col("visits", "Visits seen", "number", total=True), Col("new", "New", "number", total=True),
         Col("follow_up", "Follow-up", "number", total=True), Col("review", "Review with reports", "number", total=True),
         Col("new_pct", "New %", "percent")],
        filters=[F.period, F.view(["By department", "By day", "By doctor"]), F.department], access=("appointments.appointments",),
        icon="Users", chart={"type": "bar", "x": "group", "y": ["new", "follow_up", "review"], "stacked": True})
async def opd_new_revisit(ctx, p: Params) -> Result:
    a = appointments
    view = p.get("view", "By department")
    g = (sa.func.to_char(a.c.appt_date, "YYYY-MM-DD") if view == "By day" else employees.c.name if view == "By doctor"
         else sa.func.coalesce(dept.c.title, "Unassigned"))
    conds = [a.c.deleted_at.is_(None), a.c.status.in_(OP_SEEN), *date_between(a.c.appt_date, p)]
    if _uuid(p, "department"):
        conds.append(a.c.department_id == _uuid(p, "department"))
    stmt = (sa.select(g.label("group"), sa.func.count().label("visits"), sa.func.count().filter(a.c.type == "New").label("new"),
                      sa.func.count().filter(a.c.type == "Follow-up").label("follow_up"),
                      sa.func.count().filter(a.c.type == "Review with reports").label("review"))
            .select_from(a.outerjoin(dept, dept.c.id == a.c.department_id).outerjoin(employees, employees.c.id == a.c.doctor_id))
            .where(*conds).group_by(g).order_by(g if view == "By day" else sa.func.count().desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["new_pct"] = pct(r["new"], r["visits"])
    tv, tn = sum(r["visits"] for r in out), sum(r["new"] for r in out)
    return Result(out, [{"label": "Visits seen", "value": tv, "format": "number"}, {"label": "New", "value": tn, "format": "number"},
                        {"label": "Revisits", "value": tv - tn, "format": "number"}, {"label": "New %", "value": pct(tn, tv), "format": "percent"}])


@report("OPD-03", "No-show & Cancellation Analysis", OPD,
        "Booked appointments that did not happen — no-shows and cancellations per doctor, with rates and the commonest cancellation reasons.",
        [Col("doctor", "Doctor"), Col("department", "Department"), Col("booked", "Booked", "number", total=True),
         Col("no_show", "No-show", "number", total=True), Col("cancelled", "Cancelled", "number", total=True),
         Col("no_show_pct", "No-show %", "percent"), Col("cancel_pct", "Cancelled %", "percent"), Col("top_reason", "Top cancel reason")],
        filters=[F.period, F.doctor, F.department], access=("appointments.appointments",), icon="CalendarX2",
        chart={"type": "bar", "x": "doctor", "y": ["no_show", "cancelled"], "horizontal": True, "stacked": True})
async def opd_noshow(ctx, p: Params) -> Result:
    a = appointments
    conds = [a.c.deleted_at.is_(None), *date_between(a.c.appt_date, p)]
    for k, col in (("doctor", a.c.doctor_id), ("department", a.c.department_id)):
        if _uuid(p, k):
            conds.append(col == _uuid(p, k))
    reason = a.c.data["cancel_reason"].astext
    top = sa.func.mode().within_group(reason)
    stmt = (sa.select(sa.func.coalesce(employees.c.name, "Unassigned").label("doctor"), dept.c.title.label("department"),
                      sa.func.count().label("booked"), sa.func.count().filter(a.c.status == "No-show").label("no_show"),
                      sa.func.count().filter(a.c.status == "Cancelled").label("cancelled"), top.label("top_reason"))
            .select_from(a.outerjoin(employees, employees.c.id == a.c.doctor_id).outerjoin(dept, dept.c.id == a.c.department_id))
            .where(*conds).group_by(employees.c.name, dept.c.title)
            .order_by((sa.func.count().filter(a.c.status == "No-show") + sa.func.count().filter(a.c.status == "Cancelled")).desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["no_show_pct"], r["cancel_pct"] = pct(r["no_show"], r["booked"]), pct(r["cancelled"], r["booked"])
    tb = sum(r["booked"] for r in out)
    return Result(out, [{"label": "Booked", "value": tb, "format": "number"},
                        {"label": "No-show rate", "value": pct(sum(r["no_show"] for r in out), tb), "format": "percent"},
                        {"label": "Cancellation rate", "value": pct(sum(r["cancelled"] for r in out), tb), "format": "percent"}])


@report("OPD-04", "OP Waiting Time", OPD,
        "Registration / check-in to doctor: median and 90th-percentile wait per department, from consultation timestamps and queue tokens, "
        "with how many visits could be measured.",
        [Col("department", "Department"), Col("visits", "Visits seen", "number", total=True), Col("measured", "Measured", "number", total=True),
         Col("coverage", "Coverage %", "percent"), Col("median", "Median wait", "minutes"), Col("p90", "p90 wait", "minutes"),
         Col("over_30", "Waited > 30 min", "number", total=True)],
        filters=[F.period, F.department], access=("appointments.appointments",), icon="Clock",
        chart={"type": "bar", "x": "department", "y": ["median", "p90"], "horizontal": True})
async def opd_wait(ctx, p: Params) -> Result:
    a = appointments
    chk, seen = jts(a.c.data["checked_in_at"].astext), jts(a.c.data["consult_started_at"].astext)
    wait = minutes(chk, seen)
    ok = sa.and_(chk.isnot(None), seen.isnot(None), seen >= chk)
    conds = [a.c.deleted_at.is_(None), a.c.status.in_(OP_SEEN), *date_between(a.c.appt_date, p)]
    if _uuid(p, "department"):
        conds.append(a.c.department_id == _uuid(p, "department"))
    stmt = (sa.select(sa.func.coalesce(dept.c.title, "Unassigned").label("department"), sa.func.count().label("visits"),
                      sa.func.count().filter(ok).label("measured"), pctile(wait, 0.5).filter(ok).label("median"),
                      pctile(wait, 0.9).filter(ok).label("p90"), sa.func.count().filter(ok, wait > 30).label("over_30"))
            .select_from(a.outerjoin(dept, dept.c.id == a.c.department_id)).where(*conds).group_by(dept.c.title)
            .order_by(sa.func.count().desc()))
    out = await rows(ctx, stmt)
    qt = queue_tokens
    qwait = minutes(qt.c.created_at, qt.c.called_at)
    q = (await ctx.conn.execute(sa.select(sa.func.count(), pctile(qwait, 0.5), pctile(qwait, 0.9)).where(
        qt.c.deleted_at.is_(None), qt.c.called_at.isnot(None), *date_between(qt.c.token_date, p)))).one()
    if q[0]:
        out.append({"department": "Queue tokens (all queues)", "visits": q[0], "measured": q[0], "median": q[1], "p90": q[2], "over_30": None})
    for r in out:
        r["coverage"] = pct(r["measured"], r["visits"])
        r["median"] = round(f(r["median"]), 1) if r["median"] is not None else None
        r["p90"] = round(f(r["p90"]), 1) if r["p90"] is not None else None
    tv, tm = sum(r["visits"] for r in out), sum(r["measured"] for r in out)
    return Result(out, [{"label": "Visits seen", "value": tv, "format": "number"}, {"label": "Measured", "value": tm, "format": "number"},
                        {"label": "Coverage", "value": pct(tm, tv), "format": "percent"}],
                  note=None if tm else "No check-in → consultation timestamps were recorded in this period, so waits cannot be measured yet.")


@report("OPD-05", "Doctor-wise OP Consultations", OPD,
        "Per doctor: appointments booked, seen, new and revisit patients, no-shows and average consultations per working day.",
        [Col("doctor", "Doctor"), Col("department", "Department"), Col("booked", "Booked", "number", total=True), Col("seen", "Seen", "number", total=True),
         Col("new", "New", "number", total=True), Col("revisit", "Revisit", "number", total=True), Col("no_show", "No-show", "number", total=True),
         Col("days", "Days worked", "number"), Col("per_day", "Seen / day", "number")],
        filters=[F.period, F.doctor, F.department], access=("appointments.appointments",), popular=True, icon="UserRound",
        chart={"type": "bar", "x": "doctor", "y": ["seen"], "horizontal": True})
async def opd_doctor(ctx, p: Params) -> Result:
    a = appointments
    seen = a.c.status.in_(OP_SEEN)
    conds = [a.c.deleted_at.is_(None), *date_between(a.c.appt_date, p)]
    for k, col in (("doctor", a.c.doctor_id), ("department", a.c.department_id)):
        if _uuid(p, k):
            conds.append(col == _uuid(p, k))
    stmt = (sa.select(sa.func.coalesce(employees.c.name, "Unassigned").label("doctor"), dept.c.title.label("department"),
                      sa.func.count().label("booked"), sa.func.count().filter(seen).label("seen"),
                      sa.func.count().filter(seen, a.c.type == "New").label("new"), sa.func.count().filter(seen, a.c.type != "New").label("revisit"),
                      sa.func.count().filter(a.c.status == "No-show").label("no_show"),
                      sa.func.count(sa.distinct(a.c.appt_date)).filter(seen).label("days"))
            .select_from(a.outerjoin(employees, employees.c.id == a.c.doctor_id).outerjoin(dept, dept.c.id == a.c.department_id))
            .where(*conds).group_by(employees.c.name, dept.c.title).order_by(sa.func.count().filter(seen).desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["per_day"] = round(r["seen"] / r["days"], 1) if r["days"] else None
    return Result(out)


@report("OPD-06", "Hourly OP Load", OPD,
        "OP visits by hour of the appointment slot and weekday — when the clinics are busiest, for staffing the counters.",
        [Col("hour", "Hour"), Col("mon", "Mon", "number", total=True), Col("tue", "Tue", "number", total=True), Col("wed", "Wed", "number", total=True),
         Col("thu", "Thu", "number", total=True), Col("fri", "Fri", "number", total=True), Col("sat", "Sat", "number", total=True),
         Col("sun", "Sun", "number", total=True), Col("total", "Total", "number", total=True)],
        filters=[F.period, F.department], access=("appointments.appointments",), icon="Clock3",
        chart={"type": "bar", "x": "hour", "y": ["total"]})
async def opd_hourly(ctx, p: Params) -> Result:
    a = appointments
    hr = sa.func.split_part(a.c.slot, ":", 1)
    dow = sa.extract("isodow", a.c.appt_date)
    conds = [a.c.deleted_at.is_(None), a.c.status.in_(OP_SEEN), a.c.slot.isnot(None), *date_between(a.c.appt_date, p)]
    if _uuid(p, "department"):
        conds.append(a.c.department_id == _uuid(p, "department"))
    data = (await ctx.conn.execute(sa.select(hr, dow, sa.func.count()).where(*conds).group_by(hr, dow))).all()
    grid: dict[str, dict] = {}
    names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    for h, d, n in data:
        row = grid.setdefault(h, {"hour": f"{int(h):02d}:00–{int(h) + 1:02d}:00", **{k: 0 for k in names}})
        row[names[int(d) - 1]] += n
    out = [grid[k] for k in sorted(grid, key=lambda x: int(x))]
    for r in out:
        r["total"] = sum(r[k] for k in names)
    return Result(out)


# ====================================================================== IP

def _ip_select():
    en, pat = encounters, patients
    w = records.alias("w")
    cols = [en.c.code.label("ip_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"), pat.c.gender,
            sa.func.date_part("year", sa.func.age(pat.c.dob)).label("age"), en.c.started_at.label("admitted_at"), en.c.ended_at.label("discharged_at"),
            w.c.title.label("ward"), beds.c.bed_no.label("bed"), employees.c.name.label("consultant"), dept.c.title.label("department"),
            en.c.data["admission_type"].astext.label("admission_type"), en.c.data["admission_source"].astext.label("source"),
            en.c.data["diagnosis"].astext.label("diagnosis"), en.c.data["payer"].astext.label("payer"),
            en.c.data["discharge_type"].astext.label("discharge_type"), en.c.status, en.c.id.label("_id")]
    j = (en.join(pat, pat.c.id == en.c.patient_id).outerjoin(beds, beds.c.id == en.c.bed_id).outerjoin(w, w.c.id == beds.c.ward_id)
         .outerjoin(employees, employees.c.id == en.c.doctor_id).outerjoin(dept, dept.c.id == en.c.department_id))
    return cols, j, w


IP_COLS = [Col("ip_no", "IP no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"), Col("gender", "Gender", default=False),
           Col("age", "Age", "number", False), Col("admitted_at", "Admitted", "datetime")]


def _ip_filters(p: Params, w) -> list:
    en = encounters
    out = []
    for k, col in (("doctor", en.c.doctor_id), ("department", en.c.department_id), ("ward", w.c.id)):
        if _uuid(p, k):
            out.append(col == _uuid(p, k))
    if p.get("payer"):
        out.append(en.c.data["payer"].astext == ("Cash" if p.get("payer") == "Self / Cash" else p.get("payer")))
    return out


@report("IPD-01", "Admission Register", IPD,
        "Every admission in the window — IP no, patient, ward / bed, consultant, department, type, source, provisional diagnosis and payer.",
        [*IP_COLS, Col("ward", "Ward"), Col("bed", "Bed"), Col("consultant", "Consultant"), Col("department", "Department"),
         Col("admission_type", "Type"), Col("source", "Source", default=False), Col("diagnosis", "Provisional diagnosis"),
         Col("payer", "Payer"), Col("status", "Status", "status")],
        filters=[F.period, F.search("IP no / UHID / name…"), F.doctor, F.department, F.ward, F.payer,
                 F.status(["Admitted", "Discharge Initiated", "Discharged", "Cancelled"])],
        access=("ipd.admissions",), popular=True, icon="LogIn", handles_q=True)
async def ipd_admissions(ctx, p: Params) -> Result:
    en, pat = encounters, patients
    cols, j, w = _ip_select()
    conds = [en.c.type == "IPD", en.c.deleted_at.is_(None), *ts_between(en.c.started_at, p), *_ip_filters(p, w),
             *_search(p, en.c.code, pat.c.code, pat.c.title)]
    if p.get("status"):
        conds.append(en.c.status == p.get("status"))
    out = await rows(ctx, sa.select(*cols).select_from(j).where(*conds).order_by(en.c.started_at.desc()))
    for r in out:
        r["_link"] = f"/m/ipd/admissions?r={r.pop('_id')}"
    return Result(out, [{"label": "Admissions", "value": len(out), "format": "number"},
                        {"label": "Emergency", "value": sum(1 for r in out if r["admission_type"] == "Emergency"), "format": "number"},
                        {"label": "Still admitted", "value": sum(1 for r in out if r["status"] in ("Admitted", "Discharge Initiated")), "format": "number"},
                        {"label": "Insurance", "value": sum(1 for r in out if r["payer"] == "Insurance"), "format": "number"}])


@report("IPD-02", "Discharge Register", IPD,
        "Discharges in the window with length of stay, discharge type (normal, LAMA, DAMA, referred, death) and the consultant.",
        [*IP_COLS, Col("discharged_at", "Discharged", "datetime"), Col("los_days", "LOS (days)", "days"), Col("ward", "Ward"),
         Col("consultant", "Consultant"), Col("department", "Department"), Col("discharge_type", "Discharge type"),
         Col("diagnosis", "Diagnosis", default=False), Col("payer", "Payer", default=False)],
        filters=[F.period, F.search("IP no / UHID / name…"), F.doctor, F.department, F.ward,
                 F.select("discharge_type", "Discharge type", ["Normal", "LAMA", "DAMA", "Referred", "Absconded", "Death"])],
        access=("ipd.admissions",), icon="LogOut", handles_q=True)
async def ipd_discharges(ctx, p: Params) -> Result:
    en, pat = encounters, patients
    cols, j, w = _ip_select()
    los = sa.func.round(sa.cast(sa.extract("epoch", en.c.ended_at - en.c.started_at) / 86400, sa.Numeric), 1)
    conds = [en.c.type == "IPD", en.c.status == "Discharged", *ts_between(en.c.ended_at, p), *_ip_filters(p, w),
             *_search(p, en.c.code, pat.c.code, pat.c.title)]
    if p.get("discharge_type"):
        conds.append(en.c.data["discharge_type"].astext == p.get("discharge_type"))
    out = await rows(ctx, sa.select(*cols, los.label("los_days")).select_from(j).where(*conds).order_by(en.c.ended_at.desc()))
    for r in out:
        r["_link"] = f"/m/ipd/admissions?r={r.pop('_id')}"
    lv = [f(r["los_days"]) for r in out if r["los_days"] is not None]
    return Result(out, [{"label": "Discharges", "value": len(out), "format": "number"},
                        {"label": "ALOS (days)", "value": round(sum(lv) / len(lv), 1) if lv else None, "format": "number"},
                        {"label": "LAMA / DAMA", "value": sum(1 for r in out if r["discharge_type"] in ("LAMA", "DAMA")), "format": "number"},
                        {"label": "Deaths", "value": sum(1 for r in out if r["discharge_type"] in ("Death", "Expired")), "format": "number"}])


@report("IPD-03", "Daily IP Census", IPD,
        "Per day: opening census, admissions, discharges, closing (midnight) census, patient-days and bed occupancy against operational beds.",
        [Col("date", "Date", "date"), Col("opening", "Opening census", "number"), Col("admissions", "Admissions", "number", total=True),
         Col("discharges", "Discharges", "number", total=True), Col("closing", "Midnight census", "number"),
         Col("occupancy_pct", "Occupancy %", "percent"), Col("beds", "Operational beds", "number", False)],
        filters=[F.period], access=("ipd.admissions",), icon="Activity", chart={"type": "line", "x": "date", "y": ["closing"]})
async def ipd_census(ctx, p: Params) -> Result:
    en = encounters
    end = p.d_to or today()
    start = p.d_from or end - timedelta(days=29)
    live = [en.c.type == "IPD", en.c.deleted_at.is_(None), en.c.status != "Cancelled"]
    from . import Params as P

    q = P(p.period, start, end, None, {})
    adm = dict((await ctx.conn.execute(sa.select(day(en.c.started_at), sa.func.count()).where(*live, *ts_between(en.c.started_at, q))
                                       .group_by(day(en.c.started_at)))).all())
    dis = dict((await ctx.conn.execute(sa.select(day(en.c.ended_at), sa.func.count()).where(*live, en.c.status == "Discharged",
                                                                                           *ts_between(en.c.ended_at, q)).group_by(day(en.c.ended_at)))).all())
    opening = (await ctx.conn.execute(sa.select(sa.func.count()).where(*live, en.c.started_at < q.start,
                                                                       sa.or_(en.c.ended_at.is_(None), en.c.ended_at >= q.start)))).scalar_one()
    nbeds = (await ctx.conn.execute(sa.select(sa.func.count()).where(beds.c.deleted_at.is_(None), beds.c.status.notin_(["Blocked", "Maintenance"])))).scalar_one()
    out, census = [], opening
    for key, _ in buckets(start, end, "Day"):
        from datetime import date as _d

        d = _d.fromisoformat(key)
        a_, d_ = int(adm.get(d) or 0), int(dis.get(d) or 0)
        row = {"date": key, "opening": census, "admissions": a_, "discharges": d_}
        census = census + a_ - d_
        row.update(closing=census, beds=nbeds, occupancy_pct=pct(census, nbeds))
        out.append(row)
    pdays = sum(r["closing"] for r in out)
    return Result(out, [{"label": "Patient-days", "value": pdays, "format": "number"},
                        {"label": "Avg daily census", "value": round(pdays / len(out), 1) if out else 0, "format": "number"},
                        {"label": "Avg occupancy", "value": pct(pdays, nbeds * len(out)) if out else None, "format": "percent"},
                        {"label": "Operational beds", "value": nbeds, "format": "number"}])


@report("IPD-04", "ALOS by Department", IPD,
        "Average length of stay of patients discharged in the window, per department — discharges, patient-days, ALOS, median and longest stay.",
        [Col("department", "Department"), Col("discharges", "Discharges", "number", total=True), Col("patient_days", "Patient-days", "number", total=True),
         Col("alos", "ALOS (days)", "days"), Col("median", "Median (days)", "days"), Col("max_los", "Longest (days)", "days")],
        filters=[F.period, F.department], access=("ipd.admissions",), icon="CalendarDays",
        chart={"type": "bar", "x": "department", "y": ["alos"], "horizontal": True})
async def ipd_alos(ctx, p: Params) -> Result:
    en = encounters
    los = sa.extract("epoch", en.c.ended_at - en.c.started_at) / 86400
    conds = [en.c.type == "IPD", en.c.status == "Discharged", *ts_between(en.c.ended_at, p)]
    if _uuid(p, "department"):
        conds.append(en.c.department_id == _uuid(p, "department"))
    r1 = lambda x: sa.func.round(sa.cast(x, sa.Numeric), 1)  # noqa: E731
    stmt = (sa.select(sa.func.coalesce(dept.c.title, "Unassigned").label("department"), sa.func.count().label("discharges"),
                      r1(sa.func.sum(los)).label("patient_days"), r1(sa.func.avg(los)).label("alos"), r1(pctile(los, 0.5)).label("median"),
                      r1(sa.func.max(los)).label("max_los"))
            .select_from(en.outerjoin(dept, dept.c.id == en.c.department_id)).where(*conds).group_by(dept.c.title)
            .order_by(sa.func.avg(los).desc()))
    out = await rows(ctx, stmt)
    tot_d, tot_n = sum(f(r["patient_days"]) for r in out), sum(r["discharges"] for r in out)
    return Result(out, [{"label": "Discharges", "value": tot_n, "format": "number"},
                        {"label": "Hospital ALOS (days)", "value": round(tot_d / tot_n, 1) if tot_n else None, "format": "number"}])


@report("IPD-05", "Discharge TAT", IPD,
        "Discharge decision (initiated) to discharge complete (bed free) for each discharge, with median / p90 and the delay reasons.",
        [Col("ip_no", "IP no", "code"), Col("patient", "Patient"), Col("department", "Department"), Col("initiated_at", "Initiated", "datetime"),
         Col("discharged_at", "Discharged", "datetime"), Col("tat", "TAT", "minutes"), Col("delay_reason", "Delay reason"),
         Col("within_target", "Within 3 h", "bool")],
        filters=[F.period, F.department], access=("ipd.admissions",), icon="TimerReset")
async def ipd_discharge_tat(ctx, p: Params) -> Result:
    en, pat = encounters, patients
    ini = jts(en.c.data["discharge_initiated_at"].astext)
    tat = sa.func.coalesce(jnum(en.c.data["discharge_tat_minutes"].astext), minutes(ini, en.c.ended_at))
    ck = records.alias("ck")
    conds = [en.c.type == "IPD", en.c.status == "Discharged", *ts_between(en.c.ended_at, p)]
    if _uuid(p, "department"):
        conds.append(en.c.department_id == _uuid(p, "department"))
    stmt = (sa.select(en.c.code.label("ip_no"), pat.c.title.label("patient"), dept.c.title.label("department"), ini.label("initiated_at"),
                      en.c.ended_at.label("discharged_at"), sa.func.round(sa.cast(tat, sa.Numeric), 0).label("tat"),
                      ck.c.data["delay_reason"].astext.label("delay_reason"))
            .select_from(en.join(pat, pat.c.id == en.c.patient_id).outerjoin(dept, dept.c.id == en.c.department_id)
                         .outerjoin(ck, sa.and_(ck.c.module == "discharge", ck.c.entity == "checklists", ck.c.encounter_id == en.c.id)))
            .where(*conds).order_by(en.c.ended_at.desc()))
    out = await rows(ctx, stmt)
    vals = sorted(f(r["tat"]) for r in out if r["tat"] is not None)
    for r in out:
        r["within_target"] = None if r["tat"] is None else f(r["tat"]) <= 180
    med = vals[len(vals) // 2] if vals else None
    p90 = vals[min(len(vals) - 1, int(len(vals) * 0.9))] if vals else None
    return Result(out, [{"label": "Discharges", "value": len(out), "format": "number"},
                        {"label": "Measured", "value": len(vals), "format": "number"},
                        {"label": "Median TAT", "value": med, "format": "minutes"}, {"label": "p90 TAT", "value": p90, "format": "minutes"},
                        {"label": "Within 3 h", "value": pct(sum(1 for v in vals if v <= 180), len(vals)), "format": "percent"}],
                  note=None if vals else "No discharge-initiated timestamps were recorded for these discharges, so TAT cannot be measured.")


@report("IPD-06", "Bed Occupancy & Turnover by Ward", IPD,
        "Per ward: beds, operational beds, occupied now, blocked, occupancy %, admissions and discharges in the period and the bed turnover rate.",
        [Col("ward", "Ward"), Col("ward_type", "Type"), Col("beds", "Beds", "number", total=True), Col("operational", "Operational", "number", total=True),
         Col("occupied", "Occupied", "number", total=True), Col("blocked", "Blocked", "number", total=True), Col("occupancy_pct", "Occupancy %", "percent"),
         Col("status_band", "Status", "status"), Col("admissions", "Admissions", "number", total=True), Col("discharges", "Discharges", "number", total=True),
         Col("turnover", "Bed turnover", "number")],
        filters=[F.period, F.select("ward_type", "Ward type", ["General", "Semi-private", "Private", "ICU", "HDU", "NICU", "PICU", "Isolation", "Day care"])],
        access=("ipd.beds",), popular=True, icon="Bed", chart={"type": "bar", "x": "ward", "y": ["occupancy_pct"], "horizontal": True})
async def ipd_wards(ctx, p: Params) -> Result:
    w, en = records.alias("w"), encounters
    eb = beds.alias("eb")
    adm = (sa.select(eb.c.ward_id, sa.func.count().label("n")).select_from(en.join(eb, eb.c.id == en.c.bed_id))
           .where(en.c.type == "IPD", en.c.deleted_at.is_(None), *ts_between(en.c.started_at, p)).group_by(eb.c.ward_id).subquery())
    dis = (sa.select(eb.c.ward_id, sa.func.count().label("n")).select_from(en.join(eb, eb.c.id == en.c.bed_id))
           .where(en.c.type == "IPD", en.c.status == "Discharged", *ts_between(en.c.ended_at, p)).group_by(eb.c.ward_id).subquery())
    blocked = beds.c.status.in_(["Blocked", "Maintenance"])
    conds = [beds.c.deleted_at.is_(None)]
    if p.get("ward_type"):
        conds.append(w.c.data["ward_type"].astext == p.get("ward_type"))
    stmt = (sa.select(sa.func.coalesce(w.c.title, "Unassigned").label("ward"), sa.func.max(w.c.data["ward_type"].astext).label("ward_type"),
                      sa.func.count().label("beds"), sa.func.count().filter(sa.not_(blocked)).label("operational"),
                      sa.func.count().filter(beds.c.status == "Occupied").label("occupied"), sa.func.count().filter(blocked).label("blocked"),
                      sa.func.max(sa.func.coalesce(adm.c.n, 0)).label("admissions"), sa.func.max(sa.func.coalesce(dis.c.n, 0)).label("discharges"))
            .select_from(beds.outerjoin(w, w.c.id == beds.c.ward_id).outerjoin(adm, adm.c.ward_id == beds.c.ward_id)
                         .outerjoin(dis, dis.c.ward_id == beds.c.ward_id))
            .where(*conds).group_by(w.c.id, w.c.title))
    out = await rows(ctx, stmt)
    for r in out:
        r["occupancy_pct"] = pct(r["occupied"], r["operational"]) or 0.0
        r["status_band"] = "Full" if r["occupancy_pct"] >= 90 else "Busy" if r["occupancy_pct"] >= 75 else "Available"
        r["turnover"] = round(r["discharges"] / r["operational"], 2) if r["operational"] else None
    out.sort(key=lambda r: -r["occupancy_pct"])
    ob, oc = sum(r["operational"] for r in out), sum(r["occupied"] for r in out)
    return Result(out, [{"label": "Beds", "value": sum(r["beds"] for r in out), "format": "number"},
                        {"label": "Occupied", "value": oc, "format": "number"}, {"label": "Occupancy", "value": pct(oc, ob), "format": "percent"},
                        {"label": "Blocked", "value": sum(r["blocked"] for r in out), "format": "number"},
                        {"label": "Full wards (≥ 90%)", "value": sum(1 for r in out if r["status_band"] == "Full"), "format": "number"}])


@report("IPD-07", "Long-stay Patients", IPD,
        "Patients still admitted beyond a threshold (default 30 days) — for utilisation review, with consultant, ward, payer and diagnosis.",
        [*IP_COLS, Col("los_days", "Days in hospital", "days"), Col("ward", "Ward"), Col("bed", "Bed"), Col("consultant", "Consultant"),
         Col("department", "Department"), Col("payer", "Payer"), Col("diagnosis", "Diagnosis")],
        filters=[F.view(["Over 30 days", "Over 15 days", "Over 7 days", "Over 60 days"]), F.department, F.doctor, F.ward],
        access=("ipd.admissions",), icon="Hourglass", default_period="all")
async def ipd_long(ctx, p: Params) -> Result:
    en = encounters
    days_ = int((p.get("view") or "Over 30 days").split()[1])
    cols, j, w = _ip_select()
    los = sa.func.round(sa.cast(sa.extract("epoch", sa.func.now() - en.c.started_at) / 86400, sa.Numeric), 1)
    conds = [en.c.type == "IPD", en.c.status.in_(["Admitted", "Discharge Initiated"]), en.c.deleted_at.is_(None),
             en.c.started_at < sa.func.now() - sa.text(f"interval '{days_} days'"), *_ip_filters(p, w)]
    out = await rows(ctx, sa.select(*cols, los.label("los_days")).select_from(j).where(*conds).order_by(en.c.started_at))
    for r in out:
        r["_link"] = f"/m/ipd/admissions?r={r.pop('_id')}"
    return Result(out, [{"label": f"Admitted > {days_} days", "value": len(out), "format": "number"}])


@report("IPD-08", "Admissions by Source & Type", IPD,
        "Admissions split by source (OPD, ER, referral, transfer-in…) and type (emergency / elective / day care), with the payer mix.",
        [Col("source", "Source"), Col("emergency", "Emergency", "number", total=True), Col("elective", "Elective", "number", total=True),
         Col("other", "Other types", "number", total=True), Col("total", "Total", "number", total=True), Col("insurance", "Insurance", "number", total=True),
         Col("scheme", "Govt scheme", "number", total=True), Col("share", "Share %", "percent")],
        filters=[F.period, F.department], access=("ipd.admissions",), icon="GitBranch",
        chart={"type": "donut", "x": "source", "y": ["total"]})
async def ipd_sources(ctx, p: Params) -> Result:
    en = encounters
    typ, payer = en.c.data["admission_type"].astext, en.c.data["payer"].astext
    src = sa.func.coalesce(en.c.data["admission_source"].astext, "Not recorded")
    conds = [en.c.type == "IPD", en.c.deleted_at.is_(None), en.c.status != "Cancelled", *ts_between(en.c.started_at, p)]
    if _uuid(p, "department"):
        conds.append(en.c.department_id == _uuid(p, "department"))
    stmt = (sa.select(src.label("source"), sa.func.count().filter(typ == "Emergency").label("emergency"),
                      sa.func.count().filter(typ == "Elective").label("elective"),
                      sa.func.count().filter(sa.or_(typ.is_(None), typ.notin_(["Emergency", "Elective"]))).label("other"),
                      sa.func.count().label("total"), sa.func.count().filter(payer == "Insurance").label("insurance"),
                      sa.func.count().filter(payer == "Government Scheme").label("scheme"))
            .where(*conds).group_by(src).order_by(sa.func.count().desc()))
    return Result(share(await rows(ctx, stmt), "total"))


# ====================================================================== ER

@report("ER-01", "ER Visits Register", ER,
        "Every emergency visit — arrival, triage level, complaint, door-to-doctor, ER length of stay, MLC and disposition.",
        [Col("arrived_at", "Arrived", "datetime"), Col("er_no", "ER no", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("arrival_mode", "Arrival mode", default=False), Col("triage", "Triage"), Col("complaint", "Chief complaint"),
         Col("doctor", "Doctor"), Col("d2d", "Door-to-doctor", "minutes"), Col("er_los", "ER LOS", "minutes", False), Col("mlc", "MLC", "bool"),
         Col("disposition", "Disposition"), Col("status", "Status", "status")],
        filters=[F.period, F.search("ER no / UHID / name…"), F.select("triage", "Triage", ["Red", "Orange", "Yellow", "Green", "Blue", "Black"]),
                 F.status(["Waiting", "In Treatment", "Observation", "Disposed"])],
        access=("er.visits",), icon="Siren", handles_q=True)
async def er_register(ctx, p: Params) -> Result:
    en, pat = encounters, patients
    seen = jts(en.c.data["doctor_seen_at"].astext)
    conds = [en.c.type == "ER", en.c.deleted_at.is_(None), *ts_between(en.c.started_at, p), *_search(p, en.c.code, pat.c.code, pat.c.title)]
    if p.get("triage"):
        conds.append(en.c.data["triage_level"].astext.ilike(f"{p.get('triage')}%"))
    if p.get("status"):
        conds.append(en.c.status == p.get("status"))
    stmt = (sa.select(en.c.started_at.label("arrived_at"), en.c.code.label("er_no"), pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      en.c.data["arrival_mode"].astext.label("arrival_mode"), en.c.data["triage_level"].astext.label("triage"),
                      en.c.data["chief_complaint"].astext.label("complaint"), employees.c.name.label("doctor"),
                      sa.func.round(sa.cast(minutes(en.c.started_at, seen), sa.Numeric), 0).label("d2d"),
                      sa.func.round(sa.cast(jnum(en.c.data["er_los_minutes"].astext), sa.Numeric), 0).label("er_los"),
                      (en.c.data["mlc"].astext == "true").label("mlc"), en.c.data["disposition"].astext.label("disposition"), en.c.status,
                      en.c.id.label("_id"))
            .select_from(en.join(pat, pat.c.id == en.c.patient_id).outerjoin(employees, employees.c.id == en.c.doctor_id))
            .where(*conds).order_by(en.c.started_at.desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["_link"] = f"/m/er/visits?r={r.pop('_id')}"
    d2d = sorted(f(r["d2d"]) for r in out if r["d2d"] is not None)
    return Result(out, [{"label": "ER visits", "value": len(out), "format": "number"},
                        {"label": "Median door-to-doctor", "value": d2d[len(d2d) // 2] if d2d else None, "format": "minutes"},
                        {"label": "MLC", "value": sum(1 for r in out if r["mlc"]), "format": "number"},
                        {"label": "In ER now", "value": sum(1 for r in out if r["status"] != "Disposed"), "format": "number"}])


@report("ER-02", "ER Triage & Door-to-Doctor", ER,
        "Per triage level: visits, median and p90 door-to-doctor time, and the share seen within the level's target (Red 0, Orange 10, "
        "Yellow 30, Green 60 minutes).",
        [Col("triage", "Triage level"), Col("visits", "Visits", "number", total=True), Col("measured", "Measured", "number", total=True),
         Col("median", "Median D2D", "minutes"), Col("p90", "p90 D2D", "minutes"), Col("target", "Target", "minutes"),
         Col("within_pct", "Within target %", "percent")],
        filters=[F.period], access=("er.visits",), icon="Gauge", chart={"type": "bar", "x": "triage", "y": ["median", "p90"]})
async def er_triage(ctx, p: Params) -> Result:
    en = encounters
    seen = jts(en.c.data["doctor_seen_at"].astext)
    d2d = minutes(en.c.started_at, seen)
    tri = sa.func.coalesce(en.c.data["triage_level"].astext, "Not triaged")
    stmt = (sa.select(tri.label("triage"), sa.func.count().label("visits"), sa.func.count().filter(seen.isnot(None)).label("measured"),
                      pctile(d2d, 0.5).filter(seen.isnot(None)).label("median"), pctile(d2d, 0.9).filter(seen.isnot(None)).label("p90"),
                      sa.func.array_agg(d2d).filter(seen.isnot(None)).label("_vals"))
            .where(en.c.type == "ER", en.c.deleted_at.is_(None), *ts_between(en.c.started_at, p)).group_by(tri))
    out = await rows(ctx, stmt)
    targets = {"red": 0, "orange": 10, "yellow": 30, "green": 60, "blue": 120}
    for r in out:
        t = next((v for k, v in targets.items() if k in (r["triage"] or "").lower()), None)
        vals = [f(x) for x in (r.pop("_vals") or [])]
        r["target"] = t
        r["within_pct"] = pct(sum(1 for v in vals if v <= t), len(vals)) if t is not None and vals else None
        r["median"] = round(f(r["median"]), 1) if r["median"] is not None else None
        r["p90"] = round(f(r["p90"]), 1) if r["p90"] is not None else None
    order = ["red", "orange", "yellow", "green", "blue"]
    out.sort(key=lambda r: next((i for i, k in enumerate(order) if k in (r["triage"] or "").lower()), 9))
    return Result(out)


@report("ER-03", "ER Disposition Summary", ER,
        "How ER visits ended — admitted, discharged, referred, LAMA / DAMA, death — with the average ER length of stay for each outcome.",
        [Col("disposition", "Disposition"), Col("visits", "Visits", "number", total=True), Col("share", "Share %", "percent"),
         Col("avg_los", "Avg ER LOS", "minutes"), Col("mlc", "MLC", "number", total=True)],
        filters=[F.period], access=("er.visits",), icon="Split", chart={"type": "donut", "x": "disposition", "y": ["visits"]})
async def er_disposition(ctx, p: Params) -> Result:
    en = encounters
    dp = sa.func.coalesce(en.c.data["disposition"].astext, sa.case((en.c.status == "Disposed", "Not recorded"), else_="Still in ER"))
    stmt = (sa.select(dp.label("disposition"), sa.func.count().label("visits"),
                      sa.func.round(sa.cast(sa.func.avg(jnum(en.c.data["er_los_minutes"].astext)), sa.Numeric), 0).label("avg_los"),
                      sa.func.count().filter(en.c.data["mlc"].astext == "true").label("mlc"))
            .where(en.c.type == "ER", en.c.deleted_at.is_(None), *ts_between(en.c.started_at, p)).group_by(dp).order_by(sa.func.count().desc()))
    return Result(share(await rows(ctx, stmt), "visits"))


# ====================================================================== OT

def _ot_cols():
    r = records
    th = records.alias("th")
    sur = employees.alias("sur")
    ana = employees.alias("ana")
    return r, th, sur, ana


@report("OT-01", "OT Utilisation", OT,
        "Per theatre: sessions available, cases done, knife-to-skin minutes, in-room minutes and utilisation of the available session time.",
        [Col("theatre", "Theatre"), Col("days", "Days", "number"), Col("available_min", "Available (min)", "number", total=True),
         Col("cases", "Cases done", "number", total=True), Col("surgery_min", "Incision–closure (min)", "number", total=True),
         Col("in_room_min", "In-room (min)", "number", total=True), Col("utilisation_pct", "Utilisation %", "percent"),
         Col("cancelled", "Cancelled / postponed", "number", total=True)],
        filters=[F.period], access=("ot.bookings",), popular=True, icon="Scissors",
        chart={"type": "bar", "x": "theatre", "y": ["utilisation_pct"], "horizontal": True})
async def ot_util(ctx, p: Params) -> Result:
    r, th, _, _ = _ot_cols()
    sched = jts(r.c.data["scheduled_at"].astext)
    inc, clo = jts(r.c.data["incision_at"].astext), jts(r.c.data["closure_at"].astext)
    win, wout = jts(r.c.data["wheeled_in_at"].astext), jts(r.c.data["wheeled_out_at"].astext)
    done = r.c.status.in_(["Surgery Completed", "Shifted Out"])
    stmt = (sa.select(sa.func.coalesce(th.c.title, "Unassigned").label("theatre"), sa.func.max(jnum(th.c.data["available_minutes"].astext)).label("_avail"),
                      sa.func.count().filter(done).label("cases"),
                      sa.func.round(sa.cast(sa.func.coalesce(sa.func.sum(minutes(inc, clo)).filter(done), 0), sa.Numeric), 0).label("surgery_min"),
                      sa.func.round(sa.cast(sa.func.coalesce(sa.func.sum(minutes(win, wout)).filter(done), 0), sa.Numeric), 0).label("in_room_min"),
                      sa.func.count().filter(r.c.status.in_(["Cancelled", "Postponed"])).label("cancelled"))
            .select_from(r.outerjoin(th, sa.cast(th.c.id, sa.Text) == r.c.data["theatre"].astext))
            .where(*rec_live("ot", "bookings"), *ts_between(sched, p)).group_by(th.c.title))
    out = await rows(ctx, stmt)
    days_ = p.days or 30
    for x in out:
        x["days"] = days_
        x["available_min"] = round(f(x.pop("_avail") or 480) * days_)
        x["utilisation_pct"] = pct(x["in_room_min"] or x["surgery_min"], x["available_min"])
    return Result(out, [{"label": "Cases done", "value": sum(x["cases"] for x in out), "format": "number"},
                        {"label": "Utilisation", "value": pct(sum(f(x["in_room_min"]) for x in out), sum(x["available_min"] for x in out)),
                         "format": "percent"},
                        {"label": "Cancelled / postponed", "value": sum(x["cancelled"] for x in out), "format": "number"}],
                  note="Available time = the theatre's session minutes (default 480) × days in the period.")


@report("OT-02", "Surgery Register (cases)", OT,
        "Every OT case — date, theatre, patient, procedure, surgeon, anaesthetist, anaesthesia, ASA, type, wound class and duration.",
        [Col("scheduled_at", "Scheduled", "datetime"), Col("booking", "Booking", "code"), Col("theatre", "Theatre"), Col("uhid", "UHID", "code"),
         Col("patient", "Patient"), Col("procedure", "Procedure"), Col("surgeon", "Surgeon"), Col("anaesthetist", "Anaesthetist"),
         Col("anaesthesia", "Anaesthesia", default=False), Col("asa", "ASA", default=False), Col("surgery_type", "Type"),
         Col("wound_class", "Wound class", default=False), Col("duration", "Incision–closure", "minutes"), Col("status", "Status", "status")],
        filters=[F.period, F.search("Booking / patient / procedure…"), F.select("surgery_type", "Type", ["Elective", "Emergency", "Day care"]),
                 F.status(["Scheduled", "Patient In", "Surgery Started", "Surgery Completed", "Shifted Out", "Postponed", "Cancelled"])],
        access=("ot.bookings",), icon="ClipboardList", handles_q=True)
async def ot_register(ctx, p: Params) -> Result:
    r, th, sur, ana = _ot_cols()
    pat = patients
    sched = jts(r.c.data["scheduled_at"].astext)
    conds = [*rec_live("ot", "bookings"), *ts_between(sched, p), *_search(p, r.c.code, pat.c.title, r.c.data["procedure"].astext)]
    if p.get("surgery_type"):
        conds.append(r.c.data["surgery_type"].astext == p.get("surgery_type"))
    if p.get("status"):
        conds.append(r.c.status == p.get("status"))
    stmt = (sa.select(sched.label("scheduled_at"), r.c.code.label("booking"), th.c.title.label("theatre"), pat.c.code.label("uhid"),
                      pat.c.title.label("patient"), r.c.data["procedure"].astext.label("procedure"), sur.c.name.label("surgeon"),
                      ana.c.name.label("anaesthetist"), r.c.data["anaesthesia_type"].astext.label("anaesthesia"),
                      r.c.data["asa_grade"].astext.label("asa"), r.c.data["surgery_type"].astext.label("surgery_type"),
                      r.c.data["wound_class"].astext.label("wound_class"),
                      sa.func.round(sa.cast(minutes(jts(r.c.data["incision_at"].astext), jts(r.c.data["closure_at"].astext)), sa.Numeric), 0).label("duration"),
                      r.c.status, r.c.id.label("_id"))
            .select_from(r.outerjoin(th, sa.cast(th.c.id, sa.Text) == r.c.data["theatre"].astext).outerjoin(pat, pat.c.id == r.c.patient_id)
                         .outerjoin(sur, sa.cast(sur.c.id, sa.Text) == r.c.data["surgeon"].astext)
                         .outerjoin(ana, sa.cast(ana.c.id, sa.Text) == r.c.data["anaesthetist"].astext))
            .where(*conds).order_by(sched.desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["_link"] = f"/m/ot/bookings?r={x.pop('_id')}"
    return Result(out)


@report("OT-03", "OT Cancellations & First-case Delays", OT,
        "Cancelled and postponed cases with the reason, and first cases of the day that started late against the session start.",
        [Col("date", "Date", "date"), Col("theatre", "Theatre"), Col("booking", "Booking", "code"), Col("procedure", "Procedure"),
         Col("event", "Event", "status"), Col("reason", "Reason / delay"), Col("delay_min", "Delay (min)", "minutes")],
        filters=[F.period], access=("ot.bookings",), icon="CalendarOff")
async def ot_cancel(ctx, p: Params) -> Result:
    r, th, _, _ = _ot_cols()
    sched = jts(r.c.data["scheduled_at"].astext)
    base = [*rec_live("ot", "bookings"), *ts_between(sched, p)]
    j = r.outerjoin(th, sa.cast(th.c.id, sa.Text) == r.c.data["theatre"].astext)
    canc = await rows(ctx, sa.select(sa.func.date(local(sched)).label("date"), th.c.title.label("theatre"), r.c.code.label("booking"),
                                     r.c.data["procedure"].astext.label("procedure"), r.c.status.label("event"),
                                     r.c.data["cancel_reason"].astext.label("reason")).select_from(j)
                      .where(*base, r.c.status.in_(["Cancelled", "Postponed"])))
    win = jts(r.c.data["wheeled_in_at"].astext)
    rn = sa.func.row_number().over(partition_by=(th.c.id, sa.func.date(local(sched))), order_by=sched).label("rn")
    sub = (sa.select(sa.func.date(local(sched)).label("date"), th.c.title.label("theatre"), r.c.code.label("booking"),
                     r.c.data["procedure"].astext.label("procedure"), sched.label("sched"), win.label("win"),
                     th.c.data["session_start"].astext.label("session_start"), rn)
           .select_from(j).where(*base, r.c.status.notin_(["Cancelled", "Postponed"])).subquery())
    first = await rows(ctx, sa.select(sub).where(sub.c.rn == 1, sub.c.win.isnot(None)))
    out = list(canc)
    from ..core.util import parse_dt

    for x in first:
        start = parse_dt(x["sched"])
        if x.get("session_start") and start:
            hh, mm = (int(v) for v in x["session_start"].split(":")[:2])
            start = start.replace(hour=hh, minute=mm)
        delay = (parse_dt(x["win"]) - start).total_seconds() / 60 if start and x["win"] else None
        if delay and delay > 15:
            out.append({"date": x["date"], "theatre": x["theatre"], "booking": x["booking"], "procedure": x["procedure"],
                        "event": "Late start", "reason": f"First case wheeled in {round(delay)} min after session start", "delay_min": round(delay)})
    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return Result(out, [{"label": "Cancelled", "value": sum(1 for x in out if x["event"] == "Cancelled"), "format": "number"},
                        {"label": "Postponed", "value": sum(1 for x in out if x["event"] == "Postponed"), "format": "number"},
                        {"label": "Late first cases", "value": sum(1 for x in out if x["event"] == "Late start"), "format": "number"}])


# ====================================================================== clinical / MRD

@report("MRD-01", "Diagnosis Morbidity (ICD-10)", MRD,
        "Diagnoses of admissions in the window — coded ICD-10 (MRD coding / discharge summaries) where available, else the provisional "
        "diagnosis — with cases, deaths and ALOS.",
        [Col("icd", "ICD-10", "code"), Col("diagnosis", "Diagnosis"), Col("cases", "Cases", "number", total=True), Col("share", "Share %", "percent"),
         Col("discharged", "Discharged", "number", total=True), Col("deaths", "Deaths", "number", total=True), Col("alos", "ALOS (days)", "days")],
        filters=[F.period, F.department], access=("ipd.admissions", "mrd.coding"), popular=True, icon="FileHeart",
        chart={"type": "bar", "x": "diagnosis", "y": ["cases"], "horizontal": True})
async def mrd_morbidity(ctx, p: Params) -> Result:
    en = encounters
    cd = records.alias("cd")
    icd = cd.c.data["icd_principal"].astext
    name = sa.func.coalesce(sa.func.nullif(cd.c.data["principal_diagnosis"].astext, ""), en.c.data["diagnosis"].astext, "Not recorded")
    los = sa.extract("epoch", en.c.ended_at - en.c.started_at) / 86400
    death = en.c.data["discharge_type"].astext.in_(["Death", "Expired"])
    conds = [en.c.type == "IPD", en.c.deleted_at.is_(None), en.c.status != "Cancelled", *ts_between(en.c.started_at, p)]
    if _uuid(p, "department"):
        conds.append(en.c.department_id == _uuid(p, "department"))
    stmt = (sa.select(icd.label("icd"), name.label("diagnosis"), sa.func.count().label("cases"),
                      sa.func.count().filter(en.c.status == "Discharged").label("discharged"), sa.func.count().filter(death).label("deaths"),
                      sa.func.round(sa.cast(sa.func.avg(los).filter(en.c.status == "Discharged"), sa.Numeric), 1).label("alos"))
            .select_from(en.outerjoin(cd, sa.and_(cd.c.module == "mrd", cd.c.entity == "coding", cd.c.encounter_id == en.c.id,
                                                  cd.c.deleted_at.is_(None))))
            .where(*conds).group_by(icd, name).order_by(sa.func.count().desc()).limit(200))
    return Result(share(await rows(ctx, stmt), "cases"))


@report("MRD-02", "Mortality Report", MRD,
        "Deaths among discharges by department — gross and net (> 48 h) mortality rates, deaths within 48 h of admission and ICU deaths.",
        [Col("department", "Department"), Col("discharges", "Discharges (incl. deaths)", "number", total=True),
         Col("deaths", "Deaths", "number", total=True), Col("within_48h", "Within 48 h", "number", total=True),
         Col("gross_rate", "Gross mortality %", "percent"), Col("net_rate", "Net mortality %", "percent")],
        filters=[F.period], access=("ipd.admissions", "mrd.case_files"), icon="HeartCrack")
async def mrd_mortality(ctx, p: Params) -> Result:
    en = encounters
    death = en.c.data["discharge_type"].astext.in_(["Death", "Expired"])
    early = (en.c.ended_at - en.c.started_at) < sa.text("interval '48 hours'")
    stmt = (sa.select(sa.func.coalesce(dept.c.title, "Unassigned").label("department"), sa.func.count().label("discharges"),
                      sa.func.count().filter(death).label("deaths"), sa.func.count().filter(death, early).label("within_48h"))
            .select_from(en.outerjoin(dept, dept.c.id == en.c.department_id))
            .where(en.c.type == "IPD", en.c.status == "Discharged", *ts_between(en.c.ended_at, p)).group_by(dept.c.title)
            .order_by(sa.func.count().filter(death).desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["gross_rate"] = pct(r["deaths"], r["discharges"], 2) or 0.0
        r["net_rate"] = pct(r["deaths"] - r["within_48h"], r["discharges"] - r["within_48h"], 2) or 0.0
    td, tn = sum(r["deaths"] for r in out), sum(r["discharges"] for r in out)
    return Result(out, [{"label": "Discharges", "value": tn, "format": "number"}, {"label": "Deaths", "value": td, "format": "number"},
                        {"label": "Gross mortality", "value": pct(td, tn, 2), "format": "percent"}])


@report("MRD-03", "Readmissions within 30 Days", MRD,
        "Patients re-admitted within 30 days of a discharge — the index stay, the readmission, the gap in days and whether the "
        "department was the same.",
        [Col("uhid", "UHID", "code"), Col("patient", "Patient"), Col("index_ip", "Index IP no", "code"), Col("index_discharge", "Discharged", "datetime"),
         Col("index_dept", "Index department"), Col("readmit_ip", "Readmission IP no", "code"), Col("readmitted_at", "Readmitted", "datetime"),
         Col("readmit_dept", "Readmission department"), Col("gap_days", "Gap (days)", "days"), Col("same_dept", "Same department", "bool")],
        filters=[F.period, F.department], access=("ipd.admissions",), icon="Repeat")
async def mrd_readmit(ctx, p: Params) -> Result:
    a, b = encounters.alias("a"), encounters.alias("b")
    pat = patients
    da, db = records.alias("da"), records.alias("db")
    gap = sa.extract("epoch", b.c.started_at - a.c.ended_at) / 86400
    conds = [a.c.type == "IPD", b.c.type == "IPD", a.c.status == "Discharged", b.c.deleted_at.is_(None), b.c.status != "Cancelled",
             b.c.started_at > a.c.ended_at, b.c.started_at <= a.c.ended_at + sa.text("interval '30 days'"), *ts_between(b.c.started_at, p)]
    if _uuid(p, "department"):
        conds.append(b.c.department_id == _uuid(p, "department"))
    stmt = (sa.select(pat.c.code.label("uhid"), pat.c.title.label("patient"), a.c.code.label("index_ip"), a.c.ended_at.label("index_discharge"),
                      da.c.title.label("index_dept"), b.c.code.label("readmit_ip"), b.c.started_at.label("readmitted_at"),
                      db.c.title.label("readmit_dept"), sa.func.round(sa.cast(gap, sa.Numeric), 1).label("gap_days"),
                      (a.c.department_id == b.c.department_id).label("same_dept"))
            .select_from(a.join(b, b.c.patient_id == a.c.patient_id).join(pat, pat.c.id == a.c.patient_id)
                         .outerjoin(da, da.c.id == a.c.department_id).outerjoin(db, db.c.id == b.c.department_id))
            .where(*conds).order_by(b.c.started_at.desc()))
    out = await rows(ctx, stmt)
    en = encounters
    admits = (await ctx.conn.execute(sa.select(sa.func.count()).where(en.c.type == "IPD", en.c.deleted_at.is_(None),
                                                                      *ts_between(en.c.started_at, p)))).scalar_one()
    return Result(out, [{"label": "Readmissions", "value": len(out), "format": "number"},
                        {"label": "Readmission rate", "value": pct(len(out), admits, 2), "format": "percent"},
                        {"label": "Same department", "value": sum(1 for r in out if r["same_dept"]), "format": "number"}])


@report("MRD-04", "Case-file Completeness", MRD,
        "Medical-record files by status and deficiency — awaiting receipt from wards, deficient (what is missing), complete and archived.",
        [Col("department", "Department"), Col("files", "Files", "number", total=True), Col("awaiting", "Awaiting receipt", "number", total=True),
         Col("deficient", "Deficient", "number", total=True), Col("complete", "Complete / archived", "number", total=True),
         Col("complete_pct", "Complete %", "percent"), Col("top_deficiency", "Commonest deficiency")],
        filters=[F.period], access=("mrd.case_files",), icon="FolderCheck")
async def mrd_files(ctx, p: Params) -> Result:
    r = records
    dpt = records.alias("dpt")
    stmt = (sa.select(sa.func.coalesce(dpt.c.title, "Unassigned").label("department"), sa.func.count().label("files"),
                      sa.func.count().filter(r.c.status == "Awaiting Receipt").label("awaiting"),
                      sa.func.count().filter(r.c.status == "Deficient").label("deficient"),
                      sa.func.count().filter(r.c.status.in_(["Complete", "Archived"])).label("complete"))
            .select_from(r.outerjoin(dpt, sa.cast(dpt.c.id, sa.Text) == r.c.data["department"].astext))
            .where(*rec_live("mrd", "case_files"), *text_between(r.c.data["discharge_date"].astext, p)).group_by(dpt.c.title))
    out = await rows(ctx, stmt)
    d = sa.func.jsonb_array_elements_text(r.c.data["deficiencies"]).label("d")
    counts: dict = {}
    for dep_title, item in (await ctx.conn.execute(
            sa.select(sa.func.coalesce(dpt.c.title, "Unassigned"), d)
            .select_from(r.outerjoin(dpt, sa.cast(dpt.c.id, sa.Text) == r.c.data["department"].astext))
            .where(*rec_live("mrd", "case_files"), sa.func.jsonb_typeof(r.c.data["deficiencies"]) == "array",
                   *text_between(r.c.data["discharge_date"].astext, p)))).all():
        counts.setdefault(dep_title, {}).setdefault(item, 0)
        counts[dep_title][item] += 1
    for x in out:
        x["complete_pct"] = pct(x["complete"], x["files"])
        c = counts.get(x["department"]) or {}
        x["top_deficiency"] = max(c, key=c.get) if c else None
    return Result(out)


@report("MRD-05", "Coding Progress", MRD,
        "MRD coding queue — encounters pending coding, under doctor query, coded and validated — per coder, with the oldest pending item.",
        [Col("coder", "Coder"), Col("pending", "Pending", "number", total=True), Col("query", "Query raised", "number", total=True),
         Col("coded", "Coded", "number", total=True), Col("validated", "Validated", "number", total=True),
         Col("oldest_pending", "Oldest pending", "datetime")],
        filters=[F.period], access=("mrd.coding",), icon="Binary", default_period="all")
async def mrd_coding(ctx, p: Params) -> Result:
    r = records
    st = r.c.status
    stmt = (sa.select(sa.func.coalesce(employees.c.name, "Unassigned").label("coder"), sa.func.count().filter(st == "Pending").label("pending"),
                      sa.func.count().filter(st == "Query Raised").label("query"), sa.func.count().filter(st == "Coded").label("coded"),
                      sa.func.count().filter(st == "Validated").label("validated"),
                      sa.func.min(r.c.created_at).filter(st.in_(["Pending", "Query Raised"])).label("oldest_pending"))
            .select_from(r.outerjoin(employees, sa.cast(employees.c.id, sa.Text) == r.c.data["coder"].astext))
            .where(*rec_live("mrd", "coding"), *ts_between(r.c.created_at, p)).group_by(employees.c.name))
    return Result(await rows(ctx, stmt))


# ====================================================================== lab & radiology

def _orders_base(category_: str, p: Params):
    o, sv = orders, services
    return o.outerjoin(sv, sv.c.id == o.c.service_id), [o.c.category == category_, o.c.deleted_at.is_(None), *ts_between(o.c.ordered_at, p)]


def _volumes_report(cat: str):
    async def run(ctx, p: Params) -> Result:
        o, sv = orders, services
        j, conds = _orders_base(cat, p)
        if p.get("priority"):
            conds.append(o.c.priority == p.get("priority"))
        if p.q:
            conds.append(sv.c.title.ilike(f"%{p.q}%"))
        stmt = (sa.select(sa.func.coalesce(sv.c.title, "Unknown").label("test"), sv.c.code.label("code"), sa.func.count().label("ordered"),
                          sa.func.count().filter(o.c.status == "Verified").label("verified"),
                          sa.func.count().filter(o.c.status.in_(["Ordered", "Collected", "In Progress", "Resulted"])).label("pending"),
                          sa.func.count().filter(o.c.status == "Cancelled").label("cancelled"),
                          sa.func.count().filter(o.c.critical.is_(True)).label("critical"))
                .select_from(j).where(*conds).group_by(sv.c.title, sv.c.code).order_by(sa.func.count().desc()))
        out = share(await rows(ctx, stmt), "ordered")
        return Result(out, [{"label": "Ordered", "value": sum(r["ordered"] for r in out), "format": "number"},
                            {"label": "Verified", "value": sum(r["verified"] for r in out), "format": "number"},
                            {"label": "Pending", "value": sum(r["pending"] for r in out), "format": "number"},
                            {"label": "Critical", "value": sum(r["critical"] for r in out), "format": "number"}])
    return run


report("LAB-01", "Lab Test Volumes", LAB,
        "Tests ordered per test in the window — verified, pending in the lab, cancelled — and critical results flagged.",
        [Col("test", "Test"), Col("code", "Code", "code", False), Col("ordered", "Ordered", "number", total=True),
         Col("verified", "Verified", "number", total=True), Col("pending", "Pending", "number", total=True),
         Col("cancelled", "Cancelled", "number", total=True), Col("critical", "Critical", "number", total=True), Col("share", "Share %", "percent")],
        filters=[F.period, F.search("Test…"), F.select("priority", "Priority", ["Routine", "Urgent", "STAT"])], access=("lab.lab_orders",),
        popular=True, icon="TestTubes", handles_q=True, chart={"type": "bar", "x": "test", "y": ["ordered"], "horizontal": True})(_volumes_report("LAB"))


def _tat_report(cat: str):
    async def run(ctx, p: Params) -> Result:
        o, sv = orders, services
        j, conds = _orders_base(cat, p)
        start = o.c.collected_at if cat == "LAB" else o.c.ordered_at
        done = sa.func.coalesce(o.c.verified_at, o.c.resulted_at)
        tat = minutes(start, done)
        ok = sa.and_(start.isnot(None), done.isnot(None))
        sla = sv.c.tat_minutes
        if p.q:
            conds.append(sv.c.title.ilike(f"%{p.q}%"))
        stmt = (sa.select(sa.func.coalesce(sv.c.title, "Unknown").label("test"), sa.func.max(sla).label("sla"),
                          sa.func.count().filter(o.c.status != "Cancelled").label("tests"), sa.func.count().filter(ok).label("measured"),
                          pctile(tat, 0.5).filter(ok).label("median"), pctile(tat, 0.9).filter(ok).label("p90"),
                          sa.func.count().filter(ok, sla.isnot(None), tat <= sla).label("within"),
                          sa.func.count().filter(ok, sla.isnot(None), tat > sla).label("breaches"))
                .select_from(j).where(*conds).group_by(sv.c.title).order_by(sa.func.count().filter(ok, sla.isnot(None), tat > sla).desc()))
        out = await rows(ctx, stmt)
        for r in out:
            r["median"] = round(f(r["median"]), 1) if r["median"] is not None else None
            r["p90"] = round(f(r["p90"]), 1) if r["p90"] is not None else None
            r["within_pct"] = pct(r["within"], r["within"] + r["breaches"])
            r["coverage"] = pct(r["measured"], r["tests"])
        tw, tb = sum(r["within"] for r in out), sum(r["breaches"] for r in out)
        return Result(out, [{"label": "Tests", "value": sum(r["tests"] for r in out), "format": "number"},
                            {"label": "Measured", "value": sum(r["measured"] for r in out), "format": "number"},
                            {"label": "Within SLA", "value": pct(tw, tw + tb), "format": "percent"},
                            {"label": "Breaches", "value": tb, "format": "number"}])
    return run


TAT_COLS = [Col("test", "Test / study"), Col("sla", "SLA", "minutes"), Col("tests", "Tests", "number", total=True),
            Col("measured", "Measured", "number", total=True), Col("coverage", "Coverage %", "percent", False), Col("median", "Median TAT", "minutes"),
            Col("p90", "p90 TAT", "minutes"), Col("within", "Within SLA", "number", total=True), Col("breaches", "Breaches", "number", total=True),
            Col("within_pct", "Within SLA %", "percent")]

report("LAB-02", "Lab TAT by Test vs SLA", LAB,
       "Per test: collection → release turnaround (median, p90) against the test's own SLA from the tariff, with the breaches counted.",
       TAT_COLS, filters=[F.period, F.search("Test…")], access=("lab.lab_orders",), popular=True, icon="Timer", handles_q=True,
       chart={"type": "bar", "x": "test", "y": ["median", "p90"], "horizontal": True})(_tat_report("LAB"))
report("RAD-02", "Radiology TAT by Study vs SLA", LAB,
       "Per study: order → report verification turnaround (median, p90) against the study's SLA, with breaches.",
       TAT_COLS, filters=[F.period, F.search("Study…")], access=("radiology.rad_orders",), icon="ScanLine", handles_q=True,
       chart={"type": "bar", "x": "test", "y": ["median", "p90"], "horizontal": True})(_tat_report("RAD"))


report("RAD-01", "Radiology Study Volumes", LAB,
       "Studies ordered per modality / study — reported and verified, pending, cancelled and critical findings.",
       [Col("test", "Study"), Col("code", "Code", "code", False), Col("ordered", "Ordered", "number", total=True),
        Col("verified", "Reported", "number", total=True), Col("pending", "Pending", "number", total=True),
        Col("cancelled", "Cancelled", "number", total=True), Col("critical", "Critical", "number", total=True), Col("share", "Share %", "percent")],
       filters=[F.period, F.search("Study…"), F.select("priority", "Priority", ["Routine", "Urgent", "STAT"])], access=("radiology.rad_orders",),
       icon="ScanLine", handles_q=True, chart={"type": "bar", "x": "test", "y": ["ordered"], "horizontal": True})(_volumes_report("RAD"))


@report("LAB-03", "Critical Values Report", LAB,
        "Critical results — patient, test, when resulted, when acknowledged and by whom, minutes to acknowledge and whether within 30 minutes.",
        [Col("resulted_at", "Resulted", "datetime"), Col("order", "Order", "code"), Col("uhid", "UHID", "code"), Col("patient", "Patient"),
         Col("test", "Test"), Col("category", "Lab / radiology", default=False), Col("acknowledged_at", "Acknowledged", "datetime"),
         Col("acknowledged_by", "Acknowledged by"), Col("minutes_to_ack", "Minutes to ack", "minutes"), Col("within_30", "Within 30 min", "bool")],
        filters=[F.period, F.select("ack", "Acknowledgement", ["Acknowledged", "Not acknowledged"])], access=("lab.lab_orders", "orders.orders"),
        popular=True, icon="AlertTriangle")
async def lab_critical(ctx, p: Params) -> Result:
    o, sv, pat = orders, services, patients
    res = sa.func.coalesce(o.c.resulted_at, o.c.verified_at)
    mins = minutes(res, o.c.acknowledged_at)
    conds = [o.c.critical.is_(True), o.c.deleted_at.is_(None), *ts_between(res, p)]
    if p.get("ack") == "Acknowledged":
        conds.append(o.c.acknowledged_at.isnot(None))
    elif p.get("ack") == "Not acknowledged":
        conds.append(o.c.acknowledged_at.is_(None))
    stmt = (sa.select(res.label("resulted_at"), o.c.code.label("order"), pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      sv.c.title.label("test"), o.c.category, o.c.acknowledged_at, o.c.data["acknowledged_by"].astext.label("acknowledged_by"),
                      sa.func.round(sa.cast(mins, sa.Numeric), 0).label("minutes_to_ack"))
            .select_from(o.join(pat, pat.c.id == o.c.patient_id).outerjoin(sv, sv.c.id == o.c.service_id)).where(*conds).order_by(res.desc()))
    out = await rows(ctx, stmt)
    for r in out:
        r["within_30"] = None if r["minutes_to_ack"] is None else f(r["minutes_to_ack"]) <= 30
    acked = [r for r in out if r["minutes_to_ack"] is not None]
    return Result(out, [{"label": "Critical results", "value": len(out), "format": "number"},
                        {"label": "Unacknowledged", "value": len(out) - len(acked), "format": "number"},
                        {"label": "Within 30 min", "value": pct(sum(1 for r in acked if r["within_30"]), len(acked)), "format": "percent"}])


@report("LAB-04", "Lab Backlog & Pending Ageing", LAB,
        "Lab and radiology orders not yet verified — where each sits (ordered, collected, in progress, resulted) and how long it has waited.",
        [Col("ordered_at", "Ordered", "datetime"), Col("order", "Order", "code"), Col("category", "Lab / radiology"), Col("priority", "Priority"),
         Col("uhid", "UHID", "code"), Col("patient", "Patient"), Col("test", "Test / study"), Col("age_min", "Waiting", "minutes"),
         Col("status", "Status", "status")],
        filters=[F.select("category", "Category", ["LAB", "RAD"]), F.select("priority", "Priority", ["Routine", "Urgent", "STAT"]),
                 F.status(["Ordered", "Collected", "In Progress", "Resulted"])],
        access=("lab.lab_orders", "radiology.rad_orders"), icon="ListTodo", default_period="all")
async def lab_backlog(ctx, p: Params) -> Result:
    o, sv, pat = orders, services, patients
    conds = [o.c.deleted_at.is_(None), o.c.category.in_([p.get("category")] if p.get("category") else ["LAB", "RAD"]),
             o.c.status.in_([p.get("status")] if p.get("status") else ["Ordered", "Collected", "In Progress", "Resulted"])]
    if p.get("priority"):
        conds.append(o.c.priority == p.get("priority"))
    stmt = (sa.select(o.c.ordered_at, o.c.code.label("order"), o.c.category, o.c.priority, pat.c.code.label("uhid"), pat.c.title.label("patient"),
                      sv.c.title.label("test"), sa.func.round(sa.cast(minutes(o.c.ordered_at, sa.func.now()), sa.Numeric), 0).label("age_min"),
                      o.c.status)
            .select_from(o.join(pat, pat.c.id == o.c.patient_id).outerjoin(sv, sv.c.id == o.c.service_id)).where(*conds).order_by(o.c.ordered_at))
    out = await rows(ctx, stmt)
    return Result(out, [{"label": "Pending", "value": len(out), "format": "number"},
                        {"label": "STAT / urgent", "value": sum(1 for r in out if r["priority"] in ("STAT", "Urgent")), "format": "number"},
                        {"label": "Waiting > 4 h", "value": sum(1 for r in out if f(r["age_min"]) > 240), "format": "number"}])


@report("LAB-05", "Sample Rejections", LAB,
        "Samples rejected at reception — reason, sample type, collecting location — the pre-analytical quality indicator.",
        [Col("date", "Date", "datetime"), Col("sample", "Sample", "code"), Col("patient", "Patient"), Col("sample_type", "Sample type"),
         Col("reason", "Rejection reason"), Col("location", "Collected at")],
        filters=[F.period], access=("lab.samples",), icon="TestTubeDiagonal")
async def lab_rejections(ctx, p: Params) -> Result:
    r, pat = records, patients
    stmt = (sa.select(r.c.updated_at.label("date"), r.c.code.label("sample"), pat.c.title.label("patient"),
                      r.c.data["sample_type"].astext.label("sample_type"), r.c.data["rejection_reason"].astext.label("reason"),
                      r.c.data["collected_at_location"].astext.label("location"))
            .select_from(r.outerjoin(pat, pat.c.id == r.c.patient_id))
            .where(*rec_live("lab", "samples"), r.c.status == "Rejected", *ts_between(r.c.updated_at, p)).order_by(r.c.updated_at.desc()))
    out = await rows(ctx, stmt)
    total = (await ctx.conn.execute(sa.select(sa.func.count()).select_from(r).where(*rec_live("lab", "samples"),
                                                                                    *ts_between(r.c.created_at, p)))).scalar_one()
    return Result(out, [{"label": "Rejected", "value": len(out), "format": "number"},
                        {"label": "Rejection rate", "value": pct(len(out), total, 2), "format": "percent"}])


# ====================================================================== statutory registers (from the register framework)

def _statutory():
    from ..engines.registers import REGISTERS

    for i, reg in enumerate(REGISTERS.values(), 1):
        cols = [Col(k, lbl, "text") for k, lbl in reg.columns]

        def make(r=reg):
            async def run(ctx, p: Params) -> Result:
                start = p.d_from or today().replace(day=1)
                end = p.d_to or today()
                out = await r.build(ctx, start, end)
                return Result(out, [{"label": "Entries", "value": len(out), "format": "number"}],
                              note=f"{r.legal_basis} · Authority: {r.authority}. Sign the month off in Registers.")
            return run

        report(f"STAT-{i:02d}", reg.name, STAT,
               f"{reg.name} generated from live records ({reg.frequency.lower()}). Legal basis: {reg.legal_basis}.",
               cols, access=(reg.source,), roles=(), icon="BookCheck", kind="statutory", tags=("statutory", reg.klass.lower()))(make())


_statutory()
