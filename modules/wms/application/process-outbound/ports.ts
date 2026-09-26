// modules/wms/application/process-outbound/ports.ts — WBS 2.11 part 1.
//
// application/ layer: the ports this use case programs against, following the shape of
// ../../application/receive-inbound/ports.ts (golden slice). Every command takes ONE
// `deps: ProcessOutboundDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/process-outbound/repository.ts implements `OutboundOrderRepository`
// (including the cross-schema read-only condition checks, brief "Scope taken by the lane" —
// no cross-module TypeScript import, plain SQL against sales.*/catalog.* inside the same
// withContext(ctx, fn) transaction, following the ../../infrastructure/take-occupancy-snapshot/
// repository.ts precedent).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { OutboundOrderStatus } from '../../domain/process-outbound/machine.js';

export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type LogFields = Record<string, unknown>;

/** A structured logger port — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." Implemented
 *  by ../../infrastructure/process-outbound/logger.ts; a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by ../../api/process-outbound/composition.ts. */
export interface ProcessOutboundDeps extends ClockDeps {
  readonly repo: OutboundOrderRepository;
  readonly ledger: LedgerPort;
  readonly logger: Logger;
}

/** The ledger rows one posting wrote — ../../infrastructure/receive-inbound/ports.ts's own
 *  `PostedLedgerMovement` shape (fix round 1 finding 1). */
export interface PostedLedgerMovement {
  readonly movementIds: readonly string[];
  readonly correlationId: string;
}

export interface PostPickParams {
  readonly entityId: string;
  readonly clientId: string;
  readonly skuId: string;
  /** the line's own reserved `location_id` — a pick removes stock, it is not a transfer (unlike
   *  putaway), so there is no `toLocationId`. */
  readonly fromLocationId: string;
  readonly qty: string;
  readonly uom: string;
  readonly batchNo: string;
  /** ref_id for the posted `wms.stock_movements` row — fix round 1 finding 2: keyed to the LINE
   *  (`ref_table='wms.order_lines'`), never the order, so a per-line "already picked" check is
   *  possible. Same precedent ../count-inventory/ledger.ts already uses. */
  readonly lineId: string;
  readonly correlationId: string;
}

/** Fix round 1 finding 1 — implemented by ../../infrastructure/process-outbound/ledger.ts (NEW), a
 *  thin adapter over ../../src/stock-ledger/post-movement.ts's `postMovementInTx`, mirroring
 *  ../../infrastructure/receive-inbound/ledger.ts's exact pattern: the shared rebuild-key lock, the
 *  balance advisory lock, `validateEntry` (rejects qty<=0 before the DB), the
 *  `no_negative_stock`->`NegativeStockError` mapping, `last_movement_at`, and the per-movement
 *  `wms.stock.moved` outbox+audit pairing (G9) — none of which the hand-written SQL this replaces
 *  had. */
export interface LedgerPort {
  postPick(tx: NodePgDatabase, params: PostPickParams, actorId: string, deps: ClockDeps): Promise<PostedLedgerMovement>;
}

export type AuditTarget = 'order';

export interface OrderRow {
  readonly id: string;
  readonly entityId: string;
  readonly clientId: string;
  readonly contractId: string | null;
  readonly warehouseId: string;
  readonly orderType: string;
  readonly status: OutboundOrderStatus;
  readonly version: number;
  readonly shipToName: string | null;
  readonly shipToPhone: string | null;
  readonly shipToAddress: string | null;
  readonly shipToArea: string | null;
  /** WBS 2.12 part 1: PickLine's own `picked_by` (01-Data-Model.sql:768) — null before the order
   *  reaches 'picked'. CheckOrder's own self-check gate compares this to `ctx.userId`. */
  readonly pickedBy: string | null;
  /** WBS 2.12 part 1: CheckOrder's own `checked_by` — null before the order reaches 'checked'. */
  readonly checkedBy: string | null;
}

export interface OrderLineRow {
  readonly skuId: string;
  readonly qtyOrdered: string;
}

