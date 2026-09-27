#!/usr/bin/env bash
# PG-EOS · mutation-all.sh — G16 (doc 40 Part F): Stryker on every module's domain/, one module at a
# time in its own process. A single `pnpm -r run mutation` stalled after two modules on 2026-09-26
# (child runner never exited), so each module gets its own timeout and the loop continues past a
# failure so every score is reported; the exit code is red if any module was red or missing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PER_MODULE_TIMEOUT="${MUTATION_TIMEOUT:-1800}"
status=0

# Every module test that imports a workspace package (@pg-eos/domain-kit, /contracts, ...) resolves
# it through the package's `exports` map to dist/. Stryker's vitest runner drops a test file whose
# import fails without failing the dry run, so on a checkout with no dist/ (CI gate ⑤, nightly) the
# mutants those files cover are reported "no coverage" and every module scores under 75 (2026-09-27:
# wms dry run 414 tests in CI vs 1,000 locally). Build the packages first; turbo caches the no-op.
echo "mutation-all: building packages/* (workspace imports resolve to dist/)"
if ! (cd "$ROOT" && pnpm -s exec turbo run build --filter='./packages/*' >/dev/null); then
  echo "mutation-all: packages build failed — no module can be scored" >&2
  exit 1
fi

for dir in "$ROOT"/modules/*/; do
  [ -f "$dir/stryker.config.json" ] || continue
  name="$(basename "$dir")"
  echo "mutation-all: ${name}"
  if ! (cd "$dir" && timeout "$PER_MODULE_TIMEOUT" pnpm -s exec stryker run); then
    echo "mutation-all: ${name} RED (score under thresholds.break, crash or timeout)" >&2
    status=1
  fi
done

exit "$status"
