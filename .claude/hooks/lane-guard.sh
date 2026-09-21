#!/usr/bin/env bash
# PG-EOS · lane-guard.sh — PreToolUse hook for Edit | Write | MultiEdit.
#
# Enforces, at the tool call, the two rules CLAUDE.md states in prose:
#   PARALLEL LANES — CONFLICT-FREE MECHANISM (v5): "A lane writes only inside its
#   locked modules and tests/" · "Frozen during any parallel phase: packages/*,
#   database/schema/*, packages/contracts/_shared/*, CLAUDE.md, .claude/*".
#
# Contract (Claude Code hooks):
#   stdin  = JSON with .tool_name and .tool_input.file_path
#   exit 0 = allow · exit 2 = BLOCK, reason is read from stderr
#   any other exit code is a non-blocking error.
#
# Session mode:
#   PG_LANE set   → lane session. Writes allowed only under modules/<locked>/,
#                   apps/<locked>/, tests/, and database/migrations/NNNN_<lane>_*.
#   PG_LANE unset → Master session. Everything allowed except database/schema/*,
#                   which is the delivered schema (01 · 13 · 13B · 019) and is
#                   changed only under the G-01 rule (EXECUTION-MASTER-v4 §1.11).
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
LOCKS="$ROOT/tasks/LANE_LOCKS.md"
PAYLOAD="$(cat)"

# ---- read tool_input.file_path out of the stdin JSON ----------------------
FILE=""
if command -v python3 >/dev/null 2>&1; then
  FILE="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys
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
case "$REL" in
  "$ROOT"/*) REL="${REL#"$ROOT"/}" ;;
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
      [0-9][0-9][0-9][0-9]_"$LANE"_*) exit 0 ;;
      *) block "a lane writes only migrations named NNNN_${LANE}_<slug>.sql with a number issued by the Master. Request one in tasks/backlog/MIGRATION-REQUEST-${LANE}.md." ;;
    esac ;;
esac

# ---- modules this lane owns, read from tasks/LANE_LOCKS.md ---------------
if [ ! -f "$LOCKS" ]; then
  block "tasks/LANE_LOCKS.md not found — a lane session may not write before its modules are claimed."
fi

OWNED="$(awk -F'|' -v lane="$LANE" '
  /^[[:space:]]*\|/ {
    m = $2; l = $3
    gsub(/[[:space:]`]/, "", m); gsub(/[[:space:]`]/, "", l)
    if (m == "" || m == "module" || m ~ /^-+$/) next
    if (l == lane) print m
  }' "$LOCKS")"

if [ -z "$OWNED" ]; then
  block "lane $LANE holds no module lock in tasks/LANE_LOCKS.md. Claim the module through the Master before writing."
fi

for m in $OWNED; do
  case "$REL" in
    modules/"$m"/*|apps/"$m"/*) exit 0 ;;
  esac
done

block "lane $LANE owns only [$(printf '%s' "$OWNED" | tr '\n' ' ')] — it may write under modules/<owned>/, apps/<owned>/, tests/, and its Master-numbered migration. STOP and report instead of widening the lock."
