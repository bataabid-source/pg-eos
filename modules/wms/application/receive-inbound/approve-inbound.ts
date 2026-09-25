// modules/wms/application/receive-inbound/approve-inbound.ts — WBS 2.9, THE GOLDEN SLICE.
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set). Lock order
// (full rationale in ../../infrastructure/receive-inbound/repository.ts's own header): (1)
// order-row lock + expectedVersion check, (2) the role gate, (3) the machine's legality check
// (via canTransition, never an if on the status string), (4) the unconditional version bump, (5)
// WBS 2.9b (D2, docs/notes/slice-briefs/_slice-2.9b.brief.md): IF `input.expectedAt` is present,
// the ScheduleInbound-style domain pre-checks (isFutureTimestamp/isValidVehicleType) run, then the
// same nine ScheduleInbound-shaped columns (expected_at/scheduled_by/scheduled_at/dock_code/
// handover_point/transport_by/vehicle_type/labour_by/labour_count) are written via
// deps.repo.updateOrderScheduleAndTerms (round-1 review finding 2 — the port method the Master
// widened this file's lock to add, replacing the prior raw `tx.execute()` UPDATE) and NOT
// incrementing `version` a second time (the version bump already happened in step 4; this UPDATE
// touches only the logistics columns). `wms.inbound.approved` is written to platform.outbox on
// EVERY successful approval (round-2 finding 8, Master ruling — catalog.ts governs); when
// `expectedAt` is present `wms.inbound.scheduled` is written IN ADDITION, same transaction.
// (6) the audit row (last).
//
// Round-1 review finding 5 — recorded default: when ANY logistics term/dockCode is supplied
// WITHOUT `expectedAt` in the same call, this file REJECTS with a typed 422
// (LogisticsTermsRequireExpectedAtError) rather than silently persisting the terms independently
// or dropping them. Rationale: D2's own wording ("When expectedAt is present: writes... When
// absent: unchanged behavior") treats the appointment slot as one atomic unit — a partial slot
// with terms but no anchor timestamp is not a state this slice models. Flagged in the closing
// report per the brief's own D7-adjacent discipline.
//
// Round-1 review finding 3 (partial, approve-with-slot path): the same domain invariants used by
// ../../application/schedule-inbound/schedule-inbound.ts (isValidHandoverPoint/isValidTransportBy/
// isValidLabourBy/isNonNegativeLabourCount) also gate this path's optional slot, mirroring the
// pre-existing isValidVehicleType check below.
//
// Round-1 review finding 6: the `wms.inbound.scheduled` event payload (and the audit row's
// newValue, finding 4) are built from the RETURNING row of `updateOrderScheduleAndTerms` — the
// actual stored values — never from raw `input`, so a value coalesce()-preserved from a prior call
// is reported accurately.
//
// Round-1 review finding 2: this file's scoped grant was widened by the Master (session
// docs/notes/slice-briefs/_slice-2.9b.brief.md follow-up) to include ./ports.ts and
// ../../infrastructure/receive-inbound/repository.ts specifically so the raw `tx.execute()` UPDATE
// this file used to issue directly could be replaced by a proper port method
// (`deps.repo.updateOrderScheduleAndTerms`) — the application layer now programs only against the
// InboundOrderRepository port, never a raw SQL statement.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { INBOUND_EVENT_ROLES, INBOUND_ORDER_EVENTS, advanceInboundOrder } from '../../domain/receive-inbound/machine.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/receive-inbound/errors.js';
import {
  isFutureTimestamp,
  isNonNegativeLabourCount,
  isValidHandoverPoint,
  isValidLabourBy,
  isValidTransportBy,
  isValidVehicleType,
} from '../../domain/schedule-inbound/invariants.js';
import {
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
  LogisticsTermsRequireExpectedAtError,
  ScheduleInPastError,
} from '../../domain/schedule-inbound/errors.js';
import type { ReceiveInboundDeps } from './ports.js';

const AUDIT_OPERATION_APPROVE = 'approve';
const INBOUND_ORDERS_AGGREGATE_TYPE = 'wms.inbound_orders';
const APPROVED_EVENT_TYPE: CatalogedEventType = 'wms.inbound.approved';
const SCHEDULED_EVENT_TYPE: CatalogedEventType = 'wms.inbound.scheduled';

