# SLICE BRIEF — WBS 2.11 part 5 · condition 10, per-contract per-SKU order limit (closes 2.11)

Task: 2.11 part 5 — condition 10 ("quantity within the agreed order limit"), GM ruling D-189 (SCR-WMS-OUT-02 §6) — closes doc-38 row 2.11 if this passes (all ten conditions then have a failing test with the correct message)      Lane: 1      Lock: `wms/process-outbound` (already held)
Owner: WH_MGR      Deps: 2.11 parts 1-4 DONE, GM D-189      Worktree: `../pg-eos-lane-1`, branch `lane/1-2.11p5` (on origin/main `1867304`)
Model routing: pg-tester sonnet (RED, then verify GREEN) → pg-backend sonnet (build) → pg-reviewer opus (pre-migration AND post-build, two rounds max, P7) → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
No new use case, no `scripts/new-slice.sh` run — extends the existing `process-outbound` tree in place, same as parts 1-4. Migration **0026** already issued (D-189), file name `database/migrations/0026_1_contract-sku-limits.sql`.

## Scope (GM ruling D-189, SCR-WMS-OUT-02 §6 — verbatim, not re-derived)
- **Source**: a new table `sales.contract_sku_limits` — `id uuid pk default gen_random_uuid()`, `entity_id uuid not null` (FK `platform.entities`), `contract_id uuid not null` (FK `sales.contracts`), `sku_id uuid not null` (FK `wms.skus`), `max_order_qty numeric(14,3) not null check (max_order_qty > 0)`, `version int not null default 1`, audit columns per the package's standard pattern (`created_at`/`created_by`/`updated_at`/`updated_by`), `unique (contract_id, sku_id)`, RLS `entity_scope`, one `identity.column_classification` row per column. **pg-reviewer (opus) fixes the final DDL shape at the mandatory pre-migration review** — this brief's proposal is a starting point, not the final word.
- **Null/absent = no limit.** A `(contract_id, sku_id)` pair with no row in `sales.contract_sku_limits` means condition 10 passes unconditionally for that line.
- **Message**: «الكمية تتجاوز الحد المتفق [كمية]» with the limit substituted — i18n key in the same family as the other nine (`wms.outbound.check.orderQuantityExceeded`, params `{skuCode, ordered, limit}` — matches the existing per-condition error convention, see `NoServicePriceError` precedent below).
- **Consumer**: `RunOutboundChecks` reads the table read-only, inside `withContext`, from `wms`'s own `infrastructure/process-outbound/repository.ts` — same cross-schema read-only pattern condition 1 already uses for `sales.contracts` (no cross-module TypeScript import, no sales code written).
- **Per-line check**: condition 10 runs per order line (like conditions 3/4/5/6/7), not once per order — each line's SKU may have its own limit under the order's contract.

