#!/usr/bin/env bash
# Logical backup of the Vlack HRMS database (complements WAL/PITR — see docs/OPERATIONS.md).
#   DATABASE_URL=postgresql://user:pass@host:5432/vlack_hrms scripts/backup.sh /var/backups/vlack
# Keeps 14 daily dumps. Encrypt / ship the output off-site with your KMS tooling.
set -euo pipefail

DEST="${1:-./backups}"
URL="${DATABASE_URL:-postgresql://vlack:vlack@127.0.0.1:5432/vlack_hrms}"
URL="${URL/+asyncpg/}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
PG_DUMP="${PG_DUMP:-$(command -v pg_dump || echo "$(dirname "$0")/../.devinfra/.venv/lib/python3.12/site-packages/pgserver/pginstall/bin/pg_dump")}"

"$PG_DUMP" --format=custom --compress=9 --no-owner --file "$DEST/vlack_hrms-$STAMP.dump" "$URL"
echo "backup written: $DEST/vlack_hrms-$STAMP.dump"
find "$DEST" -name 'vlack_hrms-*.dump' -mtime +14 -delete
