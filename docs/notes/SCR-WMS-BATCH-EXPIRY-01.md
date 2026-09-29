# SCR-WMS-BATCH-EXPIRY-01 — one expiry per batch on `wms.stock_balance` (G-01 rule request)

**Status:** REQUESTED — filed 2026-09-29 by the Master (M11) under **EXECUTION-MASTER-v4 §1.11 (G-01)** for WBS `2.9 part 3` (PR #212 round-1 finding 4). The GM decides. Nothing in `database/schema/*` or `database/migrations/*` is touched by this note.

## 1 · Context (verified on `origin/main @ 7d823b6`)
- The rule "a batch has one expiry" comes from the PR #185 brief (`docs/notes/slice-briefs/_slice-2.9-p2.brief.md`, Decision 2), which was a Master default. It is **not found** in doc 01 / 13 / 13B / 019 / 40.
- `wms.stock_balance` has `expiry_date date` and the key `unique (client_id, sku_id, location_id, batch_no)` (01-Data-Model.sql:719-732). `wms.stock_movements` carries `expiry_date` (01:705). No constraint ties one batch's expiry across locations.
- Doc 40 Part E S1 (scenario 2) needs only the expiry to be written: "Given available stock of "GULF-0137" in two batches with expiries 90 and 200 days … Then allocation takes 12 units from the 90-day batch". It states no rule for a conflicting expiry.
- Backlog row `2.9 part 3` acceptance includes "same-batch different-expiry refused at any location". That clause depends on this rule.

## 2 · Requested rule
| # | Object | Rule | Source | status |
|---|---|---|---|---|
| 1 | `wms.stock_balance.expiry_date` (ledger write path) | For one (client_id, sku_id, batch_no), every balance row at every location carries the same non-null `expiry_date`. A movement that carries a different non-null expiry for that batch is refused, never overwritten. A null expiry is filled by the first non-null one. | #185 brief Decision 2 (Master default) — no package source | requested — GM decides |

## 3 · Open items
- The GM decides whether the rule is adopted, and whether it is enforced in application code (the ledger write path) or as a schema constraint. A constraint would need a migration number and a pre-migration review.
- Until the GM decides, 2.9 part 3 writes the expiry only (Decision 2a of its brief), and the refusal clause is not built.
