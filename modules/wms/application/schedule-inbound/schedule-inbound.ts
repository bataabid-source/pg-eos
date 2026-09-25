// modules/wms/application/schedule-inbound/schedule-inbound.ts — WBS 2.9b (lane 2).
//
// ONE withIdempotentContext transaction (step 0 — see ../../../../packages/db/src/idempotency.ts
// — runs first when input.idem is set). Order (docs/notes/slice-briefs/_slice-2.9b.brief.md,
// D1/D4):
//   1. order-row lock (repo.getOrderForUpdate) + expectedVersion check -> StaleVersionError.
//   2. the role gate (WH_MGR or WH_SUP) -> RoleRequiredError.
//   3. legality check: the machine's SCHEDULE_INBOUND event (../../domain/receive-inbound/
//      machine.ts, canTransition) — a self-transition legal only from 'draft'/'approved', landing
//      on the same status (round-1 review finding 12) -> IllegalTransitionError.
//   4. domain pre-checks, thrown BEFORE any write: isFutureTimestamp(expectedAt, clock.now()) ->
//      ScheduleInPastError; isValidVehicleType(vehicleType) -> InvalidVehicleTypeError.
//   5. the update (repo.updateOrder — the version bump, on the row already locked in step 1),
//      then the outbox event ('wms.inbound.scheduled', same transaction/correlationId), then the
//      audit row, last (ADR-0002 discipline — no row lock after the audit-chain write).
//
// Every command takes the same injected ScheduleInboundDeps (clock, ids) — occurred_at/
// scheduled_at always come from the injected clock, never a bare `new Date()`.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import {
  INBOUND_ORDER_EVENTS,
  canTransition,
  type InboundOrderStatus,
} from '../../domain/receive-inbound/machine.js';
import {
  isFutureTimestamp,
  isNonNegativeLabourCount,
  isValidHandoverPoint,
  isValidLabourBy,
  isValidTransportBy,
  isValidVehicleType,
} from '../../domain/schedule-inbound/invariants.js';
import {
  IllegalTransitionError,
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
  MissingActorError,
  RoleRequiredError,
  ScheduleInPastError,
  StaleVersionError,
} from '../../domain/schedule-inbound/errors.js';
import type { ScheduleInboundDeps } from './ports.js';

const SCHEDULE_INBOUND_ROLES = ['WH_MGR', 'WH_SUP'] as const;
const INBOUND_ORDERS_AGGREGATE_TYPE = 'wms.inbound_orders';
const SCHEDULED_EVENT_TYPE: CatalogedEventType = 'wms.inbound.scheduled';
const AUDIT_OPERATION_SCHEDULE = 'update';

export interface ScheduleInboundInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly expectedAt: string;
  readonly dockCode?: string | undefined;
  readonly scheduleNote?: string | undefined;
  readonly handoverPoint?: string | undefined;
  readonly transportBy?: string | undefined;
  readonly vehicleType?: string | undefined;
  readonly labourBy?: string | undefined;
  readonly labourCount?: number | undefined;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ScheduleInboundResult {
  readonly version: number;
}

