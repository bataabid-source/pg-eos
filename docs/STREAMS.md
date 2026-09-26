# STREAMS — the build order to the pilot (ADR-0005, D-192)

The unit of planning is a doc 40 Part E scenario. A stream is the minimal set of doc-38 rows, across
modules, that turns its scenarios green in Playwright. A row is DONE when its scenario is green.
Rows not listed here are decided by the GM after the streams run. Row IDs, dependencies and lanes are
doc 38 v4.7's; nothing here adds a table, column or rule.

## Streams (in order)

| # | Stream | Scenarios | Minimal rows (dependency order) | Proof |
|---|---|---|---|---|
| A | Warehouse runs | S1, S2, S18 | 2.16 (only the screens S1/S2/S18 need) → 2.18 | PDA receives and ships |
| B | Order to invoice | S8, S11 | 3.4 (core + POD) → 4.3 → 4.1b p2 → 4.19 → 4.20 (minimum posting) → 4.4 → 4.6 → 4.18 | first automated invoice matches operations |
| C | Delivery + iMile | S3, S4, S15, S16 | 3.5 → 3.6 → 3.7 (core) · 3.12/3.13 close → 3.14 p2 → 3.15 → 3.18 → 3.20 | driver and sorter work |
| D | Client and decision | S7, S9, S12 | 6.4 → 6.3 (needs 5.13 p2) → 6.1 (scenario screens only) → 6.7 | client and GM see the system |
| E | Payroll and admin | S13, S14, S17 | 5.3 → 5.6 (needs 3.13) · 5.11 → 5.16 / 5.17 | one payroll month |
| F | Financial close | S19, S20 | 4.7 → 4.9 · 4.11 → 4.16 → 4.17 | month-end |

Dependency hubs: **3.4** unlocks 3.5–3.11, 4.3, 4.10, 5.1, 6.1 · **4.20** unlocks 3.6a, 4.7a, 4.11, 4.12a, 4.22, 4.23, 5.6a, 5.11a/b · **3.14 p2 + 2.16** unlock 3.15, 3.18.

## Waves (two build lanes + one integration lane)

| Wave | Build lane 1 | Build lane 2 | Integration lane |
|---|---|---|---|
| 1 | A: 2.16 → 2.18 | B: 4.1b p2 → 4.19 → 4.20 | Playwright bootstrap · S1, S2, S18 · greening of the ~15 known red tests |
| 2 | B: 3.4 → 4.3 | B: 4.4 → 4.6 → 4.18 | S8, S11 |
| 3 | C: 3.5 → 3.6 → 3.7 | C: 3.12/3.13 close → 3.14 p2 → 3.15 → 3.18 | S3, S4, S15, S16 → 3.20 |
| 4 | D: 6.4 → 6.1 | D: 5.13 p2 → 6.3 | S7, S9, S12 → 6.7 |
| 5 | E: 5.3 → 5.6 | E: 5.11 | S13, S14, S17 → 5.16 / 5.17 |
| 6 | F: 4.7 → 4.9 | F: 4.11 → 4.16 | S19, S20 → 4.17 |
| 7 | GM decision on the remaining rows | | 7.3 · 7.4 (S1–S20 in CI) · 7.1 · 7.2 · 7.12 |

Before each wave the Master commits the wave's contracts and catalog names (ADR-0005 §3). Merge order
inside a wave: the branch carrying a migration first, then the others; each merge = rebase → gates ①–③ →
`pnpm guards:run` → merge → delete branch.

## Enablement (Master + integration lane, before wave 1)

1. Security — DONE in this commit set: `PG_APP_USER` required and verified against `pg_roles` on first connect, no superuser fallback (ADR-0005 §7). The approval chain already binds `approved_by` to the session (`0034:394`); re-checked in 4.1b part 2's pre-migration review.
2. Greening — fix (never skip) the known red tests: `modules/platform/tests/evaluate-alerts/**`, `modules/platform/tests/integration/{schema-invariants,audit-chain-seq,audit-chain-concurrency}.test.ts`, `modules/wms/tests/receive-inbound` T9 fixtures.
3. Real gates — vitest coverage ≥ 90% on `domain/`; Stryker nightly ≥ 75%; Playwright with S1/S2 first; `scripts/deploy.sh` running G15–G17.
4. Domain purity — the 4 `*.property.test.ts` files opening a `pg.Pool` move to integration.
5. Deduplication — `logger` and `requireIdempotencyKey` into `packages/`; `scripts/new-slice.sh` imports them.
6. OpenAPI — every module registers in `packages/contracts/_shared/registry.ts`; contract tests derive from it.
7. Documents v2 — CLAUDE.md ≤ 80 lines (history → `docs/GOVERNANCE-HISTORY.md`), generated PROJECT_STATE (`scripts/scribe.mjs`), CHANGELOG entry ≤ 12 lines, LANE_LOCKS table only, stream locks in `scripts/check-locks.sh`, four agents (ADR-0005 §5).

## Operating protocol

- Lane start: read CLAUDE.md, PROJECT_STATE, the brief — nothing else. Sequence: brief → pre-build review → RED → build → GREEN → close review → scribe → one `feat(<WBS>)` commit → push `lane/<id>/<wbs>` → one report trigger to the Master → exit.
- Master per report: rebase → gates → guards → merge → delete branch → launch the stream's next slice. Reports to the GM only on: a scenario green, a stream merged, a REAL BLOCKER.
- Budget: ≤ 150k tokens per slice (written in the brief); > 2× splits the slice. One `chore(X)`/`docs(X)` per day.

## Targets (printed by `/pg-state`)

| Metric | 2026-09-26 | Target |
|---|---|---|
| Scenarios green | 0/20 | +3 per week → 20/20 before the pilot |
| Commits per WBS row | 4–8 | ≤ 3 |
| Review findings per slice | 7.2 | ≤ 3 |
| feat/fix share | 56% | ≥ 75% |
| Known red tests | ~15 | 0 |
| domain coverage / mutation | not measured | ≥ 90% / ≥ 75% |
| Lines read at session start | ~600 | ≤ 150 |

## Timeline

- to 2026-09-27 03:00 UTC: Master executes enablement items 1 and the cleanup in this session; lanes relaunch automatically when the quota resets.
- 2026-09-27 → 29: enablement 2–7.
- 2026-09-30 → ~10-12: waves 1–4 (streams A–D); first automated invoice ≈ 10-07.
- 10-13 → 18: waves 5–6. · 10-19 → 22: wave 7 (hardening).
