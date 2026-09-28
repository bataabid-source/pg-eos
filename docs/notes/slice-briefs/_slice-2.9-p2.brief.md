# SLICE BRIEF — WBS 2.9 part 2 (fix) · the ledger writes `wms.stock_balance.expiry_date`

Task: 2.9 part 2 (fix) (MASTER_BACKLOG)      Lane: 1 (stream A, wave 1)      Lock: `wms` (whole module — see Default 1)
builder: pg-builder
Session: R4 (`pg-eos:lane-1`), branch `lane/1-2.9p2` (first command: `git fetch origin && git checkout -B lane/1-2.9p2 origin/main`), cloud lock worktree `cloud:session_<R4 id>`.
Model routing (ADR-0005 §5, D-174): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance (backlog row 2.9 part 2 (fix), verbatim)
"S1's FEFO step turns green; `stock_balance.expiry_date` populated for every received batch line"

## Facts (verified by the Master on main)
- `wms.stock_movements` carries `expiry_date` (01-Data-Model.sql:703) and `wms.stock_balance` has `expiry_date date` (01:717-730) — no schema change.
- `receive-line.ts:137` passes `expiryDate`; the receipt is posted through `modules/wms/infrastructure/receive-inbound/ledger.ts` → `postMovementInTx` (`modules/wms/src/stock-ledger/post-movement.ts:591`), whose balance upsert (`post-movement.ts:482`) inserts `(client_id, sku_id, location_id, batch_no, qty_on_hand, last_movement_at)` — no `expiry_date`; `rebuild-balance.ts:121` has the same gap.
- Balance key is `(client_id, sku_id, location_id, batch_no)`; the expiry belongs to the batch.

## Decisions (defaults — one CHANGELOG line each)
1. Lock `wms` (whole module), not `wms/receive-inbound`: the defect is in the module-wide `src/stock-ledger/`, which a use-case lock may not write (LANE_LOCKS rule 1).
2. The balance row takes the movement's `expiry_date` on insert; on conflict an existing non-null `expiry_date` is kept and a null one is filled (a batch has one expiry; a different non-null expiry for the same batch → STOP and report, never overwrite silently). `rebuild-balance.ts` derives it from the batch's movements the same way.
3. `PostMovementInput` gains the expiry only if it does not already carry it — reuse the existing field if present.

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/wms.brief.md`
- `modules/wms/src/stock-ledger/post-movement.ts` lines 60-100, 440-520, 585-660
- `modules/wms/src/stock-ledger/rebuild-balance.ts`
- `modules/wms/infrastructure/receive-inbound/ledger.ts`
- `modules/wms/application/receive-inbound/receive-line.ts` lines 120-180
- `database/schema/01-Data-Model.sql` lines 695-730
- `tests/scenarios/S1.spec.ts` lines 260-290, 335-380

Write ONLY: `modules/wms/src/stock-ledger/**` · `modules/wms/infrastructure/receive-inbound/**` · `modules/wms/application/receive-inbound/**` · `modules/wms/tests/**` · `tests/**` (pg-tester only). Frozen paths untouched.
Contract: none changed. Screen/Board spec: none.

## RED tests
`modules/wms/tests/receive-inbound/expiry-balance.feature` · `modules/wms/tests/receive-inbound/expiry-balance.test.ts` · `modules/wms/tests/integration/expiry-balance.property.test.ts`

```gherkin
Feature: The stock balance carries the batch expiry (WBS 2.9 part 2)
  Scenario: A received batch line with an expiry writes that expiry on its stock_balance row
  Scenario: A second receipt of the same batch keeps the recorded expiry and adds quantity
  Scenario: A receipt without expiry leaves expiry_date null; a later one with expiry fills it
  Scenario: A conflicting expiry for the same batch is refused, never overwritten silently
  Scenario: rebuild-balance reproduces the same expiry_date as the incremental path
```
Property test: for any generated sequence of receipts/transfers of one batch, `stock_balance.expiry_date` equals the batch's single expiry after incremental posting and after `rebuild-balance`.

Deliver: the edited `post-movement.ts` / `rebuild-balance.ts` (and `ledger.ts` only if the input must change) + the RED files; modules/wms tests + `pnpm guards:run` (G1 stays 0) green; S1's FEFO step result reported (green or the next named RED).
Migration number: none.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01).
