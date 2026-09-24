// modules/hr/infrastructure/register-employee/repository.ts — WBS 3.3.
//
// infrastructure/ layer: every DB statement for the register-employee use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/register-employee/ports.ts's `EmployeeRepository`.
//
// LOCK ORDER — the one every command follows (each command's own header points here), same
// discipline as the golden slice's own repository.ts (modules/wms/infrastructure/receive-inbound/
// repository.ts):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's own
//      input carries an `idem` (every write command in this use case; CheckDriverAssignable never
//      does, brief D1).
//   1. getEmployeeForUpdate — `select ... for update` on the ONE aggregate row, when the command
//      writes. CheckDriverAssignable and RegisterEmployee never take this lock: RegisterEmployee
//      only inserts a fresh row (nothing to lock yet), CheckDriverAssignable is read-only.
//   2. no other row lock this use case needs (no counters, no ledger).
//   3. the document INSERT, then the version-bumping update, then the outbox insert, then
//      writeAuditRow, last (ADR-0002) — record-employee-document.ts's own real write order.
//
// TEMPLATE GUIDANCE — every module-specific literal a later slice's copy must change is a named
// constant in this ONE file:
const EMPLOYEE_SCHEMA = 'hr'; // REPLACE-ON-COPY: the module schema.
const EMPLOYEE_TABLE_NAME = 'employees'; // REPLACE-ON-COPY: the aggregate table.
const EMPLOYEE_TABLE = `${EMPLOYEE_SCHEMA}.${EMPLOYEE_TABLE_NAME}`; // dotted, so sed-rename catches both halves.
const DOCUMENT_TABLE_NAME = 'employee_documents'; // REPLACE-ON-COPY: the document table (audited separately).
const DOCUMENT_TABLE = `${EMPLOYEE_SCHEMA}.${DOCUMENT_TABLE_NAME}`; // dotted, like EMPLOYEE_TABLE.
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
// The audited table for each AuditTarget — the application layer names a target, never a table.
const AUDIT_TABLE_BY_TARGET = { employee: EMPLOYEE_TABLE_NAME, document: DOCUMENT_TABLE_NAME } as const;

// decision (sku-registration precedent, modules/wms/src/sku-registration/register-sku.ts): the
// SQLSTATE and exact, live-verified constraint name on hr.employees (never a guessed Postgres
// auto-generated name — confirmed against the live local database, 01-Data-Model.sql:1270 `code
// text not null unique`).
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const EMPLOYEES_CODE_UNIQUE_CONSTRAINT = 'employees_code_key';

// 01-Data-Model.sql:1307 `hr.employee_documents.alert_days_before int not null default 60` — the
// column default the INSERT falls back to when the caller omits alertDaysBefore (the column is
// NOT NULL, so an explicit NULL parameter would violate it; COALESCE in the SQL below applies this
// constant only when the caller supplied none).
const ALERT_DAYS_BEFORE_DEFAULT = 60;

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { EmployeeCodeTakenError, EmployeeNotFoundError, EntityScopeAmbiguousError } from '../../domain/register-employee/errors.js';
import type { EmployeeStatus } from '../../domain/register-employee/machine.js';
import type {
  AuditTarget,
  EmployeeDocumentRow,
  EmployeeRepository,
  EmployeeRow,
  EmployeeStatusUpdateColumns,
  InsertEmployeeColumns,
  InsertEmployeeDocumentColumns,
} from '../../application/register-employee/ports.js';

/**
 * True only for hr.employees's `employees_code_key` unique violation. The whole `cause` chain is
 * walked (drizzle wraps the failing query in its own error, carrying pg's DatabaseError — which
 * holds the SQLSTATE and constraint name — as `cause`), bounded by `seen` against a cyclic chain.
 * Same pattern as modules/wms/src/sku-registration/register-sku.ts's isDuplicateSkuCode.
 */