export interface OrderUpdateColumns {
  readonly status: OutboundOrderStatus;
  readonly creditCheckPassed?: boolean;
  readonly creditCheckedAt?: Date;
  /** WBS 2.12 part 1: set once, the call PickLine completes the order on (coalesce — never
   *  overwritten by a later call). */
  readonly pickedBy?: string;
  /** WBS 2.12 part 1: set once, on the call CheckOrder succeeds on. */
  readonly checkedBy?: string;
}

export interface ClientQualificationRow {
  readonly status: string;
  readonly deletedAt: Date | null;
}

export interface ContractCheckRow {
  /** WBS 2.11 part 5 (D-189, finding 1): the resolved contract's own id — condition 10 looks up
   *  `sales.contract_sku_limits` by THIS resolved contract_id, never by `order.contractId` directly
   *  (which may be null when the order was created without one and condition 1 resolved it by
   *  client/entity instead). */
  readonly id: string;
  /** ISO date (`YYYY-MM-DD`) or null — never a Date instance (CLAUDE.md "no Date in domain/";
   *  kept as the raw SQL text form up through the application layer for a stable string compare). */
  readonly endDate: string | null;
  readonly priceListId: string | null;
}

/** Condition 10 (WBS 2.11 part 5, D-189): `sales.contract_sku_limits.max_order_qty` for a
 *  (contract_id, sku_id) pair, or `null` when no row exists (no cap). */
export interface ContractSkuLimitRow {
  readonly maxOrderQty: string;
}

export interface AccountCreditRow {
  readonly creditHold: boolean;
  readonly holdReason: string | null;
}

export interface SkuCheckRow {
  readonly clientId: string;
  readonly code: string;
  readonly status: string;
  readonly trackExpiry: boolean;
  readonly minRemainingLifeIssueDays: number | null;
}

export interface StockAvailabilityRow {
  readonly availableSum: string;
  readonly singleLocationCode: string | null;
}

export interface StockLotRow {
  readonly expiryDate: string | null;
  readonly qtyAvailable: string;
  /** Fix round 1 finding 6: `wms.stock_balance.batch_no` — named in ShelfLifeTooShortError's
   *  params so the message can identify the failing lot. */
  readonly batchNo: string;
}

export interface StockedLocationBlockRow {
  readonly isBlocked: boolean;
  /** `wms.locations.code` (01-Data-Model.sql:634) — fix round 1 finding 6/7. */
  readonly locationCode: string;
  /** `wms.locations.block_reason` (01-Data-Model.sql:642) — fix round 1 finding 6/7. */
  readonly blockReason: string | null;
  /** `wms.stock_balance.qty_available` at this location — fix round 1 finding 7 (the
   *  non-blocked-only sufficiency comparison). */
  readonly qtyAvailable: string;
}

// --- WBS 2.11 part 2: Allocate / GeneratePickList / extended CancelOutbound (brief Master
// decisions 2/3/4) --------------------------------------------------------------------------------

export interface AllocationLineRow {
  readonly lineId: string;
  readonly lineNo: number;
  readonly skuId: string;
  readonly qtyOrdered: string;
}

/** `wms.stock_balance` candidate lot for Allocate, ALREADY ordered by the repository's own SQL
 *  per the SKU's `picking_policy` (brief Master decision 2); Allocate reserves at most ONE of them
 *  per line (single-lot rule). */
export interface CandidateLotRow {
  readonly locationId: string;
  readonly batchNo: string;
  readonly qtyAvailable: string;
}

export interface IncrementLotAllocatedParams {
  readonly clientId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly qty: string;
}

export interface UpdateOrderLineAllocationParams {
  readonly lineId: string;
  readonly status: string;
  readonly locationId: string | null;
  readonly batchNo: string | null;
  readonly qtyActual: string;
  readonly varianceReason: string | null;
}

export interface PickListLineRow {
  readonly lineId: string;
  readonly lineNo: number;
  readonly skuId: string;
  readonly qtyOrdered: string;
  readonly locationId: string;
  readonly locationCode: string;
  readonly positionNo: number | null;
  readonly batchNo: string | null;
}

/** Master decision 4: one `order_lines` row on this order with a non-null `location_id` — the
 *  SINGLE lot Allocate reserved for that line (single-lot rule) and the `qty_actual` it reserved
 *  there — a release candidate for CancelOutbound's own extension. */
