#!/usr/bin/env bash
# PG-EOS · lane-guard.sh — PreToolUse hook for Edit | Write | MultiEdit.
#
# Enforces, at the tool call, the rules CLAUDE.md states in prose:
#   PARALLEL LANES: "A lane writes only inside its
#   locked modules and tests/" · "Frozen during any parallel phase: packages/*,
#   database/schema/*, packages/contracts/_shared/*, CLAUDE.md, .claude/*".
#   D-179 (2026-09-25): a lane session runs ONLY in its own worktree ../pg-eos-lane-<id>;
#   a lock row is a module or a module/use-case pair; a lane's migration file is written
#   only after its MIGRATION-REQUEST row names the RED test files that already exist.
#
# Contract (Claude Code hooks):
#   stdin  = JSON with .tool_name and .tool_input.file_path
#   exit 0 = allow · exit 2 = BLOCK, reason is read from stderr
#   any other exit code is a non-blocking error.
#
# Session mode:
#   PG_LANE set   → lane session. Writes allowed only under the locked scope (see below),
#                   tests/, docs/notes/, its MIGRATION-REQUEST file and its Master-numbered
#                   migration whose request row names existing RED tests.
#   PG_LANE unset → Master session. Everything allowed except database/schema/*,
#                   which is the delivered schema (01 · 13 · 13B · 019) and is
#                   changed only under the G-01 rule (EXECUTION-MASTER-v4 §1.11).
#
# Lock scope (tasks/LANE_LOCKS.md, `module` column):
#   `wms`             → modules/wms/**  and apps/wms/**
#   `wms/put-away`    → modules/wms/<layer>/put-away/** for layer in domain application
#                        infrastructure api tests, and apps/wms/src/features/put-away/**,
#                        apps/wms/tests/put-away/**. Files shared by the whole module
#                        (index.ts, package.json, router, i18n) need the whole-module lock.
#   A whole-module row and a use-case row of the same module never coexist for two lanes;
#   the hook refuses every write of both lanes until the Master fixes the table.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
LOCKS="$ROOT/tasks/LANE_LOCKS.md"
PAYLOAD="$(cat)"

# ---- read tool_input.file_path out of the stdin JSON ----------------------
FILE=""
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -n "$PY" ]; then
  FILE="$(printf '%s' "$PAYLOAD" | "$PY" -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input") or {}
print(ti.get("file_path") or ti.get("filePath") or "")' 2>/dev/null)"
fi
if [ -z "$FILE" ]; then
  FILE="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi
# No path to judge (e.g. a tool form this hook does not know) → do not block.
[ -n "$FILE" ] || exit 0

# ---- normalise to a repository-relative path -----------------------------
REL="$FILE"
REL="${REL//\\//}"
ROOT_FWD="${ROOT//\\//}"
case "$REL" in
  "$ROOT_FWD"/*) REL="${REL#"$ROOT_FWD"/}" ;;
  /*)        REL="${REL#/}" ;;
  ./*)       REL="${REL#./}" ;;
esac

block() {
  printf '%s\n' "BLOCKED by .claude/hooks/lane-guard.sh — $1" >&2
  printf '%s\n' "path: $REL" >&2
  exit 2
}

# ---- frozen paths: refused in every session ------------------------------
case "$REL" in
  database/schema/*)
    block "database/schema/* is the delivered schema (01 · 13 · 13B · 019 · guards.sql · apply.sh). File a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01); write a migration under database/migrations/ instead." ;;
esac

# ---- Master session: everything else is allowed --------------------------
if [ -z "${PG_LANE:-}" ]; then
  exit 0
fi

LANE="$PG_LANE"

# ---- D-179: a lane session writes only from its own worktree -------------
WT_NAME="$(basename "$ROOT_FWD")"
if [ "$WT_NAME" != "pg-eos-lane-$LANE" ]; then
  block "lane $LANE may write only inside its own worktree ../pg-eos-lane-$LANE (this checkout is '$WT_NAME'). Two sessions on one checkout clobber each other (incident a901a04). Open the worktree: git worktree add ../pg-eos-lane-$LANE -b lane/$LANE"
fi

# ---- lane session: the rest of the frozen list ---------------------------
case "$REL" in
  packages/*|CLAUDE.md|.claude/*)
    block "frozen during a parallel phase (packages/* · database/schema/* · packages/contracts/_shared/* · CLAUDE.md · .claude/*). A change here is a single-lane Master task, merged before lanes resume." ;;
esac

# ---- always-writable lane paths ------------------------------------------
case "$REL" in
  tests/*)  exit 0 ;;
  docs/notes/*) exit 0 ;;
  tasks/backlog/MIGRATION-REQUEST-*) exit 0 ;;
  database/migrations/*)
    base="${REL##*/}"
    case "$base" in
      [0-9][0-9][0-9][0-9]_"$LANE"_*.sql) ;;
      *) block "a lane writes only migrations named NNNN_${LANE}_<slug>.sql with a number issued by the Master. Request one in tasks/backlog/MIGRATION-REQUEST-${LANE}.md." ;;
    esac
    # D-179: RED before migration — the request row for this slug names ≥ 1 existing test file.
    slug="${base#[0-9][0-9][0-9][0-9]_"$LANE"_}"
    slug="${slug%.sql}"
    REQ="$ROOT/tasks/backlog/MIGRATION-REQUEST-$LANE.md"
    [ -f "$REQ" ] || block "tasks/backlog/MIGRATION-REQUEST-$LANE.md does not exist — request the number and name the RED tests before writing a migration."
    row="$(grep -F -- "$slug" "$REQ" | head -1)"
    [ -n "$row" ] || block "no row for slug '$slug' in tasks/backlog/MIGRATION-REQUEST-$LANE.md — request the number (with the RED test paths) before writing the migration."
    red_paths="$(printf '%s' "$row" | grep -oE '(modules|tests|apps)/[A-Za-z0-9_./-]+\.(feature|test\.ts|spec\.ts)' | sort -u)"
    [ -n "$red_paths" ] || block "RED before migration (CLAUDE.md · OPERATING RULES · RED FIRST): the MIGRATION-REQUEST-$LANE.md row for '$slug' names no test file. pg-tester writes the Gherkin scenario, property tests and guard additions BEFORE the migration; list their paths (modules/<m>/tests/<uc>/*.feature|*.test.ts) in the row."
    while IFS= read -r p; do
      [ -f "$ROOT/$p" ] || block "RED before migration: '$p' is named in the MIGRATION-REQUEST-$LANE.md row for '$slug' but does not exist yet. pg-tester writes it first; the migration comes after."
    done <<< "$red_paths"
    exit 0 ;;
