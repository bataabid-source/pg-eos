// modules/wms/application/process-outbound/allocate.ts — WBS 2.11 part 2 (brief Master decision 2),
// following ../../application/process-outbound/approve-outbound.ts's own shape.
//
// SINGLE-LOT allocation per order line (Master ruling, fix round 1): `wms.order_lines` carries one
// `location_id`/`batch_no` per line and no per-lot allocation child table exists (SCR-WMS-OUT-01),
// so a line is never split across two lots.
//
// ONE withIdempotentContext transaction. Lock order: (1) order-row lock + expectedVersion check,
// (2) the machine's own transition-guard check (ALLOCATE_FULL must be legal from the order's
// current status — only 'approved' — BEFORE any write; ALLOCATE_PARTIAL shares the exact same
// source status, so this single check gates both), (3) for every order line (line_no order):
// fetch the SKU's picking_policy and the candidate lots — ALREADY ordered FEFO/FIFO/LIFO and
// locked `for update of sb` by the repository's own SQL — then run the pure domain function
// allocateFromSingleLot (../../domain/process-outbound/invariants.ts), which picks ONE lot:
// the first lot in policy order whose qty_available covers the whole line, else the first lot in
// policy order supplying min(available, ordered), else none. When a lot was chosen, that ONE
// lot's qty_allocated is incremented by the quantity taken, and the line records that same lot's
// location_id/batch_no + qty_actual (the quantity taken from it) + status ('complete' when it
// covers qty_ordered, 'partial' when it covers less, 'open' with null location/batch when no lot
// has stock); (4) the order's own status is 'allocated' when every line is 'complete', else
// 'partially_allocated' (advanceOutboundOrder picks the matching machine edge); (5) the
// unconditional version bump; (6) ONE outbox event (wms.outbound.allocated OR
// wms.outbound.partially_allocated, both in packages/events/catalog.ts) + ONE audit row whose
// per-line entries carry the reserved locationId/batchNo (doc 40 §A1 P7), same correlation_id
// (last, ADR-0002). No wms.stock_movements row (Scope — the pick movement belongs to 2.12's own
// PickLine). platform.audit_log is never read.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';
import { Quantity } from '@pg-eos/domain-kit';

import { OUTBOUND_ORDER_EVENTS, advanceOutboundOrder, canTransition } from '../../domain/process-outbound/machine.js';
import { IllegalTransitionError, MissingActorError, StaleVersionError } from '../../domain/process-outbound/errors.js';
import { allocateFromSingleLot, type AllocationLotCandidate } from '../../domain/process-outbound/invariants.js';
import type { CandidateLotRow, ProcessOutboundDeps } from './ports.js';

const AUDIT_OPERATION_ALLOCATE = 'update';
const OUTBOUND_ALLOCATED_EVENT: CatalogedEventType = 'wms.outbound.allocated';
const OUTBOUND_PARTIALLY_ALLOCATED_EVENT: CatalogedEventType = 'wms.outbound.partially_allocated';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';
const LINE_STATUS_OPEN = 'open';
const LINE_STATUS_PARTIAL = 'partial';
const LINE_STATUS_COMPLETE = 'complete';
// A system-derived reason (never operator-entered) satisfying wms.order_lines' own
// `variance_needs_reason` check (01-Data-Model.sql:790-793: qty_actual <> qty_ordered requires a
// non-null variance_reason).
const PARTIAL_ALLOCATION_VARIANCE_REASON = 'insufficient_stock';

export interface AllocateInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface AllocateResult {
  readonly status: 'allocated' | 'partially_allocated';
  readonly version: number;
}

/** One line's entry in the audit row's `new_value.lines` — the reserved lot's own
 *  `locationId`/`batchNo` (null when no lot had stock), doc 40 §A1 P7. */
interface AllocatedLineAudit {
  readonly lineId: string;
  readonly status: string;
  readonly qtyOrdered: string;
  readonly qtyActual: string;
  readonly locationId: string | null;
  readonly batchNo: string | null;
}

