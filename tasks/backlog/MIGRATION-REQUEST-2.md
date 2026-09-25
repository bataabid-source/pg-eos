# MIGRATION-REQUEST-2 — lane 2 (wms)

| # | module | slug | purpose (one line) | requested | issued by Master |
|---|---|---|---|---|---|
| 1 | wms | `inventory-counts-version` | `wms.inventory_counts.version int not null default 1` (+ column_classification row) — optimistic-lock column for WBS 2.13's StartCount/CountLocation/Recount/AdjustCount, shape of 0008/0014/0015/0016. pg-reviewer pre-migration review: **APPROVED WITH CHANGES (3 findings, comment-only, all applied)**. | 2026-09-25 | **0018** (`f070f62`, applied, verified) |
