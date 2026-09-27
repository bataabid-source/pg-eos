#!/usr/bin/env bash
# PG-EOS · post-edit-check.sh — PostToolUse hook for Edit | Write | MultiEdit.
#
# Fast feedback (GM directive 2026-09-27 "نفذ الكل بنفسك"): the moment a TypeScript file is
# written, lint it and typecheck the package that owns it, so a type or boundary error is seen in
# the same turn instead of at pre-commit (gate ①). The edit stands either way — this hook only
# reports.
#
# Contract (Claude Code hooks):
#   stdin  = JSON with .tool_name and .tool_input.file_path
#   exit 0 = nothing to report
#   exit 2 = findings on stderr, fed back to the session
#   any other exit code is a non-blocking error.
#
# Scope: *.ts *.tsx *.mts *.cts only; every other file exits 0 without running anything.
#   lint      : `pnpm exec eslint <file>` from the repo root (flat config, boundaries included)
#   typecheck : `pnpm run typecheck` of the nearest package.json above the file (skipped when the
#               file has no package or the package has no typecheck script)
# Test seams (tests/hooks/run.sh): PEC_LINT_CMD <file> and PEC_TYPECHECK_CMD <package-dir>
# replace the two commands.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
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

case "$REL" in
  *.ts|*.tsx|*.mts|*.cts) ;;
  *) exit 0 ;;
esac
[ -f "$ROOT_FWD/$REL" ] || exit 0

# ---- nearest package above the file (never the repo root) -----------------
PKG=""
dir="$(dirname "$REL")"
while [ -n "$dir" ] && [ "$dir" != "." ] && [ "$dir" != "/" ]; do
  if [ -f "$ROOT_FWD/$dir/package.json" ]; then PKG="$dir"; break; fi
  dir="$(dirname "$dir")"
done

cd "$ROOT_FWD" || exit 0
rc=0
report=""

if [ -n "${PEC_LINT_CMD:-}" ]; then
  lint_out="$($PEC_LINT_CMD "$REL" 2>&1)" || rc=2
else
  lint_out="$(pnpm -s exec eslint --no-warn-ignored "$REL" 2>&1)" || rc=2
fi
if [ "$rc" -ne 0 ]; then
  report+="lint — $REL"$'\n'"$lint_out"$'\n'
fi

if [ -n "$PKG" ]; then
  tc_rc=0
  if [ -n "${PEC_TYPECHECK_CMD:-}" ]; then
    tc_out="$($PEC_TYPECHECK_CMD "$PKG" 2>&1)" || tc_rc=2
  else
    tc_out="$(cd "$PKG" && pnpm -s run --if-present typecheck 2>&1)" || tc_rc=2
  fi
  if [ "$tc_rc" -ne 0 ]; then
    rc=2
    errs="$(printf '%s\n' "$tc_out" | grep -E 'error TS[0-9]+' | head -20)"
    [ -n "$errs" ] || errs="$(printf '%s\n' "$tc_out" | tail -20)"
    report+="typecheck — $PKG"$'\n'"$errs"$'\n'
  fi
fi

if [ "$rc" -ne 0 ]; then
  printf 'post-edit-check (.claude/hooks/post-edit-check.sh): fix before moving on — gate ① refuses this at commit.\n%s' "$report" >&2
  exit 2
fi
exit 0
