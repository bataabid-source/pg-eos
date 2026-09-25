# SLICE BRIEF — WBS 2.15 (lane 2 → pg-tester → pg-backend)

Task: 2.15 "Space management: allocations, reservations, `check_space_available()` guard"      Lane: 2      Lock: `wms` (LANE_LOCKS row `wms | 2`, task field updated by the Master).
Acceptance (doc 38): **Over-allocation raises with exact available qty.**   Owner: SALES_MGR.   Depends: 2.1 (DONE), 1.7 (DONE — `sales.contracts`, which `space_allocations.contract_id` references).

Read ONLY:
- `CLAUDE.md`
- `.claude/briefs/wms.brief.md`
- golden slice (shape only): `modules/wms/domain/receive-inbound/{errors.ts,invariants.ts}` — **no `machine.ts`**: neither `wms.space_allocations` nor `wms.space_reservations` has a status column this slice mutates through edges (both commands only ever INSERT a new row at `status='active'`; no update/transition command is named by doc 40 for this slice — D1 below).
- `modules/wms/application/take-occupancy-snapshot/{ports.ts,take-occupancy-snapshot.ts}` (this session's own WBS 2.14 — nearest precedent for calling a Postgres function/reading derived data and writing a plain INSERT with no version column, audit-only, no outbox event)
- `modules/wms/infrastructure/count-inventory/repository.ts` (nearest precedent for catching a specific Postgres SQLSTATE and mapping it to a typed domain error — WBS 2.13's `23P01`/`23505` catches)
- `modules/platform/api/maintain-site/handlers.ts` (Problem envelope / Idempotency-Key / role-gate shape to replicate)
- `docs/package/40-Build-Specification-EN.md` line 251 (INV-C3-8, quoted verbatim below) and line 260 (the two named commands `AllocateSpace`, `ReserveSpace`) — do not re-read the document
- schema: `database/schema/13B-Schema-Reference-Consolidation.sql` lines 954-1017 (`wms.space_blocks`, `wms.space_reservations`, already exist — no new tables), lines 1042-1090 (`wms.space_availability()`, the sellable-computation function: `sellable = capacity_pallets - out_of_service - contracted - reserved`), lines 1092-1106 (`wms.check_space_available()`, RAISES with the exact sellable qty in its message when insufficient — this IS the acceptance line's own mechanism, quote its message, do not re-derive the number), lines 4777-4810 (`wms.trg_space_reservation_guard()`, an EXISTING BEFORE INSERT/UPDATE trigger on `wms.space_reservations` that already enforces both a max-reservation-duration threshold — `platform.thresholds` key `space.reservation_max_days`, seeded 30 — and the space-availability check; belt-and-braces, the domain layer pre-checks BOTH before the insert so the trigger's raw exception is never the caller-visible failure path in normal operation), lines 4812-onward (`wms.convert_reservation()`, an EXISTING function converting a reservation into an allocation — **NOT part of this slice**, doc 40 names no `ConvertReservation` command for WBS 2.15; batched GM question below).
- `packages/contracts/wms/count-inventory.ts` (contract shape precedent)

Write ONLY: `modules/wms/{domain,application,infrastructure,api}/manage-space/**` (do not touch `receive-inbound/**`, `count-inventory/**`, `take-occupancy-snapshot/**`, except to READ them) · `packages/contracts/wms/manage-space.ts` · `tests/**` · **`modules/wms/tsconfig.test.json` and `packages/contracts/package.json`, LIMITED to the two registration edits `scripts/new-slice.sh` makes on its own (the `tests/manage-space/**` project reference and the `./wms/manage-space` export entry) — round-2 review finding 5: these are the tool's own additive registration, same shape as every prior slice's (2.9, 2.13, 2.14), never a hand-authored change; `packages/contracts/package.json` sits under the "frozen during parallel lanes" list (CLAUDE.md · PARALLEL LANES), but `scripts/new-slice.sh`'s own auto-registration is accepted as the standing tool-generated exception to that freeze, not a hand-edit.**
**No migration in this slice** — `wms.space_allocations` and `wms.space_reservations` already have every column needed, all already classified (G6 confirmed live), no version column needed (D1).
pg-tester writes ONLY test files (`modules/wms/tests/manage-space/**`, `*.feature`). pg-backend never edits a test.

## Facts (verified by the lane against the schema and the package — quote, do not re-derive)

- `wms.space_allocations` columns: `id, entity_id, contract_id (-> sales.contracts, NOT NULL), client_id (-> sales.accounts), block_id (-> wms.space_blocks), alloc_type (dedicated·shared·overflow, default 'dedicated'), qty (CHECK > 0), uom (pallet·sqm·cbm), service_id (-> catalog.services, nullable), valid_from, valid_to (nullable), min_charge_applies (default true), status (active·expiring·expired·terminated, default 'active'), created_by`. RLS `entity_scope` + `client_portal_scope`. **No version column, no trigger** — the application layer is the ONLY place `check_space_available()` is called for an allocation.
- `wms.space_reservations` columns: `id, entity_id, block_id, client_id (nullable), quote_id (-> sales.quotes, nullable), opportunity_id (-> sales.opportunities, nullable), qty (no positive-qty CHECK found — domain must still validate > 0), uom, reserved_from, expires_at (CHECK expires_at > reserved_from), reason (quote_pending·incoming_client·seasonal_peak·internal), status (active·converted·expired·cancelled, default 'active'), converted_allocation_id (nullable), reserved_by (NOT NULL), approved_by (nullable), created_at`. RLS `entity_scope` + `client_portal_scope`. **Has an existing BEFORE INSERT/UPDATE trigger** (`trg_space_reservation_guard`) enforcing the 30-day max-duration threshold and `check_space_available()` — this slice's domain layer duplicates BOTH checks before the INSERT (doc 36 §5-4 #2 dual enforcement), so the trigger only ever fires as a normal-path backstop against a caller who bypassed the application layer entirely. **CORRECTION (round-1 review finding 1): the trigger does NOT prevent a race between two concurrent calls** — it takes no row lock, so two simultaneous `ReserveSpace`/`AllocateSpace` calls on the same block can both read a stale "sellable" figure and both pass, over-allocating. The application layer itself must lock the block row (`SELECT ... FOR UPDATE`) before computing/checking availability, in BOTH commands — see D3/D4 below.
- doc 40 INV-C3-8 (verbatim): "Space: `check_space_available()` rejects allocation/reservation exceeding sellable (capacity − out-of-service − contracted − reserved). Reservations expire automatically."
- `wms.check_space_available(p_block uuid, p_qty numeric, p_from date, p_to date) returns void` — raises a plain exception (SQLSTATE `P0001`, the Postgres default for `RAISE EXCEPTION` with no explicit SQLSTATE) whose message already states the block's code, the exact sellable qty, and the qty that was requested — this message text IS the acceptance line's "exact available qty", quote it into the typed error, never recompute the number separately.
- **"Reservations expire automatically" (INV-C3-8's second half) is ALREADY satisfied by the schema, not something this slice builds:** `wms.space_availability()`'s own `resv` CTE filters `expires_at >= p_from` — an expired reservation (past its `expires_at`) stops counting toward `reserved` (and therefore stops reducing `sellable`) the moment its date passes, REGARDLESS of whether its `status` column has been separately flipped to `'expired'`. No pg-boss job exists anywhere in this codebase yet (grepped, none found) to actually flip the `status` column on a schedule — that is a STATUS-HYGIENE concern (so `wms.space_dashboard`/reporting shows the correct label), not a SPACE-AVAILABILITY concern (which is already correct without it). Building that job is OUT OF SCOPE for this slice (batched GM question below): the acceptance line is about space becoming available again, which already works.
- `wms.convert_reservation(p_reservation, p_contract, p_service, p_valid_from, p_valid_to, p_actor) returns uuid` already exists, fully implemented (locks the reservation, validates status/client, marks it `converted`, re-checks space, inserts the allocation row) — **NOT part of this slice**; doc 40 line 260 names only `AllocateSpace` and `ReserveSpace` for WBS 2.15. Exposing `ConvertReservation` as its own API command is a later slice's scope (batched GM question).
- `platform.thresholds` key `space.reservation_max_days` = 30 (already seeded, read by the existing trigger and by this slice's domain pre-check — never a literal `30` in application code).
- Roles (13B:556-572): `SALES_MGR` (all-scope) is doc 38's named owner for this row. An SoD rule exists between `SALES_MGR` and `CFO` (13B:633, "whoever sells doesn't set the floor") — unrelated to space allocation directly, but test fixtures must not grant both roles to one identity (same SoD discipline as every prior slice this session).
- **Entity resolution (CORRECTED — supersedes the caller-cardinality rule used by every prior slice):** `SALES_MGR` is explicitly named `all-scope` (Facts above) — a caller legitimately belonging to more than one `platform.entities` row is the NORMAL case for this role, not an ambiguity to reject. `cardinality(platform.allowed_entities()) = 1` would therefore wrongly block a genuine SALES_MGR from ever allocating or reserving space. Instead: entity is resolved from the REQUEST's own `blockId` — `select entity_id from wms.space_blocks where id = $1` under that table's own `entity_scope` RLS (a block outside the caller's visible entities is simply invisible, same "indistinguishable from missing" convention every prior slice used for a NotFoundError). Both `wms.space_allocations` and `wms.space_reservations` are inserted with `entity_id = block.entityId` (never `ctx.entityId`, never caller-supplied) — the row's own `entity_scope` INSERT check is the second, DB-level line of defense if this were ever gotten wrong. `EntityScopeAmbiguousError` is REUSED for "no such block visible to the caller" (same error type, a different resolution path — not a new error class).
- No event named in doc 40's "Events → billing" list (line 262) covers space allocation/reservation — this slice writes an audit_log row per command (G9) and no outbox event, same precedent as 3.3's `ChangeEmployeeStatus` (a state-recording write with no cross-module business-event meaning).

## Defaults taken by the lane (CHANGELOG lines; batched to the GM in the closing report)

D1. No XState machine, no version column: both commands only ever INSERT a new row at `status='active'`; doc 40 names no update/terminate command for this WBS row (a later slice may add `TerminateAllocation`/`CancelReservation`, out of scope here).
D2. Two commands only, per doc 40 line 260: `AllocateSpace`, `ReserveSpace`. `ConvertReservation` is explicitly out of scope (Facts above) — batched GM question: should this slice also expose the already-implemented `wms.convert_reservation()` DB function as a third command, or is that intentionally a separate later slice?
D3. `AllocateSpace`: role gate SALES_MGR first; resolve `entityId` via the block (Facts CORRECTION above), which requires reading `wms.space_blocks` — **that read must be `SELECT ... FOR UPDATE`** (round-1 review finding 1: the block row must be LOCKED before the capacity check, not just read, so two concurrent calls on the same block serialize instead of both passing a stale sellable figure). Domain pre-checks `qty > 0` and calls `wms.check_space_available(blockId, qty, validFrom, validTo)` (a plain `SELECT`, since the function returns void and raises on failure) BEFORE the INSERT, still inside the same locked transaction; catches SQLSTATE `P0001` and re-throws as a typed `SpaceNotAvailableError` (422) carrying the function's own message (which already states the exact sellable qty). `contractId`, `clientId`, `blockId`, `allocType`, `qty`, `uom`, `serviceId` (optional), `validFrom`, `validTo` (optional), `minChargeApplies` (optional, defaults to the column's own `true`) are caller-supplied; `entityId` = the block's own entity; `createdBy` = `ctx.userId`.
D4. `ReserveSpace`: role gate SALES_MGR first; resolve `entityId` via the block, same `SELECT ... FOR UPDATE` lock as D3 (round-1 finding 1 — this command has the identical race). Domain pre-checks `qty > 0`, `expiresAt > reservedFrom` (mirrors `reservation_has_expiry`, a typed `ReservationDateRangeInvalidError` or equivalent — NOT the same error as the duration-limit check, round-1 finding 3), the 30-day max-duration threshold (read from `platform.thresholds`, never hardcoded), and calls `wms.check_space_available(blockId, qty, reservedFrom, expiresAt)` BEFORE the INSERT, inside the same locked transaction — same `P0001` catch/re-throw pattern as D3, plus a typed `ReservationTooLongError` (422) for the duration check specifically (a different error from the plain date-range check). `blockId`, `clientId` (optional), `quoteId` (optional), `opportunityId` (optional), `qty`, `uom`, `reservedFrom`, `expiresAt`, `reason` are caller-supplied; `entityId` = the block's own entity; `reservedBy` = `ctx.userId`; `approvedBy` left null (no approval step named by doc 40 for this slice).
D5. Role gate: `SALES_MGR` only for both commands (doc 38's stated owner — narrower than some prior slices' multi-role gates, matches the single-named-owner precedent).
D6. Audit only, no outbox event (Facts above) — one `platform.audit_log` row per command, aggregate `wms.space_allocations`/`wms.space_reservations` respectively.
D7. `space_reservations.qty` has no DB-level positive-qty CHECK (unlike `space_allocations.qty`'s `positive_qty` constraint) — the domain layer's own `qty > 0` check is therefore NOT redundant belt-and-braces here, it is the ONLY enforcement; still recorded as D4, not a separate G-01 item (no new column/table, just an invariant this slice's domain layer must not skip).

## Scenario (Gherkin — pg-tester pastes into `modules/wms/tests/manage-space/manage-space.feature`)

```gherkin
Feature: Space management — allocations, reservations, check_space_available() guard (WBS 2.15, INV-C3-8)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId
    And an existing wms.space_blocks row with a known capacity_pallets

  Scenario: Allocate space within sellable capacity
    Given the caller holds role "SALES_MGR"
    And a block with capacity 100 pallets, no existing allocations/reservations/out-of-service rows
    When AllocateSpace is called with qty 40
    Then one wms.space_allocations row exists with status "active", qty 40

  Scenario: Allocating beyond sellable capacity is rejected with the exact available qty
    Given a block with capacity 100 pallets and an existing active allocation of 70
    When AllocateSpace is called with qty 40
    Then SpaceNotAvailableError (422) whose message states the sellable qty is 30
    And no wms.space_allocations row is written

  Scenario: Reserve space within sellable capacity
    Given the caller holds role "SALES_MGR"
    And a block with capacity 100 pallets and no existing allocations/reservations
    When ReserveSpace is called with qty 25, reservedFrom today, expiresAt 10 days from today, reason "quote_pending"
    Then one wms.space_reservations row exists with status "active", qty 25

  Scenario: Reserving beyond sellable capacity is rejected
    Given a block with capacity 100 pallets and an existing active reservation of 80 that has not expired
    When ReserveSpace is called with qty 30
    Then SpaceNotAvailableError (422) and no wms.space_reservations row is written

  Scenario: A reservation longer than the threshold is rejected
    Given the platform.thresholds key space.reservation_max_days is 30
    When ReserveSpace is called with reservedFrom today and expiresAt 45 days from today
    Then ReservationTooLongError (422) and no wms.space_reservations row is written

  Scenario: An expired reservation no longer counts against sellable capacity
    Given a block with capacity 100 pallets and a reservation of 80 whose expires_at is yesterday (status still "active" — never flipped by any job)
    When AllocateSpace is called with qty 90
    Then the allocation succeeds — the expired reservation's qty does not reduce sellable capacity

  Scenario: Allocating with a non-positive qty is rejected at the contract
    When AllocateSpace is called with qty 0
    Then the handler returns a 400 Problem and nothing is written

  Scenario: Reserving with a non-positive qty is rejected by the domain
    When ReserveSpace is called with qty -5
    Then a typed 422 error and nothing is written

  Scenario: Role gates
    Given the caller holds only role "WH_MGR"
    Then AllocateSpace and ReserveSpace each throw RoleRequiredError and write nothing

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When AllocateSpace is called twice with K and the same body
    Then one allocation row exists and the second call returns the first result
```

Property tests (fast-check, `invariants.property.test.ts`):
- P1 for any `(reservedFrom, expiresAt)` pair: `isWithinMaxDuration(reservedFrom, expiresAt, maxDays) ⇔ (expiresAt - reservedFrom) <= maxDays`.
- P2 for any `qty`: `isPositiveQty(qty) ⇔ qty > 0`.

## Contract (`packages/contracts/wms/manage-space.ts`)

`AllocateSpaceInputSchema` (`contractId`, `clientId`, `blockId`, `allocType` enum `dedicated|shared|overflow` optional (defaults server-side to the column's own `'dedicated'`), `qty: z.number().positive()`, `uom` enum `pallet|sqm|cbm`, `serviceId` optional, `validFrom: z.iso.date()`, `validTo` optional, `minChargeApplies` optional boolean, `correlationId`). `ReserveSpaceInputSchema` (`blockId`, `clientId` optional, `quoteId` optional, `opportunityId` optional, `qty: z.number().positive()`, `uom`, `reservedFrom: z.iso.date()`, `expiresAt: z.iso.date()`, `reason` enum `quote_pending|incoming_client|seasonal_peak|internal`, `correlationId`). No `entityId`, no `performedBy`, no `expectedVersion` (no version column, D1).

Screen/Board spec: none (backend only, like every prior slice this session).

## Deliver (from `new-slice.sh`, rename the golden-only files to the counterparts below; delete files with no counterpart)

```
modules/wms/domain/manage-space/{errors.ts,invariants.ts}                 (delete machine.ts — D1 — and suggest-location-ranking.ts)
modules/wms/application/manage-space/{ports.ts,index.ts,allocate-space.ts,reserve-space.ts}   (delete approve-inbound.ts, cancel-inbound.ts, close-inbound.ts, confirm-putaway.ts, receive-line.ts, suggest-location.ts)
modules/wms/infrastructure/manage-space/{repository.ts,logger.ts}         (delete ledger.ts — this slice does not post stock movements)
modules/wms/api/manage-space/{composition.ts,handlers.ts}
modules/wms/tests/manage-space/{manage-space.feature,manage-space.test.ts,invariants.property.test.ts,handlers.test.ts}   (delete inbound-machine.unit.test.ts — D1 — and suggest-location-ranking.property.test.ts)
packages/contracts/wms/manage-space.ts
```

Migration: none (D1/Facts — no new column, no version column needed).

Test run: `pnpm --filter @pg-eos/wms test` (vitest per module, low memory — never the full suite) with `PG_APP_USER=pgeos_app`, admin pool from PGUSER for fixtures. **Also confirm `modules/wms/tests/{receive-inbound,count-inventory,take-occupancy-snapshot}/**` (all three already shipped) stay green** — this slice shares the `wms` module with all of them. Guards: `pnpm guards:run`.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 or in the Facts above.
Agent tiers (docs/MODEL_ROUTING.md): pg-tester sonnet ≤ 30k · pg-backend sonnet ≤ 40k · pg-reviewer opus ≤ 30k · pg-scribe sonnet ≤ 10k.
