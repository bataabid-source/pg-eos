# MIGRATION-REQUEST-1 — lane 1 (sales)

| # | module | slug | purpose (one line) | requested | issued by Master |
|---|---|---|---|---|---|
| 1 | catalog | `price-lists-version` | (applied — 0013) | 2026-09-24 | 0013 |
| 2 | sales | `quotes-version` | (applied — 0017) | 2026-09-25 | 0017 |
| 3 | sales | `contracts-version` | `sales.contracts.version int not null default 1` (+ column_classification row) — WBS 1.7's mutable aggregate needs the optimistic-lock column CLAUDE.md · ARCHITECTURE requires; verbatim replica of 0008/0013/0017 | 2026-09-25 | 0019 |
| 4 | sales | `accounts-version` | `sales.accounts.version int not null default 1` (+ column_classification row) — WBS 1.8's mutable aggregate (credit_limit/credit_hold) needs the optimistic-lock column CLAUDE.md · ARCHITECTURE requires; verbatim replica of 0008/0013/0017/0019 | 2026-09-25 | 0020 |
| 5 | sales | `accounts-internal-write-policy` | `sales.accounts` had no write RLS policy at all (G-01, D-177 ruling, `docs/notes/SCR-SALES-ACCT-01-accounts-write-policy.md`) — adds `internal_only for all using (platform.is_internal())`, matching the existing pattern on other non-entity-scoped tables | 2026-09-25 | 0021 |
