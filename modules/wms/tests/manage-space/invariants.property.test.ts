// modules/wms/tests/manage-space/invariants.property.test.ts — WBS 2.15 (lane 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/wms/domain/manage-space/invariants.ts — one property per invariant the brief lists
// (docs/notes/slice-briefs/_slice-2.15.brief.md, "Property tests" section, P1/P2).
//
// Expected new surface (RED until it exists):
//   modules/wms/domain/manage-space/invariants.ts
//     - `isWithinMaxDuration(reservedFrom: string, expiresAt: string, maxDays: number): boolean`
//       — D4: true iff `(expiresAt - reservedFrom) <= maxDays`, both `reservedFrom`/`expiresAt`
//       ISO date strings ('YYYY-MM-DD', same shape as the contract's `z.iso.date()`). Pure: no I/O,
//       no Date.now(), no Math.random() (CLAUDE.md · AGENT CONSTRAINTS — both dates are ALWAYS
//       caller-supplied arguments, never read from the system clock inside this function).
//     - `isPositiveQty(qty: number): boolean` — D7: true iff `qty > 0`. `wms.space_reservations.qty`
//       has NO DB-level positive-qty CHECK (unlike `space_allocations.qty`'s `positive_qty`
//       constraint) — this function is therefore the ONLY enforcement for ReserveSpace, not
//       redundant belt-and-braces.
//     - `isValidReservationRange(reservedFrom: string, expiresAt: string): boolean` — round-2
//       review finding 1: true iff `expiresAt > reservedFrom` (a zero/negative duration is
//       invalid), both ISO date strings ('YYYY-MM-DD'). Pure: no I/O, no Date.now(),
//       no Math.random(). Called from reserve-space.ts, throwing the existing
//       ReservationDateRangeInvalidError on false — see the "Finding 3" scenario in
//       manage-space.test.ts, which already asserts the application-level behaviour; this file
//       asserts the pure predicate itself.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import {
  hasValidQtyScale,
  isPositiveQty,
  isValidReservationRange,
  isWithinMaxDuration,
  QTY_DB_SCALE,
} from '../../domain/manage-space/invariants.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoDateOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function diffDays(reservedFrom: string, expiresAt: string): number {
  const from = new Date(`${reservedFrom}T00:00:00.000Z`).getTime();
  const to = new Date(`${expiresAt}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / MS_PER_DAY);
}

// --- P1: isWithinMaxDuration ---------------------------------------------------------------------

describe('isWithinMaxDuration — property P1 (brief): (expiresAt - reservedFrom) <= maxDays', () => {
  it('for any (reservedFrom, expiresAt, maxDays), isWithinMaxDuration ⇔ (expiresAt - reservedFrom) <= maxDays', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true }),
        fc.integer({ min: 1, max: 3650 }), // duration in days, always positive (expiresAt after reservedFrom).
        fc.integer({ min: 0, max: 3650 }), // maxDays.
        (reservedFromInstant, durationDays, maxDays) => {
          const reservedFrom = isoDateOf(reservedFromInstant);
          const expiresAt = isoDateOf(new Date(reservedFromInstant.getTime() + durationDays * MS_PER_DAY));
          const actualDuration = diffDays(reservedFrom, expiresAt);
          expect(isWithinMaxDuration(reservedFrom, expiresAt, maxDays)).toBe(actualDuration <= maxDays);
        },
      ),
    );
  });

  it('at the exact boundary (duration === maxDays) is within — inclusive, not exclusive', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true }),
        fc.integer({ min: 1, max: 3650 }),
        (reservedFromInstant, maxDays) => {
          const reservedFrom = isoDateOf(reservedFromInstant);
          const expiresAt = isoDateOf(new Date(reservedFromInstant.getTime() + maxDays * MS_PER_DAY));
          expect(isWithinMaxDuration(reservedFrom, expiresAt, maxDays)).toBe(true);
        },
      ),
    );
  });

  it('one day beyond maxDays is NOT within', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true }),
        fc.integer({ min: 0, max: 3650 }),
        (reservedFromInstant, maxDays) => {
          const reservedFrom = isoDateOf(reservedFromInstant);
          const expiresAt = isoDateOf(new Date(reservedFromInstant.getTime() + (maxDays + 1) * MS_PER_DAY));
          expect(isWithinMaxDuration(reservedFrom, expiresAt, maxDays)).toBe(false);
        },
      ),
    );
  });
});

// --- P2: isPositiveQty -----------------------------------------------------------------------------

describe('isPositiveQty — property P2 (brief): isPositiveQty(qty) ⇔ qty > 0', () => {
  it('for any qty, isPositiveQty ⇔ qty > 0', () => {
    fc.assert(
      fc.property(fc.float({ min: Math.fround(-1_000_000), max: Math.fround(1_000_000), noNaN: true }), (qty) => {
        expect(isPositiveQty(qty)).toBe(qty > 0);
      }),
    );
  });

  it('zero is NOT positive', () => {
    expect(isPositiveQty(0)).toBe(false);
  });

  it('any strictly positive qty is positive', () => {
    fc.assert(
      fc.property(fc.float({ min: Math.fround(0.001), max: Math.fround(1_000_000), noNaN: true }), (qty) => {
        fc.pre(qty > 0);
        expect(isPositiveQty(qty)).toBe(true);
      }),
    );
  });

  it('any negative qty is not positive', () => {
    fc.assert(
      fc.property(fc.float({ min: Math.fround(-1_000_000), max: Math.fround(-0.001), noNaN: true }), (qty) => {
        fc.pre(qty < 0);
        expect(isPositiveQty(qty)).toBe(false);
      }),
    );
  });
});

// --- P3: isValidReservationRange (round-2 review finding 1) ----------------------------------------

describe('isValidReservationRange — property P3 (round-2 review finding 1): isValidReservationRange(reservedFrom, expiresAt) ⇔ expiresAt > reservedFrom', () => {
  it('for any reservedFrom and any expiresAt <= reservedFrom, isValidReservationRange is false', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true }),
        fc.integer({ min: 0, max: 3650 }), // days BEFORE or AT reservedFrom (0 = same day, zero duration).
        (reservedFromInstant, daysBeforeOrAt) => {
          const reservedFrom = isoDateOf(reservedFromInstant);
          const expiresAt = isoDateOf(new Date(reservedFromInstant.getTime() - daysBeforeOrAt * MS_PER_DAY));
          expect(isValidReservationRange(reservedFrom, expiresAt)).toBe(false);
        },
      ),
    );
  });

  it('for any reservedFrom and any expiresAt > reservedFrom, isValidReservationRange is true', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true }),
        fc.integer({ min: 1, max: 3650 }), // days strictly AFTER reservedFrom.
        (reservedFromInstant, daysAfter) => {
          const reservedFrom = isoDateOf(reservedFromInstant);
          const expiresAt = isoDateOf(new Date(reservedFromInstant.getTime() + daysAfter * MS_PER_DAY));
          expect(isValidReservationRange(reservedFrom, expiresAt)).toBe(true);
        },
      ),
    );
  });

  it('zero duration (expiresAt === reservedFrom) is false — the exact boundary', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true }),
        (reservedFromInstant) => {
          const reservedFrom = isoDateOf(reservedFromInstant);
          expect(isValidReservationRange(reservedFrom, reservedFrom)).toBe(false);
        },
      ),
    );
  });
});

// --- P4: hasValidQtyScale (round-4 review finding · round-5 review gap) -----------------------------
//
// `wms.space_allocations.qty` and `wms.space_reservations.qty` are both `numeric(14,3)` (13B):
// hasValidQtyScale(qty) is true iff qty is finite and has at most 3 decimals, i.e. the column stores
// exactly the value asked for. Integer generators use fast-check's default 32-bit range, so
// `n * 10 ** QTY_DB_SCALE` stays well inside Number.MAX_SAFE_INTEGER (exact double arithmetic).

describe('hasValidQtyScale — property P4 (round-4 review finding): finite and at most numeric(14,3) scale', () => {
  it('QTY_DB_SCALE mirrors the numeric(14,3) scale of wms.space_allocations.qty / wms.space_reservations.qty', () => {
    expect(QTY_DB_SCALE).toBe(3);
  });

  it('for any integer n and k in 0..3, hasValidQtyScale(n / 10**k) is true', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 0, max: QTY_DB_SCALE }), (n, k) => {
        expect(hasValidQtyScale(n / 10 ** k)).toBe(true);
      }),
    );
  });

  it('for any value with a non-zero 4th decimal, hasValidQtyScale is false', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }), // whole thousandths: the value's first 3 decimals and integer part.
        fc.integer({ min: 1, max: 9 }), // the 4th decimal digit — never zero.
        fc.integer({ min: 0, max: 9 }), // an optional 5th decimal digit.
        fc.boolean(), // sign.
        (thousandths, fourthDecimal, fifthDecimal, negative) => {
          const magnitude = (thousandths * 100 + fourthDecimal * 10 + fifthDecimal) / 100_000;
          const qty = negative ? -magnitude : magnitude;
          expect(hasValidQtyScale(qty)).toBe(false);
        },
      ),
    );
  });

  it('0.0004 (positive, yet stored as 0.000 by numeric(14,3)) is false', () => {
    expect(hasValidQtyScale(0.0004)).toBe(false);
  });

  it('NaN and ±Infinity are false', () => {
    fc.assert(
      fc.property(fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY), (qty) => {
        expect(hasValidQtyScale(qty)).toBe(false);
      }),
    );
    expect(hasValidQtyScale(Number.NaN)).toBe(false);
    expect(hasValidQtyScale(Number.POSITIVE_INFINITY)).toBe(false);
    expect(hasValidQtyScale(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});
