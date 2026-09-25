# SLICE BRIEF — WBS 2.13 (lane 2 → pg-tester → pg-backend)

Task: 2.13 "Inventory count: blind, recount mandatory, adjustment by approval"      Lane: 2      Lock: `wms` (LANE_LOCKS row `wms | 2 | 2.13`).
Acceptance (doc 38): **System qty invisible to counter.**   Owner: WH_MGR.   Depends: 2.8 (DONE — the shared stock-ledger mechanism this slice reuses).

Read ONLY:
- `CLAUDE.md`
- `.claude/briefs/wms.brief.md`
- golden slice (shape + the EXACT ledger-reuse pattern to replicate, not just shape): `modules/wms/application/receive-inbound/ports.ts` (the `LedgerPort` interface, ~line 197-230) · `modules/wms/infrastructure/receive-inbound/ledger.ts` (the ONE file that imports `../../src/stock-ledger` — REPLACE-ON-COPY) · `modules/wms/domain/receive-inbound/errors.ts` (shape only)
- `modules/wms/src/stock-ledger/index.ts` (the public surface: `postMovementInTx`, `MOVEMENT_TYPES` includes `'adjust'`, `LedgerEntry`, `NegativeStockError` etc.) — this slice calls `postMovementInTx` for every stock adjustment, never re-implements ledger posting.
- `modules/hr/application/register-employee/{change-employee-status.ts,ports.ts}` (nearest precedent for an audit-only state transition with no outbox event of its own — WBS 3.3's `ChangeEmployeeStatus`)
- `modules/platform/api/maintain-site/handlers.ts` (Problem envelope / Idempotency-Key / role-gate shape to replicate)
- `docs/package/40-Build-Specification-EN.md` line 250 (INV-C3-7, quoted verbatim below) and line 260 (the four named commands, quoted below) — do not re-read the document
- schema: `database/schema/01-Data-Model.sql` lines 798-823 (`wms.inventory_counts`, `wms.inventory_count_lines`, already exist — no new tables) · `database/migrations/0018_2_inventory-counts-version.sql` (the only schema change this slice needed, already applied and verified) · `chk_inventory_counts_status` (13B:2333-2335, six values)
- `packages/contracts/hr/maintain-shift.ts` (contract shape precedent: multiple commands over one aggregate family, optional/required field conventions)
- Scaffold already run: `scripts/new-slice.sh wms count-inventory` (files listed under Deliver; renamed copies of the golden slice, logic to be replaced)

Write ONLY: `modules/wms/{domain,application,infrastructure,api}/count-inventory/**` (do not touch `receive-inbound/**`, the golden slice, except to READ it) · `packages/contracts/wms/count-inventory.ts` · `tests/**`.
No migration to write in this slice — `database/migrations/0018_2_inventory-counts-version.sql` is already written, reviewed and applied. Do not edit it.
pg-tester writes ONLY test files (`modules/wms/tests/count-inventory/**`, `*.feature`). pg-backend never edits a test.

## Facts (verified by the lane against the schema and the package — quote, do not re-derive)

- `wms.inventory_counts` columns: `id, entity_id, doc_no, warehouse_id, client_id (nullable — a count can span multiple clients' SKUs in a warehouse), count_type (full · cycle · spot, no DB CHECK — free text per 01:804's own comment), status (6-value CHECK: draft · in_progress · review · recount · adjusted · closed), started_at, finished_at, counted_by, approved_by, version (migration 0018)`. RLS `entity_scope`.
- `wms.inventory_count_lines` columns: `id, count_id (FK cascade), location_id, sku_id, batch_no, qty_system (NOT NULL — the frozen snapshot, INV-C3-7's "system quantity"), qty_counted (nullable — filled by CountLocation), variance (GENERATED ALWAYS AS qty_counted - qty_system, nullable until counted), recount_qty (nullable — filled by Recount), variance_reason (nullable), adjusted_movement_id (nullable, FK to the stock_movements row AdjustCount posts)`. **No `entity_id` column** — RLS on this table is `internal_only` (the 13B blanket-loop default for a table with no `entity_id`; same known gap `wms.order_lines` has, accepted at 2.9). **The application layer must reach a line only through a join to its parent `wms.inventory_counts` row, inside `withContext`, never by `id` alone** — this is how entity scoping is enforced for this child table.
- doc 40 INV-C3-7 (verbatim): "Count is blind: counter never sees system quantity; recount mandatory on variance; adjustment = `adjust` movement approved by WH_MGR."
- doc 40 line 260 names exactly these commands for this scope: `StartCount`, `CountLocation`, `Recount`, `AdjustCount` (the fifth named command in that line, `TakeOccupancySnapshot`, is WBS **2.14, NOT this slice**).
- `wms.stock_movements.movement_type` CHECK (13B, copied verbatim into `modules/wms/src/stock-ledger/domain.ts`'s `MOVEMENT_TYPES`) already includes `'adjust'` — no schema change needed for the adjustment posting itself.
- `postMovementInTx(tx, { entityId, entry: { clientId, skuId, fromLocationId, toLocationId, qty: Quantity, batchNo, movementType, uom }, correlationId, performedBy, refTable, refId }, actorId, deps)` — single-sided (`decision 1`): exactly one of `fromLocationId`/`toLocationId` set, `qty` always positive. Inserts `wms.stock_movements`, upserts `wms.stock_balance`, writes the `wms.stock.moved` outbox event, writes the audit row — ALL already handled by this one call, in the SAME transaction as whatever else the caller does with `tx`. **No new event catalog entry needed for this slice** — `wms.stock.moved` already exists and already covers every stock-affecting write, including adjustments.
- `skus.client_id` is `NOT NULL` (every SKU is client-owned) — when posting an adjustment for a line, the `clientId` `postMovementInTx` needs comes from the line's own `sku_id -> skus.client_id` join, NEVER from `inventory_counts.client_id` (which is nullable and may not even match, since one count can span several clients' SKUs in the same warehouse).
- Roles (13B:556-572): `WH_MGR` (entity-scope), `WH_SUP` (org_unit), `WH_OP` (self — "the counter" INV-C3-7 refers to).
- Entity resolution is fail-closed (established precedent across every prior slice this session): `cardinality(platform.allowed_entities()) = 1` else `EntityScopeAmbiguousError` 422.
- `writeOutboxEvent`/`writeAuditRow` pattern for this slice's OWN state changes (StartCount's draft->in_progress, the auto-transitions to review, AdjustCount's review->adjusted): **audit row only, no outbox event of the count's own** (D8 below) — the golden-slice precedent for this exact shape is 3.3's `ChangeEmployeeStatus`, which writes an audit_log row and no event because the state transition itself has no cross-module business meaning; the cross-module-meaningful event here is `wms.stock.moved`, already fired per adjustment by `postMovementInTx`.

## Defaults taken by the lane (CHANGELOG lines; batched to the GM in the closing report)

D1. XState machine for `inventory_counts.status` over the six `chk_inventory_counts_status` values: `draft -> in_progress` (StartCount) · `in_progress -> review` (auto, when every line in the count has `qty_counted IS NOT NULL` — no separate "submit for review" command exists in doc 40's named list) · `review -> recount` (auto, when `Recount` is first called on a count with at least one variant line — see D3) · `recount -> review` (auto, when every variant line now has `recount_qty IS NOT NULL`) · `review -> adjusted` (AdjustCount). `closed` has **no edge into it from any of the four named commands** — doc 40 names no fifth "CloseCount" command and doc 38's acceptance line doesn't require one; `closed` is out of scope for this slice (a manual/administrative action, or a later slice, batched GM question below). No edge reaches `closed`; the machine simply has no transition defined for it.
D2. **Blind count enforced at the contract/response layer, not just RLS** (INV-C3-7's actual mechanism, since RLS cannot hide one column of a visible row): `CountLocationResult`/`RecountResult` response schemas in the contract carry ONLY `{ lineId, recorded: true }` — never `qtySystem`, `variance`, or `recountQty`. The read side (whatever later slice builds a counter-facing screen) must use a narrower query/view than the WH_MGR-facing one; this slice's own commands simply never RETURN the hidden fields to a `CountLocation`/`Recount` caller (they still exist in the DB row, read by `AdjustCount` internally).
D3. **Concurrency default (reviewer's flagged open question, resolved here):** `CountLocation` and `Recount` do NOT take a caller-supplied `expectedVersion` — each is a per-line write, guarded by the line's own state (`AlreadyCountedError` if `qty_counted` is already set; `NotFlaggedForRecountError` if the line has no variance or `recount_qty` is already set), serialized by a `SELECT ... FOR UPDATE` on the PARENT count row (never a client-visible version check) so two counters working different locations of the same count never conflict with each other. Only `StartCount` and `AdjustCount` — the two commands a human explicitly re-invokes after reading the count's current state — require `expectedVersion`. The auto-transitions (`in_progress->review`, `recount->review`) happen inside the same locked transaction as the line write that triggers them and bump `version` themselves; the caller never supplies a version for those.
D4. Roles: `StartCount` → `WH_MGR` or `WH_SUP` (initiating a count is supervisory). `CountLocation` / `Recount` → `WH_OP`, `WH_SUP`, or `WH_MGR` (any warehouse worker counts). `AdjustCount` → `WH_MGR` ONLY (INV-C3-7 states this explicitly — "approved by WH_MGR", no OR).
D5. `AdjustCount` iterates every line where the FINAL counted quantity (`recount_qty ?? qty_counted`) differs from `qty_system`; for each, calls `postMovementInTx` with `movementType: 'adjust'`, `qty: Quantity.of(abs(diff))`, and exactly one of `fromLocationId`/`toLocationId` = the line's `location_id` (a shortfall — counted < system — is an outflow, `fromLocationId` set; a surplus is an inflow, `toLocationId` set), `refTable: 'wms.inventory_count_lines'`, `refId: line.id`; then sets `line.adjusted_movement_id` to the posted movement's id. A line with zero variance is skipped (no movement posted for it).
D6. `StartCount` snapshots `qty_system` for every `(location_id, sku_id, batch_no)` combination currently holding stock in the target warehouse (`wms.stock_balance` where `qty_on_hand <> 0`, scoped to the warehouse via its locations) into new `wms.inventory_count_lines` rows — this is the "frozen system snapshot" doc 40:387 describes. `count_type` (`full · cycle · spot`) determines the FILTER on which locations/SKUs get a line: `full` = every location in the warehouse; `cycle`/`spot` require a caller-supplied location/SKU filter (contract field `locationIds`/`skuIds`, optional, required together when `count_type != 'full'` — domain-validated).
D7. `assigned_by`/`counted_by`/`approved_by` = `ctx.userId`, never caller-supplied (same convention as every prior slice this session).
D8. No new outbox event for the count's own status transitions (Facts above) — only `wms.stock.moved`, already catalogued, fires per `AdjustCount`-posted movement. Every count-level state change still gets an audit_log row (G9's general rule, independent of whether an outbox event accompanies it).

## Scenario (Gherkin — pg-tester pastes into `modules/wms/tests/count-inventory/count-inventory.feature`)

```gherkin
Feature: Inventory count — blind, recount mandatory, adjustment by approval (WBS 2.13, INV-C3-7)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId
    And an existing wms.warehouses row with locations holding non-zero wms.stock_balance

  Scenario: Start a full count
    Given the caller holds role "WH_MGR"
    When StartCount is called with warehouseId, count_type "full"
    Then one wms.inventory_counts row exists with status "in_progress", version 1
    And one wms.inventory_count_lines row exists per (location, sku, batch) with non-zero stock, each with qty_system frozen and qty_counted null

  Scenario: A counter records a count without seeing the system quantity
    Given a count in progress with an uncounted line
    When CountLocation is called with lineId and qtyCounted
    Then the response carries no qtySystem, variance, or recountQty field
    And the line's qty_counted is set

  Scenario: Counting the same location twice is rejected
    Given a line that has already been counted
    When CountLocation is called again for the same lineId
    Then AlreadyCountedError (422) and the line is unchanged

  Scenario: Completing every line moves the count to review
    Given a count with exactly one uncounted line
    When CountLocation is called for that last line
    Then the count's status becomes "review" and its version increments

  Scenario: A variant line requires a mandatory recount (two variant lines, so "recount" is observed)
    Given a count in "review" with TWO lines whose qty_counted differs from qty_system
    When Recount is called for the first of them with a recountQty
    Then the count's status becomes "recount" (the second variant line is still awaiting its recount)
    And the response carries no qtySystem, variance, or the original qtyCounted

  Scenario: Recounting the LAST variant line returns the count directly to review
    Given a count with exactly ONE line whose qty_counted differs from qty_system (no other variant line pending)
    When Recount is called for that line with a recountQty
    Then the count's status becomes "review" — NOT "recount" — in the same call (both FLAG_RECOUNT and RECOUNT_COMPLETE fire together; version increments by one)
    And a platform.audit_log row is written for the count even though its status ends where it started (review -> recount -> review nets to the same value, but the row still changed and must still be audited)

  Scenario: Recounting a line with no variance is rejected
    Given a count in "review" with a line whose qty_counted equals qty_system
    When Recount is called for that line
    Then NotFlaggedForRecountError (422)

  Scenario: All variant lines recounted returns the count to review
    Given a count in "recount" with exactly one line still awaiting its recount
    When Recount is called for that line
    Then the count's status becomes "review" again

  Scenario: Adjusting before every variant line is recounted is rejected (INV-C3-7's "recount mandatory")
    Given a count in "review" with a line whose qty_counted differs from qty_system and recount_qty still null
    When AdjustCount is called
    Then RecountRequiredError (422) and no stock_movements row is posted

  Scenario: Starting a count on a warehouse with no matching stock lands directly in review
    Given a warehouse with zero non-zero wms.stock_balance rows
    When StartCount is called for that warehouse
    Then the count's status becomes "review" directly (not stuck in "in_progress" with zero lines) — START and COMPLETE fire together

  Scenario: Adjustment posts a stock movement and closes the gap
    Given a count in "review" with a line whose final quantity (recount_qty or qty_counted) is less than qty_system
    When AdjustCount is called by a caller holding role "WH_MGR" with expectedVersion matching
    Then the count's status becomes "adjusted", version increments
    And exactly one wms.stock_movements row exists for that line with movement_type "adjust", correct qty and direction
    And wms.stock_balance for that (client, sku, location, batch) reflects the adjustment
    And the line's adjusted_movement_id is set

  Scenario: A line with zero final variance is not adjusted
    Given a count in "review" where every line's final quantity equals qty_system
    When AdjustCount is called
    Then the count's status becomes "adjusted" and no wms.stock_movements row is posted

  Scenario: AdjustCount by a non-WH_MGR is rejected
    Given the caller holds only role "WH_SUP"
    When AdjustCount is called
    Then RoleRequiredError (422) and nothing is written

  Scenario: AdjustCount before review is rejected
    Given a count still "in_progress"
    When AdjustCount is called
    Then IllegalTransitionError (422)

  Scenario: A mismatched expectedVersion on AdjustCount is rejected
    Given a count whose current version does not equal the caller's expectedVersion (older OR newer than the row's actual version — StaleVersionError fires on any mismatch, not only a stale/older one)
    When AdjustCount is called with that mismatched expectedVersion
    Then StaleVersionError (409) and no column is written

  Scenario: Role gates on StartCount
    Given the caller holds only role "WH_OP"
    When StartCount is called
    Then RoleRequiredError (422) and nothing is written

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When StartCount is called twice with K and the same body
    Then one count exists and the second call returns the first result
```

Property tests (fast-check, `invariants.property.test.ts`):
- P1 for any `(qtyCounted, qtySystem)` pair: `hasVariance(qtyCounted, qtySystem) ⇔ qtyCounted ≠ qtySystem`.
- P2 for any final quantity and `qtySystem`: `adjustmentDirection(final, qtySystem)` returns `'inflow'` when `final > qtySystem`, `'outflow'` when `final < qtySystem`, and `null` (no movement) when equal — and the magnitude is always `abs(final - qtySystem)`.
- P3 for any set of lines with a `qtyCounted` flag per line: `isCountComplete(lines) ⇔` every line has `qtyCounted ≠ null`.

## Contract (`packages/contracts/wms/count-inventory.ts`)

`StartCountInputSchema` (`warehouseId`, `countType` enum `full|cycle|spot`, `locationIds`/`skuIds` optional arrays, `clientId` optional), `CountLocationInputSchema` (`lineId`, `qtyCounted: z.number().nonnegative()`), `RecountInputSchema` (`lineId`, `recountQty: z.number().nonnegative()`), `AdjustCountInputSchema` (`countId`, `expectedVersion`). `CountLocationResultSchema`/`RecountResultSchema` carry ONLY `{ lineId: uuid, recorded: z.literal(true) }` (D2 — no hidden-field leak, enforced by the schema shape itself, not just application discipline). `correlationId` on every command. No `entityId`, no `performedBy`.

Screen/Board spec: none (backend only, like every prior slice this session — a PDA count screen is a later UI slice, doc 40:422's "nine screens" note).

## Deliver (from `new-slice.sh`, rename the golden-only files to the counterparts below; delete files with no counterpart)

```
modules/wms/domain/count-inventory/{errors.ts,invariants.ts,machine.ts}          (delete suggest-location-ranking.ts)
modules/wms/application/count-inventory/{ports.ts,index.ts,start-count.ts,count-location.ts,recount.ts,adjust-count.ts}   (delete approve-inbound.ts, cancel-inbound.ts, close-inbound.ts, confirm-putaway.ts, receive-line.ts, suggest-location.ts)
modules/wms/infrastructure/count-inventory/{repository.ts,logger.ts,ledger.ts}   (ledger.ts REPLACE-ON-COPY per the golden pattern — thin adapter over ../../src/stock-ledger's postMovementInTx, movement_type 'adjust', ref_table 'wms.inventory_count_lines')
modules/wms/api/count-inventory/{composition.ts,handlers.ts}
modules/wms/tests/count-inventory/{count-inventory.feature,count-inventory.test.ts,machine.unit.test.ts,invariants.property.test.ts,handlers.test.ts}   (delete suggest-location-ranking.property.test.ts; rename inbound-machine.unit.test.ts -> machine.unit.test.ts)
packages/contracts/wms/count-inventory.ts
```

Migration: none needed for this slice's logic — `database/migrations/0018_2_inventory-counts-version.sql` already delivered the one required schema change (issued by the Master, pre-migration review APPROVED WITH CHANGES, applied and verified).

Test run: `pnpm --filter @pg-eos/wms test` (vitest per module, low memory — never the full suite) with `PG_APP_USER=pgeos_app`, admin pool from PGUSER for fixtures. **Also confirm `modules/wms/tests/receive-inbound/**` (the golden slice, already shipped) stays green** — this slice shares the `wms` module with it. Guards: `pnpm guards:run`.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 or in the Facts above.
Agent tiers (docs/MODEL_ROUTING.md): pg-tester sonnet ≤ 30k · pg-backend sonnet ≤ 40k · pg-reviewer opus ≤ 30k · pg-scribe sonnet ≤ 10k.
