// WBS 0.14 — RED phase (pg-tester). Property + unit tests for packages/domain-kit/money.ts
// against the agreed spec (docs/package/40-Build-Specification-EN.md §A3: numeric(14,3), KWD,
// never float; CLAUDE.md line 27: no Math.random()/new Date() in domain/, and money must never
// use `float`). money.ts does not exist yet — these tests are expected to fail on import
// (module not found), which is the correct RED for this phase. Never implement money.ts here.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Money } from '../money.js';

const PROPERTY_SEED = 1_000_003;
const NUM_RUNS = 1000;

// Arbitrary valid decimal strings within numeric(14,3): optional sign, up to 11 integer digits,
// exactly 3 fractional digits (matches the spec's own examples "12.500" / "-3.000"). Negative
// zero is excluded so the equals/compare invariants aren't ambiguous about -0 vs 0.
const validDecimalString = (): fc.Arbitrary<string> =>
  fc
    .tuple(fc.boolean(), fc.nat({ max: 99_999_999_999 }), fc.nat({ max: 999 }))
    .map(([negative, intPart, fracPart]) => {
      const isZero = intPart === 0 && fracPart === 0;
      const sign = negative && !isZero ? '-' : '';
      return `${sign}${intPart}.${String(fracPart).padStart(3, '0')}`;
    });

const arbitraryMoney = (): fc.Arbitrary<Money> => validDecimalString().map((value) => Money.of(value));

// Bounded variant for properties that COMBINE multiple operands (commutative/associative/
// round-trip). These properties test the arithmetic LAWS holding, not numeric(14,3) overflow
// behavior (that's covered separately by the "Range invariant" and "closed under Money.of"
// tests below, which correctly use the full-range generator). At the fixed PROPERTY_SEED, the
// full-range arbitraryMoney() generates operand pairs whose sum genuinely overflows
// numeric(14,3) (up to 11 integer digits each, so a+b can reach 12 digits), which is correct
// per-of()/add() behavior (RangeError) but exercises the wrong thing for a commutativity/
// associativity/round-trip check. Capping each operand's integer part at 5 digits keeps every
// combination (up to 3 operands) safely under the 11-digit bound in the worst case.
const validBoundedDecimalString = (): fc.Arbitrary<string> =>
  fc
    .tuple(fc.boolean(), fc.nat({ max: 99_999 }), fc.nat({ max: 999 }))
    .map(([negative, intPart, fracPart]) => {
      const isZero = intPart === 0 && fracPart === 0;
      const sign = negative && !isZero ? '-' : '';
      return `${sign}${intPart}.${String(fracPart).padStart(3, '0')}`;
    });

const arbitraryMoneyBounded = (): fc.Arbitrary<Money> =>
  validBoundedDecimalString().map((value) => Money.of(value));

