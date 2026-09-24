// modules/hr/application/register-employee/ports.ts — WBS 3.3.
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: RegisterEmployeeDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/register-employee/repository.ts implements `EmployeeRepository`.
// ../../api/register-employee/composition.ts wires it. Shape copied from the golden slice's own
// ports.ts (modules/wms/application/receive-inbound/ports.ts) — this use case has no ledger, so
// that port is dropped rather than left unused (TEMPLATE GUIDANCE there: "a later slice's own
// ports.ts declares its OWN interfaces named after its own aggregate").

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { EmployeeStatus } from '../../domain/register-employee/machine.js';

/** The clock and id generator every command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/register-employee/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/register-employee/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface RegisterEmployeeDeps extends ClockDeps {
  readonly repo: EmployeeRepository;
  readonly logger: Logger;
}

/** What an audit row is about: the employee row itself, or one of its documents. The adapter maps
 *  this to schema_name/table_name — the application layer never names a table. */
export type AuditTarget = 'employee' | 'document';

export interface EmployeeRow {
  readonly id: string;
  readonly entityId: string;
  readonly code: string;
  readonly status: EmployeeStatus;
  readonly version: number;
}

export interface EmployeeDocumentRow {
  readonly docType: string;
  readonly expiryDate: string;
}

export interface InsertEmployeeColumns {
  readonly entityId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly civilId: string | null;
  readonly nationality: string | null;
  readonly passportNo: string | null;
  readonly jobTitleAr: string | null;
  readonly jobTitleEn: string | null;
  readonly orgUnitId: string | null;
  readonly reportsTo: string | null;
  readonly employmentType: string;
  readonly hireDate: string;
  readonly assignedClientId: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface InsertEmployeeDocumentColumns {
  readonly employeeId: string;
  readonly docType: string;
  readonly docNo: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string;
  readonly fileUrl: string | null;
  readonly alertDaysBefore: number | null;
}

export interface EmployeeStatusUpdateColumns {
  readonly status: EmployeeStatus;
  readonly endDate: string | null;
}

/** Every DB statement the register-employee use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/register-employee/repository.ts. */
export interface EmployeeRepository {
  /** row lock, FIRST — `select ... for update`. Throws EmployeeNotFoundError. */
  getEmployeeForUpdate(tx: NodePgDatabase, employeeId: string): Promise<EmployeeRow>;
  /** plain read, no lock — CheckDriverAssignable is read-only (brief D1). Throws
   *  EmployeeNotFoundError. */
  getEmployee(tx: NodePgDatabase, employeeId: string): Promise<EmployeeRow>;
  /** Throws EmployeeCodeTakenError on a `employees_code_key` unique violation (01-Data-Model.sql:
   *  1270) — translated here, in infrastructure, since only this layer sees the raw pg error. */
  insertEmployee(tx: NodePgDatabase, columns: InsertEmployeeColumns): Promise<{ readonly id: string; readonly version: number }>;
  /** INSERT ONLY — hr.employee_documents is never UPDATEd (brief: a renewal is a NEW row, history
   *  kept, D3). */
  insertEmployeeDocument(tx: NodePgDatabase, columns: InsertEmployeeDocumentColumns): Promise<{ readonly id: string }>;
  /** every doc_type row for this employee — the domain layer (assertDriverAssignable) computes
   *  the per-doc_type latest itself (brief D3), so this returns the full, unaggregated set. */
  getDocumentsForEmployee(tx: NodePgDatabase, employeeId: string): Promise<readonly EmployeeDocumentRow[]>;
  /** unconditional version bump with a status/end_date change — the caller already validated
   *  expectedVersion against the locked row and holds that lock for the whole transaction, so this
   *  never races. Returns the new version. */
  updateEmployeeStatus(tx: NodePgDatabase, employeeId: string, columns: EmployeeStatusUpdateColumns): Promise<number>;
  /** unconditional version bump with no other column change — RecordEmployeeDocument's own write
   *  (brief: "hr.employees.version becomes 2"). Returns the new version. */
  bumpEmployeeVersion(tx: NodePgDatabase, employeeId: string): Promise<number>;
  /** true iff the caller holds at least one of `roleCodes` (`platform.my_roles()`) — brief D6
   *  gates every command on an OR of roles, never a single one. */
  hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean>;
  /** the caller's own entity (brief D9: "entity_id = ctx.entityId (never caller-supplied)") —
   *  resolved from identity.user_entities via platform.allowed_entities(), never trusted from the
   *  request body. */
  resolveCallerEntityId(tx: NodePgDatabase): Promise<string>;
  writeAuditRow(
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
  ): Promise<void>;
}

export type { DriverAssignmentPurpose } from '../../domain/register-employee/invariants.js';
