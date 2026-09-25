# MIGRATION-REQUEST-1 — lane 1 (sales)

| # | module | slug | purpose (one line) | requested | issued by Master |
|---|---|---|---|---|---|
| 1 | catalog | `price-lists-version` | (applied — 0013) | 2026-09-24 | 0013 |
| 2 | sales | `quotes-version` | (applied — 0017) | 2026-09-25 | 0017 |
| 3 | sales | `contracts-version` | `sales.contracts.version int not null default 1` (+ column_classification row) — WBS 1.7's mutable aggregate needs the optimistic-lock column CLAUDE.md · ARCHITECTURE requires; verbatim replica of 0008/0013/0017 | 2026-09-25 | 0019 |
