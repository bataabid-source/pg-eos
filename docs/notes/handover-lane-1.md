# Handover — build lane 1 (live packet; history is in docs/CHANGELOG.md)

Read with CLAUDE.md and docs/PROJECT_STATE.md. Session session_01VComj7TLSZGmgfAUrRbGsP (lane 1 successor 2), 2026-09-29 23:30Z, context ceiling.

## State
- PR #220 (lane/1-2.9-p3, WBS 2.9 part 3, FEFO/expiry, D-204): head 2f64a28, 0 behind main 7eda919 when pushed, CI ①–⑦ were green on c085e7b; 2f64a28 = the declared final escalation (M13 approval #207 22:58Z): stock-moved payload + audit new_value carry expiry_date; reverseMovement keeps the batch expiry under lockBatchExpiry. pg-reviewer PASS(0).
- claude[bot] keeps FAILing on process only (commit count, review-cap wording, handlers.ts write-list default, budget 2.2×). Per D-205 B no further fix round; M13 merges once the GM confirms D-205 in M13's session (harness refused M13's merge as [CI Bypass]).
- Open rows for M13 to record at squash: `2.9 part 6` (dedicated BatchExpiryConflictError so only the D-204 refusal maps to 422; optional named hashtextextended seed). `2.9 part 5` is CLOSED by 2f64a28. `2.9 part 4` (rebuild-balance parity) stays.
- S1: FEFO allocation step green on pgeos_lane1; `tests/scenarios/S1.spec.ts:455-462` red only on typing (pg date → JS Date vs string) → integration lane 2.18 (reported on #207).
- Backup branch `lane/1-2.9-p3-escalation` (= 2f64a28): harness refused delete (403) → GM deletes.
- Lock `wms | 1 | 2.9` still held; M13 releases it at #220 merge and closes #185.

## Next
1. 2.16 part 3 (PDA pick → check → load) once `pda | 1 | 2.16` is on main (comes with M13's D-205 C chore(X) PR, currently blocked on GM confirmation). Brief `_slice-2.16-p3-pda-pick-check-load` is on main. The Load screen stays conditional on OF-09 / SCR-WMS-OUT-01 (GM 19:35Z; M13 owns the SCR). Start from the XState pattern of 2.16 part 2.
2. Then 2.16 part 2e (PDA visual layer), same `pda` lock; needs Tailwind deps from M-core first.
3. Second step of 2.9 part 3 (S1 QRT routing + quarantine_decision) needs a Master brief.

## Environment notes
- Lane DB pgeos_lane1: migration 0041 applied by hand (apply.sh is not re-runnable); GRN-01 template is not seed data — test fixtures upsert/delete it.
- Build workspace deps before running module tests: `pnpm turbo run build --filter='@pg-eos/wms^...'` (and `@pg-eos/wms` itself before S1 scenarios).
- Never run guards and module tests concurrently on the same lane DB (fixed-UUID fixtures collide).
- Commit with `PGDATABASE=pgeos_lane1 G16_MODULES=`; channel is #207 only (Arabic, ≤ 5 lines).
