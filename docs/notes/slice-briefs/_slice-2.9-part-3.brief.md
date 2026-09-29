# SLICE BRIEF — WBS 2.9 part 3 · PR #185's four open findings (batch expiry, one per batch at any location)

Task: 2.9 part 3 (MASTER_BACKLOG)      Lane: 1 (stream A, wave 1)      Lock: `wms` requested (the row names `wms/receive-inbound` — see Decision 1)
builder: pg-builder
Session: lane 1 successor of R4 (`pg-eos:lane-1`), branch `lane/1-2.9-part-3-r5` (first command: `git fetch origin && git checkout -B lane/1-2.9-part-3-r5 origin/main`). Brief drafted by the lane at the Master's request (M8, 2026-09-29 05:40Z, D-200 queue).
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance (backlog row 2.9 part 3, verbatim)
"S1's FEFO step green; same-batch different-expiry refused at any location; trailer matches the review verdict; one confirmed review round"

## Facts (verified on origin/lane/1-2.9p2-r4 = PR #185 head 593999f, 2026-09-29)
- #185 is one commit, 22 files, +1424/−89; `mergeable_state` dirty against main. Its code is the base of this slice: `PostMovementInput.expiryDate`, pure `resolveBatchExpiry` (`src/stock-ledger/domain.ts:265-292`), `ConflictingExpiryError` (`errors.ts`), 422 mapping (`api/receive-inbound/handlers.ts`).
- Finding 3, incremental path: `applyLockedBalanceDelta` (`post-movement.ts:475-537`) compares the offered expiry with the ONE balance row it updates (key `(client_id, sku_id, location_id, batch_no)`), under the per-key lock `lockBalanceRow` (`:206`). A second location of the same batch is never consulted.
- Finding 3, rebuild path: `rebuild-balance.ts:101-124` folds `group by location, batch` and refuses only when min ≠ max expiry inside one location.
- Finding 1: #185's trailer `Review: PASS(25 findings, 2 rounds)` against pre-build FAIL(13), close round 2 FAIL(8), PR-level FAIL(4).
- Finding 4: ≈760k tokens against 150k.
- No table, column, contract or migration involved (`wms.stock_balance.expiry_date` and `wms.stock_movements.expiry_date` exist, 01-Data-Model).

## Decisions (defaults — one CHANGELOG line each)
1. Lock `wms` (whole module), as for 2.9 part 2: finding 3's fix is in module-wide `src/stock-ledger/`, which a `wms/receive-inbound` lock may not write (LANE_LOCKS rule 1). If the Master keeps `wms/receive-inbound`, the slice STOPS at the pre-build review and reports.
2. Base = #185's tree, restored without re-reading it: `git checkout 593999f -- modules/wms tests/scenarios/S1.spec.ts` (never its docs/state files; never its commit message). Main's changes to those paths since 4a771a1 win on conflict; the builder reports any overlap.
3. One expiry per `(client_id, sku_id, batch_no)` across every location. Incremental: before the upsert, take `pg_advisory_xact_lock(hashtextextended('batch-expiry:'||client||':'||sku||':'||batch, 0))`, then read the distinct non-null `expiry_date` of that batch's other balance rows; `resolveBatchExpiry(recorded, offered)` decides; `conflict` → `ConflictingExpiryError` (existing 422 path). The batch lock is taken BEFORE the per-key balance locks, in sorted order for a transfer (same deadlock rule as `lockBalanceRow`).
4. Rebuild: the refusal is computed per `(batch)` over all locations (`min`/`max` of `expiry_date` grouped by batch), before the delete — nothing written on conflict.
5. An empty `batch_no` ('' = no batch) is exempt from Decision 3 (no batch identity to share an expiry).
6. Finding 1: the `feat(2.9)` commit's `Review:` trailer is the close review's own final verdict and count, nothing added or softened; the body lists every round.
7. Finding 2: exactly one confirmed review round is spent on the restored #185 fixes plus Decision 3–5 (pre-build + close per REVIEW CAP; no third round).
8. Finding 4: recorded in the CHANGELOG entry (≈760k/150k on 2.9 part 2). This slice rebuilds nothing already built (Decision 2); if pre-build review estimates > 150k, the rebuild half (Decision 4) splits to `2.9 part 4` before RED.
9. #185 is closed as superseded when this slice's PR opens.

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/wms.brief.md`
- `modules/wms/src/stock-ledger/post-movement.ts` lines 184-240, 470-550, 700-760
- `modules/wms/src/stock-ledger/rebuild-balance.ts` lines 60-134
- `modules/wms/src/stock-ledger/domain.ts` lines 240-263
- `modules/wms/src/stock-ledger/errors.ts`
- `modules/wms/api/receive-inbound/handlers.ts` lines 200-270
- `database/schema/01-Data-Model.sql` lines 695-730

Write ONLY: `modules/wms/src/stock-ledger/**` · `modules/wms/api/receive-inbound/**` · `modules/wms/application/receive-inbound/**` · `modules/wms/infrastructure/receive-inbound/**` · `modules/wms/tests/**` · `tests/scenarios/S1.spec.ts` (tests: pg-tester only). Frozen paths untouched.
Contract: none changed. Screen/Board spec: none. Migration number: none.

## RED tests
`modules/wms/tests/receive-inbound/batch-expiry-any-location.feature` · `modules/wms/tests/receive-inbound/batch-expiry-any-location.test.ts` · `modules/wms/tests/integration/batch-expiry-any-location.property.test.ts`

```gherkin
Feature: A batch has one expiry at every location (WBS 2.9 part 3)
  Scenario: A receipt of batch B at location L2 with a different expiry than B at L1 is refused (422), nothing written
  Scenario: A put-away transfer of batch B into a location holding B with another expiry is refused
  Scenario: A receipt of batch B at L2 with the same expiry as L1 is accepted and adds quantity
  Scenario: A receipt without expiry at L2 takes no expiry and is not refused
  Scenario: Two concurrent receipts of B at L1 and L2 with different expiries — exactly one commits
  Scenario: rebuild-balance refuses a batch whose movements carry two expiries at two locations
  Scenario: Lines without a batch number are never refused on expiry
```
Property test: for any generated sequence of receipts/transfers of one batch over ≥ 2 locations, every `stock_balance` row of the batch has the same non-null expiry or the posting that would break it was refused; rebuild agrees with the incremental path.

Deliver: the restored #185 tree + the edited `post-movement.ts` / `rebuild-balance.ts` + the RED files; `pnpm --filter @pg-eos/wms test`, typecheck, eslint green; `G16_MODULES=wms pnpm guards:run` (G1 = 0); S1's FEFO step green (tests/scenarios/S1.spec.ts).

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01).
