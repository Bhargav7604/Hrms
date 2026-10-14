"""HR & payroll and audit reports."""

from __future__ import annotations

from datetime import timedelta

import sqlalchemy as sa

from ..core.util import today
from ..schema import audit_log, employees, invoices, payments, records, users
from . import Col, F, Params, Result, category, report
from ._sql import dept, f, jnum, pct, rec_live, rows, text_between, ts_between

HR = category("HR & Payroll", "Headcount, attrition, attendance, leave, payroll cost and credential expiry.", "UsersRound", 19)
AUD = category("Audit", "Discounts, refunds, cancellations, break-the-glass access, login failures and user activity.", "ScanEye", 20)

EMP_ACCESS = ("employees.employees",)
AUDIT_ROLES = ("management", "quality")
CATEGORIES = ["Doctor", "Nurse", "Technician", "Pharmacist", "Therapist", "Administrative", "Support", "Management"]
EXITED = ["Resigned", "Terminated"]


@report("HR-01", "Headcount by Department", HR,
        "Active staff per department split by category — doctors, nurses, technicians, others — with joiners and exits in the period.",
        [Col("department", "Department"), Col("headcount", "Active", "number", total=True), Col("doctors", "Doctors", "number", total=True),
         Col("nurses", "Nurses", "number", total=True), Col("technicians", "Technicians", "number", total=True), Col("others", "Others", "number", total=True),
         Col("on_notice", "On notice", "number", total=True), Col("joined", "Joined", "number", total=True), Col("exited", "Exited", "number", total=True)],
        filters=[F.period, F.select("category", "Category", CATEGORIES)], access=EMP_ACCESS, popular=True, icon="UsersRound",
        chart={"type": "bar", "x": "department", "y": ["doctors", "nurses", "technicians", "others"], "horizontal": True, "stacked": True})
async def hr_headcount(ctx, p: Params) -> Result:
    e = employees
    active = e.c.status.in_(["Active", "On Notice"])
    lwd = sa.cast(sa.func.nullif(e.c.data["last_working_day"].astext, ""), sa.Date)
    conds = [e.c.deleted_at.is_(None)]
    if p.get("category"):
        conds.append(e.c.category == p.get("category"))
    joined = [e.c.doj >= p.d_from, e.c.doj <= p.d_to] if p.d_from else [sa.false()]
    exited = [e.c.status.in_(EXITED), lwd >= p.d_from, lwd <= p.d_to] if p.d_from else [sa.false()]
    stmt = (sa.select(sa.func.coalesce(dept.c.title, "Unassigned").label("department"), sa.func.count().filter(active).label("headcount"),
                      sa.func.count().filter(active, e.c.category == "Doctor").label("doctors"),
                      sa.func.count().filter(active, e.c.category == "Nurse").label("nurses"),
                      sa.func.count().filter(active, e.c.category == "Technician").label("technicians"),
                      sa.func.count().filter(active, e.c.category.notin_(["Doctor", "Nurse", "Technician"])).label("others"),
                      sa.func.count().filter(e.c.status == "On Notice").label("on_notice"),
                      sa.func.count().filter(*joined).label("joined"), sa.func.count().filter(*exited).label("exited"))
            .select_from(e.outerjoin(dept, dept.c.id == e.c.department_id)).where(*conds).group_by(dept.c.title)
            .order_by(sa.func.count().filter(active).desc()))
    out = await rows(ctx, stmt)
    return Result(out, [{"label": "Active staff", "value": sum(x["headcount"] for x in out), "format": "number"},
                        {"label": "Doctors", "value": sum(x["doctors"] for x in out), "format": "number"},
                        {"label": "Nurses", "value": sum(x["nurses"] for x in out), "format": "number"},
                        {"label": "Joined", "value": sum(x["joined"] for x in out), "format": "number"},
                        {"label": "Exited", "value": sum(x["exited"] for x in out), "format": "number"}])


