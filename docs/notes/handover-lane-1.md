# Handover — build lane 1 (live packet; history is in docs/CHANGELOG.md)

Read with CLAUDE.md and docs/PROJECT_STATE.md. Session session_01EqzNQeqRGdNkNG9zKSe8Hm (lane 1 successor 3), 2026-09-30 ~18:00Z, slice closed.

## State
- WBS 2.9 part 3 step 2 (QRT routing + `quarantine_decision`, D-211, migration 0047): one feat(2.9) commit on `lane/1-2.9-p3-s2`, non-draft PR opened; close review PASS(12 findings, 2 rounds). Migration PR → manual merge by the Master (D-179 order).
- S1 scenario 1 stays RED only on the integration lane's fixture: `tests/scenarios/S1.spec.ts:223-229` inserts GULF-0137 without `trackExpiry: true`; Decision 1 requires `track_expiry` → 2.18 (reported on #207).
- Lock `wms | 1 | 2.9` still held; the Master releases or re-scopes it at merge.

## Next
1. `2.9 part 6` (MASTER_BACKLOG): dedicated `BatchExpiryConflictError` → 422; `reverseMovement` runs the D-204 check (RED first).
2. `2.9 part 3 step 3`: deciding a `quarantine_decision` (release / return_to_client / destroy, escalation to WH_MGR on due time). Carry-overs from this slice's reviews: `pgeos_app` holds UPDATE on `platform.decisions`, so any PST session can close the item and lift the hold → guard + SoD (decider holds `assigned_role`, is not the receiver); after `release`, `confirmPutaway` must find a balance held in QRT (today it looks in RCV).

## Environment notes
- Lane DB pgeos_lane1: 0046 and 0047 applied by hand (psql -f; both rerunnable).
- Build before tests: `pnpm turbo run build --filter='@pg-eos/wms...'`; scenarios need `--filter='@pg-eos/scenarios^...'` and run from `tests/scenarios` (`npx playwright test <spec>`).
- Never run guards and module tests concurrently on the same lane DB (fixed-UUID fixtures collide).
- Commit with `PGDATABASE=pgeos_lane1 G16_MODULES=`; channel is #207 only (Arabic, ≤ 5 lines).
