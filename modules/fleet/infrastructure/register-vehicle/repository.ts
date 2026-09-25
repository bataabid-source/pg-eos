// modules/fleet/infrastructure/register-vehicle/repository.ts — WBS 3.1.
//
// infrastructure/ layer: every DB statement for the register-vehicle use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened (via withIdempotentContext — see
// ../../application/register-vehicle/register-vehicle.ts). Implements
// ../../application/register-vehicle/ports.ts's `VehiclesRepository`.
//
// LOCK ORDER — this use case takes no row lock at all (it only inserts):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before anything below, since input.idem is
//      always set at the api layer.
//   1. resolveCallerEntityId — a plain read, no lock.
//   2. insertVehicle, then one insertVehicleDocument per document, then the outbox insert
//      (../../application/register-vehicle/register-vehicle.ts), then writeAuditRow, last
//      (ADR-0002).
//
// TEMPLATE GUIDANCE — every module-specific literal a later slice's copy must change is a named
// constant in this ONE file:
const VEHICLE_SCHEMA = 'tms'; // REPLACE-ON-COPY: the module schema.
const VEHICLE_TABLE_NAME = 'vehicles'; // REPLACE-ON-COPY: the aggregate table.
const VEHICLE_TABLE = `${VEHICLE_SCHEMA}.${VEHICLE_TABLE_NAME}`; // dotted, so sed-rename catches both halves.
const DOCUMENT_TABLE_NAME = 'vehicle_documents'; // REPLACE-ON-COPY: the document table.
const DOCUMENT_TABLE = `${VEHICLE_SCHEMA}.${DOCUMENT_TABLE_NAME}`; // dotted, like VEHICLE_TABLE.
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

// decision: the SQLSTATE for a unique violation — tms.vehicles.plate_no (01-Data-Model.sql:846
// `plate_no text not null unique`) is the ONLY unique constraint this insert can hit, so the
// SQLSTATE alone is a sufficient discriminator here (never a guessed Postgres auto-generated
// constraint name).
const UNIQUE_VIOLATION_SQLSTATE = '23505';
// pg-reviewer round 1, Finding 3: the SQLSTATE Postgres raises for a row-level security policy
// violation — tms.vehicle_documents' own `internal_only` RLS policy (`using
// (platform.is_internal())`) rejecting a non-internal actor's insert (brief Scenario "A
// non-internal actor cannot write vehicle_documents").
const RLS_VIOLATION_SQLSTATE = '42501';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  DuplicatePlateNoError,
  EntityScopeAmbiguousError,
  VehicleDocumentAccessDeniedError,
} from '../../domain/register-vehicle/errors.js';
import type {
  InsertedVehicleRow,
  InsertVehicleColumns,
  InsertVehicleDocumentColumns,
  VehiclesRepository,
} from '../../application/register-vehicle/ports.js';

/**
 * True only for a unique violation on this insert (tms.vehicles.plate_no). The whole `cause`
 * chain is walked (drizzle wraps the failing query in its own error, carrying pg's DatabaseError —
 * which holds the SQLSTATE — as `cause`), bounded by `seen` against a cyclic chain. Same pattern as
 * modules/hr/infrastructure/register-employee/repository.ts's own `isDuplicateEmployeeCode`.
 */