@report("HR-02", "Attrition Report", HR,
        "Exits (resigned / terminated with the last working day in the period) against the average headcount, per category, with exit reasons.",
        [Col("category", "Category"), Col("opening", "Opening headcount", "number", total=True), Col("joined", "Joined", "number", total=True),
         Col("exited", "Exited", "number", total=True), Col("closing", "Closing headcount", "number", total=True),
         Col("attrition_pct", "Attrition %", "percent"), Col("top_reason", "Commonest exit reason")],
        filters=[F.period], access=EMP_ACCESS, icon="UserMinus", default_period="this_fy")
async def hr_attrition(ctx, p: Params) -> Result:
    e = employees
    start, end = p.d_from or today().replace(day=1), p.d_to or today()
    lwd = sa.cast(sa.func.nullif(e.c.data["last_working_day"].astext, ""), sa.Date)
    left_before = sa.and_(e.c.status.in_(EXITED), lwd < start)
    stmt = (sa.select(sa.func.coalesce(e.c.category, "Other").label("category"),
                      sa.func.count().filter(sa.or_(e.c.doj.is_(None), e.c.doj < start), sa.not_(left_before)).label("opening"),
                      sa.func.count().filter(e.c.doj >= start, e.c.doj <= end).label("joined"),
                      sa.func.count().filter(e.c.status.in_(EXITED), lwd >= start, lwd <= end).label("exited"),
                      sa.func.mode().within_group(e.c.data["exit_reason"].astext).filter(e.c.status.in_(EXITED)).label("top_reason"))
            .where(e.c.deleted_at.is_(None)).group_by(e.c.category))
    out = await rows(ctx, stmt)
    for x in out:
        x["closing"] = x["opening"] + x["joined"] - x["exited"]
        x["attrition_pct"] = pct(x["exited"], (x["opening"] + x["closing"]) / 2, 2) or 0.0
    to, tc, tx = sum(x["opening"] for x in out), sum(x["closing"] for x in out), sum(x["exited"] for x in out)
    return Result(out, [{"label": "Exits", "value": tx, "format": "number"},
                        {"label": "Attrition", "value": pct(tx, (to + tc) / 2, 2), "format": "percent"}])


@report("HR-03", "Attendance Summary", HR,
        "Per employee: days present, absent, half days, on leave, late arrivals and minutes late, hours worked and overtime in the period.",
        [Col("emp_code", "Emp code", "code"), Col("employee", "Employee"), Col("department", "Department"), Col("present", "Present", "number", total=True),
         Col("absent", "Absent", "number", total=True), Col("half_day", "Half day", "number", total=True), Col("leave", "On leave", "number", total=True),
         Col("late_days", "Late days", "number", total=True), Col("late_minutes", "Late (min)", "number", False, total=True),
         Col("hours", "Hours worked", "number", total=True), Col("overtime", "Overtime (h)", "number", total=True)],
        filters=[F.period, F.department, F.search("Employee…")], access=("roster.attendance",), icon="CalendarCheck2", handles_q=True)
async def hr_attendance(ctx, p: Params) -> Result:
    r, e = records, employees
    st = r.c.status
    conds = [*rec_live("roster", "attendance"), *text_between(r.c.data["att_date"].astext, p)]
    if p.get("department"):
        conds.append(sa.cast(e.c.department_id, sa.Text) == p.get("department"))
    if p.q:
        conds.append(e.c.name.ilike(f"%{p.q}%"))
    late = jnum(r.c.data["late_minutes"].astext)
    stmt = (sa.select(e.c.code.label("emp_code"), e.c.name.label("employee"), dept.c.title.label("department"),
                      sa.func.count().filter(st == "Present").label("present"), sa.func.count().filter(st == "Absent").label("absent"),
                      sa.func.count().filter(st == "Half Day").label("half_day"), sa.func.count().filter(st == "On Leave").label("leave"),
                      sa.func.count().filter(late > 0).label("late_days"), sa.func.coalesce(sa.func.sum(late), 0).label("late_minutes"),
                      sa.func.round(sa.cast(sa.func.coalesce(sa.func.sum(jnum(r.c.data["hours_worked"].astext)), 0), sa.Numeric), 1).label("hours"),
                      sa.func.round(sa.cast(sa.func.coalesce(sa.func.sum(jnum(r.c.data["overtime_hours"].astext)), 0), sa.Numeric), 1).label("overtime"))
            .select_from(r.join(e, e.c.id == r.c.employee_id).outerjoin(dept, dept.c.id == e.c.department_id))
            .where(*conds).group_by(e.c.code, e.c.name, dept.c.title).order_by(e.c.name))
    out = await rows(ctx, stmt)
    pr, ab = sum(x["present"] for x in out), sum(x["absent"] for x in out)
    return Result(out, [{"label": "Employees", "value": len(out), "format": "number"},
                        {"label": "Attendance rate", "value": pct(pr, pr + ab), "format": "percent"},
                        {"label": "Late arrivals", "value": sum(x["late_days"] for x in out), "format": "number"},
                        {"label": "Overtime (h)", "value": sum(f(x["overtime"]) for x in out), "format": "number"}])


