#!/usr/bin/env bash
# Local PostgreSQL + Redis for development WITHOUT Docker.
# Uses the Postgres binaries bundled in the `pgserver` wheel and a Redis built from source.
# With Docker available, prefer:  docker compose up -d postgres redis
#
#   scripts/devinfra.sh setup   # one-time: install binaries
#   scripts/devinfra.sh start   # start postgres :5432 and redis :6379
#   scripts/devinfra.sh stop
#   scripts/devinfra.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INFRA="$ROOT/.devinfra"
UV="${UV:-$(command -v uv || echo "$HOME/Library/Python/3.9/bin/uv")}"
PGBIN="$INFRA/.venv/lib/python3.12/site-packages/pgserver/pginstall/bin"
PGDATA="$INFRA/pgdata"
REDIS_DIR="$INFRA/redis-src/redis-stable"
REDIS_DATA="$INFRA/redis-data"
PGPORT="${PGPORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
DB_NAME="${DB_NAME:-vlack_hrms}"
DB_USER="${DB_USER:-vlack}"
DB_PASS="${DB_PASS:-vlack}"

setup() {
  mkdir -p "$INFRA"
  if [ ! -x "$PGBIN/postgres" ]; then
    "$UV" venv -q --python 3.12 "$INFRA/.venv"
    "$UV" pip install -q --python "$INFRA/.venv/bin/python" pgserver
  fi
  if [ ! -x "$REDIS_DIR/src/redis-server" ]; then
    mkdir -p "$INFRA/redis-src"
    curl -fsSL https://download.redis.io/redis-stable.tar.gz -o "$INFRA/redis-src/redis-stable.tar.gz"
    tar -xzf "$INFRA/redis-src/redis-stable.tar.gz" -C "$INFRA/redis-src"
    (cd "$REDIS_DIR" && make -j8 BUILD_TLS=no MALLOC=libc >/dev/null 2>&1 || true)
    [ -x "$REDIS_DIR/src/redis-server" ] || { echo "redis build failed"; exit 1; }
  fi
  echo "dev infra binaries ready"
}

start() {
  [ -x "$PGBIN/postgres" ] || setup
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null
  fi
  if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$INFRA/postgres.log" \
      -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" -w start >/dev/null
  fi
  "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 ||
    "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -c "CREATE ROLE $DB_USER LOGIN SUPERUSER PASSWORD '$DB_PASS'" >/dev/null
  "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 ||
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U postgres -O "$DB_USER" "$DB_NAME"
  "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}_test'" | grep -q 1 ||
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U postgres -O "$DB_USER" "${DB_NAME}_test"

  mkdir -p "$REDIS_DATA"
  if ! "$REDIS_DIR/src/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    "$REDIS_DIR/src/redis-server" --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$REDIS_DATA" \
      --daemonize yes --logfile "$INFRA/redis.log" --save 60 1000
  fi
  status
}

stop() {
  "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  "$REDIS_DIR/src/redis-cli" -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  echo "stopped"
}

status() {
  if "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then
    echo "postgres: up  postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PGPORT/$DB_NAME"
  else
    echo "postgres: down"
  fi
  if "$REDIS_DIR/src/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    echo "redis:    up  redis://127.0.0.1:$REDIS_PORT/0"
  else
    echo "redis:    down"
  fi
}

case "${1:-start}" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  psql) shift; exec "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" "$DB_NAME" "$@" ;;
  *) echo "usage: $0 setup|start|stop|status|psql"; exit 1 ;;
esac
