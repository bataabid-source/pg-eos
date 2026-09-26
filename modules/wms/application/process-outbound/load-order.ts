// modules/wms/application/process-outbound/load-order.ts — WBS 2.12 part 4
// (_slice-2.12.brief.md), following ./pack-order.ts's own exact shape.
//
// ORDER-LEVEL command ('packed' -> 'loaded'), version-lock. ONE withIdempotentContext transaction.
// Lock order: (1) order-row lock + expectedVersion check, (2) the machine's own legality check
// (LOAD must be legal from the order's current status — only 'packed' — BEFORE any write); (3)
// status 'loaded' — NO new actor-stamp column (SCR-WMS-OUT-04: the D-blueprint names none for this
// step, so none is invented); (4) the unconditional version bump; (5) the outbox event
// ('wms.outbound.loaded') + the audit row, same correlation_id (last, ADR-0002). No invariant beyond
// the machine's own legality check; no cross-order/manifest check (SCR-WMS-OUT-04 §3, deferred).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent } from '@pg-eos/events';

import { OUTBOUND_ORDER_EVENTS, advanceOutboundOrder, canTransition } from '../../domain/process-outbound/machine.js';
import { IllegalTransitionError, MissingActorError, StaleVersionError } from '../../domain/process-outbound/errors.js';
import type { ProcessOutboundDeps } from './ports.js';

const AUDIT_OPERATION_LOAD = 'update';
const OUTBOUND_LOADED_EVENT = 'wms.outbound.loaded';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';

export interface LoadOrderInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface LoadOrderResult {
  readonly status: 'loaded';
  readonly version: number;
}

export async function loadOrder(
  ctx: WithContextCtx,
  input: LoadOrderInput,
  deps: ProcessOutboundDeps,
): Promise<LoadOrderResult> {
  if (!ctx.userId) throw new MissingActorError('LoadOrder requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<LoadOrderResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `LoadOrder: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    if (!canTransition(order.status, OUTBOUND_ORDER_EVENTS.LOAD)) {
      throw new IllegalTransitionError(
        `LoadOrder is illegal from outbound-order status "${order.status}" (the machine allows it ` +
          `only from "packed").`,
      );
    }

    const newStatus = advanceOutboundOrder(order.status, [OUTBOUND_ORDER_EVENTS.LOAD]);
    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus });
    const occurredAt = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: OUTBOUND_LOADED_EVENT,
      payload: { orderId: input.orderId, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_LOAD,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion },
      occurredAt,
    });

    return { status: 'loaded', version: newVersion };
  });
}