@report("HR-04", "Payroll Cost by Department", HR,
        "Payslips for the months in the period by department — employees paid, gross, deductions, net pay, employer PF and ESI and total cost.",
        [Col("department", "Department"), Col("employees", "Employees", "number", total=True), Col("gross", "Gross", "money", total=True),
         Col("deductions", "Deductions", "money", total=True), Col("net", "Net pay", "money", total=True),
         Col("employer_pf", "Employer PF", "money", total=True), Col("employer_esi", "Employer ESI", "money", total=True),
         Col("cost", "Total cost", "money", total=True), Col("share", "Share %", "percent")],
        filters=[F.period], access=("payroll.payslips",), roles=("hr", "management"), icon="Wallet", default_period="last_month",
        chart={"type": "bar", "x": "department", "y": ["cost"], "horizontal": True})
async def hr_payroll(ctx, p: Params) -> Result:
    r, e = records, employees
    months = []
    if p.d_from:
        d = p.d_from.replace(day=1)
        while d <= p.d_to:
            months.append(d.strftime("%Y-%m"))
            d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    conds = [*rec_live("payroll", "payslips")]
    if months:
        conds.append(r.c.data["period"].astext.in_(months))
    g, pf, esi = jnum(r.c.data["gross"].astext), jnum(r.c.data["employer_pf"].astext), jnum(r.c.data["employer_esi"].astext)
    stmt = (sa.select(sa.func.coalesce(dept.c.title, "Unassigned").label("department"), sa.func.count(sa.distinct(r.c.employee_id)).label("employees"),
                      sa.func.sum(g).label("gross"), sa.func.sum(jnum(r.c.data["total_deductions"].astext)).label("deductions"),
                      sa.func.sum(jnum(r.c.data["net_pay"].astext)).label("net"), sa.func.coalesce(sa.func.sum(pf), 0).label("employer_pf"),
                      sa.func.coalesce(sa.func.sum(esi), 0).label("employer_esi"))
            .select_from(r.outerjoin(e, e.c.id == r.c.employee_id).outerjoin(dept, dept.c.id == e.c.department_id))
            .where(*conds).group_by(dept.c.title).order_by(sa.func.sum(g).desc()))
    out = await rows(ctx, stmt)
    for x in out:
        x["cost"] = f(x["gross"]) + f(x["employer_pf"]) + f(x["employer_esi"])
    tot = sum(x["cost"] for x in out)
    for x in out:
        x["share"] = round(x["cost"] / tot * 100, 1) if tot else 0.0
    return Result(out, [{"label": "Total cost", "value": tot, "format": "money"},
                        {"label": "Net pay", "value": sum(f(x["net"]) for x in out), "format": "money"},
                        {"label": "Employees", "value": sum(x["employees"] for x in out), "format": "number"}],
                  note=f"Payroll months: {', '.join(months) if months else 'all'}.")


@report("HR-05", "Licence & Credential Expiry", HR,
        "Professional registrations (medical / nursing council), BLS / ACLS and other credentials expired or expiring within 90 days.",
        [Col("employee", "Employee"), Col("emp_code", "Emp code", "code", False), Col("category", "Category"), Col("department", "Department"),
         Col("credential", "Credential"), Col("number", "Number", default=False), Col("valid_until", "Valid until", "date"),
         Col("days_left", "Days left", "number"), Col("status", "Status", "status")],
        filters=[F.view(["Within 90 days", "Within 30 days", "Within 180 days"]), F.department], access=EMP_ACCESS, icon="BadgeAlert",
        default_period="all")
