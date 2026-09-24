// modules/wms/application/receive-inbound/cancel-inbound.ts — WBS 2.9, THE GOLDEN SLICE.
//
// application/ layer, ONE withContext transaction. Lock order: (1) order-row lock + expectedVersion
// check, (2) role gate, (3) machine legality check (CancelBlockedError, the domain-specific name
// for "CANCEL is not legal from this status" via canTransition, no if on the status string),
// (4) unconditional version bump, (5) audit row (last).
//
// Every command takes the same injected ReceiveInboundDeps (clock, ids) — occurred_at always comes
// from the injected clock, never a bare `new Date()`.

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { INBOUND_EVENT_ROLES, INBOUND_ORDER_EVENTS, advanceInboundOrder, canTransition } from '../../domain/receive-inbound/machine.js';
import { CancelBlockedError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/receive-inbound/errors.js';
import type { ReceiveInboundDeps } from './ports.js';

const AUDIT_OPERATION_CANCEL = 'update';

export interface CancelInboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly reason?: string | undefined;
}

export interface CancelInboundResult {
  readonly status: 'cancelled';
  readonly version: number;
}

export async function cancelInbound(
  ctx: WithContextCtx,
  input: CancelInboundInput,
  deps: ReceiveInboundDeps,
): Promise<CancelInboundResult> {
  if (!ctx.userId) throw new MissingActorError('CancelInbound requires ctx.userId.');
  const actorId = ctx.userId;

  return withContext(ctx, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `CancelInbound: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    const requiredRole = INBOUND_EVENT_ROLES[INBOUND_ORDER_EVENTS.CANCEL];
    if (requiredRole && !(await deps.repo.hasRole(tx, requiredRole))) {
      throw new RoleRequiredError(`CancelInbound requires role ${requiredRole} (platform.my_roles()).`);
    }

    if (!canTransition(order.status, INBOUND_ORDER_EVENTS.CANCEL)) {
      throw new CancelBlockedError(
        `CancelInbound refused: order ${input.orderId} is in status "${order.status}" — a line has ` +
          `already been received (legal only from "draft"/"approved").`,
      );
    }
    const newStatus = advanceInboundOrder(order.status, [INBOUND_ORDER_EVENTS.CANCEL]);

    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_CANCEL,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, reason: input.reason ?? null },
      occurredAt: deps.clock.now(),
    });

    return { status: 'cancelled', version: newVersion };
  });
}
