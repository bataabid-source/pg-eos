# SLICE BRIEF — WBS 2.9 part 3 step 2 · short-shelf-life receipt → zone QRT + `quarantine_decision` (S1 scenario 1, steps 3–4)

Task: 2.9 part 3, second step (MASTER_BACKLOG rows "S1 QRT routing" and "S1 quarantine_decision": doc 40 Part E S1 scenario 1 steps with no doc-38 row of their own — Master planning assignment M12, owner 2.9 part 3, lane 1)      Lane: 1      Lock: `wms | 1 | 2.9` (whole module → `modules/wms/**`; tasks/LANE_LOCKS.md, claimed 2026-09-30; lane 1 keeps `pda | 1 | 2.16` for its open 2.16 parts — two rows, different modules, ADR-0007 Decision 3)
builder: pg-builder
Session: lane 1 — branch `lane/1-2.9-p3-s2` (first command: `git fetch origin && git checkout -B lane/1-2.9-p3-s2 origin/main`); lane DB `bash scripts/lane-db.sh 1` (PGDATABASE=pgeos_lane1). No migration: every table and column below exists (01 / 13B / 019).
Model routing (ADR-0005 §5) and review steps exactly as CLAUDE.md BUILD METHOD and REVIEW are written: pg-tester sonnet (RED) → pg-reviewer opus (pre-build review of brief + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus (close review); REVIEW CAP round 1 → one fix round → round 2. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens (CLAUDE.md REVIEW). Tests per CLAUDE.md TESTING as written (property tests on every invariant — here the stock invariant "a short-shelf-life batch never lands outside a quarantine-zone location" and the one-decision-per-receipt invariant); no rule asserted twice across layers; S1 itself stays the integration lane's (2.18). The GM's test-scope directive on #207 (2026-09-30 05:22Z) applies to this slice only once CLAUDE.md TESTING carries it.
Golden slice = this use case (`modules/wms/**/receive-inbound`): extend it in place, no new tree.

## Acceptance
doc 40 lines 433-439 (verbatim S1 scenario 1): "Given client "GULF" has active PST contract with min receipt shelf life 180 days / And an approved inbound order for SKU "GULF-0137" / When the PDA receives batch "B2409-7" with expiry 120 days from today / Then the line is placed in zone QRT / And a decision item "quarantine_decision" is created for client contact within 48 h / And no stock_movement to a storage location exists for that batch".
tests/scenarios/S1.spec.ts:305-400 — the Given reads `wms.skus.min_remaining_life_receipt_days` (:318-321, fixture 180); the When calls `handleReceiveLine` with `expiryDate` 120 days after the scenario clock (:356-369); step 3 (:374-388) expects the `wms.stock_balance` row of (sku, batch) to sit in a location whose `wms.zones.code = 'QRT'`; step 4 (:390-400) expects one `platform.decisions` row with `kind = 'quarantine_decision' and source_table = 'wms.inbound_orders' and source_id = <order id>` and reads `created_at, due_at`. Today both fail with the `NOT BUILT` messages naming these rows.

## Facts (verified by the Master on main c0a59b5, 2026-09-30; re-verify at slice start)
- Receipt path: `modules/wms/application/receive-inbound/receive-line.ts:83-296` — step 7 (:198-217) posts the receipt movement to `deps.repo.pickRcvLocation(tx, order.warehouseId)` = the first unblocked operational location of a `zone_type = 'receiving'` zone (`modules/wms/infrastructure/receive-inbound/repository.ts:41` `RCV_ZONE_TYPE`, :375-391); `expiryDate` reaches the ledger as `expiryDate: input.expiryDate ?? null` (:211) and `occurredAt = deps.clock.now()` (:158). The SKU row is not read today (only `line.skuId`, ports.ts:65-75).
- Zones: `wms.zones` 01 (`code`, `zone_type` storage · receiving · quarantine · staging · shipping · returns · damaged; CHECK 13B:3564); WH1 seed 019:99 `('QRT','الحجر','quarantine')`, 019:290 four operational locations `QRT-1…QRT-4`. `wms.locations.location_type = 'operational'` for them (repository.ts:379-380 pattern).
- SKU rule columns: `wms.skus` 01:650-690 — `track_expiry boolean` (:674), `min_remaining_life_receipt_days int` (:677), `quarantine_days int default 0` (:679); `client_id` (:652). The contract carries no per-contract minimum in 01 / 13 / 13B — the S1 Given itself asserts the SKU column (S1.spec.ts:318-321), so the SKU column is the rule's source (Decision 1).
- Date rule precedent: `modules/fleet/domain/register-vehicle/invariants.ts:27,63-80` — calendar-date comparison in `BUSINESS_TIME_ZONE = 'Asia/Kuwait'`, strict `<`; the clock is injected (`deps.clock.now()`), never `new Date()` in domain/.
- Decision item: `platform.decisions` 13B:440-456 — `entity_id`, `kind text not null`, `title_ar text not null`, `context jsonb not null` ("الوقائع المحسوبة — لا نص حر"), `urgency` default 'normal', `source_table`, `source_id`, `assigned_role text not null`, `status` default 'open', `due_at timestamptz`. Insert precedent: `modules/billing/infrastructure/accounting-periods/repository.ts:320-343` (`assigned_role` read from `platform.approval_chains` by `request_type`); 13B:3938-3947 seeds NO `quarantine_decision` chain row (Decision 3).
- Put-away: `modules/wms/application/receive-inbound/confirm-putaway.ts:38-136` moves the RCV balance to the chosen storage location; `suggest-location.ts` ranks storage candidates (repository.ts:440-462, `location_type in ('pallet','shelf')`).

## Decisions (defaults — one CHANGELOG line each)
1. Rule (domain, `modules/wms/domain/receive-inbound/invariants.ts`): `isShortShelfLifeReceipt({ expiryDate, today, minRemainingLifeReceiptDays })` — true iff the SKU has `track_expiry`, a non-null `min_remaining_life_receipt_days` and `expiryDate − today (Asia/Kuwait calendar days) < min_remaining_life_receipt_days`; `today` comes from `deps.clock`. No expiry or no minimum → not short (unchanged behaviour). One SKU read added to the repository port (`getSkuShelfLifeRule(tx, skuId)` → `{ trackExpiry, minRemainingLifeReceiptDays }`).
2. Routing: in step 7 the receipt's `toLocationId` is `pickQrtLocation(tx, warehouseId)` (first unblocked operational location of a `zone_type = 'quarantine'` zone, the exact mirror of `pickRcvLocation`) when Decision 1 is true, else `pickRcvLocation` as today. The ledger call, GRN, `wms.inbound.received` and audit rows are unchanged. The order-line row is not changed (no new status: the line's location stays null until put-away, as today).
3. Decision item, same transaction as the movement: one `platform.decisions` row — `entity_id = order.entityId`, `kind 'quarantine_decision'`, `title_ar` from a named constant in `modules/wms/infrastructure/receive-inbound/repository.ts` (Arabic, the doc-40 step wording «قرار حجر — تواصل مع العميل»; a DB constant, not UI text), `context = { orderId, lineId, skuId, batchNo, expiryDate, minRemainingLifeReceiptDays, remainingDays, qty }` (computed facts only), `source_table 'wms.inbound_orders'`, `source_id = orderId`, `assigned_role 'WH_MGR'` (doc 38 owner of 2.9; no `platform.approval_chains` row exists for this kind — recorded as an open G-01 question, never a seed insert by the lane), `status 'open'`, `due_at = occurredAt + QUARANTINE_DECISION_DUE_HOURS` with `QUARANTINE_DECISION_DUE_HOURS = 48` (doc 40 line 438 verbatim "within 48 h" — a named constant citing the line; the GM may move it to `platform.thresholds` later). Exactly one row per (order, line): a replay under the same Idempotency-Key writes none (the existing idempotency of `receiveLine`).
4. Step 4 protection: `confirmPutaway` refuses (typed 422 `QuarantineDecisionOpenError`, `errors.ts`) a line whose batch sits in a quarantine-zone location while its `quarantine_decision` is `open` — so no stock movement to a storage location exists for that batch until the decision is decided. Deciding the item (release · return · destroy) is NOT this slice: row `2.9 part 3 step 3` (GM decision: outcomes and roles — doc 40 has no step text for it).
5. PDA: no screen change. The PDA receive screen (2.16) shows the server's location code; a QRT code needs no new i18n key.

