// modules/hr/domain/dispute-commission/errors.ts — WBS 3.13 part 4.
//
// Typed errors for the DisputeCommission use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at runtime.
// The api/ layer (../../api/dispute-commission/handlers.ts) maps each to the Problem envelope.

/** every command's actor is `ctx.userId` ONLY — same discipline as this module's own
 *  calculate-daily-commission/register-employee precedents. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** brief, Deliver: the target hr.commission_daily row's own `created_at` is more than
 *  `hr.commission.dispute_window_hours` (platform.thresholds) hours in the past — the 48-hour
 *  dispute window (doc 10 §14) has closed. No row is written. Maps to HTTP 409 (a real conflict —
 *  the window closed). */
export class DisputeWindowExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeWindowExpiredError';
  }
}

/** round-1 review finding 2 (SECURITY): the DISPUTING actor (`ctx.userId`) must resolve — via the
 *  same `identity.users.id = ctx.userId and identity.users.employee_id = <the row's own
 *  employee_id>` pattern ../confirm-commission/errors.ts's own `SelfReviewNotAllowedError`
 *  documents — to the SAME employee that owns the row. Without this check, any internal actor
 *  visible through `hr.driver_commission.read_all` (DEL_SUP, SALES_MGR, CFO, GM) could dispute a
 *  DIFFERENT driver's commission and, since ConfirmCommission's own SoD only checks the confirmer
 *  against the row's OWN employee (not against who raised the dispute), the SAME role could then
 *  act as both requester and approver of its own dispute. Brief Scenario 1: "DisputeCommission is
 *  called by that employee's own actor"; doc 10 §14 (l.300) has the disputing driver acting on
 *  their own row. Checked at the APPLICATION layer BEFORE the window check and BEFORE the write.
 *  Maps to HTTP 403 (a LOCAL status constant in ../../api/dispute-commission/handlers.ts, same
 *  discipline as ConfirmCommission's own SelfReviewNotAllowedError). */
export class CannotDisputeAnotherEmployeesRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CannotDisputeAnotherEmployeesRowError';
  }
}

/** The shared commission-daily-status machine (./machine.ts) rejected the DISPUTE event from the
 *  row's current status (e.g. already 'disputed'/'confirmed'/'paid') — DisputeCommission only
 *  ever transitions a 'calculated' row. Maps to HTTP 422. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** Optimistic-lock conflict: `UPDATE ... WHERE id=$1 AND version=$2` matched zero rows — either no
 *  hr.commission_daily row is visible for this id (does not exist, or RLS's own `own_commission`
 *  policy hides it from the caller — indistinguishable from missing, by the same design as
 *  register-employee's own EmployeeNotFoundError), or another caller already advanced its version.
 *  Same pattern as PullShipments' own StaleVersionError. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}
