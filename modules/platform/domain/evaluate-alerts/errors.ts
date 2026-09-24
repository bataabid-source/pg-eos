// modules/platform/domain/evaluate-alerts/errors.ts — WBS 5.13 part 1, replicated (shape only)
// from the golden slice's errors.ts (modules/wms/domain/receive-inbound/errors.ts) — this use
// case's errors are alert evaluation/acknowledgement (doc 40 §B6, doc 25 §1), not inbound
// receiving.
//
// Every class sets `name` explicitly (CLAUDE.md · AGENT CONSTRAINTS) — an `Error` subclass does
// NOT get its constructor name for free at runtime. The api/ layer
// (../../api/evaluate-alerts/handlers.ts) maps these to the Problem envelope:
//   RoleRequiredError -> 403, StaleVersionError -> 409, AlertAlreadyAcknowledgedError -> 409,
//   ActionLinkMissingError -> 400, MissingActorError -> 422 (golden slice's own mapping),
//   AlertLogNotFoundError -> 404.

/** EvaluateAlertRules was called by a caller whose ctx.isInternal is false. platform.alert_log and
 *  identity.user_roles both carry an `internal_only` RLS policy keyed on platform.is_internal()
 *  (platform brief §2) — this is the proactive application-layer guard mirroring that policy,
 *  thrown BEFORE any row is written (doc 40 §B6). Maps to HTTP 403. */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** Optimistic-lock conflict: AcknowledgeAlert's `expectedVersion` no longer matches the locked
 *  platform.alert_log row's own `version` column (migration 0011: `version integer not null
 *  default 1`) — `UPDATE ... WHERE id=$1` would otherwise silently overwrite a concurrent change.
 *  Maps to HTTP 409. Message states what IS allowed (pg-reviewer finding 8). */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** AcknowledgeAlert was called against a platform.alert_log row whose ./machine.js offers no
 *  ACKNOWLEDGE edge from its current state (already acknowledged) — never a silent no-op. Maps to
 *  HTTP 409. Message states what IS allowed (pg-reviewer finding 8). */
export class AlertAlreadyAcknowledgedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertAlreadyAcknowledgedError';
  }
}

/** No platform.alert_log row is visible for the given id — it does not exist, or RLS hides it
 *  from the caller (an alert outside the caller's visibility is indistinguishable from a missing
 *  one, by design — same discipline as the golden slice's OrderNotFoundError). Maps to HTTP 404. */
export class AlertLogNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertLogNotFoundError';
  }
}

/** Every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to alert_log.acknowledged_by / audit_log.user_id (golden slice's own
 *  MissingActorError pattern, modules/wms/domain/receive-inbound/errors.ts). Maps to HTTP 422
 *  (the golden slice's own mapping for this error). */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** doc 40 §B6 "An alert without an action link is impossible" — a rule's actionLabel is
 *  empty/whitespace-only, or its actionLink does not start with '/'. Thrown by
 *  ./invariants.js's assertActionLinkPresent, before any DB write. Maps to HTTP 400. */
export class ActionLinkMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionLinkMissingError';
  }
}
