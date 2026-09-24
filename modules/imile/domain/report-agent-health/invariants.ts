// modules/imile/domain/report-agent-health/invariants.ts — WBS 3.14.
//
// domain/ layer: pure invariant checks — no I/O, no Date.now()/new Date(), no Math.random()
// (CLAUDE.md · AGENT CONSTRAINTS). The application layer
// (../../application/report-agent-health/report-agent-health.ts) calls these BEFORE any DB write;
// a failed invariant throws a typed error from ./errors.ts. pg-tester adds property tests against
// these functions directly (../../tests/report-agent-health/invariants.property.test.ts).

import { LastPullInFutureError, SessionInvalidWithoutReasonError } from './errors.js';

/** doc 40 §C8 health heartbeat: `sessionValid === false` requires a non-empty `errorMessage`.
 *  Never throws when `sessionValid === true`, regardless of `errorMessage`. */
export function assertSessionValidHasReason(
  sessionValid: boolean,
  errorMessage: string | null | undefined,
): void {
  if (sessionValid === false && (errorMessage === null || errorMessage === undefined || errorMessage.length === 0)) {
    throw new SessionInvalidWithoutReasonError(
      'sessionValid=false requires a non-empty errorMessage. (Allowed: sessionValid=true with any ' +
        'errorMessage, or sessionValid=false with a non-empty errorMessage)',
    );
  }
}

/** `lastPullAt` (when not null) must never be strictly after `reportedAt`. Never throws when
 *  `lastPullAt` is null or `lastPullAt <= reportedAt`. */
export function assertLastPullNotInFuture(lastPullAt: Date | null, reportedAt: Date): void {
  if (lastPullAt !== null && lastPullAt.getTime() > reportedAt.getTime()) {
    throw new LastPullInFutureError(
      `lastPullAt (${lastPullAt.toISOString()}) is after reportedAt (${reportedAt.toISOString()}). ` +
        '(Allowed: lastPullAt null, or lastPullAt <= reportedAt)',
    );
  }
}
