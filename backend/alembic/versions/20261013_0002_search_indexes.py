"""trigram search indexes (when pg_trgm is available)

Revision ID: 0002_search_indexes
Revises: 80430c3d9788
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0002_search_indexes"
down_revision: str | None = "80430c3d9788"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ["records", "patients", "employees", "services", "encounters", "orders", "invoices"]


def upgrade() -> None:
    # pg_trgm ships with standard PostgreSQL images; minimal builds may lack contrib.
    op.execute("""
    DO $$
    BEGIN
      BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_trgm unavailable; search falls back to sequential ILIKE';
      END;
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        %s
      END IF;
    END $$;
    """ % "\n        ".join(
        f"CREATE INDEX IF NOT EXISTS ix_{t}_search_trgm ON {t} USING gin (search gin_trgm_ops);" for t in TABLES
    ))


def downgrade() -> None:
    for t in TABLES:
        op.execute(f"DROP INDEX IF EXISTS ix_{t}_search_trgm")
