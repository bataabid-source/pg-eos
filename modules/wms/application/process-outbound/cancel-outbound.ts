// modules/wms/application/process-outbound/cancel-outbound.ts — WBS 2.11 part 1, following
// ../../application/receive-inbound/cancel-inbound.ts (golden slice).
//
// ONE withIdempotentContext transaction. Lock order: (1) order-row lock + expectedVersion check,
// (2) role gate (WH_MGR), (3) reason-required gate (before any further check — brief scenario
// "CancelOutbound without a reason is rejected... before any write"), (4) the machine's legality
// check — part 1's own {draft, checks_pending, credit_rejected, approved} PLUS part 2's own
// {allocated, partially_allocated} (brief Master decision 1/4: the CANCEL edge now reaches six
// statuses total); IllegalTransitionError from any other status, (5) WBS 2.11 part 2's OWN release
// step (Master decision 4), run ONLY when the machine just accepted CANCEL from `allocated`/
// `partially_allocated`: for every order_lines row on this order with a non-null location_id (the
// SINGLE lot Allocate reserved for that line — single-lot rule), decrement that one
// wms.stock_balance row's qty_allocated by the line's qty_actual (UPDATE, same shape as
// Allocate's own increment, reversed) — BEFORE the status flip, same transaction, (6) the
// unconditional version bump, (7) the outbox event ('wms.outbound.cancelled', already cataloged),
// (8) the audit row (last, ADR-0002), whose `released` entries carry each released line's
// locationId/batchNo/qty (doc 40 §A1 P7; empty when nothing was released). No release step at
// part 1's own four statuses (brief: nothing has been allocated yet there). platform.audit_log is
// never read.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { OUTBOUND_EVENT_ROLES, OUTBOUND_ORDER_EVENTS, OUTBOUND_ORDER_STATUS, advanceOutboundOrder } from '../../domain/process-outbound/machine.js';
import { CancelReasonRequiredError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/process-outbound/errors.js';
import type { ProcessOutboundDeps } from './ports.js';

// WBS 2.11 part 2 (Master decision 4): the two source statuses whose CANCEL now releases a
// reservation — every other legal CANCEL source (part 1's own four) never allocated anything.
const RELEASE_ON_CANCEL_STATUSES: ReadonlySet<string> = new Set([
  OUTBOUND_ORDER_STATUS.ALLOCATED,
  OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED,
]);

const AUDIT_OPERATION_CANCEL = 'update';
const OUTBOUND_CANCELLED_EVENT: CatalogedEventType = 'wms.outbound.cancelled';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';

/** One released line in the audit row's `new_value.released` — sourced from the order_lines row
 *  whose reservation was released (doc 40 §A1 P7). */
interface ReleasedLineAudit {
  readonly lineId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly qty: string;
}

export interface CancelOutboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly reason?: string | undefined;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CancelOutboundResult {
  readonly status: 'cancelled';
  readonly version: number;
}

export async function cancelOutbound(
  ctx: WithContextCtx,
  input: CancelOutboundInput,
  deps: ProcessOutboundDeps,
): Promise<CancelOutboundResult> {
  if (!ctx.userId) throw new MissingActorError('CancelOutbound requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CancelOutboundResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `CancelOutbound: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    const requiredRole = OUTBOUND_EVENT_ROLES[OUTBOUND_ORDER_EVENTS.CANCEL];
    if (requiredRole && !(await deps.repo.hasRole(tx, requiredRole))) {
      throw new RoleRequiredError(`CancelOutbound requires role ${requiredRole} (platform.my_roles()).`);
    }

    if (!input.reason || input.reason.trim().length === 0) {
      throw new CancelReasonRequiredError('CancelOutbound requires a non-empty reason.');
    }

    const releaseRequired = RELEASE_ON_CANCEL_STATUSES.has(order.status);
    const newStatus = advanceOutboundOrder(order.status, [OUTBOUND_ORDER_EVENTS.CANCEL]);

    const released: ReleasedLineAudit[] = [];
    if (releaseRequired) {
      const reservedLines = await deps.repo.getConsumedLinesForRelease(tx, input.orderId);
      for (const line of reservedLines) {
        await deps.repo.decrementLotAllocated(tx, {
          clientId: order.clientId,
          skuId: line.skuId,
          locationId: line.locationId,
          batchNo: line.batchNo,
          qty: line.qtyActual,
        });
        released.push({ lineId: line.lineId, locationId: line.locationId, batchNo: line.batchNo, qty: line.qtyActual });
      }
    }

    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus });
    const occurredAt = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: OUTBOUND_CANCELLED_EVENT,
      payload: { orderId: input.orderId, status: newStatus, reason: input.reason },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_CANCEL,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, reason: input.reason, released },
      occurredAt,
    });

    return { status: 'cancelled', version: newVersion };
  });
}