esac

# ---- locks this lane owns, read from tasks/LANE_LOCKS.md -----------------
if [ ! -f "$LOCKS" ]; then
  block "tasks/LANE_LOCKS.md not found — a lane session may not write before its modules are claimed."
fi

# Every lock row as "module lane" pairs (module may be `m` or `m/use-case`).
ALL_ROWS="$(awk -F'|' '
  /^[[:space:]]*\|/ {
    m = $2; l = $3
    gsub(/[[:space:]`]/, "", m); gsub(/[[:space:]`]/, "", l)
    if (m == "" || m == "module" || m ~ /^-+$/) next
    print m, l
  }' "$LOCKS")"

OWNED="$(printf '%s\n' "$ALL_ROWS" | awk -v lane="$LANE" '$2 == lane { print $1 }')"

if [ -z "$OWNED" ]; then
  block "lane $LANE holds no lock in tasks/LANE_LOCKS.md. Claim the module (or module/use-case) through the Master before writing."
fi

# A whole-module row and a use-case row of the same module held by different lanes = conflict.
for m in $OWNED; do
  mod="${m%%/*}"
  conflict="$(printf '%s\n' "$ALL_ROWS" | awk -v mod="$mod" -v lane="$LANE" -v own="$m" '
    $2 != lane {
      split($1, parts, "/")
      if (parts[1] == mod && (own !~ /\// || $1 !~ /\//)) print $1 " (lane " $2 ")"
    }' | head -1)"
  [ -z "$conflict" ] || block "lock conflict in tasks/LANE_LOCKS.md: lane $LANE holds '$m' while $conflict is also held. A whole-module row and a use-case row of the same module never coexist for two lanes — the Master fixes the table before either lane writes."
done

for m in $OWNED; do
  case "$m" in
    */*)
      mod="${m%%/*}"; uc="${m#*/}"
      case "$REL" in
        modules/"$mod"/domain/"$uc"/*|modules/"$mod"/application/"$uc"/*|modules/"$mod"/infrastructure/"$uc"/*|modules/"$mod"/api/"$uc"/*|modules/"$mod"/tests/"$uc"/*) exit 0 ;;
        apps/"$mod"/src/features/"$uc"/*|apps/"$mod"/tests/"$uc"/*) exit 0 ;;
        # additive include registration (tests/<uc>/**); scripts/new-slice.sh writes it, rebases merge it
        modules/"$mod"/tsconfig.test.json) exit 0 ;;
      esac ;;
    *)
      case "$REL" in
        modules/"$m"/*|apps/"$m"/*) exit 0 ;;
      esac ;;
  esac
done

block "lane $LANE owns only [$(printf '%s' "$OWNED" | tr '\n' ' ')] — it may write under the locked module (modules/<m>/**, apps/<m>/**) or the locked use case (modules/<m>/<layer>/<uc>/**, apps/<m>/src/features/<uc>/**), tests/, docs/notes/ and its Master-numbered migration. A module-wide file (index.ts, package.json, router, i18n) needs the whole-module lock. STOP and report instead of widening the lock."
