// modules/fleet/tests/register-vehicle/invariants.property.test.ts — WBS 3.1.
//
// Property tests (fast-check) for the pure domain invariant in
// modules/fleet/domain/register-vehicle/invariants.ts — doc 40 INV-C4-1's vehicle half:
// "vehicle with expired document, cannot be assigned". `canBeAssigned` (application/domain result)
// is `NOT hasExpiredDocument(documents, asOf)`, so pinning `hasExpiredDocument`'s own behaviour here
// pins the gate itself.
//
// Expected new surface (RED until it exists):
//   modules/fleet/domain/register-vehicle/invariants.ts
//     - `hasExpiredDocument(documents: readonly { expiryDate: string }[], asOf: Date): boolean` —
//       pure (no I/O, no Date.now()/new Date(), no Math.random() — CLAUDE.md · AGENT CONSTRAINTS),
//       true iff ANY document's expiryDate is strictly before `asOf`'s Kuwait-local calendar date
//       (pg-reviewer round 1, Finding 1 — production comparison is done on plain `YYYY-MM-DD`
//       Kuwait-local calendar-date strings, never a raw instant/timestamp comparison). Never throws
//       for any input.
//
// pg-reviewer round 2, Finding 1: `documents[i].expiryDate` is a `YYYY-MM-DD` string in production
// (packages/contracts/fleet/register-vehicle.ts uses `z.iso.date()`) — feeding bare
// `.toISOString()` output (a full timestamp, e.g. `2026-09-25T00:00:00.000Z`) is an input shape
// production never sees. It also has a real bug: `fc.date()`'s default range includes years whose
// `.toISOString()` uses the signed extended-year format (e.g. `"+010000-01-01T..."`), and `"+"`
// sorts BEFORE any digit lexicographically, so a document expiring in year 10000 would misread as
// already-expired under a plain string comparison. Fixed with a standard bounded-arbitrary
// technique for this class of bug: every generated date is reduced to a whole-day offset from a
// fixed, bounded reference instant (never `fc.date()`'s own unbounded default range), then sliced
// to a plain `YYYY-MM-DD` date string with `.slice(0, 10)`.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hasExpiredDocument } from '../../domain/register-vehicle/invariants.js';

// 2026-09-25T00:00:00.000Z is UTC midnight; Kuwait (UTC+3) reads this as 2026-09-25T03:00 local —
// same calendar day, so the Kuwait-local "today" for this AS_OF is unambiguously '2026-09-25'.
const AS_OF = new Date('2026-09-25T00:00:00.000Z');
const AS_OF_KUWAIT_TODAY = '2026-09-25';

const MAX_DOCUMENTS_PER_RUN = 10;
const MAX_SURROUNDING_DOCUMENTS = 5;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Bounded day-offset range — the generated instant's `.toISOString()` always uses the plain 4-digit
// year format (never the signed extended-year format that broke plain string comparison).
const MAX_DAY_OFFSET = 3650;

/** A `YYYY-MM-DD` string strictly AFTER AS_OF's own Kuwait-local calendar date — whole-day offsets
 *  only, so the result is never ambiguous relative to a timezone boundary. */
function futureDateStringArb(): fc.Arbitrary<string> {
  return fc
    .integer({ min: 1, max: MAX_DAY_OFFSET })
    .map((days) => new Date(AS_OF.getTime() + days * ONE_DAY_MS).toISOString().slice(0, 10));
}

/** A `YYYY-MM-DD` string strictly BEFORE AS_OF's own Kuwait-local calendar date. */
function pastDateStringArb(): fc.Arbitrary<string> {
  return fc
    .integer({ min: 1, max: MAX_DAY_OFFSET })
    .map((days) => new Date(AS_OF.getTime() - days * ONE_DAY_MS).toISOString().slice(0, 10));
}

describe('hasExpiredDocument — property (pure, doc 40 INV-C4-1 vehicle half)', () => {
  it('returns false for an empty document array — vacuously true for canBeAssigned', () => {
    expect(hasExpiredDocument([], AS_OF)).toBe(false);
  });

  it('returns false whenever every document expiryDate is strictly in the future (Kuwait-local calendar date)', () => {
    fc.assert(
      fc.property(
        fc.array(futureDateStringArb(), { minLength: 0, maxLength: MAX_DOCUMENTS_PER_RUN }),
        (dates) => {
          const documents = dates.map((expiryDate) => ({ expiryDate }));
          expect(hasExpiredDocument(documents, AS_OF)).toBe(false);
        },
      ),
    );
  });

  it('returns true whenever at least one document expiryDate is strictly in the past, surrounded by any number of future ones on either side', () => {
    fc.assert(
      fc.property(
        fc.array(futureDateStringArb(), { minLength: 0, maxLength: MAX_SURROUNDING_DOCUMENTS }),
        pastDateStringArb(),
        fc.array(futureDateStringArb(), { minLength: 0, maxLength: MAX_SURROUNDING_DOCUMENTS }),
        (before, expiredOne, after) => {
          const documents = [...before, expiredOne, ...after].map((expiryDate) => ({ expiryDate }));
          expect(hasExpiredDocument(documents, AS_OF)).toBe(true);
        },
      ),
    );
  });

  it('never throws for arbitrary garbage input', () => {
    fc.assert(
      fc.property(fc.anything(), fc.date({ noInvalidDate: true }), (garbage, asOf) => {
        expect(() =>
          hasExpiredDocument(garbage as unknown as readonly { expiryDate: string }[], asOf),
        ).not.toThrow();
      }),
    );
  });

  // --- boundary cases (pg-reviewer round 2, Finding 1) -------------------------------------------

  it('a document expiring exactly on AS_OF\'s Kuwait-local "today" is NOT expired', () => {
    expect(hasExpiredDocument([{ expiryDate: AS_OF_KUWAIT_TODAY }], AS_OF)).toBe(false);
  });

  it('a document expiring exactly yesterday (Kuwait-local) IS expired', () => {
    const yesterday = new Date(AS_OF.getTime() - ONE_DAY_MS).toISOString().slice(0, 10);
    expect(hasExpiredDocument([{ expiryDate: yesterday }], AS_OF)).toBe(true);
  });

  it('reads the gate relative to Kuwait\'s local calendar date, not UTC\'s, when the clock\'s UTC instant is late in the day (21:00-23:59 UTC, so Kuwait\'s local date is already the next day)', () => {
    // 22:00 UTC + 3h (Kuwait) = 01:00 the next day local — Kuwait's own calendar date is already
    // '2026-09-26', one day ahead of the UTC calendar date '2026-09-25'.
    const lateUtcAsOf = new Date('2026-09-25T22:00:00.000Z');

    // A document expiring on the UTC calendar date ('2026-09-25') is, per Kuwait's OWN date
    // ('2026-09-26'), already in the past — IS expired. A UTC-date comparison would have wrongly
    // read this as "today" (not expired).
    expect(hasExpiredDocument([{ expiryDate: '2026-09-25' }], lateUtcAsOf)).toBe(true);

    // A document expiring on Kuwait's own current calendar date ('2026-09-26') is NOT expired.
    expect(hasExpiredDocument([{ expiryDate: '2026-09-26' }], lateUtcAsOf)).toBe(false);
  });
});
