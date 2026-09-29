# SCR-WMS-BATCH-EXPIRY-01 — one expiry per batch on `wms.stock_balance` (G-01 rule request)

**Status:** APPROVED 2026-09-29 — the same request as `SCR-WMS-EXPIRY-01` (lane 1 R4, commit 51fceb1), which the GM approved with backlog row 2.9 part 3 («مواافق» 01:20Z, R4 rulings); GM default (b), Advisory 12:25Z, issue #207. Filed by the Master (M11) under **EXECUTION-MASTER-v4 §1.11 (G-01)** for WBS `2.9 part 3`. No new table or column; nothing in `database/schema/*` or `database/migrations/*` is touched.

## 1 · Context (verified on `origin/main @ 7d823b6`)
- The rule "a batch has one expiry" comes from the PR #185 brief (`docs/notes/slice-briefs/_slice-2.9-p2.brief.md`, Decision 2), which was a Master default. It is **not found** in doc 01 / 13 / 13B / 019 / 40.
- `wms.stock_balance` has `expiry_date date` and the key `unique (client_id, sku_id, location_id, batch_no)` (01-Data-Model.sql:719-732). `wms.stock_movements` carries `expiry_date` (01:705). No constraint ties one batch's expiry across locations.
- Doc 40 Part E S1 (scenario 2) needs only the expiry to be written: "Given available stock of "GULF-0137" in two batches with expiries 90 and 200 days … Then allocation takes 12 units from the 90-day batch". It states no rule for a conflicting expiry.
- Backlog row `2.9 part 3` acceptance includes "same-batch different-expiry refused at any location". That clause depends on this rule.

## 2 · Requested rule
| # | Object | Rule | Source | status |
|---|---|---|---|---|
| 1 | `wms.stock_balance.expiry_date` (ledger write path) | For one (client_id, sku_id, batch_no), every balance row at every location carries the same non-null `expiry_date`. A movement that carries a different non-null expiry for that batch is refused, never overwritten. A null expiry is filled by the first non-null one. | #185 brief Decision 2 (Master default) — no package source | approved (with SCR-WMS-EXPIRY-01) |

## 3 · Decision
- Same rule as SCR-WMS-EXPIRY-01 ("one expiry per batch across locations", on the existing `wms.stock_balance.expiry_date`); it adds no table or column, so it is approved with EXPIRY-01.
- Enforced in application code on the ledger write path (EXPIRY-01 option 1, no schema change). A batch-level table or a constraint (EXPIRY-01 option 2) is NOT approved; it would need its own SCR, migration number and pre-migration review.
- Applied by 2.9 part 3, whose commit deletes this note.
