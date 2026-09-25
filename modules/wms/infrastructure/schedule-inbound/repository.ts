// modules/wms/infrastructure/schedule-inbound/repository.ts — WBS 2.9b (lane 2).
//
// infrastructure/ layer: every DB statement for the schedule-inbound use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/schedule-inbound/ports.ts's `ScheduleInboundRepository`.
//
// LOCK ORDER — the one ../../application/schedule-inbound/schedule-inbound.ts's own header
// points here:
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's
//      own input carries an `idem`.
//   1. getOrderForUpdate — `select ... for update` on the ONE aggregate row (RLS entity_scope
//      already governs wms.inbound_orders — no new policy needed, brief Scenario section).
//   2. hasAnyRole — a plain read, no lock.
//   3. updateOrder — the unconditional version bump, on the row already locked in step 1.
//   4. writeAuditRow, last (ADR-0002 discipline — no row lock after the audit-chain write; the
//      caller writes the 'wms.inbound.scheduled' outbox row via @pg-eos/events'
//      writeOutboxEvent directly, between steps 3 and 4).

const ORDER_SCHEMA = 'wms';
const ORDER_TABLE_NAME = 'inbound_orders';
const ORDER_TABLE = `${ORDER_SCHEMA}.${ORDER_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

// D4/migration 0023: `chk_inbound_orders_vehicle_type` raises SQLSTATE 23514 (check_violation) —
// mapped to InvalidVehicleTypeError (422) as a defense-in-depth backstop behind the domain
// pre-check (isValidVehicleType), never an unhandled 500. Round-1 review finding 3: the same
// belt-and-braces mapping for the three other CHECKs migration 0023 added.
const CHECK_VIOLATION_SQLSTATE = '23514';
const VEHICLE_TYPE_CONSTRAINT = 'chk_inbound_orders_vehicle_type';
const HANDOVER_POINT_CONSTRAINT = 'chk_inbound_orders_handover_point';
const TRANSPORT_BY_CONSTRAINT = 'chk_inbound_orders_transport_by';
const LABOUR_BY_CONSTRAINT = 'chk_inbound_orders_labour_by';
const LABOUR_COUNT_CONSTRAINT = 'chk_inbound_orders_labour_count';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
  OrderNotFoundError,
} from '../../domain/schedule-inbound/errors.js';
import type {
  OrderRow,
  ScheduledAppointmentRow,
  ScheduleInboundRepository,
  ScheduleInboundUpdateColumns,
  ScheduleInboundUpdateResult,
} from '../../application/schedule-inbound/ports.js';

/** Walks `error`'s own cause chain for a Postgres error with the given SQLSTATE — same
 *  walk-the-cause-chain discipline as ../../manage-space/repository.ts's own
 *  findRaisedException. Returns the MATCHING error in the chain (never drizzle's own outer
 *  "Failed query: ..." wrapper). */
function findRaisedException(error: unknown, sqlstate: string): Error | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (code === sqlstate) {
      return current;
    }
    current = current.cause;
  }

  return undefined;
}

async function getOrderForUpdate(tx: NodePgDatabase, orderId: string): Promise<OrderRow> {
  const result = await tx.execute<{ id: string; entity_id: string; status: string; version: number }>(sql`
    select id, entity_id, status, version
      from ${sql.raw(ORDER_TABLE)} where id = ${orderId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new OrderNotFoundError(
      `no ${ORDER_TABLE} row visible for id ${orderId} (Allowed: an existing order in the caller's entities)`,
    );
  }
  return { id: row.id, entityId: row.entity_id, status: row.status, version: row.version };
}

/** Round-1 review finding 3: maps a CHECK-violation SQLSTATE (23514) on `raised` to its matching
 *  typed error by constraint name — the same belt-and-braces backstop as the pre-existing
 *  vehicle_type mapping, for the three other CHECKs migration 0023 added. Returns `undefined`
 *  (caller rethrows the original error) when the constraint isn't one of these four. */
function mapCheckViolation(raised: Error, columns: ScheduleInboundUpdateColumns): Error | undefined {
  const constraint = 'constraint' in raised ? raised.constraint : undefined;
  switch (constraint) {
    case VEHICLE_TYPE_CONSTRAINT:
      return new InvalidVehicleTypeError(
        `ScheduleInbound: ${ORDER_TABLE}.vehicle_type must be one of the closed list; received ` +
          `${columns.vehicleType}. (Allowed: container_20, container_40, truck, trailer, van, ` +
          `pickup, other) — ${raised.message}`,
      );
    case HANDOVER_POINT_CONSTRAINT:
      return new InvalidHandoverPointError(
        `ScheduleInbound: ${ORDER_TABLE}.handover_point must be one of the closed list; received ` +
          `${columns.handoverPoint}. (Allowed: premium_warehouse, client_site) — ${raised.message}`,
      );
    case TRANSPORT_BY_CONSTRAINT:
      return new InvalidTransportByError(
        `ScheduleInbound: ${ORDER_TABLE}.transport_by must be one of the closed list; received ` +
          `${columns.transportBy}. (Allowed: client, premium) — ${raised.message}`,
      );
    case LABOUR_BY_CONSTRAINT:
      return new InvalidLabourByError(
        `ScheduleInbound: ${ORDER_TABLE}.labour_by must be one of the closed list; received ` +
          `${columns.labourBy}. (Allowed: client, premium, shared) — ${raised.message}`,
      );
    case LABOUR_COUNT_CONSTRAINT:
      return new InvalidLabourCountError(
        `ScheduleInbound: ${ORDER_TABLE}.labour_count must be >= 0; received ` +
          `${columns.labourCount}. — ${raised.message}`,
      );
    default:
      return undefined;
  }
}

