# SLICE BRIEF — WBS 1.9 · Customer 360 screen

Task: 1.9 — Customer 360 screen      Lane: 1      Lock: `sales` + `admin` (apps/admin) — BOTH claimed for lane 1 on this task (tasks/LANE_LOCKS.md, D-176/confirmed 2026-09-25) + `packages/contracts/sales/` (lane-owned)
Owner: SALES_MGR      Deps: 1.7 DONE (`e3ced50`)      Worktree: `../pg-eos-lane-1`, branch `lane/1` (on origin/main `7fa0c43`)
Model routing (D-174): pg-tester sonnet → pg-backend sonnet (data) → pg-frontend sonnet (UI) → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
Use case (kebab): **`customer-profile`** — scaffolded by `scripts/new-slice.sh sales customer-profile` (already run; `pnpm install` done). **No migration this slice** — every command is read-only, nothing is written anywhere.

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, batched for the GM)
- **The acceptance line narrows doc 06 §3's eight sections to four.** Doc 06 §3 (verbatim, quoted below) names eight sections: identity, contracting, operational readiness, live operations, finance, profitability, SLA, activity. Doc 38's own acceptance criterion is narrower: **"Shows contracts, readiness gaps with owners, finance, profitability placeholder"** — four sections. This brief builds exactly those four (contracts, readiness, finance, profitability-as-placeholder), plus a minimal identity HEADER (name/code/segment — the structural top-of-page strip doc 40 §D1's "profile" pattern requires for every profile screen, not a separate content section). **Deferred, not built:** live operations (needs `wms`/`tms`/`cc` data — different modules/phases), SLA section (needs `sales.sla_results`, explicitly out of scope per WBS 1.7's own brief), activity section (needs `sales.activities`/leads, not named in the acceptance line), contacts (part of doc 06's "identity" row, not the narrowed header). Batched GM question: authorise these as follow-up sections once their source modules exist.
- **Profitability is a literal placeholder — the acceptance line's own word.** No revenue/cost computation exists anywhere in this codebase (`billing.profitability` doesn't exist as a table with data yet; nothing flows into it). The result carries `{ available: false }` and nothing else — never a fabricated number.
- **Finance is what's actually available today, not what doc 06 lists.** Doc 06 §3's finance row says "الرصيد · أعمار الذمم · الحد الائتماني المتبقي · حالة الحجز" (balance, AR aging, remaining credit limit, hold status) — balance and AR aging need `billing.*` (not built). This slice shows exactly what WBS 1.8 already computes: `creditLimit`, `creditHold`, `holdReason`. "Remaining" credit (limit minus consumed) is NOT computed — no consumption figure exists (WBS 1.8's own brief recorded this same gap). Recorded as a default, not a new one — same reasoning already established.
- **Readiness gaps reuse the D03 completeness metric verbatim** (D-blueprint 02, table row "اكتمال بيانات العملاء — D03"): `cr_number`, `credit_limit > 0`, `segment_id`, `payment_terms_days` all set — owner `CFO` (D03's own stated owner) for all four. One more gap, grounded in WBS 1.7's own INV-C2-2: no active contract with a non-null `price_list_id` for ANY entity — owner `CFO` (contract ownership, doc 06 §2-3/D-blueprint "D04"). No other gap is invented; these five are the only ones with a named source and a named owner in the docs.
- **Group-level, no `entityId` parameter** — a customer's contracts span every entity (doc 06 §3: "عقود كل كيان" — contracts of every entity), matching WBS 1.8's own group-level construction. `getCustomerProfile(ctx, { accountId })` takes no entity parameter; its contracts array itself carries each contract's own `entityId`/`entityCode`.
- **No backend HTTP endpoint; the UI uses a mock client**, same precedent as WBS 0.19: no NestJS app or API host exists anywhere in this workspace. The REAL, tested, DB-backed aggregation lives in `modules/sales` as a callable library function (`getCustomerProfile`) — this is what a future API layer wires up. `apps/admin`'s screen reads a mock client that returns data shaped EXACTLY by the same Zod contract (`packages/contracts/sales/customer-profile.ts`), giving real type continuity without a live backend.
- **No customer list/search screen this slice** — doc 29 §6-3 buckets that separately ("قوائم وبحث" — list/search screens, a different line item). Navigation to the one profile screen is a single fixed nav item (mirroring 0.19's fixed-role stand-in, since no login/session exists yet — 0.17 deferred) linking to one demo `accountId` from the mock data. Batched GM question: authorise a customer-search screen as its own follow-up WBS item.
- **No "audit" tab** — doc 40 §D1 says every "profile" pattern screen's last tab is audit, but no audit-log READ capability exists in any app yet (0.19 didn't build one either). Deferred, recorded as a default, not silently dropped.

## Read ONLY (workers) — kept under the 12-file / 1,500-line budget
1. `CLAUDE.md`
2. `.claude/briefs/sales.brief.md`
3. golden slice, SHAPE ONLY: `modules/wms/{domain,application,infrastructure,api}/receive-inbound/*`
4. **Nearer precedents** (pre-authorized): `modules/sales/{application,infrastructure,api}/{resolve-price,get-contract-for-order}*`-shaped files — i.e. `modules/sales/application/manage-contract/get-contract-for-order.ts` (the read-only, no-lock, no-Idempotency-Key guard/query shape this slice's `getCustomerProfile` copies exactly) — and `apps/admin/src/{router.tsx, App.tsx, components/empty-state.tsx, components/ui/*, features/decision-inbox/*, i18n/*}` (the ENTIRE existing admin app — this is the second-ever frontend slice, extending the first; read all of it, it is small)
5. `database/schema/01-Data-Model.sql` 420-582 (`sales.accounts`, `sales.contracts` — verbatim DDL, reused from 1.7/1.8) and `identity.users` (full_name_ar/full_name_en) and `catalog.segments` (name_ar/name_en) — grep these three tables' DDL directly, already known column shapes from prior slices
6. `docs/package/06-Sales-CRM-and-Accounting.md` 66-79 (§3 Customer 360°, verbatim below)
7. `docs/package/D-blueprints/02-Financial-Accounting.md` 1066 (D03 completeness metric, verbatim below), 1129 (the screen's ownership row)
8. `docs/package/40-Build-Specification-EN.md` 404-406 (§D1 — the three screen patterns, "profile" pattern quoted below)
9. `packages/db/index.ts` (`withContext`) · `packages/domain-kit/index.ts` (`Money` for `creditLimit` display formatting, reused from 1.8)
10. `modules/sales/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts, index.ts}` (the extended shell) · `apps/admin/{package.json, tsconfig.json, tsconfig.test.json, vite.config.ts}` (the extended shell)
Fixture precedent (pg-tester only): `modules/sales/tests/manage-contract/manage-contract.test.ts` 1-40 · `apps/admin/tests/decision-inbox/decision-inbox.test.tsx` 1-40 (both fixture/test-shape precedents in their own tracks).

## Write ONLY
- pg-tester: `modules/sales/tests/customer-profile/*` AND `apps/admin/tests/customer-profile/*` (both, since this slice has a data track and a UI track, each pg-tester writes RED first) · nothing else.
- pg-backend: `modules/sales/{domain,application,infrastructure,api}/customer-profile/*` · `modules/sales/index.ts` (extend barrel) · `packages/contracts/sales/customer-profile.ts` · `modules/sales/package.json` (deps only if missing).
- pg-frontend: `apps/admin/src/features/customer-profile/*` (contract re-export, `mock-client.ts`, `constants.ts`, screen + section components) · `apps/admin/src/components/readiness-checklist.tsx` (new, sibling to `empty-state.tsx`) · `apps/admin/src/router.tsx` (extend — add the `/customers/:accountId` route and one nav item) · `apps/admin/src/i18n/*.json` (extend — new `customer360.*`/`nav.customer360` keys, `ar` authored first).
- Lane session only: this brief.
Forbidden for every worker: `database/schema/**`, `packages/**` other than `packages/contracts/sales/customer-profile.ts`, `packages/events/catalog.ts`, other-module schema or code, `docs/**`, `scripts/**`, `CLAUDE.md`, `.claude/**`. A test defect goes back to pg-tester; builders never edit a test. **No migration** — nothing here writes to the database.

## Acceptance criterion (doc 38 row 1.9, verbatim)
"Shows contracts, readiness gaps with owners, finance, profitability placeholder"
Gates: `pnpm --filter @pg-eos/sales typecheck && lint && test` green as `pgeos_app` · `pnpm --filter @pg-eos/admin typecheck && lint && test` green · `pnpm guards:run` green (no migration, so this should already be green; verify on an isolated DB anyway per established practice) · pg-reviewer PASS.

## Doc 06 §3 (verbatim, the eight-section table)
شاشة واحدة لكل عميل تعرض من كل النطاقات:
| القسم | المحتوى |
|---|---|
| الهوية | البيانات · الشريحة · مسؤول الحساب · جهات الاتصال |
| التعاقد | عقود كل كيان · تواريخ الانتهاء · ملاحق الأسعار |
| **الجاهزية التشغيلية** | ما ينقص قبل التشغيل **بمسؤول لكل بند** |
| التشغيل | مخزونه · أوامره · شحناته · تذاكره — لحظياً |
| المالية | الرصيد · أعمار الذمم · الحد الائتماني المتبقي · حالة الحجز |
| **الربحية** | إيراد · تكلفة · هامش · الاتجاه ستة أشهر |
| SLA | الأداء مقابل المستهدف · الغرامات |
| النشاط | آخر مكالمة · زيارة · شكوى · فرصة مفتوحة |
"هذه الشاشة هي أهم مخرج من التوحيد. اليوم هذه المعلومات في أربعة أماكن ولا أحد يراها مجتمعة."

## D03 completeness metric (verbatim, D-blueprint 02 line 1066)
`count(cr_number و credit_limit > 0 و segment_id و payment_terms_days) ÷ count(*)` on `sales.accounts` — monthly (R-20), owner `CFO`, target 100%, "under 80% for two months ⇒ escalate to GM".

## Doc 40 §D1 (verbatim, the "profile" pattern)
"profile" (identity header, "what's missing before go-live" bar with owner+date, tabs, last tab = audit).

## Master decisions the workers copy (not re-derive)
1. **`getCustomerProfile(ctx, { accountId })`** (application, read-only, no lock, no version, no Idempotency-Key — mirrors `getContractForOrder`'s shape exactly): throws `AccountNotFoundError` when the account doesn't resolve under RLS. On success returns:
   ```
   {
     identity: { accountId, code, nameAr, nameEn: string|null, segmentCode: string|null, segmentNameAr: string|null, ownerUserId: string|null, ownerNameAr: string|null },
     contracts: [{ contractId, entityCode, status, startDate, endDate: string|null, hasPriceList: boolean }],
     readiness: [{ item: 'cr_number'|'credit_limit'|'segment'|'payment_terms'|'priced_contract', present: boolean, owner: 'CFO' }],
     finance: { creditLimit: string|null, creditHold: boolean, holdReason: string|null },
     profitability: { available: false }
   }
   ```
2. **Readiness items, exact rule per item** (decision copied verbatim from Scope, restated as the literal predicate each worker implements):
   - `cr_number`: present iff `sales.accounts.cr_number is not null`.
   - `credit_limit`: present iff `credit_limit is not null and credit_limit > 0` (D03's own `> 0` — a legitimate `0` for a trial client, per WBS 1.8's S7 case, still counts as an outstanding gap here; this screen is descriptive, not a hard gate).
   - `segment`: present iff `segment_id is not null`.
   - `payment_terms`: present iff `payment_terms_days is not null`.
   - `priced_contract`: present iff at least one `sales.contracts` row for this account (any entity, any status) has `price_list_id is not null`.
   - Every item's `owner` is `'CFO'` (D03's stated owner for the first four; contract ownership per doc 06 §2-3/D-blueprint "D04" for the fifth — no other role is named anywhere for these five facts).
3. **Contracts list**: every `sales.contracts` row for the account, across every entity, newest `start_date` first; `entityCode` joined from `platform.entities.code`; `hasPriceList = price_list_id is not null` (not the annex's own details — WBS 1.7 already has a dedicated slice for that).
4. **Finance section**: read straight from the SAME `sales.accounts` row WBS 1.8 already maintains — `credit_limit`, `credit_hold`, `hold_reason`. No new computation, no new column, no new table.
5. **Profitability**: hard-coded `{ available: false }` — never computed, never estimated.
6. **RLS**: everything through `withContext`; an account outside the caller's visibility surfaces as `AccountNotFoundError`, matching every prior slice's convention.
7. **Frontend contract reuse**: `apps/admin/src/features/customer-profile/contract.ts` re-exports (does not redeclare) `packages/contracts/sales/customer-profile.ts`'s schemas — this is a NEW rule for this slice (WBS 0.19 had no backend contract to reuse yet, so it declared its own app-local contract; this slice DOES have a real backend contract, so the frontend imports it directly via the package's `./sales/customer-profile` subpath export — no duplicated type declarations this time).
8. **Screen layout** (doc 40 §D1 "profile" pattern): an identity header strip (name, code, segment — no edit affordance, this is a read-only screen) + a "what's missing before go-live" bar rendering the readiness gaps (new `ReadinessChecklist` component: one row per item, a status icon/text and the owner, in the SAME visual language as `EmptyState` but supporting a LIST of items rather than one) + tabs: **Contracts**, **Finance**, **Profitability** (in that order; no audit tab, per Scope). The readiness bar sits above the tabs, always visible, not inside a tab (matching doc 40's own description: the readiness bar is a distinct element from the tab set).
9. **Navigation**: one new nav item ("عميل 360" / "Customer 360") added to the existing shell nav (alongside "Decision Inbox"), linking to a fixed demo `accountId` from the mock data (no customer search/list this slice, per Scope) — `aria-current="page"` when active, same pattern as the existing nav item.
10. **i18n**: `ar` authored first, fallback for missing keys in other locales (existing `t()` helper, no new library). New namespace `customer360.*` (header, readiness item labels, tab labels, finance/profitability copy) + `nav.customer360`.

## Scenario (Gherkin — pg-tester pastes into TWO feature files, one per track, and executes 1:1)

### `modules/sales/tests/customer-profile/customer-profile.feature` (data track, integration)
```gherkin
Feature: Customer profile (WBS 1.9, data track)
  As the aggregation query behind the Customer 360 screen, assemble one account's contracts,
  readiness gaps and finance facts from data already built by 1.5/1.7/1.8, with profitability as
  an honest placeholder

  Background:
    Given account "ACC-360" with cr_number set, credit_limit 5000.000, segment SEG-A,
      payment_terms_days 30, credit_hold false, and two contracts: one at entity PST with a
      price_list_id set, one at entity PDL with price_list_id null

  Scenario: A fully-ready account shows no gaps
    When getCustomerProfile is called for ACC-360
    Then every readiness item is present, contracts shows both entities (PST and PDL), finance
      shows creditLimit 5000.000 and creditHold false, profitability is { available: false }

  Scenario: Missing cr_number is a readiness gap owned by CFO
    Given ACC-360's cr_number is cleared
    When getCustomerProfile is called
    Then the "cr_number" readiness item is present:false, owner "CFO"

  Scenario: A zero credit limit is a readiness gap even though it is a legal value (S7)
    Given ACC-360's credit_limit is 0
    When getCustomerProfile is called
    Then the "credit_limit" readiness item is present:false

  Scenario: No priced contract anywhere is a readiness gap
    Given neither of ACC-360's contracts has a price_list_id
    When getCustomerProfile is called
    Then the "priced_contract" readiness item is present:false

  Scenario: An account with one priced contract among several has that gap closed
    Given ACC-360 has one contract with a price list and one without
    When getCustomerProfile is called
    Then the "priced_contract" readiness item is present:true

  Scenario: Finance reflects an active hold
    Given ACC-360 is on credit hold with reason "overdue"
    When getCustomerProfile is called
    Then finance.creditHold is true and finance.holdReason is "overdue"

  Scenario: An unknown account is rejected
    When getCustomerProfile is called with an accountId that does not exist
    Then it is rejected with AccountNotFoundError

  Scenario: RLS — a caller who cannot see the account gets a not-found
    When the same call runs as a user without visibility into ACC-360
    Then it is rejected with AccountNotFoundError

  Scenario: Contracts are ordered newest start_date first
    Given ACC-360 has three contracts with different start dates
    When getCustomerProfile is called
    Then the contracts array is ordered by start_date descending

  Scenario: A negative credit limit is a readiness gap, not a present one (round-1 review finding 1)
    Given ACC-360's credit_limit is -5.000 (no CHECK constraint prevents this)
    When getCustomerProfile is called
    Then the "credit_limit" readiness item is present:false

  Scenario: Readiness reflects only the caller's visible entities (round-1 review finding 4,
    accepted as documented behavior — sales.contracts has its own entity_scope RLS, separate
    from sales.accounts)
    Given ACC-360's only priced contract is at entity PDL, and the caller has
      identity.user_entities visibility into PST only, not PDL
    When getCustomerProfile is called as that caller
    Then the "priced_contract" readiness item is present:false, because the priced contract is
      outside what this caller can see — not a bug, the documented scope of this read
```

### `apps/admin/tests/customer-profile/customer-profile.test.tsx` (UI track, component)
```gherkin
Feature: Customer 360 screen (WBS 1.9, UI track)
  As a sales manager I open one screen per customer and see contracts, readiness gaps with an
  owner each, finance facts, and an honest profitability placeholder

  Scenario: Renders the identity header
    Then the account's name, code and segment are visible

  Scenario: Renders every readiness item with its status and owner
    Then each of the five readiness items shows present/missing and the owner "CFO" when missing

  Scenario: All gaps closed renders a clear "ready" state, not an empty list silently
    Given every readiness item is present
    Then a positive "no outstanding gaps" message is shown, not a blank readiness bar

  Scenario: Contracts tab lists every contract with its entity and price-list status
  Scenario: Finance tab shows credit limit, hold state and reason when held
  Scenario: Profitability tab shows the placeholder copy, never a fabricated number
  Scenario: Switching locale updates the whole screen, including the readiness owner labels
  Scenario: The nav item for Customer 360 is present and marks itself current when active
```

## Contract — `packages/contracts/sales/customer-profile.ts`
`GetCustomerProfileInputSchema` (`accountId` uuid), `.meta({id})`. `CustomerProfileResultSchema` matching decision 1's shape exactly (nested identity/contracts/readiness/finance/profitability objects), each readiness item's `item` field a `z.enum(['cr_number','credit_limit','segment','payment_terms','priced_contract'])`.

## Deliver
- `packages/contracts/sales/customer-profile.ts`
- `modules/sales/domain/customer-profile/errors.ts` (just `AccountNotFoundError` — no invariants file needed, nothing to validate on a read-only call beyond existence)
- `modules/sales/application/customer-profile/{ports.ts, index.ts, get-customer-profile.ts}`
- `modules/sales/infrastructure/customer-profile/repository.ts`
- `modules/sales/api/customer-profile/composition.ts` (no `handlers.ts` — no HTTP endpoint, mirrors 1.4/1.7's mechanism-slice precedent)
- `modules/sales/tests/customer-profile/{customer-profile.feature, customer-profile.test.ts}`
- `apps/admin/src/features/customer-profile/{contract.ts, mock-client.ts, constants.ts, identity-header.tsx, contracts-tab.tsx, finance-tab.tsx, profitability-tab.tsx, customer-profile-screen.tsx, index.ts}`
- `apps/admin/src/components/readiness-checklist.tsx`
- `apps/admin/src/i18n/{ar,en,hi,ur,bn,am}.json` (extended) · `apps/admin/src/router.tsx` (extended)
- `apps/admin/tests/customer-profile/customer-profile.test.tsx`
- `modules/sales/index.ts` (barrel, extended)

Migration number: none.
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent.
