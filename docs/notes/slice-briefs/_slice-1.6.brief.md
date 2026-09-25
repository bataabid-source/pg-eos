# SLICE BRIEF — WBS 1.6 · M02 quotes with approval flow (rep → sales mgr → CFO → GM on exception)

Task: 1.6 — M02: quotes with approval flow      Lane: 1      Lock: `sales` (tasks/LANE_LOCKS.md, D-176) + `packages/contracts/sales/` (lane-owned)
Owner: CFO      Deps: 1.4 DONE (`d0ec957`, informational only — not called by this slice, see Scope), 1.5 DONE (proof, `f790da7`, `sales.accounts` schema)      Worktree: `../pg-eos-lane-1`, branch `lane/1` (on origin/main `b21d89a`)
Model routing (D-174): pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
Use case (kebab): **`manage-quote`** — scaffolded by `scripts/new-slice.sh sales manage-quote` (already run; `pnpm install` done; the scaffold self-registered the contracts export/include, no Master hand-off needed).

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, batched for the GM)
- **`sales.quotes` has no `version` column** — a new mutable aggregate (real 8-value state machine) needs one per CLAUDE.md ARCHITECTURE. Migration requested: `tasks/backlog/MIGRATION-REQUEST-1.md` #2, replica of 0008/0013. **The lane session writes this migration only after the Master issues the number and pg-reviewer's pre-migration review passes** — do not delegate the migration file itself to a worker.
- **1.4's `resolvePrice` is NOT called by this slice.** D-blueprint 02 §162 is explicit: a quote line stores `min_price_at_quote` — a snapshot of `catalog.services.min_price` at write time, the SAME floor reference 1.2 already uses, not a resolved contract/segment/standard-list price. `unit_price` is an input the rep supplies (a future UI may call 1.4's engine to pre-fill it, out of scope here). This removes an unnecessary dependency on 1.4 despite doc 38 listing it — 1.6's only real schema dependency is 1.2 (catalog) and 1.5 (accounts, already proof-built).
- **`ExpireQuote` is deferred**, same reasoning as 1.2's deferred `SetServiceCost` and 5.13's part-1/part-2 split: expiry is a scheduling concern (who calls it, and when, is a job-wiring question with no acceptance line here) with no test in doc 38's acceptance criterion. The `expired` status value stays legal in the DB and the domain machine's type, just unreached by any command this slice ships. Batched GM question: authorise a follow-up mechanism slice once a scheduler exists (precedent: 5.13 part 2).
- **`RecordDecision`** (client accepts/rejects a sent quote) and **`ReturnToDraft`** (a reviewer kicks a quote back for edits — the only way to leave `commercial_review`/`finance_review` backward, since the 8-value enum has no separate "returned" status) ARE in scope: doc 40 §C2's own state machine names `accepted | rejected` as terminal exits from `sent`, and a reviewer needs a literal path to reject-and-request-changes without inventing a 9th status.
- **The generic `platform.approval_chains`/`admin.approval_requests` mechanism is NOT used.** `approval_chains` has no seeded row for `request_type = 'quote'` (only purchase/invoice/credit_note/price_exception/penalty) — quotes have their own fixed-role, fixed-step machine per doc 40 §C2's literal text ("Roles: SALES_REP creates; SALES_MGR → finance_review; CFO → approved"), not an amount-tiered chain. `admin.approval_requests`/`admin.approval_steps` live in schema `admin`, a different module with no lock held by this lane — never touched.
- **"GM on exception" and the margin gate are the SAME transition's role escalation, not a separate GM step.** Doc 40 §C2: "GM required if any line has an exception." D-blueprint 02 §165: "under 10% [margin] is not approved except by GM." Both gate the finance_review→approved transition (`ApproveFinance`): the normal actor is CFO; if EITHER condition holds, the actor must be GM instead (CFO alone is refused). No new GM-specific command exists — GM re-uses `ApproveFinance` with their own role. (The GM's approval of a below-floor EXCEPTION ITSELF already happened earlier, via 1.2's `GrantPriceException` — this slice only verifies a cited `exception_id` is real, valid, and GM-approved; it never grants one.)
- **`sales.quote.approved`** (doc 40 §C2's own named event) is published via `writeOutboxEvent` with a string-literal event type, same as 1.2's `catalog.price_list.activated` — NOT added to the frozen `packages/events/catalog.ts` (that list governs consumption, not publication; the Master adds the name when a consumer appears, same precedent).
- **"Edit creates new version"** (the acceptance line): no revision-link column exists on `sales.quotes` (no `supersedes_quote_id`/`revision_of` — not inventing one). `ReviseQuote` creates a brand-new independent quote row (new `doc_no` from the same `QTE` series, status `draft`) copying the frozen source's account/opportunity/currency/terms/lines. Traceability beyond sharing `opportunity_id` is out of scope (no G-01 item — nothing in 01/13/13B/019/40 asks for a link column).
- **Lines are mutable only while status is `draft`** (same "lines only on draft" pattern as 1.2's price lists) — `commercial_review`/`finance_review`/`approved` are read-only for lines; a reviewer who wants changes calls `ReturnToDraft` first. `sent`/`accepted`/`rejected`/`expired` reject EVERY mutating command with `QuoteFrozenError`, steering the caller to `ReviseQuote`.

## Read ONLY (workers) — kept under the 12-file / 1,500-line budget
1. `CLAUDE.md`
2. `.claude/briefs/sales.brief.md` (+ `.claude/briefs/catalog.brief.md` §2 for `services.min_price`/`standard_cost` — already read for 1.2/1.4, cite by column name)
3. golden slice, SHAPE ONLY: `modules/wms/{domain,application,infrastructure,api}/receive-inbound/*` (layering, ports, typed errors, `withIdempotentContext`, audit-in-transaction, outbox-in-transaction)
4. **Nearer business-shape precedent** (more relevant than the golden slice for a floor-check + exception + XState + version-lock CRUD use case): `modules/catalog/{domain,application,infrastructure,api}/maintain-price-list/*` — reuse its floor/exception-check pattern, its `assertListEditable`-via-machine-tag idiom (round-2 reviewer fix from 1.2 — no if/switch on status), and its repository/composition shape almost directly
5. `database/schema/01-Data-Model.sql` 420-582 (`sales.accounts`, `sales.quotes`, `sales.quote_lines` — verbatim DDL, the ONLY columns that exist, including the `below_min_needs_exception` CHECK and the generated `below_min` column) and 338-412 (`catalog.services`/`price_exceptions` — reused from 1.2)
6. `database/schema/13B-Schema-Reference-Consolidation.sql` 2314-2316 (`chk_quotes_status`, the 8-value enum, verbatim)
7. `docs/package/40-Build-Specification-EN.md` 204-217 (§C2 entities, state machines, invariants, events — quoted below)
8. `docs/package/D-blueprints/02-Financial-Accounting.md` 160-165, 200-204 (quote-build steps, margin-threshold rule, status table — quoted below)
9. `database/migrations/0013_1_price-lists-version.sql` (the version-column precedent this slice's migration replicates) and `database/migrations/NNNN_1_quotes-version.sql` once issued
10. `packages/db/src/idempotency.ts` · `packages/db/index.ts` (`withContext`, `WithContextCtx`) · `packages/events/src/outbox.ts` (`writeOutboxEvent`) · `packages/domain-kit/index.ts` (`Money`, `Quantity`, `Clock`, `IdGenerator`)
11. `modules/sales/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts, index.ts}` (the scaffolded shell)
Fixture precedent (pg-tester only): `modules/catalog/tests/maintain-price-list/maintain-price-list.test.ts` 1-40 (admin-pool fixture pattern, `PG_APP_USER=pgeos_app`).

## Write ONLY
- pg-tester: `modules/sales/tests/manage-quote/*` · nothing else.
- pg-backend: `modules/sales/{domain,application,infrastructure,api}/manage-quote/*` · `modules/sales/index.ts` · `packages/contracts/sales/manage-quote.ts` · `modules/sales/package.json` (deps only if the scaffold lacks one, then `pnpm install`).
- Lane session only: `database/migrations/NNNN_1_quotes-version.sql` (after the Master's number + pg-reviewer's pre-migration PASS) · `tasks/backlog/MIGRATION-REQUEST-1.md` · this brief.
Forbidden for every worker: `database/schema/**`, `packages/**` other than `packages/contracts/sales/`, `packages/events/catalog.ts`, `docs/**`, `scripts/**`, `admin` schema/module, any other module, `CLAUDE.md`, `.claude/**`. A test defect goes back to pg-tester; pg-backend never edits a test.

## Acceptance criterion (doc 38 row 1.6, verbatim)
"Sent quote is frozen; edit creates new version"
Gates: `pnpm --filter @pg-eos/sales typecheck && lint && test` green as `pgeos_app` · `pnpm guards:run` green (verify on an isolated DB built from this branch's own migrations, per 0.19/1.4's close-out precedent) · pg-reviewer PASS (both the pre-migration review and the slice review).

## Doc 40 §C2 (verbatim, lines 204-217)
**State machines:** Quote: `draft → finance_review → approved → sent → accepted | rejected | expired`. Roles: SALES_REP creates; SALES_MGR → finance_review; CFO → approved; GM required if any line has an exception. `sent` is frozen; edit creates a new version.
**Invariants:** INV-C2-1 No quote without a qualified account with `cr_number`. INV-C2-3 Duplicate detection on `cr_number` and name similarity ≥ 0.85 (pg_trgm); merge, never delete a record with transactions.
**Events:** `sales.quote.approved`.
(The DB's own `chk_quotes_status` also legalises an intermediate `commercial_review` status between `draft` and `finance_review` — doc 40's prose compresses "SALES_MGR → finance_review" into one arrow; this brief's decision 2 below spells out the full 8-status path the DB actually enforces.)

## D-blueprint 02 (verbatim, lines 162-165, 200-204)
1. `SALES_REP` يبني العرض · شاشة العرض · `sales.quotes` بحالة `draft`، وكل سطر في `sales.quote_lines` يخزّن `min_price_at_quote` وقت البناء.
2. عند الحفظ يُحسب العمود المولَّد `below_min = unit_price < min_price_at_quote`، ويرفض القيد `below_min_needs_exception` أي سطر تحت الحد **بلا `exception_id`** — على **كل مسارات الكتابة**.
4. الهامش المقدَّر يُحسب في `sales.quotes.estimated_margin_pct`: تحت **15%** تحذير بارز، وتحت **10%** لا يُعتمد إلا من **`GM`**.
| حالات العرض | `chk_quotes_status` | `draft · commercial_review · finance_review · approved · sent · accepted · rejected · expired` | STATE-REGISTER §1 |

## Master decisions the workers copy (not re-derive)
1. **Machine (XState v5, `.can()`/tags only — no if/switch on status):** `QUOTE_STATUS` verbatim from `chk_quotes_status` (8 values). Legal edges: `draft --SUBMIT_FOR_REVIEW--> commercial_review`, `commercial_review --APPROVE_COMMERCIAL--> finance_review`, `commercial_review --RETURN_TO_DRAFT--> draft`, `finance_review --APPROVE_FINANCE--> approved`, `finance_review --RETURN_TO_DRAFT--> draft`, `approved --SEND_QUOTE--> sent`, `sent --RECORD_DECISION(accepted|rejected)--> accepted|rejected`. `draft` is tagged `editable` (lines mutable); `expired` is a legal status value with no producing edge in this slice (decision on ExpireQuote deferral above).
2. **`CreateQuote`** (role SALES_REP): `entityId`, `accountId` (must resolve via `withContext` RLS — a cross-entity account is invisible, surfaces as `AccountNotFoundError`, never leaked), `opportunityId?`, `validUntil` (date, must be `>= today` — injected Clock), `currency` default `KWD`, `termsAr?`, `termsEn?`. INV-C2-1: the account must exist, `status != 'closed'`, `cr_number is not null` — else `AccountNotQualifiedError`. Status `draft`, `version` 1, `subtotal`/`discountAmt`/`total` 0, `estimatedMarginPct` null. `doc_no` via `platform.next_doc_no(entityId, 'QTE')` (never formatted in application code).
3. **`UpsertQuoteLine`** (role SALES_REP or SALES_MGR — same actors who may touch a draft quote; role gate is "any internal user who can see the quote via RLS", not a named-role check, since line-building is not itself a review gate): requires `status` tagged `editable` (else `QuoteFrozenError`, steering to `ReviseQuote`); locks the quote row `for update`, checks `expectedVersion` (`StaleVersionError`); `serviceId` must exist and be active (`ServiceNotFoundError`); reads `catalog.services.min_price` fresh into `min_price_at_quote` (a snapshot, per the D-blueprint — re-read on every upsert, not cached from a prior call); `qty` positive, `unitPrice` positive (contract-level, never `Number()`); if `unitPrice < min_price_at_quote` an `exceptionId` is REQUIRED (mirrors the DB CHECK, but checked in the domain BEFORE the write, same "domain guards before DB" pattern as 1.2) — the cited `catalog.price_exceptions` row must exist, match `(client_id=account_id, service_id)`, and be valid at today (`valid_from <= today <= valid_to`), else `InvalidPriceExceptionError`. Recomputes `line_total = qty × unit_price` (via `Money`), then recomputes the WHOLE quote's `subtotal` (sum of `line_total`), `total = subtotal − discount_amt`, and `estimated_margin_pct` (decision 5) in the same transaction; bumps `version`.
4. **`discountAmt`** is set only via `UpsertQuoteLine`'s sibling field on the input (a quote-level input, not a line field) — applied as a flat subtraction from `subtotal` for `total`; `discountAmt` must be `>= 0` and `<= subtotal` (`InvalidDiscountError`). (No separate `SetDiscount` command — bundling it into every line write keeps the CRUD surface small; recorded as a default.)
5. **Margin formula** (`domain/manage-quote/margin.ts`, pure): `estimatedMarginPct = subtotal.isZero() ? null : ((subtotal − sum(qty × standard_cost per line)) / subtotal) × 100`, rounded per `numeric(6,3)`. A line whose service has a null `standard_cost` contributes `0` cost for that line (never blocks the calc — margin is an estimate, not a gate by itself; the *gate* is the 10%/GM rule at decision 7). `marginWarning: boolean` (true when `0 <= estimatedMarginPct < 15`) is returned by `UpsertQuoteLine`'s result for a future UI to surface "under 15% — prominent warning" — not enforced as a rejection.
6. **`SubmitForReview`** (role SALES_REP, `draft → commercial_review`): re-checks INV-C2-1 (account still qualified) and requires at least one line (`EmptyQuoteError`); bumps version.
7. **`ApproveCommercial`** (role SALES_MGR, `commercial_review → finance_review`): no additional business check beyond the role/version/machine gates.
8. **`ApproveFinance`** (`finance_review → approved`): actor role CFO normally; **actor role must be GM instead** when EITHER any line has `exception_id is not null` OR `estimatedMarginPct < 10` (both re-checked live, not trusted from a stale read) — else `RoleRequiredError` names the role actually needed. On success: writes ONE outbox event `sales.quote.approved` (aggregate `sales.quotes`, payload `{ quoteId, entityId, accountId, total, estimatedMarginPct, approvedBy }`) + one audit row, same `correlation_id` (G9); sets `approved_by = ctx.userId`. `reviewed_by` is set by `ApproveCommercial` (decision 7) at that step, not here.
9. **`ReturnToDraft`** (role SALES_MGR from `commercial_review`, or CFO/GM from `finance_review`, `-> draft`): no business check; bumps version. (Legal per the machine even though doc 40's prose only shows forward arrows — the DB enum has no separate "returned" value, so returning to the existing `draft` value is the only board-compliant way to represent a rejection at an internal review step.)
10. **`SendQuote`** (`approved → sent`): sets `frozen_snapshot` (the whole quote + its lines, as JSON — the columns as they exist at this instant, never touched again), `sent_at = clock.now()`; no outbox event (doc 40 names only `sales.quote.approved`). After this, `sent`/`accepted`/`rejected`/`expired` reject every mutating command except `RecordDecision` (from `sent` only) with `QuoteFrozenError`.
11. **`RecordDecision`** (`sent → accepted | rejected`, role: any internal user who can see the quote — the client's own decision is recorded by staff, not entered directly by the client in this slice): `decision: 'accepted' | 'rejected'`, sets `decided_at = clock.now()`. No reason field exists on `sales.quotes` for a rejection (unlike `leads.lost_reason`) — none is invented.
12. **`ReviseQuote`** (any status EXCEPT `draft`/`commercial_review`/`finance_review` — i.e. `approved`/`sent`/`accepted`/`rejected`/`expired`, since those are exactly the states where "editing" the original is illegitimate and a caller instead wants a fresh start): creates a brand-new `sales.quotes` row, `status='draft'`, `version=1`, a fresh `doc_no` from the same `QTE` series, copying `entity_id`/`account_id`/`opportunity_id`/`currency`/`terms_ar`/`terms_en` from the source and cloning every `quote_lines` row (new ids, same `service_id`/`qty`/`unit_price`/`exception_id`, `min_price_at_quote` RE-READ fresh — not copied stale) into the new quote. Returns `{ newQuoteId, newDocNo }`. The source quote is untouched (still frozen at whatever status it was).
13. **Actor:** always `ctx.userId`; no `performedBy`/`preparedBy`/`approvedBy` input field anywhere — `prepared_by` is set by `CreateQuote` to `ctx.userId`.
14. **Idempotency:** every write handler builds `IdempotencyInput` from the required header + sha256 of the canonical body; endpoints `sales.manage-quote.{create-quote, upsert-quote-line, submit-for-review, approve-commercial, approve-finance, return-to-draft, send-quote, record-decision, revise-quote}`.
15. **Errors → Problem statuses**, same convention as 1.2's handlers: Zod → 400; `StaleVersionError`/`IdempotencyConflictError` → 409; every other typed domain error → 422; unknown → 500 logged via the pino adapter.
16. **Migration** (`database/migrations/NNNN_1_quotes-version.sql`) is the ONLY schema change: `alter table sales.quotes add column if not exists version int not null default 1;` + comment + `identity.column_classification` row `('sales','quotes','version','public')` — verbatim replica of 0008/0013.

## Scenario (Gherkin — pg-tester pastes into `manage-quote.feature` and executes 1:1)
```gherkin
Feature: Manage quote (WBS 1.6, M02 sales)
  As a sales rep I build a quote whose lines never go below floor without a GM-approved exception,
  route it through sales-manager and finance review, and once it is sent it is frozen — any further
  change creates a brand-new quote

  Background:
    Given entity PST, a qualified account "ACC-1" (cr_number set, status active), seeded services
      ST-01 (min_price set) and HD-04 (min_price set), a SALES_REP user, a SALES_MGR user, a CFO
      user and a GM user, all scoped to PST

  Scenario: Create a draft quote and add a line at or above the floor
    When CreateQuote is called by the SALES_REP for ACC-1
    Then a sales.quotes row exists, status "draft", version 1
    When UpsertQuoteLine is called for ST-01 at price = min_price(ST-01), qty 3
    Then the line exists, subtotal/total reflect qty*price, version is 2

  Scenario: A line below the floor is rejected without an exception
    When UpsertQuoteLine is called with price below min_price(ST-01) and no exceptionId
    Then it is rejected with InvalidPriceExceptionError and no line is written

  Scenario: A line below the floor is accepted with a valid GM-granted exception
    Given a GM-approved price_exception for ACC-1 / ST-01 below min_price, valid today
    When UpsertQuoteLine cites that exceptionId with the exception's approved price
    Then the line is written and below_min is true

  Scenario: An expired exception is rejected
    Given ACC-1's ST-01 exception's valid_to is yesterday
    When UpsertQuoteLine cites it
    Then it is rejected with InvalidPriceExceptionError

  Scenario: Submit for review requires at least one line
    When SubmitForReview is called on a quote with zero lines
    Then it is rejected with EmptyQuoteError

  Scenario: Full happy path to approved (no exception, healthy margin)
    When SubmitForReview then ApproveCommercial (SALES_MGR) then ApproveFinance (CFO) are called
    Then status ends "approved", exactly one "sales.quote.approved" outbox row and one audit row
      share a correlation_id

  Scenario: CFO cannot approve a quote with a below-floor exception line — only GM can
    Given the quote has one line with a valid exceptionId
    When ApproveFinance is called by the CFO
    Then it is rejected with RoleRequiredError
    When ApproveFinance is called by the GM
    Then it succeeds

  Scenario: CFO cannot approve a quote whose estimated margin is below 10% — only GM can
    Given the quote's lines yield estimatedMarginPct < 10
    When ApproveFinance is called by the CFO
    Then it is rejected with RoleRequiredError
    When ApproveFinance is called by the GM
    Then it succeeds

  Scenario: A sales manager returns a quote to draft for changes
    When ReturnToDraft is called from commercial_review
    Then status is "draft" and lines are editable again

  Scenario: Lines are frozen outside draft
    When UpsertQuoteLine is called while status is commercial_review
    Then it is rejected with QuoteFrozenError

  Scenario: Send freezes the quote
    Given status is "approved"
    When SendQuote is called
    Then status is "sent", frozen_snapshot is set, sent_at is set

  Scenario: Any edit after send is rejected and steered to revise
    When UpsertQuoteLine (or ApproveFinance, or SubmitForReview) is called on a "sent" quote
    Then it is rejected with QuoteFrozenError

  Scenario: Revising a sent quote creates a brand-new quote, untouched original
    When ReviseQuote is called on the sent quote
    Then a NEW quote exists with status "draft", a new doc_no, the same lines cloned (fresh
      min_price_at_quote), and the ORIGINAL quote's row is completely unchanged

  Scenario: Recording the client's decision
    When RecordDecision "accepted" is called on the sent quote
    Then status is "accepted" and decided_at is set

  Scenario: Stale version is rejected on every mutating command
    When any mutating command is called with a stale expectedVersion
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: An unqualified account is rejected at creation
    When CreateQuote is called for an account with no cr_number
    Then it is rejected with AccountNotQualifiedError

  Scenario: Idempotent replay and conflicting replay
    When a write is replayed with the same Idempotency-Key and body
    Then the stored response is returned and no second row is written
    When the same key is sent with a different body
    Then IdempotencyConflictError (409)

  Scenario: RLS — a caller scoped to another entity cannot see or write the quote
    When the same commands run as a user whose entity scope excludes PST
    Then the quote is not found and nothing is written
```
Property tests (fast-check, `margin.property.test.ts`): the margin formula never produces a value outside `[-100, 100+]` for arbitrary positive prices/costs/quantities (bounded by construction, not clamped), and `subtotal.isZero()` always yields `estimatedMarginPct = null`, never a division by zero.

## Contract — `packages/contracts/sales/manage-quote.ts`
One `<Command>InputSchema` per command (9: `CreateQuoteInputSchema`, `UpsertQuoteLineInputSchema`, `SubmitForReviewInputSchema`, `ApproveCommercialInputSchema`, `ApproveFinanceInputSchema`, `ReturnToDraftInputSchema`, `SendQuoteInputSchema`, `RecordDecisionInputSchema`, `ReviseQuoteInputSchema`), `.meta({id})` on each. Prices/qty/discount are positive (or non-negative for discount) numeric(14,3) strings, never `Number()` in the schema itself; `expectedVersion` int ≥ 1 on every quote-mutating command except `CreateQuote`/`ReviseQuote` (which create a NEW row); `correlationId` uuid; `RecordDecisionInputSchema.decision` is `z.enum(['accepted','rejected'])`.

## Deliver (mirrors the golden/catalog tree; names after the scaffold's rename)
- `packages/contracts/sales/manage-quote.ts`
- `modules/sales/domain/manage-quote/{errors.ts, machine.ts, invariants.ts, margin.ts}`
- `modules/sales/application/manage-quote/{ports.ts, index.ts, create-quote.ts, upsert-quote-line.ts, submit-for-review.ts, approve-commercial.ts, approve-finance.ts, return-to-draft.ts, send-quote.ts, record-decision.ts, revise-quote.ts}`
- `modules/sales/infrastructure/manage-quote/{repository.ts, logger.ts}`
- `modules/sales/api/manage-quote/{composition.ts, handlers.ts}`
- `modules/sales/tests/manage-quote/{manage-quote.feature, manage-quote.test.ts, quote-machine.unit.test.ts, margin.property.test.ts, handlers.test.ts}`
- `modules/sales/index.ts` (barrel, extended) · `database/migrations/NNNN_1_quotes-version.sql` (lane session, after pre-migration review)

Migration number: pending (MIGRATION-REQUEST-1.md #2, requested from the Master).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent.
