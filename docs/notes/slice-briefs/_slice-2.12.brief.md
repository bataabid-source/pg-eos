# SLICE BRIEF — WBS 2.12 part 1 · PickLine + CheckOrder (checker ≠ picker)

Task: 2.12 part 1 — `PickLine` (approved/allocated → picking → picked) and `CheckOrder` (picked → checked, checker ≠ picker) — meets doc-38 row 2.12's own acceptance ("Self-check rejected"); pack/load are part 2      Lane: 1      Lock: `wms/process-outbound` (already held)
Owner: WH_MGR      Deps: 2.11 DONE (`f9aeecc`)      Worktree: `../pg-eos-lane-1`, branch `lane/1-2.12` (on origin/main `f9aeecc`)
Model routing: pg-tester sonnet → pg-backend sonnet → pg-reviewer opus, two-round cap (P7). Lane session sonnet, effort medium — orchestrates only.
No new use case, no `scripts/new-slice.sh` run — extends the existing `process-outbound` tree in place. **Split before pg-tester (D-179/P7 SPLIT BEFORE, NOT AFTER)**: doc 38 row 2.12 covers four steps (pick, check, pack, load); its own acceptance line names only the checker≠picker invariant, so part 1 delivers exactly that (PickLine + CheckOrder); PackOrder + LoadOrder are part 2, same lock, next task.

