# `sales` — module brief (generated)

Generated 2026-09-21 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `sales` · tables in this module: 11 · default lane: 2 (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C2 M02 Sales & CRM (`sales`)
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/02-Financial-Accounting.md (quotes → contracts → revenue)`
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/14-Sales-Compensation.md (SCR-SC-01 commission, 13B-SC)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `account_ownership_history` | سجل ملكية حساب العميل بتاريخ — أساس تقسيم العمولة عند نقل… | yes | entity_scope |
| `accounts` | — | no | client_portal_scope |
| `activities` | — | no | internal_only |
| `contacts` | — | no | internal_only |
| `contract_sla` | — | no | internal_only |
| `contracts` | — | yes | entity_scope |
| `leads` | — | no | internal_only |
| `opportunities` | — | yes | entity_scope |
| `quote_lines` | — | no | internal_only |
| `quotes` | — | yes | entity_scope |
| `sla_results` | — | no | internal_only |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `accounts.status` | active · suspended · closed |
| `contracts.status` | draft · signed · active · suspended · expired · renewed · terminated |
| `leads.status` | new · contacted · qualified · converted · lost |
| `quotes.status` | draft · commercial_review · finance_review · approved · sent · accepted · rejected… |
| `account_ownership_history.role_kind` | sales_rep · sales_mgr |
| `opportunities.stage` | qualification · needs_analysis · proposal · negotiation · won · lost |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `QTE` | `PCC-QT-` |
| `CTR` | `PCC-CT-` |
| `LEAD` | `PCC-LD-` |
| `OPP` | `PCC-OP-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.

## 5. Views and functions in this schema

- Views: `sales.possible_duplicates`
- Functions: none

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh sales <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/sales/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
