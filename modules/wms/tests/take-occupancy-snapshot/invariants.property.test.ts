// modules/wms/tests/take-occupancy-snapshot/invariants.property.test.ts — WBS 2.14 (lane 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/wms/domain/take-occupancy-snapshot/invariants.ts — one property per invariant the brief
// lists (docs/notes/slice-briefs/_slice-2.14.brief.md, "Property tests" section, P1/P2).
//
// Expected new surface (RED until it exists):
//   modules/wms/domain/take-occupancy-snapshot/invariants.ts
//     - `overflowQty(occupied: number, contracted: number): number` — D3/D4: the excess of occupied
//       pallets over the contracted capacity, `occupied - contracted` when occupied > contracted,
//       else 0 (never negative — a client within or exactly at capacity has no overflow).
//     - `countOccupiedLocations(rows: readonly OccupiedLocationRow[], opts?: { readonly typeFilter?:
//       string }): number` — D2: counts rows whose `occupied` flag is true, additionally filtered
//       to `type === opts.typeFilter` when a typeFilter is supplied. Pure: no I/O, no Date, no
//       Math.random() (CLAUDE.md · AGENT CONSTRAINTS).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import { countOccupiedLocations, overflowQty, businessDateOf, type OccupiedLocationRow } from '../../domain/take-occupancy-snapshot/invariants.js';

// --- P1: overflowQty ---------------------------------------------------------------------------

describe('overflowQty — property P1 (brief)', () => {
  it('returns occupied - contracted when occupied > contracted', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (occupied, contracted) => {
        fc.pre(occupied > contracted);
        expect(overflowQty(occupied, contracted)).toBe(occupied - contracted);
      }),
    );
  });

  it('returns 0 when occupied <= contracted — never negative', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (occupied, contracted) => {
        fc.pre(occupied <= contracted);
        expect(overflowQty(occupied, contracted)).toBe(0);
      }),
    );
  });

  it('never returns a negative number, for ANY non-negative pair', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (occupied, contracted) => {
        expect(overflowQty(occupied, contracted)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

// --- P2: countOccupiedLocations ------------------------------------------------------------------

const LOCATION_TYPES = ['pallet', 'shelf', 'floor', 'mezzanine', 'bulk'] as const;

const locationRowArb: fc.Arbitrary<OccupiedLocationRow> = fc.record({
  type: fc.constantFrom(...LOCATION_TYPES),
  occupied: fc.boolean(),
});

describe('countOccupiedLocations — property P2 (brief)', () => {
  it('with no typeFilter, counts exactly the rows whose occupied flag is true', () => {
    fc.assert(
      fc.property(fc.array(locationRowArb, { maxLength: 200 }), (rows) => {
        const expected = rows.filter((row) => row.occupied).length;
        expect(countOccupiedLocations(rows)).toBe(expected);
      }),
    );
  });

  it('with a typeFilter, counts only rows matching BOTH occupied=true AND that type', () => {
    fc.assert(
      fc.property(fc.array(locationRowArb, { maxLength: 200 }), fc.constantFrom(...LOCATION_TYPES), (rows, typeFilter) => {
        const expected = rows.filter((row) => row.occupied && row.type === typeFilter).length;
        expect(countOccupiedLocations(rows, { typeFilter })).toBe(expected);
      }),
    );
  });

  it('an empty row set counts 0, with or without a typeFilter', () => {
    expect(countOccupiedLocations([])).toBe(0);
    expect(countOccupiedLocations([], { typeFilter: 'pallet' })).toBe(0);
  });

  it('a typeFilter matching no row in the set counts 0', () => {
    fc.assert(
      fc.property(fc.array(locationRowArb.filter((row) => row.type !== 'bulk'), { maxLength: 200 }), (rows) => {
        expect(countOccupiedLocations(rows, { typeFilter: 'bulk' })).toBe(0);
      }),
    );
  });
});

// --- D6/businessDateOf — round-1 review finding 3 (never exercised by any existing test, every
// prior scenario in take-occupancy-snapshot.test.ts passes snapshotDate explicitly) --------------
//
// Asia/Kuwait carries a fixed UTC+3 offset year-round (no DST — invariants.ts's own comment). The
// Kuwait business date rolls over at 21:00 UTC (= 00:00 Kuwait local time the next day).

describe('businessDateOf — Asia/Kuwait (UTC+3, no DST) business-date rollover', () => {
  it('21:00:00.000 UTC minus 1ms is still the SAME UTC calendar day in Kuwait (20:59:59.999 UTC -> 23:59:59.999 Kuwait)', () => {
    expect(businessDateOf(new Date('2026-09-25T20:59:59.999Z'))).toBe('2026-09-25');
  });

  it('21:00:00.000 UTC is already the NEXT Kuwait calendar day (00:00:00.000 Kuwait local)', () => {
    expect(businessDateOf(new Date('2026-09-25T21:00:00.000Z'))).toBe('2026-09-26');
  });

  it('is a pure function of its instant argument — the same instant always yields the same date, for any instant', () => {
    fc.assert(
      fc.property(
        // round-2 finding follow-up: `noInvalidDate: true` is required — fast-check's fc.date()
        // can still generate `new Date(NaN)` inside a min/max range without it (a known fast-check
        // gotcha, not a bounds bug), which made this test flaky (businessDateOf(NaN) -> the
        // non-matching string 'NaN-NaN-NaN').
        fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z'), noInvalidDate: true }),
        (instant) => {
          expect(businessDateOf(instant)).toBe(businessDateOf(new Date(instant.getTime())));
        },
      ),
    );
  });

  it('always returns a YYYY-MM-DD string, for any instant', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z'), noInvalidDate: true }),
        (instant) => {
          expect(businessDateOf(instant)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        },
      ),
    );
  });
});
