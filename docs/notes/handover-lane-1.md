# Handover — build lane 1 (live packet; history is in docs/CHANGELOG.md)

Read with CLAUDE.md and docs/PROJECT_STATE.md. Session session_01QdrAPRKmFdLKZYJzbceZDc, 2026-09-29, ceiling reached.

## State
- PR #211 (lane/1-2.16-p2, WBS 2.16 part 2, PDA receive + put-away): head 9f8d93d, up to date with main cab71f0,
  CI ①–⑦ green, claude[bot] PASS(1 nit: the squash message states the honest review — FAIL rounds, PASS subset — never
  `PASS(20 findings)`). All review threads resolved. Waiting only on the Master's squash merge.
- On #211 beyond the original commit: put-away retry, typed `ReceiveTransportError`, re-tap double-receipt fix, both
  screens on XState v5 (`receive-machine.ts`, `put-away-machine.ts`). `xstate` 5.33.2 + `@xstate/react` 6.1.0 added to
  apps/pda under the GM's in-session approval «مقبول»; lockfile delta limited to them (one unrelated jsdom peer line
  pnpm had changed was reverted to main's value; frozen install passes). pda 141/141.
- Row 2.16 part 2d is closed on #211. Rows 2.16 part 2b (offline receive re-resolution, G-01 on `checkScan`) and
  2.16 part 2c (one test assertion) stay open.
- Lock `pda | 1 | 2.16` is still held; the Master swaps it to `wms | 1` when #211 merges (Advisory 16:20Z).

## Next
1. 2.9 part 3 (brief docs/notes/slice-briefs/_slice-2.9-p3-fefo-expiry.brief.md; D-204: one expiry per batch across all
   locations, enforced in the ledger write path, no schema change). Branch `lane/1-2.9-part-3` from origin/main once
   the `wms | 1` row is on main. Order: pg-reviewer pre-build → pg-tester RED → builder per the brief's `builder:` line
   → pg-reviewer close. Closing #185 is the Master's call.
2. Then 2.16 part 3 (pick → check → load) on the Master's brief; start from the XState machine pattern of part 2.
- Lane DB: `bash scripts/lane-db.sh 1`, PGDATABASE=pgeos_lane1. Commit with `G16_MODULES=` empty (CI ⑤ runs G16, D-198).
- Channel: issue #207 (read on every check-in, report ≤ 5 lines in Arabic); the live Master is M12.
