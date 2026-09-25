# SLICE BRIEF — WBS 1.4 · Pricing engine: exception → contract → segment → list → pending

Task: 1.4 — Pricing engine: exception → contract annex → segment list → standard list → pending      Lane: 1      Lock: `sales` (tasks/LANE_LOCKS.md, D-176)
Owner: CFO      Deps: 1.2 DONE (`6a53fc8`, catalog price lists)      Worktree: `../pg-eos-lane-1`, branch `lane/1` (on origin/main `dcd41dd`)
Model routing (D-174): pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
Use case (kebab): **`resolve-price`** — scaffolded by `scripts/new-slice.sh sales resolve-price` (already run; the script now self-registers the contracts export/include and `pnpm install` is done — no Master hand-off needed this time, unlike 1.2's finding 5).

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, batched for the GM)
- **This is a READ-ONLY resolution engine, not a command.** It computes a price; it does not persist anything. `billing.billable_events` (the table that actually carries a `pending`/`priced` status per event, doc 40 §C9) lives in schema `billing`, an entirely different module with no lock held by this lane — this slice never writes there. "Unpriced event stays pending" (the acceptance line) is read literally as: **the engine's own return value has a status `pending` and no price when nothing resolves — it never fabricates a zero price.** What a future billing-phase slice does with that `pending` result (writing `billing.billable_events`, surfacing it in the Lost Revenue report / Decision Inbox after 7 days per doc 40 §C1) is out of scope here and explicitly deferred.
- **No API endpoint, no XState machine.** This is a mechanism/library slice (precedent: WBS 2.8's stock-ledger posting, "no endpoint, no UI ... no state transitions exist" — the same reasoning applies: resolving a price is a computation with four ordered branches, not an entity moving through a persisted lifecycle, so CLAUDE.md's "no if/switch for state transitions — XState" does not apply here — there is no `status` column this engine writes or transitions). Deliver keeps `domain/`, `application/`, `infrastructure/` from the scaffold; `api/handlers.ts` and `domain/machine.ts` are DELETED (no golden counterpart in spirit — nothing calls this over HTTP yet, and there is nothing to transition); `api/composition.ts` is KEPT (wires the infrastructure adapters to the application function — this module's public surface for a future caller, e.g. a billing job).
- **Cross-schema reads follow existing precedent, not a new exception.** `modules/sales` reads `catalog.services` / `catalog.price_lists` / `catalog.price_list_lines` / `catalog.price_exceptions` directly via SQL inside its own repository (same pattern as the golden slice reading `sales.accounts` / `wms.skus` from `modules/wms`) — this is a schema-level read, not a TypeScript cross-module import, so the boundaries lint rule does not fire and no `packages/contracts/catalog` type is imported.
- **Intercompany/transfer pricing (`is_internal = true` price lists) is OUT of scope.** The engine only resolves client-facing prices; every list branch below filters `is_internal = false`. Transfer pricing is a separate, later concern (doc 40 §D-blueprints intercompany pricing note, referenced but not built here).
- **An exception is a flat unit price, not a tier ladder** (`catalog.price_exceptions` has one `approved_price` column, no tier columns) — `total = qty × approved_price`. Tiered/progressive computation (INV-C1-3) applies only to the three list-resolution branches (contract annex, segment list, standard list), each of which reads `catalog.price_list_lines`.
- **Tie-break when more than one list matches a branch** (no DB constraint enforces "at most one active list per scope" — `catalog.price_lists`' only unique key is `(entity_id, code)`): pick the row with the latest `valid_from`; if still tied, the lowest `id` (deterministic, not meaningful) — this is a data-hygiene assumption, not a rule from the docs, recorded as a default and NOT a G-01 item (no invented column or table, just an ORDER BY tie-break in application code).
- **Contract annex requires the contract to be `status = 'active'`** (not `signed`/`draft`) — doc 40 §C1 pairs "contract annex" with INV-C2-2 ("no contract activation without `price_list_id`"), so an active contract is the first point a `price_list_id` is guaranteed meaningful; a signed-but-not-yet-active contract's price list does not override the client's segment pricing. Recorded as a default.

## Read ONLY (workers) — kept under the 12-file / 1,500-line budget
1. `CLAUDE.md`
2. `.claude/briefs/{sales,catalog}.brief.md`
3. golden slice, SHAPE ONLY: `modules/wms/{domain,application,infrastructure}/receive-inbound/*` (layering only — ports, typed errors, repository pattern reading another schema directly, `withContext`); do NOT port the state-machine/command pattern (irrelevant here)
4. `database/schema/01-Data-Model.sql` 338-412 (`catalog.*` six tables, verbatim — reuse from 1.2's brief) and 420-582 (`sales.accounts`, `sales.contracts` — verbatim DDL, the ONLY columns that exist)
5. `docs/package/40-Build-Specification-EN.md` 192-217 (§C1 entities/invariants + §C2 sales entities/INV-C2-2, quoted below)
6. `docs/package/D-blueprints/02-Financial-Accounting.md` 92-98, 115-123 (catalog + contract ownership rows, A3 floor-check steps 5-6 — pricing-engine context)
7. `database/migrations/0013_1_price-lists-version.sql` (informational — `price_lists.version` exists but this engine never mutates a list, so it never checks `expectedVersion`)
8. `packages/domain-kit/index.ts` + `money.ts` (`Money.of/add/subtract/multiply/compare` — numeric(14,3) arithmetic, never `Number()`) · `clock.ts` (injected `Clock` for "as of" date, never `new Date()`)
9. `packages/db/index.ts` (`withContext`, `WithContextCtx`) — read-only queries only, no `withIdempotentContext` (nothing is a write here, no Idempotency-Key needed)
10. `modules/sales/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts, index.ts}` (the scaffolded shell)
Fixture precedent (pg-tester only): `modules/wms/tests/receive-inbound/receive-inbound.test.ts` 1-40 (admin-pool fixture setup pattern, real `identity.users`/`user_entities` rows, `PG_APP_USER=pgeos_app`).

## Write ONLY
- pg-tester: `modules/sales/tests/resolve-price/*` (feature · integration · unit · property) · nothing else.
- pg-backend: `modules/sales/{domain,application,infrastructure}/resolve-price/*` (DELETE `domain/resolve-price/machine.ts`, `domain/resolve-price/suggest-location-ranking.ts` + its property-test golden leftover, `application/resolve-price/{approve-inbound,cancel-inbound,close-inbound,confirm-putaway,receive-line,suggest-location}.ts`, `infrastructure/resolve-price/ledger.ts`; DELETE `api/resolve-price/handlers.ts` — no HTTP endpoint) · `modules/sales/api/resolve-price/composition.ts` (KEEP, rewritten — wires the repository to the resolver function) · `modules/sales/index.ts` · `packages/contracts/sales/resolve-price.ts` · `modules/sales/package.json` (deps only if the scaffold lacks one, then `pnpm install`).
Forbidden for every worker: `database/**`, `packages/**` other than `packages/contracts/sales/`, `packages/events/catalog.ts`, `docs/**`, `scripts/**`, any other module, `CLAUDE.md`, `.claude/**`. A test defect goes back to pg-tester; pg-backend never edits a test. **No migration in this slice** — nothing here alters a table.

## Acceptance criterion (doc 38 row 1.4, verbatim)
"Tiered pricing matches manual calc on 3 cases; unpriced event stays pending"
Gates: `pnpm --filter @pg-eos/sales typecheck && lint && test` green as `pgeos_app` · `pnpm guards:run` green (G1–G14, G18 report-only — verify on an isolated DB built from this branch's own migrations only, per the 0.19 close-out note, since the shared `pgeos` may carry other lanes' migrations) · pg-reviewer PASS.

## Doc 40 §C1/§C2 (verbatim, lines 192-217)
**Entities:** `service_categories` … `price_lists` (entity, segment or client, `is_internal` for transfer pricing, validity), `price_list_lines` (tiered: `tier_from/to`, `free_units`), `price_exceptions` (client, service, approved_price, `min_price_at_approval`, validity, `approved_by` GM, `review_at`).
**Pricing engine (A3):** resolve in order `exception → contract annex → segment list → standard list → pending`. Never price at zero; `pending` events surface in the Lost Revenue report and Decision Inbox after 7 days.
**Entities (§C2):** `accounts` (one per client; `client_kind`, `segment_id`, …), … `contracts` (per entity; `billing_cycle`, `payment_terms_days`, `price_list_id`, …).
- INV-C2-2 No contract activation without `price_list_id`.

## Master decisions the workers copy (not re-derive)
1. **Public surface — one function, `resolvePrice`** (`application/resolve-price/resolve-price.ts`): input `{ accountId, serviceId, entityId, qty, asOfDate }` (all required; `asOfDate` an ISO date string, defaults to `clock.today()` when the caller omits it — but the function signature always takes it explicitly, injected by the caller, never `new Date()` internally). Output a discriminated union: `{ status: 'priced'; unitPriceSource: 'exception'|'contract'|'segment_list'|'standard_list'; totalPrice: string /* numeric(14,3) */; priceListId?: string; priceExceptionId?: string; contractId?: string }` or `{ status: 'pending'; reason: string }`.
2. **Waterfall, in this exact order, first match wins:**
   a. **Exception:** `catalog.price_exceptions` row where `client_id = accountId`, `service_id = serviceId`, `valid_from <= asOfDate <= valid_to` (tie-break: latest `approved_at`). Total = `Money.of(approved_price).multiply(qty)`.
   b. **Contract annex:** the account's `sales.contracts` row where `account_id = accountId`, `entity_id = entityId`, `status = 'active'`, `start_date <= asOfDate` and (`end_date is null or end_date >= asOfDate`), `price_list_id is not null` (tie-break: latest `start_date`) → read that list's `price_list_lines` for `serviceId`, compute via decision 4.
   c. **Segment list:** `catalog.price_lists` where `entity_id = entityId`, `segment_id = ` the account's `segment_id` (read from `sales.accounts`; if the account has no `segment_id`, this branch is skipped entirely — not an error), `client_id is null`, `is_internal = false`, `status = 'active'`, validity covers `asOfDate` (tie-break: decision in Scope) → same tiered read/compute.
   d. **Standard list:** same as (c) but `segment_id is null and client_id is null` (the entity's default list) — same tiered read/compute.
   e. **Pending:** none of the above yields a line for `serviceId` → `{ status: 'pending', reason: '<one of: no-exception-no-list | resolved-list-has-no-line-for-service>' }`. Never throw, never return a zero price.
3. **A resolved list with no line for `serviceId` falls through to the NEXT branch, not straight to pending** — e.g. the segment list exists and is active but has no row for this service: try the standard list before giving up. Only exhausting (c) AND (d) with no line reaches `pending`. (The contract-annex branch (b) is the exception to this: if the contract is active with a `price_list_id` but that list has no line for the service, treat it the same way — fall through to (c), do not stop at "contract found but unpriced".)
4. **Tiered/progressive calculation** (`domain/resolve-price/tiered-pricing.ts`, pure — no I/O): given the service's `price_list_lines` for one list (already fetched, sorted by `tier_from` ascending — a flat line has `tier_from = null, tier_to = null` and is the sole line) and a quantity `qty: Money` (quantities here are unit counts, represented via `Money`-shaped `numeric(14,3)` strings per 1.2's `Quantity`/`NON_NEGATIVE_QUANTITY` convention — reuse `Quantity` from `@pg-eos/domain-kit` for the running/remaining-quantity math, `Money` for prices/totals):
   - A **flat line** (`tier_from`/`tier_to` both null): `total = Money.of(price).multiply(qty)`.
   - A **tiered ladder**: walk tiers in order; for each tier `[from, to)` (last tier's `to` may be null = unbounded), the tier's raw span is `to - from` (or "remaining qty" when `to` is null); apply `free_units` as a per-tier allowance subtracted from the billable quantity **within that tier only** (never carried to another tier): `billableInTier = max(0, min(qty, to ?? qty) - from - free_units)`, `remaining_after_this_tier = max(0, qty - to)` (or 0 once `to` is null). Sum `billableInTier × price` per tier — "each tier at its own rate" (INV-C1-3), never the last tier's rate applied to the whole quantity.
   - Reuses this exact wording and formula for the ladder-validity precondition: this function assumes the ladder already passed 1.2's `validateTierLadder` (contiguous, no gap, no overlap) — it does NOT re-validate the ladder; a malformed ladder found here (should not exist, since 1.2 validates on write) surfaces as a typed `MalformedTierLadderError`, never a silent miscalculation.
5. **Never price at zero, never throw for a legitimate business case.** `PriceExceptionExpiredError`/similar typed errors are NOT used for "no match" — that is the `pending` status, not an exception. A typed error IS thrown for a genuine data-integrity problem: `ServiceNotFoundError` (unknown `serviceId`), `AccountNotFoundError` (unknown `accountId`), `MalformedTierLadderError` (decision 4).
6. **Currency:** every list/exception used is assumed `KWD` (the schema's universal default); a mixed-currency read (a line with a non-KWD `currency`) is out of scope for this slice — filter to `currency = 'KWD'` when reading lines and treat a non-KWD-only list as if it had no line for the service (falls through per decision 3). Recorded as a default; multi-currency is a later concern.
7. **RLS / role:** every read goes through `withContext(ctx, fn)` as `pgeos_app`; `sales.contracts`/`sales.accounts` carry `entity_scope`/`client_portal_scope` policies already — the caller's `ctx` must include an entity that covers `entityId`, or the read returns zero rows (surfaces as `AccountNotFoundError`/no-contract-found, not a leaked 403). No new role/permission is needed — this is a read path, unlike 1.2's CFO/GM write gates.

## Scenario (Gherkin — pg-tester pastes into `resolve-price.feature` and executes 1:1)
```gherkin
Feature: Resolve price (WBS 1.4, pricing engine)
  As the pricing engine, for a given client, service and quantity, resolve the price to charge by
  trying exception, then the client's active contract's own list, then the client's segment list,
  then the entity's standard list, in that order, and never invent a price

  Background:
    Given entity PST, a client account "ACC-1" in segment SEG-A, a client account "ACC-2" with no
      segment, seeded services HD-04, ST-01, OF-01, DL-11, IT-01 (min_price/standard_cost already
      set by the fixture, admin pool)

  Scenario: Standard list, two-tier ladder with free_units (manual calc case 1)
    Given the entity's standard list has HD-04 priced [0-50, free_units 5, 2.000] then [50-null, 1.500]
    When resolvePrice is called for ACC-2 / HD-04 / qty 120
    Then status is "priced", unitPriceSource is "standard_list", totalPrice is "195.000"
      # manual calc: (50-5)*2.000 + (120-50)*1.500 = 90.000 + 105.000 = 195.000

  Scenario: Segment list, three-tier ladder, no free_units (manual calc case 2)
    Given SEG-A's list has ST-01 priced [0-10, 5.000] [10-50, 4.000] [50-null, 3.000]
    When resolvePrice is called for ACC-1 / ST-01 / qty 80
    Then status is "priced", unitPriceSource is "segment_list", totalPrice is "300.000"
      # manual calc: 10*5.000 + 40*4.000 + 30*3.000 = 50.000 + 160.000 + 90.000 = 300.000

  Scenario: Contract annex, flat line (manual calc case 3)
    Given ACC-1 has an active contract at entity PST whose own price list prices OF-01 flat at 1.200
      (that list is DIFFERENT from ACC-1's segment list, which also has an OF-01 line at a different
      price, to prove the contract wins)
    When resolvePrice is called for ACC-1 / OF-01 / qty 25
    Then status is "priced", unitPriceSource is "contract", totalPrice is "30.000", contractId is set
      # manual calc: 25 * 1.200 = 30.000

  Scenario: Exception overrides everything, including a cheaper contract/segment/standard line
    Given ACC-1 has an approved price_exception for DL-11 at 9.500, valid today
    When resolvePrice is called for ACC-1 / DL-11 / qty 4
    Then status is "priced", unitPriceSource is "exception", totalPrice is "38.000", priceExceptionId is set

  Scenario: An expired exception is ignored, falling through to the next branch
    Given ACC-1's DL-11 exception's valid_to is yesterday
    When resolvePrice is called for ACC-1 / DL-11 / qty 4
    Then unitPriceSource is NOT "exception"

  Scenario: A contract exists but its list has no line for the service — falls through, not pending
    Given ACC-1's active contract's price list has no line for ST-01
    When resolvePrice is called for ACC-1 / ST-01 / qty 80
    Then status is "priced", unitPriceSource is "segment_list" (ACC-1's own segment list still resolves it)

  Scenario: No account segment, no matching list anywhere — pending, never zero
    When resolvePrice is called for ACC-2 / IT-01 / qty 1 (no exception, no contract, no segment,
      standard list has no IT-01 line)
    Then status is "pending" and no totalPrice field is present

  Scenario: An inactive (draft) contract's list is ignored
    Given ACC-1 has a DRAFT (not active) contract with its own OF-01 list
    When resolvePrice is called for ACC-1 / OF-01 / qty 25
    Then unitPriceSource is NOT "contract" (falls through to segment/standard)

  Scenario: Unknown service is rejected
    When resolvePrice is called with a serviceId that does not exist
    Then it is rejected with ServiceNotFoundError

  Scenario: Unknown account is rejected
    When resolvePrice is called with an accountId that does not exist
    Then it is rejected with AccountNotFoundError

  Scenario: Zero quantity is rejected at the contract boundary
    When resolvePrice is called with qty "0"
    Then it is rejected at the contract (positive-quantity validation, same convention as 1.2)
```
Property tests (fast-check, `tiered-pricing.property.test.ts`): (a) for any valid contiguous ladder (reuse 1.2's `validateTierLadder`-passing generator shape) and any non-negative qty, the computed total equals the sum of each tier's `(billable-in-tier × price)` computed independently by the test (a second, differently-written reference calculation, not a copy of the production function — same anti-vacuous-test rule as 1.2's review finding 3); (b) a flat line's total is always `qty × price`; (c) `free_units` never produces a negative billable-in-tier (clamped at zero).

## Contract — `packages/contracts/sales/resolve-price.ts`
`ResolvePriceInputSchema` (`accountId`, `serviceId`, `entityId` all uuid; `qty` positive numeric(14,3) string; `asOfDate` `z.iso.date()`), `.meta({id:'ResolvePriceInput'})`. `ResolvePriceResultSchema` — a discriminated union on `status` (`'priced'` | `'pending'`) matching decision 1's shape exactly, `.meta({id:'ResolvePriceResult'})`.

## Deliver
- `packages/contracts/sales/resolve-price.ts`
- `modules/sales/domain/resolve-price/{errors.ts, tiered-pricing.ts}`
- `modules/sales/application/resolve-price/{ports.ts, index.ts, resolve-price.ts}`
- `modules/sales/infrastructure/resolve-price/repository.ts` (no `logger.ts` needed — a pure read path with no domain event/audit row to log; if pg-backend judges a logger is genuinely useful for an unexpected-error path, keep the golden `logger.ts` pattern, but it is not required)
- `modules/sales/api/resolve-price/composition.ts`
- `modules/sales/tests/resolve-price/{resolve-price.feature, resolve-price.test.ts, tiered-pricing.property.test.ts}`
- `modules/sales/index.ts` (barrel)

Migration number: none.
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent.
