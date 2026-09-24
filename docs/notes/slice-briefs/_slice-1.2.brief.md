# SLICE BRIEF — WBS 1.2 · M03 `catalog`: price lists, lines, import, exceptions — "price below floor rejected"

Task: 1.2 — M03 `catalog`: categories, services (7 categories), segments, price lists, exceptions      Lane: 1      Lock: `catalog` (tasks/LANE_LOCKS.md, claimed D-170) + `packages/contracts/catalog/` (lane-owned per CLAUDE.md · PARALLEL LANES "Contracts")
Owner: CFO      Deps: 0.13 DONE (`335b5db`)      Worktree: `../pg-eos-lane-1`, branch `lane/1`
Model routing (docs/MODEL_ROUTING.md): pg-tester sonnet (≤ 30k) → pg-backend sonnet (≤ 40k) → pg-tester verify → pg-reviewer opus (≤ 30k) → pg-scribe sonnet (≤ 10k). Lane 1 session orchestrates only.
Use case (kebab): **`maintain-price-list`** — scaffolded by `scripts/new-slice.sh catalog maintain-price-list` (already run; `pnpm install` done). Every file below is the renamed golden copy; the builder REPLACES the golden logic file-by-file, keeps the layering, and deletes only the golden files that have no catalog counterpart (`infrastructure/…/ledger.ts`, `domain/…/suggest-location-ranking.ts` + its property test, the six inbound command files) — replaced by the counterparts named in Deliver.

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, not re-argued)
- **Reference data is seeded, not built:** `catalog.service_categories` (7, 01-Data-Model.sql:1602), `catalog.services` (92, 13B:2536), `catalog.segments` (SEG-A…F, 01:1612) already exist. No CRUD on them in 1.2. Their floors (`min_price`/`standard_cost`) are the **human data gate 1.3** (lane A). Writes to `catalog.services` are RLS-gated by `platform.reference.manage`, "a permission no operational role holds" (migration 0009 header) — so a `SetServiceCost` command is NOT in this slice; granting that permission is a G-01/GM item batched in the closing report.
- **This slice builds the mutable aggregate `catalog.price_lists` (+ `price_list_lines`) and the GM-only `catalog.price_exceptions` record**, with the acceptance rule enforced at the API and the import path: **a line price below `catalog.services.min_price` is rejected** (doc 38 row 1.2). UI: `apps/` is empty (no admin app exists; golden slice was backend-only by GM choice, D-161) — the "from UI" leg is satisfied when the admin app slice (0.19, per the Master's D-172 message) mounts these handlers; recorded as a default.
- "Import" = `ImportPriceListLines`: one command taking an array of parsed rows (the CSV→rows parse is a thin api concern, not in scope), **all-or-nothing in ONE transaction**; the first offending row aborts the whole import with `PriceBelowFloorError` carrying `rowIndex`.

## Read ONLY (workers) — 12 files / ≤ 1,500 lines outside the golden tree
1. `CLAUDE.md`
2. `.claude/briefs/catalog.brief.md`
3. golden slice, SHAPE ONLY: `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound/*` + `packages/contracts/wms/receive-inbound.ts` (do not port inbound business rules; port the layering: ports → commands → repository/logger adapters → composition → handlers; role gate via `repo.hasRole` / `platform.my_roles()`; `withIdempotentContext`; audit row per command; outbox event in the SAME transaction; `expectedVersion` on every mutating command; typed errors with `name`)
4. `database/schema/01-Data-Model.sql` 338-412 (the six `catalog.*` tables — verbatim DDL, the ONLY columns that exist) and 1602-1625 (category + segment seeds)
5. `database/schema/13B-Schema-Reference-Consolidation.sql` 2413-2415 (`chk_price_lists_status` = draft · active · expired), 2530-2540 (services seed shape; `min_price` is NULL for every seeded service — fixtures set it), 2815 (`catalog.min_price_markup_pct` = 15, informational only in 1.2), 3108-3130 (RLS pattern: `services`/`segments`/`service_categories` = reference_read for every internal user; `price_lists`/`price_exceptions` = `entity_scope` on `entity_id`; `price_list_lines` = `internal_only`)
6. `docs/package/40-Build-Specification-EN.md` 192-202 (§C1 entities, INV-C1-1…4, pricing order — quoted below)
7. `docs/package/D-blueprints/02-Financial-Accounting.md` 92-96 and 115-122 (catalog ownership table, A3 floor check steps 5-6)
8. `database/migrations/0008_M_inbound-orders-version.sql` (the version-column precedent) and `database/migrations/0013_1_price-lists-version.sql` (this slice's migration, written by the lane after pg-reviewer's pre-migration review — APPROVED WITH CHANGES, applied)
9. `packages/db/src/idempotency.ts` (`withIdempotentContext`, `IdempotencyInput`, `IdempotencyConflictError`) · `packages/db/index.ts` (`withContext`, `WithContextCtx`)
10. `packages/events/src/outbox.ts` (`writeOutboxEvent` input shape) · `packages/events/catalog.ts` (frozen — read only; NOT edited by this lane)
11. `packages/domain-kit/index.ts` (`Quantity`, `Clock`, `IdGenerator`, `FixedClock`, `SequentialIdGenerator`)
12. `modules/catalog/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts, index.ts}` (the scaffolded shell — fix names only if the scaffold left a `wms` remnant)
Fixture precedent (pg-tester only, one extra file): `modules/wms/tests/receive-inbound/receive-inbound.test.ts` 1-140 (admin pool + real identity users/entities/roles, `PG_APP_USER=pgeos_app`, audit rows never deleted).

## Write ONLY
- pg-tester: `modules/catalog/tests/maintain-price-list/*` (feature · integration · unit · property · handlers tests) · nothing else.
- pg-backend: `modules/catalog/{domain,application,infrastructure,api}/maintain-price-list/*` · `modules/catalog/index.ts` · `packages/contracts/catalog/maintain-price-list.ts` · `modules/catalog/package.json` (deps only if the scaffold lacks one, then `pnpm install`).
- Lane session only (already done / Master-level defaults): `packages/contracts/package.json` (one `exports` entry `./catalog/maintain-price-list`) · `packages/contracts/tsconfig.json` (`catalog/**/*.ts` in `include`) · `database/migrations/0013_1_price-lists-version.sql` · `tasks/backlog/MIGRATION-REQUEST-1.md` · this brief.
Forbidden for every worker: `database/schema/**`, `packages/**` other than `packages/contracts/catalog/`, `packages/events/catalog.ts`, `docs/**`, `scripts/**`, any other module, `CLAUDE.md`, `.claude/**`. A test defect goes back to pg-tester; pg-backend never edits a test.

## Acceptance criterion (doc 38 row 1.2, verbatim)
"Price below floor rejected from UI, API and import"
Gates: `pnpm --filter @pg-eos/catalog typecheck && lint && test` green as `pgeos_app` · `pnpm guards:run` green (G1–G14, G18 report-only) · pg-reviewer PASS.

## Doc 40 §C1 (verbatim, lines 192-202)
Entities: `service_categories` (ST HD OF DL VA CC IT), `services` (code, uom, billing_basis, entity_id, `min_price`, `standard_cost`, `requires_contract_clause`), `segments` (SEG-A…F, criteria jsonb, discount_pct), `price_lists` (entity, segment or client, `is_internal` for transfer pricing, validity), `price_list_lines` (tiered: `tier_from/to`, `free_units`), `price_exceptions` (client, service, approved_price, `min_price_at_approval`, validity, `approved_by` GM, `review_at`).
- INV-C1-1 An active service must have `min_price` and `standard_cost` (data gate M03).
- INV-C1-2 A quote/invoice line price < `min_price` requires a valid `price_exception` (DB CHECK on `sales.quote_lines`).
- INV-C1-3 Tiered pricing is **progressive** (each tier at its own rate), never "last tier applies to all".
- INV-C1-4 Floor prices and standard costs are approved by GM + CFO; SALES_MGR maintains the catalog but cannot change floors.
Pricing engine (A3): resolve in order `exception → contract annex → segment list → standard list → pending`. Never price at zero.

## Master decisions the workers copy (not re-derive)
1. **Aggregate = `catalog.price_lists`; lines belong to it.** Every mutating command locks the list row (`select … for update`), checks `expectedVersion` (mismatch → `StaleVersionError`, 409), and bumps `version` — including line upserts and imports. `version` comes from migration 0013 (default 1).
2. **State machine (XState v5, `.can()` only):** `draft → active → expired`; events `ACTIVATE_PRICE_LIST`, `EXPIRE_PRICE_LIST`. No other edge. `PRICE_LIST_STATUS` verbatim from `chk_price_lists_status`.
3. **Lines are written only while the list is `draft`** (`assertListEditable` → `PriceListLockedError`). An active list is frozen; a price change = a new list. (Default; lean — no line-versioning.)
4. **Floor rule (the acceptance):** for every line written by `UpsertPriceListLine` and every row of `ImportPriceListLines`: the service must exist (`ServiceNotFoundError`) and be `is_active`; it must have a non-null `min_price` (INV-C1-1, else `ServiceNotPriceableError`); `price` must be `> 0` (A3 "never price at zero" — enforced at the contract) and `price >= min_price` (else `PriceBelowFloorError { serviceCode, price, minPrice, rowIndex? }`). The comparison is a pure domain function on `Quantity` (numeric(14,3)) — `assertPriceMeetsFloor(price, minPrice)` in `domain/…/invariants.ts` — called BEFORE any write; the DB has no such CHECK, so the domain is the only guard. Currency default `KWD`; all lines of one list share one currency (the first line decides; mismatch → `CurrencyMismatchError`; default).
5. **Tier ladder (INV-C1-3) — `domain/…/tier-ladder.ts`, pure:** per service within a list, either ONE flat line (`tier_from` null, `tier_to` null) or an ordered ladder where the first `tier_from = 0`, each next `tier_from` equals the previous `tier_to`, only the last `tier_to` may be null, no overlap, no gap; `free_units >= 0`. Validated on every upsert/import against the service's existing lines, and again at `ActivatePriceList` over the whole list (`TierLadderError`). The progressive *computation* belongs to 1.4 (pricing engine), not here.
6. **`CreatePriceList`** (role CFO): `entityId` (RLS `entity_scope` enforces membership; an RLS-refused insert surfaces through the golden handler's unknown-error path, never leaked), `code` (unique per entity — duplicate → `PriceListCodeTakenError` from SQLSTATE 23505 on `(entity_id, code)`, matched via the `cause` chain like the golden `isNegativeStockViolation`), `nameAr`, at most ONE of `segmentId` / `clientId` (both → `SegmentAndClientError`; neither = the entity's standard list), `validFrom`, `validTo` (null or `>= validFrom`, else `InvalidValidityError`), `isInternal`. Status `draft`, `version` 1. Returns `{ priceListId, version }`. `UpsertPriceListLine` upserts on `(price_list_id, service_id, tier_from)` (the 01 unique key).
7. **`ActivatePriceList`** (CFO): requires ≥ 1 line (`EmptyPriceListError`), ladder valid (decision 5), then `draft → active`; writes ONE outbox event `catalog.price_list.activated` (aggregate `catalog.price_lists`, payload `{ priceListId, entityId, code, segmentId, clientId, validFrom, validTo, lineCount }`) in the SAME transaction + one audit row with the same `correlation_id` (G9). Publishing an own-module event needs no `packages/events/catalog.ts` entry (that list governs *consumption*; the Master adds the name when a consumer appears).
8. **`ExpirePriceList`** (CFO): `active → expired`; sets `valid_to = today` (injected Clock) when `valid_to` is null or later than today; audit row; no event (default — nothing consumes it yet).
9. **`GrantPriceException`** (role **GM**, D-blueprint 02 row "الاستثناءات السعرية — يعتمدها GM حصراً"): inserts `catalog.price_exceptions` with `approved_by = ctx.userId`, `approved_at = clock.now()`, `min_price_at_approval = services.min_price` read in the same transaction (service must be priceable — INV-C1-1 — else `ServiceNotPriceableError`), `approved_price > 0` (may be **below** `min_price` — that is the point of an exception), `reason` non-empty, `validTo >= validFrom`, `reviewAt >= validFrom` (`InvalidValidityError`). Not versioned (append-only record; a change = a new exception). Writes outbox event `catalog.price_exception.granted` (aggregate `catalog.price_exceptions`, payload: ids, prices, validity) + audit row, same `correlation_id`. `clientId` is a bare uuid (no FK in 01) — not validated against `sales.accounts` here (default; 1.6 quotes will).
10. **Actor:** always `ctx.userId` (`MissingActorError` when absent); no `performedBy`/`approvedBy` input field anywhere.
11. **Idempotency:** every write handler builds `IdempotencyInput` from the required header + sha256 of the canonical body; endpoints `catalog.maintain-price-list.{create-price-list, upsert-price-list-line, import-price-list-lines, activate-price-list, expire-price-list, grant-price-exception}`.
12. **Errors → Problem statuses** as in the golden `handlers.ts`: Zod → 400; `StaleVersionError`, `IdempotencyConflictError` → 409; every other typed domain error → 422; unknown → 500 logged via the pino adapter. No literal status numbers outside the named constants.
13. **Audit targets:** `'list' | 'line' | 'exception'` mapped by the adapter to `catalog.price_lists` / `catalog.price_list_lines` / `catalog.price_exceptions`.
14. **Reads under RLS:** `services`/`segments` via reference_read (any internal user); the CFO/GM fixture user needs `user_entities` for the list's entity (entity_scope on `price_lists`/`price_exceptions`). No `platform.reference.manage` is needed anywhere in this slice.
15. **Migration 0013** (`database/migrations/0013_1_price-lists-version.sql`) is the ONLY schema change: `alter table catalog.price_lists add column if not exists version int not null default 1;` + comment + `identity.column_classification` row `('catalog','price_lists','version','public')` — verbatim replica of 0008. pg-reviewer pre-migration verdict: APPROVED WITH CHANGES (placeholder verdict line filled; 'public' accepted on the 0008 precedent, confirmed by a clean apply + G6 zero rows). Anything else → STOP under G-01.

## Scenario (Gherkin — pg-tester pastes into `maintain-price-list.feature` and executes 1:1)
```gherkin
Feature: Maintain price list (WBS 1.2, M03 catalog)
  As the CFO I create segment/client/standard price lists whose every line respects the service floor,
  so that nothing is ever sold below min_price without a GM-approved exception

  Background:
    Given entity PST, a CFO user and a GM user scoped to PST, and a SALES_MGR user scoped to PST
    And seeded services ST-01 and HD-04 with min_price set by the fixture (admin pool) and OF-01 with min_price NULL
    And segment SEG-A exists (seed)

  Scenario: Create a draft segment price list
    When CreatePriceList is called by the CFO for PST / SEG-A with code "PL-SEG-A-2026"
    Then a catalog.price_lists row exists with status "draft" and version 1, and one audit row is written

  Scenario: A line at or above the floor is accepted and bumps the list version
    When UpsertPriceListLine is called with price = min_price(ST-01) and expectedVersion 1
    Then the line exists, the list version is 2, and an audit row is written

  Scenario: A line below the floor is rejected from the API (acceptance)
    When UpsertPriceListLine is called with price = min_price(ST-01) - 0.001
    Then it is rejected with PriceBelowFloorError (HTTP 422 through the handler), no line is written and the version is unchanged

  Scenario: A zero price is rejected (A3 "never price at zero")
    When UpsertPriceListLine is called with price = 0
    Then it is rejected at the contract (400 through the handler) — the contract requires a positive numeric string

  Scenario: A service without a floor cannot be priced (INV-C1-1)
    When UpsertPriceListLine is called for OF-01 (min_price NULL)
    Then it is rejected with ServiceNotPriceableError and nothing is written

  Scenario: Import — all rows at or above the floor succeed atomically
    When ImportPriceListLines is called with 3 rows (ST-01 flat, HD-04 tier 0-100, HD-04 tier 100-null)
    Then 3 lines exist, the list version is bumped exactly once, and one audit row is written

  Scenario: Import — one row below the floor rejects the whole import (acceptance)
    When ImportPriceListLines is called with 3 rows where row 2 is below floor
    Then it is rejected with PriceBelowFloorError { rowIndex: 1 } and ZERO lines are written

  Scenario: A broken tier ladder is rejected (INV-C1-3)
    When ImportPriceListLines is called with HD-04 tiers 0-100 and 150-null
    Then it is rejected with TierLadderError and nothing is written

  Scenario: Activate a list with lines
    Given the list has >= 1 valid line
    When ActivatePriceList is called with the current version
    Then status is "active", version is bumped, exactly one "catalog.price_list.activated" outbox row and one audit row share a correlation_id

  Scenario: An empty list cannot be activated
    When ActivatePriceList is called on a list with no lines
    Then it is rejected with EmptyPriceListError

  Scenario: Lines on an active list are refused
    When UpsertPriceListLine is called on an active list
    Then it is rejected with PriceListLockedError

  Scenario: Expire an active list
    When ExpirePriceList is called
    Then status is "expired" and valid_to is today (fixed clock)

  Scenario: Illegal transition
    When ExpirePriceList is called on a draft list
    Then it is rejected with IllegalTransitionError

  Scenario: Stale version
    When any mutating command is called with a stale expectedVersion
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: Role gate — SALES_MGR cannot write prices (INV-C1-4)
    When CreatePriceList or UpsertPriceListLine is called by the SALES_MGR
    Then it is rejected with RoleRequiredError

  Scenario: GM grants a price exception below the floor
    When GrantPriceException is called by the GM for client C / ST-01 with approved_price = min_price - 1
    Then a price_exceptions row exists with min_price_at_approval = min_price(ST-01), approved_by = GM user id,
      one "catalog.price_exception.granted" outbox row and one audit row share a correlation_id

  Scenario: Only the GM grants exceptions
    When GrantPriceException is called by the CFO
    Then it is rejected with RoleRequiredError and nothing is written

  Scenario: Idempotent replay and conflicting replay
    When a write is replayed with the same Idempotency-Key and body
    Then the stored response is returned and no second row is written
    When the same key is sent with a different body
    Then IdempotencyConflictError (409)

  Scenario: RLS — a CFO scoped to another entity cannot see or write the PST list
    When the same commands run as a CFO whose user_entities excludes PST
    Then the list is not found (PriceListNotFoundError) and nothing is written
```
Property tests (fast-check, `invariants.property.test.ts` / `tier-ladder.property.test.ts`): (a) `assertPriceMeetsFloor` accepts iff `price >= minPrice` for all numeric(14,3) pairs; (b) a ladder built as contiguous tiers from 0 always validates, and any single mutation (gap, overlap, non-zero start, flat+tier mix, negative free_units) fails; (c) machine unit test: the only legal edges are draft→active and active→expired.

## Contract — `packages/contracts/catalog/maintain-price-list.ts`
One `<Command>InputSchema` per command (`CreatePriceListInputSchema`, `UpsertPriceListLineInputSchema`, `ImportPriceListLinesInputSchema`, `ActivatePriceListInputSchema`, `ExpirePriceListInputSchema`, `GrantPriceExceptionInputSchema`), `.meta({ id })` on each. Prices/tiers/free_units are numeric(14,3) strings (`POSITIVE_QUANTITY` for `price`/`approvedPrice`; `NON_NEGATIVE_QUANTITY` for `tierFrom`/`tierTo`/`freeUnits`); dates `z.iso.date()`; `expectedVersion` int >= 1 on every list-mutating command; `correlationId` uuid; import rows = non-empty array of `{ serviceCode, price, currency?, tierFrom?, tierTo?, freeUnits?, notes? }` (service by **code**, the import's natural key; the repo resolves code → id). `UpsertPriceListLine` also takes `serviceCode`.

## Deliver (mirrors the golden tree; names after the scaffold's rename)
- `packages/contracts/catalog/maintain-price-list.ts`
- `modules/catalog/domain/maintain-price-list/{errors.ts, invariants.ts, machine.ts, tier-ladder.ts}`
- `modules/catalog/application/maintain-price-list/{ports.ts, index.ts, create-price-list.ts, upsert-price-list-line.ts, import-price-list-lines.ts, activate-price-list.ts, expire-price-list.ts, grant-price-exception.ts}`
- `modules/catalog/infrastructure/maintain-price-list/{repository.ts, logger.ts}`
- `modules/catalog/api/maintain-price-list/{composition.ts, handlers.ts}`
- `modules/catalog/tests/maintain-price-list/{maintain-price-list.feature, maintain-price-list.test.ts, price-list-machine.unit.test.ts, invariants.property.test.ts, tier-ladder.property.test.ts, handlers.test.ts}`
- `modules/catalog/index.ts` (barrel) · `database/migrations/0013_1_price-lists-version.sql` (lane session, after pre-migration review)

Migration number: **0013** (issued by the Master, MIGRATION-REQUEST-1.md).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent.
