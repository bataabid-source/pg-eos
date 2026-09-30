#!/usr/bin/env bash
# PG-EOS · merge-step.sh — the Master's manual merge step for M-core, migration and lock PRs
# (CLAUDE.md · Merge queue: "rebase on main → gates ①–③ → pnpm guards:run → rebase merge";
# #209 review finding 2 / X part 17 item 15).
#   usage: bash scripts/merge-step.sh [guards-run.sh args…]
#   exit = guards-run.sh's exit code
#
# Why: `pnpm guards:run` runs `bash scripts/guards-run.sh` (package.json:18). Since X part 16 a local
# guards:run skips G16 (and reports a missing G15–G17 runner as NOT RUNNABLE) unless
# PG_GUARDS_STRICT=1. The merge step never does: it sets PG_GUARDS_STRICT=1 explicitly on the
# command, so a caller who exported PG_GUARDS_STRICT=0 still gets the strict run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PG_GUARDS_STRICT=1 bash "$ROOT/scripts/guards-run.sh" "$@"
exit $?
