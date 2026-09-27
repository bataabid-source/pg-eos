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

# g16_decide → prints `all` or `scoped:<space-separated modules>` (`scoped:` alone = none in scope).
# G16_MODULES unset = all (nightly, deploy, local merge queue); set = scoped; PG_GUARDS_STRICT=1
# (deploy) always prints `all` — deploy never runs a partial G16.
g16_decide() {
  if [ -n "${G16_MODULES+x}" ] && [ "${PG_GUARDS_STRICT:-0}" != "1" ]; then
    local mods=()
    read -r -a mods <<<"$G16_MODULES"
    echo "scoped:${mods[*]}"
  else
    echo all
  fi
}
