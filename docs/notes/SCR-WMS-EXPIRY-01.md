# SCR-WMS-EXPIRY-01 — one expiry per batch across locations (`wms.stock_balance.expiry_date`)

Filed by lane 1 (R4), 2026-09-29, on the GM's ruling (GM-Directive: "مواافق", relayed by the GM's advisory
session) approving backlog row `2.9 part 3`. Schema-change request only — no build until the Master or the GM
decides the options below (CLAUDE.md · ARCHITECTURE: a rule outside 01 / 13 / 13B / 019 / 40 is filed, never
invented).

## The gap

| Source | Says |
|---|---|
| WBS 2.9 part 2 (fix), brief Decision 2 | "a batch has one expiry" — a different non-null expiry is refused with `ConflictingExpiryError` |
| same, implementation | detection is per `wms.stock_balance` row, key `(client_id, sku_id, location_id, batch_no)`; the advisory lock is taken per key |
| 01-Data-Model.sql 695-730 | `expiry_date` lives on `wms.stock_movements` and `wms.stock_balance`; no batch-level table or constraint |

A put-away transfer carries the source row's expiry, so transfers cannot diverge. Two RECEIPTS of the same
`(client, sku, batch_no)` at two different locations with different expiries are both accepted today.

## Options (decision needed)

1. **Application check, batch-level lock.** Before a receipt, take an advisory lock on `(client, sku, batch_no)` and
   compare with every existing balance row of the batch. No schema change; adds a second lock to the ledger's
   lock order (ADR-0002 review needed).
2. **Schema backstop.** A batch-level table (e.g. one row per `(client_id, sku_id, batch_no)` with `expiry_date`,
   RLS, G6 classification) or an exclusion/trigger constraint on `wms.stock_balance`. Needs a Master-issued
   migration number, a doc 01/13B amendment and a pre-migration review.
3. **Accept per-location scope.** Record the limit in doc 40 / the wms brief; no change.

## Until decided

PR #185 (2.9 part 2) ships the per-row rule; this SCR does not block it. Backlog row `2.9 part 3` tracks the decision.