export async function scheduleInbound(
  ctx: WithContextCtx,
  input: ScheduleInboundInput,
  deps: ScheduleInboundDeps,
): Promise<ScheduleInboundResult> {
  if (!ctx.userId) throw new MissingActorError('ScheduleInbound requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ScheduleInboundResult>(ctx, input.idem, async (tx) => {
    // Step 1 — order-row lock + optimistic-lock check.
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ScheduleInbound: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    // Step 2 — the role gate.
    if (!(await deps.repo.hasAnyRole(tx, SCHEDULE_INBOUND_ROLES))) {
      throw new RoleRequiredError(
        `ScheduleInbound requires role ${SCHEDULE_INBOUND_ROLES.join(' or ')} (platform.my_roles()).`,
      );
    }

    // Step 3 — legality: the machine's SCHEDULE event, a self-transition legal only from 'draft'
    // and 'approved' (round-1 review finding 12) — never a raw string compare on order.status.
    if (!canTransition(order.status as InboundOrderStatus, INBOUND_ORDER_EVENTS.SCHEDULE)) {
      throw new IllegalTransitionError(
        `ScheduleInbound is illegal from status "${order.status}" (allowed: "draft" or "approved" only).`,
      );
    }

    const now = deps.clock.now();

    // Step 4 — domain pre-checks, BEFORE any write.
    const expectedAt = new Date(input.expectedAt);
    if (!isFutureTimestamp(expectedAt, now)) {
      throw new ScheduleInPastError(
        `ScheduleInbound requires expectedAt (${input.expectedAt}) to be strictly after now ` +
          `(${now.toISOString()}). (Allowed: a future timestamp)`,
      );
    }
    if (!isValidVehicleType(input.vehicleType ?? null)) {
      throw new InvalidVehicleTypeError(
        `ScheduleInbound: vehicleType "${input.vehicleType}" is not one of the closed list ` +
          `(container_20, container_40, truck, trailer, van, pickup, other).`,
      );
    }
    // Round-1 review finding 3: the remaining three logistics-term invariants, same
    // dual-enforcement discipline as isValidVehicleType above.
    if (!isValidHandoverPoint(input.handoverPoint ?? null)) {
      throw new InvalidHandoverPointError(
        `ScheduleInbound: handoverPoint "${input.handoverPoint}" is not one of the closed list ` +
          `(premium_warehouse, client_site).`,
      );
    }
    if (!isValidTransportBy(input.transportBy ?? null)) {
      throw new InvalidTransportByError(
        `ScheduleInbound: transportBy "${input.transportBy}" is not one of the closed list ` +
          `(client, premium).`,
      );
    }
    if (!isValidLabourBy(input.labourBy ?? null)) {
      throw new InvalidLabourByError(
        `ScheduleInbound: labourBy "${input.labourBy}" is not one of the closed list ` +
          `(client, premium, shared).`,
      );
    }
    if (!isNonNegativeLabourCount(input.labourCount ?? null)) {
      throw new InvalidLabourCountError(
        `ScheduleInbound: labourCount (${input.labourCount}) must be >= 0.`,
      );
    }

    // Step 5 — the update, then the outbox event, then the audit row (ADR-0002). Round-1 review
    // finding 6: the event payload is built from the ACTUAL post-UPDATE stored row (returned by
    // repo.updateOrder), not the raw input — a reschedule that omits a field keeps the DB's own
    // coalesce()-preserved old value, and the event must reflect that, not `null`.
    const scheduledAt = now;
    const updated = await deps.repo.updateOrder(tx, input.orderId, {
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
    const newVersion = updated.version;

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: INBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: SCHEDULED_EVENT_TYPE,
      payload: {
        orderId: input.orderId,
        expectedAt: updated.expectedAt.toISOString(),
        dockCode: updated.dockCode,
        scheduleNote: input.scheduleNote ?? null,
        handoverPoint: updated.handoverPoint,
        transportBy: updated.transportBy,
        vehicleType: updated.vehicleType,
        labourBy: updated.labourBy,
        labourCount: updated.labourCount,
      },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      recordId: input.orderId,
      operation: AUDIT_OPERATION_SCHEDULE,
      correlationId: input.correlationId,
      actorId,
      // Pre-migration review finding 1: the four commercial-classified logistics-term columns use
      // their SNAKE_CASE DB column names here — platform.sanitize_audit joins
      // identity.column_classification on column_name verbatim, so a camelCase key would silently
      // fail to mask at read time. Every other field (public-classified, or scheduleNote which has
      // no column) uses the camelCase convention already established by
      // ../receive-inbound/approve-inbound.ts's own `newValue: { status, version }` precedent.
      // Round-2 review finding 5: every stored field comes from `updated` (the RETURNING row), the
      // same discipline as the event payload above — a reschedule that omits a term records the
      // coalesce()-preserved stored value, never `null`. scheduleNote has no column (brief D1), so
      // it is the only field still taken from `input`.
      newValue: {
        expectedAt: updated.expectedAt.toISOString(),
        scheduledBy: actorId,
        scheduledAt: scheduledAt.toISOString(),
        dockCode: updated.dockCode,
        vehicleType: updated.vehicleType,
        version: newVersion,
        scheduleNote: input.scheduleNote ?? null,
        handover_point: updated.handoverPoint,
        transport_by: updated.transportBy,
        labour_by: updated.labourBy,
        labour_count: updated.labourCount,
      },
      occurredAt: now,
    });

    return { version: newVersion };
  });
}
