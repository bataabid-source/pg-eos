// modules/sales/tests/manage-quote/margin.unit.test.ts — WBS 1.6, M02 sales.
//
// Mutation-coverage gap fill on domain/manage-quote/margin.ts: margin.property.test.ts never
// exercised the malformed-input RangeError branch (`parseScaledAmount`'s own `DECIMAL_PATTERN` guard)
// nor a NEGATIVE margin (cost exceeding revenue) — both plausible mutant-survival spots.

import { describe, expect, it } from 'vitest';

import { computeEstimatedMarginPct, type MarginLine } from '../../domain/manage-quote/margin.js';

describe('computeEstimatedMarginPct — malformed numeric(14,3) input throws RangeError', () => {
  it('a non-numeric qty throws RangeError naming the qty label', () => {
    const lines: MarginLine[] = [{ qty: 'abc', unitPrice: '10.000', standardCost: null }];
    expect(() => computeEstimatedMarginPct(lines)).toThrow(RangeError);
    expect(() => computeEstimatedMarginPct(lines)).toThrow(/qty/);
  });

  it('a non-numeric unitPrice throws RangeError naming the unitPrice label', () => {
    const lines: MarginLine[] = [{ qty: '1.000', unitPrice: 'oops', standardCost: null }];
    expect(() => computeEstimatedMarginPct(lines)).toThrow(RangeError);
    expect(() => computeEstimatedMarginPct(lines)).toThrow(/unitPrice/);
  });

  it('a non-numeric standardCost throws RangeError naming the standardCost label', () => {
    const lines: MarginLine[] = [{ qty: '1.000', unitPrice: '10.000', standardCost: 'bad' }];
    expect(() => computeEstimatedMarginPct(lines)).toThrow(RangeError);
    expect(() => computeEstimatedMarginPct(lines)).toThrow(/standardCost/);
  });

  it('too many fractional digits (numeric(14,3) allows at most 3) throws RangeError', () => {
    const lines: MarginLine[] = [{ qty: '1.0001', unitPrice: '10.000', standardCost: null }];
    expect(() => computeEstimatedMarginPct(lines)).toThrow(RangeError);
  });
});

describe('computeEstimatedMarginPct — cost exceeding revenue yields a NEGATIVE margin, never clamped to zero', () => {
  it('standardCost * qty > unitPrice * qty on a single line yields exactly -100', () => {
    // revenue = 1 * 10 = 10; cost = 1 * 20 = 20; margin = ((10 - 20) / 10) * 100 = -100.
    const lines: MarginLine[] = [{ qty: '1.000', unitPrice: '10.000', standardCost: '20.000' }];
    expect(computeEstimatedMarginPct(lines)).toBe(-100);
  });

  it('cost exactly equal to revenue yields exactly 0 (never negative, never null)', () => {
    const lines: MarginLine[] = [{ qty: '2.000', unitPrice: '10.000', standardCost: '10.000' }];
    expect(computeEstimatedMarginPct(lines)).toBe(0);
  });
});
