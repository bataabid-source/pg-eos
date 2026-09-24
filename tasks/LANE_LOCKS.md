# LANE_LOCKS — module ownership, one row per claimed module

| module | lane | task | claimed_at | worktree |
|---|---|---|---|---|
| admin | 1 | 0.19 | 2026-09-24 | ../pg-eos-lane-1 (queued — next lane-1 session; `apps/admin`, D-172) |
| hr | 2 | 5.5a | 2026-09-24 | ../pg-eos-lane-2 (queued — next lane-2 session) |
| platform | 2 | 5.5a | 2026-09-24 | ../pg-eos-lane-2 (queued — `platform.sites` §2.4 ONLY; released with the 5.5a merge, then lane 3 / 5.18) |

- `0013_1_price-lists-version.sql` — lane 1, task 1.2, applied 2026-09-24 (pg-reviewer pre-migration APPROVED WITH CHANGES; number issued by the Master, MIGRATION-REQUEST-1.md).

`hr` (lane 2, task 3.3) released 2026-09-24 — 3.3 DONE @ `9616422` (PR #14); re-claimed above for 5.5a.
`catalog` (lane 1, task 1.2) released 2026-09-24 — 1.2 DONE @ `6a53fc8` (PR #12).
`platform` (lane 3, task 5.13) released 2026-09-24 — 5.13 part 1 committed (alert evaluation mechanism), NOT DONE (part 2: delivery, escalation, dynamic recipients, reports, job).
`wms + packages/db (idempotency) + database/migrations (0010)` (lane M, task 2.9-part2) released 2026-09-24 — GM sheet-3 answers applied (idempotency store, cancel/close rules, variance photo, shared logger); NOT DONE (blocked on SCR-WMS-INB-01 §6, Q10/D-159 GM acceptance).
`wms + packages/contracts/wms + packages/events (catalog)` (lane M, task 2.9) released 2026-09-24 — 2.9 built and reviewed, PASS round 4; NOT DONE (blocked on SCR-PLAT-IDEM-01, SCR-WMS-INB-01 §1–4, observability, GM acceptance).
`wms` (lane 2, task 2.4) released 2026-09-24 — 2.4 DONE.
`packages/db + CI (.github)` (lane M, task 0.6a-2) released 2026-09-24 — 0.6a IN PROGRESS pending GM ruleset decision (first green CI run: #2 @ d8dc887).

## Migrations issued

Not a lock table — deliberately not a `|`-prefixed markdown table, since
`.claude/hooks/lane-guard.sh` parses every such line in this file as a
module-lock row (see Rules below). One line per migration, newest first:

- `0015` — next free number; issued by the Master on the next MIGRATION-REQUEST (5.5a expected first: `platform.sites` + `hr.shifts` / `hr.shift_assignments` / `hr.shift_groups`).
- `0014_2_employees-version.sql` — lane 2, task 3.3 (`hr.employees.version` + classification row; shape of 0008), issued by the Master 2026-09-24 on MIGRATION-REQUEST-2 (pre-migration review APPROVED); applied, merged in `9616422`.
- `0013` — RESERVED for lane 1, task 1.2 (catalog), pending its MIGRATION-REQUEST-1.md.
- `0012_M_space-dashboard-invoker-grant.sql` — lane M, task 5.13 part 1, applied 2026-09-24 (pg-reviewer pre-migration APPROVED WITH CHANGES, header text).
- `0011_M_alert-log-version-seed-rules.sql` — lane M, task 5.13 part 1, applied 2026-09-24 (pg-reviewer pre-migration FAIL(11) → PASS round 2).
- `0010_M_idempotency-keys-variance-photo.sql` — lane M, task 2.9-part2, applied 2026-09-24 (pg-reviewer pre-migration APPROVED WITH CHANGES).
- `0009_M_next-doc-no-definer.sql` — lane M, task 2.9, applied 2026-09-24 (pg-reviewer pre-migration APPROVED WITH CHANGES).
- `0008_M_inbound-orders-version.sql` — lane M, task 2.9, applied 2026-09-24 (pg-reviewer pre-migration APPROVED WITH CHANGES).
- `0007_M_pgeos-app-role-entity-scope.sql` — lane M, task 0.6a (part 1, D-133/D-140), applied 2026-09-24 (pg-reviewer pre-migration APPROVED WITH CHANGES; slice PASS round 4).
- `0006_M_possible-duplicates-ge.sql` — lane M, task 1.5 (GM directive phase D: 13B §13B-19 `> 0.85` → `>= 0.85`), applied 2026-09-23 (pg-reviewer migration gate PASS, round 3).
- `0005_M_balance-integrity-batch.sql` — lane M, task 2.8 fix (SCR-WMS-01), applied 2026-09-23 (pg-reviewer migration gate PASS, round 2).
- `0004_M_audit-chain-seq.sql` — lane M, task 0.9 fix (SCR-AUDIT-01, ADR-0002), applied 2026-09-23 (pg-reviewer migration gate PASS, round 3).
- `0003_M_rls-scr-01-02.sql` — lane M, task 0.18 (SCR-RLS-01 B+C, SCR-RLS-02 A+B+C), applied 2026-09-23.
- `0002_M_classify-columns.sql` — lane M, task 0.16, applied 2026-09-22.
- `0001_B_fix-is-internal-empty-guc.sql` — lane B, task 0.11, applied 2026-09-22.

## Rules (CLAUDE.md · PARALLEL LANES — CONFLICT-FREE MECHANISM (v5))

1. A module appears at most once; a lane writes only inside its locked modules and `tests/`, and a worker needing a file outside its lock STOPS and reports.
2. Only the Master claims and releases; pg-scribe writes this file. Lanes never edit it — max three lanes.
3. Frozen for every lane: `packages/*`, `database/schema/*`, `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*` — changes there are single-lane Master tasks merged before lanes resume.
4. Migrations: the lane requests, the Master issues the next `NNNN` and records it here; the file is `database/migrations/NNNN_<lane>_<slug>.sql` and migrations merge first, in number order.
5. Merge queue: pg-reviewer PASS → `git rebase main` → gates ①–③ green → `pnpm guards:run` green → the Master merges fast-forward only; lanes never merge lanes.

`lane` is `A` (GM manual) · `B` · `C` · `1` · `2` · `3` · `M` (Master), taken from the `Lane` column of `docs/package/38-WBS.md` — never invented. `.claude/hooks/lane-guard.sh` reads this table on every Edit/Write when `PG_LANE` is set.
