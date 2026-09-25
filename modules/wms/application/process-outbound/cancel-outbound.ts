// modules/wms/application/process-outbound/cancel-outbound.ts — WBS 2.11 part 1, following
// ../../application/receive-inbound/cancel-inbound.ts (golden slice).
//
// ONE withIdempotentContext transaction. Lock order: (1) order-row lock + expectedVersion check,
// (2) role gate (WH_MGR), (3) reason-required gate (before any further check — brief scenario
// "CancelOutbound without a reason is rejected... before any write"), (4) the machine's legality
// check (brief Master decision 5: legal ONLY from {draft, checks_pending, credit_rejected,
// approved} — the four statuses this part can reach; IllegalTransitionError from any other status,
// including part 2's `allocated`/`partially_allocated`, which have no CANCEL edge in this part's
// machine), (5) the unconditional version bump, (6) the outbox event ('wms.outbound.cancelled'),
// (7) the audit row (last, ADR-0002). No stock to release at this part's statuses (brief: nothing
// has been allocated yet).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { OUTBOUND_EVENT_ROLES, OUTBOUND_ORDER_EVENTS, advanceOutboundOrder } from '../../domain/process-outbound/machine.js';
import { CancelReasonRequiredError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/process-outbound/errors.js';
import type { ProcessOutboundDeps } from './ports.js';

const AUDIT_OPERATION_CANCEL = 'update';
const OUTBOUND_CANCELLED_EVENT: CatalogedEventType = 'wms.outbound.cancelled';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';

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

    const newStatus = advanceOutboundOrder(order.status, [OUTBOUND_ORDER_EVENTS.CANCEL]);

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
      newValue: { status: newStatus, version: newVersion, reason: input.reason },
      occurredAt,
    });

    return { status: 'cancelled', version: newVersion };
  });
}
