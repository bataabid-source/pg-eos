# SLICE BRIEF — WBS 2.11 part 2 · Allocate, GeneratePickList, allocation-aware CancelOutbound

Task: 2.11 part 2 — Allocate (FEFO/FIFO), GeneratePickList (shortest path), CancelOutbound extended to allocated/partially_allocated (release) — closes WBS 2.11      Lane: 1      Lock: `wms/process-outbound` (whole part) + `wms/receive-inbound` (test-files-only, item 0 below; released with this slice's commit)
Owner: WH_MGR      Deps: 2.11 part 1 DONE (`a96b013`)      Worktree: `../pg-eos-lane-1`, branch `lane/1-2.11p2` (on origin/main `119f65d`)
Model routing: pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium — orchestrates only.
Master-set bound for this slice: brief ≤ 8 files / 1,000 lines, **two review rounds max** (tighter than the usual budget) — a third FAIL escalates straight to the Master, no third worker round.
No new use case, no `scripts/new-slice.sh` run — this extends the existing `process-outbound` tree (part 1) in place.

## Item 0 — 2.10 fixture fix (pg-tester, test-files-only, `wms/receive-inbound` lock)
`modules/wms/tests/receive-inbound/receive-inbound.test.ts`'s `pickFreshWh1Location` currently does `select ... where w.code='WH1' and l.location_type=$1 and l.is_blocked=false and l.id <> all($2::uuid[]) order by l.code desc limit 1` — picking ANY unblocked WH1 location, descending by code, excluding only already-used-by-this-test ids. This is the SAME class of bug as part 1's own finding 1 (handlers.test.ts's `LIMIT 1` on a shared row): it can pick a real WH1 production location OR another test file's leftover fixture location, and `order by code desc limit 1` means an orphan location whose code sorts high (e.g. a stray `T9-*` row) is picked FIRST — pg-reviewer traced this to 2.9b round 5's 8 failures (7 location-ranking + 1 `ConfirmPutaway` `LocationLimitExceededError`, both from `maxWeightKg: null` on locations this picker handed out and count mismatches from orphaned rows). Fix: this function must create its OWN dedicated location under a distinct code prefix (`M9-` block — the same block part 1's own `handlers.test.ts`/`process-outbound.test.ts` fixtures now use, already proven collision-free under concurrent runs) instead of selecting an existing row, mirroring part 1's own fix for the identical class of bug. Write ONLY `modules/wms/tests/receive-inbound/receive-inbound.test.ts` — no other receive-inbound file, no domain/application/api file. Verify: `PGHOST=localhost PGUSER=postgres PGDATABASE=pgeos PG_APP_USER=pgeos_app pnpm --filter @pg-eos/wms test -- receive-inbound` full pass, twice in a row (collision check), before moving to item 1+.

## Item 1+ — Allocate, GeneratePickList, CancelOutbound extension (pg-backend + pg-tester, `wms/process-outbound` lock)

### Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG)
- **Allocation is a soft reservation, not a physical movement** (unchanged from the original, discarded 32-file brief's own decision, re-confirmed against the D-blueprint this session): `Allocate` increments `wms.stock_balance.qty_allocated` and sets `order_lines.location_id`/`batch_no`; it writes NO `wms.stock_movements` row — the doc's own flow places the `pick` movement type at the PICKING step (2.12), not at allocation.
- **Allocation rule (Master ruling, verbatim)**: "a line is allocated from a single lot. FEFO/FIFO picks the first lot whose qty_available covers the line; if none covers it, the best single lot supplies min(available, ordered) → `partially_allocated` with the `insufficient_stock` variance constant; if no lot has stock the line stays unallocated; a line is never split across two lots." `order_lines.location_id`/`batch_no` always records that single lot (the DDL gives one `location_id`/`batch_no` per line). Per-lot split is a G-01 item — SCR-WMS-OUT-01.
- **"Shortest path" pick sequencing reuses `wms.locations.position_no`** — the same proximity proxy 2.9/2.10's `SuggestLocation` already uses, no routing-graph invention.
- **CancelOutbound's release path**: cancelling an `allocated`/`partially_allocated` order must not leak a permanent reservation — for every order line that consumed a lot (fully or partially allocated; a line left unallocated has nothing to release), that single lot's `qty_allocated` is decremented back, same rows, same transaction, before the status flips to `cancelled`.

## Read ONLY (workers) — kept under the 8-file / 1,000-line budget
1. `CLAUDE.md`
2. `.claude/briefs/wms.brief.md`
3. `docs/package/D-blueprints/03-Operations-Warehouse.md` lines 277-291 (§4.2 flow table rows 3-4b — approved → allocated/partially_allocated, verbatim, already quoted below)
4. `docs/package/40-Build-Specification-EN.md` lines 260-260 (the `Allocate (FEFO/FIFO)` / `GeneratePickList (shortest path)` command names, verbatim)
5. `database/schema/01-Data-Model.sql` lines 717-728 (`wms.stock_balance`, verbatim DDL), 648-680 (`wms.skus`, verbatim DDL), 630-645 (`wms.locations`, verbatim DDL)
6. `modules/wms/tests/receive-inbound/receive-inbound.test.ts` lines 260-330 (item 0's `pickFreshWh1Location` plus the `insertZone`/`insertLocation`-shaped M9 fixture helpers it must mirror, from this same file's neighbourhood) — pg-tester (item 0) only

## Not separately read (viewed directly when editing, not a precedent study)
`modules/wms/domain/process-outbound/{machine.ts, errors.ts}`, `modules/wms/application/process-outbound/{ports.ts, cancel-outbound.ts, index.ts}`, `modules/wms/infrastructure/process-outbound/repository.ts`, `modules/wms/api/process-outbound/{handlers.ts, composition.ts}`, `packages/contracts/wms/process-outbound.ts` — every file this slice extends is already this lock's own reviewed code from part 1; pg-backend views each directly before editing it, matching the SAME field/error/i18n conventions those files already established (version-lock, `withIdempotentContext`, outbox+audit same transaction, `Quantity` decimal arithmetic — never a raw `Number()` on a quantity, per part 1's own fix-round finding 7). `modules/wms/tests/process-outbound/*` (all four existing test files) — pg-tester extends these directly, same reasoning.

## Write ONLY
- pg-tester: `modules/wms/tests/receive-inbound/receive-inbound.test.ts` (item 0 ONLY) · `modules/wms/tests/process-outbound/*` (item 1+, extend existing files, do not weaken any of the 126 existing passing tests).
- pg-backend: `modules/wms/domain/process-outbound/{machine.ts, errors.ts, invariants.ts}` · `modules/wms/application/process-outbound/{ports.ts, index.ts, allocate.ts, generate-pick-list.ts, cancel-outbound.ts}` (allocate.ts/generate-pick-list.ts are NEW files, cancel-outbound.ts is EDITED) · `modules/wms/infrastructure/process-outbound/repository.ts` · `modules/wms/api/process-outbound/{handlers.ts, composition.ts}` · `packages/contracts/wms/process-outbound.ts` (add `AllocateInputSchema`, `GeneratePickListInputSchema` only — the four part-1 schemas stay unchanged).
Forbidden for every worker: `database/schema/**` (no migration this part — `qty_allocated`/`position_no`/`picking_policy` all already exist), `packages/**` other than the one named contract file, `packages/events/catalog.ts`, other modules, any golden-slice `receive-inbound/*` file other than item 0's one named test file, `docs/**` other than this brief, `scripts/**`, `CLAUDE.md`, `.claude/**`.

## Acceptance criterion (doc 38 row 2.11, verbatim — this closes the row)
"Each of ten conditions has a failing test with the correct message" — nine of ten already met (part 1); condition 10 stays explicitly BLOCKED (no schema source, unchanged). This part's own delivery is judged against doc 40's command list: `Allocate` and `GeneratePickList` exist, are tested, and `CancelOutbound` correctly releases an allocation.
Gates: `pnpm --filter @pg-eos/wms typecheck && lint` green · **FULL `pnpm --filter @pg-eos/wms test` (unfiltered module suite, not `-- process-outbound`) green — mandatory this slice, per the CHANGELOG process note part 1's own regression added** · `pnpm guards:run` green (re-check G1 before the first run — shared-DB pollution is GM/Master-owned cleanup, not this slice's job to fix, but a red G1 from LEAKED rows this slice's own fixtures cause is this slice's job) · pg-reviewer PASS (two rounds max this slice).