## Read ONLY (workers)
- `.claude/briefs/wms.brief.md`
- `modules/wms/application/receive-inbound/receive-line.ts` lines 60-240
- `modules/wms/application/receive-inbound/confirm-putaway.ts`
- `modules/wms/application/receive-inbound/ports.ts` lines 40-80, 128-200
- `modules/wms/infrastructure/receive-inbound/repository.ts` lines 30-60, 370-410
- `modules/billing/infrastructure/accounting-periods/repository.ts` lines 318-345
- `database/schema/13B-Schema-Reference-Consolidation.sql` lines 440-456
- `tests/scenarios/S1.spec.ts` lines 305-400

Write ONLY: `modules/wms/{domain,application,infrastructure,api}/receive-inbound/**` (pg-tester only under `modules/wms/tests/receive-inbound/**`). Never `tests/scenarios/*` (2.18), `apps/pda/*` (own `pda` lock, other slice), `packages/*`.
Contract: `packages/contracts/wms/receive-inbound.ts` unchanged (ReceiveLine already carries `expiryDate`; no new field). Screen/Board spec: none.

## RED tests
`modules/wms/tests/receive-inbound/quarantine.feature` · `shelf-life-rule.unit.test.ts` (Decision 1 cases: below / equal / above the minimum, no minimum, no expiry, `track_expiry` false — ordinary unit tests) · `quarantine-routing.property.test.ts` (fast-check, stock invariant: for any short receipt the balance location's zone_type is 'quarantine') · `quarantine.test.ts` (integration, lane DB: the S1 queries verbatim for steps 3–4 incl. `due_at = occurred_at + 48 h`; a receipt above the minimum lands in RCV and writes no decision; replay writes one decision; `confirmPutaway` on the quarantined line → 422 while open).

```gherkin
Feature: Short-shelf-life receipt is quarantined (WBS 2.9 part 3 step 2, doc 40 S1 scenario 1)
  Scenario: A receipt whose remaining life in Asia/Kuwait calendar days is below the SKU's min receipt shelf life lands on a QRT-zone operational location and writes one open quarantine_decision (source wms.inbound_orders, due in 48 h) in the same transaction
  Scenario: A receipt at or above the minimum, or of a SKU without track_expiry or without a minimum, lands in RCV as today and writes no decision
  Scenario: A replay of the receipt under the same Idempotency-Key writes no second decision and no second movement
  Scenario: ConfirmPutaway of a quarantined line is refused with 422 while its decision is open
  Scenario: The receipt's GRN, wms.inbound.received event and audit rows are unchanged by the routing
```

Deliver: `invariants.ts` (rule) · `errors.ts` (`QuarantineDecisionOpenError`) · `ports.ts` + `repository.ts` (`getSkuShelfLifeRule`, `pickQrtLocation`, `insertQuarantineDecision`, `hasOpenQuarantineDecision`) · `receive-line.ts` step 7 branch · `confirm-putaway.ts` guard · the RED files above green · CHANGELOG entry (scribe template) · this brief deleted in the commit · closing report to the Master on #207 (2.18 re-runs S1 scenario 1; row `2.9 part 3 step 3`).
Migration number: none.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01; the quarantine outcome flow is Decision 4's next row, not this slice); the lane DB has no `quarantine`-zone operational location (seed 019:290) — STOP and report; a needed file outside `modules/wms` — STOP and report.
