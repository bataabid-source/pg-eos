// modules/imile/infrastructure/assign-driver-id/repository.ts — WBS 3.12.
//
// infrastructure/ layer: every DB statement for the assign-driver-id use case, run against the
// `tx` a caller's own withIdempotentContext(ctx, idem, fn) already opened. Implements
// ../../application/assign-driver-id/ports.ts's `DriverIdAssignmentsRepository`.
//
// `selectDriverIdStatus` is a fast, non-authoritative early read — used by the application layer
// (../../application/assign-driver-id/assign-driver-id.ts) together with
// ../../domain/assign-driver-id/invariants.ts's `isAssignableStatus` to reject the common case (the
// row is already known not to be 'available') before attempting a write. It is NOT the guard
// against the race this slice's round-2 fix round, finding 1 addresses — `markDriverIdAssigned`
// below is: the compare-and-set UPDATE re-checks `status = 'available'` atomically at write time,
// so a concurrent status change between this SELECT and the UPDATE can never be silently
// overwritten.
//
// `insertAssignment` translates the DB's own partial-unique-index violations on
// imile.driver_id_assignments — there are TWO (database/schema/13-Schema-Additions.sql:310,312;
// live index names confirmed via `pg_indexes`: driver_id_assignments_driver_id_ref_idx,
// driver_id_assignments_employee_id_idx) — to a typed error each, discriminating on the pg error's
// own `constraint` field (never a guessed string), same cause-chain-walking technique as
// modules/fleet/infrastructure/register-vehicle/repository.ts's own `isDuplicatePlateNo`.
// `approved_by`/`handover_doc_id` stay their column defaults (null) — never passed here (brief,
// Contract: "no approvedBy this slice", "handover_doc_id stays null").
//
// `markDriverIdAssigned` is a compare-and-set UPDATE (round-2 fix round, finding 1): guarded by
// `where id = $1 and status = 'available'` in the SAME statement, atomically replacing the earlier
// SELECT-then-UPDATE (which raced a concurrent trg_close_on_suspension between the read
// and the write). Zero rows returned means the row was not 'available' at the instant of the
// UPDATE — the application layer maps that to DriverIdNotAvailableError.
//
// `writeAuditRow` follows the same doc 40 P3/P7 append-only platform.audit_log insert convention
// this module's other use cases already use — same hash-chain mechanism (a DB trigger, not
// application code). `entity_id` is always null — neither table has an entity_id column (brief,
// Event: "neither table has an entity_id column").

const DRIVER_IDS_SCHEMA = 'imile'; // REPLACE-ON-COPY: the module schema.
const DRIVER_IDS_TABLE_NAME = 'driver_ids'; // REPLACE-ON-COPY: the aggregate table.
const DRIVER_IDS_TABLE = `${DRIVER_IDS_SCHEMA}.${DRIVER_IDS_TABLE_NAME}`;
const DRIVER_ID_ASSIGNMENTS_TABLE_NAME = 'driver_id_assignments';
const DRIVER_ID_ASSIGNMENTS_TABLE = `${DRIVER_IDS_SCHEMA}.${DRIVER_ID_ASSIGNMENTS_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
const DRIVER_ID_STATUS_ASSIGNED = 'assigned';
const DRIVER_ID_STATUS_AVAILABLE = 'available';

// decision: the SQLSTATE for a unique violation. There are TWO partial unique indexes on
// imile.driver_id_assignments (13-Schema-Additions.sql:310,312) — unlike register-vehicle's single
// plate_no constraint, the SQLSTATE alone does not discriminate which one fired, so
// `isDuplicateActiveAssignmentForEmployee`/`isDuplicateActiveAssignmentForDriverId` below also read
// the error's own `constraint` field (confirmed live against `pg_indexes`, never a guessed Postgres
// auto-generated name).
const UNIQUE_VIOLATION_SQLSTATE = '23505';
// live index names — confirmed via `select indexname from pg_indexes where
// tablename='driver_id_assignments'` against the running database, per round-2 fix round finding 2.
const DRIVER_ID_REF_UNIQUE_INDEX = 'driver_id_assignments_driver_id_ref_idx'; // one active row per driver ID.
const EMPLOYEE_UNIQUE_INDEX = 'driver_id_assignments_employee_id_idx'; // one active row per employee.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  DriverIdNotAvailableError,
  EmployeeAlreadyAssignedError,
} from '../../domain/assign-driver-id/errors.js';
import type {
  DriverAssignabilityCheckRow,
  DriverIdAssignmentsRepository,
  DriverIdStatusRow,
  InsertAssignmentColumns,
  InsertedAssignmentRow,
} from '../../application/assign-driver-id/ports.js';