export async function allocate(
  ctx: WithContextCtx,
  input: AllocateInput,
  deps: ProcessOutboundDeps,
): Promise<AllocateResult> {
  if (!ctx.userId) throw new MissingActorError('Allocate requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<AllocateResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `Allocate: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    // ALLOCATE_FULL and ALLOCATE_PARTIAL share the exact same legal source status ('approved') —
    // checking one gates both, BEFORE any write (no stock_balance/order_lines mutation on an
    // illegal-status attempt).
    if (!canTransition(order.status, OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL)) {
      throw new IllegalTransitionError(
        `Allocate is illegal from outbound-order status "${order.status}" (the machine allows it ` +
          `only from "approved").`,
      );
    }

    const lines = await deps.repo.getOrderLinesForAllocation(tx, input.orderId);
    let everyLineComplete = lines.length > 0;
    const lineAudits: AllocatedLineAudit[] = [];

    for (const line of lines) {
      const pickingPolicy = await deps.repo.getSkuPickingPolicy(tx, line.skuId);
      const candidateLots = await deps.repo.getCandidateLots(tx, {
        clientId: order.clientId,
        skuId: line.skuId,
        warehouseId: order.warehouseId,
        pickingPolicy,
      });
      const lotCandidates: AllocationLotCandidate[] = candidateLots.map((lot, index) => ({
        lotKey: String(index),
        available: lot.qtyAvailable,
      }));
      // Single-lot rule: `consumed` holds at most ONE entry — the one lot this line reserves.
      const chosen = allocateFromSingleLot(line.qtyOrdered, lotCandidates).consumed[0];
      const reservedLot: CandidateLotRow | undefined = chosen ? candidateLots[Number(chosen.lotKey)] : undefined;
      const reservedQty = chosen && reservedLot ? Quantity.of(chosen.qty) : Quantity.zero();

      if (reservedLot) {
        await deps.repo.incrementLotAllocated(tx, {
          clientId: order.clientId,
          skuId: line.skuId,
          locationId: reservedLot.locationId,
          batchNo: reservedLot.batchNo,
          qty: reservedQty.toString(),
        });
      }

      const lineStatus =
        reservedQty.compare(Quantity.of(line.qtyOrdered)) === 0
          ? LINE_STATUS_COMPLETE
          : reservedQty.isPositive()
            ? LINE_STATUS_PARTIAL
            : LINE_STATUS_OPEN;
      if (lineStatus !== LINE_STATUS_COMPLETE) everyLineComplete = false;

      const locationId = reservedLot?.locationId ?? null;
      const batchNo = reservedLot?.batchNo ?? null;

      await deps.repo.updateOrderLineAllocation(tx, {
        lineId: line.lineId,
        status: lineStatus,
        locationId,
        batchNo,
        qtyActual: reservedQty.toString(),
        varianceReason: lineStatus === LINE_STATUS_COMPLETE ? null : PARTIAL_ALLOCATION_VARIANCE_REASON,
      });

      lineAudits.push({
        lineId: line.lineId,
        status: lineStatus,
        qtyOrdered: line.qtyOrdered,
        qtyActual: reservedQty.toString(),
        locationId,
        batchNo,
      });
    }

    const event = everyLineComplete ? OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL : OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL;
    const newStatus = advanceOutboundOrder(order.status, [event]);
    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus });
    const occurredAt = deps.clock.now();
    const eventType = everyLineComplete ? OUTBOUND_ALLOCATED_EVENT : OUTBOUND_PARTIALLY_ALLOCATED_EVENT;

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType,
      payload: { orderId: input.orderId, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_ALLOCATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, lines: lineAudits },
      occurredAt,
    });

    return { status: everyLineComplete ? 'allocated' : 'partially_allocated', version: newVersion };
  });
}
