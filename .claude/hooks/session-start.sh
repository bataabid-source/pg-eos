#!/usr/bin/env bash
# PG-EOS · SessionStart hook — boots a local PostgreSQL 16 cluster inside a Claude Code on the web
# container (no Docker daemon there), applies the schema to `pgeos` once, and installs workspace
# dependencies, so gates ②③⑤, `scripts/lane-db.sh` and `scripts/guards-run.sh` work in every
# remote session exactly as they do against infra/docker/docker-compose.yml locally.
#
# Idempotent: re-running on a warm container starts nothing twice and never drops a database
# (CLAUDE.md · AGENT CONSTRAINTS, D-183). Local machines are untouched — it exits at once unless
# CLAUDE_CODE_REMOTE=true.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PG_BIN="/usr/lib/postgresql/16/bin"
PGDATA="/var/lib/postgresql/16/pgeos"
PG_LOG="/var/log/postgresql/pgeos-session.log"
SOCK_DIR="/var/run/postgresql"
export PGHOST="localhost"
export PGPORT="5432"
export PGUSER="postgres"

as_postgres() { runuser -u postgres -- "$@"; }

if [ ! -x "$PG_BIN/postgres" ]; then
  echo "session-start: PostgreSQL 16 server binaries missing at $PG_BIN — install postgresql-16 in the environment image." >&2
  exit 1
fi

mkdir -p "$SOCK_DIR" "$(dirname "$PGDATA")" "$(dirname "$PG_LOG")"
chown postgres:postgres "$SOCK_DIR" "$(dirname "$PGDATA")" "$(dirname "$PG_LOG")"

# 1. Cluster — same locale as infra/docker/docker-compose.yml (SCR-TRGM-01): collate C, ctype C.UTF-8.
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "session-start: initialising cluster at $PGDATA …"
  as_postgres "$PG_BIN/initdb" -D "$PGDATA" --encoding=UTF8 --locale=C --lc-ctype=C.UTF-8 \
    --auth-local=trust --auth-host=trust >/dev/null
  cat >> "$PGDATA/postgresql.conf" <<EOF
# PG-EOS session container — loopback only, matches docker-compose.yml settings.
listen_addresses = '127.0.0.1'
port = ${PGPORT}
unix_socket_directories = '${SOCK_DIR}'
max_connections = 200
shared_buffers = 256MB
timezone = 'Asia/Kuwait'
EOF
fi

# 2. Server — start only when not already answering.
if ! pg_isready -h "$PGHOST" -p "$PGPORT" -q; then
  echo "session-start: starting PostgreSQL …"
  as_postgres "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PG_LOG" -w -t 60 start >/dev/null
fi
for _ in $(seq 1 30); do
  pg_isready -h "$PGHOST" -p "$PGPORT" -q && break
  sleep 1
done
pg_isready -h "$PGHOST" -p "$PGPORT" -q || { echo "session-start: PostgreSQL did not become ready — see $PG_LOG" >&2; exit 1; }

# 3. `pgeos` — created and schema-applied once (01 → 13 → 13B → 019 → migrations → guards via
#    database/schema/apply.sh); an existing database is left exactly as it is.
if [ "$(psql -d postgres -Atqc "select 1 from pg_database where datname = 'pgeos'")" != "1" ]; then
  echo "session-start: creating pgeos and applying the schema …"
  createdb -T template0 -E UTF8 --lc-collate=C --lc-ctype=C.UTF-8 pgeos
  PGDATABASE=pgeos bash "$ROOT/database/schema/apply.sh" --no-guards >/dev/null
fi

# 4. Dependencies — pnpm's store is cached with the container, so this is a no-op on a warm start.
(cd "$ROOT" && pnpm install --frozen-lockfile --prefer-offline >/dev/null)

# 5. Session environment — same PG* convention as packages/db and every vitest config; PG_APP_USER
#    mirrors .github/workflows/ci.yml so tests run under RLS as `pgeos_app`, not as a superuser.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PGHOST=${PGHOST}"
    echo "export PGPORT=${PGPORT}"
    echo "export PGUSER=${PGUSER}"
    echo "export PGDATABASE=pgeos"
    echo "export PG_APP_USER=pgeos_app"
  } >> "$CLAUDE_ENV_FILE"
fi

echo "session-start: PostgreSQL ready on ${PGHOST}:${PGPORT} (pgeos applied; lanes: bash scripts/lane-db.sh <id>)."
