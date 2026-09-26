#!/usr/bin/env bash
# PG-EOS · brief-check.sh — the SPLIT-BEFORE gate (D-179, 2026-09-25).
#   usage: bash scripts/brief-check.sh <slice-brief.md> [--root <repo>]
#   exit 0 = within budget · exit 1 = over budget (split into two slices BEFORE pg-tester starts)
#          · exit 2 = brief unreadable / no Read ONLY block
#
# CLAUDE.md · OPERATING RULES · SPLIT BEFORE, NOT AFTER: "SPLIT BEFORE, NOT AFTER: a brief over the budget
# is split into two slices before pg-tester starts, never after a failed round." Budget since P7:
# 8 files / 1,000 lines (was 12 / 1,500; CLAUDE.md states it since P2).
# .claude/briefs/_TEMPLATE.brief.md: "A 'Read ONLY' list over 8 files or 1,000 lines (P7; was 12 / 1,500) MUST be
# split into two slices before any worker is delegated to."
#
# What is counted (deterministic, no judgement):
#   files = every distinct existing file named in the Read ONLY block — brace groups `{a,b}`
#           and `*`/`**` globs are expanded against the repository.
#   lines = for a path followed by `lines A-B` or `A-B` (also `A-B, C-D`) the ranges' sizes;
#           otherwise the whole file's line count. A directory glob counts every file it matches.
# The Read ONLY block runs from the line matching /^(## )?Read ONLY/ to the next line that
# starts with `Write ONLY`, `## `, `Scenario:` or `Deliver`.
# Run by: /slice step 5 (before pg-tester), .githooks/pre-commit when a
# docs/notes/slice-briefs/*.brief.md is staged, tests/hooks.
set -uo pipefail

# P7 (2026-09-26, GM-delegated plan; D-186 applied the numbers per slice first): 8 files / 1,000 lines.
MAX_FILES=8
MAX_LINES=1000

BRIEF="${1:-}"
ROOT="."
if [ "${2:-}" = "--root" ]; then ROOT="${3:-.}"; fi
[ -n "$BRIEF" ] && [ -f "$BRIEF" ] || { echo "brief-check: usage: brief-check.sh <brief.md> [--root <repo>]" >&2; exit 2; }

block="$(awk '
  /^(## )?Read ONLY/ { on = 1; next }
  on && /^(## |Write ONLY|Scenario:|Deliver)/ { exit }
  on { print }
' "$BRIEF")"
[ -n "$block" ] || { echo "brief-check: no 'Read ONLY' block in $BRIEF" >&2; exit 2; }

# Routing v2 (D-191, GM 2026-09-26): the brief names its builder before pg-tester starts —
# `builder: pg-backend | pg-backend-core | pg-frontend`, optionally two joined by `+`
# (e.g. `builder: pg-backend-core + pg-frontend`). A brief without a valid line is refused.
BUILDER_RE='^builder:[[:space:]]*(pg-backend|pg-backend-core|pg-frontend)([[:space:]]*\+[[:space:]]*(pg-backend|pg-backend-core|pg-frontend))?[[:space:]]*$'
if ! grep -Eq "$BUILDER_RE" "$BRIEF"; then
  echo "brief-check: no valid 'builder:' line (pg-backend | pg-backend-core | pg-frontend) — routing v2, D-191" >&2
  status_builder=1
else
  status_builder=0
fi

expand_braces() {
  # a/{b,c}/d → a/b/d a/c/d, every brace group, in order
  local queue=("$1") out=() s pre inner rest a
  while [ "${#queue[@]}" -gt 0 ]; do
    s="${queue[0]}"; queue=("${queue[@]:1}")
    if [[ "$s" == *"{"*"}"* ]]; then
      pre="${s%%\{*}"; rest="${s#*\{}"; inner="${rest%%\}*}"; rest="${rest#*\}}"
      IFS=',' read -ra alts <<< "$inner"
      for a in "${alts[@]}"; do queue+=("${pre}${a}${rest}"); done
    else
      out+=("$s")
    fi
  done
  printf '%s\n' "${out[@]}"
}

declare -A seen=()
total_lines=0
# Tokenise: candidate paths are tokens that contain a `/` or end in a known extension.
# Line ranges: the text after the path, up to the next path token, may hold `lines A-B` / `A-B`.
tokens="$(printf '%s\n' "$block" | tr '`()' '   ' | tr -s '[:space:]' '\n')"
prev_path=""
ranges_for_prev=""
flush() {
  [ -n "$prev_path" ] || return
  for f in $(expand_braces "$prev_path"); do
    shopt -s globstar nullglob
    matches=( $ROOT/$f )
    shopt -u globstar nullglob
    for m in "${matches[@]}"; do
      [ -f "$m" ] || continue
      rel="${m#$ROOT/}"
      [ -n "${seen[$rel]:-}" ] && continue
      seen[$rel]=1
      if [ -n "$ranges_for_prev" ]; then
        for r in $ranges_for_prev; do
          a="${r%-*}"; b="${r#*-}"
          [ "$b" -ge "$a" ] 2>/dev/null && total_lines=$((total_lines + b - a + 1))
        done
      else
        total_lines=$((total_lines + $(wc -l < "$m")))
      fi
    done
  done
  prev_path=""; ranges_for_prev=""
}
while IFS= read -r t; do
  t="${t%,}"; t="${t%.}"; t="${t%;}"; t="${t%:}"
  [ -n "$t" ] || continue
  if [[ "$t" =~ ^[A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@{},*-]+)+$ ]] || [[ "$t" =~ ^[A-Za-z0-9_.-]+\.(md|ts|tsx|sql|json|mjs|sh|py|yml|yaml|feature)$ ]]; then
    flush; prev_path="$t"
  elif [[ "$t" =~ ^[0-9]+-[0-9]+$ ]]; then
    ranges_for_prev="$ranges_for_prev $t"
  fi
done <<< "$tokens"
flush

count="${#seen[@]}"
status=0
[ "$count" -le "$MAX_FILES" ] || { echo "brief-check: OVER BUDGET — Read ONLY names $count files (max $MAX_FILES)" >&2; status=1; }
[ "$total_lines" -le "$MAX_LINES" ] || { echo "brief-check: OVER BUDGET — Read ONLY spans $total_lines lines (max $MAX_LINES)" >&2; status=1; }
if [ "$status" -eq 0 ]; then
  echo "brief-check: OK — $count files, $total_lines lines (max $MAX_FILES / $MAX_LINES)"
else
  echo "brief-check: split the slice in two BEFORE pg-tester starts (CLAUDE.md · SPLIT BEFORE, NOT AFTER)" >&2
fi
[ "$status_builder" -eq 0 ] || status=1
exit $status
