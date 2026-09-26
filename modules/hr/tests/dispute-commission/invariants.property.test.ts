// modules/hr/tests/dispute-commission/invariants.property.test.ts — WBS 3.13 part 4.
//
// Property tests (fast-check) for modules/hr/domain/dispute-commission/invariants.ts — the only
// pure domain logic this pair of commands needs beyond the shared XState machine's own `.can()`
// checks (brief, Deliver; task instructions: "if the ONLY pure logic is the shared XState machine's
// `.can()` checks, property-test the window-expiry boundary check itself").
//
// Surface this file pins (once GREEN and built):
//   modules/hr/domain/dispute-commission/invariants.ts
//     - isWithinDisputeWindow(createdAt: Date, now: Date, thresholdHours: number): boolean — pure,
//       no I/O, no Date.now()/new Date() internally (CLAUDE.md · AGENT CONSTRAINTS: "No
//       Math.random() / new Date() in domain/ — inject generator and clock"), returns true iff the
//       elapsed hours between createdAt and now is STRICTLY LESS THAN thresholdHours (brief
//       Scenario 1: "created LESS than 48 hours ago" -> disputable; Scenario 2: "created MORE than
//       48 hours ago" -> DisputeWindowExpiredError; confirm-commission's own "still inside its
//       window" / "past its window" scenarios are the exact logical negation of the same check).
//   modules/hr/domain/dispute-commission/machine.ts
//     - the shared commission-daily-status XState machine (brief decision 2: "may be SHARED ... a
//       single commission-daily-status machine both commands import"), consulted only through
//       `.can()` (CLAUDE.md · ARCHITECTURE: "No if/switch for state transitions — XState"). Edges
//       (brief decision 2): calculated -> disputed (DISPUTE), disputed -> confirmed (CONFIRM),
//       calculated -> confirmed (CONFIRM, the window-expiry auto-confirm path). `paid` is modelled
//       as a state with NO incoming edge this slice (brief decision 2: "confirmed -> paid ... OUT
//       OF SCOPE this part").

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — built and GREEN (see this module's own sibling test files' headers for
// the original two-layer RED→GREEN history).
import { isWithinDisputeWindow } from '../../domain/dispute-commission/invariants.js';
import {
  COMMISSION_DAILY_STATUS,
  COMMISSION_DAILY_EVENTS,
  canTransition,
  allowedEventsFrom,
} from '../../domain/dispute-commission/machine.js';

const HOURS_TO_MS = 60 * 60 * 1000;

describe('isWithinDisputeWindow — property (pure, no I/O, elapsed hours < thresholdHours)', () => {
  it('never throws for arbitrary createdAt/now/thresholdHours combinations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000 }), // elapsedHours magnitude
        fc.integer({ min: 1, max: 500 }), // thresholdHours (always positive — a real threshold)
        fc.boolean(), // now before or after createdAt (createdAt is always <= now in practice, but
        // the pure function itself must not throw on an out-of-order pair either)
        (elapsedHours, thresholdHours, reversed) => {
          const base = new Date('2024-06-01T00:00:00.000Z');
          const other = new Date(base.getTime() + elapsedHours * HOURS_TO_MS);
          const [createdAt, now] = reversed ? [other, base] : [base, other];
          expect(() => isWithinDisputeWindow(createdAt, now, thresholdHours)).not.toThrow();
        },
      ),
    );
  });

  it('returns true iff the elapsed hours between createdAt and now is strictly less than thresholdHours — independent oracle, real elapsed-ms division, never routed through the function under test', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 1, max: 200 }),
        (elapsedHours, thresholdHours) => {
          const createdAt = new Date('2024-06-01T00:00:00.000Z');
          const now = new Date(createdAt.getTime() + elapsedHours * HOURS_TO_MS);
          const elapsedMs = now.getTime() - createdAt.getTime();
          const expected = elapsedMs < thresholdHours * HOURS_TO_MS;

          expect(isWithinDisputeWindow(createdAt, now, thresholdHours)).toBe(expected);
        },
      ),
    );
  });

  it('the exact boundary (elapsed hours === thresholdHours) is NOT within the window (strict <, brief Scenario 2: "MORE than 48 hours ago" is the rejection case, so exactly-48 must not be silently treated as still-open)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (thresholdHours) => {
        const createdAt = new Date('2024-06-01T00:00:00.000Z');
        const now = new Date(createdAt.getTime() + thresholdHours * HOURS_TO_MS);
        expect(isWithinDisputeWindow(createdAt, now, thresholdHours)).toBe(false);
      }),
    );
  });

  it('one millisecond before the boundary is still within the window', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (thresholdHours) => {
        const createdAt = new Date('2024-06-01T00:00:00.000Z');
        const now = new Date(createdAt.getTime() + thresholdHours * HOURS_TO_MS - 1);
        expect(isWithinDisputeWindow(createdAt, now, thresholdHours)).toBe(true);
      }),
    );
  });

  it('createdAt === now is always within the window, for any positive thresholdHours', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (thresholdHours) => {
        const createdAt = new Date('2024-06-01T00:00:00.000Z');
        expect(isWithinDisputeWindow(createdAt, createdAt, thresholdHours)).toBe(true);
      }),
    );
  });

  // concrete example from the feature's own scenarios (48-hour threshold, brief).
  it('concrete: created 47 hours ago, threshold 48 -> within window (disputable)', () => {
    const createdAt = new Date('2024-06-01T00:00:00.000Z');
    const now = new Date('2024-06-02T23:00:00.000Z'); // +47h
    expect(isWithinDisputeWindow(createdAt, now, 48)).toBe(true);
  });

  it('concrete: created 49 hours ago, threshold 48 -> window expired', () => {
    const createdAt = new Date('2024-06-01T00:00:00.000Z');
    const now = new Date('2024-06-03T01:00:00.000Z'); // +49h
    expect(isWithinDisputeWindow(createdAt, now, 48)).toBe(false);
  });
});

