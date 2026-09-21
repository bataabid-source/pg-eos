#!/usr/bin/env bash
# check-boundaries.sh — the executable form of the WBS 0.4 acceptance criterion
# (tasks/MASTER_BACKLOG.md row 0.4: "pnpm build green; cross-module import fails lint").
#
# It asserts the whole criterion, not the convenient half. A lint setup that failed on
# everything, or a tsconfig that type-checked nothing, would satisfy the words and not the rule:
#
#   A  clean tree — pnpm build, pnpm typecheck and pnpm lint are all green
#   B  cross-module import by package name      '@pg-eos/platform'          fails lint
#   C  cross-module import by relative path     '../../platform/index.js'   fails lint
#   D  cross-module import by UNRESOLVABLE relative path                    fails lint
#        (boundaries cannot classify what it cannot resolve — the regex layer catches it)
#   E  an `eslint-disable` comment does NOT rescue a cross-module import
#        (CLAUDE.md · AGENT CONSTRAINTS bans eslint-disable; noInlineConfig enforces it)
#   F  a file at modules/<m>/domain/ IS type-checked
#        (doc 36 §1-2 and scripts/new-slice.sh put slice code there, never under src/;
#         a tsconfig scoped elsewhere makes `pnpm build` green over an empty file set)
#
# Turbo runs with --force throughout: the fixtures are git-ignored, so a cached task could
# otherwise report green without ever looking at them.
set -uo pipefail

cd "$(dirname "$0")/.."

LINT_FIXTURE="modules/identity/__check_boundary__.ts"
TYPE_FIXTURE="modules/identity/domain/__check_typecheck__.ts"
LOG="$(mktemp -t pg-boundaries.XXXXXX)"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
FAILED=0
fail() { printf "  ${RED}FAIL${NC}  %s\n" "$1"; FAILED=1; }
ok()   { printf "  ${GREEN}OK${NC}    %s\n" "$1"; }

cleanup() {
  rm -f "$LINT_FIXTURE" "$TYPE_FIXTURE" "$LOG"
  [ -d modules/identity/domain ] && rmdir modules/identity/domain 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM
cleanup   # clear anything a killed earlier run left behind

echo "== boundary check (WBS 0.4 acceptance)"

if [ ! -d node_modules ]; then
  fail "node_modules absent — run 'pnpm install' first"
  exit 1
fi

# ── A. the tree as committed must be green, or nothing below proves anything ──
for task in build typecheck; do
  if pnpm exec turbo run "$task" --force >"$LOG" 2>&1; then
    ok "pnpm $task is green on the committed tree"
  else
    fail "pnpm $task is NOT green on the committed tree"; sed -n '1,30p' "$LOG"
  fi
done
if pnpm exec eslint . >"$LOG" 2>&1; then
  ok "pnpm lint is green on the committed tree"
else
  fail "pnpm lint is NOT green on the committed tree"; sed -n '1,30p' "$LOG"
fi

# ── B–E. every way of crossing a module border must fail lint ────────────────
# $1 = label · $2 = expected rule in the output · $3 = fixture body
expect_lint_failure() {
  local label="$1" expected_rule="$2" body="$3"
  printf '%s\n' "$body" > "$LINT_FIXTURE"
  if pnpm exec eslint "$LINT_FIXTURE" >"$LOG" 2>&1; then
    fail "$label — PASSED lint; the boundary is not enforced"
  elif grep -q "$expected_rule" "$LOG"; then
    ok "$label — fails lint ($expected_rule)"
  else
    fail "$label — failed lint, but not via $expected_rule"; sed -n '1,20p' "$LOG"
  fi
  rm -f "$LINT_FIXTURE"
}

expect_lint_failure "B. import by package name" "no-restricted-imports" \
"import * as platform from '@pg-eos/platform';
export const used = platform;"

expect_lint_failure "C. import by resolvable relative path" "boundaries/dependencies" \
"import * as platform from '../platform/index.js';
export const used = platform;"

expect_lint_failure "D. import by unresolvable relative path" "no-restricted-imports" \
"import * as platform from '../platform/domain/does-not-exist.js';
export const used = platform;"

expect_lint_failure "E. eslint-disable does not rescue it" "no-restricted-imports" \
"// eslint-disable-next-line no-restricted-imports, boundaries/dependencies
import * as platform from '@pg-eos/platform';
export const used = platform;"

# ── F. the mandated module layout is actually type-checked ───────────────────
mkdir -p modules/identity/domain
printf '%s\n' "export const deliberatelyWrong: number = 'not a number';" > "$TYPE_FIXTURE"
if pnpm exec turbo run typecheck --force >"$LOG" 2>&1; then
  fail "F. a type error in modules/identity/domain/ did NOT fail typecheck — tsconfig does not cover the layout of doc 36 §1-2"
else
  ok "F. modules/<m>/domain/ is type-checked"
fi
rm -f "$TYPE_FIXTURE"; rmdir modules/identity/domain 2>/dev/null

cleanup
echo
if [ "$FAILED" -eq 0 ]; then
  printf "${GREEN}BOUNDARIES ENFORCED${NC} — WBS 0.4 acceptance criterion is green (A-F).\n"
  exit 0
fi
printf "${RED}BOUNDARIES NOT ENFORCED${NC} — WBS 0.4 is not DONE.\n"
exit 1