async def hr_credentials(ctx, p: Params) -> Result:
    e, r = employees, records
    days_ = int((p.get("view") or "Within 90 days").split()[1])
    horizon = today() + timedelta(days=days_)
    dconds = [sa.cast(e.c.department_id, sa.Text) == p.get("department")] if p.get("department") else []
    lic = await rows(ctx, sa.select(e.c.name.label("employee"), e.c.code.label("emp_code"), e.c.category, dept.c.title.label("department"),
                                    sa.literal("Professional registration").label("credential"), e.c.data["license_no"].astext.label("number"),
                                    e.c.license_expiry.label("valid_until"))
                     .select_from(e.outerjoin(dept, dept.c.id == e.c.department_id))
                     .where(e.c.deleted_at.is_(None), e.c.status.in_(["Active", "On Notice"]), e.c.license_expiry.isnot(None),
                            e.c.license_expiry <= horizon, *dconds))
    vu = sa.cast(sa.func.nullif(r.c.data["valid_until"].astext, ""), sa.Date)
    cred = await rows(ctx, sa.select(e.c.name.label("employee"), e.c.code.label("emp_code"), e.c.category, dept.c.title.label("department"),
                                     r.c.data["credential_type"].astext.label("credential"), r.c.data["number"].astext.label("number"),
                                     vu.label("valid_until"))
                      .select_from(r.join(e, e.c.id == r.c.employee_id).outerjoin(dept, dept.c.id == e.c.department_id))
                      .where(*rec_live("employees", "credentials"), vu <= horizon, *dconds))
    out = lic + cred
    t = today()
    from ..core.util import parse_date

    for x in out:
        d = parse_date(x["valid_until"])
        x["days_left"] = (d - t).days if d else None
        x["status"] = "Expired" if d and d < t else "Expiring"
    out.sort(key=lambda x: x["days_left"] if x["days_left"] is not None else 9999)
    return Result(out, [{"label": "Expired", "value": sum(1 for x in out if x["status"] == "Expired"), "format": "number"},
                        {"label": f"Expiring ≤ {days_} days", "value": sum(1 for x in out if x["status"] == "Expiring"), "format": "number"}])


@report("HR-06", "Leave Register", HR,
        "Leave applications in the period — employee, type, dates, days, status and approval.",
        [Col("from_date", "From", "date"), Col("to_date", "To", "date"), Col("employee", "Employee"), Col("department", "Department"),
         Col("leave_type", "Leave type"), Col("days", "Days", "number", total=True), Col("reason", "Reason", default=False), Col("status", "Status", "status")],
        filters=[F.period, F.status(["Applied", "Approved", "Rejected", "Cancelled"]), F.department], access=("roster.leaves",), icon="Plane")
async def hr_leaves(ctx, p: Params) -> Result:
    r, e = records, employees
    conds = [*rec_live("roster", "leaves"), *text_between(r.c.data["from_date"].astext, p)]
    if p.get("status"):
        conds.append(r.c.status == p.get("status"))
    if p.get("department"):
        conds.append(sa.cast(e.c.department_id, sa.Text) == p.get("department"))
    stmt = (sa.select(r.c.data["from_date"].astext.label("from_date"), r.c.data["to_date"].astext.label("to_date"), e.c.name.label("employee"),
                      dept.c.title.label("department"), r.c.data["leave_type"].astext.label("leave_type"), jnum(r.c.data["days"].astext).label("days"),
                      r.c.data["reason"].astext.label("reason"), r.c.status)
            .select_from(r.join(e, e.c.id == r.c.employee_id).outerjoin(dept, dept.c.id == e.c.department_id))
            .where(*conds).order_by(r.c.data["from_date"].astext.desc()))
    return Result(await rows(ctx, stmt))


# ====================================================================== audit

def _actor():
    return sa.func.coalesce(users.c.name, "System")


