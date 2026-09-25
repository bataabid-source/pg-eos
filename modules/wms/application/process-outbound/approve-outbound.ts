// modules/wms/application/process-outbound/approve-outbound.ts — WBS 2.11 part 1, following
// ../../application/receive-inbound/approve-inbound.ts (golden slice).
//
// ONE withIdempotentContext transaction. Lock order: (1) order-row lock + expectedVersion check,
// (2) role gate (WH_MGR), (3) the machine's legality check (checks_pending -> approved), (4) the
// unconditional version bump, (5) the outbox event ('wms.outbound.approved'), (6) the audit row
// (last, ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { OUTBOUND_EVENT_ROLES, OUTBOUND_ORDER_EVENTS, advanceOutboundOrder } from '../../domain/process-outbound/machine.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/process-outbound/errors.js';
import type { ProcessOutboundDeps } from './ports.js';

const AUDIT_OPERATION_APPROVE = 'approve';
const OUTBOUND_APPROVED_EVENT: CatalogedEventType = 'wms.outbound.approved';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';

export interface ApproveOutboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ApproveOutboundResult {
  readonly status: 'approved';
  readonly version: number;
}

export async function approveOutbound(
  ctx: WithContextCtx,
  input: ApproveOutboundInput,
  deps: ProcessOutboundDeps,
): Promise<ApproveOutboundResult> {
  if (!ctx.userId) throw new MissingActorError('ApproveOutbound requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ApproveOutboundResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ApproveOutbound: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    const requiredRole = OUTBOUND_EVENT_ROLES[OUTBOUND_ORDER_EVENTS.APPROVE];
    if (requiredRole && !(await deps.repo.hasRole(tx, requiredRole))) {
      throw new RoleRequiredError(`ApproveOutbound requires role ${requiredRole} (platform.my_roles()).`);
    }

    // no if on the status string — advanceOutboundOrder asks the machine and THROWS
    // IllegalTransitionError itself when APPROVE is not legal from `order.status`.
    const newStatus = advanceOutboundOrder(order.status, [OUTBOUND_ORDER_EVENTS.APPROVE]);

    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus });
    const occurredAt = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: OUTBOUND_APPROVED_EVENT,
      payload: { orderId: input.orderId, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_APPROVE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion },
      occurredAt,
    });

    return { status: 'approved', version: newVersion };
  });
}