## Scope (D-blueprint 03 §4.2 steps 5-6, verbatim below)
- **`PickLine`** (`allocated`/`partially_allocated` → `picking` on first line, → `picked` when every line is fully picked): `WH_OP` scans/confirms each order line, records `qty_actual` picked, posts a `pick` movement in `wms.stock_movements` (the ledger — `movement_type='pick'`, already a legal value in `chk_stock_movements_type`), decrements the consumed lot's `qty_on_hand`/`qty_allocated` together (a real physical pick, unlike Allocate's soft reservation). A shortage (`qty_actual < qty_ordered`) requires `order_lines.variance_reason` (reuses the existing `variance_needs_reason` CHECK, same free-text pattern the golden slice's own `ReceiveLine` already established — no new lookup table, "a reason from a list" is UI-level guidance with no schema-level enum/FK anywhere in 01/13/13B/019/40, confirmed by the same class of search SCR-WMS-OUT-01/02 already did for their own gaps) and alerts the supervisor immediately (Scope default: the alert mechanism itself — `platform.alert_rules`/`platform.alert_log` — is out of this part's scope; the shortage is recorded and auditable, a follow-up slice wires the actual alert if the GM wants one, same "deferred, not missing" pattern as every prior slice's unreached steps).
- **`CheckOrder`** (`picked` → `checked`): a SECOND `WH_OP` (or any qualified role) re-scans every line; the checker's `ctx.userId` MUST differ from the order's own `picked_by` — self-check is rejected with a typed error (doc-38's own literal acceptance line). On success, sets `checked_by`; the D-blueprint's own note that this step "generates OF-01…OF-11 → an issue permit/delivery note" is OUT OF SCOPE this part (billing/document generation, Phase 4/future work, not invented here).

## Read ONLY (workers) — kept under the 8-file / 1,000-line budget (P7)
1. `CLAUDE.md`
2. `.claude/briefs/wms.brief.md`
3. `docs/package/D-blueprints/03-Operations-Warehouse.md` lines 289-290 (§4.2 rows 5-6, verbatim, already quoted below)
4. `database/schema/01-Data-Model.sql` lines 693-715 (`wms.stock_movements` DDL, verbatim — `movement_type`, `qty`, the ledger's own append-only shape) and lines 777-794 (`wms.order_lines`, verbatim — `qty_actual`, `variance_reason`, `status`)
5. `modules/wms/application/process-outbound/cancel-outbound.ts` (the most recent, smallest full command in this use case — version-lock, `withIdempotentContext`, outbox+audit-same-transaction pattern to mirror for `PickLine`/`CheckOrder`)
6. `modules/wms/domain/process-outbound/errors.ts` lines 1-40 (the file's own typed-error idiom header + one example class, to mirror for the new `SelfCheckNotAllowedError`/shortage-related errors)
7. `modules/wms/infrastructure/receive-inbound/ledger.ts` (fix round, finding 1 — the exact `LedgerPort` adapter pattern to mirror, calling `postMovementInTx`)
8. `modules/wms/src/stock-ledger/post-movement.ts` lines 68-90 (fix round, finding 1 — `PostMovementInput`/`LedgerDeps`/`PostedMovement` interfaces only, confirms `fromLocationId`/`toLocationId` semantics: a pick sets `fromLocationId` to the source, `toLocationId: null`) and lines 591-597 (the `postMovementInTx` function signature only, not its body)

## Not separately read (viewed directly when editing)
`modules/wms/domain/process-outbound/{machine.ts, invariants.ts}`, `modules/wms/application/process-outbound/{ports.ts, index.ts}`, `modules/wms/infrastructure/process-outbound/repository.ts`, `modules/wms/api/process-outbound/{handlers.ts, composition.ts}`, `packages/contracts/wms/process-outbound.ts`, `modules/wms/tests/process-outbound/{process-outbound.test.ts, process-outbound.feature, invariants.property.test.ts}` — every file this part extends is already this lock's own reviewed code.

## Write ONLY
- pg-tester: `modules/wms/tests/process-outbound/{process-outbound.test.ts, process-outbound.feature, invariants.property.test.ts, process-outbound-machine.unit.test.ts, handlers.test.ts}` (handlers.test.ts and the machine unit test added in the fix round — findings 8/9 below).
- pg-backend: `modules/wms/domain/process-outbound/{machine.ts, errors.ts, invariants.ts}` · `modules/wms/application/process-outbound/{ports.ts, index.ts, pick-line.ts, check-order.ts}` · `modules/wms/infrastructure/process-outbound/{repository.ts, ledger.ts}` (`ledger.ts` new, added in the fix round — finding 1 below) · `modules/wms/api/process-outbound/{handlers.ts, composition.ts}` · `packages/contracts/wms/process-outbound.ts` (add `PickLineInputSchema`, `CheckOrderInputSchema` only).
- Lane session only: this brief.
Forbidden for every worker: `database/schema/**` (no migration this part — `movement_type='pick'` and every column already exist), `packages/**` other than the one named contract file, `packages/events/catalog.ts` (new events `wms.outbound.picking_started`/`picked`/`checked` — check if already cataloged; if not, STOP and report to the lane session, Master-only frozen path, same pattern as parts 1-2's events), other modules, `docs/**` other than this brief, `scripts/**`, `CLAUDE.md`, `.claude/**`.

## Fix round (pg-reviewer round 1 FAIL, 9 findings — two-round cap, P7/D-186)
Round 1 confirmed the self-check invariant itself correct and doc-38's acceptance met in behavior, but found 9 real issues in PickLine's stock-ledger handling. All must be fixed this round (findings 1-7 pg-backend, 8-9 pg-tester coverage, plus new RED tests for the bug scenarios 2/3/5/6/7).

**Finding 1 — no shared ledger mechanism (pg-backend, NEW file `infrastructure/process-outbound/ledger.ts`).** `postPickMovement`/`consumeLotForPick` in repository.ts are hand-written SQL that bypass `postMovementInTx` (`modules/wms/src/stock-ledger/post-movement.ts`) — losing the shared rebuild-key lock, the balance advisory lock, `validateEntry` (rejects qty≤0 before the DB), the `no_negative_stock`→`NegativeStockError` mapping, `last_movement_at`, and the per-movement `wms.stock.moved` outbox+audit pairing (G9). Fix: add `infrastructure/process-outbound/ledger.ts` implementing a `LedgerPort`-shaped adapter over `postMovementInTx`, mirroring `infrastructure/receive-inbound/ledger.ts`'s exact pattern (Read ONLY item 7 below) — movement `'pick'`, `fromLocationId` = the line's reserved `location_id`, `toLocationId: null` (a pick removes stock, it isn't a transfer). Keep the SEPARATE `qty_allocated` decrement (that's process-outbound's own soft-reservation bookkeeping, not the ledger's concern) — write PickLine's own audit row LAST (ADR-0002), same discipline as every other command in this use case.

**Finding 2 — double-pick (pg-backend, repository.ts).** `countOpenPickLines` counts pick movements order-wide (`ref_id` = order id), not per-line, so picking the SAME line twice (fresh idempotency keys) can mark the order 'picked' while a second line was never touched, and doubly-consumes the first line's lot. Fix: key the pick movement's `ref_table`/`ref_id` to the LINE (`'wms.order_lines'` / line id — same precedent 2.13's count-inventory ledger already uses, no G-01), reject a pick on an already-picked line with a typed error before any write, and make the completion check per-line (every line has a matching pick row).

**Finding 3 — unbounded pick quantity (pg-backend, pick-line.ts + a new pure invariant).** Nothing bounds `qtyActual` against the line's own reserved quantity — an over-pick can silently eat other orders' `qty_allocated` (no DB floor on that column) or fail as a raw 500 on the DB's own `variance_needs_reason` CHECK. Fix: `getOrderLineForPick` must also select the reserved quantity (`order_lines.qty_actual`, Allocate's own stamp); add a pure `Quantity`-exact invariant (name it, e.g. `assertPickedWithinReserved`) that throws a typed error BEFORE any write when `qtyActual > reserved`.

**Finding 4 — a shortage leaves the unpicked remainder's reservation stuck (pg-backend, pick-line.ts).** A partial pick (with a reason) only decrements `qty_allocated` by the picked amount, leaving the rest permanently reserved on an order that's already 'picked' — that stock never becomes available again. Fix: on a shortage, decrement `qty_allocated` by the FULL reserved quantity (release the whole reservation, matching Master decision 2's "reversing the earlier soft reservation permanently"), `qty_on_hand` only by the actually-picked amount; any real-world shortfall is corrected later by a count/adjustment (out of this part's scope, already-existing mechanisms).

**Finding 5 — `qtyActual='0'` with a reason posts a zero-qty ledger row (pg-backend, pick-line.ts).** Violates the DB's own `qty_not_zero` check, surfaces as a raw 500. Fix: a zero pick releases the reservation and posts NO movement row (finding 1's `validateEntry` would reject it anyway — handle it explicitly before calling the ledger adapter).

**Finding 6 — picking a line with no reservation is silently accepted (pg-backend, pick-line.ts).** A line with `location_id` null (never allocated, e.g. the open remainder of a partially_allocated order) accepts any `qtyActual > 0` with no ledger row and no stock consumed. Fix: a typed rejection when `qtyActual > 0` on a line with no reservation.

**Finding 7 — an unknown lineId throws a bare `Error` (pg-backend, pick-line.ts).** Surfaces as a 500 instead of 422. Fix: a typed not-found error, same convention as every other command's unknown-order/unknown-line handling in this use case.

**Finding 8 — no handlers.test.ts coverage for handlePickLine/handleCheckOrder (pg-tester, NEW test scope `handlers.test.ts`).** Add: missing Idempotency-Key → 400, SelfCheckNotAllowedError → 422, StaleVersionError → 409 — same pattern every earlier command in this file already has.

**Finding 9 — no positive unit tests for the new machine edges (pg-tester, `process-outbound-machine.unit.test.ts`).** Add explicit `allowedEventsFrom` assertions for `picking --COMPLETE_PICKING--> picked` and `picked --CHECK--> checked` (i.e. `allowedEventsFrom("picked") === [CHECK]`, `allowedEventsFrom("checked") === []`), not just exercised incidentally via integration tests.

**Also — RED tests for findings 2/3/5/6/7's bug scenarios (pg-tester)**: a repeat-pick-on-the-same-line rejection, an over-pick rejection, a zero-qty-with-reason release (no ledger row, reservation released), a pick-with-no-reservation rejection, an unknown-lineId typed rejection (422 not 500).


## Acceptance criterion (doc 38 row 2.12, verbatim — this part meets it)
"Self-check rejected" — `CheckOrder` called by the same actor who picked the order is rejected with a typed error, order stays `picked`.
Gates: `pnpm --filter @pg-eos/wms typecheck && lint` (root eslint workaround) green · `pnpm --filter @pg-eos/wms test -- process-outbound` green · `pnpm guards:run` green (re-check G1 first — PickLine writes real ledger rows, unlike Allocate) · pg-reviewer PASS, two rounds max (P7).

## D-blueprint 03 §4.2 rows 5-6 (verbatim)
| # | من يفعلها | الشاشة | ما الذي يتغيّر في القاعدة | الحدث المنشور |
|---|---|---|---|---|
| 5 | `WH_OP` | PDA · التقاط — بالمسار الأقصر (A3) | `status='picking'` ثم `'picked'` · `picked_by` · حركة `pick` في الدفتر · نقص ⇒ سبب من قائمة + تنبيه المشرف فوراً | `wms.outbound.picking_started` · `wms.outbound.picked` |
| 6 | `WH_OP` آخر | PDA · تدقيق — مسح كل بند | `status='checked'` · `checked_by` — المدقّق ≠ الملتقط | `wms.outbound.checked` ← يولّد OF-01…OF-11 ← إذن صرف / بوليصة تسليم |

## Master decisions the workers copy (not re-derive)
1. **Machine edges added this part**: `{allocated, partially_allocated} --START_PICKING--> picking`, `picking --COMPLETE_PICKING--> picked`, `picked --CHECK--> checked`. Every other status (`packed`…`delivered`) still has no producing edge — part 2's job.
2. **`PickLine`**: per-line command (like Allocate), version-lock at the ORDER level (`expectedVersion` on the order, bump once per call — matches every prior command's discipline), role: any internal `WH_OP`-capable caller under RLS (no named-role gate, same "not itself a review gate" precedent as CreateOutbound). First `PickLine` call on an order transitions it to `picking` (sets nothing else); each line records `qty_actual`, posts `wms.stock_movements` (`movement_type='pick'`, `from_location_id`=the line's allocated `location_id`, `qty`=picked amount, same client/sku/batch as the allocation) and decrements `stock_balance.qty_on_hand` AND `qty_allocated` together (a real consumption, reversing the earlier soft reservation permanently — unlike Cancel's release, this is not reversible by this use case). A shortage sets `order_lines.variance_reason` (free text, required — reuses `variance_needs_reason`). When every line reaches `qty_actual` set (`complete` or `partial` per the existing `order_lines.status` convention, matching `qty_actual != qty_ordered` needing a reason), the ORDER transitions to `picked`, records `picked_by = ctx.userId`. One outbox event `wms.outbound.picking_started` on the FIRST line's call, one `wms.outbound.picked` when the order completes — same transaction discipline as every other command (audit row same correlation_id).
3. **`CheckOrder`**: order-level command (`picked → checked`), version-lock, role: any internal `WH_OP`-capable caller. MANDATORY invariant: `ctx.userId !== order.pickedBy` — if equal, throw a new typed error (name your own, e.g. `SelfCheckNotAllowedError`, `OutboundCheckError`-shaped, i18nKey `wms.outbound.check.selfCheckNotAllowed` — NOT one of the ten RunOutboundChecks conditions, a separate check on a different command, name it distinctly) BEFORE any write; order stays `picked`. On success: `checked_by = ctx.userId`, status `checked`, one outbox event `wms.outbound.checked` + audit row. No OF-01…OF-11 document generation this part (Scope, deferred).
4. **Actor**: always `ctx.userId`. **Idempotency**: both commands build `IdempotencyInput` (real writes, both need it).
5. **Errors → Problem statuses**: unchanged convention — `StaleVersionError`/`IdempotencyConflictError` → 409, `SelfCheckNotAllowedError` and every other typed domain error → 422, unknown → 500.
6. **`Quantity` decimal arithmetic** for every quantity comparison/decrement (part 2's own fix-round finding 7 — never a raw `Number()` on a `qty_*` string).

## Scenario (Gherkin — pg-tester extends `process-outbound.feature`/`process-outbound.test.ts`, does not remove any existing test)
```gherkin
  Scenario: PickLine records the picked quantity and posts a pick ledger movement
    Given an allocated order with one line
    When PickLine is called for that line at the full ordered quantity
    Then a wms.stock_movements row (movement_type 'pick') is posted, stock_balance.qty_on_hand and
      qty_allocated both drop by that amount, the line is "complete"

  Scenario: The order transitions to picking on the first PickLine call, then picked when complete
  Scenario: A shortage on PickLine requires a variance_reason
    Given qty_actual less than qty_ordered on a line
    When PickLine is called with no variance_reason
    Then it is rejected before any write

  Scenario: PickLine is illegal before allocation
  Scenario: CheckOrder rejects a self-check
    Given the same actor who picked the order calls CheckOrder
    When CheckOrder is called
    Then it is rejected with SelfCheckNotAllowedError, status stays "picked"

  Scenario: CheckOrder succeeds when the checker differs from the picker
    Then status is "checked", checked_by is set

  Scenario: CheckOrder is illegal before picking completes
  Scenario: Stale version is rejected on PickLine and CheckOrder
  Scenario: Idempotent replay and conflicting replay on PickLine and CheckOrder
  Scenario: RLS — a caller scoped to another entity cannot pick or check the order
```

## Deliver
- `modules/wms/domain/process-outbound/{machine.ts, errors.ts, invariants.ts}` (edited)
- `modules/wms/application/process-outbound/{ports.ts, index.ts, pick-line.ts, check-order.ts}` (pick-line.ts, check-order.ts new; rest edited)
- `modules/wms/infrastructure/process-outbound/repository.ts` (edited)
- `modules/wms/api/process-outbound/{handlers.ts, composition.ts}` (edited)
- `packages/contracts/wms/process-outbound.ts` (edited — two new schemas)
- `modules/wms/tests/process-outbound/*` (edited/extended)

Migration number: none — every column this part needs (`variance_reason`, `qty_actual`, `movement_type='pick'`) already exists.
Stop-and-ask if: any table/column/rule not in 01/13/13B/019/40 — file under G-01; never invent. (The pick-shortage-alert mechanism and OF-01…OF-11 document generation are the two live, explicitly-deferred examples this part already tracks — not G-01 gaps, just out-of-scope future work.)