function isDuplicatePlateNo(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (code === UNIQUE_VIOLATION_SQLSTATE) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

/**
 * pg-reviewer round 1, Finding 3: true only for a row-level security violation (SQLSTATE 42501) —
 * same cause-chain-walking technique as `isDuplicatePlateNo` above, just a different SQLSTATE.
 */
function isRlsViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (code === RLS_VIOLATION_SQLSTATE) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

async function insertVehicle(tx: NodePgDatabase, columns: InsertVehicleColumns): Promise<InsertedVehicleRow> {
  let result;
  try {
    result = await tx.execute<{ id: string }>(sql`
      insert into ${sql.raw(VEHICLE_TABLE)}
        (entity_id, plate_no, make, model, year, vehicle_type, capacity_kg, capacity_cbm,
         is_refrigerated, ownership, assigned_client_id)
      values
        (${columns.entityId}::uuid, ${columns.plateNo}, ${columns.make}, ${columns.model},
         ${columns.year}::int, ${columns.vehicleType}, ${columns.capacityKg}::numeric,
         ${columns.capacityCbm}::numeric, ${columns.isRefrigerated}, ${columns.ownership},
         ${columns.assignedClientId}::uuid)
      returning id
    `);
  } catch (error) {
    if (isDuplicatePlateNo(error)) {
      throw new DuplicatePlateNoError(
        `a ${VEHICLE_TABLE} row with plate_no ${JSON.stringify(columns.plateNo)} already exists ` +
          `(01-Data-Model.sql:846, plate_no unique). Allowed: a unique plate_no.`,
        { cause: error },
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${VEHICLE_TABLE} returned no row`);
  return { id: row.id };
}

/** A non-internal caller is rejected here by tms.vehicle_documents' own `internal_only` RLS policy
 *  (`using (platform.is_internal())`) — this is NOT reimplemented as an application-level check
 *  (brief). pg-reviewer round 1, Finding 3: the RLS rejection is translated (not reimplemented) to
 *  a typed `VehicleDocumentAccessDeniedError` so it surfaces as a meaningful 422 instead of a
 *  generic 500; any other error is left untyped and propagates as-is. Either way the whole
 *  transaction rolls back, including the vehicle row already inserted. */
async function insertVehicleDocument(
  tx: NodePgDatabase,
  columns: InsertVehicleDocumentColumns,
): Promise<{ readonly id: string }> {
  let result;
  try {
    result = await tx.execute<{ id: string }>(sql`
      insert into ${sql.raw(DOCUMENT_TABLE)}
        (vehicle_id, doc_type, doc_no, issue_date, expiry_date, file_url, alert_days_before)
      values
        (${columns.vehicleId}::uuid, ${columns.docType}, ${columns.docNo}, ${columns.issueDate}::date,
         ${columns.expiryDate}::date, ${columns.fileUrl}, ${columns.alertDaysBefore}::int)
      returning id
    `);
  } catch (error) {
    if (isRlsViolation(error)) {
      throw new VehicleDocumentAccessDeniedError(
        `${DOCUMENT_TABLE}'s own internal_only RLS policy rejected this insert. ` +
          `(Allowed: an internal actor — tms.vehicle_documents' own internal_only RLS policy)`,
        { cause: error },
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${DOCUMENT_TABLE} returned no row`);
  return { id: row.id };
}

/** brief: "entityId ... come[s] from ctx, never the caller". WithContextCtx carries no `entityId`
 *  field, so the caller's own entity is resolved from the session's own identity, via the
 *  platform's own function — `platform.allowed_entities()` (01-Data-Model.sql:327, `security
 *  definer`, scoped to `platform.current_user_id()`), never trusted from the request body. This
 *  replicates the cross-module pattern modules/hr/infrastructure/register-employee/repository.ts's
 *  own `resolveCallerEntityId` already established to work around that gap (`fleet` has no earlier
 *  slice of its own — this is not this module's own precedent). Fails closed: cardinality
 *  (platform.allowed_entities()) = 1 -> use it; otherwise (zero, or more than one) throw
 *  EntityScopeAmbiguousError BEFORE any write — never guess by picking `[1]`. */
async function resolveCallerEntityId(tx: NodePgDatabase): Promise<string> {
  const result = await tx.execute<{ entity_id: string; entity_count: number }>(sql`
    select (platform.allowed_entities())[1] as entity_id, array_length(platform.allowed_entities(), 1) as entity_count
  `);
  const row = result.rows[0];
  const entityCount = row?.entity_count ?? 0;
  if (entityCount !== 1) {
    throw new EntityScopeAmbiguousError(
      `platform.allowed_entities() returned ${entityCount} entities for the caller, not exactly one. ` +
        `(Allowed: a caller scoped to exactly one entity)`,
    );
  }
  const entityId = row?.entity_id;
  if (!entityId) {
    throw new EntityScopeAmbiguousError(
      `platform.allowed_entities() returned no entity for the caller. (Allowed: a caller scoped to exactly one entity)`,
    );
  }
  return entityId;
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the outbox row the same
 *  call writes (G9). `occurredAt` is mandatory (always from the injected Clock, never the column's
 *  own `default now()`). */
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
       ${params.entityId}::uuid, ${VEHICLE_SCHEMA}, ${VEHICLE_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const vehiclesRepository: VehiclesRepository = {
  insertVehicle,
  insertVehicleDocument,
  resolveCallerEntityId,
  writeAuditRow,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export { VEHICLE_SCHEMA, VEHICLE_TABLE_NAME, VEHICLE_TABLE, DOCUMENT_TABLE_NAME, DOCUMENT_TABLE };
