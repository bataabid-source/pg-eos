#!/usr/bin/env bash
# PG-EOS · check-locks.sh — validates tasks/LANE_LOCKS.md (D-179, 2026-09-25).
#   usage: bash scripts/check-locks.sh [path-to-LANE_LOCKS.md]
#   exit 0 = OK · exit 1 = one or more violations (each printed) · exit 2 = file missing
#
# Rules enforced (CLAUDE.md · PARALLEL LANES — CONFLICT-FREE MECHANISM (v5) + D-179):
#   1. A lock is `module` or `module/use-case`; each appears at most once.
#   2. A whole-module row and a use-case row of the same module never coexist for two lanes.
#   3. A lane row (lane 1|2|3|A|B|C) names the worktree `../pg-eos-lane-<lane>` — never the
#      shared `claude-kit` checkout. Lane M (Master) is exempt.
#   4. At most three lane rows with distinct lanes (max three lanes).
#   5. The `task` of every row is a row ID of docs/package/38-WBS.md (or the literal `X`) — D-185:
#      a lock for a task that is not a doc-38 row is refused, so a staged row (tasks/MASTER_BACKLOG.md
#      "Staged" section) is moved into doc 38 by the Master BEFORE any lane claims it.
#      The doc is read from $CHECK_LOCKS_WBS, else <repo root>/docs/package/38-WBS.md.
# Run by: .githooks/pre-commit (when the file is staged), scripts/check-setup.sh, tests/hooks.
set -uo pipefail

LOCKS="${1:-tasks/LANE_LOCKS.md}"
[ -f "$LOCKS" ] || { echo "check-locks: $LOCKS not found" >&2; exit 2; }

fail=0
err() { echo "check-locks: VIOLATION — $1" >&2; fail=1; }

# module | lane | worktree | task  (backticks and spaces stripped from module/lane/task; worktree kept raw)
rows="$(awk -F'|' '
  /^[[:space:]]*\|/ {
    m = $2; l = $3; t = $4; w = $6
    gsub(/[[:space:]`]/, "", m); gsub(/[[:space:]`]/, "", l); gsub(/[[:space:]`]/, "", t)
    sub(/^[[:space:]]+/, "", w); sub(/[[:space:]]+$/, "", w)
    if (m == "" || m == "module" || m ~ /^-+$/) next
    print m "\t" l "\t" w "\t" t
  }' "$LOCKS")"

WBS_DOC="${CHECK_LOCKS_WBS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/package/38-WBS.md}"

[ -n "$rows" ] && {
  # rule 1 — unique lock
  dup="$(printf '%s\n' "$rows" | cut -f1 | sort | uniq -d)"
  [ -z "$dup" ] || err "lock appears more than once: $(printf '%s' "$dup" | tr '\n' ' ')"

  # rule 2 — whole vs use-case coexistence across lanes
  while IFS=$'\t' read -r m l w t; do
    case "$m" in
      */*) mod="${m%%/*}"
           other="$(printf '%s\n' "$rows" | awk -F'\t' -v mod="$mod" -v lane="$l" '$1 == mod && $2 != lane { print $2 }' | head -1)"
           [ -z "$other" ] || err "'$m' (lane $l) coexists with whole-module '$mod' held by lane $other" ;;
    esac
  done <<< "$rows"

  # rule 3 — lane worktree
  while IFS=$'\t' read -r m l w t; do
    [ "$l" = "M" ] && continue
    case "$w" in
      "../pg-eos-lane-$l"|"../pg-eos-lane-$l "*|"../pg-eos-lane-$l("*) ;;
      *) err "'$m' (lane $l) names worktree '$w' — a lane runs only in ../pg-eos-lane-$l (D-179), never the shared claude-kit checkout" ;;
    esac
  done <<< "$rows"

  # rule 4 — max three lanes
  n="$(printf '%s\n' "$rows" | cut -f2 | grep -v '^M$' | sort -u | wc -l | tr -d ' ')"
  [ "$n" -le 3 ] || err "$n lanes hold locks — max three lanes"

  # rule 5 — task is a doc-38 row (D-185)
  if [ -f "$WBS_DOC" ]; then
    while IFS=$'\t' read -r m l w t; do
      [ "$t" = "X" ] && continue
      awk -F'|' -v id="$t" '/^\|/ { c = $2; gsub(/[[:space:]]/, "", c); if (c == id) f = 1 } END { exit !f }' "$WBS_DOC" \
        || err "'$m' (lane $l) is locked for task '$t', which is not a row of docs/package/38-WBS.md — the Master moves a staged row into doc 38 before it is claimed (D-185)"
    done <<< "$rows"
  else
    err "docs/package/38-WBS.md not found at '$WBS_DOC' — cannot validate lock tasks (D-185)"
  fi
}

if [ "$fail" -eq 0 ]; then echo "check-locks: OK"; exit 0; fi
exit 1
