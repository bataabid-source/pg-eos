// modules/wms/application/process-outbound/pick-line.ts — WBS 2.12 part 1 (_slice-2.12.brief.md),
// following ./allocate.ts's own shape.
//
// PER-LINE command (like Allocate), version-lock at the ORDER level. ONE withIdempotentContext
// transaction. Lock order: (1) order-row lock + expectedVersion check, (2) legality — START_PICKING
// must be legal from the order's current status ('allocated'/'partially_allocated') OR the order is
// already 'picking' (a continuing line of the same pick run) — BEFORE any write; (3) fetch the
// targeted line (scoped to this order) — an unknown lineId is OrderLineNotFoundError (fix round 1
// finding 7); (4) pre-write gates, all BEFORE any write: assertLineNotAlreadyPicked (finding 2),
// assertLineReservedForPick (finding 6), assertPickedWithinReserved (finding 3),
// assertVarianceReasonRequired (Master decision 2); (5) when the line carries a reserved lot
// (Allocate's own location_id/batch_no): a NONZERO qtyActual posts the wms.stock_movements 'pick'
// row via ../../infrastructure/process-outbound/ledger.ts's LedgerPort (finding 1 — decrements
// qty_on_hand only, by the actually-picked amount); a ZERO qtyActual posts no ledger row at all
// (finding 5); either way qty_allocated is released by the line's FULL reserved quantity, never
// just the picked amount (finding 4 — a shortage permanently reverses the earlier soft
// reservation); (6) update the line's own status/qty_actual/variance_reason; (7) the order's own
// status: 'picking' on the first call (START_PICKING), 'picked' when every line now carries a
// qty_actual (COMPLETE_PICKING) — both may fire in the SAME call on a single-line order; (8) the
// unconditional version bump (Master decision 4: bumped EVERY call, even a middle call of a
// multi-line order that changes no order-level status); (9) ONE outbox event when the order's own
// status actually changed this call ('wms.outbound.picking_started' on the first call,
// 'wms.outbound.picked' when the order completes; NEITHER on a middle call of a 3+-line order whose
// own order status stays 'picking') + ONE audit row every call, same correlation_id (last,
// ADR-0002). platform.audit_log is never read.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { Quantity } from '@pg-eos/domain-kit';
import { writeOutboxEvent } from '@pg-eos/events';

import { OUTBOUND_ORDER_EVENTS, OUTBOUND_ORDER_STATUS, advanceOutboundOrder, canTransition } from '../../domain/process-outbound/machine.js';
import { IllegalTransitionError, MissingActorError, OrderLineNotFoundError, StaleVersionError } from '../../domain/process-outbound/errors.js';
import {
  assertLineNotAlreadyPicked,
  assertLineReservedForPick,
  assertPickedWithinReserved,
  assertVarianceReasonRequired,
} from '../../domain/process-outbound/invariants.js';
import type { ProcessOutboundDeps } from './ports.js';

const AUDIT_OPERATION_PICK = 'update';
const OUTBOUND_PICKING_STARTED_EVENT = 'wms.outbound.picking_started';
const OUTBOUND_PICKED_EVENT = 'wms.outbound.picked';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';
const LINE_STATUS_COMPLETE = 'complete';
const LINE_STATUS_PARTIAL = 'partial';
// WBS 2.12 part 2 item 3, file-local convention (same as ./allocate.ts's own copy, never imported
// cross-file): Allocate leaves an unreserved line's status at 'open'; any PickLine call moves it
// off 'open', so this is the only reliable "never picked" signal on such a line.
const LINE_STATUS_OPEN = 'open';