const EMPLOYEE_DOCUMENTS_TABLE = 'hr.employee_documents';
const EMPLOYEES_TABLE = 'hr.employees';

/** WBS 3.12 part 2c-i, doc 40 INV-C4-1: read-only, cross-schema (`hr.employees` +
 *  `hr.employee_documents`) — no `modules/hr` TypeScript import, same pattern as WMS's own
 *  `getContractCheck` (modules/wms/infrastructure/process-outbound/repository.ts:258-279). A LEFT
 *  JOIN — an employee with zero `hr.employee_documents` rows still returns `employeeStatus`/
 *  `entityId` with an empty `documents` array, so a genuinely undocumented employee reaches the
 *  domain gate's own `DriverDocumentMissingError` instead of vanishing from the query (an INNER JOIN
 *  would silently drop that employee's row). Throws when the employee itself does not exist — left
 *  to surface as an untyped error mapped to 500 at the api layer (this slice's Scenario is only ever
 *  called for an EXISTING employeeId, same convention as `selectDriverIdStatus`'s own sibling
 *  cases). */
async function getDriverAssignabilityCheck(
  tx: NodePgDatabase,
  employeeId: string,
): Promise<DriverAssignabilityCheckRow> {
  const result = await tx.execute<{
    entity_id: string;
    status: string;
    doc_type: string | null;
    expiry_date: string | null;
  }>(sql`
    select e.entity_id as entity_id, e.status as status,
           d.doc_type as doc_type, d.expiry_date::text as expiry_date
      from ${sql.raw(EMPLOYEES_TABLE)} e
      left join ${sql.raw(EMPLOYEE_DOCUMENTS_TABLE)} d on d.employee_id = e.id
     where e.id = ${employeeId}::uuid
  `);
  const rows = result.rows;
  const first = rows[0];
  if (!first) throw new Error(`hr.employees row not found for employeeId ${employeeId}`);

  const documents = rows
    .filter((row): row is typeof row & { doc_type: string; expiry_date: string } =>
      row.doc_type !== null && row.expiry_date !== null,
    )
    .map((row) => ({ docType: row.doc_type, expiryDate: row.expiry_date }));

  return { entityId: first.entity_id, employeeStatus: first.status, documents };
}

async function selectDriverIdStatus(
  tx: NodePgDatabase,
  driverIdRef: string,
): Promise<DriverIdStatusRow | undefined> {
  const result = await tx.execute<{ status: string }>(sql`
    select status from ${sql.raw(DRIVER_IDS_TABLE)} where id = ${driverIdRef}::uuid
  `);
  return result.rows[0];
}

/** True only for a unique violation on `EMPLOYEE_UNIQUE_INDEX` (one active row per employee). The
 *  whole `cause` chain is walked (drizzle wraps the failing query in its own error, carrying pg's
 *  DatabaseError — which holds the SQLSTATE and `constraint` fields — as `cause`), bounded by `seen`
 *  against a cyclic chain. Same pattern as modules/hr/infrastructure/register-employee/
 *  repository.ts's own `isDuplicateEmployeeCode` — checking `constraint`, not the SQLSTATE alone,
 *  because this insert can hit TWO distinct unique indexes (round-2 fix round, finding 2). */
