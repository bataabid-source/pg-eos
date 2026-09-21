#!/usr/bin/env bash
# PG-EOS · stop-reminder.sh — Stop hook.
#
# Prints the two facts the operator needs at the end of a session:
#   1. how many files are still uncommitted — "Code that is not committed does
#      not exist" (BOOTSTRAP-v5 §1);
#   2. the one-task-per-session rule (CLAUDE.md · QUOTA DISCIPLINE (v5)).
#
# This hook never blocks: it always exits 0.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$ROOT" 2>/dev/null || exit 0

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  COUNT="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if [ "$COUNT" -gt 0 ]; then
    echo "PG-EOS · branch $BRANCH — $COUNT uncommitted change(s). A task is DONE only with the commit hash of its passing acceptance test in docs/PROJECT_STATE.md."
  else
    echo "PG-EOS · branch $BRANCH — working tree clean."
  fi
else
  echo "PG-EOS · not a git work tree — nothing to report."
fi

echo "PG-EOS · one task per session. /compact after the review PASS, /clear before the next task. Never carry a slice across sessions."
exit 0
