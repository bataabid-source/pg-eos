# `admin` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `admin` · tables in this module: 12 · default lane: 3 (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C7 M08 HR (`hr`), Housing (`housing`), Admin (`admin`) — Admin part
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/06-Administrative-HR-Housing.md (purchasing, assets, gov transactions)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `approval_requests` | — | yes | entity_scope |
| `approval_steps` | — | no | internal_only |
| `asset_custody` | — | no | internal_only |
| `assets` | — | yes | entity_scope |
| `budget_lines` | — | yes | entity_scope |
| `correspondence` | — | yes | entity_scope |
| `gov_transactions` | — | yes | entity_scope |
| `petty_cash` | — | yes | entity_scope |
| `petty_cash_transactions` | — | no | internal_only |
| `purchase_orders` | — | yes | entity_scope |
| `purchase_requests` | — | yes | entity_scope |
| `vendor_quotes` | — | no | internal_only |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `approval_requests.status` | pending · approved · rejected · expired · delegated |
| `assets.status` | in_stock · in_custody · maintenance · disposed |
| `correspondence.status` | open · replied · closed |
| `petty_cash.status` | active · closed |
| `purchase_orders.status` | issued · received · matched · paid · cancelled |
| `purchase_requests.status` | draft · pending_approval · approved · rejected · ordered · cancelled |
| `gov_transactions.stage` | requested · submitted · in_progress · completed · rejected |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `PRQ` | `PCC-PR-` |
| `PO` | `PCC-PO-` |
| `PINV` | `PCC-PI-` |
| `PCT` | `PCC-PC-` |
| `GOV` | `PCC-GV-` |
| `APR` | `PCC-AP-` |
| `COR` | `PCC-CR-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.

## 5. Views and functions in this schema

- Views: none
- Functions: `reject_self_approval()`

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh admin <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/admin/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
