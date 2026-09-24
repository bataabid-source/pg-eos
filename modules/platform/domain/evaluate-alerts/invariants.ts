// modules/platform/domain/evaluate-alerts/invariants.ts — WBS 5.13 part 1, replicated (shape
// only) from the golden slice's invariants.ts. Pure: no I/O, no `new Date()`, no `Math.random()`
// (CLAUDE.md · AGENT CONSTRAINTS) — every function takes its clock/now as an explicit argument.
// The application layer (../../application/evaluate-alerts/evaluate-alert-rules.ts,
// acknowledge-alert.ts) calls these BEFORE any DB write; a failed invariant throws a typed error
// from ./errors.ts. pg-tester's property tests exercise these functions directly
// (tests/evaluate-alerts/invariants.property.test.ts).

import { ActionLinkMissingError } from './errors.js';

// doc 40 §A3 (~L54): the platform's own default timezone is Asia/Kuwait — doc 25 §1 names NO
// timezone for quiet_hours, so this constant borrows doc 40's platform-wide default rather than
// inventing one (pg-reviewer round-1 finding 3: NOT 'Asia/Riyadh', which no cited source names).
export const ALERT_QUIET_HOURS_TIMEZONE = 'Asia/Kuwait';
const QUIET_HOURS_START_LOCAL_HOUR = 22;
const QUIET_HOURS_END_LOCAL_HOUR = 7;
const MINUTES_PER_HOUR = 60;

// doc 25 §1: "0 = no suppression" for platform.alert_rules.dedupe_window_hours.
const DEDUPE_WINDOW_HOURS_NO_SUPPRESSION = 0;
const MS_PER_HOUR = 3_600_000;

const ACTION_LINK_REQUIRED_PREFIX = '/';

/** doc 40 §B6 "An alert without an action link is impossible" — throws ActionLinkMissingError iff
 *  `actionLabel` is empty/whitespace-only, or `actionLink` does not start with '/'. Returns (no
 *  throw) otherwise. */
export function assertActionLinkPresent(rule: { readonly actionLabel: string; readonly actionLink: string }): void {
  if (rule.actionLabel.trim().length === 0 || !rule.actionLink.startsWith(ACTION_LINK_REQUIRED_PREFIX)) {
    throw new ActionLinkMissingError(
      `alert rule action_label/action_link invalid: action_label=${JSON.stringify(rule.actionLabel)}, ` +
        `action_link=${JSON.stringify(rule.actionLink)} (doc 40 §B6: "An alert without an action ` +
        `link is impossible"). (Allowed: a non-empty label and a link starting with "/")`,
    );
  }
}

/** `now`'s instant, converted to the `tz` IANA zone, as minutes since local midnight. Uses the
 *  platform `Intl` API (never a hand-rolled fixed-offset table) so the same function is correct
 *  for any IANA zone, not just the seed's one DST-free timezone. Takes the already-read `now`
 *  directly (pg-reviewer finding 16) — never reads the clock itself, so a caller's one
 *  `deps.clock.now()` read and this decision always share the same instant. */
function localMinutesOfDay(now: Date, tz: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * MINUTES_PER_HOUR + minute;
}

/** doc 25 §1: true iff `now` falls in [22:00, 07:00) local time in `tz`. Takes `now: Date`
 *  directly (pg-reviewer finding 16) — never `Clock`, never a second clock read. */
export function isWithinQuietHours(now: Date, tz: string): boolean {
  const localMinutes = localMinutesOfDay(now, tz);
  return (
    localMinutes >= QUIET_HOURS_START_LOCAL_HOUR * MINUTES_PER_HOUR ||
    localMinutes < QUIET_HOURS_END_LOCAL_HOUR * MINUTES_PER_HOUR
  );
}

/** doc 25 §1: false when the rule never fired before (`lastFiredAt` null) or its
 *  `dedupe_window_hours` is 0 ("no suppression"); otherwise true iff the elapsed time since
 *  `lastFiredAt` is strictly less than `windowHours`. */
export function isDeduped(lastFiredAt: Date | null, now: Date, windowHours: number): boolean {
  if (lastFiredAt === null || windowHours === DEDUPE_WINDOW_HOURS_NO_SUPPRESSION) return false;
  const elapsedMs = now.getTime() - lastFiredAt.getTime();
  return elapsedMs < windowHours * MS_PER_HOUR;
}

/** false when the rule is not `is_active`, or its `muted_until` is still in the future relative
 *  to `now`; true otherwise (including `muted_until` null or already past). */
export function shouldEvaluate(
  rule: { readonly isActive: boolean; readonly mutedUntil: Date | null },
  now: Date,
): boolean {
  if (!rule.isActive) return false;
  if (rule.mutedUntil !== null && rule.mutedUntil.getTime() > now.getTime()) return false;
  return true;
}
