// modules/billing/domain/accounting-periods/errors.ts — WBS 4.19 (lane 2).
//
// Typed errors for the accounting-periods use case. Every class sets `name` explicitly — an `Error`
// subclass does NOT get its constructor name for free at runtime (golden slice:
// modules/wms/domain/receive-inbound/errors.ts). The api/ layer (../../api/accounting-periods/
// handlers.ts) maps these to the Problem envelope: StaleVersionError -> 409, RoleRequiredError ->
// 403, everything else -> 422.

/** Optimistic-lock conflict: the caller's expectedVersion (or a reopen decision's recorded
 *  periodVersion) no longer matches the period's current version. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The caller does not hold the role a command requires (checked inside the transaction via
 *  platform.my_roles() / platform.is_approval_chain_approver() — read, never guessed). Maps to 403. */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** Every command's actor is `ctx.userId` only; a missing one is a typed error, never a silent
 *  `null` written to the outbox, the audit row or the decision's requestedBy. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** The period state machine (./machine.ts) refused the event from the period's current status, or
 *  a reopen was applied without a decided and approved Decision Inbox row. Maps to HTTP 422. */
export class IllegalPeriodTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalPeriodTransitionError';
  }
}

/** No period row is visible for this id — it does not exist, or RLS hides it from the caller (a
 *  period of another entity is indistinguishable from a missing one, by design). Maps to 422. */
export class PeriodNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodNotFoundError';
  }
}

/** No fiscal year of the named entity is visible for this id (missing, of another entity, or hidden
 *  by RLS). Maps to 422. */
export class FiscalYearNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiscalYearNotFoundError';
  }
}

/** Segregation of duties (4.19 pre-build review D9, brief "the reopen requester ≠ the approver"):
 *  the reopen decision was decided by the user who requested it. Maps to 422. */
export class SelfApprovalNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfApprovalNotAllowedError';
  }
}

/** Close review round 1 #3: the database refused a fiscal year overlapping another fiscal year of
 *  the same entity (ex_fiscal_years_no_overlap, 23P01). Maps to 422. */
export class FiscalYearOverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiscalYearOverlapError';
  }
}

/** The database refused a period overlapping another period of the same entity
 *  (ex_accounting_periods_no_overlap, 23P01). Maps to 422. */
export class PeriodOverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodOverlapError';
  }
}

/** The database refused a period whose date range is not inside its fiscal year
 *  (chk_accounting_periods_in_fiscal_year, 23514). Maps to 422. */
export class PeriodOutsideFiscalYearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodOutsideFiscalYearError';
  }
}

/** entity_scope RLS refused the insert (42501): the entity is not one of the caller's entities.
 *  Maps to 422. */
export class EntityNotInScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityNotInScopeError';
  }
}
