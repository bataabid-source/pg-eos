// modules/wms/application/process-outbound/check-order.ts — WBS 2.12 part 1
// (_slice-2.12.brief.md), following ./cancel-outbound.ts's own shape.
//
// ORDER-LEVEL command ('picked' -> 'checked'), version-lock. ONE withIdempotentContext transaction.
// Lock order: (1) order-row lock + expectedVersion check, (2) the machine's own legality check
// (CHECK must be legal from the order's current status — only 'picked' — BEFORE any write), (3)
// MANDATORY invariant: assertCheckerNotPicker (doc 38 row 2.12's own literal acceptance line
// "Self-check rejected") — BEFORE any write, order stays 'picked'; (4) checked_by = ctx.userId,
// status 'checked'; (5) the unconditional version bump; (6) the outbox event
// ('wms.outbound.checked') + the audit row, same correlation_id (last, ADR-0002). No OF-01…OF-11
// document generation this part (Scope, deferred). platform.audit_log is never read.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent } from '@pg-eos/events';

import { OUTBOUND_ORDER_EVENTS, advanceOutboundOrder, canTransition } from '../../domain/process-outbound/machine.js';
import { IllegalTransitionError, MissingActorError, StaleVersionError } from '../../domain/process-outbound/errors.js';
import { assertCheckerNotPicker } from '../../domain/process-outbound/invariants.js';
import type { ProcessOutboundDeps } from './ports.js';

const AUDIT_OPERATION_CHECK = 'update';
const OUTBOUND_CHECKED_EVENT = 'wms.outbound.checked';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';

export interface CheckOrderInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CheckOrderResult {
  readonly status: 'checked';
  readonly version: number;
}

export async function checkOrder(
  ctx: WithContextCtx,
  input: CheckOrderInput,
  deps: ProcessOutboundDeps,
): Promise<CheckOrderResult> {
  if (!ctx.userId) throw new MissingActorError('CheckOrder requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CheckOrderResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `CheckOrder: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    if (!canTransition(order.status, OUTBOUND_ORDER_EVENTS.CHECK)) {
      throw new IllegalTransitionError(
        `CheckOrder is illegal from outbound-order status "${order.status}" (the machine allows it ` +
          `only from "picked").`,
      );
    }

    if (order.pickedBy === null) {
      throw new Error(`CheckOrder: order ${input.orderId} is "picked" but picked_by is null (data invariant violated).`);
    }

    // WBS 2.12 part 2 item 4 (Master-ruled widening, strictly broader than the literal wording,
    // which named only the pick-movement check): `wasPicker` is `picked_by` OR any posted pick
    // movement's `performed_by` on this order. This still leaves a residual gap out of this part's
    // fix scope: a picker whose ONLY action was a zero-qty pick on a line OTHER than the last one
    // picked posts no ledger row and is not `picked_by` either, so today they pass self-check on
    // neither check. Closing that would need a different signal (e.g. platform.audit_log's
    // PickLine actors) — a Master/GM call, not decided here.
    const wasPicker =
      actorId === order.pickedBy || (await deps.repo.hasPickMovementByActor(tx, { orderId: input.orderId, actorId }));

    // Doc 38 row 2.12's own literal acceptance line "Self-check rejected" — BEFORE any write.
    assertCheckerNotPicker({ orderId: input.orderId, checkerId: actorId, wasPicker });

    const newStatus = advanceOutboundOrder(order.status, [OUTBOUND_ORDER_EVENTS.CHECK]);
    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus, checkedBy: actorId });
    const occurredAt = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: OUTBOUND_CHECKED_EVENT,
      payload: { orderId: input.orderId, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_CHECK,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, checkedBy: actorId },
      occurredAt,
    });

    return { status: 'checked', version: newVersion };
  });
}
