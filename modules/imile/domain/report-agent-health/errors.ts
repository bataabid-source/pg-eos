// modules/imile/domain/report-agent-health/errors.ts — WBS 3.14.
//
// Typed errors for the report-agent-health use case. Every class sets `name` explicitly (CLAUDE.md
// · AGENT CONSTRAINTS; same discipline as modules/wms/domain/receive-inbound/errors.ts) — an
// `Error` subclass does NOT get its constructor name for free at runtime. The api/ layer
// (../../api/report-agent-health/handlers.ts) maps these to the Problem envelope.

/** doc 40 §C8 health heartbeat: `sessionValid=false` requires a non-empty `errorMessage`. Thrown
 *  BEFORE any DB write. Maps to HTTP 422. */
export class SessionInvalidWithoutReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInvalidWithoutReasonError';
  }
}

/** `lastPullAt` (when supplied) must never be after `reportedAt` (= deps.clock.now() at call
 *  time) — a pull cannot be reported as happening in the future. Thrown BEFORE any DB write. Maps
 *  to HTTP 422. */
export class LastPullInFutureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LastPullInFutureError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to imile.agent_health / audit rows (same discipline as the golden
 *  slice's MissingActorError). */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}
