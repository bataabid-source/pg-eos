// modules/hr/infrastructure/maintain-shift/repository.ts — WBS 5.5a part 2 (lane 2).
//
// infrastructure/ layer: every DB statement for the maintain-shift use case, run against the `tx`
// a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/maintain-shift/ports.ts's `ShiftRepository`.
//
// LOCK ORDER — the one every command follows, same discipline as the platform/maintain-site
// precedent (../../../platform/infrastructure/maintain-site/repository.ts):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's own
//      input carries an `idem` (every write command in this use case).
//   1. getAssignmentForUpdate — `select ... for update`, EndShiftAssignment only. CreateShift/
//      CreateShiftGroup/AssignShift never take a row lock: each only inserts a fresh row.
//   2. getAssignmentRangesForEmployee / getShiftGroupShiftId — plain reads (no lock), AssignShift
//      only, BEFORE its own INSERT (brief D4/D5 — the domain layer re-validates BOTH invariants
//      the DB's own exclusion constraint and composite FK enforce, doc 36 §5-4 #2).
//   3. the INSERT/UPDATE, then the outbox insert, then writeAuditRow, last (ADR-0002).
//
// `crossesMidnight` follows the same "omit the column so the DB default fires" discipline as the
// platform/maintain-site precedent's own `radiusM` (brief: never a hardcoded fallback in
// application code — CLAUDE.md "No magic numbers").

const SHIFTS_SCHEMA = 'hr'; // REPLACE-ON-COPY: the module schema.
const SHIFTS_TABLE_NAME = 'shifts';
const SHIFTS_TABLE = `${SHIFTS_SCHEMA}.${SHIFTS_TABLE_NAME}`;
const SHIFT_GROUPS_TABLE_NAME = 'shift_groups';
const SHIFT_GROUPS_TABLE = `${SHIFTS_SCHEMA}.${SHIFT_GROUPS_TABLE_NAME}`;
const SHIFT_ASSIGNMENTS_TABLE_NAME = 'shift_assignments';
const SHIFT_ASSIGNMENTS_TABLE = `${SHIFTS_SCHEMA}.${SHIFT_ASSIGNMENTS_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

// pg-reviewer round-1 findings 4/7: the exact, live-verified SQLSTATEs and constraint names
// (migration 0016) — never a guessed Postgres auto-generated name — same discipline as
// modules/hr/infrastructure/register-employee/repository.ts's own UNIQUE_VIOLATION_SQLSTATE.
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const EXCLUSION_VIOLATION_SQLSTATE = '23P01';
const SHIFTS_CODE_UNIQUE_CONSTRAINT = 'shifts_code_key';
const SHIFT_GROUPS_CODE_UNIQUE_CONSTRAINT = 'shift_groups_code_key';
const SHIFT_ASSIGNMENTS_NO_OVERLAP_CONSTRAINT = 'shift_assignments_no_overlap';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  EntityScopeAmbiguousError,
  ShiftAssignmentNotFoundError,
  ShiftAssignmentOverlapError,
  ShiftCodeTakenError,
  ShiftGroupCodeTakenError,
  ShiftGroupNotFoundError,
} from '../../domain/maintain-shift/errors.js';
import type {
  ExistingAssignmentRange,
  InsertedRow,
  InsertShiftAssignmentColumns,
  InsertShiftColumns,
  InsertShiftGroupColumns,
  ShiftAssignmentRow,
  ShiftRepository,
} from '../../application/maintain-shift/ports.js';

/**
 * pg-reviewer round-1 findings 4/7: true only when `error`'s own cause chain carries a Postgres
 * error with the given SQLSTATE and constraint name. Drizzle wraps the failing query in its own
 * error, carrying pg's DatabaseError (which holds `code`/`constraint`) as `cause`; the whole chain
 * is walked, bounded by `seen` against a cyclic chain — same pattern as
 * modules/hr/infrastructure/register-employee/repository.ts's own isDuplicateEmployeeCode.
 */
function isConstraintViolation(error: unknown, sqlstate: string, constraint: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    const errorConstraint = 'constraint' in current ? current.constraint : undefined;
    if (code === sqlstate && errorConstraint === constraint) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

async function insertShift(tx: NodePgDatabase, columns: InsertShiftColumns): Promise<InsertedRow> {
  // drizzle's `sql` template expands a JS array parameter into a parenthesized value LIST (the
  // `(a, b, c)` shape used for e.g. `IN (...)`), not a Postgres array literal — casting THAT to
  // `::int[]` is a `record -> integer[]` cast, which Postgres rejects (42846). A `{a,b,c}` curly-
  // brace text literal is the one format `::int[]` accepts from a bound parameter here.
  const daysOfWeekLiteral = `{${columns.daysOfWeek.join(',')}}`;
  let result;
  try {
    result =
      columns.crossesMidnight === undefined
        ? await tx.execute<{ id: string; version: number }>(sql`
            insert into ${sql.raw(SHIFTS_TABLE)}
              (entity_id, code, name_ar, name_en, starts_at, ends_at, grace_minutes, days_of_week, site_id)
            values
              (${columns.entityId}::uuid, ${columns.code}, ${columns.nameAr}, ${columns.nameEn},
               ${columns.startsAt}::time, ${columns.endsAt}::time, ${columns.graceMinutes}::int,
               ${daysOfWeekLiteral}::int[], ${columns.siteId}::uuid)
            returning id, version
          `)
        : await tx.execute<{ id: string; version: number }>(sql`
            insert into ${sql.raw(SHIFTS_TABLE)}
              (entity_id, code, name_ar, name_en, starts_at, ends_at, crosses_midnight, grace_minutes,
               days_of_week, site_id)
            values
              (${columns.entityId}::uuid, ${columns.code}, ${columns.nameAr}, ${columns.nameEn},
               ${columns.startsAt}::time, ${columns.endsAt}::time, ${columns.crossesMidnight}::boolean,
               ${columns.graceMinutes}::int, ${daysOfWeekLiteral}::int[], ${columns.siteId}::uuid)
            returning id, version
          `);
  } catch (error) {
    if (isConstraintViolation(error, UNIQUE_VIOLATION_SQLSTATE, SHIFTS_CODE_UNIQUE_CONSTRAINT)) {
      throw new ShiftCodeTakenError(
        `a ${SHIFTS_TABLE} row with code ${JSON.stringify(columns.code)} already exists ` +
          `(migration 0016 ${SHIFTS_CODE_UNIQUE_CONSTRAINT}). Allowed: a unique code.`,
        { cause: error },
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${SHIFTS_TABLE} returned no row`);
  return { id: row.id, version: row.version };
}

