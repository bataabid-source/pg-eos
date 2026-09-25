#!/usr/bin/env bash
# PG-EOS · lane-db.sh — P4a: one Postgres database per lane worktree (GM 2026-09-26).
#
# Three lane worktrees (../pg-eos-lane-1/2/3) used to share the single database `pgeos` in the
# local Docker container, so their test fixtures polluted each other. This script gives a lane
# its own database — `pgeos_lane<id>` — in the SAME running container.
#
#   bash scripts/lane-db.sh <1|2|3>
#
# What it does, idempotently (safe to re-run):
#   1. Creates database `pgeos_lane<id>` in the running container if it does not already exist.
#      CREATE DATABASE only — this script never drops a database (CLAUDE.md · AGENT CONSTRAINTS,
#      D-183 db-guard.sh).
#   2. Only on that first creation, applies the full schema via the repo's existing
#      database/schema/apply.sh (same 01 → 13 → 13B → 019 → database/migrations/*.sql → guards.sql
#      sequence as any other database — no reimplementation here), which also seeds every
#      reference table the schema files carry. apply.sh itself is not safe to re-run on an
#      already-populated database without --recreate (which this script will not do — that would
#      drop the lane's data); a database that already exists is left exactly as it is. To pick up
#      schema changes on an existing lane database, run apply.sh directly, same as on `pgeos`.
#   3. Writes infra/docker/.env (git-ignored) with PGDATABASE=pgeos_lane<id>, preserving every
#      other key already in that file. This step always runs, even when step 2 was skipped.
#      NOTE: nothing sources infra/docker/.env automatically — packages/db, the vitest configs,
#      apply.sh and guards-run.sh all read PGDATABASE from the process environment. Writing this
#      file alone does not isolate a lane's tests; see this script's final message for the
#      durable fix (a worktree-scoped .claude/settings.local.json env entry, or a shell export).
#
# Run from the lane's own worktree (../pg-eos-lane-<id>) — the lanes run this themselves; the
# Master does not write to a lane worktree (CLAUDE.md · PARALLEL LANES, D-180).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ID="${1:-}"
case "$ID" in
  1|2|3) ;;
  *)
    echo "usage: bash scripts/lane-db.sh <1|2|3>" >&2
    exit 2
    ;;
esac

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
LANE_DB="pgeos_lane${ID}"

for bin in psql createdb; do
  command -v "$bin" >/dev/null 2>&1 || { echo "lane-db: $bin not found on PATH." >&2; exit 2; }
done

echo "lane-db: target database '${LANE_DB}' on ${PGHOST}:${PGPORT} (user ${PGUSER})"

EXISTS="$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -Atqc \
  "select 1 from pg_database where datname = '${LANE_DB}'")"

if [[ "$EXISTS" == "1" ]]; then
  echo "lane-db: '${LANE_DB}' already exists — leaving it and its schema in place (never dropped, never re-applied)."
  echo "lane-db: to pick up schema changes, run: PGDATABASE=${LANE_DB} bash database/schema/apply.sh"
else
  echo "lane-db: creating '${LANE_DB}' …"
  # SCR-TRGM-01 (database/schema/apply.sh): same locale every PG-EOS database requires — ctype
  # C.UTF-8 so pg_trgm sees Arabic letters, collation stays C.
  createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -T template0 -E UTF8 --lc-collate=C --lc-ctype=C.UTF-8 "$LANE_DB"

  echo "lane-db: applying schema to '${LANE_DB}' via database/schema/apply.sh …"
  PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER="$PGUSER" PGDATABASE="$LANE_DB" bash "$DIR/database/schema/apply.sh"
fi

# --- infra/docker/.env: set PGDATABASE=<lane db>, preserving every other key already there -----
ENV_FILE="$DIR/infra/docker/.env"
mkdir -p "$(dirname "$ENV_FILE")"
TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"' EXIT

if [[ -f "$ENV_FILE" ]]; then
  grep -v '^PGDATABASE=' "$ENV_FILE" > "$TMP_ENV" || true
else
  : > "$TMP_ENV"
fi
printf 'PGDATABASE=%s\n' "$LANE_DB" >> "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"

echo "lane-db: wrote PGDATABASE=${LANE_DB} to infra/docker/.env"
echo "lane-db: OK — nothing sources infra/docker/.env automatically, so this alone is not enough. Set PGDATABASE=${LANE_DB} where your commands actually run it: add \"env\": {\"PGDATABASE\": \"${LANE_DB}\"} to this worktree's .claude/settings.local.json (Claude Code applies it to every Bash command — gitignored, never committed), or export PGDATABASE=${LANE_DB} in your shell."
