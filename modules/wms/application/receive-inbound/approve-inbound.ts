// modules/wms/application/receive-inbound/approve-inbound.ts — WBS 2.9, THE GOLDEN SLICE.
//
// application/ layer, ONE withContext transaction. Lock order (full rationale in
// ../../infrastructure/receive-inbound/repository.ts's own header): (1) order-row lock +
// expectedVersion check, (2) the role gate, (3) the machine's legality check (via
// canTransition, never an if on the status string), (4) the unconditional version bump, (5)
// the audit row (last).

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { INBOUND_EVENT_ROLES, INBOUND_ORDER_EVENTS, advanceInboundOrder } from '../../domain/receive-inbound/machine.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/receive-inbound/errors.js';
import type { ReceiveInboundDeps } from './ports.js';

const AUDIT_OPERATION_APPROVE = 'approve';

export interface ApproveInboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
}

export interface ApproveInboundResult {
  readonly status: 'approved';
  readonly version: number;
}

export async function approveInbound(
  ctx: WithContextCtx,
  input: ApproveInboundInput,
  deps: ReceiveInboundDeps,
): Promise<ApproveInboundResult> {
  if (!ctx.userId) throw new MissingActorError('ApproveInbound requires ctx.userId.');
  const actorId = ctx.userId;

  return withContext(ctx, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ApproveInbound: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    const requiredRole = INBOUND_EVENT_ROLES[INBOUND_ORDER_EVENTS.APPROVE];
    if (requiredRole && !(await deps.repo.hasRole(tx, requiredRole))) {
      throw new RoleRequiredError(`ApproveInbound requires role ${requiredRole} (platform.my_roles()).`);
    }

    // no if on the status string — advanceInboundOrder asks the machine and THROWS
    // IllegalTransitionError itself when APPROVE is not legal from `order.status`.
    const newStatus = advanceInboundOrder(order.status, [INBOUND_ORDER_EVENTS.APPROVE]);

    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_APPROVE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { status: 'approved', version: newVersion };
  });
}