function isDuplicateEmployeeCode(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    const constraint = 'constraint' in current ? current.constraint : undefined;
    if (code === UNIQUE_VIOLATION_SQLSTATE && constraint === EMPLOYEES_CODE_UNIQUE_CONSTRAINT) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

async function getEmployeeForUpdate(tx: NodePgDatabase, employeeId: string): Promise<EmployeeRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    code: string;
    status: string;
    version: number;
  }>(sql`
    select id, entity_id, code, status, version
      from ${sql.raw(EMPLOYEE_TABLE)} where id = ${employeeId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new EmployeeNotFoundError(
      `no ${EMPLOYEE_TABLE} row visible for id ${employeeId} (Allowed: an existing employee in the caller's entities)`,
    );
  }
  return { id: row.id, entityId: row.entity_id, code: row.code, status: row.status as EmployeeStatus, version: row.version };
}

async function getEmployee(tx: NodePgDatabase, employeeId: string): Promise<EmployeeRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    code: string;
    status: string;
    version: number;
  }>(sql`
    select id, entity_id, code, status, version
      from ${sql.raw(EMPLOYEE_TABLE)} where id = ${employeeId}::uuid
  `);
  const row = result.rows[0];
  if (!row) {
    throw new EmployeeNotFoundError(
      `no ${EMPLOYEE_TABLE} row visible for id ${employeeId} (Allowed: an existing employee in the caller's entities)`,
    );
  }
  return { id: row.id, entityId: row.entity_id, code: row.code, status: row.status as EmployeeStatus, version: row.version };
}

async function insertEmployee(
  tx: NodePgDatabase,
  columns: InsertEmployeeColumns,
): Promise<{ readonly id: string; readonly version: number }> {
  let result;
  try {
    result = await tx.execute<{ id: string; version: number }>(sql`
      insert into ${sql.raw(EMPLOYEE_TABLE)}
        (entity_id, code, name_ar, name_en, civil_id, nationality, passport_no, job_title_ar,
         job_title_en, org_unit_id, reports_to, employment_type, hire_date, assigned_client_id,
         phone, email)
      values
        (${columns.entityId}::uuid, ${columns.code}, ${columns.nameAr}, ${columns.nameEn},
         ${columns.civilId}, ${columns.nationality}, ${columns.passportNo}, ${columns.jobTitleAr},
         ${columns.jobTitleEn}, ${columns.orgUnitId}::uuid, ${columns.reportsTo}::uuid,
         ${columns.employmentType}, ${columns.hireDate}::date, ${columns.assignedClientId}::uuid,
         ${columns.phone}, ${columns.email})
      returning id, version
    `);
  } catch (error) {
    if (isDuplicateEmployeeCode(error)) {
      throw new EmployeeCodeTakenError(
        `a ${EMPLOYEE_TABLE} row with code ${JSON.stringify(columns.code)} already exists ` +
          `(01-Data-Model.sql ${EMPLOYEES_CODE_UNIQUE_CONSTRAINT}). Allowed: a unique code.`,
        { cause: error },
      );
    }
    throw error;
  }
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${EMPLOYEE_TABLE} returned no row`);
  return { id: row.id, version: row.version };
}

async function insertEmployeeDocument(
  tx: NodePgDatabase,
  columns: InsertEmployeeDocumentColumns,
): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${sql.raw(DOCUMENT_TABLE)}
      (employee_id, doc_type, doc_no, issue_date, expiry_date, file_url, alert_days_before)
    values
      (${columns.employeeId}::uuid, ${columns.docType}, ${columns.docNo}, ${columns.issueDate}::date,
       ${columns.expiryDate}::date, ${columns.fileUrl},
       coalesce(${columns.alertDaysBefore}::int, ${ALERT_DAYS_BEFORE_DEFAULT}))
    returning id
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${DOCUMENT_TABLE} returned no row`);
  return { id: row.id };
}

