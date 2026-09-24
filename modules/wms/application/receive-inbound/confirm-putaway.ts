// modules/wms/application/receive-inbound/confirm-putaway.ts — WBS 2.9, THE GOLDEN SLICE.
//
// ONE withContext transaction. Lock order (full rationale in
// ../../infrastructure/receive-inbound/repository.ts's own header): (1) order-row lock +
// expectedVersion check; (2) line-row lock, bound to the order; (3) re-entry guard on the
// locked line (status <> 'complete' AND location_id IS NULL) -> LineAlreadyPutAwayError, BEFORE
// any ledger post; (4) the line write; (5) the reused ledger port's own advisory locks (INV-C3-4
// inherited, unmodified, from WBS 2.4); (6) the unconditional version bump; (7) audit row
// (last).
//
// Re-validates `toLocationId` itself (does not trust SuggestLocation's own output) — enforced by
// the ledger port's postPutawayTransfer.

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { INBOUND_ORDER_EVENTS, advanceInboundOrder, canTransition } from '../../domain/receive-inbound/machine.js';
import { LineAlreadyPutAwayError, MissingActorError, RcvBalanceMissingError, StaleVersionError } from '../../domain/receive-inbound/errors.js';
import type { ReceiveInboundDeps } from './ports.js';

const LINE_STATUS_COMPLETE = 'complete';
const AUDIT_OPERATION_CONFIRM_PUTAWAY = 'update';

export interface ConfirmPutawayInput {
  readonly orderId: string;
  readonly lineId: string;
  readonly toLocationId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
}

export interface ConfirmPutawayResult {
  readonly orderStatus: string;
  readonly lineStatus: string;
}

export async function confirmPutaway(
  ctx: WithContextCtx,
  input: ConfirmPutawayInput,
  deps: ReceiveInboundDeps,
): Promise<ConfirmPutawayResult> {
  if (!ctx.userId) throw new MissingActorError('ConfirmPutaway requires ctx.userId.');
  const actorId = ctx.userId;

  return withContext(ctx, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ConfirmPutaway: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    const line = await deps.repo.getOrderLineForUpdate(tx, input.orderId, input.lineId);
    if (line.status === LINE_STATUS_COMPLETE || line.locationId !== null) {
      throw new LineAlreadyPutAwayError(
        `order line ${input.lineId} is already put away (re-entry guard).`,
      );
    }
    if (line.qtyActual === null) {
      throw new RcvBalanceMissingError(
        `order line ${input.lineId} has no qty_actual yet — ReceiveLine must run first.`,
      );
    }

    // The put-away's own event: CONFIRM_PUTAWAY_FIRST from 'received', CONFIRM_PUTAWAY on
    // 'putaway'. Legality and the next status come from the machine alone; an illegal status
    // throws here, before any write.
    const putawayEvent = canTransition(order.status, INBOUND_ORDER_EVENTS.CONFIRM_PUTAWAY_FIRST)
      ? INBOUND_ORDER_EVENTS.CONFIRM_PUTAWAY_FIRST
      : INBOUND_ORDER_EVENTS.CONFIRM_PUTAWAY;
    const finalStatus = advanceInboundOrder(order.status, [putawayEvent]);

    const rcvLocation = await deps.repo.findRcvBalanceLocation(tx, {
      warehouseId: order.warehouseId,
      clientId: order.clientId,
      skuId: line.skuId,
      batchNo: line.batchNo ?? '',
    });
    if (rcvLocation === null) {
      throw new RcvBalanceMissingError(
        `no positive RCV balance for line ${input.lineId} (client ${order.clientId}, sku ${line.skuId}) ` +
          `— ReceiveLine must post a receipt before ConfirmPutaway is called.`,
      );
    }

    const lineUpdated = await deps.repo.updateLineLocation(tx, {
      lineId: input.lineId,
      locationId: input.toLocationId,
      status: LINE_STATUS_COMPLETE,
    });
    if (!lineUpdated) {
      throw new LineAlreadyPutAwayError(
        `order line ${input.lineId} was put away concurrently (atomic guard).`,
      );
    }

    // INV-C3-4 inherited, unmodified, from WBS 2.4: over-weight/volume or a blocked destination
    // throws before either ledger leg is written, rolling back this WHOLE transaction — the line
    // write above rolls back with it.
    await deps.ledger.postPutawayTransfer(
      tx,
      {
        entityId: order.entityId,
        clientId: order.clientId,
        skuId: line.skuId,
        qty: line.qtyActual,
        batchNo: line.batchNo ?? '',
        uom: line.uom,
        fromLocationId: rcvLocation.id,
        toLocationId: input.toLocationId,
        correlationId: input.correlationId,
        refId: input.orderId,
      },
      actorId,
      deps,
    );

    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: finalStatus });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'line',
      recordId: input.lineId,
      operation: AUDIT_OPERATION_CONFIRM_PUTAWAY,
      correlationId: input.correlationId,
      actorId,
      newValue: { locationId: input.toLocationId, lineStatus: LINE_STATUS_COMPLETE, orderStatus: finalStatus, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { orderStatus: finalStatus, lineStatus: LINE_STATUS_COMPLETE };
  });
}

