"""platform: layered configuration, user sessions, internal messages

Revision ID: 0003_platform
Revises: 0002_search_indexes
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_platform"
down_revision: str | None = "0002_search_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID = sa.Uuid(as_uuid=False)
TS = sa.DateTime(timezone=True)
JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "config_entries",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("namespace", sa.Text, nullable=False),
        sa.Column("scope", sa.Text, nullable=False),
        sa.Column("scope_id", sa.Text, nullable=False, server_default=""),
        sa.Column("value", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("updated_by", sa.Text),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id", name="pk_config_entries"),
        sa.UniqueConstraint("kind", "namespace", "scope", "scope_id", name="uq_config_entries_key"),
    )
    op.create_index("ix_config_entries_scope", "config_entries", ["kind", "scope", "scope_id"])

    op.create_table(
        "user_sessions",
        sa.Column("id", sa.Text, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("device", sa.Text),
        sa.Column("browser", sa.Text),
        sa.Column("os", sa.Text),
        sa.Column("user_agent", sa.Text),
        sa.Column("ip", sa.Text),
        sa.Column("branch_id", sa.Text),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.Column("last_active_at", TS),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked_at", TS),
        sa.Column("revoked_by", sa.Text),
        sa.Column("revoke_reason", sa.Text),
        sa.PrimaryKeyConstraint("id", name="pk_user_sessions"),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id", sa.text("created_at DESC")])

    op.create_table(
        "messages",
        sa.Column("id", UUID, nullable=False),
        sa.Column("code", sa.Text),
        sa.Column("thread_id", UUID),
        sa.Column("sender_id", UUID),
        sa.Column("sender_name", sa.Text),
        sa.Column("subject", sa.Text),
        sa.Column("body", sa.Text),
        sa.Column("priority", sa.Text, nullable=False, server_default="NORMAL"),
        sa.Column("type", sa.Text, nullable=False, server_default="MESSAGE"),
        sa.Column("patient_id", UUID),
        sa.Column("encounter_id", UUID),
        sa.Column("is_task", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("task_status", sa.Text),
        sa.Column("task_closed_at", TS),
        sa.Column("task_closed_by", sa.Text),
        sa.Column("is_draft", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("audience", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("branch_id", sa.Text),
        sa.Column("search", sa.Text),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.Column("sent_at", TS),
        sa.Column("updated_at", TS),
        sa.Column("deleted_at", TS),
        sa.PrimaryKeyConstraint("id", name="pk_messages"),
    )
    op.create_index("ix_messages_thread_id", "messages", ["thread_id"])
    op.create_index("ix_messages_sender_id", "messages", ["sender_id", "is_draft"])
    op.create_index("ix_messages_patient_id", "messages", ["patient_id"])
    op.create_index("ix_messages_encounter_id", "messages", ["encounter_id"])

    op.create_table(
        "message_recipients",
        sa.Column("message_id", UUID, nullable=False),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("via", sa.Text),
        sa.Column("mentioned", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("read_at", TS),
        sa.Column("pinned", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("archived", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("message_id", "user_id", name="pk_message_recipients"),
    )
    op.create_index("ix_message_recipients_user", "message_recipients", ["user_id", "archived"])


def downgrade() -> None:
    op.drop_table("message_recipients")
    op.drop_table("messages")
    op.drop_table("user_sessions")
    op.drop_table("config_entries")
