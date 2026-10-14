"""Physical schema (SQLAlchemy Core).

Every entity table shares BASE columns so the generic record service can read and write
any of them. Core engine tables add typed columns that need indexing, joins or arithmetic
(money, dates, foreign keys). Everything else a module defines lives in the `data` JSONB.
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

metadata = sa.MetaData(
    naming_convention={
        "ix": "ix_%(table_name)s_%(column_0_N_name)s",
        "uq": "uq_%(table_name)s_%(column_0_N_name)s",
        "pk": "pk_%(table_name)s",
    }
)

UUID = sa.Uuid(as_uuid=False)
MONEY = sa.Numeric(14, 2)
TS = sa.DateTime(timezone=True)

BASE_COLUMNS = (
    "id", "code", "status", "title", "patient_id", "encounter_id", "employee_id",
    "data", "search", "branch_id", "created_by", "created_at", "updated_by", "updated_at", "deleted_at",
)


def _base() -> list[sa.Column]:
    return [
        sa.Column("id", UUID, primary_key=True),
        sa.Column("code", sa.Text),
        sa.Column("status", sa.Text),
        sa.Column("title", sa.Text),
        sa.Column("patient_id", UUID),
        sa.Column("encounter_id", UUID),
        sa.Column("employee_id", UUID),
        sa.Column("data", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("search", sa.Text),
        sa.Column("branch_id", sa.Text),
        sa.Column("created_by", sa.Text),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by", sa.Text),
        sa.Column("updated_at", TS),
        sa.Column("deleted_at", TS),
    ]


def _table(name: str, *extra: sa.Column, indexes: tuple[tuple[str, ...], ...] = ()) -> sa.Table:
    t = sa.Table(name, metadata, *_base(), *extra)
    sa.Index(f"ix_{name}_created_at", t.c.created_at.desc())
    sa.Index(f"ix_{name}_code", t.c.code)
    for cols in indexes:
        sa.Index(f"ix_{name}_{'_'.join(cols)}", *[t.c[c] for c in cols])
    return t


# Generic store for every module entity that is not engine-backed.
records = _table(
    "records",
    sa.Column("module", sa.Text, nullable=False),
    sa.Column("entity", sa.Text, nullable=False),
    indexes=(("module", "entity", "status"), ("patient_id",), ("employee_id",), ("encounter_id",)),
)
sa.Index("ix_records_data", records.c.data, postgresql_using="gin", postgresql_ops={"data": "jsonb_path_ops"})

patients = _table(
    "patients",
    sa.Column("first_name", sa.Text),
    sa.Column("last_name", sa.Text),
    sa.Column("gender", sa.Text),
    sa.Column("dob", sa.Date),
    sa.Column("phone", sa.Text),
    sa.Column("email", sa.Text),
    sa.Column("abha_id", sa.Text),
    sa.Column("id_number", sa.Text),  # masked ID (Aadhaar etc.) — last 4 digits only
    sa.Column("blood_group", sa.Text),
    sa.Column("family_id", UUID),
    sa.Column("merged_into", UUID),
    indexes=(("phone",), ("abha_id",), ("family_id",), ("first_name", "last_name")),
)

encounters = _table(
    "encounters",
    sa.Column("type", sa.Text),  # OPD | IPD | ER | DAYCARE | TELE
    sa.Column("department_id", UUID),
    sa.Column("doctor_id", UUID),
    sa.Column("bed_id", UUID),
    sa.Column("started_at", TS),
    sa.Column("ended_at", TS),
    indexes=(("patient_id",), ("type", "status"), ("doctor_id",), ("bed_id",)),
)

beds = _table(
    "beds",
    sa.Column("ward_id", UUID),
    sa.Column("bed_no", sa.Text),
    sa.Column("category", sa.Text),
    sa.Column("rate", MONEY),
    indexes=(("ward_id",), ("status",)),
)

appointments = _table(
    "appointments",
    sa.Column("doctor_id", UUID),
    sa.Column("department_id", UUID),
    sa.Column("appt_date", sa.Date),
    sa.Column("slot", sa.Text),
    sa.Column("token_no", sa.Integer),
    sa.Column("type", sa.Text),
    indexes=(("appt_date", "doctor_id"), ("patient_id",), ("status",)),
)

queue_tokens = _table(
    "queue_tokens",
    sa.Column("queue", sa.Text),
    sa.Column("token_no", sa.Integer),
    sa.Column("token_date", sa.Date),
    sa.Column("called_at", TS),
    sa.Column("served_at", TS),
    indexes=(("token_date", "queue"), ("patient_id",)),
)

services = _table(
    "services",
    sa.Column("category", sa.Text),
    sa.Column("department_id", UUID),
    sa.Column("rate", MONEY),
    sa.Column("tat_minutes", sa.Integer),
    indexes=(("category",),),
)

orders = _table(
    "orders",
    sa.Column("category", sa.Text),  # LAB | RAD | PHARM | PROC | DIET | NURSING
    sa.Column("service_id", UUID),
    sa.Column("priority", sa.Text),
    sa.Column("ordered_by", sa.Text),
    sa.Column("ordered_at", TS),
    sa.Column("collected_at", TS),
    sa.Column("resulted_at", TS),
    sa.Column("verified_at", TS),
    sa.Column("critical", sa.Boolean, server_default=sa.false()),
    sa.Column("acknowledged_at", TS),
    indexes=(("patient_id",), ("category", "status"), ("encounter_id",)),
)

charges = _table(
    "charges",
    sa.Column("service_id", UUID),
    sa.Column("qty", sa.Numeric(12, 3)),
    sa.Column("rate", MONEY),
    sa.Column("amount", MONEY),
    sa.Column("discount", MONEY),
    sa.Column("invoice_id", UUID),
    sa.Column("source", sa.Text),
    sa.Column("source_id", UUID),
    sa.Column("charged_at", TS),
    indexes=(("patient_id",), ("encounter_id",), ("invoice_id",), ("source_id",)),
)

invoices = _table(
    "invoices",
    sa.Column("type", sa.Text),  # OP | IP | PHARMACY | PACKAGE
    sa.Column("gross", MONEY),
    sa.Column("discount", MONEY),
    sa.Column("tax", MONEY),
    sa.Column("net", MONEY),
    sa.Column("paid", MONEY),
    sa.Column("balance", MONEY),
    sa.Column("payer", sa.Text),
    sa.Column("billed_at", TS),
    indexes=(("patient_id",), ("status",), ("billed_at",)),
)

payments = _table(
    "payments",
    sa.Column("invoice_id", UUID),
    sa.Column("mode", sa.Text),  # CASH | CARD | UPI | WALLET | BANK | INSURANCE
    sa.Column("kind", sa.Text),  # PAYMENT | DEPOSIT | REFUND | ADJUSTMENT
    sa.Column("amount", MONEY),
    sa.Column("paid_at", TS),
    indexes=(("invoice_id",), ("patient_id",), ("paid_at",)),
)

employees = _table(
    "employees",
    sa.Column("name", sa.Text),
    sa.Column("category", sa.Text),  # Doctor | Nurse | Technician | Admin | Support | ...
    sa.Column("department_id", UUID),
    sa.Column("designation", sa.Text),
    sa.Column("doj", sa.Date),
    sa.Column("phone", sa.Text),
    sa.Column("email", sa.Text),
    sa.Column("license_expiry", sa.Date),
    sa.Column("user_id", UUID),
    indexes=(("category",), ("department_id",)),
)

stock = _table(
    "stock",
    sa.Column("item_id", UUID),
    sa.Column("store", sa.Text),
    sa.Column("batch", sa.Text),
    sa.Column("expiry", sa.Date),
    sa.Column("qty", sa.Numeric(12, 3)),
    sa.Column("rate", MONEY),
    sa.Column("mrp", MONEY),
    indexes=(("item_id", "store"), ("expiry",)),
)

stock_moves = _table(
    "stock_moves",
    sa.Column("item_id", UUID),
    sa.Column("store", sa.Text),
    sa.Column("batch", sa.Text),
    sa.Column("qty", sa.Numeric(12, 3)),
    sa.Column("kind", sa.Text),  # GRN | ISSUE | DISPENSE | RETURN | TRANSFER_IN | TRANSFER_OUT | ADJUST
    sa.Column("ref", sa.Text),
    indexes=(("item_id",),),
)

approvals = _table(
    "approvals",
    sa.Column("flow", sa.Text),
    sa.Column("subject_module", sa.Text),
    sa.Column("subject_entity", sa.Text),
    sa.Column("subject_id", sa.Text),
    sa.Column("step", sa.Integer),
    sa.Column("amount", MONEY),
    sa.Column("requested_by", sa.Text),
    sa.Column("decided_by", sa.Text),
    sa.Column("decided_at", TS),
    indexes=(("status",), ("subject_id",)),
)

notifications = _table(
    "notifications",
    sa.Column("channel", sa.Text),  # SMS | WHATSAPP | EMAIL | PUSH
    sa.Column("recipient", sa.Text),
    sa.Column("template", sa.Text),
    sa.Column("sent_at", TS),
    indexes=(("status",),),
)

files = _table(
    "files",
    sa.Column("name", sa.Text),
    sa.Column("mime", sa.Text),
    sa.Column("size", sa.Integer),
    sa.Column("path", sa.Text),
    indexes=(("patient_id",),),
)

ENTITY_TABLES: dict[str, sa.Table] = {
    t.name: t
    for t in (records, patients, encounters, beds, appointments, queue_tokens, services, orders, charges,
              invoices, payments, employees, stock, stock_moves, approvals, notifications, files)
}

# ---- system tables ----------------------------------------------------------------------

sequences = sa.Table(
    "sequences", metadata,
    sa.Column("key", sa.Text, primary_key=True),
    sa.Column("value", sa.BigInteger, nullable=False),
)

users = sa.Table(
    "users", metadata,
    sa.Column("id", UUID, primary_key=True),
    sa.Column("username", sa.Text, nullable=False, unique=True),
    sa.Column("password_hash", sa.Text, nullable=False),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("role", sa.Text, nullable=False),
    sa.Column("employee_id", UUID),
    sa.Column("email", sa.Text),
    sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
    sa.Column("data", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    sa.Column("last_login_at", TS),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    sa.Column("updated_at", TS),
)

audit_log = sa.Table(
    "audit_log", metadata,
    sa.Column("id", UUID, primary_key=True),
    sa.Column("at", TS, nullable=False, server_default=sa.func.now()),
    sa.Column("user_id", sa.Text),
    sa.Column("user_name", sa.Text),
    sa.Column("role", sa.Text),
    sa.Column("action", sa.Text, nullable=False),
    sa.Column("module", sa.Text),
    sa.Column("entity", sa.Text),
    sa.Column("record_id", sa.Text),
    sa.Column("record_code", sa.Text),
    sa.Column("patient_id", sa.Text),
    sa.Column("before", JSONB),
    sa.Column("after", JSONB),
    sa.Column("note", sa.Text),
    sa.Column("ip", sa.Text),
)
sa.Index("ix_audit_log_at", audit_log.c.at.desc())
sa.Index("ix_audit_log_record_id", audit_log.c.record_id)
sa.Index("ix_audit_log_patient_id", audit_log.c.patient_id)
sa.Index("ix_audit_log_module_action", audit_log.c.module, audit_log.c.action)

# ---- platform tables (phase 2: configuration, sessions, internal messages) ------------------

# Layered configuration: field configuration per form/screen and JSON settings per namespace.
# scope: org | branch | department | doctor | user — the most specific layer wins.
config_entries = sa.Table(
    "config_entries", metadata,
    sa.Column("id", UUID, primary_key=True),
    sa.Column("kind", sa.Text, nullable=False),  # fieldconfig | settings
    sa.Column("namespace", sa.Text, nullable=False),  # form / screen key, or settings namespace
    sa.Column("scope", sa.Text, nullable=False),
    sa.Column("scope_id", sa.Text, nullable=False, server_default=""),
    sa.Column("value", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    sa.Column("updated_by", sa.Text),
    sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
    sa.UniqueConstraint("kind", "namespace", "scope", "scope_id", name="uq_config_entries_key"),
)
sa.Index("ix_config_entries_scope", config_entries.c.kind, config_entries.c.scope, config_entries.c.scope_id)

# Signed-in devices. id = the JWT `jti`; revoking a row also revokes the token in Redis.
user_sessions = sa.Table(
    "user_sessions", metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("user_id", UUID, nullable=False),
    sa.Column("device", sa.Text),
    sa.Column("browser", sa.Text),
    sa.Column("os", sa.Text),
    sa.Column("user_agent", sa.Text),
    sa.Column("ip", sa.Text),
    sa.Column("branch_id", sa.Text),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    sa.Column("last_active_at", TS),
    sa.Column("expires_at", TS, nullable=False),
    sa.Column("revoked_at", TS),
    sa.Column("revoked_by", sa.Text),
    sa.Column("revoke_reason", sa.Text),
)
sa.Index("ix_user_sessions_user_id", user_sessions.c.user_id, user_sessions.c.created_at.desc())

# Internal (staff-only) messages. One row per message; per-user state lives in message_recipients
# (the sender has a row too, via="sender", so pin/archive work the same for both sides).
messages = sa.Table(
    "messages", metadata,
    sa.Column("id", UUID, primary_key=True),
    sa.Column("code", sa.Text),
    sa.Column("thread_id", UUID),
    sa.Column("sender_id", UUID),
    sa.Column("sender_name", sa.Text),
    sa.Column("subject", sa.Text),
    sa.Column("body", sa.Text),
    sa.Column("priority", sa.Text, nullable=False, server_default="NORMAL"),  # LOW | NORMAL | HIGH | URGENT
    sa.Column("type", sa.Text, nullable=False, server_default="MESSAGE"),  # MESSAGE | ALERT | NOTICE
    sa.Column("patient_id", UUID),
    sa.Column("encounter_id", UUID),
    sa.Column("is_task", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("task_status", sa.Text),  # Open | Closed
    sa.Column("task_closed_at", TS),
    sa.Column("task_closed_by", sa.Text),
    sa.Column("is_draft", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("audience", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    sa.Column("branch_id", sa.Text),
    sa.Column("search", sa.Text),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    sa.Column("sent_at", TS),
    sa.Column("updated_at", TS),
    sa.Column("deleted_at", TS),
)
sa.Index("ix_messages_thread_id", messages.c.thread_id)
sa.Index("ix_messages_sender_id", messages.c.sender_id, messages.c.is_draft)
sa.Index("ix_messages_patient_id", messages.c.patient_id)
sa.Index("ix_messages_encounter_id", messages.c.encounter_id)

message_recipients = sa.Table(
    "message_recipients", metadata,
    sa.Column("message_id", UUID, primary_key=True),
    sa.Column("user_id", UUID, primary_key=True),
    sa.Column("via", sa.Text),  # sender | person | department:<id> | role:<role>
    sa.Column("mentioned", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("read_at", TS),
    sa.Column("pinned", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("archived", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
)
sa.Index("ix_message_recipients_user", message_recipients.c.user_id, message_recipients.c.archived)
