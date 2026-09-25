# `billing` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `billing` · tables in this module: 11 · default lane: M (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C6 M07 Finance & Billing (`billing`)
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/02-Financial-Accounting.md (ledger, invoices, allocations)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `billable_events` | — | yes | entity_scope |
| `cost_allocations` | — | yes | entity_scope |
| `credit_notes` | — | yes | entity_scope |
| `gl_accounts` | — | yes | reference_read · reference_write |
| `invoice_lines` | — | no | internal_only |
| `invoices` | — | yes | client_portal_scope · entity_scope |
| `journal_entries` | — | yes | entity_scope |
| `journal_lines` | — | no | internal_only |
| `profitability` | — | yes | entity_scope |
| `receipt_allocations` | — | no | internal_only |
| `receipts` | — | yes | entity_scope |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `billable_events.status` | pending · priced · invoiced · excluded · disputed |
| `credit_notes.status` | draft · approved · applied |
| `invoices.status` | draft · review · approved · sent · partially_paid · paid · overdue · void |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `INV` | `PCC-INV-` |
| `CN` | `PCC-CN-` |
| `JE` | `PCC-JE-` |
| `RCT` | `PCC-RC-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.

## 5. Views and functions in this schema

- Views: none
- Functions: `reject_holding_invoice()` · `verify_journal_balance()` · `verify_unpriced_events()`

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh billing <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/billing/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.

## 8. Accounting core — requested, not yet in the schema (ADR-0004, D-187)

Added by the Master in A2 (D-187), outside the generator: every item below is **requested — SCR-ACC-01** (`docs/notes/SCR-ACC-01-accounting-core.md`, A0 §3 verbatim), is NOT in 01 / 13 / 13B, and has no migration number. A worker builds against an item only when its slice brief issues the migration. Re-running `scripts/gen-briefs.py` drops this section; re-add it from SCR-ACC-01 until the tables exist.

New tables (schema `billing`):

| table | what the spec needs (A0 §3) | SCR # | doc 38 row | status |
|---|---|---|---|---|
| `fiscal_years`, `accounting_periods` | Fiscal year; periods open/closed/locked per entity | 3 | 4.19 | requested — SCR-ACC-01 |
| `dimension_types`, `line_dimensions` | Dimensions as data; backs the fixed `client_id/contract_id/cost_center` | 9 | 4.1b | requested — SCR-ACC-01 |
| `exchange_rates` | Rates; invalid-currency checks; realized/unrealized FX | 11 | 4.21 | requested — SCR-ACC-01 |
| `intercompany_reconciliations` | Due-from/due-to reconciliation | 13 | 4.12a | requested — SCR-ACC-01 |
| `consolidation_entries` (separate book) | Eliminations, investment in subsidiaries, NCI | 14 | 4.12b | requested — SCR-ACC-01 |
| `vendor_bills`, `vendor_payments`, `vendor_payment_allocations` | AP bills, payments, allocation, statements, aging | 16 | 4.22 | requested — SCR-ACC-01 |
| `bank_accounts`, `bank_transactions`, `bank_reconciliations` | Banking (statement import itself is WBS 4.7) | 18 | 4.7a | requested — SCR-ACC-01 |
| `debit_notes` | Debit notes | 25 | — | requested — SCR-ACC-01 |
| `reporting_mappings` | Account → IFRS line / IFRS 18 category | 26 | 7.13 | requested — SCR-ACC-01 |
| `xbrl_taxonomies`, `xbrl_mappings` | XBRL layer outside the engine | 27 | 7.14 | requested — SCR-ACC-01 |

Changed columns and constraints (schema `billing`):

| table.column | what the spec needs (A0 §3) | SCR # | doc 38 row | status |
|---|---|---|---|---|
| `gl_accounts.code` | CHECK on X-XX-XXX-XXX; class 1–9 from the first segment | 1 | 4.1a | requested — SCR-ACC-01 |
| `gl_accounts.account_type` | Values for Cost of Revenue, Other Income/Expense, Tax, Control/Memorandum | 2 | 4.1a | requested — SCR-ACC-01 |
| `journal_entries` | Period link; posting to closed/locked period refused | 4 | 4.19 | requested — SCR-ACC-01 |
| `journal_entries` | Entry type; approved by/at (posted_at/by exist) | 5 | 4.20 | requested — SCR-ACC-01 |
| `journal_entries/lines` | Balance enforced at commit (constraint trigger), not only G2 | 6 | 4.20 | requested — SCR-ACC-01 |
| `journal_lines.entry_id … on delete cascade`; no REVOKE on journals | Posted entries immutable (doc 40 P3); cascade removed | 7 | 4.20 | requested — SCR-ACC-01 |
| `journal_lines.account_id` | Account in the entry's entity and `is_postable` | 8 | 4.20 | requested — SCR-ACC-01 |
| `journal_lines` | Transaction currency, functional currency, rate, base amount, foreign amount | 10 | 4.21 | requested — SCR-ACC-01 |
| `journal_entries.is_intercompany` | Counterparty entity; paired-leg link; self/unknown pair refused | 12 | 4.12a | requested — SCR-ACC-01 |

Outside this module (pointer only; each lands in its own module's brief): SCR # 15 `partners.partners` · 17 `admin.goods_receipts` · 19 `admin.cash_counts` · 20 `admin.asset_categories`, `admin.depreciation_runs` · 21 `admin.expense_claims` · 22 `hr.payroll_runs/lines` · 23 `tms.cod_settlements` · 24 `platform.approval_chains` · 28 `platform.tax_rules` · 29 `identity.roles` seed.

Events: none yet; catalog entries requested with each slice (`packages/events/catalog.ts` is a Master task).

Pointers: `docs/adr/ADR-0004-general-ledger-single-source.md` (D1 1–10, D2 (a)–(l), D3 OD-01…OD-18) · `docs/notes/SCR-ACC-01-accounting-core.md` · doc 38 v4.6 rows 4.1a, 4.1b, 4.19, 4.20 (lane 2, after 4.2 — D2 (e)) · slice briefs `docs/notes/slice-briefs/_slice-{4.1a,4.1b,4.19,4.20}.brief.md`.
