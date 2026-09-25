# SLICE BRIEF — WBS 4.1a · CoA structure X-XX-XXX-XXX + class 1–9; synthetic pilot chart

Task: 4.1a "CoA structure X-XX-XXX-XXX + class 1–9; synthetic pilot chart"      Lane: 2      Lock: `billing` (whole module — lane 2's existing lock, carried from 4.2 under ADR-0004 D2 (e); the Master records the task change in `tasks/LANE_LOCKS.md`)
Owner: CFO      Deps: 0.12 (doc 38 v4.6); sequenced after 4.2 by D-187 (backlog status "READY — lane 2 after 4.2 (D-187)")      Worktree: `../pg-eos-lane-2`
Model routing: pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus (also BEFORE the migration) → pg-scribe sonnet. Budget: brief ≤ 8 files / 1,000 lines, two review rounds (D-186).
Use case: `chart-of-accounts` — `scripts/new-slice.sh billing chart-of-accounts` (golden-slice replication; hand-made tree = review FAIL).

## Acceptance (doc 38 v4.6 row 4.1a, verbatim)
"Off-format code rejected by CHECK; no account-code literal in `modules/`"

## ADR-0004 decision lines this slice serves (verbatim)
- D1 6: "`entity_id` stays a hard column; every other axis is dimension data."
- D1 10: "Tax, IFRS mapping, XBRL taxonomy, depreciation and payroll rules are configuration, never code."
- D2 (c): "Per-entity rows from a mandatory shared template; entity-specific leaf accounts allowed (the schema already stores the chart per entity, `unique (entity_id, code)`, 01:1186)."
- D2 (e): "lane 2 takes the accounting core (4.1a → 4.1b → 4.19 → 4.20) after WBS 4.2, under its existing `billing` lock; pilot on a synthetic chart (D-127); the real chart stays 4.1 / lane A."
- D3 OD-10: "Adopt the spec format; doc 06 §6 codes mapped".

## SCR-ACC-01 rows (verbatim from A0 §3)
- #1 `billing.gl_accounts.code` (01:1181) — "CHECK on X-XX-XXX-XXX; class 1–9 from the first segment"
- #2 `billing.gl_accounts.account_type` (01:1183) — "Values for Cost of Revenue, Other Income/Expense, Tax, Control/Memorandum"

## Read ONLY (workers) — 8 files, within the 8-file / 1,000-line budget
- `CLAUDE.md`
- `.claude/briefs/billing.brief.md` lines 1-100
- `docs/adr/ADR-0004-general-ledger-single-source.md` lines 19-29, 34-36, 59-59
- `docs/notes/SCR-ACC-01-accounting-core.md` lines 14-17, 50-52
- `database/schema/01-Data-Model.sql` lines 1176-1186
- `docs/package/06-Sales-CRM-and-Accounting.md` lines 149-159
- `database/migrations/0015_2_platform-sites.sql` lines 96-134
- `modules/wms/domain/receive-inbound/invariants.ts`

Write ONLY: `modules/billing/{domain,application,infrastructure,api,tests}/chart-of-accounts/**` · `packages/contracts/billing/chart-of-accounts.ts` · `packages/i18n/<lang>/billing.json` (chart-of-accounts keys only) · `database/migrations/NNNN_2_chart-of-accounts.sql` (number issued by the Master) · `tests/**`. pg-tester writes only test files; builders never touch a test.

## Golden-slice counterparts (produced by `new-slice.sh`, edited in place — not reference reads)
`modules/wms/domain/receive-inbound/*` → `modules/billing/domain/chart-of-accounts/*` · `modules/wms/application/receive-inbound/*` → `modules/billing/application/chart-of-accounts/*` · `modules/wms/infrastructure/receive-inbound/*` → `modules/billing/infrastructure/chart-of-accounts/*` · `modules/wms/api/receive-inbound/*` → `modules/billing/api/chart-of-accounts/*` · `modules/wms/tests/receive-inbound/*` → `modules/billing/tests/chart-of-accounts/*` · `packages/contracts/wms/receive-inbound.ts` → `packages/contracts/billing/chart-of-accounts.ts`. No `machine.ts` edges: an account has no lifecycle in 01 (delete the copied machine, precedent 5.5a part 1).

## RED tests (SCR-ACC-01 §3 — must exist before the migration file)
`modules/billing/tests/chart-of-accounts/chart-of-accounts.feature` · `modules/billing/tests/chart-of-accounts/chart-of-accounts.test.ts` · `modules/billing/tests/chart-of-accounts/invariants.property.test.ts`

Scenario (Gherkin outline — pg-tester writes the full `.feature`; every Then traces to the acceptance line or an ADR line above):
```gherkin
Feature: Chart of accounts structure (WBS 4.1a)
  Scenario: An account code in the X-XX-XXX-XXX format is accepted and its class is its first segment
  Scenario: An off-format account code is rejected by the database CHECK, not only by the domain
  Scenario: A first segment outside class 1–9 is rejected by the database CHECK
  Scenario: An account_type outside the allowed list is rejected
  Scenario: The same code may exist once per entity and never twice in one entity (unique (entity_id, code))
  Scenario: No account-code literal appears under modules/ (static scan test over the source tree)
```
Property test: for every generated string, the domain format check and the DB CHECK agree (accept ⇔ accept).

Contract: `packages/contracts/billing/chart-of-accounts.ts` — derive from `billing.gl_accounts` (01:1176-1186) plus SCR-ACC-01 #1–#2; no field that is not a column.
Screen/Board spec: none this slice (API + DB only).
Deliver: the file list printed by `scripts/new-slice.sh billing chart-of-accounts` (paste it here when run) + `database/migrations/NNNN_2_chart-of-accounts.sql` (CHECK on `code`, `account_type` value list, column classification rows for any new column, RLS unchanged: `reference_read · reference_write`).
Migration number: requested — lane 2 lists it in `tasks/backlog/MIGRATION-REQUEST-2.md` with the RED paths above (D-179 batch); not issued.

## Defaults taken (recorded in CHANGELOG with the slice)
- The synthetic pilot chart (D-127) carries no real account. Neither A0 nor ADR-0004 lists its rows, and OD-10 "doc 06 §6 codes mapped" names no mapping table. Default: the worker composes no account name or code; synthetic chart rows are test / synthetic-seed fixtures (D-127), never in the migration (ADR-0004 D3: no account is seeded); their source is a batched GM/CFO question in the closing report. RLS stays `reference_read` / `reference_write` (13B:3078 — `billing.gl_accounts` is a reference table), so no cross-entity RLS scenario is written; any RLS change is a G-01 line for the pre-migration review. The mapping of the real doc 06 §6 codes stays with 4.1 (lane A).
- The four `account_type` additions are exactly the words of SCR-ACC-01 #2. Their DB spelling is proposed in the migration request and fixed at the pre-migration pg-reviewer review; no value outside those words.

Stop-and-ask if: any table, column or rule not in 01 / 13 / 13B / 019 / 40 or SCR-ACC-01 #1–#2 — STOP and report (G-01); never invent an account, a code or a class name.

## Carried item — WBS 4.2 part 2 (Master ruling, `<this commit>` closing 4.2 part 1)
4.2 is DONE-in-part, not DONE: its own round-2 finding 2 (duplicate-detection test not reaching the DB-constraint/SQLSTATE-23505 path) was fixed by pg-tester AFTER 4.2's round 2 and is mutation-proven (the lane locally neutralized the SQLSTATE 23505→typed-error mapping in `modules/billing/infrastructure/record-billable-event/repository.ts`, reran the test, confirmed it went RED on the exact assertion, then restored the file byte-identical and re-confirmed GREEN) — but it landed without pg-reviewer having seen it. **4.1a's own round-1 pg-reviewer review must include, as an explicit item: pg-reviewer confirmation of the SQLSTATE 23505 test (landed in 4.2 part 1 after round 2, mutation-proven by the lane).** This is not a new test to write — only pg-reviewer's confirmation of the already-landed test. If that item passes, 4.1a's own commit marks WBS 4.2 fully DONE (no separate 4.2 commit — no state-only commits, CLAUDE.md GIT).
