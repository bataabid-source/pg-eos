// modules/imile/application/assign-driver-id/ports.ts — WBS 3.12.
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: AssignDriverIdDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/assign-driver-id/repository.ts implements `DriverIdAssignmentsRepository`;
// ../../api/assign-driver-id/composition.ts wires it.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN interface(s) named after its own
// aggregate — do not import this file from another use case (same discipline as this module's own
// evaluate-dtl-problem/ports.ts).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/assign-driver-id/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

export interface DriverIdStatusRow {
  readonly status: string;
}

export interface InsertAssignmentColumns {
  readonly driverIdRef: string;
  readonly employeeId: string;
  readonly assignedFrom: Date;
  readonly assignedBy: string;
}

export interface InsertedAssignmentRow {
  readonly id: string;
}

/** WBS 3.12 part 2c-i — the row `getDriverAssignabilityCheck` resolves for `employeeId`: the
 *  employee's own `hr.employees.entity_id` (the outbox row's own `entityId`, since neither
 *  `imile.driver_ids` nor `imile.driver_id_assignments` has its own `entity_id` column — brief,
 *  Event) plus its `status`, paired with every `hr.employee_documents` row (`docType`,
 *  `expiryDate`) — an employee with zero document rows still returns `documents: []` (a LEFT JOIN,
 *  not an INNER JOIN — an undocumented employee must reach the domain gate's own
 *  `DriverDocumentMissingError`, not silently vanish from the query). */
export interface DriverAssignabilityCheckRow {
  readonly entityId: string;
  readonly employeeStatus: string;
  readonly documents: readonly { readonly docType: string; readonly expiryDate: string }[];
}

/** Every DB statement the assign-driver-id use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/assign-driver-id/repository.ts. */
export interface DriverIdAssignmentsRepository {
  /** Fast, non-authoritative early read of imile.driver_ids.status — paired with
   *  ../../domain/assign-driver-id/invariants.js's `isAssignableStatus` to reject the common case
   *  before attempting a write. Returns `undefined` when no such row exists (not this typed error —
   *  left to the insert's own foreign-key violation). NOT the guard against the race round-2 fix
   *  round finding 1 addresses — `markDriverIdAssigned` below is. */
  selectDriverIdStatus(tx: NodePgDatabase, driverIdRef: string): Promise<DriverIdStatusRow | undefined>;

  /** INSERT into imile.driver_id_assignments — `approved_by`/`handover_doc_id` always stay null
   *  this slice (brief, Contract). Translates the DB's own partial-unique-index violations
   *  (round-2 fix round, finding 2: there are TWO — one on employee_id, one on driver_id_ref, both
   *  where assigned_to is null) to `EmployeeAlreadyAssignedError` / `DriverIdNotAvailableError`
   *  (../../domain/assign-driver-id/errors.js), same pattern as register-vehicle's
   *  `DuplicatePlateNoError` translation, discriminated by the violated constraint/index name. */
  insertAssignment(tx: NodePgDatabase, columns: InsertAssignmentColumns): Promise<InsertedAssignmentRow>;

  /** Compare-and-set UPDATE imile.driver_ids SET status = 'assigned', updated_at = now() WHERE id =
   *  driverIdRef AND status = 'available' RETURNING id (round-2 fix round, finding 1: the guard and
   *  the write are the SAME statement, so this is immune to a lost update no matter what
   *  `selectDriverIdStatus` saw earlier). Returns `true` when a row was updated, `false` when the
   *  row was not 'available' at the instant of the UPDATE — the application layer maps `false` to
   *  `DriverIdNotAvailableError`. */
  markDriverIdAssigned(tx: NodePgDatabase, driverIdRef: string): Promise<boolean>;

  /** WBS 3.12 part 2c-i, doc 40 INV-C4-1: read-only, cross-schema (`hr.employees` +
   *  `hr.employee_documents`) — no `modules/hr` TypeScript import (a direct cross-module import
   *  fails lint, CLAUDE.md · ARCHITECTURE), same class as WMS's own `getContractCheck`
   *  (modules/wms/infrastructure/process-outbound/repository.ts:258-279). Serves TWO purposes with
   *  ONE query (brief, Scenario: "one query serves both purposes, no separate read"): the outbox
   *  row's own `entityId` (below) AND the employee/document shape
   *  `../../domain/assign-driver-id/invariants.js`'s `assertDriverAssignable` gates on. */
  getDriverAssignabilityCheck(
    tx: NodePgDatabase,
    employeeId: string,
  ): Promise<DriverAssignabilityCheckRow>;

  /** doc 40 P3/P7: one append-only platform.audit_log row per write this use case performs (the
   *  assignment insert, the driver_ids status update) — same hash-chain mechanism (a DB trigger,
   *  not application code) this module's other use cases already write through their own
   *  `writeAuditRow`. `entity_id` is always null — neither imile.driver_id_assignments nor
   *  imile.driver_ids has an entity_id column (brief, Event). `oldValue`/`changedFields` are only
   *  meaningful on the driver_ids update (round-2 fix round, finding 3). */
  writeAuditRow(
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
  ): Promise<void>;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/assign-driver-id/composition.ts). The command programs only against these ports —
 *  the application layer never imports infrastructure/. */
export interface AssignDriverIdDeps extends ClockDeps {
  readonly repo: DriverIdAssignmentsRepository;
  readonly logger: Logger;
}