async function updateOrder(
  tx: NodePgDatabase,
  orderId: string,
  columns: ScheduleInboundUpdateColumns,
): Promise<ScheduleInboundUpdateResult> {
  // Round-1 review finding 6: RETURNING the full post-UPDATE row — the caller
  // (../../application/schedule-inbound/schedule-inbound.ts) builds the 'wms.inbound.scheduled'
  // event payload from THIS actual stored row, not from raw input, so a reschedule that omits a
  // field publishes the coalesce()-preserved old value, not `null`.
  let result;
  try {
    result = await tx.execute<{
      version: number;
      expected_at: string;
      dock_code: string | null;
      handover_point: string | null;
      transport_by: string | null;
      vehicle_type: string | null;
      labour_by: string | null;
      labour_count: number | null;
    }>(sql`
      update ${sql.raw(ORDER_TABLE)}
         set version = version + 1,
             expected_at = ${columns.expectedAt.toISOString()}::timestamptz,
             scheduled_by = ${columns.scheduledBy}::uuid,
             scheduled_at = ${columns.scheduledAt.toISOString()}::timestamptz,
             dock_code = coalesce(${columns.dockCode}, dock_code),
             handover_point = coalesce(${columns.handoverPoint}, handover_point),
             transport_by = coalesce(${columns.transportBy}, transport_by),
             vehicle_type = coalesce(${columns.vehicleType}, vehicle_type),
             labour_by = coalesce(${columns.labourBy}, labour_by),
             labour_count = coalesce(${columns.labourCount}, labour_count)
       where id = ${orderId}::uuid
      returning version, expected_at::text as expected_at, dock_code, handover_point, transport_by,
                vehicle_type, labour_by, labour_count
    `);
  } catch (error) {
    const raised = findRaisedException(error, CHECK_VIOLATION_SQLSTATE);
    const mapped = raised ? mapCheckViolation(raised, columns) : undefined;
    if (mapped) throw mapped;
    throw error;
  }
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateOrder: no ${ORDER_TABLE} row for id ${orderId} (lock was already held)`);
  }
  return {
    version: row.version,
    expectedAt: new Date(row.expected_at),
    dockCode: row.dock_code,
    handoverPoint: row.handover_point,
    transportBy: row.transport_by,
    vehicleType: row.vehicle_type,
    labourBy: row.labour_by,
    labourCount: row.labour_count,
  };
}

async function hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roleCodes.some((roleCode) => roles.includes(roleCode));
}

// D10 (round-2 review finding 9, recorded default): listScheduledAppointmentsToday excludes
// cancelled/closed orders — a terminal order whose expected_at happens to fall today is not an
// appointment the WH_SUP board should show. Values from wms.brief.md's inbound_orders.status list
// (draft · approved · receiving · received · putaway · closed · cancelled — there is no
// 'rejected' status; a rejection is a CancelInbound with a cancelReason, D3).
const BOARD_EXCLUDED_STATUS_CANCELLED = 'cancelled';
const BOARD_EXCLUDED_STATUS_CLOSED = 'closed';

async function listScheduledAppointmentsToday(
  tx: NodePgDatabase,
  params: { readonly warehouseId: string; readonly startOfDay: string; readonly endOfDay: string },
): Promise<readonly ScheduledAppointmentRow[]> {
  const result = await tx.execute<{
    id: string;
    expected_at: string;
    vehicle_type: string | null;
    labour_count: number | null;
  }>(sql`
    select id, expected_at::text as expected_at, vehicle_type, labour_count
      from ${sql.raw(ORDER_TABLE)}
     where warehouse_id = ${params.warehouseId}::uuid
       and expected_at is not null
       and expected_at >= ${params.startOfDay}::timestamptz
       and expected_at < ${params.endOfDay}::timestamptz
       and status not in (${BOARD_EXCLUDED_STATUS_CANCELLED}, ${BOARD_EXCLUDED_STATUS_CLOSED})
     order by expected_at asc
  `);
  return result.rows.map((row) => ({
    orderId: row.id,
    expectedAt: row.expected_at,
    vehicleType: row.vehicle_type,
    labourCount: row.labour_count,
  }));
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the
 *  'wms.inbound.scheduled' outbox row the caller writes (G9). `occurredAt` is mandatory (always
 *  from the injected Clock, never the column's own `default now()`). */
async function writeAuditRow(
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
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${ORDER_SCHEMA}, ${ORDER_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const scheduleInboundRepository: ScheduleInboundRepository = {
  getOrderForUpdate,
  updateOrder,
  hasAnyRole,
  listScheduledAppointmentsToday,
  writeAuditRow,
};

export { ORDER_SCHEMA, ORDER_TABLE_NAME, ORDER_TABLE };
