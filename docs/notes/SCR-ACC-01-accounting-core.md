# SCR-ACC-01 — accounting core: chart format, periods, dimensions, posting engine, currency, intercompany, consolidation and subledgers (G-01 schema-change request)

**Status:** REQUESTED — filed 2026-09-25 by the Master (step A2 of the accounting track) under **EXECUTION-MASTER-v4 §1.11 (G-01)**, authorised by GM decision **D-187** / **ADR-0004** (Accepted). Nothing in `database/schema/*` or `database/migrations/*` is touched by this note; each row lands through its own doc 38 v4.6 slice, with a pg-reviewer pre-migration review and a migration number issued by the Master only after the RED tests named in §3 exist.

## 1 · Context

- Gap analysis A0 (`docs/notes/2026-09-25-accounting-gap-analysis.md`, commit `2c57971`) §3 lists 29 schema deltas (G-01 candidates) between the GM accounting spec (`docs/notes/GM-2026-09-25-accounting-erp-spec.md`) and `database/schema/01 · 13 · 13B`. The rows below are A0 §3 rows 1–29, verbatim.
- ADR-0004 (`docs/adr/ADR-0004-general-ledger-single-source.md`) Consequences 2: "G-01 candidates = A0 §3 rows 1–29, each a schema-change request under EXECUTION-MASTER-v4 §1.11 before any migration." The column "ADR-0004 decision" names the D1 bullet (1–10) or D2 letter ((a)–(l)) each row serves; where only a D3 standing default applies it is named too (D3 OD-nn).
- ADR-0004 Consequences 4: the `journal_lines` → `journal_entries` `on delete cascade` (01:1204) and the missing REVOKE UPDATE/DELETE on the journal tables are fixed in WBS 4.20 (row 7).
- Doc 38 v4.6 (D-187) carries the rows that build these deltas: 4.1a, 4.1b, 4.19, 4.20 (lane 2, D2 (e)), then 4.21, 4.12a, 4.12b, 4.22, 4.7a, 3.6a, 4.23, 4.24, 5.6a, 5.11a, 5.11b, 7.13, 7.14.

## 2 · Requested deltas (A0 §3 rows 1–29, verbatim)

