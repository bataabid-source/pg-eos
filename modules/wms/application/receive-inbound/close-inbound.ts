// modules/wms/application/receive-inbound/close-inbound.ts — WBS 2.9, THE GOLDEN SLICE.
//
// Master ruling , doc 40 §C3 lines 262/264): the GRN document and
// 'wms.inbound.received' event are written when the order reaches 'received' (see
// ./receive-line.ts) — CloseInbound ONLY closes: status, closed_at, closed_by, and its own audit
// row. No document, no outbox event here.
//
// Lock order (step 0 — see ../../../../packages/db/src/idempotency.ts — runs first when
// input.idem is set): (1) order-row lock + expectedVersion check, (2) role gate, (3)
// CloseBlockedError business-rule gate (any line still open), (4) machine legality check (via
// canTransition), (5) the unconditional version bump with closed_at/closed_by, (6) audit row
// (last).
//
// Legality comes from the machine ONLY (SCR-WMS-INB-01 §1): CLOSE is legal from 'putaway' ONLY —
// there is no 'received' -> CLOSE edge; a fully-short order (every line qty_actual = 0) is
// CANCELLED instead, see ./cancel-inbound.ts. Whether an order in 'putaway' MAY close is then the
// separate business rule below: no line may still be open.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { INBOUND_EVENT_ROLES, INBOUND_ORDER_EVENTS, advanceInboundOrder, canTransition } from '../../domain/receive-inbound/machine.js';
import { CloseBlockedError, IllegalTransitionError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/receive-inbound/errors.js';
import type { ReceiveInboundDeps } from './ports.js';

const AUDIT_OPERATION_CLOSE = 'update';

export interface CloseInboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CloseInboundResult {
  readonly status: 'closed';
  readonly version: number;
}

export async function closeInbound(
  ctx: WithContextCtx,
  input: CloseInboundInput,
  deps: ReceiveInboundDeps,
): Promise<CloseInboundResult> {
  if (!ctx.userId) throw new MissingActorError('CloseInbound requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CloseInboundResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `CloseInbound: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    const requiredRole = INBOUND_EVENT_ROLES[INBOUND_ORDER_EVENTS.CLOSE];
    if (requiredRole && !(await deps.repo.hasRole(tx, requiredRole))) {
      throw new RoleRequiredError(`CloseInbound requires role ${requiredRole} (platform.my_roles()).`);
    }

    if (!canTransition(order.status, INBOUND_ORDER_EVENTS.CLOSE)) {
      throw new IllegalTransitionError(
        `CloseInbound is illegal from status "${order.status}" (the machine allows CLOSE only from ` +
          `"putaway").`,
      );
    }

    if (await deps.repo.hasBlockingOpenLines(tx, input.orderId)) {
      throw new CloseBlockedError(
        `CloseInbound refused: order ${input.orderId} still has a line that is neither ` +
          `status='complete' with a location_id (or qty_actual=0), nor status='cancelled'.`,
      );
    }

    const newStatus = advanceInboundOrder(order.status, [INBOUND_ORDER_EVENTS.CLOSE]);

    const closedAt = deps.clock.now();
    const newVersion = await deps.repo.updateOrder(tx, input.orderId, {
      status: newStatus,
      closedAt,
      closedBy: actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_CLOSE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, closedAt: closedAt.toISOString(), closedBy: actorId },
      occurredAt: closedAt,
    });

    return { status: 'closed', version: newVersion };
  });
}
