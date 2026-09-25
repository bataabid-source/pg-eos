# SLICE BRIEF — WBS 2.11 part 1 · Outbound order: create + ten-condition check + approve + cancel

Task: 2.11 part 1 — Outbound order create, RunOutboundChecks (nine of ten conditions), ApproveOutbound, CancelOutbound (pre-allocation statuses only)      Lane: 1      Lock: `wms/process-outbound` (tasks/LANE_LOCKS.md)
Owner: WH_MGR      Deps: 2.9 DONE (golden slice, `78c640e`), 1.8 DONE (`cedd4bf`, group-level credit hold), 1.7 DONE (contracts)      Worktree: `../pg-eos-lane-1`, branch `lane/1` (on origin/main `5644b5c`)
Model routing (D-174): pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
Use case (kebab): **`process-outbound`** — already scaffolded by `scripts/new-slice.sh wms process-outbound` (contracts export self-registered). This is a SPLIT of the original over-budget 2.11 brief (D-179): **part 1** delivers `CreateOutbound`, `RunOutboundChecks`, `ApproveOutbound`, `CancelOutbound` (scoped to the six pre-allocation/pre-pick statuses this part can reach: `draft, checks_pending, credit_rejected, approved` → `cancelled`). **Part 2** (separate brief, separate commit, `... (part 2, DONE)`) adds `Allocate`, `GeneratePickList`, and extends `CancelOutbound` to the `allocated`/`partially_allocated` release path. Part 1 lands as `feat(2.11): ... (part 1, NOT DONE)` — row stays open until part 2.

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, batched for the GM)
- **No cross-module TypeScript import.** `RunOutboundChecks` needs contract-active (sales.contracts), credit-hold (sales.accounts), and price-exists (catalog price chain) facts. Instead of importing `@pg-eos/sales` application code (forbidden — CLAUDE.md "No cross-module import. Use an event or a contract."; `eslint-plugin-boundaries` fails the build), `wms`'s own `infrastructure/process-outbound/repository.ts` runs read-only SQL directly against `sales.contracts`/`sales.accounts`/`catalog.*` inside the SAME `withContext(ctx, fn)` transaction, RLS-scoped exactly like the existing `take-occupancy-snapshot/repository.ts` precedent (reads `sales.contracts`, `catalog.services`, `billing.billable_events` today). Condition 9 (price) is reduced to: does an active, dated price-list line (or price exception) exist for service `OF-01` at this account/entity as-of today — a narrower read than calling `resolvePrice`, but the acceptance line only requires "no price for service X" to be detectable, not a full tiered-pricing computation; recorded as a default, not a G-01 gap (no invented column, purely a read of existing tables the golden-slice pattern already reads cross-schema).
- **Condition 10** ("quantity within the agreed order limit") stays BLOCKED — no schema source in 01/13/13B/019/40 (searched, confirmed by the discarded original brief). Not built. Recorded in code/CHANGELOG, not counted toward the ten.
- **Condition messages are typed errors carrying an i18n key + params, not hardcoded Arabic strings** (CLAUDE.md "No embedded UI strings — i18n"). Each condition's typed error class exposes `.i18nKey` (e.g. `wms.outbound.check.contractExpired`) and a `.params` object (e.g. `{ expiryDate }`); the API layer's Problem envelope carries both. The literal Arabic template in the D-blueprint is the KEY'S DEFINITION, not code to embed — actual translated strings (ar/en/hi/ur/bn/am) are a module-wide `apps/admin/src/i18n/*.json` addition, which this use-case lock may NOT write (module-wide file) — the full key→ar-template list goes in this session's closing report for the Master to add in one batch, same as every prior slice's i18n keys.
- **`chk_outbound_orders_status` (13B, live CHECK) is authoritative** — 14 values: `draft · checks_pending · credit_rejected · approved · allocated · partially_allocated · picking · picked · checked · packed · loaded · dispatched · delivered · cancelled`. Part 1's XState machine covers only: `draft --RUN_CHECKS_PASS--> checks_pending`, `draft --RUN_CHECKS_CREDIT_FAIL--> credit_rejected`, `checks_pending --APPROVE--> approved`, `{draft, checks_pending, credit_rejected, approved} --CANCEL--> cancelled`. `allocated`/`partially_allocated` and their own CANCEL edge belong to part 2 (they don't exist yet in this part — machine has no producing edge into them).
- **A qualified-account check for `CreateOutbound`** — the client must exist, not be soft-deleted (`deleted_at is null`), `status='active'` — a plain SQL read in wms's own repository (no cross-module call), same class of check as condition 1/2's SQL reads.