function isDuplicateActiveAssignmentForEmployee(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    const constraint = 'constraint' in current ? current.constraint : undefined;
    if (code === UNIQUE_VIOLATION_SQLSTATE && constraint === EMPLOYEE_UNIQUE_INDEX) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

/** True only for a unique violation on `DRIVER_ID_REF_UNIQUE_INDEX` (one active row per driver ID)
 *  — a concurrent assignment claimed this driver ID between this call's own early
 *  `selectDriverIdStatus` read and this insert. Same technique as
 *  `isDuplicateActiveAssignmentForEmployee` above (round-2 fix round, finding 2). */
function isDuplicateActiveAssignmentForDriverId(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    const constraint = 'constraint' in current ? current.constraint : undefined;
    if (code === UNIQUE_VIOLATION_SQLSTATE && constraint === DRIVER_ID_REF_UNIQUE_INDEX) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

async function insertAssignment(
  tx: NodePgDatabase,
  columns: InsertAssignmentColumns,
): Promise<InsertedAssignmentRow> {
  let result;
  try {
    result = await tx.execute<{ id: string }>(sql`
      insert into ${sql.raw(DRIVER_ID_ASSIGNMENTS_TABLE)}
        (driver_id_ref, employee_id, assigned_from, assigned_to, assigned_by, approved_by, handover_doc_id)
      values
        (${columns.driverIdRef}::uuid, ${columns.employeeId}::uuid,
         ${columns.assignedFrom.toISOString()}::timestamptz, null, ${columns.assignedBy}::uuid, null, null)
      returning id
    `);
  } catch (error) {
    if (isDuplicateActiveAssignmentForEmployee(error)) {
      throw new EmployeeAlreadyAssignedError(
        'This employee already holds an active driver ID assignment. ' +
          '(Allowed: one active assignment per employee.)',
        { cause: error },
      );
    }
    if (isDuplicateActiveAssignmentForDriverId(error)) {
      throw new DriverIdNotAvailableError(
        'This driver ID was just claimed by a concurrent assignment. ' +
          '(Allowed: an available driver ID.)',
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${DRIVER_ID_ASSIGNMENTS_TABLE} returned no row`);
  return { id: row.id };
}

/** Compare-and-set (round-2 fix round, finding 1): the guard (`status = 'available'`) and the write
 *  are the SAME statement, so a concurrent status change (e.g. trg_close_on_suspension
 *  firing between a separate read and write) can never be silently overwritten — the UPDATE simply
 *  matches zero rows and this function reports that to the caller instead of writing anything. No
 *  separate `for update` row lock is needed — the guarded UPDATE itself is the lock. */
async function markDriverIdAssigned(tx: NodePgDatabase, driverIdRef: string): Promise<boolean> {
  const result = await tx.execute<{ id: string }>(sql`
    update ${sql.raw(DRIVER_IDS_TABLE)}
      set status = ${DRIVER_ID_STATUS_ASSIGNED}, updated_at = now()
      where id = ${driverIdRef}::uuid and status = ${DRIVER_ID_STATUS_AVAILABLE}
      returning id
  `);
  return result.rows.length > 0;
}

/** doc 40 P3/P7: one append-only audit_log row per write this use case performs. `entity_id` is
 *  always null — neither table carries such a column (brief, Event: "neither table has an
 *  entity_id column"). `oldValue`/`changedFields` are only meaningful on an update (round-2 fix
 *  round, finding 3) — `changedFields` maps 1:1 to `platform.audit_log.changed_fields text[]`
 *  (13B-Schema-Reference-Consolidation.sql — "changed fields only"), same shape as
 *  ../pull-shipments/repository.ts's own `writeAuditRow`. Left `undefined` on an insert (the whole
 *  row is new, not a diff). */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly tableName: string;
    readonly recordId: string;
    readonly operation: string;
    readonly correlationId: string;
    readonly actorId: string;
    readonly oldValue?: unknown;
    readonly newValue: unknown;
    readonly changedFields?: readonly string[];
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       changed_fields, old_value, new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       null, ${DRIVER_IDS_SCHEMA}, ${params.tableName}, ${params.recordId}::uuid,
       ${params.operation},
       ${params.changedFields && params.changedFields.length > 0 ? sql.param(params.changedFields) : null}::text[],
       ${params.oldValue === undefined ? null : JSON.stringify(params.oldValue)}::jsonb,
       ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const driverIdAssignmentsRepository: DriverIdAssignmentsRepository = {
  selectDriverIdStatus,
  insertAssignment,
  markDriverIdAssigned,
  getDriverAssignabilityCheck,
  writeAuditRow,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export {
  DRIVER_IDS_SCHEMA,
  DRIVER_IDS_TABLE_NAME,
  DRIVER_IDS_TABLE,
  DRIVER_ID_ASSIGNMENTS_TABLE_NAME,
  DRIVER_ID_ASSIGNMENTS_TABLE,
};
