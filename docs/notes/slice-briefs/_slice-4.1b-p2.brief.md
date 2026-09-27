# SLICE BRIEF — WBS 4.1b part 2 · Line dimensions write path + dimension values (list kind, reference kind)

Task: 4.1b part 2 "Dimensions: line dimensions + values"      Lane: 2 (build lane B, wave 1)      Lock: `billing`
builder: pg-builder-core
Owner: CFO      Deps: 4.1b part 1 (`dimension_types`, migration 0030)      Worktree: `../pg-eos-lane-2`      Branch: `lane/2-4.1b-p2`
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED, and BEFORE the migration) → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget: ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.
Use case: `dimensions` (exists since part 1 — extend in place; no second tree). Golden slice: WBS 2.9 `receive-inbound`.

## Acceptance (doc 38 row 4.1b, verbatim)
"New dimension added with zero migration; undefined value rejected" — part 1 proved the first half; this part proves "undefined value rejected" and "zero orphan `line_dimensions.value_id` rows" (MASTER_BACKLOG row 4.1b part 2).

## Design (SCR-ACC-01 row 9, D-190 — fully specified, no further ruling)
- **list kind:** `billing.dimension_values` (entity_id, dimension_type_id, code, name, is_active, version) + composite FK `line_dimensions (dimension_type_id, value_id) → dimension_values (dimension_type_id, id)` — declarative, no trigger.
- **reference kind:** `line_dimensions.value_id uuid` validated by constraint trigger `billing.assert_dimension_value()` — the row exists in `dimension_types.source_table` (closed CHECK whitelist of 8, part 1) and, where that source has `entity_id`, belongs to the line's entity (precedent style `billing.reject_holding_invoice`).
- Carried from part 1's review (not re-litigated): no `on delete cascade` on `journal_line_id`; `select, insert`-only grant on `line_dimensions` (append-only, doc 40 P3); an entity-deriving trigger validating `line_dimensions.entity_id` against `journal_lines → journal_entries`. `value_ref text` is never built. "Zero orphan values" = a G-01 report-only line, not blocking.
- Split rule (Master): if this exceeds 8 files / 1,000 lines, part 2 = list kind, part 3 = reference kind.

## Read ONLY (workers) — 7 files, within the 8-file / 1,000-line budget
- `CLAUDE.md`
- `.claude/briefs/billing.brief.md` lines 1-100
- `docs/notes/SCR-ACC-01-accounting-core.md` lines 24-24, 53-53
- `database/migrations/0030_2_dimensions.sql`
- `packages/contracts/billing/dimensions.ts`
- `database/schema/01-Data-Model.sql` lines 1188-1215, 1575-1586
- `modules/wms/domain/receive-inbound/machine.ts`

Write ONLY: `modules/billing/{domain,application,infrastructure,api,tests}/dimensions/**` · `packages/i18n/<lang>/billing.json` (dimension keys only) · `database/migrations/0038_2_line-dimensions.sql` · `tests/**`. pg-tester writes only test files; builders never touch a test.
Contract: `packages/contracts/billing/dimensions.ts` is FROZEN (wave-1 contract, committed by the Master: `DimensionValueInputSchema`, `LineDimensionInputSchema`, `CreateDimensionValueInputSchema`, `DeactivateDimensionValueInputSchema`, routes `create-dimension-value`, `deactivate-dimension-value`). A field it lacks → STOP and report; never edit it.
Routes: `apps/api/src/route-table.ts` lists both routes in `UNIMPLEMENTED_ROUTES`; the host refuses a listed route that has a handlers file. Do NOT edit `apps/api` — when your handlers exist, report it; the Master removes the two paths (and the test's expected list) on your branch before merge. Until then the only acceptable CI red is `apps/api/tests/route-table.unit.test.ts` naming those two routes.

## RED tests (must exist before the migration file — lane-guard.sh)
`modules/billing/tests/dimensions/line-dimensions.feature` · `modules/billing/tests/dimensions/line-dimensions.test.ts` · `modules/billing/tests/dimensions/line-dimensions.property.test.ts`

```gherkin
Feature: Line dimensions and dimension values (WBS 4.1b part 2)
  Scenario: A list-kind value is created per entity and tagged on a journal line
  Scenario: A line tagged with a value that does not exist for its dimension type is rejected by the database
  Scenario: A reference-kind value must exist in the type's source table and belong to the line's entity
  Scenario: A deactivated value cannot be tagged on a new line; existing tags stay
  Scenario: line_dimensions is append-only — UPDATE and DELETE are refused for the app role
  Scenario: line_dimensions.entity_id must equal the entity of its journal entry
  Scenario: Stale version is rejected; idempotent replay returns the first result; one outbox + one audit row per write
  Scenario: RLS — a caller scoped to another entity cannot see or tag this entity's values
```
Property test: for any generated types/values/lines, the DB accepts a tag ⇔ the value exists for that type (list: in `dimension_values`; reference: in the source table, same entity when the source has one).

Deliver: the part-1 tree extended in place + `database/migrations/0038_2_line-dimensions.sql` (tables with RLS, `version`, column classification rows, the FK, the two triggers, the grants).
Migration number: **0038 — issued to lane 2** (register in `database/migrations/README.md` in the slice commit).

## Defaults (one CHANGELOG line each, in the slice commit)
- `dimension_values.code` unique per (entity_id, dimension_type_id); a deactivated value keeps its code.
- The G-01 orphan line is report-only (G18 style), never blocking.

Stop-and-ask if: any table, column or rule not in 01 / 13 / 13B / 019 / 40 or SCR-ACC-01 row 9 — STOP and report (G-01); never invent a column, a role or a source table.
