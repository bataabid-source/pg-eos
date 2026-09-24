// modules/hr/domain/register-employee/errors.ts — WBS 3.3.
//
// Typed errors for the register-employee use case. Every class sets `name` explicitly (CLAUDE.md
// · AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at
// runtime. Same discipline as modules/wms/domain/receive-inbound/errors.ts (THE GOLDEN SLICE). The
// api/ layer (../../api/register-employee/handlers.ts) maps these to the RFC 9457 Problem
// envelope: StaleVersionError / EmployeeCodeTakenError -> 409, everything else -> 422/400 per that
// layer's own map.

/** No hr.employees row is visible for this id — it does not exist, or RLS hides it from the
 *  caller (an employee outside the caller's entities is indistinguishable from a missing one, by
 *  design). Maps to 422 (the Problem envelope has no 404). */
export class EmployeeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeNotFoundError';
  }
}

/** RegisterEmployee's `code` (`^PG-\d{4}$`) already belongs to another hr.employees row
 *  (`employees_code_key`, 01-Data-Model.sql:1270). Maps to HTTP 409. */
export class EmployeeCodeTakenError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'EmployeeCodeTakenError';
  }
}

/** doc 40 INV-C4-1 / bp06 §4.3: the hard gate refused because the employee's own status is not
 *  'active' (suspended/terminated/on_leave — brief D5). Maps to HTTP 422. */
export class EmployeeNotActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeNotActiveError';
  }
}

/** doc 40 INV-C4-1: the required doc_type's latest hr.employee_documents row (brief D3) has
 *  expiry_date < today. Maps to HTTP 422. */
export class DriverDocumentExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverDocumentExpiredError';
  }
}

/** doc 40 INV-C4-1: no hr.employee_documents row of a required doc_type exists at all — a
 *  missing document blocks like an expired one (brief D4: "the gate cannot prove validity").
 *  Maps to HTTP 422. */
export class DriverDocumentMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverDocumentMissingError';
  }
}

/** RecordEmployeeDocument was called with an issue_date later than its own expiry_date. Thrown
 *  before any DB write. Maps to HTTP 422. */
export class DocumentDatesInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentDatesInvalidError';
  }
}

/** Optimistic-lock conflict: `expectedVersion` no longer matches the locked hr.employees row's
 *  own `version` — another caller already advanced it. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The caller does not hold any of the roles a command requires (checked via
 *  `platform.my_roles()` inside the transaction — read, never guessed, brief D6). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** The employee state machine (./machine.ts) rejected the requested ChangeEmployeeStatus event
 *  from the employee's current status (brief D7). Maps to HTTP 422. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to platform.audit_log.user_id / platform.outbox.actor_id (brief D9). */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** brief D9: "entity_id = ctx.entityId (never caller-supplied)" — resolved from
 *  `platform.allowed_entities()`. Thrown, never defaulted, when the caller's own entity scope is
 *  not exactly one entity (zero, or more than one) — RegisterEmployee refuses to guess which
 *  entity a write belongs to. Thrown BEFORE any write (pg-reviewer FAIL round 1, Finding 2). */
export class EntityScopeAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityScopeAmbiguousError';
  }
}
