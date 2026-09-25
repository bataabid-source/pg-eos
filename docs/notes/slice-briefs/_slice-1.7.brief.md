# SLICE BRIEF — WBS 1.7 · M02 contracts, price annexes, SLA definitions, billing flags (DL-11/12/13/14/18)

Task: 1.7 — M02: contracts, price annexes, SLA definitions, billing flags      Lane: 1      Lock: `sales` (tasks/LANE_LOCKS.md, D-176) + `packages/contracts/sales/` (lane-owned)
Owner: CFO      Deps: 1.6 DONE (`6accbf2`)      Worktree: `../pg-eos-lane-1`, branch `lane/1` (on origin/main `6accbf2`)
Model routing (D-174): pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
Use case (kebab): **`manage-contract`** — scaffolded by `scripts/new-slice.sh sales manage-contract` (already run; `pnpm install` done; scaffold self-registers contracts export/include).

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, batched for the GM)
- **`sales.contracts` has no `version` column** — a new mutable aggregate needs one per CLAUDE.md ARCHITECTURE. Migration requested: `tasks/backlog/MIGRATION-REQUEST-1.md` #3, replica of 0008/0013/0017. **The lane session writes this migration only after the Master issues the number and pg-reviewer's pre-migration review passes.**
- **"Order on expired contract rejected" (the acceptance line) has no consumer to test against yet.** No `sales.orders` table exists, and the natural consumer (a client fulfillment order — `wms.outbound_orders` or a future sales-order entity) is a DIFFERENT module/phase with no lock held by this lane. This slice therefore builds the RULE as a reusable, directly-testable guard — `assertContractUsableForOrder(contract)` (domain, pure) plus an application query `getContractForOrder(ctx, { accountId, entityId, asOfDate })` — that a future order-placing slice (WMS or elsewhere) will call before accepting an order against this account/entity. The acceptance is proven by calling this guard/query directly against fixture contracts in every status, not by touching another module. Batched GM question: confirm the eventual consumer (which WBS row wires this into an actual order-creation path).
- **Only `status = 'active'` is usable for an order.** `draft`/`signed` (not yet operational), `suspended`/`expired` (temporarily or permanently down), `terminated` (dead) and `renewed` (superseded — see below) all reject with a typed `ContractNotActiveError { status }`. This is the literal, minimal reading of the acceptance line generalised from "expired" to every non-active status — doc 40 §C2 names no separate rule distinguishing them.
- **"Price annex"** = the contract's own `price_list_id`, reusing WBS 1.2's `catalog.price_lists` — NOT a new table. This slice does not rebuild price-list CRUD (1.2 already did); it adds one small command, `SetContractPriceList`, that links an EXISTING `catalog.price_lists` row (validated: same `entity_id`, and either `client_id = account_id` or the list is the entity's segment/standard list — reuses 1.2's own list-scoping rules, read-only here) to the contract. INV-C2-2 ("no contract ACTIVATION without `price_list_id`") is enforced at `ActivateContract`, not at creation — a draft/signed contract may legitimately have no list yet.
- **"SLA definitions"** = `sales.contract_sla` rows (metric/target/direction/penalty/bonus) — definitions only. `sales.sla_results` (the MONTHLY computed actuals + penalty amounts, `period` = first-of-month) is a month-end billing/reporting mechanism, entirely out of scope here (same reasoning as WBS 1.4 leaving `billing.billable_events` to a later billing-phase slice) — no command in this slice writes to `sla_results`. An SLA line may only be added when `sla_enabled = true` on the contract (the boolean exists specifically to gate this), else `SlaNotEnabledError`. The `metric` value is restricted, at the CONTRACT/Zod layer only (not a new DB CHECK — the DB column is free text), to the six values doc 40 §C2's own SLA vocabulary names (`otd_pct`, `inventory_accuracy`, `pick_time_min`, `damage_pct`, `answer_rate`, `aht_sec`) — a documented default, not a G-01 item, since it tightens the application's own input, not the schema.
- **Billing flags (DL-11/12/13/14/18)** are five existing boolean columns (`bills_failed_attempt`, `bills_return`, `bills_waiting` in 01; `bills_reschedule`, `bills_partial_delivery` added in 13B) — all default `false` ("OFF" per doc 03/04's explicit rule: unbilled by default, uninvoiced events surface in the Lost Revenue report). This slice exposes them as plain settable fields on `CreateContract` ONLY — **create-only this slice, no `SetBillingFlags` command** (correction: an earlier draft of this brief mentioned one; it was never added to the Master decisions or the Deliver list, and stays out — a batched GM question, not a code gap). This slice does NOT implement the invoicing-time gate itself (INV-C4-8, "billable only if the corresponding contract flag is true") — that belongs to the delivery-billing slice that reads these flags later (out of scope, a different module/phase).
- **`RenewContract` and `TerminateContract` are DEFERRED**, same reasoning as WBS 1.6's deferred `ExpireQuote`: doc 38's title enumerates "contracts, price annexes, SLA definitions, billing flags", not renewal/termination mechanics, and neither is needed by the acceptance line. `renewed`/`terminated` stay legal status values, unreached by any command this slice ships. Batched GM question: authorise a follow-up slice once a real renewal/termination workflow is specified (is `renewed` a status the OLD contract gets while a NEW contract row is created — mirroring `ReviseQuote` — or an in-place transition? undecided, correctly left undecided here).
- **`ExpireContract` IS in scope** (unlike `ExpireQuote` in 1.6) because the acceptance line names `expired` specifically and this slice needs at least one way to reach it for the guard to be end-to-end testable: a simple command, callable by any internal role (a stand-in for a future scheduler, same reasoning as leaving a manual trigger available until a job exists), that transitions `active|suspended → expired` only when `end_date` is non-null and `end_date < asOfDate` (injected Clock) — else `ContractNotYetExpirableError`.

## Read ONLY (workers) — kept under the 12-file / 1,500-line budget
1. `CLAUDE.md`
2. `.claude/briefs/sales.brief.md` (+ `.claude/briefs/catalog.brief.md` §2 for `catalog.price_lists` scoping rules, already used in 1.2/1.6)
3. golden slice, SHAPE ONLY: `modules/wms/{domain,application,infrastructure,api}/receive-inbound/*`
4. **Nearer business-shape precedent** (pre-authorized, same reasoning as 1.6's brief): `modules/sales/{domain,application,infrastructure,api}/manage-quote/*` — reuse its machine-tag idiom, version-lock pattern, qualified-account check (`invariants.ts`'s `assertAccountQualified`), and composition/repository shape directly; it is the closest sibling use case in this exact module.
5. `database/schema/01-Data-Model.sql` 420-582 (`sales.accounts`, `sales.contracts`, `sales.contract_sla`, `sales.sla_results` — verbatim DDL) and 338-396 (`catalog.price_lists`/`price_list_lines` — reused from 1.2/1.6, scoping columns only)
6. `database/schema/13B-Schema-Reference-Consolidation.sql` 1758-1759 (`bills_reschedule`/`bills_partial_delivery` ALTER) and 2318-2320 (`chk_contracts_status`, the 7-value enum, verbatim)
7. `docs/package/40-Build-Specification-EN.md` 204-217 (§C2 state machines/invariants/events — quoted below) and 273-280 (§C4 INV-C4-1/INV-C4-8, the DL-11..18 billing-flag rule, quoted below — informational, the gate itself is out of scope)
8. `docs/package/03-Workflows.md` 269, 453-457 (the DL-11/12/13/14/18 → contract-flag mapping table, verbatim) — informational only, confirms the five column names and their OFF default
9. `database/migrations/0017_1_quotes-version.sql` (the version-column precedent) and `database/migrations/NNNN_1_contracts-version.sql` once issued
10. `packages/db/src/idempotency.ts` · `packages/db/index.ts` · `packages/events/src/outbox.ts` · `packages/domain-kit/index.ts`
11. `modules/sales/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts, index.ts}` (the extended shell)
Fixture precedent (pg-tester only): `modules/sales/tests/manage-quote/manage-quote.test.ts` 1-40 (fixture pattern already established in THIS module).

## Write ONLY
- pg-tester: `modules/sales/tests/manage-contract/*` · nothing else.
- pg-backend: `modules/sales/{domain,application,infrastructure,api}/manage-contract/*` · `modules/sales/index.ts` (extend barrel) · `packages/contracts/sales/manage-contract.ts` · `modules/sales/package.json` (deps only if missing, then `pnpm install`).
- Lane session only: `database/migrations/NNNN_1_contracts-version.sql` (after the Master's number + pg-reviewer PASS) · `tasks/backlog/MIGRATION-REQUEST-1.md` · this brief.
Forbidden for every worker: `database/schema/**`, `packages/**` other than `packages/contracts/sales/`, `packages/events/catalog.ts`, `admin`/`wms`/other-module schema or code, `docs/**`, `scripts/**`, `CLAUDE.md`, `.claude/**`. A test defect goes back to pg-tester; pg-backend never edits a test.

## Acceptance criterion (doc 38 row 1.7, verbatim)
"Order on expired contract rejected"
Gates: `pnpm --filter @pg-eos/sales typecheck && lint && test` green as `pgeos_app` · `pnpm guards:run` green (verify on an isolated DB built from this branch's own migrations) · pg-reviewer PASS (pre-migration + slice review).

## Doc 40 §C2 (verbatim, lines 204-217)
**State machines:** Contract: `draft → signed → active → suspended | expired → renewed | terminated`.
**Entities:** `contracts` (per entity; `billing_cycle`, `payment_terms_days`, `price_list_id`, `bills_failed_attempt`, `bills_return`, `bills_waiting`, `min_monthly_charge`, `sla_enabled`), `contract_sla`, `sla_results`.
**Invariants:** INV-C2-2 No contract activation without `price_list_id`.

## Doc 40 §C4 (verbatim, lines 273-280 — informational, the gate itself is a later slice's job)
INV-C4-1 Hard gate: driver with expired residency/licence, or vehicle with expired document, cannot be assigned.
INV-C4-8 DL-11/12/13/14/18 billable only if the corresponding contract flag is true; otherwise the event is recorded as lost revenue.

## Doc 03 §Workflows (verbatim mapping, lines 453-457)
محاولة فاشلة → DL-11 → فقط إن `bills_failed_attempt = true`. إرجاع → DL-12 → `bills_return = true`. انتظار → DL-13 → `bills_waiting = true`. إعادة جدولة بطلب المستلم → DL-14 → `bills_reschedule = true`. تسليم جزئي → DL-18 → `bills_partial_delivery = true`. الأعلام كلها افتراضها `OFF`.

## Master decisions the workers copy (not re-derive)
1. **Machine (XState v5, `.can()`/tags only):** `CONTRACT_STATUS` verbatim from `chk_contracts_status` (7 values). Legal edges: `draft --SIGN_CONTRACT--> signed`, `signed --ACTIVATE_CONTRACT--> active`, `active --SUSPEND_CONTRACT--> suspended`, `suspended --RESUME_CONTRACT--> active`, `active --EXPIRE_CONTRACT--> expired`, `suspended --EXPIRE_CONTRACT--> expired`. `active` is tagged `usableForOrder` — nothing else is. `renewed`/`terminated` are legal values with no producing edge this slice (deferred, per Scope).
2. **`CreateContract`** (role CFO): `entityId`, `accountId` (must be qualified — reuse `assertAccountQualified` from `manage-quote`'s invariants, same INV-C2-1-style check for consistency, since contracts have no invariant of their own naming this but a contract for an unqualified account is nonsensical by the same logic), `quoteId?` (FK, not re-validated beyond existence), `title`, `startDate` (>= today, injected Clock, else `InvalidStartDateError`), `endDate?` (null or `>= startDate`, else `InvalidEndDateError`), `billingCycle` default `'monthly'`, `paymentTermsDays` default 30, `autoRenew` default false, `noticeDays` default 30, `minMonthlyCharge` default 0, `slaEnabled` default false, the five billing flags all default `false`. Status `draft`, `version` 1. `doc_no` via `platform.next_doc_no(entityId, 'CTR')`.
3. **`SignContract`** (CFO, `draft → signed`): `signedByClient` (text, the signatory's name — not a FK), sets `signed_at = clock.now()`.
4. **`SetContractPriceList`** (CFO, legal from `draft`/`signed`/`active`/`suspended` — i.e. any non-terminal status, since a price annex can be attached or replaced before or during the contract's life): `priceListId` must exist, `entity_id` match the contract's, and (`client_id = accountId` OR `client_id is null` — the entity's segment/standard list) — else `PriceListNotApplicableError`. No version-lock conflict beyond the contract's own `expectedVersion`.
5. **`ActivateContract`** (CFO, `signed → active`): INV-C2-2 — `price_list_id is not null` (from decision 4's prior call), else `ContractNotPriceableError`.
6. **`SuspendContract`** (CFO, `active → suspended`): no extra check (no reason column exists on `sales.contracts` — none invented).
7. **`ResumeContract`** (CFO, `suspended → active`): no extra check.
8. **`ExpireContract`** (any internal role — a manual stand-in for a future scheduler, per Scope; `active|suspended → expired`): requires `end_date is not null` and `end_date < asOfDate` (injected Clock), else `ContractNotYetExpirableError`.
9. **`AddContractSla`** (CFO): requires `sla_enabled = true` on the contract, else `SlaNotEnabledError`; `metric` restricted to the six doc-named values (Zod enum, application-layer only); `targetValue` positive; `direction` `'min'|'max'` default `'min'`; `penaltyType?` (`'pct_of_monthly'|'fixed'|'none'`), `penaltyValue?`/`bonusValue?` optional non-negative numerics. No version bump on the CONTRACT row for this (a `contract_sla` row is a child insert, not a change to the contract's own mutable fields) — but the contract row IS still locked `for update` first to serialise concurrent SLA additions and to check the contract exists and is in a state where SLA terms make sense (not `terminated`).
10. **`assertContractUsableForOrder`** (domain, pure, takes the machine snapshot or the raw status + the tag check) throws `ContractNotActiveError { status }` unless tagged `usableForOrder`. **`getContractForOrder`** (application, read-only): given `{ accountId, entityId, asOfDate }`, finds the account's contract for that entity (tie-break: latest `start_date`, same convention as WBS 1.4), applies the assert, and returns `{ contractId, status, priceListId }` on success — this is the function a future order-placing slice calls; it makes NO write.
11. **Actor:** always `ctx.userId`; no `performedBy`/`signedBy`-as-user field (`signedByClient` is the CLIENT's name, a business fact, not the actor).
12. **Idempotency:** every write handler builds `IdempotencyInput`; endpoints `sales.manage-contract.{create-contract, sign-contract, set-contract-price-list, activate-contract, suspend-contract, resume-contract, expire-contract, add-contract-sla}`.
13. **Errors → Problem statuses**, same convention as 1.2/1.6: Zod → 400; `StaleVersionError`/`IdempotencyConflictError` → 409; every other typed domain error → 422; unknown → 500 logged via pino.
14. **No outbox event this slice** — doc 40 §C2 names only `sales.contract.signed` and `sales.contract.expiring` among its events list, but `contract.expiring` is a time-based/scheduled notification (out of scope, no scheduler exists) and `contract.signed` has no known consumer yet; recorded as a default to NOT publish either this slice (unlike 1.6's `quote.approved`, which doc 40 names as the ONE canonical event for that use case) — batched GM question: confirm whether `sales.contract.signed` should be added now for a future consumer.
15. **Migration** (`database/migrations/NNNN_1_contracts-version.sql`) is the ONLY schema change: `alter table sales.contracts add column if not exists version int not null default 1;` + comment + `identity.column_classification` row `('sales','contracts','version','public')` — verbatim replica of 0008/0013/0017.

## Scenario (Gherkin — pg-tester pastes into `manage-contract.feature` and executes 1:1)
```gherkin
Feature: Manage contract (WBS 1.7, M02 sales)
  As the CFO I create and activate client contracts with a price annex and SLA terms, and any
  future order-placing path rejects an order against a contract that is not active

  Background:
    Given entity PST, a qualified account "ACC-1", a CFO user scoped to PST, a standard active
      catalog.price_lists row for PST (from WBS 1.2's fixtures), a segment price list for ACC-1's
      segment, and a price list belonging to a DIFFERENT client

  Scenario: Create a draft contract
    When CreateContract is called for ACC-1 with startDate today
    Then a sales.contracts row exists, status "draft", version 1

  Scenario: Sign the contract
    When SignContract is called with signedByClient "Ahmed Al-Sabah"
    Then status is "signed", signed_at is set

  Scenario: Cannot activate without a price list (INV-C2-2)
    When ActivateContract is called with no price_list_id set
    Then it is rejected with ContractNotPriceableError

  Scenario: Attach a price annex belonging to another client is rejected
    When SetContractPriceList cites the OTHER client's price list
    Then it is rejected with PriceListNotApplicableError

  Scenario: Attach a valid price annex and activate
    When SetContractPriceList cites ACC-1's own segment list, then ActivateContract is called
    Then status is "active"

  Scenario: A qualifying order succeeds against an active contract
    When getContractForOrder is called for ACC-1 / PST / today
    Then it returns the contract with status "active"

  Scenario: An order against an expired contract is rejected (the acceptance line)
    Given the contract's end_date is yesterday
    When ExpireContract is called
    Then status is "expired"
    When getContractForOrder is called for ACC-1 / PST / today
    Then it is rejected with ContractNotActiveError { status: "expired" }

  Scenario: An order against a draft, signed, or suspended contract is rejected the same way
    When getContractForOrder is called against a contract in each of those statuses in turn
    Then each is rejected with ContractNotActiveError naming its own status

  Scenario: A contract cannot expire before its end date
    When ExpireContract is called on an active contract whose end_date is in the future
    Then it is rejected with ContractNotYetExpirableError

  Scenario: Suspend and resume
    When SuspendContract then ResumeContract are called on an active contract
    Then status ends "active" again, version bumped twice

  Scenario: Adding an SLA line requires sla_enabled
    Given the contract has sla_enabled = false
    When AddContractSla is called
    Then it is rejected with SlaNotEnabledError

  Scenario: Adding a valid SLA line
    Given sla_enabled = true
    When AddContractSla is called with metric "otd_pct", targetValue 95, direction "min"
    Then a sales.contract_sla row exists

  Scenario: An unrecognised SLA metric is rejected at the contract boundary
    When AddContractSla is called with metric "not_a_real_metric"
    Then it is rejected at the contract (400)

  Scenario: Billing flags default OFF and are settable at creation
    When CreateContract is called with bills_failed_attempt true and the rest omitted
    Then bills_failed_attempt is true and every other billing flag is false

  Scenario: Stale version is rejected on every mutating command
    When any mutating command is called with a stale expectedVersion
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: An unqualified account is rejected at creation
    When CreateContract is called for an account with no cr_number
    Then it is rejected with AccountNotQualifiedError

  Scenario: Idempotent replay and conflicting replay
    When a write is replayed with the same Idempotency-Key and body
    Then the stored response is returned and no second row is written
    When the same key is sent with a different body
    Then IdempotencyConflictError (409)

  Scenario: RLS — a caller scoped to another entity cannot see or write the contract
    When the same commands run as a user whose entity scope excludes PST
    Then the contract is not found and nothing is written
```

## Contract — `packages/contracts/sales/manage-contract.ts`
One `<Command>InputSchema` per command (8: `CreateContractInputSchema`, `SignContractInputSchema`, `SetContractPriceListInputSchema`, `ActivateContractInputSchema`, `SuspendContractInputSchema`, `ResumeContractInputSchema`, `ExpireContractInputSchema`, `AddContractSlaInputSchema`), `.meta({id})`. Dates `z.iso.date()`; `expectedVersion` int ≥ 1 on every contract-mutating command except `CreateContract`; `correlationId` uuid; `AddContractSlaInputSchema.metric` a `z.enum([...six values...])`.

## Deliver (mirrors the manage-quote tree)
- `packages/contracts/sales/manage-contract.ts`
- `modules/sales/domain/manage-contract/{errors.ts, machine.ts, invariants.ts}`
- `modules/sales/application/manage-contract/{ports.ts, index.ts, create-contract.ts, sign-contract.ts, set-contract-price-list.ts, activate-contract.ts, suspend-contract.ts, resume-contract.ts, expire-contract.ts, add-contract-sla.ts, get-contract-for-order.ts}`
- `modules/sales/infrastructure/manage-contract/{repository.ts, logger.ts}`
- `modules/sales/api/manage-contract/{composition.ts, handlers.ts}`
- `modules/sales/tests/manage-contract/{manage-contract.feature, manage-contract.test.ts, contract-machine.unit.test.ts, handlers.test.ts}`
- `modules/sales/index.ts` (barrel, extended) · `database/migrations/NNNN_1_contracts-version.sql` (lane session, after pre-migration review)

Migration number: pending (MIGRATION-REQUEST-1.md #3, requested from the Master).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent.
