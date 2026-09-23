# `partners` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `partners` · tables in this module: 6 · default lane: 3 (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C6 M07 Finance & Billing — Partners (`partners`) paragraph
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/04-Operations-Delivery-Fleet.md (subcontracting, back-to-back SLA)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `partner_contracts` | — | yes | entity_scope |
| `partner_invoices` | — | yes | entity_scope |
| `partner_price_lines` | — | no | internal_only |
| `partners` | — | no | internal_only |
| `payable_events` | — | yes | entity_scope |
| `service_allocations` | — | yes | entity_scope |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `partner_contracts.status` | draft · active · expired · terminated |
| `partner_invoices.status` | received · matched · frozen · approved · paid · rejected |
| `partners.status` | active · suspended · terminated |
| `payable_events.status` | pending · priced · invoiced · excluded · disputed |
| `partner_contracts.liability_basis` | 3x_monthly · contract_value |

## 4. Document series and counters

This module allocates no document series of its own (`platform.counters` holds none for it).

## 5. Views and functions in this schema

- Views: `partners.resale_margin`
- Functions: `check_committed_utilization()` · `verify_paid_matched()`

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh partners <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/partners/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
