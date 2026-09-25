#!/usr/bin/env bash
# PG-EOS · db-guard.sh — PreToolUse hook on Bash (D-183, 2026-09-25).
# Refuses any `psql` invocation that carries DELETE FROM / DROP / TRUNCATE against the shared
# development database `pgeos`. Rule (every agent file, verbatim):
#   «لا DELETE / DROP / TRUNCATE على القاعدة المشتركة خارج afterAll لحزمة الاختبار نفسها؛
#    صف غريب يُبلَّغ للـ Master ولا يُمسّ»
# Background: a pg-tester worker deleted rows on `pgeos` through psql after both its lane session
# and the Master had declined to (2.11 part 1, pg-reviewer round 2 finding 12). A rule that no hook
# enforces decays (D-179) — this hook turns it into a refusal at the tool call.
#
# Target database resolution, in order: `-d <db>` / `--dbname=<db>` / `--dbname <db>` on the psql
# command line · an inline `PGDATABASE=<db>` assignment in the command · $PGDATABASE of the session
# · unset → not `pgeos`, allowed (psql then targets the OS user's database, which does not exist).
# The test-suite path (vitest afterAll) never goes through psql and is untouched. `apply.sh` is
# invoked as `bash database/schema/apply.sh …` — its internal statements are not in the command
# text and are not the target of this rule.
#
# Exit codes (same convention as lane-guard.sh): 0 = allow · 2 = block (message on stderr).
set -u

PAYLOAD="$(cat)"

PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -n "$PY" ]; then
  CMD="$(printf '%s' "$PAYLOAD" | "$PY" -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input") or {}
print(ti.get("command") or "")' 2>/dev/null)"
else
  CMD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)"
fi
[ -n "$CMD" ] || exit 0

# Only psql invocations are in scope.
printf '%s' "$CMD" | grep -qE '(^|[^A-Za-z0-9_./-])psql([^A-Za-z0-9_]|$)' || exit 0

lc="$(printf '%s' "$CMD" | tr '[:upper:]' '[:lower:]')"

# Destructive statement present anywhere in the command text (inline SQL, heredoc body, -c/-f args)?
printf '%s' "$lc" | grep -qE '(^|[^a-z0-9_])(delete[[:space:]]+from|drop[[:space:]]|truncate[[:space:]])' || exit 0

# Resolve the target database.
db="$(printf '%s' "$CMD" | grep -oE -- '(^|[[:space:]])(-d[[:space:]]*|--dbname(=|[[:space:]]+))[A-Za-z0-9_-]+' | head -1 | sed -E 's/^[[:space:]]*(-d[[:space:]]*|--dbname(=|[[:space:]]+))//')"
if [ -z "$db" ]; then
  db="$(printf '%s' "$CMD" | grep -oE '(^|[[:space:]])PGDATABASE=[A-Za-z0-9_-]+' | head -1 | sed -E 's/^[[:space:]]*PGDATABASE=//')"
fi
if [ -z "$db" ]; then
  db="${PGDATABASE:-}"
fi

[ "$db" = "pgeos" ] || exit 0

# ---- D-188 (GM, 2026-09-25): the Master may run a shared-DB cleanup ---------------------------
# Allowed ONLY when BOTH hold:
#   1. the session runs from the Master's worktree — basename of $CLAUDE_PROJECT_DIR (or $PWD) is
#      exactly `pg-eos-gov` (lane sessions run from ../pg-eos-lane-<id>, D-179; their subagents
#      inherit that project dir, so no lane worker can use this path);
#   2. the command carries the literal marker `MASTER-CLEANUP (D-188)` (e.g. as an SQL comment),
#      so every Master cleanup is deliberate and greppable in the transcript.
# Anything else stays refused exactly as D-183 states.
ROOT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
ROOT_DIR="${ROOT_DIR//\\//}"
ROOT_DIR="${ROOT_DIR%/}"
if [ "$(basename "$ROOT_DIR")" = "pg-eos-gov" ] && printf '%s' "$CMD" | grep -qF 'MASTER-CLEANUP (D-188)'; then
  echo "db-guard: ALLOWED — Master shared-DB cleanup (D-188), marker present, session in pg-eos-gov." >&2
  exit 0
fi

{
  echo "db-guard: REFUSED — DELETE / DROP / TRUNCATE through psql against the shared database 'pgeos' (D-183)."
  echo "  Rule: لا DELETE / DROP / TRUNCATE على القاعدة المشتركة خارج afterAll لحزمة الاختبار نفسها؛ صف غريب يُبلَّغ للـ Master ولا يُمسّ."
  echo "  A stray row is reported to the Master and left alone; test fixtures clean up in their own afterAll."
} >&2
exit 2
