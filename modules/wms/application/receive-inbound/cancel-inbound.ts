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
// line was received at qty_actual = 0, (4b) WBS 2.9b (D3): `cancelReason` is now MANDATORY (min
// length 1) — checked via the shared isNonEmptyReason predicate
// (../../domain/schedule-inbound/invariants.ts — recorded default, no shared home for this
// predicate exists in this slice's Write ONLY list, see that file's own header), thrown as
// ../../domain/schedule-inbound/errors.ts's CancelReasonRequiredError (round-1 review finding 7 —
// moved there from this file to match golden-slice doctrine), BEFORE any write, (5) unconditional
// version bump, (6)
// `cancel_reason` persisted via deps.repo.updateOrderCancelReason (round-1 review finding 2 — the
// port method the Master widened this file's lock to add, replacing the prior raw `tx.execute()`
// UPDATE; the port call does not touch `version` a second time), (7)
// `wms.inbound.cancelled` written to platform.outbox in the SAME transaction, (8) audit row
// (last).
//
// Every command takes the same injected ReceiveInboundDeps (clock, ids) — occurred_at always comes
// from the injected clock, never a bare `new Date()`.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { INBOUND_EVENT_ROLES, INBOUND_ORDER_EVENTS, advanceInboundOrder, canTransition } from '../../domain/receive-inbound/machine.js';
import { CancelBlockedError, IllegalTransitionError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/receive-inbound/errors.js';
import { isNonEmptyReason } from '../../domain/schedule-inbound/invariants.js';
import { CancelReasonRequiredError } from '../../domain/schedule-inbound/errors.js';
import type { ReceiveInboundDeps } from './ports.js';

const AUDIT_OPERATION_CANCEL = 'update';
const INBOUND_ORDERS_AGGREGATE_TYPE = 'wms.inbound_orders';
const CANCELLED_EVENT_TYPE: CatalogedEventType = 'wms.inbound.cancelled';

export interface CancelInboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly cancelReason: string;
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

    // WBS 2.9b (D3): cancelReason is now mandatory — checked BEFORE any write.
    if (!isNonEmptyReason(input.cancelReason)) {
      throw new CancelReasonRequiredError(
        `CancelInbound requires a non-empty cancelReason. (Allowed: a string of length >= 1)`,
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
    const occurredAt = deps.clock.now();

    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus });

    // WBS 2.9b (D3): cancel_reason persisted via the port (round-1 review finding 2) — no version
    // increment here (the bump already happened above).
    await deps.repo.updateOrderCancelReason(tx, input.orderId, input.cancelReason);

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: INBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: CANCELLED_EVENT_TYPE,
      payload: { orderId: input.orderId, status: newStatus, cancelReason: input.cancelReason },
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
      newValue: { status: newStatus, version: newVersion, cancelReason: input.cancelReason },
      occurredAt,
    });

    return { status: 'cancelled', version: newVersion };
  });
}