export interface ConsumedLineRow {
  readonly lineId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly qtyActual: string;
}

// --- PickLine / CheckOrder (WBS 2.12 part 1, brief Master decisions 2/3) ------------------------

/** The ONE order_lines row a PickLine call targets — scoped to (lineId, orderId) so a lineId from
 *  a different order can never be picked against this order. `locationId`/`batchNo` are the single
 *  lot Allocate reserved for this line (null when the line was never allocated any stock).
 *  Fix round 1 finding 3: `reservedQty` is that same row's own `qty_actual` — Allocate's own stamp
 *  of the quantity reserved from that one lot, read BEFORE this call's own `updateOrderLinePick`
 *  overwrites the column with the actually-picked amount. */
export interface PickOrderLineRow {
  readonly lineId: string;
  readonly skuId: string;
  readonly qtyOrdered: string;
  readonly uom: string;
  readonly locationId: string | null;
  readonly batchNo: string | null;
  readonly reservedQty: string | null;
  /** WBS 2.12 part 2 item 3: `order_lines.status` — the only reliable "never picked" signal on an
   *  unreserved line (`locationId === null`), since Allocate leaves such a line at `'open'` and
   *  PickLine's own status computation (LINE_STATUS_COMPLETE/LINE_STATUS_PARTIAL) moves ANY line
   *  off `'open'`, including a zero-qty pick. */
  readonly status: string;
}

export interface UpdateOrderLinePickParams {
  readonly lineId: string;
  readonly status: string;
  readonly qtyActual: string;
  readonly varianceReason: string | null;
}

/** Every DB statement the process-outbound use case needs (part 1). Implemented by
 *  ../../infrastructure/process-outbound/repository.ts. */
export interface OutboundOrderRepository {
  /** order-row lock, FIRST — `select ... for update`. */
  getOrderForUpdate(tx: NodePgDatabase, orderId: string): Promise<OrderRow>;
  /** WBS 2.11 part 2 (Master decision 3): a plain, unlocked read of the order row —
   *  GeneratePickList is read-only, no row lock. */
  getOrderForRead(tx: NodePgDatabase, orderId: string): Promise<OrderRow>;
  /** unconditional version bump — the caller already validated expectedVersion against the
   *  locked row and holds that lock for the whole transaction. */
  updateOrder(tx: NodePgDatabase, orderId: string, columns: OrderUpdateColumns): Promise<number>;
  hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean>;
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly target: AuditTarget;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;

