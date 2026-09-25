# SLICE BRIEF — WBS 2.14 (lane 2 → pg-tester → pg-backend)

Task: 2.14 "Daily occupancy snapshot + overflow (ST-12) billable event"      Lane: 2      Lock: `wms` (LANE_LOCKS row `wms | 2 | 2.13` — will read `2.14` once the Master rotates it; module lock unchanged).
Acceptance (doc 38): **Overflow event generated on exceed.**   Owner: WH_MGR.   Depends: 2.8 (DONE).

Read ONLY:
- `CLAUDE.md`
- `.claude/briefs/wms.brief.md`
- golden slice (shape only): `modules/wms/domain/receive-inbound/{errors.ts,invariants.ts}` — **no `machine.ts`**: `wms.occupancy_snapshots` has no status/lifecycle column (it is a derived, idempotently-upserted daily row, same class as `wms.stock_balance`, which also carries no `version` — D1 below), so `modules/wms/domain/take-occupancy-snapshot/machine.ts` is deleted.
- `modules/wms/infrastructure/count-inventory/repository.ts` (this session's own WBS 2.13 — nearest precedent for a multi-statement, cross-table write inside one transaction, and for the "compute from existing rows, write derived data" shape)
- `modules/sales/application/resolve-price/*` (WBS 1.4 — the established precedent for reading ANOTHER module's schema directly via raw SQL from inside `infrastructure/`, no TypeScript cross-module import, boundaries lint untouched: this slice reads `sales.contracts`/`wms.space_allocations` and writes `billing.billable_events`, all via SQL in `infrastructure/take-occupancy-snapshot/repository.ts`, never a TS import across `modules/billing`)
- `docs/package/40-Build-Specification-EN.md` line 224 (entities list, confirms `occupancy_snapshots` daily 00:30), line 260 (`TakeOccupancySnapshot` named command), line 262 (`Events → billing`, quoted verbatim below), line 320 (month-end context) — do not re-read the document
- schema: `database/schema/01-Data-Model.sql` lines 825-836 (`wms.occupancy_snapshots`, existing, no new column needed) · `database/schema/13B-Schema-Reference-Consolidation.sql` lines 954-975 (`wms.space_blocks`, capacity/warehouse link) and 998-1016 (`wms.space_allocations`, the client's contracted qty) · `database/schema/01-Data-Model.sql` lines 1048-1078 (`billing.billable_events`, the shared cross-module billing landing table every operational module writes into directly — confirmed by its own `source_module` column, `'wms · tms · cc · imile'`)
- `packages/contracts/wms/count-inventory.ts` (contract shape precedent from this session's own 2.13)
- `packages/events/catalog.ts` (frozen — one new entry requested: `wms.occupancy.snapshot`, named verbatim in doc 40 line 262, not past-tense per the codebase's usual convention since the doc names it this way explicitly)
- Scaffold already run: `scripts/new-slice.sh wms take-occupancy-snapshot` (files listed under Deliver; renamed copies of the golden slice, logic to be replaced)

Write ONLY: `modules/wms/{domain,application,infrastructure,api}/take-occupancy-snapshot/**` (do not touch `count-inventory/**` or `receive-inbound/**`, except to READ them) · `packages/contracts/wms/take-occupancy-snapshot.ts` · `tests/**`.
**No migration in this slice** — `wms.occupancy_snapshots` and `billing.billable_events` already exist with every column this slice needs; no version column is added (D1 below).
pg-tester writes ONLY test files (`modules/wms/tests/take-occupancy-snapshot/**`, `*.feature`). pg-backend never edits a test.

## Facts (verified by the lane against the schema and the package — quote, do not re-derive)

- `wms.occupancy_snapshots` columns: `id, snapshot_date, entity_id, client_id, warehouse_id, space_block_id, pallets_occupied, sqm_occupied, cbm_occupied, locations_used`. Unique key (SUPERSEDED — see CORRECTION below): `occupancy_snapshots_grain_uq (snapshot_date, entity_id, client_id, warehouse_id, space_block_id)`. **Round-1 review finding 2 resolution:** re-running the snapshot for a day/client/block already computed is a pure NO-OP (`ON CONFLICT ... DO NOTHING`, not `DO UPDATE`) — the FIRST snapshot of a given day stands; it is never silently recomputed later in the day from a changed stock picture. This keeps the snapshot row and its billing rows (`billing.billable_events`, also `ON CONFLICT DO NOTHING`) permanently in sync with each other — a `DO UPDATE` on the snapshot while the billing rows stay frozen would let a snapshot's `pallets_occupied` drift out of step with the `qty` on its own already-written `ST-01`/`ST-12` rows, breaking `billing.billable_events`'s own "every event traces back to its own operation" invariant. A correction to an already-snapshotted day is out of scope for this slice (a later billing-correction slice, not invented here).
- `wms.space_blocks` columns (per client's contracted allocation target): `id, entity_id, warehouse_id, zone_id, code, block_type, capacity_pallets, capacity_sqm, capacity_cbm, ..., status`.
- `wms.space_allocations` columns: `id, entity_id, contract_id, client_id, block_id (-> wms.space_blocks), alloc_type (dedicated·shared·overflow), qty, uom (pallet·sqm·cbm), service_id, valid_from, valid_to, min_charge_applies, status (active·expiring·expired·terminated)`. A client's CONTRACTED capacity (SUPERSEDED wording — see CORRECTION and D3 below, which scope this to ONE block, not "a warehouse") = `sum(qty) where block_id = <that specific block>, uom = 'pallet', status = 'active' and valid_from <= snapshotDate and (valid_to is null or valid_to >= snapshotDate)` — every `alloc_type` (dedicated/shared/overflow) counts toward contracted capacity per D3, the brief does not narrow this to `dedicated` only.
- `billing.billable_events` columns: `id, entity_id, occurred_at, client_id, contract_id (nullable), service_id (-> catalog.services), qty, uom, source_module ('wms'), source_table, source_id, unit_price (nullable — priced later, NOT at generation time), price_source (nullable), price_ref_id (nullable), amount (nullable), status (default 'pending'), exclusion_reason, invoice_line_id, is_intercompany, counterparty_entity_id, created_at`. **Unique index `(source_table, source_id, service_id)`** — "prevents double-billing the same event" (the table's own comment) — this is the mechanism that makes re-running `TakeOccupancySnapshot` for an already-billed day a no-op for billing, not a manual idempotency check this slice has to invent.
- `catalog.services` seed (13B:2539, 2550): `ST-01` = "Racked pallet storage" (منصة/شهر, monthly), `ST-12` = "Overflow occupancy charge" (منصة زائدة/شهر, monthly) — both already exist, no new service row to seed.
- doc 40 line 262 (verbatim): "**Events → billing:** `wms.inbound.received → HD-*`; `wms.outbound.checked → OF-*`; `wms.occupancy.snapshot → ST-* daily`; overflow beyond contracted → `ST-12`; `wms.count.closed`; variance → `wms.inbound.variance` (client notified)."
- No trigger auto-populates `billing.billable_events` from `wms.occupancy_snapshots` — the operational module writes both rows itself, in the SAME transaction (same "proof: every event traces back to its own operation" discipline `billing.billable_events`'s own header comment states), matching the pattern every prior slice this session used for outbox+audit.
- Entity resolution is fail-closed (established precedent): `cardinality(platform.allowed_entities()) = 1` else `EntityScopeAmbiguousError` 422.
- `wms.stock_balance` (the nearest schema precedent for "a derived table with no version column") has no `version` column despite being written on every stock movement — confirms a purely-derived table upserted from source data is NOT the kind of "mutable aggregate" CLAUDE.md's version-column rule targets (that rule targets a user-driven, multi-step workflow object like `hr.employees` or `wms.inventory_counts`, not a recomputed daily rollup).
- **CORRECTION (found by pg-backend, verified by the lane against 13B directly — supersedes this brief's earlier framing of the unique key):** `wms.occupancy_snapshots` gained a `space_block_id` column (13B "OPS-59", `alter table ... add column if not exists space_block_id uuid references wms.space_blocks(id)`) and its unique constraint was REPLACED: `occupancy_snapshots_grain_uq (snapshot_date, entity_id, client_id, warehouse_id, space_block_id)`, with the constraint's own comment quoting doc 17 §3 verbatim: **"صفاً لكل (تاريخ × كيان × عميل × مستودع × كتلة)"** — "one row per (date × entity × client × warehouse × BLOCK)", explicitly because `space_availability()` and `wms.space_dashboard` already group by `space_block_id` and a warehouse-level grain would silently break that. **This changes the slice's grain: one `occupancy_snapshots` row per (client, space_block), not one per (client, warehouse).** `space_block_id` is nullable on the table itself, but every row this command writes should have a real one (a location always belongs to exactly one block via `wms.locations.space_block_id`) — a location with no block assigned is a data-quality gap outside this slice's scope, not something to paper over with a `null`/arbitrary anchor.
- This actually SIMPLIFIES the overflow comparison: `wms.space_allocations.block_id` already ties a client's contracted capacity to one specific block — comparing occupied-per-block against contracted-per-block (same block) is the natural unit, with no need to sum allocations across multiple blocks per warehouse the way the original (superseded) brief text implied.

## Defaults taken by the lane (CHANGELOG lines; batched to the GM in the closing report)

D1. No version column, no migration: `wms.occupancy_snapshots` is a derived daily rollup (upserted from `wms.stock_balance`/`wms.locations`, never hand-edited by a user through a multi-step workflow), the same class as `wms.stock_balance` itself (no version column, accepted precedent). `TakeOccupancySnapshot` upserts by its REAL natural key, the amended `occupancy_snapshots_grain_uq (snapshot_date, entity_id, client_id, warehouse_id, space_block_id)` — one row per (client, block), not per (client, warehouse). **Round-1 review finding 2 resolution (supersedes the sentence this replaces): the upsert is `ON CONFLICT ... DO NOTHING`, NOT `DO UPDATE` — the FIRST snapshot of a given (day, client, block) stands permanently; a re-run for the same day is a pure no-op (reads the standing row via a fallback SELECT, recomputes nothing, writes no new billing row).** No optimistic-lock protection is needed because there is no human editor and no in-place recomputation — a correction to an already-snapshotted day is out of scope for this slice.
D2. Occupancy is computed PER (client, space_block), PURELY from location counts, not SKU dimensions: for each distinct `(client_id, space_block_id)` pair with at least one occupied location, `pallets_occupied` = count of DISTINCT `wms.locations` (of `location_type = 'pallet'`, in that specific block) where that client has a `wms.stock_balance` row with `qty_on_hand > 0`; `locations_used` = the same count across EVERY `location_type` within that block. A location with `space_block_id IS NULL` is excluded from this slice's snapshot (a data-quality gap outside scope, not silently attributed to an arbitrary block). `sqm_occupied`/`cbm_occupied` are left at the column's own default (`0`) — NOT computed this slice: doing so correctly needs per-SKU volume/area (`wms.skus.volume_cbm` etc.) multiplied by quantity, materially bigger scope than doc 38's narrow acceptance line requires; batched GM question: is sqm/cbm occupancy needed for a later billing slice?
D3. Contracted capacity is the SAME block's own `wms.space_allocations` rows (no cross-block summing needed — `block_id` already ties an allocation to exactly one block): `sum(qty) where block_id = <this block>, uom='pallet', status='active', and the snapshot date falls inside [valid_from, valid_to-or-null]`. `sqm`/`cbm`-uom allocations are not checked for overflow this slice (follows from D2 — no sqm/cbm occupancy is computed to compare against them).
D4. Billing rows, ONE pair per (client, block): `TakeOccupancySnapshot` always writes ONE `billing.billable_events` row for `ST-01` with `qty = pallets_occupied` for that block ("Storage keeps billing during hold", doc 40 S8). When that block's `pallets_occupied > contracted`, it ADDITIONALLY writes ONE `billing.billable_events` row for `ST-12` with `qty = pallets_occupied - contracted` for that block (the excess only, a surcharge on top of the base ST-01 charge, not instead of it). Both rows: `unit_price`/`price_source`/`price_ref_id`/`amount` all left `null`, `status = 'pending'` — **pricing happens at month-end aggregation (doc 40 line 320), never at generation time**. `source_table = 'wms.occupancy_snapshots'`, `source_id` = that specific (client, block) snapshot row's own id — a client occupying two blocks in the same warehouse gets TWO snapshot rows and up to two independent ST-01/ST-12 pairs, each traceable to its own block's row.
D5. Idempotent re-run: if `billing.billable_events` already has a row for `(source_table='wms.occupancy_snapshots', source_id=<the snapshot's id>, service_id=<ST-01 or ST-12's id>)`, the INSERT is a no-op (`ON CONFLICT DO NOTHING` on that unique index) — a second `TakeOccupancySnapshot` call for an already-billed day never creates a duplicate charge, and never silently re-prices an already-`invoiced` row. This is the table's own unique index doing the work, not a hand-rolled idempotency check.
D6. One command only: `TakeOccupancySnapshot(warehouseId, snapshotDate?)` — snapshots EVERY client with stock present in that warehouse in one call (not one call per client), matching "daily 00:30" batch framing (doc 40:224) rather than a per-client trigger. `snapshotDate` defaults to the injected Clock's own business date (Asia/Kuwait, `businessDateOf`, same convention as every prior slice) when omitted.
D7. Role: `WH_MGR` only (doc 38's stated owner; this command generates billing-relevant financial records, narrower than 2.13's broader `WH_OP|WH_SUP|WH_MGR` counting roles — matches 2.13's `AdjustCount`'s own WH_MGR-only precedent for a financially consequential command).
D8. `entity_id` = `ctx.entityId` (never caller-supplied); actor = `ctx.userId` for the audit row (`TakeOccupancySnapshot` itself gets ONE audit_log row per call, aggregate `wms.occupancy_snapshots`, listing how many clients were snapshotted and whether any overflow fired — the billing rows are a SEPARATE concern with their own traceability via `source_table`/`source_id`, not separately audited beyond what the audit row's `new_value` payload already summarizes).
D9. Idempotency-Key: required on the write (same convention as every command this session), but note the command is ALSO naturally idempotent per D1/D5 even without one — the header requirement stays for consistency with every other write endpoint, not because a second identical call would otherwise corrupt anything.

## Scenario (Gherkin — pg-tester pastes into `modules/wms/tests/take-occupancy-snapshot/take-occupancy-snapshot.feature`)

```gherkin
Feature: Daily occupancy snapshot and overflow (ST-12) billable event (WBS 2.14)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId
    And a warehouse with pallet-type locations and clients holding stock in some of them

  Scenario: Snapshotting a warehouse within contracted capacity
    Given the caller holds role "WH_MGR"
    And a client occupying 5 pallet locations with an active 10-pallet space_allocations row for that block
    When TakeOccupancySnapshot is called for that warehouse
    Then one wms.occupancy_snapshots row exists for that client/warehouse/date with pallets_occupied 5
    And one billing.billable_events row exists for service "ST-01" with qty 5
    And no billing.billable_events row exists for service "ST-12"

  Scenario: Snapshotting a warehouse over contracted capacity generates the overflow event
    Given a client occupying 12 pallet locations with an active 10-pallet space_allocations row for that block
    When TakeOccupancySnapshot is called for that warehouse
    Then one wms.occupancy_snapshots row exists with pallets_occupied 12
    And one billing.billable_events row exists for service "ST-01" with qty 12
    And one billing.billable_events row exists for service "ST-12" with qty 2 (the excess over 10)

  Scenario: A client with no active allocation is fully in overflow
    Given a client occupying 3 pallet locations with no active space_allocations row for that block
    When TakeOccupancySnapshot is called for that warehouse
    Then one billing.billable_events row exists for service "ST-12" with qty 3 (the whole occupied count, since contracted = 0)

  Scenario: A client with zero occupied locations is skipped entirely
    Given a client with no stock_balance rows in the warehouse
    When TakeOccupancySnapshot is called for that warehouse
    Then no wms.occupancy_snapshots row is written for that client

  Scenario: Re-running the snapshot for an already-taken day is a pure no-op, even if stock changed since
    Given a snapshot already taken for a client/block/warehouse/date, with its ST-01 and ST-12 billing rows already written
    And stock for that client changes after the first snapshot (a new receipt into the same block)
    When TakeOccupancySnapshot is called again for the same warehouse and date
    Then the wms.occupancy_snapshots row is UNCHANGED (same id, same pallets_occupied as the first run — the new stock is not reflected)
    And no second billing.billable_events row is written for the same (source_id, service_id) pair, and the existing rows' qty is unchanged

  Scenario: locations_used counts every location type, not just pallet-type
    Given a client occupying 2 pallet locations and 1 shelf location, all in the same block, in the warehouse
    When TakeOccupancySnapshot is called for that warehouse
    Then the snapshot's pallets_occupied is 2 and locations_used is 3

  Scenario: A client occupying two different blocks gets two snapshot rows
    Given a client occupying locations in space_block A and separately in space_block B, both in the warehouse, each with its own space_allocations row
    When TakeOccupancySnapshot is called for that warehouse
    Then two wms.occupancy_snapshots rows exist for that client — one per block, per occupancy_snapshots_grain_uq (snapshot_date, entity_id, client_id, warehouse_id, space_block_id)
    And each block's overflow is evaluated independently against that block's own contracted capacity

  Scenario: Role gate
    Given the caller holds only role "WH_SUP"
    When TakeOccupancySnapshot is called
    Then RoleRequiredError (422) and nothing is written

  Scenario: An audit row is written once per call
    Given a warehouse with two clients holding stock
    When TakeOccupancySnapshot is called for that warehouse
    Then exactly one platform.audit_log row is written for the command's own correlation_id, aggregate wms.occupancy_snapshots

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When TakeOccupancySnapshot is called twice with K and the same body
    Then the second call returns the first result without recomputing
```

Property tests (fast-check, `invariants.property.test.ts`):
- P1 for any `(occupied, contracted)` pair of non-negative numbers: `overflowQty(occupied, contracted)` returns `occupied - contracted` when `occupied > contracted`, else `0` (never negative).
- P2 for any set of location rows tagged with a type and an occupied flag: `countOccupiedLocations(rows, {typeFilter})` correctly counts only rows matching both the occupied flag and (when given) the type filter.

## Contract (`packages/contracts/wms/take-occupancy-snapshot.ts`)

`TakeOccupancySnapshotInputSchema`: `warehouseId` (uuid), `snapshotDate` optional `z.iso.date()` (defaults server-side to the Clock's business date), `correlationId`. Result schema: `{ warehouseId, snapshotDate, clientsSnapshotted: number, clientsInOverflow: number }` — a summary, not a per-client dump (no screen consumes this yet; keep the response minimal per lean design).

Screen/Board spec: none (backend only, like every prior slice this session).

## Deliver (from `new-slice.sh`, rename the golden-only files to the counterparts below; delete files with no counterpart)

```
modules/wms/domain/take-occupancy-snapshot/{errors.ts,invariants.ts}                 (delete machine.ts — D1 — and suggest-location-ranking.ts)
modules/wms/application/take-occupancy-snapshot/{ports.ts,index.ts,take-occupancy-snapshot.ts}   (delete approve-inbound.ts, cancel-inbound.ts, close-inbound.ts, confirm-putaway.ts, receive-line.ts, suggest-location.ts)
modules/wms/infrastructure/take-occupancy-snapshot/{repository.ts,logger.ts}         (delete ledger.ts — this slice writes billing.billable_events directly via raw SQL, not through the stock-ledger mechanism, which is for wms.stock_movements specifically)
modules/wms/api/take-occupancy-snapshot/{composition.ts,handlers.ts}
modules/wms/tests/take-occupancy-snapshot/{take-occupancy-snapshot.feature,take-occupancy-snapshot.test.ts,invariants.property.test.ts,handlers.test.ts}   (delete inbound-machine.unit.test.ts — D1 — and suggest-location-ranking.property.test.ts)
packages/contracts/wms/take-occupancy-snapshot.ts
```

Migration: none (D1 — no schema change needed).

Test run: `pnpm --filter @pg-eos/wms test` (vitest per module, low memory — never the full suite) with `PG_APP_USER=pgeos_app`, admin pool from PGUSER for fixtures. **Also confirm `modules/wms/tests/{receive-inbound,count-inventory}/**` (both already shipped) stay green** — this slice shares the `wms` module with both. Guards: `pnpm guards:run` (watch G18 — `billing.verify_unpriced_events()` is report-only per CLAUDE.md, a pending row this slice writes is expected and does not fail the guard).

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 or in the Facts above.
Agent tiers (docs/MODEL_ROUTING.md): pg-tester sonnet ≤ 30k · pg-backend sonnet ≤ 40k · pg-reviewer opus ≤ 30k · pg-scribe sonnet ≤ 10k.
