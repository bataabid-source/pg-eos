# LANE_LOCKS — module ownership, one row per claimed module

| module | lane | task | claimed_at | worktree |
|---|---|---|---|---|
| wms/process-outbound | 1 | 2.11 | 2026-09-25 | ../pg-eos-lane-1 (outbound order, migration 0022 WITHDRAWN — column already in 13B; 2.11 scaffold + RED tests already on disk in that worktree, untracked; 2.10 DONE @ `95a33b8`) |
| wms/schedule-inbound | 2 | 2.9b | 2026-09-25 | ../pg-eos-lane-2 (schedule inbound + logistics terms, tasks/backlog/2.9b-schedule-inbound.md, D-168/D-169; use-case lock so it runs concurrently with lane 1's 2.11) |
| wms/receive-inbound | 2 | 2.9b | 2026-09-25 | ../pg-eos-lane-2 (scoped grant by the Master 2026-09-25: 2.9b's acceptance criteria (SCR-WMS-INB-01 §7) change `ApproveInbound` (optional `expectedAt`, emits `wms.inbound.scheduled`) and `CancelInbound` (mandatory `cancelReason`) — `modules/wms/application/receive-inbound/{approve-inbound,cancel-inbound,ports}.ts`, `modules/wms/infrastructure/receive-inbound/repository.ts`, `modules/wms/api/receive-inbound/handlers.ts`, `modules/wms/domain/receive-inbound/machine.ts` (self-transition `SCHEDULE` event — legality goes through the machine, never a status string comparison) and their tests under `modules/wms/tests/receive-inbound/` — widened from two files on pg-reviewer round 1 of 2.9b (raw SQL bypassing the repository port and unmapped 422 errors were lock-induced); no other receive-inbound file; released with 2.9b) |
| imile | 3 | 3.14 | 2026-09-25 | ../pg-eos-lane-3 (part 2, services/agent pull loop; part 1 DONE-in-part on main; then 3.15→3.19 per D-180 item 3) |

WBS 1.11 is doc-38 Lane **M**, corrected 2026-09-25 from an earlier Master misassignment to lane 1, then investigated on GM instruction and found **BLOCKED** (D-178, `docs/notes/2026-09-25-wbs-1.11-premature.md`) — not a lane-1 row, not buildable today.
`wms` (lane 1, task 2.10) released 2026-09-25 — 2.10 DONE @ `95a33b8`; re-claimed above as the use-case lock `wms/process-outbound` (D-179/D-180) so lane 2 can build 2.9b in the same module at the same time.

- `0013_1_price-lists-version.sql` — lane 1, task 1.2, applied 2026-09-24 (pg-reviewer pre-migration APPROVED WITH CHANGES; number issued by the Master, MIGRATION-REQUEST-1.md).
- `0019_1_contracts-version.sql` — lane 1, task 1.7, applied 2026-09-25 (pg-reviewer pre-migration APPROVED WITH CHANGES; number issued by the Master, MIGRATION-REQUEST-1.md).

`wms` (lane 2, task 2.15) released 2026-09-25 — Phase 2 complete for lane 2 (2.13 DONE @ `ca9a109`, 2.14 DONE @ `eec1618`, 2.15 DONE @ `<this commit>`); lane 2 now builds `wms/schedule-inbound` (2.9b, D-180) instead of idling. `wms` also freed for lane 1 — claimed above as `wms/process-outbound` for 2.10/2.11.
`sales` + `admin` (lane 1, task 1.9) released 2026-09-25 — 1.9 DONE @ `90faea3` (PR #43).
`hr` (lane 2, task 5.5a) released 2026-09-25 — 5.5a DONE in full @ `ffab3bf` (part 1 `3679b70` + part 2 `ffab3bf`, PRs #19/#30); re-claimed above (`wms`) for Phase 2 (D-176).
`admin` (lane 1, task 0.19) released 2026-09-25 — 0.19 DONE @ `80e827f` (PR #24); re-claimed above (`sales`) for Phase 1 (D-176).
`platform` (lane 2, task 5.5a part 1) released 2026-09-24 — `platform.sites` DONE @ `3679b70` (PR #19); free for lane 3 / 5.18 now that lane 2 no longer holds it.
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

- `0026` — next free number.
- `0025_M_client-portal-scope-internal-bypass.sql` — lane M, SCR-RLS-03 / D-181 (seven `client_portal_scope` policies rewritten to `NOT is_internal() AND client_id = current_client_id()`; internal reads now rest on `entity_scope` alone), pg-reviewer (opus) pre-migration APPROVED WITH CHANGES (5 findings applied), RED first (`tests/isolation` entity-boundary tests rewritten by pg-tester), applied 2026-09-25.
- `0024_3_shipments-version.sql` — lane 3, task 3.14 part 2 (`imile.shipments.version int not null default 1` + classification row; shape of 0008/0013/0014/0017/0019/0020/0022/0023), issued by the Master 2026-09-25 on MIGRATION-REQUEST-3 row 1; the row names the RED tests `modules/imile/tests/pull-shipments/{pull-shipments.feature,pull-shipments.test.ts}` and the pre-migration pg-reviewer run is mandatory before the file is written.
- `0023_2_schedule-inbound.sql` — lane 2, task 2.9b (SCR-WMS-INB-01 §8 G-01: `wms.inbound_orders` + `handover_point`, `transport_by`, `labour_by`, `labour_count`, `delivery_task_id` nullable, check on `vehicle_type`; N-23 alert seed), issued by the Master 2026-09-25 ahead of MIGRATION-REQUEST-2 (D-179 batch); the request row must name the RED test paths before the file is written, and the pre-migration pg-reviewer run is mandatory. `delivery_task_id` is a nullable column only — no `tms.delivery_task` row is created until a `tms` slice exists to own it (Master default, same class as D-178).
- `0022` — **WITHDRAWN 2026-09-25** (lane 1, 2.11 part 1, pg-reviewer round 1: `wms.outbound_orders.version` already exists at 13B-Schema-Reference-Consolidation.sql:164-166; the number stays consumed, no file is written). Original issue: `0022_1_outbound-orders-version.sql` — lane 1, task 2.11 (`wms.outbound_orders.version` + classification row; shape of 0008/0013/0017/0019/0020), issued by the Master 2026-09-25 on MIGRATION-REQUEST-1 (#6, pre-migration review to be run by the lane before the file is written).
- `0021_1_accounts-internal-write-policy.sql` — lane 1, task 1.8, G-01 schema-change (SCR-SALES-ACCT-01, `docs/notes/`): `sales.accounts` had no internal write RLS policy at all (silent no-op UPDATE for every role). Fix APPROVED by the Master: `internal_only for all using (platform.is_internal())`, additive, matches every other non-entity-scoped internal table's policy. Issued 2026-09-25; RLS-touching, pre-migration review mandatory, run by the lane before the file is written. Applied 2026-09-25 (pg-reviewer pre-migration APPROVED WITH CHANGES; number issued by the Master).
- `0020_1_accounts-version.sql` — lane 1, task 1.8 (`sales.accounts.version` + classification row; shape of 0008/0013/0017/0019), issued by the Master 2026-09-25 on MIGRATION-REQUEST-1 (#4, pre-migration review to be run by the lane before the file is written). Applied 2026-09-25 (pg-reviewer pre-migration APPROVED WITH CHANGES; number issued by the Master, MIGRATION-REQUEST-1.md).
- `0019_1_contracts-version.sql` — lane 1, task 1.7 (`sales.contracts.version` + classification row; shape of 0008/0013/0017), issued by the Master 2026-09-25 on MIGRATION-REQUEST-1 (pre-migration review to be run by the lane before the file is written, same as 1.2/1.6).
- `0018_2_inventory-counts-version.sql` — lane 2, task 2.13 (`wms.inventory_counts.version` + classification row; shape of 0008/0013), issued by the Master 2026-09-25 on MIGRATION-REQUEST-2 (pre-migration review APPROVED WITH CHANGES, 3 comment-only findings applied; applied and verified by the lane).
- `0017_1_quotes-version.sql` — lane 1, task 1.6 (`sales.quotes.version` + classification row; shape of 0008/0013), issued by the Master 2026-09-25 on MIGRATION-REQUEST-1; applied and verified by the lane (pg-reviewer pre-migration APPROVED WITH CHANGES).
- `0016_2_shifts-groups-assignments.sql` — lane 2, task 5.5a part 2 (`hr.shifts` / `hr.shift_groups` / `hr.shift_assignments`, exclusion constraint + composite FK), issued by the Master on MIGRATION-REQUEST-2, applied and verified by the lane (35/35 columns classified, RLS active, exclusion + FK functionally tested).
- `0015_2_platform-sites.sql` — lane 2, task 5.5a part 1 (`platform.sites` + `hr.employees.default_site_id` FK + `platform.thresholds` `att.geofence_radius_m=500`, SCR-HR-SHIFT-01 §2.4 / D-144 item 4), issued by the Master 2026-09-24 on MIGRATION-REQUEST-2 (pre-migration review APPROVED WITH CHANGES, 7 findings applied).
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

1. A lock is a module (`wms`) or a module/use-case pair (`wms/put-away`, D-179); each appears at most once, and a whole-module row and a use-case row of the same module never coexist for two lanes. A lane writes only inside its lock and `tests/`; a use-case lock never writes a module-wide file (index.ts, package.json, router, i18n) — a worker needing a file outside its lock STOPS and reports.
2. Only the Master claims and releases; pg-scribe writes this file. Lanes never edit it — max three lanes. The `worktree` column of a lane row is `../pg-eos-lane-<lane>` — never the shared `claude-kit`; `scripts/check-locks.sh` (pre-commit gate ⓐ, CI gate ①, `pnpm check:locks`) refuses the table otherwise.
3. Frozen for every lane: `packages/*`, `database/schema/*`, `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*` — changes there are single-lane Master tasks merged before lanes resume.
4. Migrations: the lane requests — every migration of its whole task list in ONE table at lane start, each row naming its RED test paths — the Master issues the numbers in one batch and records them here; the file is `database/migrations/NNNN_<lane>_<slug>.sql`, refused by `lane-guard.sh` until the named RED tests exist, and migrations merge first, in number order (D-179).
5. Merge queue: pg-reviewer PASS → `git rebase main` → gates ①–③ green → `pnpm guards:run` green → the Master merges fast-forward only; lanes never merge lanes.

`lane` is `A` (GM manual) · `B` · `C` · `1` · `2` · `3` · `M` (Master), taken from the `Lane` column of `docs/package/38-WBS.md` — never invented. `.claude/hooks/lane-guard.sh` reads this table on every Edit/Write when `PG_LANE` is set.
