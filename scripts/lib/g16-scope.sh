#!/usr/bin/env bash
# PG-EOS · scripts/lib/g16-scope.sh — which modules G16 (Stryker, doc 40 Part F) scores (X part 6, D-193 D6).
# Sourced by scripts/guards-run.sh (the decision) and by .github/workflows/ci.yml gate ⑤ (the diff);
# tests/ops/tests/x-part-6.test.ts drives both functions without running Stryker.
#
# A module's mutation score depends on its domain/ (the mutants), its tests/ (what kills them), its
# vitest.config.ts (how Stryker runs them) and its stryker.config.json — a change to any of the four
# puts the module in scope. packages/* are out of scope: gates ②/③ catch a broken import and the
# nightly run scores every module.

G16_SCOPE_PATHS='^modules/([^/]+)/(domain/.+|tests/.+|vitest\.config\.ts|stryker\.config\.json)$'

# g16_changed_modules <base-sha> → prints the in-scope module names, space-separated (empty line = none),
# or the single word ALL when <base-sha> is empty or not a commit here (new branch, zero `before`,
# force-push) — an unresolvable base widens to every module, never narrows to none. --no-renames: a
# file moved out of domain/ (or between modules) lists its old path too, so the source module counts.
g16_changed_modules() {
  local base="${1:-}"
  if [ -z "$base" ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then echo ALL; return 0; fi
  git diff --no-renames --name-only "$base"...HEAD \
    | sed -nE "s#${G16_SCOPE_PATHS}#\\1#p" \
    | sort -u \
    | while read -r m; do if [ -f "modules/$m/stryker.config.json" ]; then echo "$m"; fi; done \
    | xargs
}

# g16_decide → prints `all`, `scoped:<space-separated modules>` (`scoped:` alone = none in scope) or
# `local`. Three-way rule, first match wins (X part 16, D-198 (أ) — Stryker out of the local check,
# kept in CI and nightly):
#   1. PG_GUARDS_STRICT=1 (deploy: `pnpm guards:deploy` sets it) → `all`, CI or not — deploy never
#      runs a partial G16.
#   2. CI mode (CI set, not empty, not "false", not "0" — CI gate ⑤) → G16_MODULES set = `scoped:`,
#      unset = `all`.
#   3. otherwise (local pre-commit / pnpm guards:run) → `local`, whatever G16_MODULES is: G16 is
#      not run here; CI gate ⑤ (scoped) and the nightly run (every module) govern.
g16_decide() {
  if [ "${PG_GUARDS_STRICT:-0}" = "1" ]; then
    echo all
  elif [ -n "${CI:-}" ] && [ "$CI" != false ] && [ "$CI" != 0 ]; then
    if [ -n "${G16_MODULES+x}" ]; then
      local mods=()
      read -r -a mods <<<"$G16_MODULES"
      echo "scoped:${mods[*]}"
    else
      echo all
    fi
  else
    echo local
  fi
}
