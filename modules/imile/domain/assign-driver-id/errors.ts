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
