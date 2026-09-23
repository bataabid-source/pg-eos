#!/usr/bin/env bash
# PG-EOS · backup.sh — WBS 0.8 (D-130 pilot acceptance, local Docker target only).
#
#   scripts/backup.sh
#   PGDATABASE=pgeos_test scripts/backup.sh
#
# Adapted from docs/package/42-Oracle-Cloud-Deployment.md §6.2 (OCI reference) for the pilot:
# no OCI Object Storage upload, no lifecycle tiering (that is WBS 0.5, deferred). Runs against the
# local Docker Postgres container's published port (127.0.0.1:5432, trust auth), the same PG* env
# var convention as database/schema/apply.sh and scripts/guards-run.sh — never via
# `docker compose exec`.
#
# Output: a new pg_dump custom-format file under data/backups/, named db-<timestamp>.dump
# (timestamp: %Y%m%d-%H%M%S, matching doc 42 §6.2's `db-$TS.dump`).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-pgeos}"

# This tooling is built for the local Docker target only (trust auth). Refuse to run against a
# stray PGHOST pointing at some other host, unless the caller explicitly opts in.
case "$PGHOST" in
  localhost|127.0.0.1) ;;
  *)
    if [[ "${PG_ALLOW_REMOTE_RESTORE:-}" != "1" ]]; then
      echo "backup.sh: refusing to run against PGHOST=${PGHOST} — this is local-Docker-only tooling." >&2
      echo "backup.sh: set PG_ALLOW_REMOTE_RESTORE=1 to override deliberately." >&2
      exit 2
    fi
    ;;
esac

command -v pg_dump >/dev/null 2>&1 || { echo "backup.sh: pg_dump not found on PATH." >&2; exit 2; }

BACKUPS_DIR="$DIR/data/backups"
mkdir -p "$BACKUPS_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUPS_DIR/db-$TS.dump"

if [[ -e "$DUMP_FILE" ]]; then
  echo "backup.sh: refusing to overwrite existing dump file: $DUMP_FILE" >&2
  echo "backup.sh: two backups ran within the same second — retry, or rename the existing file." >&2
  exit 1
fi

echo "backup.sh: dumping ${PGHOST}:${PGPORT}/${PGDATABASE} → $DUMP_FILE"

if ! pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$DUMP_FILE"; then
  echo "backup.sh: pg_dump failed — removing incomplete dump file." >&2
  rm -f "$DUMP_FILE"
  exit 1
fi

if [[ ! -s "$DUMP_FILE" ]]; then
  echo "backup.sh: dump file is empty — treating as a failure." >&2
  rm -f "$DUMP_FILE"
  exit 1
fi

echo "backup.sh: OK — $DUMP_FILE"
