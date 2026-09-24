// modules/platform/tests/evaluate-alerts/invariants.property.test.ts — WBS 5.13 part 1, replicated
// from the golden slice (modules/wms/tests/receive-inbound/invariants.property.test.ts).
//
// Property tests (fast-check, >= 100 runs each — the fast-check default `numRuns`) for the pure
// domain invariants in modules/platform/domain/evaluate-alerts/invariants.ts (CLAUDE.md TESTING:
// "property tests on every invariant"). Pure: no I/O, no `new Date()`, no `Math.random()` — every
// function under test takes its clock/now as an explicit argument (CLAUDE.md · AGENT CONSTRAINTS).
//
// Expected new surface (RED until it exists):
//   modules/platform/domain/evaluate-alerts/invariants.ts
//     - `assertActionLinkPresent(rule: { readonly actionLabel: string; readonly actionLink: string
//       }): void` — doc 40 §B6 "An alert without an action link is impossible". Throws
//       ActionLinkMissingError (./errors.js) iff actionLabel is empty/whitespace-only OR actionLink
//       does not start with '/'; returns (no throw) otherwise.
//     - `isWithinQuietHours(now: Date, tz: string): boolean` — true iff `now`, converted to the
//       `tz` IANA zone, falls in [22:00, 07:00) local time (doc 25 §1: the window; doc 25 §1 names
//       NO timezone). fix round 1 (pg-reviewer finding 3): 'Asia/Riyadh' was a FABRICATED
//       attribution — the platform default timezone is 'Asia/Kuwait' (doc 40 §A3 ~L54). This test
//       exercises tz = 'Asia/Kuwait' only — also UTC+3, NO daylight-saving time, so local-hour
//       arithmetic below is still a fixed +3h offset, never a DST table. Takes `now` directly, not
//       a Clock — the caller (evaluate-alert-rules.ts) already has `deps.clock.now()` in hand.
//     - `isDeduped(lastFiredAt: Date | null, now: Date, windowHours: number): boolean` — false when
//       lastFiredAt is null (never fired before) or windowHours = 0 (doc 25 §1: "0 = no
//       suppression"); otherwise true iff (now - lastFiredAt) < windowHours worth of milliseconds.
//     - `shouldEvaluate(rule: { readonly isActive: boolean; readonly mutedUntil: Date | null },
//       now: Date): boolean` — false when !isActive or (mutedUntil !== null && mutedUntil > now);
//       true otherwise.
//
// Naming note for pg-backend: these four names and signatures are exactly what
// evaluate-alerts.test.ts (DB-backed) and this file import — a different name/arity is a test
// defect to fix here, not a builder decision to rename.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import {
  assertActionLinkPresent,
  isDeduped,
  isWithinQuietHours,
  shouldEvaluate,
} from '../../domain/evaluate-alerts/invariants.js';
import { ActionLinkMissingError } from '../../domain/evaluate-alerts/errors.js';

// doc 25 §1 — quiet hours are 22:00 <= local time < 07:00 (the WINDOW; doc 25 §1 names no
// timezone). fix round 1 (pg-reviewer finding 3): the platform's default timezone is
// 'Asia/Kuwait' (doc 40 §A3 ~L54) — UTC+3, no DST, same offset arithmetic 'Asia/Riyadh' would have
// had, but this is the CORRECTLY-CITED source.
const QUIET_HOURS_START_LOCAL_HOUR = 22;
const QUIET_HOURS_END_LOCAL_HOUR = 7;
const KUWAIT_UTC_OFFSET_HOURS = 3;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3_600_000;
const ALERT_QUIET_HOURS_TIMEZONE = 'Asia/Kuwait';

function kuwaitLocalMinutesOfDay(utc: Date): number {
  const utcMinutes = utc.getUTCHours() * MINUTES_PER_HOUR + utc.getUTCMinutes();
  const localMinutes = (utcMinutes + KUWAIT_UTC_OFFSET_HOURS * MINUTES_PER_HOUR) % (HOURS_PER_DAY * MINUTES_PER_HOUR);
  return localMinutes;
}

function expectedIsWithinQuietHours(utc: Date): boolean {
  const localMinutes = kuwaitLocalMinutesOfDay(utc);
  return (
    localMinutes >= QUIET_HOURS_START_LOCAL_HOUR * MINUTES_PER_HOUR ||
    localMinutes < QUIET_HOURS_END_LOCAL_HOUR * MINUTES_PER_HOUR
  );
}

const utcDateArb = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 11, 31) })
  .map((ms) => new Date(ms));