export interface PickLineInput {
  readonly orderId: string;
  readonly lineId: string;
  readonly expectedVersion: number;
  readonly qtyActual: string;
  readonly varianceReason?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface PickLineResult {
  readonly status: 'picking' | 'picked';
  readonly version: number;
}

/** The line's own entry in the audit row's `new_value.line`. */
interface PickedLineAudit {
  readonly lineId: string;
  readonly status: string;
  readonly qtyOrdered: string;
  readonly qtyActual: string;
  readonly varianceReason: string | null;
}

export async function pickLine(
  ctx: WithContextCtx,
  input: PickLineInput,
  deps: ProcessOutboundDeps,
): Promise<PickLineResult> {
  if (!ctx.userId) throw new MissingActorError('PickLine requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<PickLineResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `PickLine: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    const isFirstLine = canTransition(order.status, OUTBOUND_ORDER_EVENTS.START_PICKING);
    if (!isFirstLine && order.status !== OUTBOUND_ORDER_STATUS.PICKING) {
      throw new IllegalTransitionError(
        `PickLine is illegal from outbound-order status "${order.status}" (the machine allows ` +
          `START_PICKING only from "allocated"/"partially_allocated", or a continuing call while ` +
          `"picking").`,
      );
    }

    const line = await deps.repo.getOrderLineForPick(tx, { lineId: input.lineId, orderId: input.orderId });
    if (!line) {
      // Fix round 1 finding 7: a typed not-found error (422), not a bare Error (500).
      throw new OrderLineNotFoundError(
        `PickLine: no order_lines row ${input.lineId} on order ${input.orderId}.`,
        { lineId: input.lineId, orderId: input.orderId },
      );
    }

    // Fix round 1 finding 2: reject a repeat pick on the same line BEFORE any write. See
    // ../../domain/process-outbound/invariants.ts's assertLineNotAlreadyPicked doc comment for the
    // full set of signals this covers: for a reserved line, a posted pick-movement row OR its own
    // qty_actual already reading 0 (a zero-quantity pick intentionally posts no ledger row —
    // finding 5); for an unreserved line (WBS 2.12 part 2), its own status no longer being 'open'
    // (any PickLine call, including a zero-qty one, moves an unreserved line off 'open').
    const alreadyHasLedgerPick = await deps.repo.hasPickMovementForLine(tx, { lineId: line.lineId });
    const alreadyPicked =
      line.locationId !== null
        ? alreadyHasLedgerPick || Quantity.of(line.reservedQty ?? '0').compare(Quantity.zero()) === 0
        : line.status !== LINE_STATUS_OPEN;
    assertLineNotAlreadyPicked(line.lineId, alreadyPicked);

    // Fix round 1 finding 6: a line with no reservation only accepts qtyActual === 0.
    assertLineReservedForPick({ lineId: line.lineId, locationId: line.locationId, qtyActual: input.qtyActual });

    // Fix round 1 finding 3: qtyActual may never exceed the line's own reserved quantity.
    if (line.locationId !== null) {
      assertPickedWithinReserved({ lineId: line.lineId, reserved: line.reservedQty ?? '0', qtyActual: input.qtyActual });
    }

    // Master decision 2: called BEFORE any write.
    assertVarianceReasonRequired({
      lineId: line.lineId,
      qtyOrdered: line.qtyOrdered,
      qtyActual: input.qtyActual,
      varianceReason: input.varianceReason ?? null,
    });

    if (line.locationId !== null) {
      const batchNo = line.batchNo ?? '';
      const reservedQty = line.reservedQty ?? '0';
      const isZeroPick = Quantity.of(input.qtyActual).compare(Quantity.zero()) === 0;
      // Fix round 1 finding 5: a zero-quantity pick posts no ledger row (the DB's own qty_not_zero
      // CHECK would reject it as a raw 500; postMovementInTx's own validateEntry would reject it
      // just as hard) — release the reservation and skip the ledger write entirely.
      if (!isZeroPick) {
        await deps.ledger.postPick(
          tx,
          {
            entityId: order.entityId,
            clientId: order.clientId,
            skuId: line.skuId,
            fromLocationId: line.locationId,
            qty: input.qtyActual,
            uom: line.uom,
            batchNo,
            lineId: line.lineId,
            correlationId: input.correlationId,
          },
          actorId,
          deps,
        );
      }
      // Fix round 1 finding 4: release the FULL reserved quantity from qty_allocated regardless of
      // how much was actually picked (a shortage reverses the earlier soft reservation
      // permanently) — qty_on_hand above was only decremented by the actually-picked amount (the
      // ledger call, skipped entirely on a zero pick).
      await deps.repo.decrementLotAllocated(tx, {
        clientId: order.clientId,
        skuId: line.skuId,
        locationId: line.locationId,
        batchNo,
        qty: reservedQty,
      });
    }

    const lineStatus =
      Quantity.of(input.qtyActual).compare(Quantity.of(line.qtyOrdered)) === 0 ? LINE_STATUS_COMPLETE : LINE_STATUS_PARTIAL;
    const varianceReason = lineStatus === LINE_STATUS_COMPLETE ? null : (input.varianceReason ?? null);

    const occurredAt = deps.clock.now();

    await deps.repo.updateOrderLinePick(tx, {
      lineId: line.lineId,
      status: lineStatus,
      qtyActual: input.qtyActual,
      varianceReason,
      pickedBy: actorId,
      pickedAt: occurredAt,
    });

    let newStatus = order.status;
    if (isFirstLine) {
      newStatus = advanceOutboundOrder(newStatus, [OUTBOUND_ORDER_EVENTS.START_PICKING]);
    }

    const openLinesRemaining = await deps.repo.countOpenPickLines(tx, input.orderId);
    const orderCompletes = openLinesRemaining === 0;
    if (orderCompletes) {
      newStatus = advanceOutboundOrder(newStatus, [OUTBOUND_ORDER_EVENTS.COMPLETE_PICKING]);
    }

    const newVersion = await deps.repo.updateOrder(tx, input.orderId, {
      status: newStatus,
      ...(orderCompletes ? { pickedBy: actorId } : {}),
    });

    const eventType = orderCompletes ? OUTBOUND_PICKED_EVENT : isFirstLine ? OUTBOUND_PICKING_STARTED_EVENT : undefined;
    if (eventType) {
      await writeOutboxEvent(tx, {
        entityId: order.entityId,
        aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
        aggregateId: input.orderId,
        eventType,
        payload: { orderId: input.orderId, status: newStatus },
        correlationId: input.correlationId,
        actorId,
      });
    }

    const lineAudit: PickedLineAudit = {
      lineId: line.lineId,
      status: lineStatus,
      qtyOrdered: line.qtyOrdered,
      qtyActual: input.qtyActual,
      varianceReason,
    };

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_PICK,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, line: lineAudit },
      occurredAt,
    });

    return { status: orderCompletes ? 'picked' : 'picking', version: newVersion };
  });
}