| # | Existing table / column, or new table | What the spec needs | Spec § | ADR-0004 decision | status |
|---|---|---|---|---|---|
| 1 | `billing.gl_accounts.code` (01:1181) | CHECK on X-XX-XXX-XXX; class 1–9 from the first segment | §3 | D2 (c) · D3 OD-10 | **part 1 applied (migration 0028, 4.1a part 1); part 2 — the write path, `billing.gl_account_change_requests` maker/checker + the `platform.is_approval_chain_approver()` approval-chain primitive (SCR-PLAT-APPR-01) — applied (migration 0034, 4.1a part 2, `<this commit>`); part 3 — `is_active` + deactivate/reactivate — requested, open (4.1a part 3)** |
| 2 | `billing.gl_accounts.account_type` (01:1183) | Values for Cost of Revenue, Other Income/Expense, Tax, Control/Memorandum | §3 | D2 (c) · D3 OD-10 | requested |
| 3 | new `billing.fiscal_years`, new `billing.accounting_periods` | Fiscal year; periods open/closed/locked per entity | §5, §1 | D1 5 | requested |
| 4 | `billing.journal_entries` (01:1189) | Period link; posting to closed/locked period refused | §5, §34 | D1 5 | requested |
| 5 | `billing.journal_entries` (01:1189) | Entry type; approved by/at (posted_at/by exist, 01:1197) | §4, §24 | D1 4 | requested |
| 6 | `billing.journal_entries/lines` | Balance enforced at commit (constraint trigger), not only G2 | §4, §34 | D1 3 | requested |
| 7 | `billing.journal_lines.entry_id … on delete cascade` (01:1204); no REVOKE on journals | Posted entries immutable (doc 40 P3); cascade removed | §24, §28 | D1 4 | requested |
| 8 | `billing.journal_lines.account_id` (01:1205) | Account in the entry's entity and `is_postable` | §34 | D1 6 · D2 (c) | requested |
| 9 | new `billing.dimension_types`, new `billing.line_dimensions` | Dimensions as data; backs the fixed `client_id/contract_id/cost_center` (01:1208-1210). **Hybrid design ruling (evaluation-session, D-190, relayed by the Master 2026-09-26):** `dimension_types.kind ∈ {list, reference}` — **list** kind (cost centre, project, department…) gets `billing.dimension_values` (entity_id, dimension_type_id, code, name, is_active, version) + a composite FK `line_dimensions (dimension_type_id, value_id) → dimension_values (dimension_type_id, id)`, declarative, no trigger; **reference** kind gets `dimension_types.source_table` with a closed CHECK whitelist of 8 tables (`sales.accounts`, `partners.partners`, `hr.employees`, `tms.vehicles`, `wms.warehouses`, `platform.sites`, `imile.shipments`, `platform.entities`) + `line_dimensions.value_id uuid` validated by a constraint trigger `billing.assert_dimension_value()` (checks the row exists in the source table and, where the source has `entity_id`, that it belongs to the line's entity — precedent style `reject_holding_invoice`/`check_space_available`). `value_ref text` (free text) is DROPPED entirely, never built. **Status: part 1 (`dimension_types` — kind/source_table columns + CHECK) applied, migration `0030` (WBS 4.1b part 1, `b31fe44`-lineage lane 2 commit `<this commit>`); part 2 (`line_dimensions`, `dimension_values`, `value_id`, the constraint trigger) requested, not yet built — design is fully specified, no further ruling needed before build.** | §6, §2 | D1 6 · D2 (d) | part 1 applied (0030); part 2 requested |
| 10 | `billing.journal_lines` | Transaction currency, functional currency, rate, base amount, foreign amount | §35 | D1 7 · D2 (k) | requested |
| 11 | new `billing.exchange_rates` | Rates; invalid-currency checks; realized/unrealized FX | §35, §34 | D1 7 · D2 (k) | requested |
| 12 | `billing.journal_entries.is_intercompany` (01:1196) | Counterparty entity; paired-leg link; self/unknown pair refused | §8, §34 | D1 8 | requested |
| 13 | new `billing.intercompany_reconciliations` | Due-from/due-to reconciliation | §8, §30 | D1 8 | requested |
| 14 | new `billing.consolidation_entries` (separate book) | Eliminations, investment in subsidiaries, NCI | §9 | D1 9 · D2 (g) | requested |
| 15 | `partners.partners` (13:15, no `entity_id`) | Vendors per company or a company mapping | §1, §16 | D2 (h) · D3 OD-14 | requested |
| 16 | new `billing.vendor_bills`, `vendor_payments`, `vendor_payment_allocations` | AP bills, payments, allocation, statements, aging | §16 | D1 1 · D1 2 | requested |
| 17 | `admin.purchase_orders.received_*` (13:506) → new `admin.goods_receipts` | Receipt as a record for three-way match | §17 | Consequences 2 only | requested — scope of 4.22 |
| 18 | new `billing.bank_accounts`, `bank_transactions`, `bank_reconciliations` | Banking (statement import itself is WBS 4.7) | §19 | D1 1 · D1 2 | requested |
| 19 | `admin.petty_cash` (13:516) + new `admin.cash_counts` | Main cash, custodians, transfers, count, reconciliation | §20 | D1 1 · D1 2 | requested — scope of 4.7a |
| 20 | `admin.assets` (13:543) + new `admin.asset_categories`, `admin.depreciation_runs` | Categories, capitalization, configurable depreciation, disposal, transfer, impairment | §21 | D1 1 · D1 2 · D1 10 | requested |
| 21 | new `admin.expense_claims` | Expense claims through approval chains | §22 | D1 1 · D1 2 | requested |
| 22 | `hr.payroll_runs/lines` (absent, doc 10 l.48) | Payroll module posting to the GL | §23 | D1 2 · D1 10 | requested |
| 23 | new `tms.cod_settlements` | COD value, collector, dates, remitted, shortage, variance, status; unique per task. Clearing accounts are CoA data | §12, §34 | D1 1 · D1 2 · D3 OD-11 | requested |
| 24 | `platform.approval_chains` (13B:587-598) | Expense/PO/payment request types; entity scoping (need unverified) | §25 | Consequences 2 only | requested |
| 25 | `billing.credit_notes` (01:1162) → new `billing.debit_notes` | Debit notes | §15, §18 | D1 1 · D1 2 | requested — scope of 4.22 |
| 26 | new `billing.reporting_mappings` | Account → IFRS line / IFRS 18 category | §31 | D1 10 · D3 OD-02 | requested |
| 27 | new `billing.xbrl_taxonomies`, `billing.xbrl_mappings` | XBRL layer outside the engine | §32 | D1 10 · D3 OD-04 | requested |
| 28 | new `platform.tax_rules` (or `platform.settings` keys) | Configurable tax/invoice/government rules; none seeded (OD-01) | §33 | D1 10 · D3 OD-01 | requested |
| 29 | `identity.roles` seed (13B:546-572) — data, not schema | Spec roles with no counterpart (#26) | §26 | D2 (i) · D3 OD-18 | requested — 4.1a (data) |

## 3 · RED tests that must exist before any migration

`lane-guard.sh` refuses a migration file until the RED test files named in its `MIGRATION-REQUEST-<lane>.md` row exist (CLAUDE.md · PARALLEL LANES v5). No test is written by this note; pg-tester writes them at step 6 of each slice. Paths are fixed here so the migration request rows can name them.

| Row group (§2 #) | doc 38 v4.6 row | use-case slug | RED test paths (must exist before the migration) |
|---|---|---|---|
| 1, 2 | 4.1a | `chart-of-accounts` | `modules/billing/tests/chart-of-accounts/chart-of-accounts.feature` · `modules/billing/tests/chart-of-accounts/chart-of-accounts.test.ts` · `modules/billing/tests/chart-of-accounts/invariants.property.test.ts` |
| 9 | 4.1b | `dimensions` | `modules/billing/tests/dimensions/dimensions.feature` · `modules/billing/tests/dimensions/dimensions.test.ts` · `modules/billing/tests/dimensions/invariants.property.test.ts` |
| 3, 4 | 4.19 | `accounting-periods` | `modules/billing/tests/accounting-periods/accounting-periods.feature` · `modules/billing/tests/accounting-periods/accounting-periods.test.ts` · `modules/billing/tests/accounting-periods/period-machine.unit.test.ts` · `modules/billing/tests/accounting-periods/invariants.property.test.ts` |
| 5, 6, 7, 8 | 4.20 | `post-journal` | `modules/billing/tests/post-journal/post-journal.feature` · `modules/billing/tests/post-journal/post-journal.test.ts` · `modules/billing/tests/post-journal/journal-machine.unit.test.ts` · `modules/billing/tests/post-journal/invariants.property.test.ts` |
| 10–29 | 4.21 · 4.12a · 4.12b · 4.22 · 4.7a · 3.6a · 4.23 · 4.24 · 5.6a · 5.11a · 5.11b · 7.13 · 7.14 | named when the row's slice brief is written | none issued here — each later slice names its RED paths in its own migration request row |

File names mirror the golden slice `modules/wms/tests/receive-inbound/` (`receive-inbound.feature` · `receive-inbound.test.ts` · `inbound-machine.unit.test.ts` · `invariants.property.test.ts`).

## 4 · Constraints every row carries

- RLS enabled on every new table; `entity_id` hard column where the table is entity-scoped (ADR-0004 D1 6); `identity.column_classification` rows for every new column (CLAUDE.md ARCHITECTURE).
- Forward-only migrations, numbers issued by the Master in one batch per lane (D-179); pg-reviewer pre-migration review for every row that touches the schema, RLS or the audit chain.
- No rate, date, percentage or account is seeded (ADR-0004 D3); the pilot chart of 4.1a is synthetic (D-127, D2 (e)).
- Events: none named by A0; each slice requests its `packages/events/catalog.ts` entries from the Master (frozen during parallel phases).

## 5 · Disposition

Requested. Rows 1–9 are built by lane 2 (4.1a → 4.1b → 4.19 → 4.20, after 4.2, D2 (e)); rows 10–29 by the doc 38 v4.6 row that names them — rows **17** (`admin.goods_receipts`) and **25** (`billing.debit_notes`) are assigned to **4.22** (AP/vendor bills), row **19** (`admin.cash_counts`) to **4.7a** (banking), and row **29** (`identity.roles` seed) to **4.1a** as data, not schema (Master assignment, this commit). Rows 17 and 24 carry no ADR-0004 decision of their own ("Consequences 2 only"). Each row's status moves to `approved` at its pre-migration pg-reviewer PASS and to `applied` when its migration lands.
