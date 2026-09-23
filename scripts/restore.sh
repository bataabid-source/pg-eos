#!/usr/bin/env bash
# PG-EOS · restore.sh — WBS 0.8 (D-130 pilot acceptance, local Docker target only).
#
#   scripts/restore.sh <path-to-dump>
#
# Adapted from docs/package/42-Oracle-Cloud-Deployment.md §6.3 (OCI reference) for the pilot:
# restores into a local "pgeos_restore" database via the local Docker Postgres container's
# published port (127.0.0.1:5432, trust auth) — never via `docker compose exec` — then verifies
# every guard function that exists in database/schema/* plus the SCR-TRGM-01 locale/trigram check
# (docs/notes/2026-09-23-restore-rehearsal.md). Exits 0 only if every check passes.
#
# This script does NOT drop "pgeos_restore" on success — cleanup of the restore target and the
# dump file is the caller's (test harness afterAll's) responsibility.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"

# This tooling is built for the local Docker target only (trust auth). Refuse to run against a
# stray PGHOST pointing at some other host, unless the caller explicitly opts in.
case "$PGHOST" in
  localhost|127.0.0.1) ;;
  *)
    if [[ "${PG_ALLOW_REMOTE_RESTORE:-}" != "1" ]]; then
      echo "restore.sh: refusing to run against PGHOST=${PGHOST} — this is local-Docker-only tooling." >&2
      echo "restore.sh: set PG_ALLOW_REMOTE_RESTORE=1 to override deliberately." >&2
      exit 2
    fi
    ;;
esac

RESTORE_DB="pgeos_restore"

DUMP_FILE="${1:-}"
if [[ -z "$DUMP_FILE" ]]; then
  echo "usage: scripts/restore.sh <path-to-dump>" >&2
  exit 2
fi
if [[ ! -f "$DUMP_FILE" ]]; then
  echo "restore.sh: dump file not found: $DUMP_FILE" >&2
  exit 2
fi

for bin in dropdb createdb pg_restore psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "restore.sh: $bin not found on PATH." >&2; exit 2; }
done

echo "restore.sh: recreating ${RESTORE_DB} on ${PGHOST}:${PGPORT} …"
dropdb --if-exists -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" "$RESTORE_DB"
# SCR-TRGM-01: exact locale every PG-EOS database requires (database/schema/apply.sh).
createdb -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -T template0 -E UTF8 --lc-collate=C --lc-ctype=C.UTF-8 "$RESTORE_DB"

echo "restore.sh: pg_restore ${DUMP_FILE} → ${RESTORE_DB} …"
pg_restore -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -d "$RESTORE_DB" --no-owner --no-privileges "$DUMP_FILE"

q() { psql -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -d "$RESTORE_DB" -Atqc "$1"; }

# wms.verify_balance_integrity()'s comment (database/schema/01-Data-Model.sql:1526) requires a
# role that bypasses RLS — otherwise a 0-row result can mean "RLS hid every row" rather than
# "no integrity problem", and every guard below would wrongly report success.
if ! BYPASS_RLS="$(q "select rolsuper or rolbypassrls from pg_roles where rolname = current_user;")"; then
  echo "restore.sh: FAILED — RLS-bypass precondition query errored." >&2
  exit 3
fi
if [[ "$BYPASS_RLS" != "t" ]]; then
  echo "restore.sh: FAILED — role '${PGUSER}' does not bypass RLS (rolsuper/rolbypassrls both false)." >&2
  echo "restore.sh: guard queries below would be invalid under RLS — refusing to proceed." >&2
  exit 1
fi
echo "restore.sh: OK — role '${PGUSER}' bypasses RLS."

FAILED=0

check_zero_rows() {
  local name="$1" sql="$2"
  local n
  if ! n="$(q "$sql")"; then
    echo "restore.sh: FAILED — $name — query errored." >&2
    FAILED=1
    return
  fi
  if [[ "$n" != "0" ]]; then
    echo "restore.sh: FAILED — $name — expected 0 rows, got $n." >&2
    FAILED=1
  else
    echo "restore.sh: OK — $name — 0 rows."
  fi
}

check_zero_rows "wms.verify_balance_integrity()" \
  "select count(*) from wms.verify_balance_integrity()"
check_zero_rows "billing.verify_journal_balance()" \
  "select count(*) from billing.verify_journal_balance()"
check_zero_rows "platform.verify_audit_chain()" \
  "select count(*) from platform.verify_audit_chain()"

# wms.verify_wh1() always returns a fixed 21 rows (database/schema/019-Warehouse-WH1-Setup.sql:481-482,
# "الواحد والعشرون اختباراً" — 21 checks; confirmed by the post-apply note at line 489: "21 صفاً").
# `passed` is computed via `count(*) = n` / `bool_and(...)`, both boolean (never NULL) over a
# non-empty `l` CTE, but a restore missing the WH1 seed rows entirely could still make `l` empty
# for some branches — so also assert the row count is exactly 21 rather than trusting "0 failures".
WH1_EXPECTED_ROWS=21
if ! WH1_ROW_COUNT="$(q "select count(*) from wms.verify_wh1()")"; then
  echo "restore.sh: FAILED — wms.verify_wh1() — query errored." >&2
  FAILED=1
elif [[ "$WH1_ROW_COUNT" != "$WH1_EXPECTED_ROWS" ]]; then
  echo "restore.sh: FAILED — wms.verify_wh1() — expected ${WH1_EXPECTED_ROWS} rows, got ${WH1_ROW_COUNT}." >&2
  FAILED=1
else
  echo "restore.sh: OK — wms.verify_wh1() — ${WH1_ROW_COUNT} rows as expected."
  check_zero_rows "wms.verify_wh1() (failing rows)" \
    "select count(*) from wms.verify_wh1() where passed is not true"
fi

# SCR-TRGM-01 locale/trigram check (doc 42 §6.3, docs/notes/2026-09-23-restore-rehearsal.md).
# WBS 0.15 (database/schema/apply.sh header): the Arabic literal below MUST go to psql via stdin,
# never via a `-c`/`-Atqc` command-line argument — command-line UTF-8 corrupts on this class of
# Windows environment (verified directly while building this script: `-c` reproducibly raised
# "invalid byte sequence for encoding UTF8" on the identical query that succeeds over stdin).
EXPECTED_LOCALE="C.UTF-8|C|true"
if ! ACTUAL_LOCALE="$(echo "select datctype || '|' || datcollate || '|' || (cardinality(show_trgm('مخزن')) > 0) from pg_database where datname = current_database();" \
  | psql -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -d "$RESTORE_DB" -Atq)"; then
  echo "restore.sh: FAILED — SCR-TRGM-01 locale/trigram check — query errored." >&2
  FAILED=1
elif [[ "$ACTUAL_LOCALE" != "$EXPECTED_LOCALE" ]]; then
  echo "restore.sh: FAILED — SCR-TRGM-01 locale/trigram check — expected '$EXPECTED_LOCALE', got '$ACTUAL_LOCALE'." >&2
  FAILED=1
else
  echo "restore.sh: OK — SCR-TRGM-01 locale/trigram check — $ACTUAL_LOCALE."
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "restore.sh: one or more checks FAILED on ${RESTORE_DB} — see above." >&2
  exit 1
fi

echo "restore.sh: all checks passed on ${RESTORE_DB}."