## Read ONLY (workers) — kept under the 8-file / 1,000-line budget (P7)
1. `CLAUDE.md`
2. `.claude/briefs/wms.brief.md`
3. `docs/notes/SCR-WMS-OUT-02-order-quantity-limit.md` §6 (the GM ruling, verbatim, already quoted above)
4. `docs/package/D-blueprints/03-Operations-Warehouse.md` lines 331-335 (§4.2.1 row 10, the ten-condition table's own message template)
5. `modules/wms/domain/process-outbound/errors.ts` lines 202-210 (`NoServicePriceError` — the direct precedent for condition 10's error class shape: `OutboundCheckError`, i18nKey, params)
6. `modules/wms/infrastructure/process-outbound/repository.ts` lines 244-260 (`getContractCheck` — the direct precedent for a read-only cross-schema `sales.*` query inside wms's own repository)
7. `database/migrations/0025_M_client-portal-scope-internal-bypass.sql` (the most recent RLS-touching migration — `entity_scope` policy precedent, verbatim)

## Not separately read (viewed directly when editing)
`modules/wms/domain/process-outbound/invariants.ts`, `modules/wms/application/process-outbound/run-outbound-checks.ts` (condition-10 slot already marked, line ~200, "BLOCKED — no schema source" comment to be replaced), `modules/wms/application/process-outbound/ports.ts`, `modules/wms/tests/process-outbound/{process-outbound.test.ts, process-outbound.feature, invariants.property.test.ts}` — every file this part extends is already this lock's own reviewed code.

## Write ONLY
- pg-tester: `modules/wms/tests/process-outbound/{process-outbound.test.ts, process-outbound.feature, invariants.property.test.ts}` (condition-10 RED tests, then round-2 fixes below) · `tests/isolation/tests/app-role-rls.test.ts` (round 2 addition — `ENTITY_SCOPE_POLICY_COUNT` 73→74 for migration 0026's new entity_scope policy; the lane session made this edit directly during the pre-migration/apply step, out of its own write scope per pg-reviewer round 1 finding 1 — pg-tester re-confirms/owns it properly this round, content unchanged).
- pg-backend: `modules/wms/domain/process-outbound/{errors.ts, invariants.ts}` (new error class + pure decision function, then round-2: invariants.ts's own file-header "nine conditions" comment → "ten conditions") · `modules/wms/application/process-outbound/run-outbound-checks.ts` (wire condition 10 into the existing per-line loop, replacing the "skipped" comment) · `modules/wms/infrastructure/process-outbound/repository.ts` (new read-only query for `sales.contract_sku_limits`) · `modules/wms/application/process-outbound/ports.ts` (new port method/row type if needed).
- Lane session only: `database/migrations/0026_1_contract-sku-limits.sql` (after pg-reviewer's mandatory pre-migration PASS) · `tasks/backlog/MIGRATION-REQUEST-1.md` (row 7 already added) · this brief.
Forbidden for every worker: `database/schema/**` (the migration is the lane session's own write, after review), `packages/**`, other modules, any `sales/*` code file (read-only SQL inside wms's own repository only — never a `modules/sales/**` import or edit), `docs/**` other than this brief, `scripts/**`, `CLAUDE.md`, `.claude/**`.

## Round 2 (final, P7 cap) — pg-reviewer round 1 FAIL(3 findings, all separable, zero code findings)
1. `tests/isolation/tests/app-role-rls.test.ts` write-scope correction — see Write ONLY above, content already correct (74), no value change.
2. `process-outbound.feature:147` `Scenario: All ten conditions now have a failing test with the correct message (doc 38 row 2.11)` has no Given/When/Then and no matching describe — pg-tester converts it to a plain `#` comment (not a Scenario:, since it documents the row's overall acceptance rather than one testable behavior) OR gives it a real minimal describe/test (e.g. asserting all ten condition error classes carry distinct `wms.outbound.check.*` i18nKeys) — pg-tester's call, record which.
3. The "All nine conditions pass — reaches checks_pending" scenario/describe is now factually wrong (the happy path runs all ten, condition 10 passing because no limit row exists) — pg-tester renames the feature scenario title AND the matching describe to "All ten conditions pass — reaches checks_pending" (exact match discipline, same as parts 3-4). pg-backend separately fixes `invariants.ts` line 3's own header comment ("nine conditions" → "ten conditions"). The stale "nine" in `modules/wms/api/process-outbound/handlers.ts` and `modules/wms/tests/process-outbound/handlers.test.ts` comments is OUT OF SCOPE this round (not required for PASS per pg-reviewer's own finding) — record as a deferred CHANGELOG note, do not touch those two files.

## Acceptance criterion (doc 38 row 2.11, verbatim — this closes the row if PASS)
"Each of ten conditions has a failing test with the correct message" — conditions 1-9 already met (part 1); condition 10 built this part closes the row.
Gates: pre-migration pg-reviewer PASS (mandatory, RLS/schema-touching) BEFORE the migration file is written · `pnpm --filter @pg-eos/wms typecheck && lint` (root eslint workaround) green · full `pnpm --filter @pg-eos/wms test -- process-outbound` green · `pnpm guards:run` green (re-check G1 first, isolated-DB check for the new table's RLS) · pg-reviewer PASS post-build, **two rounds max (P7)** — a third FAIL escalates to the Master, no third worker round.

## Scenario (Gherkin — pg-tester adds to process-outbound.feature)
```gherkin
  Scenario: Condition 10 passes when the SKU has no contract limit row
    Given the client's contract has no sales.contract_sku_limits row for this SKU
    When RunOutboundChecks is called
    Then condition 10 does not fail (no limit means no cap)

  Scenario: Condition 10 passes when the ordered quantity is within the limit
    Given a sales.contract_sku_limits row for this contract/SKU with max_order_qty 100
    And the line orders 50
    When RunOutboundChecks is called
    Then condition 10 does not fail

  Scenario: Condition 10 fails when the ordered quantity exceeds the limit
    Given a sales.contract_sku_limits row for this contract/SKU with max_order_qty 10
    And the line orders 15
    When RunOutboundChecks is called
    Then it is rejected with the order-quantity-exceeded error naming the SKU code, the ordered
      quantity, and the limit — status stays "draft", nothing written to outbox or audit

  Scenario: Condition 10's limit is exact — ordered equal to the limit still passes
    Given max_order_qty 10, the line orders exactly 10
    When RunOutboundChecks is called
    Then condition 10 does not fail (the limit is inclusive)

  Scenario: All ten conditions now have a failing test with the correct message (doc 38 row 2.11)
```
Property test (invariants.property.test.ts): the condition-10 decision function — given a limit (or null) and an ordered quantity, generate fractional 3-decimal-place quantities (same discipline as every other quantity invariant in this file since part 2's fix-round finding 7) and assert: null limit never fails; ordered ≤ limit never fails; ordered > limit always fails with the exact shortfall/limit in params.

## Deliver
- `docs/notes/SCR-WMS-OUT-02-order-quantity-limit.md` §6 status line updated to `applied` once the migration lands (lane session, bookkeeping, not pg-scribe's job this time since it's a one-line status flip on an already-Master-authored file — confirm with pg-scribe whether this belongs in its own close-out pass instead)
- `database/migrations/0026_1_contract-sku-limits.sql`
- `modules/wms/domain/process-outbound/{errors.ts, invariants.ts}` (edited)
- `modules/wms/application/process-outbound/{run-outbound-checks.ts, ports.ts}` (edited)
- `modules/wms/infrastructure/process-outbound/repository.ts` (edited)
- `modules/wms/tests/process-outbound/{process-outbound.test.ts, process-outbound.feature, invariants.property.test.ts}` (edited)

Migration number: **0026** (issued, D-189).
Stop-and-ask if: any detail of D-189's ruling proves insufficient to build against (e.g. pg-reviewer's pre-migration pass finds the proposed DDL shape needs a change beyond what §6 specifies) — that goes back to pg-reviewer's own pre-migration authority, not an invented workaround.