## D-blueprint 03 §4.2 rows 3-4b (verbatim, already used to derive the Master decisions below)
| # | من يفعلها | ما الذي يتغيّر في القاعدة | الحدث المنشور |
|---|---|---|---|
| 3 | `WH_MGR` | `status='approved'` | `wms.outbound.approved` ← قائمة التقاط |
| 4 | النظام + `WH_SUP` | **FEFO** للأصناف ذات الصلاحية · **FIFO** لغيرها · `stock_balance.qty_allocated` يرتفع · `order_lines.location_id` | `wms.outbound.allocated` |
| 4ب | النظام | نجاح جزئي ⇒ `status='partially_allocated'` · السطر `order_lines.status='partial'` · لا يُقفل تلقائياً · ينبّه المشرف | `wms.outbound.partially_allocated` |

## Master decisions the workers copy (not re-derive)
1. **Machine edges added this part**: `approved --ALLOCATE_FULL--> allocated`, `approved --ALLOCATE_PARTIAL--> partially_allocated`, `{allocated, partially_allocated} --CANCEL--> cancelled` (extends the existing `{draft, checks_pending, credit_rejected, approved} --CANCEL--> cancelled` set from part 1 — CancelOutbound now legal from six statuses total, not four). Every other status (`picking`…`delivered`) still has no producing edge — 2.12's job.
2. **`Allocate`** (`approved → allocated` or `partially_allocated`): for each order line, select candidate `stock_balance` rows for `(client_id=order.clientId, sku_id=line.skuId)` in this warehouse with `qty_available > 0`, ordered: `picking_policy='FEFO'` → `expiry_date` ascending (nulls last); `'FIFO'` → `stock_balance.last_movement_at` ascending (oldest first, no separate "received_at" column exists, recorded default); `'LIFO'` → reverse of FIFO. **Allocation rule (Master ruling, verbatim)**: "a line is allocated from a single lot. FEFO/FIFO picks the first lot whose qty_available covers the line; if none covers it, the best single lot supplies min(available, ordered) → `partially_allocated` with the `insufficient_stock` variance constant; if no lot has stock the line stays unallocated; a line is never split across two lots." `for update` lock the consumed row; increment its `qty_allocated` by the amount taken; set `order_lines.location_id`/`batch_no` to that lot's values. Per-lot split is a G-01 item — SCR-WMS-OUT-01. Line status: `'complete'` if fully satisfied, `'partial'` if partially, stays `'open'` if nothing allocated. Order status: `'allocated'` if every line `'complete'`, else `'partially_allocated'`. One outbox event `wms.outbound.allocated` OR `wms.outbound.partially_allocated` (aggregate `wms.outbound_orders`) + one audit row, same correlation_id, same transaction. No `stock_movements` row (Scope). Version-lock + Idempotency-Key as every other command in this use case.
3. **`GeneratePickList`** (read-only, no lock, `allocated`/`partially_allocated` only — else `IllegalTransitionError`): returns every allocated `order_lines` row (this order only) joined to its `location`'s `position_no`, sorted by `position_no` ascending (shortest-path proxy, Scope), ties broken by `line_no`. No Idempotency-Key (read-only, no state change).
4. **`CancelOutbound` extension**: unchanged role/reason-required contract from part 1; the two new source statuses (`allocated`, `partially_allocated`) trigger a release step BEFORE the status flip — for every `order_lines` row on this order with a non-null `location_id`/`batch_no` (i.e. each line's own single consumed lot from `Allocate`, per the single-lot rule above — a line that stayed unallocated has neither `location_id` nor `batch_no` and is skipped), decrement that `stock_balance` row's `qty_allocated` back by the amount this line consumed (same transaction, `for update` locked) — same shape as `Allocate`'s own lot-locking, in reverse. One outbox event `wms.outbound.cancelled` (already exists) + one audit row.
5. **Actor**: always `ctx.userId`. **Idempotency**: `Allocate` and `CancelOutbound` build `IdempotencyInput`; `GeneratePickList` does not (read-only).
6. **Errors → Problem statuses**: unchanged part-1 convention — `StaleVersionError`/`IdempotencyConflictError` → 409, every other typed domain error → 422, unknown → 500.
7. **`Quantity` decimal arithmetic everywhere a quantity is summed or compared** (part 1's own fix-round finding 7 — never a raw `Number()` on a `qty_*` string).

## Scenario (Gherkin — pg-tester adds to the existing `process-outbound.feature`/`process-outbound.test.ts`, does not remove any of the 126 existing tests)
```gherkin
  Scenario: FEFO allocation picks the earliest-expiring lot first
    Given two lots of the same SKU with different expiry dates, picking_policy 'FEFO'
    When Allocate is called on an approved order
    Then the earlier-expiring lot is the single lot consumed (per the single-lot rule), order_lines
      gets that lot's location/batch, status is "allocated"

  Scenario: FIFO allocation for a non-expiry SKU picks the oldest-moved lot first

  Scenario: Partial allocation when stock runs out mid-line
    Then status is "partially_allocated", the line is "partial", the order is not auto-closed

  Scenario: Allocate is illegal before approval (still draft or checks_pending)

  Scenario: GeneratePickList orders by position_no (shortest path), not line order
  Scenario: GeneratePickList is illegal before allocation

  Scenario: Cancelling an allocated order releases the reservation
    When CancelOutbound is called on an allocated order
    Then qty_allocated on each line's single consumed lot returns to its pre-allocation value,
      status is "cancelled"

  Scenario: Cancelling a partially_allocated order releases the lots consumed by lines that were
    allocated (fully or partially), and leaves untouched any line that stayed unallocated (no lot consumed)
  Scenario: Stale version is rejected on Allocate and the extended CancelOutbound
  Scenario: Idempotent replay and conflicting replay on Allocate
  Scenario: RLS — a caller scoped to another entity cannot see or allocate the order
```

## Deliver
- `modules/wms/domain/process-outbound/{machine.ts, errors.ts, invariants.ts}` (edited)
- `modules/wms/application/process-outbound/{ports.ts, index.ts, allocate.ts, generate-pick-list.ts, cancel-outbound.ts}` (allocate.ts, generate-pick-list.ts new; rest edited)
- `modules/wms/infrastructure/process-outbound/repository.ts` (edited)
- `modules/wms/api/process-outbound/{handlers.ts, composition.ts}` (edited)
- `packages/contracts/wms/process-outbound.ts` (edited — two new schemas)
- `modules/wms/tests/process-outbound/*` (edited/extended) · `modules/wms/tests/receive-inbound/receive-inbound.test.ts` (item 0, edited)

Migration number: none — every column this part needs (`qty_allocated`, `position_no`, `picking_policy`, `last_movement_at`) already exists.
Stop-and-ask if: any table/column/rule not in 01/13/13B/019/40 — file under G-01; never invent.
