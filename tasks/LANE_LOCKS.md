# LANE_LOCKS — module ownership, one row per claimed module

Currently none claimed.

## Migrations issued

Not a lock table — deliberately not a `|`-prefixed markdown table, since
`.claude/hooks/lane-guard.sh` parses every such line in this file as a
module-lock row (see Rules below). One line per migration, newest first:

- `0001_B_fix-is-internal-empty-guc.sql` — lane B, task 0.11, applied 2026-09-22.

## Rules (CLAUDE.md · PARALLEL LANES — CONFLICT-FREE MECHANISM (v5))

1. A module appears at most once; a lane writes only inside its locked modules and `tests/`, and a worker needing a file outside its lock STOPS and reports.
2. Only the Master claims and releases; pg-scribe writes this file. Lanes never edit it — max three lanes.
3. Frozen for every lane: `packages/*`, `database/schema/*`, `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*` — changes there are single-lane Master tasks merged before lanes resume.
4. Migrations: the lane requests, the Master issues the next `NNNN` and records it here; the file is `database/migrations/NNNN_<lane>_<slug>.sql` and migrations merge first, in number order.
5. Merge queue: pg-reviewer PASS → `git rebase main` → gates ①–③ green → `pnpm guards:run` green → the Master merges fast-forward only; lanes never merge lanes.

`lane` is `A` (GM manual) · `B` · `C` · `1` · `2` · `3` · `M` (Master), taken from the `Lane` column of `docs/package/38-WBS.md` — never invented. `.claude/hooks/lane-guard.sh` reads this table on every Edit/Write when `PG_LANE` is set.
