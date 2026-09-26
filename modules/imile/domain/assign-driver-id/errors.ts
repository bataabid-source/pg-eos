// modules/imile/domain/assign-driver-id/errors.ts — WBS 3.12.
//
// Typed errors for the assign-driver-id use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at runtime.
// The api/ layer (../../api/assign-driver-id/handlers.ts) maps both to the Problem envelope: 409
// (brief: "both map to 409 at the API layer — a real conflict, not a validation failure").

/** every command's actor is `ctx.userId` ONLY — same discipline as this module's own
 *  evaluate-dtl-problem/register-vehicle precedents. A null/missing userId is a typed error, not a
 *  silent `null` written to platform.audit_log.user_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** imile.driver_ids.status is not 'available' at read time (chk_driver_ids_status:
 *  13B-Schema-Reference-Consolidation.sql:2513-2516). No row is written. Maps to HTTP 409. */
export class DriverIdNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverIdNotAvailableError';
  }
}

/** mapped from the DB's own partial-unique-index violation on
 *  imile.driver_id_assignments(employee_id) where assigned_to is null (13-Schema-Additions.sql:312)
 *  — the employee already holds an active assignment. This TRANSLATES the database's own rejection
 *  (same pattern as register-vehicle's `DuplicatePlateNoError`), it does not reimplement the
 *  uniqueness rule as an application-level check. Maps to HTTP 409. */
export class EmployeeAlreadyAssignedError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'EmployeeAlreadyAssignedError';
  }
}

// WBS 3.12 part 2c-i — doc 40 INV-C4-1: the same hard gate as
// modules/hr/domain/register-employee/invariants.ts's own `assertDriverAssignable`
// (modules/hr/domain/register-employee/errors.ts's own three classes of the identical name), copied
// here because `AssignDriverId` lives in a DIFFERENT module (`imile`) and a direct TypeScript import
// across `modules/*` fails lint (CLAUDE.md · ARCHITECTURE, eslint-plugin-boundaries) — this is the
// same business rule, re-expressed in this module's own domain/ layer, not an invented rule. Maps to
// HTTP 422 (../../api/assign-driver-id/handlers.ts).

/** doc 40 INV-C4-1: the employee's own `hr.employees.status` is not `'active'` — the same rule as
 *  hr's own WBS-3.3 gate (modules/hr/domain/register-employee/invariants.ts:79-84), copied here
 *  because a cross-module TS import (`modules/hr` from `modules/imile`) fails lint. */
export class EmployeeNotActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeNotActiveError';
  }
}

/** doc 40 INV-C4-1: no `hr.employee_documents` row of the required `doc_type` (`'residency'`, for
 *  the `'task'` purpose) exists for this employee — same rule as hr's own WBS-3.3 gate
 *  (modules/hr/domain/register-employee/invariants.ts:86-93), copied here because a cross-module TS
 *  import (`modules/hr` from `modules/imile`) fails lint. */
export class DriverDocumentMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverDocumentMissingError';
  }
}

/** doc 40 INV-C4-1: the LATEST `hr.employee_documents` row of the required `doc_type` has
 *  `expiry_date < today` (Kuwait business date) — same rule as hr's own WBS-3.3 gate
 *  (modules/hr/domain/register-employee/invariants.ts:94-100), copied here because a cross-module TS
 *  import (`modules/hr` from `modules/imile`) fails lint. */
export class DriverDocumentExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverDocumentExpiredError';
  }
}
