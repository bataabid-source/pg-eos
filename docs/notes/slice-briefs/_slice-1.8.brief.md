# SLICE BRIEF — WBS 1.8 · Group-level credit limit and hold

Task: 1.8 — Group-level credit limit and hold      Lane: 1      Lock: `sales` (tasks/LANE_LOCKS.md, D-176) + `packages/contracts/sales/` (lane-owned)
Owner: CFO      Deps: 1.5 DONE (proof, `f790da7`, `sales.accounts` schema)      Worktree: `../pg-eos-lane-1`, branch `lane/1` (on origin/main `e3ced50`)
Model routing (D-174): pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
Use case (kebab): **`manage-account-credit`** — scaffolded by `scripts/new-slice.sh sales manage-account-credit` (already run; `pnpm install` done; scaffold self-registers contracts export/include).

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, batched for the GM)
- **`sales.accounts` has no `version` column** — a mutable aggregate (`credit_limit`/`credit_hold`/`hold_reason` all get updated) needs one per CLAUDE.md ARCHITECTURE. Migration requested: `tasks/backlog/MIGRATION-REQUEST-1.md` #4, replica of 0008/0013/0017/0019. **The lane session writes this migration only after the Master issues the number and pg-reviewer's pre-migration review passes.**
- **Genuinely group-level, not entity-scoped.** `sales.accounts` has no `entity_id` column at all (unlike `contracts`/`quotes`) — credit is one number and one flag per account, consumed across every operating entity (PCC, PST, PDL, POR; PGH is the holding entity, never operating). Every command and the guard function this slice builds take NO `entityId` parameter — this is the structural proof of "group-level", not an oversight.
- **The automatic hold-trigger is DEFERRED**, same reasoning as WBS 1.6/1.7's deferred scheduling mechanisms. Doc 40 §A2 / D-blueprint 02 §4.5 step 6 says credit_hold is set "تلقائياً" (automatically) when exposure exceeds `credit_limit` or payment runs past the term — but that calculation needs AR/overdue-invoice data from `billing.*`, a schema with no tables built yet in this workspace (Phase 4 territory, a different module/phase entirely). This slice builds `SetCreditHold` as a MANUAL command (CFO or GM) — a human stand-in for the future automatic trigger, same pattern as WBS 1.7's manual `ExpireContract` standing in for a scheduler. Batched GM question: authorise the automatic-trigger slice once `billing.*` exists.
- **Releasing a hold is human-only, by rule** (D-blueprint 02 §4.5 step 7, verbatim: "رفع الحجز يبقى بشرياً — GM أو CFO بسبب مسجَّل ومدة محددة" — "releasing stays human — GM or CFO, with a recorded reason and a fixed duration"). `ReleaseCreditHold` requires role GM or CFO and a non-empty `reason`. **No "duration" field exists on `sales.accounts`** (only `hold_reason`/`hold_set_by`/`hold_set_at`, all about the HOLD, not a release) — inventing a new column for "duration" would be a G-01 item this brief does not file, since the doc gives no column name or table for it. Default: the release reason itself may state a review date in free text; no structured expiry is enforced. Batched GM question: should a structured "review by" date be added to `sales.accounts` in a future schema-change request?
- **No "credit consumed"/usage calculation.** Nothing in 01/13/13B computes a running AR balance per account — that lives entirely in the not-yet-built `billing.*` schema. `credit_limit` is therefore a settable ceiling this slice stores and exposes, but no command in this slice compares it against a usage figure (there is none to compare against yet). The acceptance line is specifically about the HOLD FLAG blocking orders, not about automatic threshold detection — this scope split matches the doc's own wording precisely ("Hold blocks orders", not "credit limit blocks orders").
- **"Order on hold rejected" has no real consumer yet**, same situation as WBS 1.7's `getContractForOrder`: no `sales.orders`/order-placing path exists in any locked module. This slice builds the reusable guard — `assertAccountCreditOk` (domain, pure) plus `getAccountCreditStatus(ctx, { accountId })` (application, read-only) — that a future order-placing slice calls, exactly like 1.7's contract guard. The Gherkin proves "blocks in all four entities" by calling the guard under four DIFFERENT entity contexts against the SAME account and showing the rejection is identical every time (since the check never looks at `entityId` at all — group-level by construction, not by a repeated per-entity check).
- **`SetCreditLimit` accepts zero** — WBS doc 40's own S7 scenario names a legitimate trial client with `credit_limit = 0` (SEG-F, list prices, no discount) — zero is a valid, deliberate value, not an error.
- **`accounts.status` (active/suspended/closed) is untouched by this slice** — D-blueprint 02 explicitly separates it from `credit_hold` ("مستقل عن credit_hold" — independent of credit_hold, line 943). No command here reads or writes `status`.

