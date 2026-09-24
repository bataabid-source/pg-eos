// modules/wms/application/receive-inbound/cancel-inbound.ts — WBS 2.9, THE GOLDEN SLICE.
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs before any lock below when input.idem is
// set). Lock order, split the same way as ./close-inbound.ts: (1) order-row lock +
// expectedVersion check, (2) role gate, (3) machine legality check (IllegalTransitionError via
// canTransition, no if on the status string — the machine allows CANCEL only from 'draft',
// 'approved' or 'received', SCR-WMS-INB-01 §1/§3), (4) the order's own business rule
// (CancelBlockedError): refused if any line already has qty_actual > 0 (stock physically moved)
// — the one order that legitimately reaches 'received' with CANCEL still legal is one whose every
// line was received at qty_actual = 0, (5) unconditional version bump, (6) audit row (last).
//
// Every command takes the same injected ReceiveInboundDeps (clock, ids) — occurred_at always comes
// from the injected clock, never a bare `new Date()`.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { INBOUND_EVENT_ROLES, INBOUND_ORDER_EVENTS, advanceInboundOrder, canTransition } from '../../domain/receive-inbound/machine.js';
import { CancelBlockedError, IllegalTransitionError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/receive-inbound/errors.js';
import type { ReceiveInboundDeps } from './ports.js';

const AUDIT_OPERATION_CANCEL = 'update';

export interface CancelInboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly reason?: string | undefined;
  readonly idem?: IdempotencyInput | undefined;
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

  return withIdempotentContext<CancelInboundResult>(ctx, input.idem, async (tx) => {
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
      throw new IllegalTransitionError(
        `CancelInbound is illegal from status "${order.status}" (the machine allows CANCEL only ` +
          `from "draft", "approved" or "received").`,
      );
    }

    // Refused once ANY line has physically received stock (qty_actual > 0), regardless of the
    // order's own status — SCR-WMS-INB-01 §1/§3.
    if (await deps.repo.hasPhysicallyReceivedLines(tx, input.orderId)) {
      throw new CancelBlockedError(
        `CancelInbound refused: order ${input.orderId} has at least one line with qty_actual > 0 ` +
          `— stock has physically moved. (Allowed: cancel only while every line's qty_actual is 0 ` +
          `or unset)`,
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
