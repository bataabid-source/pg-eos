# SLICE BRIEF — WBS 1.5 · Customer accounts — PROOF SLICE (ADR-0001)

Task: 1.5 — M02 `sales`: accounts, contacts (leads, opportunities, activities are OUT of this proof)      Lane: 1 in doc 38 — runs single-lane on main
Lock: sales (tasks/LANE_LOCKS.md, lane M — single lane)      Owner: SALES_MGR      Deps: 0.13 DONE (`335b5db`)
GM directive 2026-09-23 phase D: start condition met (2.8 DONE @ `b5da282`, every phase-C gate green). Within D the GM ordered
13B §13B-19 `sales.possible_duplicates` corrected from `> 0.85` to `>= 0.85` (doc 40 §C2 INV-C2-3 governs the schema) — migration 0006.
Governing decision: **docs/adr/ADR-0001-1.5-proof-slice.md (Accepted, GM 2026-09-23)** — data model + seed only, no UI, no workflow,
no public API; the full 1.5 slice is replicated later from the golden slice 2.9; status becomes `DONE (proof)`, excluded from the ratio.
Model routing (GM 2026-09-23): pg-tester sonnet → pg-backend sonnet (scaffold only) → pg-reviewer opus → pg-scribe sonnet.
Type of slice: **proof-only**, the 2.1 pattern (`0d546d5`): the schema already carries the M02 data model; there is NO seed
source in 01/13/13B/019 (ADR-0001 Context), so the "seed" is a set of labelled test fixtures created in beforeAll and removed
in afterAll (0.18 precedent). No real client name, CR number, credit limit or other business value is invented.
Start condition (GM directive 2026-09-23, phase D): every phase-C gate green — otherwise this slice does not start.

## Read ONLY
- CLAUDE.md · docs/adr/ADR-0001-1.5-proof-slice.md · .claude/briefs/sales.brief.md (§2–§3)
- database/schema/01-Data-Model.sql: `create table sales.accounts` … `create table sales.contacts` (≈ 410-447; the partial unique
  index on `cr_number` at 435), 1441 (RLS enabled on sales.accounts), 1476-1479 (policy `client_portal_scope` on sales.accounts)
- database/schema/13B-Schema-Reference-Consolidation.sql §13B-19 (`sales.possible_duplicates` view — `cr_number` equality OR
  `similarity(name_ar, name_ar) > 0.85` until migration 0006, `>= 0.85` after), 13B chk_accounts_status (active · suspended · closed)
- docs/package/40-Build-Specification-EN.md: 46 (§A2 "One `sales.accounts` row per client across all entities"), 204-217 (§C2 entities
  and INV-C2-3 "Duplicate detection on `cr_number` and name similarity ≥ 0.85 (pg_trgm)")
- docs/package/38-WBS.md row 1.5 (acceptance, verbatim below)
- modules/wms/{package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts} and modules/wms/tests/integration/wh1-setup.test.ts
  (scaffold + connection precedent) · tests/isolation/tests/client-isolation.test.ts (only the `pg_policy` shape-proof pattern)
- packages/identity/tests/rbac-sod.test.ts (fixture create/cleanup precedent)

## Write ONLY
- pg-backend (scaffold only, no logic): modules/sales/{package.json (`@pg-eos/sales`), tsconfig.json, tsconfig.test.json, vitest.config.ts,
  index.ts (empty M02 shell comment like modules/wms/index.ts)} — copied from modules/wms with names changed; then `pnpm install`.
- pg-tester: modules/sales/tests/integration/customer-accounts.feature · modules/sales/tests/integration/customer-accounts.test.ts ·
  modules/platform/tests/integration/schema-invariants.test.ts (ONE environment-wide test only: database ctype/collate = C.UTF-8/C and
  non-empty Arabic trigrams — SCR-TRGM-01 is not sales-specific; owner pg-tester; single lane M, no other lane touches platform)
- pnpm-lock.yaml regenerates via `pnpm install` — never hand-edited.
- Master only (SCR-TRGM-01 option A, GM 2026-09-23): database/schema/apply.sh (createdb template0 · UTF8 · collate C · ctype C.UTF-8 + refusal
  check), infra/docker/docker-compose.yml (POSTGRES_INITDB_ARGS), doc 42 §4.2/§6.3/§9 (4.0 → 4.1), docs/notes/SCR-TRGM-01 (RESOLVED).
