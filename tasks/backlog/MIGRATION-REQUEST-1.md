# MIGRATION-REQUEST-1 — lane 1 (sales)

| # | module | slug | purpose (one line) | requested | issued by Master |
|---|---|---|---|---|---|
| 1 | catalog | `price-lists-version` | (applied — 0013) | 2026-09-24 | 0013 |
| 2 | sales | `quotes-version` | `sales.quotes.version int not null default 1` (+ column_classification row) — WBS 1.6's mutable aggregate needs the optimistic-lock column CLAUDE.md · ARCHITECTURE requires; verbatim replica of 0008/0013 | 2026-09-25 | pending — next free number requested (0016+, after 0015 platform-sites) |
