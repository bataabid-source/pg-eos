// modules/wms/application/schedule-inbound/ports.ts — WBS 2.9b (lane 2).
//
// application/ layer: the ports this use case programs against. `./schedule-inbound.ts` and
// `./list-scheduled-appointments-today.ts` take ONE `deps: ScheduleInboundDeps` (clock, ids,
// repo, logger) and never import infrastructure/.
// ../../infrastructure/schedule-inbound/repository.ts implements `ScheduleInboundRepository`;
// ../../api/schedule-inbound/composition.ts wires it.
//
// D1 (brief): no `machine` port here — ScheduleInbound's legality IS machine-gated
// (INBOUND_ORDER_EVENTS.SCHEDULE in ../../domain/receive-inbound/machine.ts, a self-transition —
// no NEW state, version bump only; round-1 review finding 12), called directly as a pure domain
// function, so no port is needed.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator every command needs (injected — domain-kit adapters in
 *  production, fixed ones in tests). `ids` is unused by this use case's own writes (no new row is
 *  ever inserted — ScheduleInbound only UPDATEs the existing wms.inbound_orders row) — carried for
 *  parity with every other use case's `ClockDeps` shape. */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/schedule-inbound/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/schedule-inbound/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface ScheduleInboundDeps extends ClockDeps {
  readonly repo: ScheduleInboundRepository;
  readonly logger: Logger;
}

export interface OrderRow {
  readonly id: string;
  readonly entityId: string;
  readonly status: string;
  readonly version: number;
}

export interface ScheduleInboundUpdateColumns {
  readonly expectedAt: Date;
  readonly scheduledBy: string;
  readonly scheduledAt: Date;
  readonly dockCode: string | null;
  readonly handoverPoint: string | null;
  readonly transportBy: string | null;
  readonly vehicleType: string | null;
  readonly labourBy: string | null;
  readonly labourCount: number | null;
}

/** Round-1 review finding 6: the actual post-UPDATE stored row (via `RETURNING`), not the raw
 *  input — a reschedule that omits a field keeps the DB's own `coalesce()`-preserved old value,
 *  and the caller (../../application/schedule-inbound/schedule-inbound.ts) must build the
 *  `wms.inbound.scheduled` event payload from THIS, not from `input`. */
export interface ScheduleInboundUpdateResult {
  readonly version: number;
  readonly expectedAt: Date;
  readonly dockCode: string | null;
  readonly handoverPoint: string | null;
  readonly transportBy: string | null;
  readonly vehicleType: string | null;
  readonly labourBy: string | null;
  readonly labourCount: number | null;
}

export interface ScheduledAppointmentRow {
  readonly orderId: string;
  readonly expectedAt: string;
  readonly vehicleType: string | null;
  readonly labourCount: number | null;
}

/** Every DB statement the schedule-inbound use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/schedule-inbound/repository.ts. */
export interface ScheduleInboundRepository {
  /** order-row lock, FIRST — `select ... for update`. Throws OrderNotFoundError when no row is
   *  visible (RLS entity_scope hides an order outside the caller's entities — indistinguishable
   *  from missing, by design). */
  getOrderForUpdate(tx: NodePgDatabase, orderId: string): Promise<OrderRow>;
  /** unconditional version bump — the caller already validated expectedVersion against the
   *  locked row and holds that lock for the whole transaction, so this never races. Also throws a
   *  typed InvalidVehicleTypeError as a belt-and-braces backstop when the DB's own
   *  chk_inbound_orders_vehicle_type CHECK raises (SQLSTATE 23514) — the domain pre-check
   *  (isValidVehicleType) already rejects an invalid value before this is ever reached in normal
   *  operation. */
  updateOrder(
    tx: NodePgDatabase,
    orderId: string,
    columns: ScheduleInboundUpdateColumns,
  ): Promise<ScheduleInboundUpdateResult>;
  hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean>;
  /** D-brief Scenario: today's appointments for a warehouse, ordered by expected_at ascending — an
   *  order with expected_at still null ("بلا موعد") is excluded. `startOfDay`/`endOfDay` are ISO
   *  timestamps computed by the caller from the injected clock, never `new Date()`. */
  listScheduledAppointmentsToday(
    tx: NodePgDatabase,
    params: { readonly warehouseId: string; readonly startOfDay: string; readonly endOfDay: string },
  ): Promise<readonly ScheduledAppointmentRow[]>;
  /** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the
   *  'wms.inbound.scheduled' outbox row the same call writes (G9). `occurredAt` is mandatory
   *  (always from the injected Clock, never the column's own `default now()`). */
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}
