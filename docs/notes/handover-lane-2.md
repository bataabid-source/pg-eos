# Handover — build lane 2 (live packet; history is in docs/CHANGELOG.md)

Read with CLAUDE.md and docs/PROJECT_STATE.md. Session session_012audWizm1uuLmQZBJd1nLy, 2026-09-29, ceiling passed (517k).

## State
- PR #214 (lane/2-4.20, WBS 4.20 posting engine, migration 0041): head e3e1999 (M-core mounted the three
  /billing/post-journal/* routes). CI ①–⑥ green on e3e1999 (⑦ was running). Migration PR: manual squash by the Master
  into one `feat(4.20)`, after #215 → #216 → #217 → #218 → #209 (Advisory 18:20Z order).
- Master M12 decision (a), #207 17:10Z: PASS subset only. The r4 fixes (64850e1, 8ac7b35) were reverted in 4cb8bb3.
  Review count, cumulative: slice PASS(7, 2 rounds); claude[bot] r1 PASS(2), r2 FAIL(2), r3 FAIL(1, migration
  escalation), r4–r7 past the REVIEW CAP. The squash trailer states this; the Master writes it.
- Open question on #207 (19:25Z, lane 2): re-apply 4.20 part 8 (posted-original check in `mark_journal_reversed`,
  64850e1: 2 SQL lines + 1 test) in #214 as a declared last escalation, because 0041 is forward-only. Master decides.
- Proposed new row 4.20 part 10: ReverseJournal looks up the entry before the CFO role check (existence leak).
- Backlog rows open for 4.20 (tasks/MASTER_BACKLOG.md, carried on #214): part 2 CFO approval path (OD-15, needs
  `approvalDecisionId` in the frozen contract) · 3 brief read-list sizing · 4 permission codes (SCR-BILLING-JOURNAL-PERM-01)
  · 5 probe-drift throw · 6 "same order" claim · 7 403 in the contract · 8 posted-original check · 9 XState guards.
- Lock `billing | 2 | 4.20` was released in the 4.20 commit (scribe --release).

## Next
1. After #214 merges: the Master names the next billing row here (4.20 part 8/9 first if not taken into #214; they touch
   migration 0041's function, so part 8 needs a new migration number unless it rides #214).
2. Lane DB: `bash scripts/lane-db.sh 2`, PGDATABASE=pgeos_lane2. `pnpm guards:run` re-applies 0007 (re-grants DML to
   pgeos_app) — re-apply 0041 after it locally. Commit with `G16_MODULES=billing` (module-scoped, GM standing rule);
   an unscoped G16 fails on main's platform dry-run residue (`users_pkey`, handlers.test.ts:223-242, M-core item).
3. After a main merge with new app deps: `pnpm install --frozen-lockfile` before committing (gate ① builds everything).
- Channel: issue #207 (read on every check-in, report ≤ 5 lines in Arabic); the live Master is M12 → M13.
