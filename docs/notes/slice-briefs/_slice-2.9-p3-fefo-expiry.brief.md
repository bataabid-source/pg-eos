# SLICE BRIEF — WBS 2.9 part 3 · the ledger writes the batch expiry on `wms.stock_balance` (the FEFO step of S1)

Task: 2.9 part 3 (MASTER_BACKLOG)      Lane: 1, second session (stream A — GM (a) 2026-09-29 08:25Z via Advisory, issue #207, cap six D-198)      lock: TBD — claimed by the Master after X part 17 (two sessions in lane 1) or after 2.16 part 2 closes; `wms` module scope needed for post-movement.ts (GM to confirm vs directive (a) wms/receive-inbound)
builder: pg-builder
Gate (#210 round 1, F1): the session starts only after X part 17 lands the D-198 cap-six / two-sessions-in-lane-1 wording in CLAUDE.md and lane-guard; until then 2.9 part 3 queues behind 2.16 part 2 in the single lane-1 session.
Session: lane 1 second session, branch `lane/1-2.9-p3` (first command: `git fetch origin && git checkout -B lane/1-2.9-p3 origin/main`) — the fresh "-r5" rebuild of PR #185, which the Master closes as superseded when this PR opens; the Master sets the lock's worktree cell to `cloud:session_<id>` when the session starts.
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds — ONE confirmed review round for the fixes carried over from #185 (backlog item 2), no de facto round 3.

## Acceptance
Backlog row 2.9 part 3 (verbatim): "S1's FEFO step green; same-batch different-expiry refused at any location; trailer matches the review verdict; one confirmed review round" — the "same-batch different-expiry refused" clause applies only once its rule is sourced (Step 0); until then it is an open item and is not built.
doc 38 row 2.9 (verbatim): "GOLDEN SLICE — Receive inbound order (PDA + state machine + ledger + event + GRN + billable events)" — row stays ACCEPTED; this part is a defect fix.
doc 40 Part E S1, scenario 2 (verbatim): "Given available stock of "GULF-0137" in two batches with expiries 90 and 200 days / When an outbound order for 12 units is approved / Then allocation takes 12 units from the 90-day batch".

## Facts (verified by the Master on main 3338da2; re-verify against the current main at slice start)
- `wms.stock_movements` carries `expiry_date` (01-Data-Model.sql:705) and `wms.stock_balance` has `expiry_date date` (01:719-732) — no schema change.
- `receive-line.ts:137` passes `expiryDate`; the receipt posts through `postMovementInTx` (`modules/wms/src/stock-ledger/post-movement.ts:591`), whose balance insert (`post-movement.ts:482`) writes `(client_id, sku_id, location_id, batch_no, qty_on_hand, last_movement_at)` — no `expiry_date`. None of #185's fix is on main.
- `tests/scenarios/S1.spec.ts:341-540`: with null expiries, outbound allocation orders lots by `location_id`, not FEFO, so "allocation takes 12 units from the 90-day batch" is RED; filling the expiry is what turns it green (allocation code is not touched).
- #185 findings carried here (backlog items 1–4): trailer states the real verdict · one confirmed round for `resolveBatchExpiry` + three refusal-path tests · the expiry conflict was detected per balance row only (#185 `post-movement.ts:513`), so another location's balance of the same batch was not checked · #185 spent ≈ 760k tokens vs 150k.

## Step 0 (first step of the slice, before RED)
Find "a batch has one expiry" in doc 01 / 13 / 13B / 019 / 40 (cite file:line in the CHANGELOG), or file `docs/notes/SCR-WMS-BATCH-EXPIRY-01.md` and build without the refusal (Decision 2b, scenarios 4–5 dropped). Never invent it.

## Decisions (defaults — one CHANGELOG line each)
1. Split (backlog item 4): this part = the incremental ledger path only; `rebuild-balance.ts:121` parity is `2.9 part 4` (waits on this part), not built here.
2. (a) The balance row takes the movement's `expiry_date` on insert; an existing non-null expiry is kept, a null one filled. (b) Only if Step 0 sources the rule: a different non-null expiry for the same (client, SKU, batch) at ANY location is refused with an existing ledger error, never overwritten.
3. The commit's `Review:` trailer copies the close verdict verbatim (backlog item 1); the ≈ 760k overrun of #185 is one CHANGELOG line.

## Open items
- Rule source (G-01): "a batch has one expiry" is #185 brief Decision 2 (a Master default), not yet found in 01 / 13 / 13B / 019 / 40 — Step 0 resolves it or files the SCR; the refusal is not built until sourced.
- Lock: `wms` module scope is needed because the fix is in module-wide `modules/wms/src/stock-ledger/` (LANE_LOCKS rule 1); GM to confirm against directive (a) `wms/receive-inbound` — `X part 19`.

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/wms.brief.md`
- `modules/wms/src/stock-ledger/post-movement.ts` lines 60-100, 440-512, 585-660
- `modules/wms/src/stock-ledger/errors.ts`
- `modules/wms/infrastructure/receive-inbound/ledger.ts`
- `modules/wms/application/receive-inbound/receive-line.ts` lines 120-180
- `database/schema/01-Data-Model.sql` lines 700-732
- `tests/scenarios/S1.spec.ts` lines 341-380, 520-540

Write ONLY: `modules/wms/src/stock-ledger/post-movement.ts` · `modules/wms/src/stock-ledger/errors.ts` (only if Step 0 sources the refusal and no existing error fits) · `docs/notes/SCR-WMS-BATCH-EXPIRY-01.md` (Step 0 only) · `modules/wms/infrastructure/receive-inbound/**` · `modules/wms/application/receive-inbound/**` · `modules/wms/tests/receive-inbound/**` (pg-tester only; `tests/scenarios/**` belongs to the integration lane, 2.18). Frozen paths untouched.
Contract: none changed. Screen/Board spec: none.

## RED tests
`modules/wms/tests/receive-inbound/expiry-balance.feature` · `modules/wms/tests/receive-inbound/expiry-balance.test.ts` · `modules/wms/tests/receive-inbound/expiry-balance.property.test.ts`

```gherkin
Feature: The stock balance carries the batch expiry (WBS 2.9 part 3)
  Scenario: A received batch line with an expiry writes that expiry on its stock_balance row
  Scenario: A second receipt of the same batch keeps the recorded expiry and adds quantity
  Scenario: A receipt without expiry leaves expiry_date null; a later one with expiry fills it
  Scenario: A different expiry for the same batch is refused at the same location (only if Step 0 sources the rule)
  Scenario: A different expiry for the same batch is refused at another location (only if Step 0 sources the rule)
```
Property test: for any generated sequence of receipts of one batch with one expiry across locations, every `stock_balance` row of that batch carries that expiry (the conflict half only if Step 0 sources the rule).

Deliver: edited ledger path + RED files; `modules/wms` tests + `pnpm guards:run` (G1 stays 0) green; S1's FEFO step result reported (green, or the next named RED) to the integration lane (2.18).
Migration number: none. The slice's commit deletes this brief and the superseded `docs/notes/slice-briefs/_slice-2.9-p2.brief.md` (and the SCR only if it applies it).

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01); a needed file outside the lock — STOP and report.