## Read ONLY (workers) — kept under the 12-file / 1,500-line budget
1. `CLAUDE.md`
2. `.claude/briefs/wms.brief.md`
3. `modules/wms/domain/receive-inbound/errors.ts` (typed-error idiom — `name` set explicitly, Problem-mapping convention)
4. `modules/wms/domain/receive-inbound/machine.ts` (XState v5 machine-tag idiom, the direct template for this part's smaller machine)
5. `modules/wms/application/receive-inbound/approve-inbound.ts` lines 1-150 (command shape: version-lock, role gate, audit-in-transaction, outbox-in-transaction, idempotency-in-transaction, inline — this IS the ports/outbox/idempotency usage pattern, no separate ports.ts/outbox.ts read needed; range trimmed 2026-09-25 — 2.9b extended this file past the original citation's line count, only the core command pattern is needed here)
6. `modules/wms/application/receive-inbound/cancel-inbound.ts` (same, for the CancelOutbound template — reason-required, multi-source-status transition)
7. `modules/wms/infrastructure/take-occupancy-snapshot/repository.ts` lines 1-136 (the cross-schema read-only SQL precedent this part follows for `sales.contracts`/`sales.accounts`/`catalog.*` reads — role/entity helpers + the `sales.contracts`-joining query)
8. `database/schema/01-Data-Model.sql` lines 420-446 (`sales.accounts`), 553-580 (`sales.contracts`), 752-800 (`wms.outbound_orders`, `wms.order_lines`)
9. `database/schema/13B-Schema-Reference-Consolidation.sql` lines 2320-2334 (`chk_outbound_orders_status`, `chk_order_lines_status`)
10. `docs/package/D-blueprints/03-Operations-Warehouse.md` lines 277-360 (§4.2 outbound flow + §4.2.1 ten conditions, verbatim below)
11. `packages/db/src/idempotency.ts`
12. `modules/wms/tests/receive-inbound/receive-inbound.test.ts` lines 1-60 (pg-tester only: admin-pool fixture pattern, real `identity.users`/`user_entities` rows, `PG_APP_USER=pgeos_app`)

## Not separately read (low marginal value, budget-traded away)
`packages/events/src/outbox.ts` (its call shape is already visible inline in items 5/6) · `modules/wms/application/receive-inbound/ports.ts` (write process-outbound's own ports.ts fresh, following the Clock/IdGenerator/Logger/repository-port shape visible in items 5/6's imports) · `modules/wms/{package.json,tsconfig.json,tsconfig.test.json,index.ts}` (scaffold already correct from `scripts/new-slice.sh`; extend `index.ts`'s barrel using the SAME named-export-with-prefix pattern count-inventory already established there — view the current barrel directly when editing it, that is not a precedent read) · `database/migrations/0020_1_accounts-version.sql` (the lane session, not a delegated worker, writes the migration — already read this session).

## Write ONLY
- pg-tester: `modules/wms/tests/process-outbound/*` · nothing else.
- pg-backend: `modules/wms/{domain,application,infrastructure,api}/process-outbound/*` · `modules/wms/index.ts` (extend barrel — allowed for a use-case lock only to ADD named exports, same pattern as 2.13's own index.ts edit) · `packages/contracts/wms/process-outbound.ts` · `modules/wms/package.json` (deps only if missing, then `pnpm install`).
- Lane session only: `database/migrations/0022_1_outbound-orders-version.sql` (after pg-reviewer pre-migration PASS) · `tasks/backlog/MIGRATION-REQUEST-1.md` · this brief.
Forbidden for every worker: `database/schema/**`, `packages/**` other than `packages/contracts/wms/process-outbound.ts`, `packages/events/catalog.ts`, other modules, any OTHER golden-slice file (do not touch `receive-inbound/*`), `apps/**` (i18n JSON is module-wide, Master batch only), `docs/**` other than this brief, `scripts/**`, `CLAUDE.md`, `.claude/**`. A test defect goes back to pg-tester; pg-backend never edits a test.

## Acceptance criterion (doc 38 row 2.11, verbatim — part 1's share)
"Each of ten conditions has a failing test with the correct message" — nine of ten conditions get a real failing test with an i18n-keyed message; condition 10 is explicitly BLOCKED (not counted, not silently dropped).
Gates: `pnpm --filter @pg-eos/wms typecheck && lint && test` green as `pgeos_app` · `pnpm guards:run` green (isolated DB, this branch's own migrations) · pg-reviewer PASS · pre-migration pg-reviewer PASS before the migration file is written.

## D-blueprint 03 §4.2 steps 1-3 (verbatim, part 1's share) + §4.2.1 the ten conditions
| # | من يفعلها | ما الذي يتغيّر | الحدث |
|---|---|---|---|
| 1 | `WH_OP` / العميل | `outbound_orders` صف `status='draft'` · `doc_no` سلسلة `OUT` | `wms.outbound.drafted` |
| 2 | النظام آلياً | `status='checks_pending'` — حارس على الانتقال لا مرحلة عمل · تشغيل الشروط العشرة | `wms.outbound.checks_started` |
| 2ب | النظام | فشل الشرط 2 ⇒ `status='credit_rejected'` · `credit_check_passed=false` | `wms.outbound.credit_rejected` |
| 3 | `WH_MGR` | صندوق القرارات · `status='approved'` | `wms.outbound.approved` |

| # | الشرط | i18n key (ar template below is the key's definition) |
|---|---|---|
| 1 | العقد ساري | `wms.outbound.check.contractExpired` — «عقد العميل منتهٍ في [تاريخ] — يلزم التجديد» |
| 2 | لا حجز ائتماني | `wms.outbound.check.creditHold` — «العميل تحت حجز ائتماني: [السبب]» |
| 3 | الرصيد كافٍ | `wms.outbound.check.insufficientStock` — «المتاح [كمية] فقط من المطلوب [كمية] في [موقع]» |
| 4 | الصنف يخص العميل | `wms.outbound.check.skuClientMismatch` — «الصنف [كود] مسجَّل لعميل آخر» |
| 5 | الصلاحية المتبقية كافية | `wms.outbound.check.shelfLifeTooShort` — «الدفعة [رقم] صلاحيتها [أيام] أقل من الحد [أيام]» |
| 6 | الصنف غير موقوف | `wms.outbound.check.skuBlocked` — «الصنف موقوف: [السبب]» |
| 7 | الموقع غير محجوب | `wms.outbound.check.locationBlocked` — «الموقع [كود] محجوب: [السبب]» |
| 8 | العنوان مكتمل — إن كان للتوصيل | `wms.outbound.check.deliveryAddressIncomplete` — «عنوان التسليم ناقص: [الحقول]» |
| 9 | سعر الخدمة موجود | `wms.outbound.check.noServicePrice` — «لا سعر لخدمة [كود] في عقد العميل» |
| 10 | الكمية ضمن حد الطلب | **BLOCKED this slice** — no schema source (G-01 batched) |
"الشرط 2 على مستوى المجموعة: حجز ائتماني على عميل متعدد الكيانات يرفض أمر صرف PST ومهمة توصيل PDL وطابور PCC بالسبب نفسه (S6)."

## Master decisions the workers copy (not re-derive)
1. **`OUTBOUND_STATUS` verbatim from `chk_outbound_orders_status`** (14 values). Machine edges this part builds: `draft --RUN_CHECKS_PASS--> checks_pending`, `draft --RUN_CHECKS_CREDIT_FAIL--> credit_rejected`, `checks_pending --APPROVE--> approved`, `{draft, checks_pending, credit_rejected, approved} --CANCEL--> cancelled`. Every other status is a legal enum value with no producing edge in this part (part 2's job).
2. **`CreateOutbound`**: `entityId`, `clientId` (must resolve, `deleted_at is null`, `status='active'` — plain SQL read, not a cross-module call), `warehouseId`, `contractId?`, `orderType` (`'standard'|'rush'|'transfer'|'return_to_client'`, application-level Zod enum — `outbound_orders.order_type` has no DB CHECK, known schema gap SCH-4, not fixed this slice), `requiredBy?`, `shipToName?/Phone?/Address?/Area?`, `clientRef?`. Status `draft`, `version` 1, `doc_no` via `platform.next_doc_no(entityId, 'OUT')` (series confirmed present in the seed, verified this session).
3. **`RunOutboundChecks`** (any internal caller, transition-guard — `draft → checks_pending` or `draft → credit_rejected`): locks the order row, checks `expectedVersion`, runs conditions 1, 3-9 in order as pure pre-checks (first failure throws its typed error, order stays `draft`, nothing persisted); condition 2 checked separately and last — failure transitions to `credit_rejected` (persisted `credit_check_passed=false`, `credit_checked_at=now()`) instead of throwing; all pass → `checks_pending` (`credit_check_passed=true`, `credit_checked_at=now()`). Condition 10 skipped (code comment states why). Per-condition SQL (all inside wms's own repository, read-only, same transaction):
   - **1 (contract active):** `sales.contracts` row for `(account_id=clientId, entity_id)` with `status='active'` and (`end_date is null or end_date >= current_date`) — `ContractNotActiveError`/`ContractExpiredError` (new typed errors in this use case, NOT imported from sales).
   - **2 (no credit hold):** `sales.accounts.credit_hold`/`hold_reason` for `clientId` — `CreditHoldError` (new typed error here).
   - **3 (sufficient stock):** `sum(wms.stock_balance.qty_available)` for `(client_id=clientId, sku_id)` across all locations in `warehouseId` `>= qty_ordered` for every line — message names SKU code, available sum, ordered qty, and the single location code if exactly one location holds any stock.
   - **4 (SKU belongs to client):** every line's `sku.client_id = order.clientId` (INV-C3-3 pattern, reused from 2.9's own check).
   - **5 (shelf life):** for a line whose SKU has `track_expiry=true`, every candidate lot (`stock_balance` row, `qty_available>0`) must have `expiry_date - current_date >= sku.min_remaining_life_issue_days`; null threshold = no requirement.
   - **6 (SKU not blocked):** `sku.status='active'`; message names SKU code + actual status.
   - **7 (location not blocked):** every location currently holding `qty_available>0` for this client/SKU that is `is_blocked=true`, UNLESS an alternative non-blocked location also has enough stock (fail only if EVERY stocked location is blocked).
   - **8 (delivery address complete):** only when `orderType` implies delivery (any type other than `'transfer'`/`'return_to_client'`, recorded default) — all four `shipTo*` fields non-empty; message names missing fields.
   - **9 (service price exists):** read-only SQL: does an active priced-list line (or price exception) exist for service `OF-01` (`catalog.services` lookup by code) at this `clientId`/`entityId` as-of `current_date`, per the same table chain `resolve-price/repository.ts` reads (`catalog.price_lists`/`price_list_lines`/`price_exceptions`, `sales.contracts.price_list_id`) — a `pending`/not-found result fails condition 9, quoting `OF-01`.
   - **10:** skipped (Scope).
4. **`ApproveOutbound`** (role WH_MGR, `checks_pending → approved`): no extra business check beyond role/version/machine gates.
5. **`CancelOutbound`** (role WH_MGR, reason required, from `{draft, checks_pending, credit_rejected, approved}` → `cancelled` — the four statuses THIS part can reach; `IllegalTransitionError` from any other status, including `allocated`/`partially_allocated` which don't exist yet in this part). No stock to release at this part's statuses (nothing has been allocated).
6. **Actor:** always `ctx.userId`; no `performedBy` field anywhere.
7. **Idempotency:** every write handler (`CreateOutbound`, `RunOutboundChecks`, `ApproveOutbound`, `CancelOutbound`) builds `IdempotencyInput` via `packages/db/src/idempotency.ts`.
8. **Errors → Problem statuses:** Zod → 400; `StaleVersionError`/`IdempotencyConflictError` → 409; every other typed domain error (all nine condition-failure errors, `CreditHoldError`, etc.) → 422; unknown → 500 logged via pino.
9. **NO MIGRATION.** Corrected 2026-09-25 (pg-reviewer pre-migration FAIL round 1, finding 3): `wms.outbound_orders.version int not null default 1` already exists — `database/schema/13B-Schema-Reference-Consolidation.sql` lines 164-166 already carries it (`alter table ... add column if not exists ...` + comment), the same statement 0008/0013/0017/0019/0020 each cite as their own precedent. Migration number 0022 is returned to the Master unused (`tasks/backlog/MIGRATION-REQUEST-1.md` row 6 updated). `packages/contracts/wms/process-outbound.ts`'s header comment cites `13B-Schema-Reference-Consolidation.sql:164` as the version column's source, not a migration number.
10. **Events this part publishes** (already in `packages/events/catalog.ts`, frozen, confirmed present): `wms.outbound.drafted`, `wms.outbound.checks_started`, `wms.outbound.credit_rejected`, `wms.outbound.approved`, `wms.outbound.cancelled` (verify presence; if any is missing, STOP and report — new catalog entries are a Master task, this use-case lock cannot write `packages/events/catalog.ts`).

## Scenario (Gherkin — pg-tester pastes into `process-outbound.feature`)
```gherkin
Feature: Process outbound order — part 1: create, ten-condition check, approve, cancel (WBS 2.11)
  As the warehouse system, create a draft outbound order, run nine of the ten pre-dispatch
  conditions (the tenth is blocked, no schema source), let WH_MGR approve, and allow cancellation
  before allocation exists

  Background:
    Given entity PST, a qualified account "ACC-OUT" with an active priced contract, seeded
      services including OF-01, a warehouse with locations, and a WH_MGR user

  Scenario: Create a draft order
    When CreateOutbound is called for ACC-OUT
    Then status is "draft", version 1, doc_no from the OUT series

  Scenario: All nine conditions pass — reaches checks_pending
    Given every condition's prerequisite is satisfied
    When RunOutboundChecks is called
    Then status is "checks_pending", credit_check_passed is true

  Scenario: Condition 1 fails — expired contract
  Scenario: Condition 2 fails — credit hold moves the order to its own status, not a thrown error
    Given ACC-OUT is on credit hold with reason "overdue"
    When RunOutboundChecks is called
    Then status becomes "credit_rejected", credit_check_passed is false, the reason is recorded

  Scenario: Condition 3 fails — insufficient stock
  Scenario: Condition 4 fails — SKU belongs to a different client
  Scenario: Condition 5 fails — remaining shelf life too short
  Scenario: Condition 6 fails — SKU blocked
  Scenario: Condition 7 fails — every candidate location is blocked
  Scenario: Condition 8 fails — delivery order with an incomplete address
  Scenario: Condition 9 fails — no price for OF-01 in the client's contract
  Scenario: Condition 10 is never evaluated — documents the deliberate gap

  Scenario: WH_MGR approves a checks_pending order
    When ApproveOutbound is called
    Then status is "approved"

  Scenario: Cancelling a draft/checks_pending/credit_rejected/approved order
    When CancelOutbound is called with a reason
    Then status is "cancelled"

  Scenario: Cancel from an unreachable status is illegal (part 2's statuses don't exist yet)
  Scenario: Stale version is rejected on every mutating command
  Scenario: An unknown order is rejected
  Scenario: Idempotent replay and conflicting replay
  Scenario: RLS — a caller scoped to another entity cannot see or write the order
```

## Contract — `packages/contracts/wms/process-outbound.ts`
One `<Command>InputSchema` per command (`CreateOutboundInputSchema`, `RunOutboundChecksInputSchema`, `ApproveOutboundInputSchema`, `CancelOutboundInputSchema`), `.meta({id})` each. (`AllocateInputSchema`/`GeneratePickListInputSchema` are part 2's — do not add them here.)

## Deliver
- `packages/contracts/wms/process-outbound.ts` (four schemas only)
- `modules/wms/domain/process-outbound/{errors.ts, machine.ts}`
- `modules/wms/application/process-outbound/{ports.ts, index.ts, create-outbound.ts, run-outbound-checks.ts, approve-outbound.ts, cancel-outbound.ts}`
- `modules/wms/infrastructure/process-outbound/{repository.ts, logger.ts}`
- `modules/wms/api/process-outbound/{composition.ts, handlers.ts}`
- `modules/wms/tests/process-outbound/{process-outbound.feature, process-outbound.test.ts, process-outbound-machine.unit.test.ts, handlers.test.ts}`
- `modules/wms/index.ts` (barrel, extended) · NO migration file (see Master decision 9 — 0022 withdrawn, column already exists in 13B)

Migration number: **none** — 0022 was issued, then found redundant and returned unused (MIGRATION-REQUEST-1.md #6, pg-reviewer pre-migration FAIL round 1 finding 3).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent. (Condition 10 is the one live example this part already tracks.)

## Fix round 1 (pg-reviewer FAIL, 16 findings — 2026-09-25)
Findings 1,6(test asserts),9(test asserts),10,11(property tests),12,13,14,15 → pg-tester.
Findings 4,5,6(repo/params),7,8,9(result shape),11(move logic to domain/process-outbound/invariants.ts) → pg-backend.
Findings 2,3,16 → resolved by the lane session (this file + MIGRATION-REQUEST-1.md; guard G1 cleanup routed to pg-tester's fixture fix + Master/GM for the already-leaked shared-DB rows).
The RLS scenario (point 10 of the review) stays RED, tracked as SCR-RLS-03/D-181 (migration 0025_M, Master-owned) — not a fix-round item, but the scenario must run green before the closing review per the reviewer's sequencing note (0025_M merges first, lane rebases).
