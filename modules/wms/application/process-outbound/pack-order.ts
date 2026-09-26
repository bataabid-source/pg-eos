// modules/wms/application/process-outbound/pack-order.ts — WBS 2.12 part 4
// (_slice-2.12.brief.md), following ./check-order.ts's own exact shape.
//
// ORDER-LEVEL command ('checked' -> 'packed'), version-lock. ONE withIdempotentContext transaction.
// Lock order: (1) order-row lock + expectedVersion check, (2) the machine's own legality check
// (PACK must be legal from the order's current status — only 'checked' — BEFORE any write); (3)
// packed_by = ctx.userId, status 'packed'; (4) the unconditional version bump; (5) the outbox event
// ('wms.outbound.packed') + the audit row, same correlation_id (last, ADR-0002). No invariant beyond
// the machine's own legality check (brief Scope: row 7 names none).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent } from '@pg-eos/events';

import { OUTBOUND_ORDER_EVENTS, advanceOutboundOrder, canTransition } from '../../domain/process-outbound/machine.js';
import { IllegalTransitionError, MissingActorError, StaleVersionError } from '../../domain/process-outbound/errors.js';
import type { ProcessOutboundDeps } from './ports.js';

const AUDIT_OPERATION_PACK = 'update';
const OUTBOUND_PACKED_EVENT = 'wms.outbound.packed';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';

export interface PackOrderInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface PackOrderResult {
  readonly status: 'packed';
  readonly version: number;
}

export async function packOrder(
  ctx: WithContextCtx,
  input: PackOrderInput,
  deps: ProcessOutboundDeps,
): Promise<PackOrderResult> {
  if (!ctx.userId) throw new MissingActorError('PackOrder requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<PackOrderResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `PackOrder: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    if (!canTransition(order.status, OUTBOUND_ORDER_EVENTS.PACK)) {
      throw new IllegalTransitionError(
        `PackOrder is illegal from outbound-order status "${order.status}" (the machine allows it ` +
          `only from "checked").`,
      );
    }

    const newStatus = advanceOutboundOrder(order.status, [OUTBOUND_ORDER_EVENTS.PACK]);
    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus, packedBy: actorId });
    const occurredAt = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: OUTBOUND_PACKED_EVENT,
      payload: { orderId: input.orderId, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_PACK,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, packedBy: actorId },
      occurredAt,
    });

    return { status: 'packed', version: newVersion };
  });
}