describe('assertActionLinkPresent — property (doc 40 §B6)', () => {
  it('never throws for a non-empty label and a link starting with "/"', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1 }).map((s) => `/${s}`),
        (actionLabel, actionLink) => {
          expect(() => assertActionLinkPresent({ actionLabel, actionLink })).not.toThrow();
        },
      ),
    );
  });

  it('always throws ActionLinkMissingError for an empty/whitespace-only actionLabel', () => {
    fc.assert(
      fc.property(fc.constantFrom('', ' ', '\t', '   \n  '), fc.string({ minLength: 1 }).map((s) => `/${s}`), (actionLabel, actionLink) => {
        expect(() => assertActionLinkPresent({ actionLabel, actionLink })).toThrow(ActionLinkMissingError);
      }),
    );
  });

  it('always throws ActionLinkMissingError when actionLink does not start with "/"', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        fc.string().filter((s) => !s.startsWith('/')),
        (actionLabel, actionLink) => {
          expect(() => assertActionLinkPresent({ actionLabel, actionLink })).toThrow(ActionLinkMissingError);
        },
      ),
    );
  });
});

describe('isWithinQuietHours — property (doc 25 §1 window, tz = Asia/Kuwait per doc 40 §A3)', () => {
  it('matches the independently-computed local-time window for any UTC instant', () => {
    fc.assert(
      fc.property(utcDateArb, (utc) => {
        expect(isWithinQuietHours(utc, ALERT_QUIET_HOURS_TIMEZONE)).toBe(expectedIsWithinQuietHours(utc));
      }),
    );
  });

  it('is true at exactly 22:00 local and false at exactly 07:00 local (boundary)', () => {
    // 22:00 Kuwait = 19:00 UTC same day; 07:00 Kuwait = 04:00 UTC same day (UTC+3, no DST).
    const startBoundary = new Date('2026-09-24T19:00:00.000Z');
    const endBoundary = new Date('2026-09-24T04:00:00.000Z');
    expect(isWithinQuietHours(startBoundary, ALERT_QUIET_HOURS_TIMEZONE)).toBe(true);
    expect(isWithinQuietHours(endBoundary, ALERT_QUIET_HOURS_TIMEZONE)).toBe(false);
  });
});

describe('isDeduped — property (doc 25 §1: dedupe_window_hours = 0 means no suppression)', () => {
  it('is always false when windowHours = 0, regardless of how recently it last fired', () => {
    fc.assert(
      fc.property(utcDateArb, fc.integer({ min: 0, max: 72 }), (now, agoHours) => {
        const lastFiredAt = new Date(now.getTime() - agoHours * MS_PER_HOUR);
        expect(isDeduped(lastFiredAt, now, 0)).toBe(false);
      }),
    );
  });

  it('is false when the rule has never fired before (lastFiredAt = null), for any window', () => {
    fc.assert(
      fc.property(utcDateArb, fc.integer({ min: 0, max: 1000 }), (now, windowHours) => {
        expect(isDeduped(null, now, windowHours)).toBe(false);
      }),
    );
  });

  it('is true iff elapsed time is strictly less than windowHours, for a non-zero window', () => {
    fc.assert(
      fc.property(utcDateArb, fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 2000 }), (now, windowHours, elapsedHours) => {
        const lastFiredAt = new Date(now.getTime() - elapsedHours * MS_PER_HOUR);
        expect(isDeduped(lastFiredAt, now, windowHours)).toBe(elapsedHours < windowHours);
      }),
    );
  });
});

describe('shouldEvaluate — property (is_active / muted_until gate)', () => {
  it('is always false when isActive is false, regardless of mutedUntil', () => {
    fc.assert(
      fc.property(utcDateArb, fc.option(utcDateArb, { nil: null }), (now, mutedUntil) => {
        expect(shouldEvaluate({ isActive: false, mutedUntil }, now)).toBe(false);
      }),
    );
  });

  it('is false when isActive is true but mutedUntil is strictly after now', () => {
    fc.assert(
      fc.property(utcDateArb, fc.integer({ min: 1, max: 100_000 }), (now, aheadMs) => {
        const mutedUntil = new Date(now.getTime() + aheadMs);
        expect(shouldEvaluate({ isActive: true, mutedUntil }, now)).toBe(false);
      }),
    );
  });

  it('is true when isActive is true and mutedUntil is null or not in the future', () => {
    fc.assert(
      fc.property(utcDateArb, fc.integer({ min: 0, max: 100_000 }), (now, agoMs) => {
        expect(shouldEvaluate({ isActive: true, mutedUntil: null }, now)).toBe(true);
        const mutedUntil = new Date(now.getTime() - agoMs);
        expect(shouldEvaluate({ isActive: true, mutedUntil }, now)).toBe(true);
      }),
    );
  });
});