describe('Property: Money.add is commutative', () => {
  it('a.add(b).equals(b.add(a)) for 1000 arbitrary valid amounts', () => {
    fc.assert(
      fc.property(arbitraryMoneyBounded(), arbitraryMoneyBounded(), (a, b) => {
        expect(a.add(b).equals(b.add(a))).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

describe('Property: Money.add is associative', () => {
  it('a.add(b).add(c).equals(a.add(b.add(c))) for 1000 arbitrary valid amounts', () => {
    fc.assert(
      fc.property(arbitraryMoneyBounded(), arbitraryMoneyBounded(), arbitraryMoneyBounded(), (a, b, c) => {
        expect(a.add(b).add(c).equals(a.add(b.add(c)))).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

describe('Property: Money add/subtract round-trip is exact', () => {
  it('a.add(b).subtract(b).equals(a) for 1000 arbitrary valid amounts', () => {
    fc.assert(
      fc.property(arbitraryMoneyBounded(), arbitraryMoneyBounded(), (a, b) => {
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

describe('Property: Money parse/format round-trip is exact', () => {
  it('Money.of(x.toString()).equals(x) for 1000 arbitrary valid amounts', () => {
    fc.assert(
      fc.property(arbitraryMoney(), (x) => {
        expect(Money.of(x.toString()).equals(x)).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

describe('Property: Money.zero() is the additive identity', () => {
  it('x.add(Money.zero()).equals(x) for 1000 arbitrary valid amounts', () => {
    fc.assert(
      fc.property(arbitraryMoney(), (x) => {
        expect(x.add(Money.zero()).equals(x)).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

describe('Property: Money.negate is its own inverse', () => {
  it('x.negate().negate().equals(x) for 1000 arbitrary valid amounts', () => {
    fc.assert(
      fc.property(arbitraryMoney(), (x) => {
        expect(x.negate().negate().equals(x)).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

describe('Property: Money.compare is reflexive and antisymmetric', () => {
  it('x.compare(x) === 0 for 1000 arbitrary valid amounts', () => {
    fc.assert(
      fc.property(arbitraryMoney(), (x) => {
        expect(x.compare(x)).toBe(0);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });

  it('a.compare(b) === -b.compare(a) for 1000 arbitrary valid amount pairs', () => {
    fc.assert(
      fc.property(arbitraryMoney(), arbitraryMoney(), (a, b) => {
        expect(a.compare(b)).toBe(-b.compare(a));
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

describe('Money.of validation (numeric(14,3): 11 integer digits, 3 fractional digits)', () => {
  it('throws RangeError for a string with more than 3 decimal places', () => {
    expect(() => Money.of('1.2345')).toThrow(RangeError);
  });

  it('throws RangeError when the integer part exceeds 11 digits', () => {
    expect(() => Money.of('100000000000.000')).toThrow(RangeError);
  });

  it('accepts an integer part of exactly 11 digits', () => {
    expect(() => Money.of('99999999999.000')).not.toThrow();
  });

  it('throws RangeError for a string that is not a valid decimal', () => {
    expect(() => Money.of('not-a-number')).toThrow(RangeError);
  });

  it('throws RangeError for an empty string', () => {
    expect(() => Money.of('')).toThrow(RangeError);
  });
});

describe('Money float-trap regression (no IEEE-754 drift)', () => {
  it('"0.10" + "0.20" equals exactly "0.300", never "0.30000000000000004"', () => {
    const sum = Money.of('0.10').add(Money.of('0.20'));

    expect(sum.toString()).toBe('0.300');
    expect(sum.equals(Money.of('0.300'))).toBe(true);
  });
});

describe('Money unit tests: public API', () => {
  it('exposes currency KWD as a static constant', () => {
    expect(Money.CURRENCY).toBe('KWD');
  });

  it('exposes currency KWD as an instance property', () => {
    expect(Money.of('1.000').currency).toBe('KWD');
  });

  it('Money.zero() is zero and has currency KWD', () => {
    const zero = Money.zero();

    expect(zero.isZero()).toBe(true);
    expect(zero.currency).toBe('KWD');
    expect(zero.toString()).toBe('0.000');
  });

  it('accepts a bare integer string with no decimal point', () => {
    expect(Money.of('0').toString()).toBe('0.000');
  });

  it('pads a string with fewer than 3 decimal places to exactly 3', () => {
    expect(Money.of('12.5').toString()).toBe('12.500');
  });

  it('formats a negative amount with exactly 3 decimal places', () => {
    expect(Money.of('-3.000').toString()).toBe('-3.000');
  });

  it('add: "10.000" + "5.250" === "15.250"', () => {
    expect(Money.of('10.000').add(Money.of('5.250')).equals(Money.of('15.250'))).toBe(true);
  });

  it('subtract: "10.000" - "3.500" === "6.500"', () => {
    expect(Money.of('10.000').subtract(Money.of('3.500')).equals(Money.of('6.500'))).toBe(true);
  });

  it('multiply: "10.500" * "3" === "31.500"', () => {
    expect(Money.of('10.500').multiply('3').equals(Money.of('31.500'))).toBe(true);
  });

  it('multiply by a negative scalar negates the amount', () => {
    const x = Money.of('5.000');

    expect(x.multiply('-1').equals(x.negate())).toBe(true);
  });

  it('negate: "5.000".negate() === "-5.000"', () => {
    expect(Money.of('5.000').negate().equals(Money.of('-5.000'))).toBe(true);
  });

  it('compare: greater amount compares 1, lesser compares -1, equal compares 0', () => {
    const five = Money.of('5.000');
    const three = Money.of('3.000');

    expect(five.compare(three)).toBe(1);
    expect(three.compare(five)).toBe(-1);
    expect(five.compare(Money.of('5.000'))).toBe(0);
  });

  it('equals: same amount is equal, different amount is not', () => {
    expect(Money.of('5.000').equals(Money.of('5.000'))).toBe(true);
    expect(Money.of('5.000').equals(Money.of('5.001'))).toBe(false);
  });

  it('isZero / isNegative / isPositive on zero', () => {
    const zero = Money.zero();

    expect(zero.isZero()).toBe(true);
    expect(zero.isNegative()).toBe(false);
    expect(zero.isPositive()).toBe(false);
  });

  it('isZero / isNegative / isPositive on a positive amount', () => {
    const positive = Money.of('1.000');

    expect(positive.isZero()).toBe(false);
    expect(positive.isNegative()).toBe(false);
    expect(positive.isPositive()).toBe(true);
  });

  it('isZero / isNegative / isPositive on a negative amount', () => {
    const negative = Money.of('-1.000');

    expect(negative.isZero()).toBe(false);
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
  });
});

// Round 2 rework (post pg-reviewer FAIL). Reviewer finding 1: multiply()'s round-half-up branch
// was never exercised because every existing multiply test used an integer scalar.
describe('multiply: round-half-up boundary (fractional scalar)', () => {
  it('rounds up at the exact half boundary: "0.001" * "0.5" === "0.001"', () => {
    expect(Money.of('0.001').multiply('0.5').toString()).toBe('0.001');
  });

  it('rounds down below the half boundary: "0.001" * "0.4" === "0.000"', () => {
    expect(Money.of('0.001').multiply('0.4').toString()).toBe('0.000');
  });

  it('rounds half-up in magnitude for a negative amount: "-0.001" * "0.5" === "-0.001"', () => {
    expect(Money.of('-0.001').multiply('0.5').toString()).toBe('-0.001');
  });

  it('rounds a non-boundary fractional scalar correctly: "10.000" * "0.125" === "1.250"', () => {
    expect(Money.of('10.000').multiply('0.125').toString()).toBe('1.250');
  });
});

// Reviewer finding 1: multiply() with a malformed scalar string was untested.
describe('multiply: malformed scalar string', () => {
  it('throws RangeError for a non-numeric scalar', () => {
    expect(() => Money.of('10.000').multiply('abc')).toThrow(RangeError);
  });

  it('throws RangeError for an empty string scalar', () => {
    expect(() => Money.of('10.000').multiply('')).toThrow(RangeError);
  });
});

// Reviewer finding 2: of() validates numeric(14,3) bounds but add/subtract/multiply/negate do not
// re-check the result, so two in-range values can combine into an out-of-range Money that a real
// numeric(14,3) column would reject with overflow.
describe('Range invariant: arithmetic results must stay within numeric(14,3)', () => {
  it('add() throws RangeError when the result would exceed 11 integer digits', () => {
    expect(() => Money.of('99999999999.999').add(Money.of('1.000'))).toThrow(RangeError);
  });
});

describe('Property: Money arithmetic results are closed under Money.of (numeric(14,3) invariant)', () => {
  it('if a.add(b) does not throw, Money.of(a.add(b).toString()) does not throw either, for 1000 arbitrary valid amount pairs', () => {
    fc.assert(
      fc.property(arbitraryMoney(), arbitraryMoney(), (a, b) => {
        let sum: Money;

        try {
          sum = a.add(b);
        } catch {
          // add() itself rejected the result — the invariant holds trivially for this pair.
          return;
        }

        expect(() => Money.of(sum.toString())).not.toThrow();
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});
