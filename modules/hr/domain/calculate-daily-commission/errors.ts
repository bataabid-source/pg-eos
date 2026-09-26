// modules/hr/domain/calculate-daily-commission/errors.ts — WBS 3.13 part 1.
//
// Typed errors for the calculate-daily-commission use case. Every class sets `name` explicitly —
// an `Error` subclass does NOT get its constructor name for free at runtime; same convention as
// modules/hr/domain/register-employee/errors.ts (this module's own nearest precedent) and
// modules/wms/domain/receive-inbound/errors.ts (THE GOLDEN SLICE). The api/ layer
// (../../api/calculate-daily-commission/handlers.ts) maps each to the Problem envelope (brief,
// Deliver's own final paragraph):
//   - CommissionAlreadyCalculatedError -> 409 (a real conflict, the DB's own unique
//     (work_date, employee_id) violation, translated the same way register-vehicle's
//     DuplicatePlateNoError translates a unique-violation);
//   - NoApplicableCommissionRuleError -> 422 (a data-completeness problem, not a conflict);
//   - AmbiguousCommissionRuleError -> 422 (more than one matching rule, no tie-break specified —
//     brief default 2);
//   - EntityScopeAmbiguousError -> 422 (the caller's own entity scope is not exactly one entity —
//     same shape as register-employee's own EntityScopeAmbiguousError, duplicated here rather than
//     imported across use-case boundaries, same convention as maintain-shift's own duplicated
//     copy — modules/hr/domain/maintain-shift/errors.ts);
//   - EmployeeNotInCallerEntityError -> 422 (round-1 review finding 1: the target employeeId is not
//     visible in / does not belong to the caller's own resolved entity. 404 would read better for
//     "not found in your scope", but packages/contracts/_shared/problem.ts's own PROBLEM_STATUS —
//     frozen, this slice cannot add to it — only names 400/BAD_REQUEST, 409/CONFLICT and
//     422/UNPROCESSABLE_ENTITY ("No other numbers"); 422 is the closest fit already in the shared
//     envelope and keeps this error in the same class as NoApplicableCommissionRuleError/
//     AmbiguousCommissionRuleError below — a data-completeness/precondition failure, not a raw
//     404 this envelope does not define);
//   - NotInternalActorError -> 422 (MASTER_BACKLOG 3.13 part 2, item 2 — originally part 1's
//     round-2 finding 2 — see this class's own doc comment below for the precedent and the reason
//     it is not 403: the same frozen PROBLEM_STATUS envelope names no 403, and the cited precedent
//     (expire-contract's RoleRequiredError) itself maps to 422).

/** every command's actor is `ctx.userId` ONLY — same discipline as this module's own
 *  register-employee/register-vehicle/assign-driver-id precedents. A null/missing userId is a
 *  typed error, not a silent `null` written to platform.audit_log.user_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** mapped from hr.commission_daily's own `commission_daily_work_date_employee_id_key` unique
 *  violation (database/schema/13-Schema-Additions.sql:385 `unique (work_date, employee_id)`) —
 *  this TRANSLATES the database's own rejection (same pattern as register-vehicle's
 *  `DuplicatePlateNoError`), it does not reimplement the uniqueness rule as an application-level
 *  check. Maps to HTTP 409. */
export class CommissionAlreadyCalculatedError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'CommissionAlreadyCalculatedError';
  }
}

/** zero hr.commission_rules rows match this employee's entity, tier and valid window for the
 *  given work date (brief default 2: "a data-completeness problem, not a conflict"). No row is
 *  written. Maps to HTTP 422. */
export class NoApplicableCommissionRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoApplicableCommissionRuleError';
  }
}

/** more than one hr.commission_rules row matches the same tier for the given delivered count —
 *  the package specifies no tie-break, so none is invented (brief default 2). No row is written.
 *  Maps to HTTP 422. */
export class AmbiguousCommissionRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousCommissionRuleError';
  }
}

/** the caller's own entity scope (`platform.allowed_entities()`) is not exactly one entity (zero,
 *  or more than one) — thrown BEFORE any write, never guessed by picking `[1]`. Duplicated from
 *  modules/hr/domain/register-employee/errors.ts's own EntityScopeAmbiguousError rather than
 *  imported across use-case boundaries (same convention as maintain-shift's own duplicated copy).
 *  Maps to HTTP 422. */
export class EntityScopeAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityScopeAmbiguousError';
  }
}

/** round-1 review finding 1 (SECURITY/RLS): the caller-supplied `employeeId` does not resolve to a
 *  visible `hr.employees` row (does not exist, or RLS's own `entity_scope` policy hides it) OR its
 *  `entity_id` does not equal the caller's own resolved `entityId`. Thrown BEFORE the
 *  shipments-attributed query and rule-matching (steps 1-2 of ../../application/
 *  calculate-daily-commission/calculate-daily-commission.ts's own order) — an entity-A caller must
 *  never write a commission row, priced by A's own rules, for an entity-B employee. See this file's
 *  own header for the 422 status choice. */
export class EmployeeNotInCallerEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeNotInCallerEntityError';
  }
}

/** MASTER_BACKLOG 3.13 part 2, item 2 (originally part 1's round-2 finding 2 — typed-error gap):
 *  a non-internal caller who DOES resolve a real,
 *  unambiguous entity scope (unlike EntityScopeAmbiguousError above) is otherwise refused only by
 *  `hr.commission_daily`'s own migration-0027 write policies' `platform.is_internal()` gate — a raw
 *  RLS SQLSTATE 42501 surfacing as an unhandled 500. Same precedent as
 *  modules/sales/application/manage-contract/expire-contract.ts's own `ctx.isInternal` check
 *  (`RoleRequiredError`, "Role gate FIRST, before any transaction opens... checked via
 *  `ctx.isInternal`, never a specific role code — read straight off `ctx`, so it needs no DB round
 *  trip and no lock") and modules/fleet/application/assert-vehicle-assignable/
 *  assert-vehicle-assignable.ts's own fail-closed `ctx.isInternal` gate (reusing
 *  VehicleDocumentAccessDeniedError there) — the application layer checks `ctx.isInternal` explicitly
 *  BEFORE attempting the write, fail-closed, rather than reimplementing `is_internal()` as a second
 *  business rule; the RLS policy remains the sole enforcement layer, this only TRANSLATES its
 *  rejection into a typed, actionable error. Maps to HTTP 422 (this envelope's frozen
 *  packages/contracts/_shared/problem.ts PROBLEM_STATUS names only 400/409/422 — "No other
 *  numbers" — same status the expire-contract/RoleRequiredError precedent itself maps to). */
export class NotInternalActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotInternalActorError';
  }
}
