// modules/hr/domain/dispute-commission/invariants.ts — WBS 3.13 part 4.
//
// Pure domain logic beyond the shared XState machine's own `.can()` checks: the 48-hour (never a
// literal `48` — CLAUDE.md · AGENT CONSTRAINTS "no magic numbers") dispute-window boundary check,
// shared by both DisputeCommission (a row created less than `thresholdHours` ago is disputable)
// and ConfirmCommission (a 'calculated' row is only auto-confirmable once the SAME window has
// elapsed — the exact logical negation).
//
// No I/O, no Date.now()/new Date() internally (CLAUDE.md · AGENT CONSTRAINTS) — `createdAt`/`now`
// are both passed in, never read from a clock here; the application layer is the only place that
// reads deps.clock.now().

const HOURS_TO_MS = 60 * 60 * 1000;

/** True iff the elapsed time between `createdAt` and `now` is STRICTLY LESS THAN `thresholdHours`
 *  (brief Scenario 1: "created LESS than 48 hours ago" -> disputable; Scenario 2: "created MORE
 *  than 48 hours ago" -> DisputeWindowExpiredError). The exact boundary (elapsed === threshold) is
 *  NOT within the window — strict `<`, never `<=`. Pure: never throws, works for any ordering of
 *  the two dates (a reversed pair simply yields a negative or zero elapsed value, still compared
 *  the same way). */
export function isWithinDisputeWindow(createdAt: Date, now: Date, thresholdHours: number): boolean {
  const elapsedMs = now.getTime() - createdAt.getTime();
  return elapsedMs < thresholdHours * HOURS_TO_MS;
}
