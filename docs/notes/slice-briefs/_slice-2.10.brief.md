# SLICE BRIEF — WBS 2.10 · Put-away with automatic location suggestion (A2)

Task: 2.10 — Put-away with automatic location suggestion      Lane: 1      Lock: `wms` (tasks/LANE_LOCKS.md, claimed the moment lane 2's 2.15 released it)
Owner: WH_MGR      Deps: 2.9 DONE (golden slice, `78c640e`)      Worktree: `../pg-eos-lane-1`, branch `lane/1` (on origin/main `1d08fe2`)
Model routing (D-174): pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
**No new use case, no `scripts/new-slice.sh` run.** This slice is an in-place ENHANCEMENT of the golden slice's own `SuggestLocation` command — the golden slice already built it (2.9), and its own header comment explicitly flags what's missing: `"doc 40 §C3 'A2: conditions, ABC, proximity to shipping, capacity, client assignment' — no ABC-class weighting: doc 40 gives no formula (recorded as a follow-up, not a G-01 invention, per the slice brief)"`. Doc 38 row 2.10's acceptance — **"Suggestion respects conditions, ABC, capacity, client assignment"** — is that exact follow-up. `client assignment` and `capacity` are already implemented and reviewed in 2.9; this slice adds the two that were explicitly deferred: **conditions** and **ABC**. No migration — every column this needs already exists (`wms.skus.temp_min/temp_max/abc_class`, `wms.zones.temp_min/temp_max`).

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, batched for the GM)
- **"Conditions" narrows to temperature-range compatibility — the only condition with a matching column on both the SKU and the location's zone.** `wms.skus` also carries `is_hazmat`, `is_fragile`, `light_sensitive`, `stackable`/`max_stack_height` — but `wms.zones`/`wms.locations` have NO matching hazmat/fragile/light/stackability flag to check them against (zones only have `zone_type` — storage/receiving/quarantine/staging/shipping/returns/damaged — and `is_secure`; no "hazmat-approved" or "dark storage" flag exists anywhere). Checking those would require inventing a column, which this brief does not do — filed as a batched GM question (a future schema-change request, G-01, if the GM wants hazmat/fragile/light-sensitivity enforced at put-away). Temperature is the one condition fully computable today: a candidate's zone must cover the SKU's declared temperature range.
- **ABC-class is a per-CALL constant, not a per-candidate field.** `suggestLocation` is called for ONE `skuId`, so every candidate row in a single call shares the same `sku.abc_class` — it cannot distinguish candidate A from candidate B the way `clientAssignedMatch`/`remainingCapacityRatio`/`positionNo` do. The correct place for it is therefore in the RANKING FUNCTION'S OWN PARAMETER (which comparator order to apply for this whole call), not a new per-candidate field compared pairwise.
- **No formula for ABC weighting exists in any doc** (confirmed by the golden slice's own comment). Default taken, matching standard WMS practice and using only what's already there (the existing `positionNo`-as-proximity-proxy and `remainingCapacityRatio`-as-capacity-proxy signals, reordered, not replaced): for **class `'A'`** SKUs (fast movers), proximity to shipping outranks capacity headroom — a slightly tighter-but-closer location beats a roomier-but-farther one. For **class `'B'`/`'C'`/`null`**, the existing order stands unchanged (capacity before proximity) — 2.9's reviewed behavior for every SKU that isn't explicitly class A. `clientAssignedMatch` keeps outranking everything, unchanged (a client's dedicated location is a business commitment, not a preference). Batched GM question: confirm this ordering, or supply an explicit formula for B/C class too.
- **This is a golden-slice file, not a new tree — reviewed with the same rigor as 2.9 itself.** The Deliver list is three edited files (domain ranking, application command, infrastructure repository) plus two edited existing test files — no new use-case directory, no new contract file (the existing `SuggestLocationInput`/`SuggestLocationResult`/`LocationCandidate` shapes in `packages/contracts/wms/receive-inbound.ts` are extended, not replaced).

## Read ONLY (workers) — kept under the 12-file / 1,500-line budget
1. `CLAUDE.md`
2. `.claude/briefs/wms.brief.md`
3. **The files being enhanced, in full** (this IS the golden slice for this task — no separate "shape precedent" needed): `modules/wms/domain/receive-inbound/suggest-location-ranking.ts`, `modules/wms/application/receive-inbound/suggest-location.ts`, `modules/wms/infrastructure/receive-inbound/repository.ts` (the whole file — `suggestLocationCandidatesQuery` plus its neighbors, to preserve the file's existing conventions exactly), `modules/wms/application/receive-inbound/ports.ts` (`SuggestLocationCandidateRow`, `InboundOrderRepository`), `packages/contracts/wms/receive-inbound.ts` (`SuggestLocationInputSchema`)
4. `database/schema/01-Data-Model.sql`: `wms.skus` (verbatim DDL, `temp_min`/`temp_max`/`abc_class`), `wms.zones` (verbatim DDL, `temp_min`/`temp_max`), `wms.locations` (verbatim DDL) — reuse from earlier reads, grep directly
5. `database/schema/019-Warehouse-WH1-Setup.sql` lines 40-45 (`position_no`/`max_volume_cbm` ALTERs on `wms.locations` — confirms these columns' origin, already used by the existing query)
6. `docs/package/40-Build-Specification-EN.md` line 260 (the `SuggestLocation` command description, verbatim, quoted below)
7. `modules/wms/tests/receive-inbound/suggest-location-ranking.property.test.ts` (the existing property test — read to preserve its existing cases exactly, extend rather than replace)

## Write ONLY
- pg-tester: `modules/wms/tests/receive-inbound/suggest-location-ranking.property.test.ts` (EXTEND — add new property cases, do not remove or weaken the four existing ones) · `modules/wms/tests/receive-inbound/receive-inbound.test.ts` (EXTEND ONLY — add new `it`s for the SuggestLocation scenarios below; every existing scenario in this file must still pass unmodified) · nothing else.
- pg-backend: `modules/wms/domain/receive-inbound/suggest-location-ranking.ts`, `modules/wms/application/receive-inbound/suggest-location.ts`, `modules/wms/infrastructure/receive-inbound/repository.ts`, `modules/wms/application/receive-inbound/ports.ts`, `packages/contracts/wms/receive-inbound.ts` — EDIT these five existing files in place (no new files, no new directories).
Forbidden for every worker: any OTHER golden-slice file (`machine.ts`, `errors.ts`, `invariants.ts`, `handlers.ts`, `composition.ts`, every command file except `suggest-location.ts` itself), `database/schema/**`, `packages/**` other than the one named contract file, `packages/events/catalog.ts`, other modules, `docs/**`, `scripts/**`, `CLAUDE.md`, `.claude/**`. **No migration** — every column already exists.

## Acceptance criterion (doc 38 row 2.10, verbatim)
"Suggestion respects conditions, ABC, capacity, client assignment"
Gates: `pnpm --filter @pg-eos/wms typecheck && lint && test` green as `pgeos_app` · the FULL existing `receive-inbound.test.ts` suite must still pass (2.9's own acceptance stays intact) · `pnpm guards:run` green (no migration, so should already be green) · pg-reviewer PASS — **this review carries the same weight as a golden-slice touch; read the whole diff, not just the new lines.**

## Doc 40 (verbatim, line 260, the `SuggestLocation` command)
`SuggestLocation` (A2: conditions, ABC, proximity to shipping, capacity, client assignment)

## Master decisions the workers copy (not re-derive)
1. **`RankableLocationCandidate` gains one new field**: `abcClass: 'A' | 'B' | 'C' | null` (from `wms.skus.abc_class`, a `char(1)` column — pass through verbatim, no re-mapping, `null` when the SKU has no class set).
2. **`compareLocationCandidates` takes a second parameter**: `compareLocationCandidates(a, b, abcClass: 'A' | 'B' | 'C' | null): number`. New total order:
   - `clientAssignedMatch` (true first) — UNCHANGED, always the top tier.
   - If `abcClass === 'A'`: `positionNo` (lower first) THEN `remainingCapacityRatio` (higher first) — proximity before capacity.
   - Else (`'B'`, `'C'`, or `null`): `remainingCapacityRatio` (higher first) THEN `positionNo` (lower first) — UNCHANGED from 2.9, capacity before proximity.
   - Final tie-break (both tiers equal): stable, no further field to compare (matches 2.9's own final `return 0`).
3. **`rankLocationCandidates(candidates, abcClass)`** — signature gains the same second parameter, threaded straight into the comparator; still returns a NEW array, still non-mutating.
4. **Repository query (`suggestLocationCandidatesQuery`) gains a temperature-condition filter and the ABC read**: join `wms.zones z on z.id = l.zone_id`; add `s.temp_min`/`s.temp_max` to the `cross join wms.skus s` already present; add `s.abc_class` to the selected columns (constant across all rows of one call, per Scope — read once, returned on every row for convenience, or read separately by the application layer — pg-backend's call which is cleaner, record which). Add to the `where` clause: a candidate qualifies iff EITHER the SKU has no temperature requirement at all (`s.temp_min is null and s.temp_max is null` — every zone remains a candidate, exactly 2.9's existing behavior), OR the zone has an EXPLICIT range that covers the SKU's requirement (`z.temp_min is not null and z.temp_max is not null and z.temp_min <= s.temp_min and z.temp_max >= s.temp_max`). **Corrected during build (pg-tester caught it, round 0):** an EARLIER draft of this decision treated a null zone bound as "no constraint on that side," symmetric with the existing capacity-limit convention — but that would let an ambient zone with NO temperature control match a frozen SKU (both `z.temp_min`/`z.temp_max` null → the "no constraint" reading passes), directly contradicting this brief's own worked Scenario ("a temperature-sensitive SKU excludes an incompatible [ambient] zone entirely"). An ambient (uncontrolled) zone is compatible ONLY with a SKU that itself has no temperature requirement — it is not "unbounded" the way a null capacity limit is unbounded. This is the correct, final rule — not a batched GM question, since it directly matches the brief's own already-specified example, not a new invented threshold.
5. **`SuggestLocationResult`/`LocationCandidate`** (application + contract): add `abcClass: 'A' | 'B' | 'C' | null` to `LocationCandidate` so a future UI can show WHY a location was ranked where it is — informational, not required by the acceptance line itself but a natural, cheap addition given the field already flows through the pipeline.
6. **No behavior change for an all-null-class, no-temperature SKU** — every existing 2.9 scenario (which uses ordinary SKUs with no `abc_class`/`temp_min`/`temp_max` set) must produce IDENTICAL rankings to before this change. This is the regression guarantee pg-tester verifies by running the full existing suite unmodified.

## Scenario (Gherkin — pg-tester ADDS these to `receive-inbound.feature`/`receive-inbound.test.ts`, does not replace the existing scenarios)
```gherkin
  Scenario: A class-A SKU prefers a closer, slightly tighter location over a roomier, farther one
    Given SKU "SKU-A1" has abc_class 'A'
    And location "L-NEAR" (position_no 1) has 60% remaining capacity for this SKU/qty
    And location "L-FAR" (position_no 20) has 90% remaining capacity for the same SKU/qty
    When SuggestLocation is called for SKU-A1
    Then L-NEAR is ranked before L-FAR (proximity outranks capacity for class A)

  Scenario: A class-C SKU keeps the 2.9 capacity-first order
    Given SKU "SKU-C1" has abc_class 'C', the same two candidate locations as above
    When SuggestLocation is called for SKU-C1
    Then L-FAR is ranked before L-NEAR (capacity outranks proximity, unchanged from 2.9)

  Scenario: A SKU with no abc_class set behaves exactly like 2.9 (regression guarantee)
    Given SKU "SKU-NULL" has abc_class null
    When SuggestLocation is called for SKU-NULL against the same two candidates
    Then the ranking is identical to the class-C case

  Scenario: A temperature-sensitive SKU excludes an incompatible zone
    Given SKU "SKU-COLD" requires temp_min -18, temp_max -18 (frozen)
    And zone "Z-AMBIENT" has no temp_min/temp_max set (ambient, no cold chain)
    And zone "Z-FROZEN" has temp_min -25, temp_max -15 (covers the SKU's requirement)
    When SuggestLocation is called for SKU-COLD against locations in both zones
    Then only the Z-FROZEN location(s) appear in the candidate list; the Z-AMBIENT location is
      absent entirely, not merely ranked last

  Scenario: A SKU with no temperature requirement is unaffected by zone temperature
    Given SKU "SKU-AMBIENT" has temp_min and temp_max both null
    When SuggestLocation is called against the same Z-AMBIENT and Z-FROZEN locations
    Then both appear as candidates (no temperature filter applies)

  Scenario: Every existing 2.9 SuggestLocation scenario still passes unmodified
    (no new test — this is the existing suite re-run in full; the brief's own gate)
```
Property tests (fast-check, extend `suggest-location-ranking.property.test.ts`): (a) for `abcClass === 'A'`, for any two candidates with the same `clientAssignedMatch`, the one with the lower `positionNo` always ranks first regardless of `remainingCapacityRatio`; (b) for `abcClass !== 'A'` (including `null`), the existing property (capacity outranks proximity) still holds — this is the EXISTING property test's own case, re-asserted with the new parameter explicitly passed as `'B'`/`'C'`/`null` to confirm the default path; (c) calling `rankLocationCandidates(candidates, 'A')` and `rankLocationCandidates(candidates, null)` on the same input never produce more or fewer elements — only a possible reordering (permutation-preserving, matching the existing golden comment's own invariant).

## Deliver (edits to five existing files, extends two existing test files — no new files)
- `modules/wms/domain/receive-inbound/suggest-location-ranking.ts` (edit)
- `modules/wms/application/receive-inbound/suggest-location.ts` (edit)
- `modules/wms/application/receive-inbound/ports.ts` (edit — `SuggestLocationCandidateRow`)
- `modules/wms/infrastructure/receive-inbound/repository.ts` (edit — `suggestLocationCandidatesQuery`)
- `packages/contracts/wms/receive-inbound.ts` (edit — no new command, just the result shape)
- `modules/wms/tests/receive-inbound/suggest-location-ranking.property.test.ts` (extend)
- `modules/wms/tests/receive-inbound/receive-inbound.test.ts` + `receive-inbound.feature` (extend)

Migration number: none.
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent. (Hazmat/fragile/light-sensitivity/stackability conditions are exactly such a case — recorded above, not built.)
