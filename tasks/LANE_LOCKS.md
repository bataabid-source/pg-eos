# LANE_LOCKS — module ownership, one row per claimed lock (table only — ADR-0005 §6)

History of claims and releases: `docs/CHANGELOG.md` · migration register and next free number: `database/migrations/README.md`.

| module | lane | task | claimed_at | worktree |
|---|---|---|---|---|
| wms | 1 | 2.9 | 2026-09-28 | cloud:session_012JpnMyNrcJm4vRQfFhjCVx |
| packages/identity | M | 2.16 | 2026-09-28 | . |
| identity | M | 2.16 | 2026-09-28 | . |
| billing | 2 | 4.19 | 2026-09-28 | cloud:session_013aUcxUgLt9g8EmcyQZLJsf |
| packages/i18n | M | 4.19 | 2026-09-29 | . |

## Rules (CLAUDE.md · AGENTS AND SESSIONS)

1. A lock is a module (`wms`) or a module/use-case pair (`wms/put-away`, D-179); each appears at most once, and a whole-module row and a use-case row of the same module never coexist for two lanes. A lane writes only inside its lock and `tests/`; a use-case lock never writes a module-wide file (index.ts, package.json, router, i18n) — a worker needing a file outside its lock STOPS and reports.
2. Only the Master claims and releases, through `node scripts/scribe.mjs --claim <module> <lane> <task>` / `--release <module>`, never by hand. Lanes never edit it — max three lanes. The `worktree` column of a lane row is `../pg-eos-lane-<lane>` — never the shared `claude-kit`; `scripts/check-locks.sh` (pre-commit gate ⓐ, CI gate ①, `pnpm check:locks`) refuses the table otherwise.
3. Frozen for every lane: `packages/*`, `database/schema/*`, `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*` — changes there are single-lane Master tasks merged before lanes resume.
4. Migrations: the lane requests — every migration of its whole task list in ONE table at lane start, each row naming its RED test paths — the Master issues the numbers in one batch and records them here; the file is `database/migrations/NNNN_<lane>_<slug>.sql`, refused by `lane-guard.sh` until the named RED tests exist, and migrations merge first, in number order (D-179).
5. Merge queue: pg-reviewer PASS → `git rebase main` → gates ①–③ green → `pnpm guards:run` green → the Master merges via linear history (rebase merge, D-173); lanes never merge lanes.

`lane` is `A` (GM manual) · `B` · `C` · `1` · `2` · `3` · `M` (Master), taken from the `Lane` column of `docs/package/38-WBS.md` — never invented. `.claude/hooks/lane-guard.sh` reads this table on every Edit/Write when `PG_LANE` is set.
