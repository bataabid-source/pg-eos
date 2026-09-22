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
