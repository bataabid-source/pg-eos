# MIGRATION-REQUEST-1 — lane 1 (catalog)

| # | module | slug | purpose (one line) | requested | issued by Master |
|---|---|---|---|---|---|
| 1 | catalog | `price-lists-version` | `catalog.price_lists.version int not null default 1` (+ column_classification row) — the mutable aggregate of WBS 1.2 needs the optimistic-lock column CLAUDE.md · ARCHITECTURE requires; verbatim replica of 0008 (wms.inbound_orders) | 2026-09-24 | **0013** — issued in the Master's cross-session message 2026-09-24 ("migration number via MIGRATION-REQUEST-1.md — next free 0013"); file `database/migrations/0013_1_price-lists-version.sql` |