async function insertShiftGroup(tx: NodePgDatabase, columns: InsertShiftGroupColumns): Promise<InsertedRow> {
  let result;
  try {
    result = await tx.execute<{ id: string; version: number }>(sql`
      insert into ${sql.raw(SHIFT_GROUPS_TABLE)}
        (entity_id, shift_id, code, name_ar, group_type, lead_employee_id, vehicle_id, site_id, starts_at, ends_at)
      values
        (${columns.entityId}::uuid, ${columns.shiftId}::uuid, ${columns.code}, ${columns.nameAr},
         ${columns.groupType}, ${columns.leadEmployeeId}::uuid, ${columns.vehicleId}::uuid,
         ${columns.siteId}::uuid, ${columns.startsAt}::time, ${columns.endsAt}::time)
      returning id, version
    `);
  } catch (error) {
    if (isConstraintViolation(error, UNIQUE_VIOLATION_SQLSTATE, SHIFT_GROUPS_CODE_UNIQUE_CONSTRAINT)) {
      throw new ShiftGroupCodeTakenError(
        `a ${SHIFT_GROUPS_TABLE} row with code ${JSON.stringify(columns.code)} already exists ` +
          `(migration 0016 ${SHIFT_GROUPS_CODE_UNIQUE_CONSTRAINT}). Allowed: a unique code.`,
        { cause: error },
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${SHIFT_GROUPS_TABLE} returned no row`);
  return { id: row.id, version: row.version };
}

async function getAssignmentRangesForEmployee(
  tx: NodePgDatabase,
  employeeId: string,
): Promise<readonly ExistingAssignmentRange[]> {
  const result = await tx.execute<{ valid_from: string; valid_to: string | null }>(sql`
    select valid_from::text as valid_from, valid_to::text as valid_to
      from ${sql.raw(SHIFT_ASSIGNMENTS_TABLE)} where employee_id = ${employeeId}::uuid
  `);
  return result.rows.map((row) => ({ validFrom: row.valid_from, validTo: row.valid_to }));
}

async function getShiftGroupShiftId(tx: NodePgDatabase, groupId: string): Promise<string> {
  const result = await tx.execute<{ shift_id: string }>(sql`
    select shift_id from ${sql.raw(SHIFT_GROUPS_TABLE)} where id = ${groupId}::uuid
  `);
  const row = result.rows[0];
  if (!row) {
    throw new ShiftGroupNotFoundError(
      `no ${SHIFT_GROUPS_TABLE} row visible for id ${groupId} (Allowed: an existing shift group in the caller's entities)`,
    );
  }
  return row.shift_id;
}

async function insertShiftAssignment(
  tx: NodePgDatabase,
  columns: InsertShiftAssignmentColumns,
): Promise<InsertedRow> {
  let result;
  try {
    result = await tx.execute<{ id: string; version: number }>(sql`
      insert into ${sql.raw(SHIFT_ASSIGNMENTS_TABLE)}
        (entity_id, employee_id, shift_id, group_id, valid_from, valid_to, assigned_by)
      values
        (${columns.entityId}::uuid, ${columns.employeeId}::uuid, ${columns.shiftId}::uuid,
         ${columns.groupId}::uuid, ${columns.validFrom}::date, ${columns.validTo}::date, ${columns.assignedBy}::uuid)
      returning id, version
    `);
  } catch (error) {
    // pg-reviewer round-1 finding 4: TOCTOU belt-and-braces — the domain-layer overlaps() check
    // (assign-shift.ts) already ran before this INSERT and is the primary defence; this catch
    // only handles the race window between two concurrent AssignShift calls for the same
    // employee, so the loser gets a typed 422 instead of a raw 23P01 -> 500 (doc 36 section 5-4
    // #2's "both, not one").
    if (isConstraintViolation(error, EXCLUSION_VIOLATION_SQLSTATE, SHIFT_ASSIGNMENTS_NO_OVERLAP_CONSTRAINT)) {
      throw new ShiftAssignmentOverlapError(
        `AssignShift: employee ${columns.employeeId} already has an assignment overlapping ` +
          `[${columns.validFrom}, ${columns.validTo ?? 'open-ended'}] (${SHIFT_ASSIGNMENTS_NO_OVERLAP_CONSTRAINT}). ` +
          `(Allowed: end the current assignment with EndShiftAssignment first, or a range that does not intersect it)`,
        { cause: error },
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${SHIFT_ASSIGNMENTS_TABLE} returned no row`);
  return { id: row.id, version: row.version };
}

async function getAssignmentForUpdate(tx: NodePgDatabase, assignmentId: string): Promise<ShiftAssignmentRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    version: number;
    valid_from: string;
    valid_to: string | null;
  }>(sql`
    select id, entity_id, version, valid_from::text as valid_from, valid_to::text as valid_to
      from ${sql.raw(SHIFT_ASSIGNMENTS_TABLE)} where id = ${assignmentId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new ShiftAssignmentNotFoundError(
      `no ${SHIFT_ASSIGNMENTS_TABLE} row visible for id ${assignmentId} (Allowed: an existing assignment in the caller's entities)`,
    );
  }
  return { id: row.id, entityId: row.entity_id, version: row.version, validFrom: row.valid_from, validTo: row.valid_to };
}

async function endAssignment(
  tx: NodePgDatabase,
  assignmentId: string,
  validTo: string,
): Promise<{ readonly version: number }> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(SHIFT_ASSIGNMENTS_TABLE)}
       set valid_to = ${validTo}::date, version = version + 1
     where id = ${assignmentId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`endAssignment: no ${SHIFT_ASSIGNMENTS_TABLE} row for id ${assignmentId} (lock was already held)`);
  }
  return { version: row.version };
}

async function hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roleCodes.some((roleCode) => roles.includes(roleCode));
}

/** brief D6: "entity_id = ctx.entityId (never caller-supplied)". WithContextCtx carries no
 *  `entityId` field, so the caller's own entity is resolved from the session's own identity, via
 *  `platform.allowed_entities()` (01-Data-Model.sql:327, `security definer`, scoped to
 *  `platform.current_user_id()`), never trusted from the request body. Fails closed:
 *  cardinality(platform.allowed_entities()) = 1 -> use it; otherwise throw
 *  EntityScopeAmbiguousError BEFORE any write — never guess by picking `[1]`. */
async function resolveCallerEntityId(tx: NodePgDatabase): Promise<string> {
  const result = await tx.execute<{ entity_id: string; entity_count: number }>(sql`
    select (platform.allowed_entities())[1] as entity_id, array_length(platform.allowed_entities(), 1) as entity_count
  `);
  const row = result.rows[0];
  const entityCount = row?.entity_count ?? 0;
  if (entityCount !== 1) {
    throw new EntityScopeAmbiguousError(
      `platform.allowed_entities() returned ${entityCount} entities for the caller, not exactly one ` +
        `(brief D6). (Allowed: a caller scoped to exactly one entity)`,
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

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the outbox row the
 *  same call writes (G9). `tableName` names which of the three aggregate tables the record
 *  belongs to — the application layer passes it, never guesses a table from the record id.
 *  `occurredAt` is mandatory (always from the injected Clock, never the column's own
 *  `default now()`). */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly tableName: string;
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
       ${params.entityId}::uuid, ${SHIFTS_SCHEMA}, ${params.tableName}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const shiftRepository: ShiftRepository = {
  insertShift,
  insertShiftGroup,
  getAssignmentRangesForEmployee,
  getShiftGroupShiftId,
  insertShiftAssignment,
  getAssignmentForUpdate,
  endAssignment,
  hasAnyRole,
  resolveCallerEntityId,
  writeAuditRow,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export {
  SHIFTS_SCHEMA,
  SHIFTS_TABLE_NAME,
  SHIFTS_TABLE,
  SHIFT_GROUPS_TABLE_NAME,
  SHIFT_GROUPS_TABLE,
  SHIFT_ASSIGNMENTS_TABLE_NAME,
  SHIFT_ASSIGNMENTS_TABLE,
};