@report("AUD-01", "Discount Audit by User", AUD,
        "Discounts given per billing user — bills discounted, total discount, average %, the largest single discount and how many "
        "crossed the approval limit.",
        [Col("user", "Billed by"), Col("bills", "Bills discounted", "number", total=True), Col("discount", "Total discount", "money", total=True),
         Col("avg_pct", "Avg discount %", "percent"), Col("max_discount", "Largest", "money"), Col("over_limit", "Needed approval", "number", total=True),
         Col("no_reason", "Without reason", "number", total=True)],
        filters=[F.period], access=("billing.invoices",), roles=AUDIT_ROLES + ("billing",), finance=True, icon="BadgePercent")
async def aud_discounts(ctx, p: Params) -> Result:
    inv = invoices
    reason = inv.c.data["discount_reason"].astext
    actor = _actor()
    stmt = (sa.select(actor.label("user"), sa.func.count().label("bills"), sa.func.sum(inv.c.discount).label("discount"),
                      sa.func.round(sa.cast(sa.func.avg(inv.c.discount / sa.func.nullif(inv.c.gross, 0) * 100), sa.Numeric), 1).label("avg_pct"),
                      sa.func.max(inv.c.discount).label("max_discount"),
                      sa.func.count().filter(inv.c.data["discount_approval"].astext.isnot(None)).label("over_limit"),
                      sa.func.count().filter(sa.or_(reason.is_(None), reason == "")).label("no_reason"))
            .select_from(inv.outerjoin(users, sa.cast(users.c.id, sa.Text) == inv.c.created_by))
            .where(inv.c.deleted_at.is_(None), inv.c.discount > 0, *ts_between(inv.c.billed_at, p)).group_by(actor)
            .order_by(sa.func.sum(inv.c.discount).desc()))
    return Result(await rows(ctx, stmt))


@report("AUD-02", "Refund Audit by User", AUD,
        "Refunds paid out per user — number, amount, the modes used and refunds paid in cash.",
        [Col("user", "Paid by"), Col("refunds", "Refunds", "number", total=True), Col("amount", "Amount", "money", total=True),
         Col("cash", "In cash", "money", total=True), Col("largest", "Largest", "money"), Col("last_at", "Last refund", "datetime")],
        filters=[F.period], access=("billing.payments",), roles=AUDIT_ROLES + ("billing",), finance=True, icon="Undo2")
async def aud_refunds(ctx, p: Params) -> Result:
    pay = payments
    actor = _actor()
    stmt = (sa.select(actor.label("user"), sa.func.count().label("refunds"), sa.func.sum(pay.c.amount).label("amount"),
                      sa.func.coalesce(sa.func.sum(pay.c.amount).filter(pay.c.mode == "CASH"), 0).label("cash"),
                      sa.func.max(pay.c.amount).label("largest"), sa.func.max(pay.c.paid_at).label("last_at"))
            .select_from(pay.outerjoin(users, sa.cast(users.c.id, sa.Text) == pay.c.created_by))
            .where(pay.c.deleted_at.is_(None), pay.c.kind == "REFUND", *ts_between(pay.c.paid_at, p)).group_by(actor)
            .order_by(sa.func.sum(pay.c.amount).desc()))
    return Result(await rows(ctx, stmt))


def _audit_log_report(actions: list[str] | None, *, like: str | None = None, extra_cols: bool = False):
    async def run(ctx, p: Params) -> Result:
        al = audit_log
        conds = [*ts_between(al.c.at, p)]
        if actions:
            conds.append(al.c.action.in_(actions))
        if like:
            conds.append(al.c.action.like(like))
        if p.q:
            conds.append(sa.or_(al.c.user_name.ilike(f"%{p.q}%"), al.c.note.ilike(f"%{p.q}%"), al.c.record_code.ilike(f"%{p.q}%")))
        if p.get("module"):
            conds.append(al.c.module == p.get("module"))
        stmt = (sa.select(al.c.at, al.c.user_name.label("user"), al.c.role, al.c.action, al.c.module, al.c.entity, al.c.record_code.label("record"),
                          al.c.note, al.c.ip).where(*conds).order_by(al.c.at.desc()).limit(5000))
        out = await rows(ctx, stmt)
        return Result(out, [{"label": "Events", "value": len(out), "format": "number"},
                            {"label": "Users", "value": len({x["user"] for x in out}), "format": "number"}])
    return run