- Master only (after pg-reviewer's migration gate): database/schema/13B-Schema-Reference-Consolidation.sql §13B-19 (`> 0.85` → `>= 0.85`, v4.3 → v4.4),
  database/migrations/0006_M_possible-duplicates-ge.sql (`create or replace view` with the identical text), doc 22 §5 view text (4.0 → 4.1),
  CHANGELOG-v4.
Forbidden for workers: database/**, packages/**, docs/**, scripts/**, any other module, CLAUDE.md, .claude/**. **No seed file.**
Any other schema change needs a schema-change request under G-01 first (ADR-0001) → STOP and report.

## Acceptance criterion (doc 38 row 1.5, verbatim)
"One account per client across entities; duplicate detection fires"
Read through ADR-0001: proven **where it is provable at the schema level** — (a) one row per client group-wide, (b) duplicate detection
on `cr_number` and on name similarity, (c) RLS on `sales.accounts`, (d) contacts belong to an account. Everything else in row 1.5
(leads, opportunities, activities, screens, merge service) is explicitly out of scope and stays TODO for the post-2.9 replication.

## Master decisions the workers copy
1. **"One account per client across entities" is a schema property**, proven by: `sales.accounts` has NO `entity_id` column
   (information_schema.columns); `code` is unique (second insert with the same code → SQLSTATE 23505); `cr_number` is unique among
   live rows (second live row with the same cr_number → 23505; a soft-deleted row — `deleted_at` set — releases the cr_number; two
   rows with `cr_number null` coexist). doc 40 §A2 "One `sales.accounts` row per client across all entities" is the source sentence; cite it by section.
2. **Duplicate detection = `sales.possible_duplicates`** (13B-19, SCR-7). Its `cr_number` branch can never see two live rows (the
   partial unique index forbids them — decision 1), so the runtime path is the name branch: two live fixture accounts with identical
   `name_ar` → the pair once (`a_id < b_id`, sim 1.000). Two live fixture accounts whose `name_ar` similarity is > 0.85 and < 1 →
   the view returns the pair with `sim` = round(similarity, 3). A soft-deleted twin is NOT reported.
   **F/G fixture (Master directive 2026-09-23, after a fixture defect):** F = `اختبار` followed by the 23 remaining distinct Arabic letters
   (n = 29 letters, all trigrams distinct), G = F with its last letter replaced. For one word of n letters with distinct trigrams,
   replacing the last letter keeps n−1 of n+1 trigrams and adds 2, so similarity = (n−1)/(n+3) — above 0.85 only for n ≥ 24 (a named
   constant carries this); here 28/32 = 0.875. The first construction (`اختبار` repeated five times) had few distinct trigrams and
   fell below 0.85 on C.UTF-8 — the Master classed it as a fixture defect (the rule and the view were correct), not an SCR.
3. **The doc-40 boundary (ADR-0001 "Known discrepancy"; GM directive phase D).** The view is corrected to `>= 0.85` (migration 0006).
   Measured on PostgreSQL 16.15 with lc_ctype C.UTF-8: the synthetic pair `name_ar = 'اختبارمكررتجريبي'` / `'اختبارمكررتجريبي كو'` has
   `similarity() = 17/20 = 0.85` exactly. `similarity()` returns `real` and the view compares it with `(0.85)::double precision`;
   float4(0.85) = 0.8500000238 > 0.85, so the OLD `>` already reported an exact-0.85 pair — the boundary cannot be RED by behaviour.
   (a) RED first, on the normalized view text: `pg_get_viewdef('sales.possible_duplicates'::regclass)` contains
       `similarity(a.name_ar, b.name_ar) >= (0.85)::double precision` and does NOT contain `similarity(a.name_ar, b.name_ar) > (0.85)::double precision`.
   (b) Non-regression at the boundary: the two synthetic accounts above → `similarity(a,b)::numeric(10,6) = 0.850000` in SQL, then the
       view returns the pair with `sim = 0.850`. The comment states why it passes on both view versions. No `it.skip`.
4. **RLS shape proof** (0.18 pattern, no role dance): `pg_class.relrowsecurity = true` for sales.accounts; `pg_policy` has
   `client_portal_scope` FOR SELECT on sales.accounts whose `qual` text contains `platform.is_internal()` and `platform.current_client_id()`.
   Functional isolation of sales.accounts was already proven by WBS 0.18 (43/43) — cite, do not repeat.
5. **Contacts.** A fixture contact with `is_primary = true` on account A; `on delete cascade` proven by deleting a throw-away fixture
   account and observing its contact row disappear. Column literals from 01 (`name`, `role_type`, `is_primary`).
6. **Fixtures.** `code` prefixed `_sales_fixture_`, `account_type = 'client'`, `client_kind = '3pl'`, `name_ar` = a clearly synthetic
   Arabic label (never a real name); the name-similarity fixtures (identical names, F/G, soft-deleted twin, boundary pair) start with the
   word `اختبار` (test) and use Arabic only, never Latin (SCR-TRGM-01), `status = 'active'` (13B chk), `cr_number` = obviously synthetic strings prefixed `FIXTURE-CR-`. Created in beforeAll,
   deleted in afterAll (contacts cascade). Assert afterAll leaves zero `_sales_fixture_%` rows. `platform.mdm_scorecard` is not asserted
   (it aggregates real data).
7. **Arabic matching works in this database (SCR-TRGM-01, option A approved by the GM 2026-09-23).** The database is created with
   `lc_ctype = C.UTF-8`, `lc_collate = C`. The suite asserts `select datctype from pg_database where datname = current_database()` =
   `C.UTF-8` and `similarity('اختبار','اختبار') = 1` before any name scenario; under the old `C` ctype both fail (0 trigrams).
8. **No numbers invented.** 0.85 is the doc-40 literal; 23505 is PostgreSQL's unique_violation; everything else is a column name.

## Scenario (Gherkin first — modules/sales/tests/integration/customer-accounts.feature; every clause its own step)
Feature: Customer accounts — one per client across entities, duplicate detection fires (WBS 1.5 proof, ADR-0001)
  Background: schema applied; fixture accounts A, B, C (and contacts) created with synthetic values
  Scenario: an account is a group-level record
    Then information_schema.columns has no entity_id column for sales.accounts (doc 40 §A2, "One sales.accounts row per client across all entities")
  Scenario: the same account code cannot be registered twice
    When a second account with A's code is inserted
    Then the insert fails with SQLSTATE 23505 and sales.accounts still has one row with that code
  Scenario: the same CR number cannot be live twice
    When a second live account with A's cr_number is inserted
    Then the insert fails with SQLSTATE 23505
    When A is soft-deleted (deleted_at set) and the same cr_number is inserted again
    Then the insert succeeds (01 partial unique index on sales.accounts (cr_number) where deleted_at is null) and the new row is removed in cleanup
  Scenario: two accounts without a CR number coexist
    When two live accounts B and C are inserted with cr_number null
    Then both inserts succeed (the 01 partial unique index ignores nulls)
  Scenario: the CR-number path of duplicate detection is closed by the index itself
    Then two LIVE rows with one cr_number cannot exist (01 partial unique index on sales.accounts (cr_number) — proven by the 23505 scenario above)
    And the view's cr_number branch (13B §13B-19 sales.possible_duplicates) can therefore only ever match a pair that the index already forbids — cite both, prove nothing more
  Scenario: duplicate detection fires on identical names
    Given two live accounts D and E with cr_number null and identical name_ar
    Then sales.possible_duplicates returns exactly the pair (D, E) with sim = 1.000
  Scenario: duplicate detection fires on name similarity above 0.85
    Given two live accounts F and G whose name_ar differ by one trailing character
    And similarity(F,G) is above 0.85 and below 1 (asserted in SQL)
    Then sales.possible_duplicates returns exactly the pair (F, G) with sim = round(similarity, 3)
  Scenario: a soft-deleted twin is not reported
    Given G is soft-deleted
    Then sales.possible_duplicates returns no row for (F, G)
  Scenario: Arabic names produce trigrams in this database (SCR-TRGM-01)
    Then the database ctype is C.UTF-8
    And similarity of an Arabic name with itself is 1
  Scenario: the view compares similarity with >= 0.85 (doc 40 §C2 INV-C2-3; migration 0006)
    Then the normalized view definition contains "similarity(a.name_ar, b.name_ar) >= (0.85)::double precision"
    And it does not contain "similarity(a.name_ar, b.name_ar) > (0.85)::double precision"
  Scenario: an Arabic pair at exactly 0.85 is reported (non-regression; float4 rounding explained in the test)
    Given two live accounts named اختبارمكررتجريبي and اختبارمكررتجريبي كو
    Then their similarity is exactly 0.850000
    And sales.possible_duplicates returns the pair with sim = 0.850
  Scenario: RLS is enabled with the client-portal policy (shape proof, 0.18 pattern)
    Then sales.accounts has relrowsecurity = true and a client_portal_scope SELECT policy using platform.is_internal() / platform.current_client_id()
  Scenario: contacts belong to their account
    Given account A has a primary contact
    When a throw-away fixture account with one contact is deleted
    Then its contact row is gone (on delete cascade, 01)
  Scenario: nothing fixture-like remains
    Then after cleanup sales.accounts has zero rows with code like '_sales_fixture_%'
## Test rules
- Connect like modules/wms/tests/integration/wh1-setup.test.ts. Superuser pool; RLS is proven by shape only (decision 4).
- Every literal cites its source BY NAME (doc 40 §A2 / §C2 INV-C2-3, 01 sales.accounts / its index, 13B §13B-19) — never a line number. Compare numerics with `::numeric` equality.
- RED is expected only on decision 3(a) (the view text, before migration 0006) and, on a database still created with ctype C, on decision 7
  and every Arabic-name scenario. The boundary 3(b) cannot be RED by behaviour (decision 3). Everything else is GREEN — report honestly.
- Run: `pnpm --filter @pg-eos/sales test` · `pnpm --filter @pg-eos/sales typecheck` · `npx eslint modules/sales` · root `pnpm typecheck`,
  `pnpm lint`, `pnpm lint:boundaries` · `pnpm guards:run` · `pnpm -w build --force` · `pnpm -w test -- --force`.
- Constraints (CLAUDE.md · AGENT CONSTRAINTS): no any / @ts-ignore / eslint-disable / console.log / magic numbers / fabricated values.

Contract: none.   Screen/Board spec: none.   Migration number: 0006 (issued to the Master, 2026-09-23).
Stop-and-ask if: a table/column/rule needed is not in 01 / 13 / 13B / 019 / 40; if an Arabic name scenario fails on a C.UTF-8 database.

## Report back (§5 REPORT format)
Files changed · Files read outside list · Tests x/y with vitest output · Guards · Open questions · Model · Tokens.
