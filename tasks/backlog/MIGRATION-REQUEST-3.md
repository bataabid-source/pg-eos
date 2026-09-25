# MIGRATION-REQUEST-3 — lane 3 (imile)

| # | module | slug | purpose (one line) | RED test paths | requested | issued by Master |
|---|---|---|---|---|---|---|
| 1 | imile | `shipments-version` | `imile.shipments.version int not null default 1` (+ column_classification row) — WBS 3.14 part 2's `PullShipments` command updates existing rows (iMile-sourced columns only) and CLAUDE.md · ARCHITECTURE requires an optimistic-lock column on every mutable aggregate; verbatim replica of 0008/0013/0014/0017/0019/0020 | `modules/imile/tests/pull-shipments/pull-shipments.feature`, `modules/imile/tests/pull-shipments/pull-shipments.test.ts` | 2026-09-25 | **0024** — issued in the Master's commit `3eb4465` 2026-09-25 ("0024 = imile.shipments.version (3.14 part 2)"); file `database/migrations/0024_3_shipments-version.sql`; pre-migration pg-reviewer APPROVED WITH CHANGES; applied |

Only row 1 is requested now, for the task actually being built this session (3.14 part 2). WBS 3.15–3.19 have not been briefed yet (SPLIT BEFORE, NOT AFTER / one task per session) — each will add its own row here, if any, when its lane-3 session starts its brief. No number picked by the lane; waiting for the Master.
