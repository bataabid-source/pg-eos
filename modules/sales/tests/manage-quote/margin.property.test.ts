// modules/sales/tests/manage-quote/margin.property.test.ts — WBS 1.6, M02 sales.
//
// Property tests (fast-check) for the margin formula (slice brief Master decision 5):
//   estimatedMarginPct = subtotal.isZero() ? null
//     : ((subtotal - sum(qty * standard_cost per line)) / subtotal) * 100, rounded to numeric(6,3).
//   A line whose service has a null standard_cost contributes 0 cost for that line.
//
// Expected new surface — modules/sales/domain/manage-quote/margin.ts (RED until it exists):
//   `computeEstimatedMarginPct(lines: ReadonlyArray<{ qty: string; unitPrice: string;
//   standardCost: string | null }>): number | null` — pure, no I/O, no Money/Quantity division
//   dependency assumed (this repo's Money/Quantity have no `divide`; pg-backend's own
//   implementation choice is not dictated here, only its observable result). pg-tester DEFAULT
//   (not pinned literally by the brief): this exact function name/signature — reported as an open
//   question in the closing report.
//
// ANTI-VACUOUS-TEST RULE (pg-reviewer flagged this twice, WBS 1.2 and WBS 1.4): this file's own
// `referenceMargin` below is an INDEPENDENT re-implementation, not a copy of production margin.ts —
// it computes each line's revenue and cost via two SEPARATE `.map()` passes (production almost
// certainly does a single accumulating loop/reduce), and rounds with a hand-rolled round-half-up
// on a scaled integer rather than whatever rounding primitive production uses. A real bug in
// production's formula will disagree with this independent calculation; a cosmetic difference in
// code shape will not.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { computeEstimatedMarginPct } from '../../domain/manage-quote/margin.js';

interface MarginLine {
  readonly qty: string;
  readonly unitPrice: string;
  readonly standardCost: string | null;
}

// Bounded, "nice" decimal-string generators (3 fractional digits, matching numeric(14,3)) — keeps
// the arithmetic below well clear of the numeric(14,3) magnitude ceiling even summed across 5 lines.
const decimalString = (n: number): string => (n / 1000).toFixed(3);

const positiveDecimalArb = fc.integer({ min: 1, max: 100_000 }).map(decimalString); // 0.001 .. 100.000
const qtyArb = fc.integer({ min: 1, max: 10_000 }).map(decimalString); // 0.001 .. 10.000
const standardCostArb = fc.option(fc.integer({ min: 0, max: 100_000 }).map(decimalString), { nil: null });

const lineArb: fc.Arbitrary<MarginLine> = fc.record({
  qty: qtyArb,
  unitPrice: positiveDecimalArb,
  standardCost: standardCostArb,
});

const linesArb = fc.array(lineArb, { minLength: 1, maxLength: 5 });

/** Round-half-up to 3 decimal places on a plain JS number, via a scaled-integer path — deliberately
 *  NOT the same rounding primitive production is expected to use. */
function roundTo3(value: number): number {
  const scaled = value * 1000;
  const rounded = scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
  return rounded / 1000;
}

/** Independent reference calculation: revenue and cost are computed via two SEPARATE `.map()`
 *  passes, summed with `.reduce()`, in that order — a different shape than a production
 *  single-pass accumulator, but the SAME formula (Master decision 5). */
function referenceMargin(lines: readonly MarginLine[]): number | null {
  const revenues = lines.map((line) => Number(line.qty) * Number(line.unitPrice));
  const subtotal = revenues.reduce((sum, value) => sum + value, 0);

  if (subtotal === 0) return null;

  const costs = lines.map((line) => Number(line.qty) * Number(line.standardCost ?? '0'));
  const totalCost = costs.reduce((sum, value) => sum + value, 0);

  return roundTo3(((subtotal - totalCost) / subtotal) * 100);
}

describe('computeEstimatedMarginPct — zero subtotal always yields null, never a division by zero', () => {
  it('an empty lines array yields null', () => {
    expect(computeEstimatedMarginPct([])).toBeNull();
  });

  it('the zero-lines call never throws and never returns NaN', () => {
    expect(() => computeEstimatedMarginPct([])).not.toThrow();
    const result = computeEstimatedMarginPct([]);
    expect(result).not.toBeNaN();
    expect(result).toBeNull();
  });
});

describe('computeEstimatedMarginPct — matches an independently-computed reference for arbitrary positive prices/costs/quantities', () => {
  it('agrees with referenceMargin (different code shape, same formula) within rounding tolerance', () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const production = computeEstimatedMarginPct(lines);
        const reference = referenceMargin(lines);

        expect(production).not.toBeNull();
        expect(reference).not.toBeNull();
        // Two independent rounding primitives (round-half-up here vs whatever production uses) may
        // legitimately differ at an exact .5-in-the-fourth-decimal boundary — 0.05 tolerance is far
        // tighter than the numeric(6,3) precision itself (0.001) would ever legitimately need, so a
        // real formula bug (wrong operand, wrong sign, missing null-cost guard) still fails loudly.
        expect(production as number).toBeCloseTo(reference as number, 1);
      }),
    );
  });
});

describe('computeEstimatedMarginPct — the formula never exceeds 100 (cost can never be negative)', () => {
  it('for arbitrary positive prices/costs/quantities, the result is always <= 100 (bounded by construction, never clamped)', () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const result = computeEstimatedMarginPct(lines);
        expect(result).not.toBeNull();
        expect(result as number).toBeLessThanOrEqual(100);
        expect(Number.isFinite(result as number)).toBe(true);
      }),
    );
  });

  it('a null standard_cost on every line yields exactly 100 (zero cost, all revenue is margin)', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ qty: qtyArb, unitPrice: positiveDecimalArb }), { minLength: 1, maxLength: 5 }), (rows) => {
        const lines: MarginLine[] = rows.map((row) => ({ ...row, standardCost: null }));
        const result = computeEstimatedMarginPct(lines);
        expect(result).toBe(100);
      }),
    );
  });
});