// --- the shared commission-daily-status machine — every legal/illegal transition, exhaustively ---
// (finite, small state space — enumerated directly rather than through fc, same as this module's
// own register-employee/invariants precedent would if it tested its machine directly; wrapped in a
// property assertion over the full state x event cross-product so no combination is silently
// skipped).

describe('the shared commission-daily-status machine — canTransition/allowedEventsFrom (brief decision 2 edges only, no if/switch consulted anywhere outside this pure check)', () => {
  const ALL_STATES = Object.values(COMMISSION_DAILY_STATUS);
  const ALL_EVENTS = Object.values(COMMISSION_DAILY_EVENTS);

  // brief decision 2's own edges, verbatim: calculated -> disputed (DISPUTE), disputed ->
  // confirmed (CONFIRM), calculated -> confirmed (CONFIRM). Every other (state, event) pair in the
  // full cross-product below must be illegal.
  const LEGAL_PAIRS = new Set([
    `${COMMISSION_DAILY_STATUS.CALCULATED}:${COMMISSION_DAILY_EVENTS.DISPUTE}`,
    `${COMMISSION_DAILY_STATUS.CALCULATED}:${COMMISSION_DAILY_EVENTS.CONFIRM}`,
    `${COMMISSION_DAILY_STATUS.DISPUTED}:${COMMISSION_DAILY_EVENTS.CONFIRM}`,
  ]);

  it('matches the brief\'s own edge table exactly — no undocumented transition is legal, no documented one is missing', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const expected = LEGAL_PAIRS.has(`${state}:${event}`);
        expect(canTransition(state, event)).toBe(expected);
      }
    }
  });

  it('allowedEventsFrom("calculated") is exactly [DISPUTE, CONFIRM] (order-independent)', () => {
    expect(new Set(allowedEventsFrom(COMMISSION_DAILY_STATUS.CALCULATED))).toEqual(
      new Set([COMMISSION_DAILY_EVENTS.DISPUTE, COMMISSION_DAILY_EVENTS.CONFIRM]),
    );
  });

  it('allowedEventsFrom("disputed") is exactly [CONFIRM] — DISPUTE is not legal twice', () => {
    expect(allowedEventsFrom(COMMISSION_DAILY_STATUS.DISPUTED)).toEqual([COMMISSION_DAILY_EVENTS.CONFIRM]);
  });

  it('allowedEventsFrom("confirmed") is empty this slice (brief decision 2: confirmed -> paid is out of scope)', () => {
    expect(allowedEventsFrom(COMMISSION_DAILY_STATUS.CONFIRMED)).toEqual([]);
  });

  it('allowedEventsFrom("paid") is empty — paid has no outgoing edge modelled this slice', () => {
    expect(allowedEventsFrom(COMMISSION_DAILY_STATUS.PAID)).toEqual([]);
  });
});
