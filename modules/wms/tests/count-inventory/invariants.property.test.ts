// modules/wms/tests/count-inventory/invariants.property.test.ts — WBS 2.13 (lane 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/wms/domain/count-inventory/invariants.ts — one property per invariant the brief names
// (CLAUDE.md TESTING; brief "Property tests" block, P1/P2/P3, verbatim).
//
// Expected new surface (RED until it exists):
//   modules/wms/domain/count-inventory/invariants.ts
//     - `hasVariance(qtyCounted: Quantity, qtySystem: Quantity): boolean` — true iff the two
//       quantities are NOT equal. Pure: no I/O, no Date, no Math.random() (CLAUDE.md · AGENT
//       CONSTRAINTS).
//     - `planAdjustment(final: Quantity, qtySystem: Quantity): { direction: 'inflow' | 'outflow' |
//       null; magnitude: Quantity }` — brief P2: 'inflow' when final > qtySystem, 'outflow' when
//       final < qtySystem, direction null (no movement) when equal; magnitude is ALWAYS
//       abs(final - qtySystem), including the equal case (magnitude zero, direction null — D5 "a
//       line with zero variance is skipped, no movement posted for it").
//     - `isCountComplete(lines: ReadonlyArray<{ readonly qtyCounted: string | null }>): boolean` —
//       brief P3: true iff EVERY line has qtyCounted !== null (an empty array is vacuously
//       complete).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Quantity } from '@pg-eos/domain-kit';

// The module under test — does not exist yet (RED).
import {
  assertAllVariancesRecounted,
  hasVariance,
  isCountComplete,
  lineNeedsRecount,
  planAdjustment,
} from '../../domain/count-inventory/invariants.js';
import { RecountRequiredError } from '../../domain/count-inventory/errors.js';

// numeric(14,3) fixture range — same pad width other suites in this module use (see the golden
// slice's own tests/receive-inbound/invariants.property.test.ts qtyArb).
const qtyArb = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 999 }))
  .map(([whole, frac]) => Quantity.of(`${whole}.${String(frac).padStart(3, '0')}`));

// --- P1: hasVariance(qtyCounted, qtySystem) <=> qtyCounted !== qtySystem ------------------------

describe('hasVariance — property P1', () => {
  it('never reports a variance when the two quantities are equal', () => {
    fc.assert(
      fc.property(qtyArb, (qty) => {
        expect(hasVariance(qty, qty)).toBe(false);
      }),
    );
  });

  it('always reports a variance when the two quantities differ, and never when they match — P1 both directions', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (a, b) => {
        expect(hasVariance(a, b)).toBe(!a.equals(b));
      }),
    );
  });
});

// --- P2: planAdjustment(final, qtySystem) — direction + magnitude = abs(final - qtySystem) ------

describe('planAdjustment — property P2', () => {
  it('direction is "inflow" iff final > qtySystem', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (final, qtySystem) => {
        fc.pre(!final.equals(qtySystem));
        const { direction } = planAdjustment(final, qtySystem);
        const finalIsGreater = Number(final.toString()) > Number(qtySystem.toString());
        expect(direction === 'inflow').toBe(finalIsGreater);
      }),
    );
  });

  it('direction is "outflow" iff final < qtySystem', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (final, qtySystem) => {
        fc.pre(!final.equals(qtySystem));
        const { direction } = planAdjustment(final, qtySystem);
        const finalIsLess = Number(final.toString()) < Number(qtySystem.toString());
        expect(direction === 'outflow').toBe(finalIsLess);
      }),
    );
  });

  it('direction is null (no movement) when final === qtySystem, and magnitude is zero', () => {
    fc.assert(
      fc.property(qtyArb, (qty) => {
        const { direction, magnitude } = planAdjustment(qty, qty);
        expect(direction).toBeNull();
        expect(magnitude.equals(Quantity.zero())).toBe(true);
      }),
    );
  });

  it('magnitude is always abs(final - qtySystem), whichever direction', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (final, qtySystem) => {
        const { magnitude } = planAdjustment(final, qtySystem);
        const expected = Math.abs(Number(final.toString()) - Number(qtySystem.toString()));
        expect(Number(magnitude.toString())).toBeCloseTo(expected, 3);
      }),
    );
  });
});

// --- P3: isCountComplete(lines) <=> every line has qtyCounted !== null --------------------------

describe('isCountComplete — property P3', () => {
  const lineArb = fc.record({
    qtyCounted: fc.option(qtyArb.map((q) => q.toString()), { nil: null }),
  });

  it('true iff every line has a non-null qtyCounted', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 20 }), (lines) => {
        const expected = lines.every((line) => line.qtyCounted !== null);
        expect(isCountComplete(lines)).toBe(expected);
      }),
    );
  });

  it('an empty set of lines is vacuously complete', () => {
    expect(isCountComplete([])).toBe(true);
  });

  it('a single line with qtyCounted null is incomplete', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 20 }), (lines) => {
        const withOneNull = [...lines, { qtyCounted: null }];
        expect(isCountComplete(withOneNull)).toBe(false);
      }),
    );
  });
});

// --- finding 1: lineNeedsRecount / assertAllVariancesRecounted — INV-C3-7 mandatory recount ------

describe('lineNeedsRecount — property (finding 1)', () => {
  it('true iff the line was counted, has a variance (P1), and has never been recounted', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, fc.boolean(), (qtyCounted, qtySystem, alreadyRecounted) => {
        const line = {
          qtyCounted: qtyCounted.toString(),
          qtySystem: qtySystem.toString(),
          recountQty: alreadyRecounted ? qtySystem.toString() : null,
        };
        const expected = !alreadyRecounted && hasVariance(qtyCounted, qtySystem);
        expect(lineNeedsRecount(line)).toBe(expected);
      }),
    );
  });

  it('an uncounted line (qtyCounted null) never needs a recount, whatever qtySystem is', () => {
    fc.assert(
      fc.property(qtyArb, (qtySystem) => {
        expect(lineNeedsRecount({ qtyCounted: null, qtySystem: qtySystem.toString(), recountQty: null })).toBe(false);
      }),
    );
  });

  it('a line with no variance never needs a recount, whether or not it was ever recounted', () => {
    fc.assert(
      fc.property(qtyArb, fc.boolean(), (qty, alreadyRecounted) => {
        const line = {
          qtyCounted: qty.toString(),
          qtySystem: qty.toString(),
          recountQty: alreadyRecounted ? qty.toString() : null,
        };
        expect(lineNeedsRecount(line)).toBe(false);
      }),
    );
  });
});

describe('assertAllVariancesRecounted — property (finding 1)', () => {
  const countLineArb = fc.record({
    qtyCounted: qtyArb.map((q) => q.toString()),
    qtySystem: qtyArb.map((q) => q.toString()),
    recountQty: fc.option(qtyArb.map((q) => q.toString()), { nil: null }),
  });

  it('throws RecountRequiredError iff at least one line still needs a recount (lineNeedsRecount)', () => {
    fc.assert(
      fc.property(fc.array(countLineArb, { maxLength: 10 }), (lines) => {
        const anyNeedsRecount = lines.some((line) => lineNeedsRecount(line));
        if (anyNeedsRecount) {
          expect(() => assertAllVariancesRecounted(lines)).toThrow(RecountRequiredError);
        } else {
          expect(() => assertAllVariancesRecounted(lines)).not.toThrow();
        }
      }),
    );
  });

  it('an empty set of lines is vacuously fine — never throws', () => {
    expect(() => assertAllVariancesRecounted([])).not.toThrow();
  });
});