AUDIT_COLS = [Col("at", "When", "datetime"), Col("user", "User"), Col("role", "Role"), Col("action", "Action", "code"), Col("module", "Module"),
              Col("entity", "Record type", default=False), Col("record", "Record", "code"), Col("note", "Reason / note"), Col("ip", "IP address", default=False)]

report("AUD-03", "Bill & Charge Cancellations", AUD,
       "Every bill and charge cancellation from the audit trail — who, when, which bill or charge and the reason given.",
       AUDIT_COLS, filters=[F.period, F.search("User / bill / reason…")], roles=AUDIT_ROLES + ("billing",), finance=True, icon="FileX",
       handles_q=True)(_audit_log_report(["bill.cancel", "charge.cancel"]))
report("AUD-04", "Break-the-glass Access Log", AUD,
       "Restricted records opened with a break-the-glass reason — who, role, which record type and the clinical reason recorded.",
       AUDIT_COLS, filters=[F.period, F.search("User / reason…")], roles=AUDIT_ROLES, popular=True, icon="ShieldAlert",
       handles_q=True)(_audit_log_report(["break_glass"]))
report("AUD-05", "Login Failures", AUD,
       "Failed sign-in attempts from the audit trail — the user name tried, when and from which IP — to spot password guessing.",
       AUDIT_COLS, filters=[F.period, F.search("User name / IP…")], roles=AUDIT_ROLES, icon="KeyRound", default_period="last_7",
       handles_q=True)(_audit_log_report(["auth.login_failed"]))
report("AUD-06", "Record Deletions", AUD,
       "Records deleted (soft-deleted) by users, with the reason — every deletion is reversible by an administrator.",
       AUDIT_COLS, filters=[F.period, F.search("User / record…")], roles=AUDIT_ROLES, icon="Trash2", handles_q=True)(_audit_log_report(["delete"]))
report("AUD-07", "Sensitive Record Access", AUD,
       "Chart views, file downloads and prints of patient records — the access trail for DPDP / NABH information-security audits.",
       AUDIT_COLS, filters=[F.period, F.search("User / record…")], roles=AUDIT_ROLES, icon="Eye", default_period="last_7",
       handles_q=True)(_audit_log_report(["emr.chart.view", "file.view", "print"]))


@report("AUD-08", "User Activity Summary", AUD,
        "Per user: records created, edited, status changes, deletions, prints and sign-ins in the period, with the last activity.",
        [Col("user", "User"), Col("role", "Role"), Col("creates", "Created", "number", total=True), Col("updates", "Edited", "number", total=True),
         Col("status", "Status changes", "number", total=True), Col("deletes", "Deleted", "number", total=True), Col("prints", "Prints", "number", total=True),
         Col("logins", "Sign-ins", "number", total=True), Col("failures", "Failed sign-ins", "number", total=True),
         Col("total", "All events", "number", total=True), Col("last_at", "Last activity", "datetime")],
        filters=[F.period, F.search("User…")], roles=AUDIT_ROLES, icon="Activity", default_period="last_7", handles_q=True)
async def aud_activity(ctx, p: Params) -> Result:
    al = audit_log
    a = al.c.action
    conds = [*ts_between(al.c.at, p)]
    if p.q:
        conds.append(al.c.user_name.ilike(f"%{p.q}%"))
    name = sa.func.coalesce(al.c.user_name, "Unknown")
    stmt = (sa.select(name.label("user"), sa.func.max(al.c.role).label("role"), sa.func.count().filter(a == "create").label("creates"),
                      sa.func.count().filter(a == "update").label("updates"), sa.func.count().filter(a == "status").label("status"),
                      sa.func.count().filter(a == "delete").label("deletes"), sa.func.count().filter(a == "print").label("prints"),
                      sa.func.count().filter(a == "auth.login").label("logins"), sa.func.count().filter(a == "auth.login_failed").label("failures"),
                      sa.func.count().label("total"), sa.func.max(al.c.at).label("last_at"))
            .where(*conds).group_by(name).order_by(sa.func.count().desc()))
    return Result(await rows(ctx, stmt))
