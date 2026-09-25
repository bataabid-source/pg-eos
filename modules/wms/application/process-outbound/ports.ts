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
  readonly logger: Logger;
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
}

export interface OrderLineRow {
  readonly skuId: string;
  readonly qtyOrdered: string;
}

export interface OrderUpdateColumns {
  readonly status: OutboundOrderStatus;
  readonly creditCheckPassed?: boolean;
  readonly creditCheckedAt?: Date;
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
}
