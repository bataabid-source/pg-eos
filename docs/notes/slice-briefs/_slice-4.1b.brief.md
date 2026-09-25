# SLICE BRIEF — WBS 4.1b · Dimensions: types + line dimensions

Task: 4.1b "Dimensions: types + line dimensions"      Lane: 2      Lock: `billing` (whole module — lane 2's lock under ADR-0004 D2 (e); the Master records the task change in `tasks/LANE_LOCKS.md`)
Owner: CFO      Deps: 4.1a (doc 38 v4.6)      Worktree: `../pg-eos-lane-2`
Model routing: pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus (also BEFORE the migration) → pg-scribe sonnet. Budget: brief ≤ 8 files / 1,000 lines, two review rounds (D-186).
Use case: `dimensions` — `scripts/new-slice.sh billing dimensions` (golden-slice replication; hand-made tree = review FAIL).

## Acceptance (doc 38 v4.6 row 4.1b, verbatim)
"New dimension added with zero migration; undefined value rejected"

## ADR-0004 decision lines this slice serves (verbatim)
- D1 6: "`entity_id` stays a hard column; every other axis is dimension data."
- D2 (d): "`entity_id` stays the hard column (RLS/SoD depend on it, 0003/0025); generic dimension tables (A0 §3 row 9) for every other axis; `client_id`/`contract_id` kept as derived copies (P2 allows derivation)."
- D2 (e): "lane 2 takes the accounting core (4.1a → 4.1b → 4.19 → 4.20) after WBS 4.2, under its existing `billing` lock; pilot on a synthetic chart (D-127)".

## SCR-ACC-01 row (verbatim from A0 §3)
- #9 new `billing.dimension_types`, new `billing.line_dimensions` — "Dimensions as data; backs the fixed `client_id/contract_id/cost_center` (01:1208-1210)"

## Read ONLY (workers) — 7 files, within the 8-file / 1,000-line budget
- `CLAUDE.md`
- `.claude/briefs/billing.brief.md` lines 1-100
- `docs/adr/ADR-0004-general-ledger-single-source.md` lines 19-29, 35-36
- `docs/notes/SCR-ACC-01-accounting-core.md` lines 14-15, 24-24, 50-53
- `database/schema/01-Data-Model.sql` lines 1202-1213
- `database/migrations/0015_2_platform-sites.sql` lines 50-134
- `modules/wms/domain/receive-inbound/invariants.ts`

Write ONLY: `modules/billing/{domain,application,infrastructure,api,tests}/dimensions/**` · `packages/contracts/billing/dimensions.ts` · `packages/i18n/<lang>/billing.json` (dimensions keys only) · `database/migrations/NNNN_2_dimensions.sql` (number issued by the Master) · `tests/**`. pg-tester writes only test files; builders never touch a test.

## Golden-slice counterparts (produced by `new-slice.sh`, edited in place — not reference reads)
`modules/wms/domain/receive-inbound/*` → `modules/billing/domain/dimensions/*` · `modules/wms/application/receive-inbound/*` → `modules/billing/application/dimensions/*` · `modules/wms/infrastructure/receive-inbound/*` → `modules/billing/infrastructure/dimensions/*` · `modules/wms/api/receive-inbound/*` → `modules/billing/api/dimensions/*` · `modules/wms/tests/receive-inbound/*` → `modules/billing/tests/dimensions/*` · `packages/contracts/wms/receive-inbound.ts` → `packages/contracts/billing/dimensions.ts`. No `machine.ts` edges: a dimension type has no lifecycle named in A0 or ADR-0004 (delete the copied machine, precedent 5.5a part 1).

## RED tests (SCR-ACC-01 §3 — must exist before the migration file)
`modules/billing/tests/dimensions/dimensions.feature` · `modules/billing/tests/dimensions/dimensions.test.ts` · `modules/billing/tests/dimensions/invariants.property.test.ts`

Scenario (Gherkin outline — pg-tester writes the full `.feature`; every Then traces to the acceptance line or an ADR line above):
```gherkin
Feature: Generic dimensions (WBS 4.1b)
  Scenario: A new dimension type is added as a data row — no DDL runs (zero migration)
  Scenario: A journal line tagged with a value of a defined dimension type is accepted
  Scenario: A journal line tagged with an undefined dimension value is rejected by the database
  Scenario: entity_id is never a dimension type — it stays the hard column on the entry (D1 6)
  Scenario: client_id and contract_id stay on journal_lines as derived copies (D2 (d)); nothing is dropped
  Scenario: RLS — a caller scoped to another entity cannot read or write this entity's dimension rows
```
Property test: for any generated set of dimension types and values, a line accepts exactly the defined values and rejects every other.

Contract: `packages/contracts/billing/dimensions.ts` — derive from SCR-ACC-01 #9 and `billing.journal_lines` (01:1202-1213); no field that is not a column of the migration.
Screen/Board spec: none this slice (API + DB only).
Deliver: the file list printed by `scripts/new-slice.sh billing dimensions` (paste it here when run) + `database/migrations/NNNN_2_dimensions.sql` (the two tables of SCR-ACC-01 #9, RLS on both, `identity.column_classification` rows for every new column, grants to `pgeos_app` as 0015).
Migration number: requested — lane 2 lists it in `tasks/backlog/MIGRATION-REQUEST-2.md` with the RED paths above (D-179 batch); not issued.

## Defaults taken (recorded in CHANGELOG with the slice)
- Column lists of `dimension_types` and `line_dimensions` are not stated in A0 or ADR-0004 beyond their purpose. Default: the migration request proposes the minimum columns that meet the acceptance line (type row · value reference · line reference · `entity_id` where RLS needs it · `version` on the mutable aggregate), fixed at the pre-migration pg-reviewer review; no dimension type is seeded (D3: nothing seeded).
- `cost_center text` (01:1210) is not dropped in this slice (forward-only, derivation allowed per D2 (d)); its migration to a dimension value is a later G-01 line if the CFO asks.

Stop-and-ask if: any table, column or rule not in 01 / 13 / 13B / 019 / 40 or SCR-ACC-01 #9 — STOP and report (G-01); never invent a dimension type or value.