export interface ApproveInboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  // WBS 2.9b (D2) — the optional ScheduleInbound-style appointment slot, all fields optional.
  readonly expectedAt?: string | undefined;
  readonly dockCode?: string | undefined;
  readonly handoverPoint?: string | undefined;
  readonly transportBy?: string | undefined;
  readonly vehicleType?: string | undefined;
  readonly labourBy?: string | undefined;
  readonly labourCount?: number | undefined;
  readonly idem?: IdempotencyInput | undefined;
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

  return withIdempotentContext<ApproveInboundResult>(ctx, input.idem, async (tx) => {
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

    // WBS 2.9b (D2): domain pre-checks for the optional slot, BEFORE any write — thrown before
    // the version bump below, so a rejected slot leaves the order entirely unchanged.
    const now = deps.clock.now();
    const hasLogisticsTerm =
      input.dockCode !== undefined ||
      input.handoverPoint !== undefined ||
      input.transportBy !== undefined ||
      input.vehicleType !== undefined ||
      input.labourBy !== undefined ||
      input.labourCount !== undefined;
    // Round-1 review finding 5 (recorded default, see this file's own header).
    if (input.expectedAt === undefined && hasLogisticsTerm) {
      throw new LogisticsTermsRequireExpectedAtError(
        'ApproveInbound: a logistics term (dockCode/handoverPoint/transportBy/vehicleType/' +
          'labourBy/labourCount) was supplied without expectedAt. (Allowed: supply expectedAt in ' +
          'the same call, or omit every logistics term)',
      );
    }
    if (input.expectedAt !== undefined) {
      const expectedAt = new Date(input.expectedAt);
      if (!isFutureTimestamp(expectedAt, now)) {
        throw new ScheduleInPastError(
          `ApproveInbound: expectedAt (${input.expectedAt}) must be strictly after now ` +
            `(${now.toISOString()}). (Allowed: a future timestamp)`,
        );
      }
    }
    if (!isValidVehicleType(input.vehicleType ?? null)) {
      throw new InvalidVehicleTypeError(
        `ApproveInbound: vehicleType "${input.vehicleType}" is not one of the closed list ` +
          `(container_20, container_40, truck, trailer, van, pickup, other).`,
      );
    }
    // Round-1 review finding 3 (partial): the remaining three logistics-term invariants.
    if (!isValidHandoverPoint(input.handoverPoint ?? null)) {
      throw new InvalidHandoverPointError(
        `ApproveInbound: handoverPoint "${input.handoverPoint}" is not one of the closed list ` +
          `(premium_warehouse, client_site).`,
      );
    }
    if (!isValidTransportBy(input.transportBy ?? null)) {
      throw new InvalidTransportByError(
        `ApproveInbound: transportBy "${input.transportBy}" is not one of the closed list ` +
          `(client, premium).`,
      );
    }
    if (!isValidLabourBy(input.labourBy ?? null)) {
      throw new InvalidLabourByError(
        `ApproveInbound: labourBy "${input.labourBy}" is not one of the closed list ` +
          `(client, premium, shared).`,
      );
    }
    if (!isNonNegativeLabourCount(input.labourCount ?? null)) {
      throw new InvalidLabourCountError(`ApproveInbound: labourCount (${input.labourCount}) must be >= 0.`);
    }

    const newVersion = await deps.repo.updateOrder(tx, input.orderId, { status: newStatus });

    // Round-1 review finding 4/6: the audit newValue defaults to {status, version} (unchanged
    // behavior when no slot is supplied, D2); when a slot IS supplied it is replaced below with
    // the RETURNING row's actual stored values.
    let auditNewValue: Record<string, unknown> = { status: newStatus, version: newVersion };

    // Round-2 review finding 8 (Master ruling — packages/events/catalog.ts governs: "written once
    // per ApproveInbound (draft → approved)"): `wms.inbound.approved` is written on EVERY
    // successful approval, unconditionally, in the same transaction as the state change (doc 40
    // §B3). `wms.inbound.scheduled` below is an ADDITIONAL row only when `expectedAt` is present.
    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: INBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: APPROVED_EVENT_TYPE,
      payload: { orderId: input.orderId, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    if (input.expectedAt !== undefined) {
      const expectedAt = new Date(input.expectedAt);
      const scheduledAt = now;
      // Round-1 review finding 2: via the port, not a raw `tx.execute()` — no version increment
      // here (the version bump already happened above). Returns the post-UPDATE row (finding 6) —
      // the event payload and audit newValue are built from this, not from raw `input`.
      const updated = await deps.repo.updateOrderScheduleAndTerms(tx, input.orderId, {
        expectedAt,
        scheduledBy: actorId,
        scheduledAt,
        dockCode: input.dockCode ?? null,
        handoverPoint: input.handoverPoint ?? null,
        transportBy: input.transportBy ?? null,
        vehicleType: input.vehicleType ?? null,
        labourBy: input.labourBy ?? null,
        labourCount: input.labourCount ?? null,
      });

      await writeOutboxEvent(tx, {
        entityId: order.entityId,
        aggregateType: INBOUND_ORDERS_AGGREGATE_TYPE,
        aggregateId: input.orderId,
        eventType: SCHEDULED_EVENT_TYPE,
        payload: {
          orderId: input.orderId,
          // Round-2 review finding 7: ISO 8601, identical to schedule-inbound.ts's own payload.
          expectedAt: updated.expectedAt.toISOString(),
          dockCode: updated.dockCode,
          handoverPoint: updated.handoverPoint,
          transportBy: updated.transportBy,
          vehicleType: updated.vehicleType,
          labourBy: updated.labourBy,
          labourCount: updated.labourCount,
        },
        correlationId: input.correlationId,
        actorId,
      });

      // Round-1 review finding 4: the nine columns written on this path are added to the audit
      // newValue — snake_case keys for the five commercial-classified fields so
      // platform.sanitize_audit masks them (delivery_task_id is never written on this path, D5,
      // so it is omitted here, same as ../../application/schedule-inbound/schedule-inbound.ts's
      // own audit row).
      auditNewValue = {
        status: newStatus,
        version: newVersion,
        expectedAt: updated.expectedAt.toISOString(),
        scheduledBy: actorId,
        scheduledAt: scheduledAt.toISOString(),
        dockCode: updated.dockCode,
        vehicleType: updated.vehicleType,
        handover_point: updated.handoverPoint,
        transport_by: updated.transportBy,
        labour_by: updated.labourBy,
        labour_count: updated.labourCount,
      };
    }

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_APPROVE,
      correlationId: input.correlationId,
      actorId,
      newValue: auditNewValue,
      occurredAt: now,
    });

    return { status: 'approved', version: newVersion };
  });
}
