// modules/hr/domain/confirm-commission/errors.ts — WBS 3.13 part 4.
//
// Typed errors for the ConfirmCommission use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS). The api/ layer (../../api/confirm-commission/handlers.ts) maps each to the
// Problem envelope. The shared state machine lives in
// ../dispute-commission/machine.ts (brief decision 2: "may be SHARED ... a single
// commission-daily-status machine both commands import") — this use case's own errors.ts only
// carries the two typed errors unique to ConfirmCommission (brief, Deliver).

/** every command's actor is `ctx.userId` ONLY — same discipline as this module's own
 *  dispute-commission/calculate-daily-commission precedents. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** brief decision 3 / doc 10 §14 (l.300): the caller (`ctx.userId`) resolves — via
 *  `identity.users.id = ctx.userId and identity.users.employee_id = <the row's own employee_id>`
 *  — to the SAME employee that owns the row being confirmed. A driver cannot confirm/resolve their
 *  own dispute; only DEL_SUP (or another non-owning internal actor) may. Checked at the
 *  APPLICATION layer BEFORE attempting the transition, so a real actor gets this typed error
 *  instead of the DB-level `hr.guard_commission_daily_status()` trigger's own raw rejection (the
 *  trigger stays as an independent backstop, migration 0033 — defense in depth, not the only line
 *  of defense). Maps to HTTP 403 (SoD — the actor lacks the privilege to act on their own row this
 *  way; a LOCAL status constant in ../../api/confirm-commission/handlers.ts, not the frozen shared
 *  packages/contracts/_shared/problem.ts PROBLEM_STATUS, which names only 400/409/422). */
export class SelfReviewNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfReviewNotAllowedError';
  }
}

/** SCR-HR-COMM-01 (APPROVED, D-190) / migration 0033's own
 *  `hr.guard_commission_daily_status()` trigger, round-4 review finding 3: resolving an ACTIVE
 *  DISPUTE (`disputed -> confirmed`) is a DEL_SUP-only act, doc 10 §14 (l.300) — gated by the
 *  `hr.commission.confirm` permission (seeded to DEL_SUP), checked via `platform.has_perm()`, the
 *  SAME mechanism every other authorization check in this codebase uses. Scoped to EXACTLY that one
 *  edge — the trigger does not require this permission on the plain `calculated -> confirmed`
 *  window-expiry auto-confirm path (no document makes DEL_SUP a gate on that path), so this
 *  application-layer check is likewise scoped to exactly that one edge — via the shared machine's
 *  `stateHasTag(row.status, COMMISSION_DAILY_TAGS.REQUIRES_CONFIRM_PERMISSION)` (round-1 slice-close
 *  review finding 1: no if/switch on the status string), never a direct status-string comparison,
 *  and never applied to the auto-confirm edge.
 *
 *  A DISTINCT class from `SelfReviewNotAllowedError` above, not a repurposed/renamed one: the two
 *  represent different refusal reasons an API consumer needs to tell apart (an owning-employee
 *  self-review attempt vs. a non-owning actor who simply lacks the DEL_SUP write permission) — both
 *  independently guarded by the SAME DB trigger, but for different rules (self-review binds to
 *  `ctx.userId`'s own employee_id; this one binds to a granted permission), so collapsing them into
 *  one class would hide which rule actually fired. Checked at the APPLICATION layer BEFORE
 *  attempting the transition, so a real actor gets this typed error instead of the DB-level
 *  trigger's own raw 42501/insufficient_privilege rejection (the trigger stays as an independent
 *  backstop — defense in depth, not the only line of defense). Maps to HTTP 403 (a LOCAL status
 *  constant in ../../api/confirm-commission/handlers.ts, same discipline as
 *  SelfReviewNotAllowedError above). */
export class ConfirmPermissionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmPermissionRequiredError';
  }
}

/** brief, Deliver: the target row is still 'calculated' and its own 48-hour dispute window
 *  (platform.thresholds `hr.commission.dispute_window_hours`) has NOT yet elapsed — confirming a
 *  'calculated' row too early (skipping 'disputed' entirely) is refused, the exact logical
 *  negation of DisputeCommission's own DisputeWindowExpiredError check
 *  (../dispute-commission/invariants.js's `isWithinDisputeWindow`). A 'disputed' row needs no such
 *  check (a DEL_SUP reviewing an active dispute may confirm any time, brief decision 2). Maps to
 *  HTTP 409 (a real conflict — the window has not yet closed). */
export class DisputeWindowStillOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeWindowStillOpenError';
  }
}

/** The shared commission-daily-status machine (../dispute-commission/machine.ts) rejected the
 *  CONFIRM event from the row's current status (e.g. already 'confirmed'/'paid') — ConfirmCommission
 *  only ever transitions a 'calculated' or 'disputed' row. Maps to HTTP 422. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** Optimistic-lock conflict: `UPDATE ... WHERE id=$1 AND version=$2` matched zero rows — either no
 *  hr.commission_daily row is visible for this id (does not exist, or RLS's own `own_commission`
 *  policy hides it from the caller), or another caller already advanced its version. Same pattern
 *  as PullShipments' own StaleVersionError. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}