async function getDocumentsForEmployee(tx: NodePgDatabase, employeeId: string): Promise<readonly EmployeeDocumentRow[]> {
  const result = await tx.execute<{ doc_type: string; expiry_date: string }>(sql`
    select doc_type, expiry_date::text as expiry_date
      from ${sql.raw(DOCUMENT_TABLE)} where employee_id = ${employeeId}::uuid
  `);
  return result.rows.map((row) => ({ docType: row.doc_type, expiryDate: row.expiry_date }));
}

async function updateEmployeeStatus(
  tx: NodePgDatabase,
  employeeId: string,
  columns: EmployeeStatusUpdateColumns,
): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(EMPLOYEE_TABLE)}
       set status = ${columns.status}, version = version + 1, end_date = ${columns.endDate}::date
     where id = ${employeeId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateEmployeeStatus: no ${EMPLOYEE_TABLE} row for id ${employeeId} (lock was already held)`);
  }
  return row.version;
}

async function bumpEmployeeVersion(tx: NodePgDatabase, employeeId: string): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(EMPLOYEE_TABLE)}
       set version = version + 1
     where id = ${employeeId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`bumpEmployeeVersion: no ${EMPLOYEE_TABLE} row for id ${employeeId} (lock was already held)`);
  }
  return row.version;
}

async function hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roleCodes.some((roleCode) => roles.includes(roleCode));
}

/** brief D9: "entity_id = ctx.entityId (never caller-supplied)". WithContextCtx carries no
 *  `entityId` field, so the caller's own entity is resolved the same way `hasRole`/`hasAnyRole`
 *  resolve roles: from the session's own identity, via the platform's own function —
 *  `platform.allowed_entities()` (01-Data-Model.sql:327, `security definer`, scoped to
 *  `platform.current_user_id()`), never trusted from the request body. Fails closed
 *  (pg-reviewer FAIL round 1, Finding 2): cardinality(platform.allowed_entities()) = 1 -> use it;
 *  otherwise (zero, or more than one) throw EntityScopeAmbiguousError BEFORE any write — never
 *  guess by picking `[1]`. */
async function resolveCallerEntityId(tx: NodePgDatabase): Promise<string> {
  const result = await tx.execute<{ entity_id: string; entity_count: number }>(sql`
    select (platform.allowed_entities())[1] as entity_id, array_length(platform.allowed_entities(), 1) as entity_count
  `);
  const row = result.rows[0];
  const entityCount = row?.entity_count ?? 0;
  if (entityCount !== 1) {
    throw new EntityScopeAmbiguousError(
      `platform.allowed_entities() returned ${entityCount} entities for the caller, not exactly one ` +
        `(brief D9). (Allowed: a caller scoped to exactly one entity)`,
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

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with any outbox row the
 *  same call writes (G9). `target` must match `recordId`'s own table (employee writes audited as
 *  `${EMPLOYEE_SCHEMA}.${EMPLOYEE_TABLE_NAME}`, document writes as
 *  `${EMPLOYEE_SCHEMA}.${DOCUMENT_TABLE_NAME}`). `occurredAt` is mandatory (always from the
 *  injected Clock, never the column's own `default now()`). */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly target: AuditTarget;
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
       ${params.entityId}::uuid, ${EMPLOYEE_SCHEMA}, ${AUDIT_TABLE_BY_TARGET[params.target]}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const employeeRepository: EmployeeRepository = {
  getEmployeeForUpdate,
  getEmployee,
  insertEmployee,
  insertEmployeeDocument,
  getDocumentsForEmployee,
  updateEmployeeStatus,
  bumpEmployeeVersion,
  hasAnyRole,
  resolveCallerEntityId,
  writeAuditRow,
};

// REPLACE-ON-COPY: the two module-schema-qualified constants a later slice's copy must change.
export { EMPLOYEE_SCHEMA, EMPLOYEE_TABLE_NAME, EMPLOYEE_TABLE, DOCUMENT_TABLE_NAME, DOCUMENT_TABLE };
