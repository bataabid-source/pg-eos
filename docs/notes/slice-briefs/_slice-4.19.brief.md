# SLICE BRIEF — WBS 4.19 · Fiscal years + periods (open/closed/locked)

Task: 4.19 "Fiscal years + periods (open/closed/locked)"      Lane: 2      Lock: `billing` (whole module — lane 2's lock under ADR-0004 D2 (e); the Master records the task change in `tasks/LANE_LOCKS.md`)
builder: pg-builder-core
Owner: CFO      Deps: 4.1a (doc 38 v4.6)      Worktree: `../pg-eos-lane-2`
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED, and BEFORE the migration) → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget: ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.
Use case: `accounting-periods` — `scripts/new-slice.sh billing accounting-periods` (golden-slice replication; hand-made tree = review FAIL).

## Acceptance (doc 38 v4.6 row 4.19, verbatim)
"Posting into closed/locked period rejected by the DB"

## ADR-0004 decision lines this slice serves (verbatim)
- D1 5: "Periods open/closed/locked per entity; the DB refuses posting into closed/locked periods."
- D2 (e): "lane 2 takes the accounting core (4.1a → 4.1b → 4.19 → 4.20) after WBS 4.2, under its existing `billing` lock; pilot on a synthetic chart (D-127)".
- D3 OD-12: "Fiscal year end per entity; who closes, locks, reopens" — standing default "Ask; CFO closes; reopen via Decision Inbox".

## SCR-ACC-01 rows (verbatim from A0 §3)
- #3 new `billing.fiscal_years`, new `billing.accounting_periods` — "Fiscal year; periods open/closed/locked per entity"
- #4 `billing.journal_entries` (01:1189) — "Period link; posting to closed/locked period refused"

## Read ONLY (workers) — 7 files, within the 8-file / 1,000-line budget
- `CLAUDE.md`
- `.claude/briefs/billing.brief.md` lines 1-100
- `docs/adr/ADR-0004-general-ledger-single-source.md` lines 19-29, 36-36, 48-49, 61-61
- `docs/notes/SCR-ACC-01-accounting-core.md` lines 14-15, 18-19, 50-54
- `database/schema/01-Data-Model.sql` lines 48-68, 1188-1200
- `database/migrations/0015_2_platform-sites.sql` lines 50-134
- `modules/wms/domain/receive-inbound/machine.ts`

Write ONLY: `modules/billing/{domain,application,infrastructure,api,tests}/accounting-periods/**` · `packages/i18n/<lang>/billing.json` (accounting-periods keys only) · `database/migrations/0040_2_accounting-periods.sql` (number issued by the Master) · `tests/**`. pg-tester writes only test files; builders never touch a test.

## Golden-slice counterparts (produced by `new-slice.sh`, edited in place — not reference reads)
`modules/wms/domain/receive-inbound/{machine.ts,errors.ts,invariants.ts}` → `modules/billing/domain/accounting-periods/*` (the XState period machine replaces the inbound machine) · `modules/wms/application/receive-inbound/*` → `modules/billing/application/accounting-periods/*` · `modules/wms/infrastructure/receive-inbound/*` → `modules/billing/infrastructure/accounting-periods/*` · `modules/wms/api/receive-inbound/*` → `modules/billing/api/accounting-periods/*` · `modules/wms/tests/receive-inbound/*` → `modules/billing/tests/accounting-periods/*` (the contract already exists and is frozen — new-slice.sh must not overwrite it).

## RED tests (SCR-ACC-01 §3 — must exist before the migration file)
`modules/billing/tests/accounting-periods/accounting-periods.feature` · `modules/billing/tests/accounting-periods/accounting-periods.test.ts` · `modules/billing/tests/accounting-periods/period-machine.unit.test.ts` · `modules/billing/tests/accounting-periods/invariants.property.test.ts`

Scenario (Gherkin outline — pg-tester writes the full `.feature`; every Then traces to the acceptance line or an ADR line above):
```gherkin
Feature: Fiscal years and accounting periods (WBS 4.19)
  Scenario: A journal entry dated inside an open period of its entity is accepted
  Scenario: A journal entry dated inside a closed period is rejected by the database (not only the domain)
  Scenario: A journal entry dated inside a locked period is rejected by the database
  Scenario: Periods are per entity — closing a period of one entity leaves the other entities' periods open
  Scenario: Close is a CFO action (OD-12); every state change writes one outbox row and one audit row in the same transaction
  Scenario: Reopen goes through the Decision Inbox (OD-12), never a direct update
  Scenario: Stale version is rejected; idempotent replay returns the first result
  Scenario: RLS — a caller scoped to another entity cannot see or change this entity's periods
```
Machine (XState, no if/switch): states `open · closed · locked` (D1 5 words); edges only those OD-12 names — close (CFO), lock, reopen via Decision Inbox. Any other edge: STOP and report.
Property test: for any generated set of periods and entry dates, the DB accepts a posting ⇔ the covering period of the same entity is `open`.

Contract: `packages/contracts/billing/accounting-periods.ts` is FROZEN (wave-1 contract, committed by the Master). A field it lacks → STOP and report; never edit it.
Routes: `apps/api/src/route-table.ts` lists the five routes (`create-fiscal-year`, `open-period`, `close-period`, `lock-period`, `reopen-period`) in `UNIMPLEMENTED_ROUTES`; the host refuses a listed route that has a handlers file. Do NOT edit `apps/api` — when your handlers exist, report it; the Master removes the paths (and the test's expected list) on your branch before merge. Until then the only acceptable CI red is `apps/api/tests/route-table.unit.test.ts` naming those routes.
Screen/Board spec: none this slice (API + DB only).
Deliver: the file list printed by `scripts/new-slice.sh billing accounting-periods` (paste it here when run) + `database/migrations/0040_2_accounting-periods.sql` (the two tables of #3 with RLS, `version` column, column classification rows; the #4 period link on `billing.journal_entries`; the DB-side refusal of a posting into a closed or locked period).
Migration number: **0040 — issued to lane 2** (Master M2, 2026-09-27; file `database/migrations/0040_2_accounting-periods.sql`, RED tests above first; register in `database/migrations/README.md` in the slice commit).

## Defaults taken (recorded in CHANGELOG with the slice)
- OD-12 "Ask": no fiscal-year end is seeded for any entity (`platform.entities.fiscal_year_end`, 01:62, stays as it is); pilot periods are synthetic fixtures (D-127). Batched question: each entity's fiscal-year end.
- Which role locks (as distinct from closes) is not named by OD-12. Default: the doc 38 row 4.19 Owner (CFO) for both close and lock, recorded and added to the batched GM questions; any other role is a GM line.
- Reopen goes through the Decision Inbox (OD-12): the reopen requester ≠ the approver (`identity.sod_rules`); the approver role is fixed at the pre-migration pg-reviewer review — never the requester.

Stop-and-ask if: any table, column or rule not in 01 / 13 / 13B / 019 / 40 or SCR-ACC-01 #3–#4 — STOP and report (G-01); never invent a period length, a date or a role.
