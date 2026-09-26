#!/usr/bin/env bash
# PG-EOS · mutation-all.sh — G16 (doc 40 Part F): Stryker on every module's domain/, one module at a
# time in its own process. A single `pnpm -r run mutation` stalled after two modules on 2026-09-26
# (child runner never exited), so each module gets its own timeout and the loop continues past a
# failure so every score is reported; the exit code is red if any module was red or missing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PER_MODULE_TIMEOUT="${MUTATION_TIMEOUT:-1800}"
status=0

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
