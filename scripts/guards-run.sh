#!/usr/bin/env bash
# PG-EOS · guards-run.sh — run database/schema/guards.sql and turn its rows into an exit code.
#
#   scripts/guards-run.sh                 # uses $PGDATABASE (default pgeos) and the usual PG* vars
#   PGDATABASE=pgeos_ci scripts/guards-run.sh
#
# guards.sql (doc 40 Part F) is written so that EVERY query returns rows ONLY on failure.
# The pass condition is CLAUDE.md · TESTING:
#   - G1–G17 must each return zero rows or their stated condition; a single failure blocks merge
#     and deploy. G1–G13 are the SQL half and are evaluated here.
#   - G6 (unclassified columns) is a normal blocking guard (WBS 0.16 closed column
#     classification; identity.column_classification now covers every column G6 checks).
#   - G18 (billing.verify_unpriced_events) is REPORT-ONLY and never blocks.
#   - G-SEED (reference-seed completeness) is REPORT-ONLY and never blocks.
#   - G14–G17 are not SQL and are not run here: `pnpm test:isolation` · `pnpm playwright test
#     tests/scenarios` · `pnpm stryker run` · `pnpm test:trace`.
#
# Exit: 0 all blocking guards green · 1 at least one of G1–G13 (G6 included, WBS 0.16 closed) returned a row
#       · 2 the guards file or psql could not be run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARDS="${PG_GUARDS_FILE:-$ROOT/database/schema/guards.sql}"
DB="${PGDATABASE:-pgeos}"

command -v psql >/dev/null 2>&1 || { echo "guards-run: psql not found on PATH." >&2; exit 2; }
[ -f "$GUARDS" ] || { echo "guards-run: $GUARDS not found." >&2; exit 2; }

OUT="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$OUT" "$ERR"' EXIT

echo "guards-run: $GUARDS against database '$DB'"
# WBS 0.15: stdin redirection, not -f — see database/schema/apply.sh's header for the full,
# epistemically-honest account (root cause not fully isolated; verified-safe defensive fix, kept
# despite a diagnostics cost, because -f reproducibly corrupted multi-byte UTF-8 in the working
# environment these guards actually run in, and stdin did not).
if ! psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" <"$GUARDS" >"$OUT" 2>"$ERR"; then
  echo "guards-run: psql failed — the guards did not complete." >&2
  sed -n '1,40p' "$ERR" >&2
  exit 2
fi

# guards.sql prints a "--- Gn: ... ---" banner before each guard; everything between two banners
# that is not a banner is a FAILING ROW of that guard. The final banner block is G-SEED.
SUMMARY="$(awk '
  /^--- / {
    sec = $0
    sub(/^--- /, "", sec)
    sub(/[:(].*$/, "", sec)
    gsub(/[[:space:]]+$/, "", sec)
    if (sec ~ /^G-SEED/) sec = "G-SEED"
    next
  }
  /^═/ { sec = ""; next }
  /^[[:space:]]*$/ { next }
  { if (sec != "") count[sec]++ }
  END { for (g in count) printf "%s %d\n", g, count[g] }
' "$OUT" | sort -V)"

BLOCKING=0
printf '\n%-10s %-8s %s\n' "guard" "rows" "verdict"
printf -- '---------- -------- ---------------------------------------------\n'

report_line() { printf '%-10s %-8s %s\n' "$1" "$2" "$3"; }

for g in G1 G2 G3 G4 G5 G6 G7 G8 G9 G10 G11 G12 G13 G18 G-SEED; do
  rows="$(printf '%s\n' "$SUMMARY" | awk -v k="$g" '$1==k {print $2}')"
  rows="${rows:-0}"
  case "$g" in
    G18)
      if [ "$rows" -gt 0 ]; then report_line "$g" "$rows" "REPORT ONLY — unpriced billing events"
      else report_line "$g" "$rows" "green"; fi ;;
    G-SEED)
      if [ "$rows" -gt 0 ]; then report_line "$g" "$rows" "REPORT ONLY — reference seed count mismatch"
      else report_line "$g" "$rows" "green"; fi ;;
    *)
      if [ "$rows" -gt 0 ]; then report_line "$g" "$rows" "RED — blocks merge and deploy"; BLOCKING=$((BLOCKING + 1))
      else report_line "$g" "$rows" "green"; fi ;;
  esac
done

echo
echo "G14–G17 are not SQL: pnpm test:isolation · pnpm playwright test tests/scenarios · pnpm stryker run · pnpm test:trace"

if [ "$BLOCKING" -gt 0 ]; then
  echo
  echo "guards-run: $BLOCKING blocking guard(s) RED. There is no 'deploy and fix'. Failing rows:" >&2
  grep -E '^G([1-9]|1[0-3])\|' "$OUT" | head -40 >&2
  exit 1
fi

echo "guards-run: all blocking guards green."
exit 0