## Read ONLY (workers) — kept under the 12-file / 1,500-line budget
1. `CLAUDE.md`
2. `.claude/briefs/sales.brief.md`
3. golden slice, SHAPE ONLY: `modules/wms/{domain,application,infrastructure,api}/receive-inbound/*`
4. **Nearer business-shape precedent** (pre-authorized): `modules/sales/{domain,application,infrastructure,api}/manage-contract/*` — reuse its machine-tag idiom (adapted: this slice's "machine" is a two-value boolean flag, not a multi-state enum — see decision 1), version-lock pattern, `getContractForOrder`'s read-only-guard shape (the direct model for `getAccountCreditStatus`), and composition/repository shape directly.
5. `database/schema/01-Data-Model.sql` 420-444 (`sales.accounts` — verbatim DDL, the ONLY columns that exist)
6. `docs/package/40-Build-Specification-EN.md` 48, 204-206 (§A2 group-level credit rule + §C2 entities, quoted below) and 484-490 (Feature S6, the worked scenario, verbatim)
7. `docs/package/D-blueprints/02-Financial-Accounting.md` 97 (ownership row), 300-321 (§4.5 the credit-hold flow, steps 6-7, quoted below), 353 ("group-level" rule table row), 943 (status independence)
8. `database/migrations/0019_1_contracts-version.sql` (the version-column precedent) and `database/migrations/NNNN_1_accounts-version.sql` once issued
9. `packages/db/src/idempotency.ts` · `packages/db/index.ts` · `packages/events/src/outbox.ts` · `packages/domain-kit/index.ts`
10. `modules/sales/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts, index.ts}` (the extended shell)
Fixture precedent (pg-tester only): `modules/sales/tests/manage-contract/manage-contract.test.ts` 1-40 (fixture pattern already established in THIS module).

## Write ONLY
- pg-tester: `modules/sales/tests/manage-account-credit/*` · nothing else.
- pg-backend: `modules/sales/{domain,application,infrastructure,api}/manage-account-credit/*` · `modules/sales/index.ts` (extend barrel) · `packages/contracts/sales/manage-account-credit.ts` · `modules/sales/package.json` (deps only if missing, then `pnpm install`).
- Lane session only: `database/migrations/NNNN_1_accounts-version.sql` (after the Master's number + pg-reviewer PASS) · `tasks/backlog/MIGRATION-REQUEST-1.md` · this brief.
Forbidden for every worker: `database/schema/**`, `packages/**` other than `packages/contracts/sales/`, `packages/events/catalog.ts`, other-module schema or code, `docs/**`, `scripts/**`, `CLAUDE.md`, `.claude/**`. A test defect goes back to pg-tester; pg-backend never edits a test.

## Acceptance criterion (doc 38 row 1.8, verbatim)
"Hold blocks orders in all four entities"
Gates: `pnpm --filter @pg-eos/sales typecheck && lint && test` green as `pgeos_app` · `pnpm guards:run` green (verify on an isolated DB built from this branch's own migrations) · pg-reviewer PASS (pre-migration + slice review).

## Doc 40 §A2 (verbatim, line 48)
`credit_limit` and `credit_hold` live on `sales.accounts` (group level). A hold blocks new outbound orders, delivery tasks and CC queues in **all** entities.

## Doc 40 Feature S6 (verbatim, lines 484-490)
```
Feature: S6 Multi-entity client
  Scenario: Group-level hold blocks all entities
    Given client "RETAIL" has contracts with PST, PDL and PCC and credit_limit 15000
    And an overdue PST invoice pushes exposure above the limit
    When the nightly job runs
    Then credit_hold = true
    And a new PST outbound order is rejected with reason "credit hold"
    And a new PDL delivery task is rejected with the same reason
    And a new PCC queue for "RETAIL" is rejected
```
(The "nightly job" and the three downstream rejections — outbound order, delivery task, CC queue — belong to other modules/phases not yet built; this slice proves the underlying `sales.accounts.credit_hold` mechanism and its guard function only, per Scope above.)

## D-blueprint 02 §4.5 (verbatim, steps 6-7)
6. الحجز الائتماني **تلقائي** عند تجاوز `credit_limit` أو تأخر يفوق المهلة → `sales.accounts.credit_hold = true` — ويمنع أوامر الصرف الجديدة ومهام التوصيل وطوابير الكول سنتر **في الكيانات الأربعة معاً** (S6).
7. **رفع الحجز يبقى بشرياً** — `GM` أو `CFO` بسبب مسجَّل **ومدة محددة**.

## Master decisions the workers copy (not re-derive)
1. **No XState machine.** `credit_hold` is a two-value boolean, not a multi-state enum — CLAUDE.md's "no if/switch for state transitions — XState" governs TRANSITIONS between named states; a boolean flag flip with a role/version gate is not that kind of state machine (same reasoning already applied to WBS 1.4's pure resolver, which has no machine either). `assertAccountCreditOk` is a plain predicate: `if (account.creditHold) throw new AccountOnCreditHoldError(...)` — this is NOT the "if/switch on state" the rule forbids (there is no enum of states to switch over, only a boolean fact to check), and is the same shape as every other invariant-assert function in this codebase (e.g. `assertQuoteEditable`'s underlying tag check still compiles down to a boolean test — the rule's target is hidden business logic inside a status-string comparison chain, not a single boolean predicate on a genuinely two-valued fact). pg-reviewer: confirm this reasoning holds; if not, the fallback is a trivial two-state machine (`held`/`clear`) with a tag — flag as an open question if disputed, do not block the round.
2. **`SetCreditLimit`** (CFO): `accountId`, `creditLimit` (numeric(14,3) string, `>= 0` — zero legal per S7). Locks the account row `for update`, checks `expectedVersion`, bumps `version`. No floor/ceiling beyond non-negative — no rule anywhere sets a minimum.
3. **`SetCreditHold`** (CFO or GM — a human stand-in for the deferred automatic trigger): `accountId`, `reason` (non-empty string, required — mirrors `hold_reason`'s purpose), `expectedVersion`. Sets `credit_hold = true`, `hold_reason = reason`, `hold_set_by = ctx.userId`, `hold_set_at = clock.now()`. Idempotent in EFFECT but not in STATUS-CHECK: calling it again while already on hold is legal (updates the reason/who/when) — no `AlreadyOnHoldError` invented, since the doc describes no such rule.
4. **`ReleaseCreditHold`** (role GM or CFO ONLY — D-blueprint 02 §4.5 step 7 is explicit that release "stays human"; this is the one place in the slice where CFO is NOT sufficient on its own to differ from `SetCreditHold` — actually both commands accept CFO or GM equally per the literal text, which names "GM أو CFO" for release specifically and leaves the automatic-trigger stand-in role unstated for setting a hold, so `SetCreditHold` defaults to the SAME CFO-or-GM gate for consistency, recorded as a default): `accountId`, `reason` (non-empty, required), `expectedVersion`. Sets `credit_hold = false`, `hold_reason = reason` (overwritten with the release's own reason — the last word on WHY the account is in its current state, matching how `hold_reason` has always described the CURRENT fact, not a history), `hold_set_by = ctx.userId`, `hold_set_at = clock.now()`. Rejecting a release attempt on an account that is NOT currently on hold: `NotOnHoldError` (a genuine no-op the caller should notice, unlike re-setting an existing hold).
5. **`getAccountCreditStatus`** (read-only, no lock, no `entityId` parameter — see Scope): given `{ accountId }`, returns `{ accountId, creditLimit, creditHold }` when `creditHold` is false, or throws `AccountOnCreditHoldError { accountId, reason }` when `creditHold` is true. `AccountNotFoundError` when the account doesn't resolve under RLS (never a leaked 403).
6. **Actor:** always `ctx.userId`; no `performedBy`/`setBy` input field (the DB column `hold_set_by` is populated FROM `ctx.userId`, never supplied by the caller).
7. **Idempotency:** every write handler (`SetCreditLimit`, `SetCreditHold`, `ReleaseCreditHold`) builds `IdempotencyInput`; endpoints `sales.manage-account-credit.{set-credit-limit, set-credit-hold, release-credit-hold}`. `getAccountCreditStatus` is read-only, no handler, no Idempotency-Key (same as 1.7's `getContractForOrder`).
8. **Errors → Problem statuses**, same convention as 1.2/1.6/1.7: Zod → 400; `StaleVersionError`/`IdempotencyConflictError` → 409; every other typed domain error → 422; unknown → 500 logged via pino.
9. **No outbox event this slice.** Neither doc 40 §C2's event list nor §A2 names a `sales.account.hold_set`/`credit.hold_released` event with a known consumer (§C2's list names `sales.account.hold_set` — but per the same recorded reasoning as WBS 1.7's deferred `contract.signed`, no consumer exists yet in a locked module; batched GM question on whether to add it now, same as 1.7's open item, not a re-argument — this repeats the exact default 1.7 already established, so it is NOT itself a new open question, just consistent practice).
10. **Migration** (`database/migrations/NNNN_1_accounts-version.sql`) is the ONLY schema change: `alter table sales.accounts add column if not exists version int not null default 1;` + comment + `identity.column_classification` row `('sales','accounts','version','public')` — verbatim replica of 0008/0013/0017/0019.

## Scenario (Gherkin — pg-tester pastes into `manage-account-credit.feature` and executes 1:1)
```gherkin
Feature: Manage account credit (WBS 1.8, group-level credit limit and hold)
  As the CFO I set a group-level credit limit and can place or release a hold that blocks a
  future order-placing path in every operating entity, because the account carries no entity_id
  at all

  Background:
    Given a qualified account "ACC-1" (no entity scoping — the account itself has no entity_id
      column), a CFO user, a GM user, and a SALES_REP user (none of whom hold CFO/GM)

  Scenario: Set the group-level credit limit
    When SetCreditLimit is called for ACC-1 with creditLimit 15000.000
    Then sales.accounts.credit_limit is 15000.000, version bumped

  Scenario: A zero credit limit is legal (S7 trial-client case)
    When SetCreditLimit is called with creditLimit 0
    Then it succeeds, credit_limit is 0.000

  Scenario: A negative credit limit is rejected
    When SetCreditLimit is called with creditLimit -1
    Then it is rejected at the contract (400)

  Scenario: CFO places a hold with a reason
    When SetCreditHold is called by the CFO with reason "overdue PST invoice above limit"
    Then credit_hold is true, hold_reason matches, hold_set_by is the CFO's id, hold_set_at is set

  Scenario: A non-CFO/GM cannot place a hold
    When SetCreditHold is called by the SALES_REP
    Then it is rejected with RoleRequiredError

  Scenario: A hold reason is required
    When SetCreditHold is called with an empty reason
    Then it is rejected at the contract (400)

  Scenario: The guard blocks the account the SAME way from all four entity contexts (the
    acceptance line — S6)
    Given the account is on hold
    When getAccountCreditStatus is called for ACC-1 under a PST context, then under a PDL
      context, then under a PCC context, then under a POR context
    Then EVERY call is rejected with AccountOnCreditHoldError carrying the same reason — the
      guard never once consults which entity is asking

  Scenario: The guard passes when there is no hold
    Given the account is not on hold
    When getAccountCreditStatus is called
    Then it returns { accountId, creditLimit, creditHold: false }

  Scenario: Only GM or CFO can release a hold
    When ReleaseCreditHold is called by the SALES_REP
    Then it is rejected with RoleRequiredError

  Scenario: GM releases a hold with a reason
    Given the account is on hold
    When ReleaseCreditHold is called by the GM with reason "payment received, exposure cleared"
    Then credit_hold is false, hold_reason matches the release reason, hold_set_by is the GM's id

  Scenario: CFO can also release a hold
    Given the account is on hold
    When ReleaseCreditHold is called by the CFO
    Then it succeeds

  Scenario: Releasing a hold that isn't there is rejected
    Given the account is NOT on hold
    When ReleaseCreditHold is called
    Then it is rejected with NotOnHoldError

  Scenario: Re-placing a hold that is already active updates the reason
    Given the account is already on hold with reason "A"
    When SetCreditHold is called again with reason "B"
    Then credit_hold is still true, hold_reason is now "B", version bumped

  Scenario: Stale version is rejected on every mutating command
    When any mutating command is called with a stale expectedVersion
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: An unknown account is rejected
    When any command is called with an accountId that does not exist
    Then it is rejected with AccountNotFoundError

  Scenario: Idempotent replay and conflicting replay
    When a write is replayed with the same Idempotency-Key and body
    Then the stored response is returned and no second row is written
    When the same key is sent with a different body
    Then IdempotencyConflictError (409)

  Scenario: RLS — a caller who cannot see the account gets a not-found, never a leaked artifact
    When the same commands run as a user without visibility into ACC-1
    Then the account is not found and nothing is written
```

## Contract — `packages/contracts/sales/manage-account-credit.ts`
`SetCreditLimitInputSchema` (`accountId` uuid, `creditLimit` non-negative numeric(14,3) string — reuse the `NON_NEGATIVE_QUANTITY`-style regex from 1.2, never `Number()`, `expectedVersion` int ≥ 1, `correlationId` uuid), `SetCreditHoldInputSchema` (`accountId`, `reason` non-empty string, `expectedVersion`, `correlationId`), `ReleaseCreditHoldInputSchema` (same shape as `SetCreditHoldInputSchema`), each `.meta({id})`.

## Deliver (mirrors the manage-contract tree, minus the machine files)
- `packages/contracts/sales/manage-account-credit.ts`
- `modules/sales/domain/manage-account-credit/{errors.ts, invariants.ts}`
- `modules/sales/application/manage-account-credit/{ports.ts, index.ts, set-credit-limit.ts, set-credit-hold.ts, release-credit-hold.ts, get-account-credit-status.ts}`
- `modules/sales/infrastructure/manage-account-credit/{repository.ts, logger.ts}`
- `modules/sales/api/manage-account-credit/{composition.ts, handlers.ts}`
- `modules/sales/tests/manage-account-credit/{manage-account-credit.feature, manage-account-credit.test.ts, invariants.property.test.ts, handlers.test.ts}`
- `modules/sales/index.ts` (barrel, extended) · `database/migrations/NNNN_1_accounts-version.sql` (lane session, after pre-migration review)

Migration number: pending (MIGRATION-REQUEST-1.md #4, requested from the Master).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent.