  // --- CreateOutbound -----------------------------------------------------------------------
  /** brief Master decision 13: the client must exist, `deleted_at is null`, `status='active'`. */
  getClientQualification(tx: NodePgDatabase, clientId: string): Promise<ClientQualificationRow | null>;
  nextDocNo(tx: NodePgDatabase, entityId: string, docType: string): Promise<string>;
  insertOrder(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly docNo: string;
      readonly clientId: string;
      readonly contractId: string | null;
      readonly warehouseId: string;
      readonly orderType: string;
      readonly requiredBy: Date | null;
      readonly shipToName: string | null;
      readonly shipToPhone: string | null;
      readonly shipToAddress: string | null;
      readonly shipToArea: string | null;
      readonly clientRef: string | null;
      readonly createdBy: string;
    },
  ): Promise<{ readonly id: string; readonly docNo: string; readonly version: number }>;

  // --- RunOutboundChecks — condition reads (brief Master decision 3), all read-only ----------
  getOrderLines(tx: NodePgDatabase, orderId: string): Promise<readonly OrderLineRow[]>;
  /** condition 1 + the price-list half of condition 9 — the ACTIVE `sales.contracts` row for
   *  (clientId, entityId); fix round 1 finding 4: `contractId` (optional on the order) is only a
   *  NARROWING filter when the order carries one, never the sole lookup key — an order created
   *  without a `contractId` still resolves the client's own active contract. */
  getContractCheck(
    tx: NodePgDatabase,
    params: { readonly clientId: string; readonly entityId: string; readonly contractId?: string | undefined },
  ): Promise<ContractCheckRow | null>;
  /** condition 2 (checked last by the caller). */
  getAccountCredit(tx: NodePgDatabase, clientId: string): Promise<AccountCreditRow | null>;
  /** conditions 4/5/6. */
  getSkuCheck(tx: NodePgDatabase, skuId: string): Promise<SkuCheckRow | null>;
  /** condition 3: summed `qty_available` across the warehouse for (clientId, skuId), plus the
   *  single stocked location's code when exactly one holds any. */
  getStockAvailability(
    tx: NodePgDatabase,
    params: { readonly clientId: string; readonly skuId: string; readonly warehouseId: string },
  ): Promise<StockAvailabilityRow>;
  /** condition 5: every candidate lot (`qty_available > 0`) for (clientId, skuId) in the
   *  warehouse. */
  getStockLots(
    tx: NodePgDatabase,
    params: { readonly clientId: string; readonly skuId: string; readonly warehouseId: string },
  ): Promise<readonly StockLotRow[]>;
  /** condition 7: every location currently holding `qty_available > 0` for (clientId, skuId) in
   *  the warehouse, with its own `is_blocked`. */
  getStockedLocationBlocks(
    tx: NodePgDatabase,
    params: { readonly clientId: string; readonly skuId: string; readonly warehouseId: string },
  ): Promise<readonly StockedLocationBlockRow[]>;
  /** condition 9: `catalog.services.id` for the service code (e.g. `OF-01`). */
  getServiceIdByCode(tx: NodePgDatabase, code: string): Promise<string | null>;
  /** condition 9 (fix round 1 finding 8): an active, dated priced line — joins
   *  `catalog.price_lists` on `status='active'` and `valid_from <= asOfDate <= valid_to` (or
   *  `valid_to is null`), not just a `price_list_lines` row's mere existence. */
  hasPricedLine(
    tx: NodePgDatabase,
    params: { readonly priceListId: string; readonly serviceId: string; readonly asOfDate: string },
  ): Promise<boolean>;
  /** condition 9: an approved price exception valid as-of `asOfDate`. */
  hasPriceException(
    tx: NodePgDatabase,
    params: { readonly entityId: string; readonly clientId: string; readonly serviceId: string; readonly asOfDate: string },
  ): Promise<boolean>;
  /** condition 10 (WBS 2.11 part 5, D-189): `sales.contract_sku_limits` for the SAME contract
   *  condition 1 already resolved (`contractId` is that row's own `id`, never `order.contractId`
   *  directly) and the line's `skuId`. `null` when no row exists — no cap for that line. */
  getContractSkuLimit(
    tx: NodePgDatabase,
    params: { readonly contractId: string; readonly skuId: string },
  ): Promise<ContractSkuLimitRow | null>;

  // --- Allocate (brief Master decision 2) -----------------------------------------------------
  getOrderLinesForAllocation(tx: NodePgDatabase, orderId: string): Promise<readonly AllocationLineRow[]>;
  /** `wms.skus.picking_policy` ('FIFO'|'FEFO'|'LIFO', schema default 'FIFO'). */
  getSkuPickingPolicy(tx: NodePgDatabase, skuId: string): Promise<string>;
  /** Every candidate lot (`qty_available > 0`) for (clientId, skuId) in the warehouse, ordered
   *  FEFO/FIFO/LIFO per `pickingPolicy` — the SAME ordering this function's own SQL applies,
   *  never re-ordered by the caller. */
  getCandidateLots(
    tx: NodePgDatabase,
    params: { readonly clientId: string; readonly skuId: string; readonly warehouseId: string; readonly pickingPolicy: string },
  ): Promise<readonly CandidateLotRow[]>;
  /** Increments the `qty_allocated` of the ONE `wms.stock_balance` row a line reserves (single-lot
   *  rule) by the quantity taken from it; the row is already locked by `getCandidateLots`' own
   *  `for update of sb`. Throws `StockBalanceRowMissingError` when the UPDATE matches no row. */
  incrementLotAllocated(tx: NodePgDatabase, params: IncrementLotAllocatedParams): Promise<void>;
  /** Sets an order line's own `location_id`/`batch_no` (the SINGLE reserved lot, or null when no
   *  lot had stock), `status`, `qty_actual` (the quantity reserved from that one lot) and
   *  `variance_reason` (required by `wms.order_lines`' own `variance_needs_reason` check whenever
   *  `qty_actual <> qty_ordered`). */
  updateOrderLineAllocation(tx: NodePgDatabase, params: UpdateOrderLineAllocationParams): Promise<void>;

  // --- GeneratePickList (brief Master decision 3) ---------------------------------------------
  /** Every allocated `order_lines` row (`location_id is not null`) on this order, joined to its
   *  location's `position_no`, ordered `position_no` ascending (nulls last), ties broken by
   *  `line_no` — already sorted server-side, never re-ordered by the caller. */
  getAllocatedPickListLines(tx: NodePgDatabase, orderId: string): Promise<readonly PickListLineRow[]>;

  // --- CancelOutbound's release step (brief Master decision 4) ---------------------------------
  /** Every `order_lines` row on this order with a non-null `location_id` — one per allocated
   *  line, each naming the single lot Allocate reserved for it. */
  getConsumedLinesForRelease(tx: NodePgDatabase, orderId: string): Promise<readonly ConsumedLineRow[]>;
  /** The reverse of `incrementLotAllocated` — decrements the line's single reserved
   *  `wms.stock_balance` row's `qty_allocated` by the line's `qty_actual`. Throws
   *  `StockBalanceRowMissingError` when the UPDATE matches no row. */
  decrementLotAllocated(tx: NodePgDatabase, params: IncrementLotAllocatedParams): Promise<void>;

  // --- PickLine / CheckOrder (WBS 2.12 part 1) -------------------------------------------------
  /** The ONE order_lines row this PickLine call targets — scoped to (lineId, orderId). */
  getOrderLineForPick(
    tx: NodePgDatabase,
    params: { readonly lineId: string; readonly orderId: string },
  ): Promise<PickOrderLineRow | null>;
  /** Fix round 1 finding 2: `true` when a `wms.stock_movements` 'pick' row already exists for THIS
   *  line (`ref_table='wms.order_lines'`/`ref_id`=lineId) — the double-pick guard, called BEFORE
   *  any write. */
  hasPickMovementForLine(tx: NodePgDatabase, params: { readonly lineId: string }): Promise<boolean>;
  /** WBS 2.12 part 2 item 4: `true` when a `wms.stock_movements` 'pick' row exists on THIS ORDER
   *  whose `performed_by` is `actorId` — broadens CheckOrder's self-check beyond `picked_by` (which
   *  records only the LAST picker of a multi-person pick) to every actor who posted ANY pick
   *  movement on the order. */
  hasPickMovementByActor(
    tx: NodePgDatabase,
    params: { readonly orderId: string; readonly actorId: string },
  ): Promise<boolean>;
  /** Count of order_lines rows on this order (with a reserved lot, `location_id is not null`) that
   *  are still open — fix round 1 findings 2/5: a reserved line is open until EITHER a matching
   *  `wms.stock_movements` 'pick' row exists for it (`ref_table='wms.order_lines'`/`ref_id`=the
   *  LINE's own id, never the order — the double-pick fix), OR its own `qty_actual` reads `0`
   *  (a zero-quantity pick intentionally posts no ledger row, finding 5 — see
   *  ../../domain/process-outbound/invariants.ts's `assertLineNotAlreadyPicked` doc comment for why
   *  `qty_actual = 0` can only mean "already zero-picked" on a reserved line). Zero means the order
   *  just completed picking. Ledger-based (never `order_lines.qty_actual is null`): Allocate
   *  ALREADY writes `qty_actual`/`status` on every line to record its own reservation outcome
   *  (../../application/process-outbound/allocate.ts), so that column alone can never distinguish
   *  "reserved" from "physically picked" — the append-only pick ledger (plus the zero-pick
   *  exception above) is the only reliable signal this call itself controls. */
  countOpenPickLines(tx: NodePgDatabase, orderId: string): Promise<number>;
  /** Sets `qty_actual`/`status`/`variance_reason` on the one line this call picked. */
  updateOrderLinePick(tx: NodePgDatabase, params: UpdateOrderLinePickParams): Promise<void>;
}
