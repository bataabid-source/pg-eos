# SLICE BRIEF — WBS 2.11 part 3 · describe/scenario naming + WBS 2.4 picker fix (closes WBS 2.11)

Task: 2.11 part 3 — align `describe` names to their Gherkin scenario names (pg-reviewer round 3 finding, carried); fix the WBS 2.4 `pickWh1Location` shared-row bug in `location-limits.test.ts` (carried, same class as 2.10's own fix)      Lane: 1      Lock: `wms/process-outbound` (naming item) + `wms/integration` (picker item, tests-only, both already claimed)
Owner: WH_MGR      Deps: 2.11 part 2 DONE (`156b042`)      Worktree: `../pg-eos-lane-1`, branch `lane/1-2.11p3` (on origin/main `156b042`)
Model routing: pg-tester sonnet, ONE review round (Master's tight bound for this slice, D-186). Lane session sonnet, effort medium — orchestrates only. Both items are pg-tester-only — no domain/application/infrastructure/api file, no builder delegation this slice.
No new use case, no migration. This is the smallest possible slice: two mechanical/test-only fixes that close out WBS 2.11.

## Item 1 — describe/scenario name alignment (`wms/process-outbound`)
Three `describe` blocks in `modules/wms/tests/process-outbound/process-outbound.test.ts` use a shortened/paraphrased name instead of their exact matching Gherkin scenario title in `process-outbound.feature`. pg-reviewer's round 3 (opus, Master) found these as the ONE low-severity carry-forward item — CONFIRM the exact three before editing (the line numbers below are approximate, re-locate by content):
- `~:1860` — `describe('Scenario: Allocate is illegal before approval (WBS 2.11 part 2)', ...)` should read exactly `describe('Scenario: Allocate is illegal before approval (still draft or checks_pending)', ...)` — feature line 228.
- `~:1881` — `describe('Scenario: Allocate version-lock + idempotency (WBS 2.11 part 2)', ...)` currently bundles what the feature file splits into TWO separate scenarios (feature line 262 "Stale version is rejected on Allocate and the extended CancelOutbound", feature line 267 "Idempotent replay and conflicting replay on Allocate"). Decide and apply the correct fix: either split this one `describe` into two matching the feature file exactly, or rename it precisely if it's genuinely one combined scenario the feature file itself should also state that way (do NOT edit the .feature file to match the test — the feature is the source scenario, the test aligns to it, per doc 36 BUILD METHOD's "scenario first"). Read both files' full surrounding context before deciding; if genuinely ambiguous, note your reasoning in the REPORT rather than guessing silently.
- `~:2504` — `describe('Scenario: Stale version is rejected on the extended CancelOutbound (allocated source, WBS 2.11 part 2)', ...)` should read exactly `describe('Scenario: Stale version is rejected on Allocate and the extended CancelOutbound', ...)` — feature line 262 (the SAME feature scenario as the one item 1861 above may also need to reference — do not create two `describe` blocks both claiming the same scenario name; if the feature scenario's assertions are genuinely split across two existing `it`-level or `describe`-level groups in the test file, consolidate or cross-reference correctly, your call, documented).

No test LOGIC changes — this is a naming/organization fix only. Do not weaken, remove, or alter any assertion. If while fixing this you find the *content* doesn't actually match the scenario's Given/When/Then (not just the label), STOP and report — that would be a real test defect requiring its own decision, not a silent rename.

## Item 2 — WBS 2.4 `pickWh1Location` fix (`wms/integration`, tests-only)
`modules/wms/tests/integration/location-limits.test.ts`'s own `pickWh1Location` helper (around line 213-231, same file class as WBS 2.4) has the identical bug class already fixed twice this session (2.10's `pickFreshWh1Location`, 2.11 part 2's `nextFixtureLocationCode`): `order by l.code desc limit 1` on a query with no exclusivity beyond `is_blocked=false`, picking ANY unblocked location — real production data or another test's leftover fixture row — with descending-code order meaning a stray high-sorting orphan gets picked first. This is confirmed as a real contributor to the shared-DB-pollution failures in this file (a leaked no-weight-limit location sorting first defeats the over-weight assertions).

Fix: apply the SAME collision-safe pattern already established twice this session — create the function's OWN dedicated location under a distinct code prefix (the `M9-` block, random code + `on conflict (warehouse_id, code) do nothing`, retry on conflict) instead of selecting an existing row. Mirror `receive-inbound.test.ts`'s own `insertLocationInZone`/`randomM9FixtureLocationCode()` helpers (same pattern, can view directly, not counted against budget below) or `process-outbound.test.ts`'s own M9 fixture helpers — whichever is closer in shape to this file's existing fixture-tracking style.

Write ONLY `modules/wms/tests/integration/location-limits.test.ts` in this item — no other file.

## Read ONLY (workers) — kept under the Master's tight 8-file / 1,000-line budget
1. `CLAUDE.md`
2. `.claude/briefs/wms.brief.md`
3. `modules/wms/tests/process-outbound/process-outbound.feature` lines 226-270 (the exact scenario titles item 1 must match, verbatim, already quoted above)

## Not separately read (viewed directly when editing, not a precedent study)
`modules/wms/tests/process-outbound/process-outbound.test.ts` (item 1, edited directly) · `modules/wms/tests/integration/location-limits.test.ts` (item 2, edited directly) · `modules/wms/tests/receive-inbound/receive-inbound.test.ts` and `modules/wms/tests/process-outbound/process-outbound.test.ts`'s own M9 fixture helpers (item 2's precedent, this session's own already-reviewed code, view directly).

## Write ONLY
- pg-tester: `modules/wms/tests/process-outbound/process-outbound.test.ts` (items 1/3/4) · `modules/wms/tests/process-outbound/process-outbound.feature` (item 1's second half only — ADD the Given/When/Then for a `describe` that names a scenario the feature file is missing, describing the tested behaviour verbatim, inventing nothing; amended into Write ONLY by the Master's round-2 ruling) · `modules/wms/tests/process-outbound/handlers.test.ts` and `invariants.property.test.ts` and `process-outbound-machine.unit.test.ts` (item 4, afterAll leak-proofing only, if any of these also write process-outbound fixtures) · `modules/wms/tests/integration/location-limits.test.ts` (item 2, `pickWh1Location` fix only, already done, DO NOT re-touch this round unless item 4's leak-proofing also applies here).
Forbidden for every worker: any domain/application/infrastructure/api file, `database/schema/**`, `packages/**`, other modules, `docs/**`, `scripts/**`, `CLAUDE.md`, `.claude/**`.

## Round 2 (final) — Master ruling after round 1 FAIL(5)
Round 1 confirmed items 1 (the 3 named renames) and 2 (the 2.4 picker) correct, but pg-reviewer applied the brief's own acceptance line ("every describe name matches its Gherkin scenario exactly") literally and found 14 more mismatches, plus 3 pre-existing content gaps in the stale-version/idempotency-on-CancelOutbound tests. Master ruling: full sweep, this round is FINAL (no round 3 — a FAIL commits the PASS subset, the rest becomes 2.11 part 4).

### Item 3 — remaining describe/scenario mismatches (full sweep)
- **7 describes carrying an extra suffix not in the feature file** (e.g. "(WBS 2.11 part 2)", "(… Master decision 2/4)") at process-outbound.test.ts lines ~1704, 1754, 1808, 1981, 2033, 2044, 2520 (re-locate by content, line numbers approximate) — rename each to its EXACT matching feature scenario title, no suffix.
- **7 describes naming a scenario that does not exist in process-outbound.feature** at lines ~917, 968, 1054, 1329, 1518, 1546, 1929 (re-locate by content) — e.g. "Condition 1 fails — the client has no active contract at all", "A failed ApproveOutbound writes ZERO outbox and ZERO audit rows (rollback proof)". For EACH: add the matching `Scenario:` block to process-outbound.feature, Given/When/Then, describing exactly the behavior the existing test already asserts — never invent a NEW behavior or assertion, the Gherkin must describe what the test already does. Do not rename these away from "Scenario:" — per the Master's ruling, a genuine behavioral test belongs in the scenario list.

### Item 4 — three pre-existing content gaps (process-outbound.test.ts, the CancelOutbound stale-version/idempotency describes)
- Feature scenario "Stale version is rejected on Allocate and the extended CancelOutbound" says "(from allocated/partially_allocated)" — add a stale-version test for the `partially_allocated` cancel source (currently only `allocated` is tested).
- The "nothing released" assertion (feature: CancelOutbound's stale-version rejection) currently only checks order status/version/outbox/audit counts — add an assertion that the reserved lot's `qty_allocated` is genuinely unchanged after the rejected cancel attempt.
- The idempotent-replay-on-Allocate test currently only checks `second toEqual first` and status — add an assertion that `platform.outbox`/`platform.audit_log` row counts for this correlation stay at exactly one after the replay (no second write).

### Item 5 — afterAll leak-proofing (Master's separate addition, same locks)
The shared DB has grown from 35/32/30 `_procout_*` accounts/price-lists/zones (this afternoon) to 106/102/96 now — confirms process-outbound's own test suites are leaking fixtures despite existing afterAll blocks. Make every `afterAll` in `modules/wms/tests/process-outbound/*.test.ts` (all four files — check each for whether it creates DB fixtures at all; unit-only files like the machine test may not need this) delete its own fixtures in FK-safe order, wrapped in try/finally, keyed strictly by the run's OWN prefix/tracked-id arrays (never a blanket prefix-wide delete — D-183). Prove it: query the three prefixes' row counts before and after TWO consecutive full runs of the process-outbound suite files — counts must be identical before/after each run (this run's own leftover-free, not the pre-existing pollution which stays untouched, D-183). Report the exact before/after numbers.

### Pre-submission gate (before requesting round 2 review)
`PGHOST=localhost PGUSER=postgres PGDATABASE=pgeos PG_APP_USER=pgeos_app pnpm --filter @pg-eos/wms typecheck` · `npx eslint modules/wms/tests/process-outbound modules/wms/tests/integration --max-warnings=0` · `PGHOST=localhost PGUSER=postgres PGDATABASE=pgeos PG_APP_USER=pgeos_app pnpm --filter @pg-eos/wms test -- process-outbound` run TWICE (both green, and the leak-proof row counts identical between the two runs).

## Acceptance criterion (doc 38 row 2.11, verbatim — this closes the row)
"Each of ten conditions has a failing test with the correct message" — already met (part 1). This part's own delivery: every `describe` name in process-outbound.test.ts matches its Gherkin scenario exactly, and location-limits.test.ts's `pickWh1Location` no longer selects a shared row.
Gates: `pnpm --filter @pg-eos/wms typecheck && lint` (root eslint workaround) green · `PGHOST=localhost PGUSER=postgres PGDATABASE=pgeos PG_APP_USER=pgeos_app pnpm --filter @pg-eos/wms test -- process-outbound` green (178/178, no count change, pure rename) · `PGHOST=localhost PGUSER=postgres PGDATABASE=pgeos PG_APP_USER=pgeos_app pnpm --filter @pg-eos/wms test -- location-limits` green, TWICE in a row (collision check, same discipline as item 0's earlier fixes) · full unfiltered `pnpm --filter @pg-eos/wms test` — the location-limits.test.ts failures from shared-DB pollution should now be gone (or reduced) since its own picker no longer contributes to the collision; the location-codes-wh1/wh1-setup failures remain known pre-existing pollution, non-blocking per the Master's standing ruling · guards green (re-check G1 first) · pg-reviewer PASS, ONE round.

## Deliver
- `modules/wms/tests/process-outbound/process-outbound.test.ts` (edited — 3 describe names/structure)
- `modules/wms/tests/integration/location-limits.test.ts` (edited — pickWh1Location fix)

Migration number: none.
Stop-and-ask if: item 1's content genuinely doesn't match its scenario (not just the label) — report, don't silently rename around a real defect.
