// modules/sales/tests/manage-quote/invariants.property.test.ts — WBS 1.6, M02 sales.
//
// Mutation-coverage gap fill: domain/manage-quote/invariants.ts had NO pure test file exercising it
// directly (only exercised indirectly through the impure handlers.test.ts, which cannot run in this
// pass). Property tests (fast-check) + boundary unit tests for every invariant in that file:
//   assertQuoteEditable(status)               -> QuoteFrozenError iff !hasQuoteTag(status, 'editable')
//   assertQuoteNotFrozen(status)              -> QuoteFrozenError iff hasQuoteTag(status, 'frozen')
//   assertQuoteRevisable(status)              -> IllegalTransitionError iff !hasQuoteTag(status, 'revisable')
//   assertValidDiscount(discountAmt, subtotal) -> InvalidDiscountError iff negative OR > subtotal
//   assertAccountQualified(account)           -> AccountNotFoundError | AccountNotQualifiedError
//   todayIso(clockNow)                        -> 'YYYY-MM-DD' slice of clockNow.toISOString()
//   assertValidUntilNotPast(validUntil, today) -> InvalidValidUntilError iff validUntil < today
//   assertMarginInRange(estimatedMarginPct)   -> MarginOutOfRangeError iff |pct| > 999.999
//
// ANTI-VACUOUS-TEST RULE: every reference oracle below is independent of production's own code shape
// (different comparison mechanism or a separately-declared boolean set), per the pattern already
// established in tests/manage-contract/invariants.property.test.ts.

import { Quantity } from '@pg-eos/domain-kit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertAccountQualified,
  assertMarginInRange,
  assertQuoteEditable,
  assertQuoteNotFrozen,
  assertQuoteRevisable,
  assertValidDiscount,
  assertValidUntilNotPast,
  todayIso,
  type AccountQualificationInput,
} from '../../domain/manage-quote/invariants.js';
import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  IllegalTransitionError,
  InvalidDiscountError,
  InvalidValidUntilError,
  MarginOutOfRangeError,
  QuoteFrozenError,
} from '../../domain/manage-quote/errors.js';
import { QUOTE_STATUS, type QuoteStatus } from '../../domain/manage-quote/machine.js';

const ALL_STATUSES: readonly QuoteStatus[] = Object.values(QUOTE_STATUS);
const statusArb: fc.Arbitrary<QuoteStatus> = fc.constantFrom(...ALL_STATUSES);

// Independent tag-membership sets (never call hasQuoteTag/machine.ts) — copied from the chart in
// machine.ts's own comments, not from any exported constant array.
const EDITABLE_STATUSES = new Set<QuoteStatus>([QUOTE_STATUS.DRAFT]);
const FROZEN_STATUSES = new Set<QuoteStatus>([
  QUOTE_STATUS.SENT,
  QUOTE_STATUS.ACCEPTED,
  QUOTE_STATUS.REJECTED,
  QUOTE_STATUS.EXPIRED,
]);
const REVISABLE_STATUSES = new Set<QuoteStatus>([
  QUOTE_STATUS.APPROVED,
  QUOTE_STATUS.SENT,
  QUOTE_STATUS.ACCEPTED,
  QUOTE_STATUS.REJECTED,
  QUOTE_STATUS.EXPIRED,
]);

describe('assertQuoteEditable — property: throws QuoteFrozenError for every status except draft', () => {
  it('agrees with an independent editable-set reference over the whole enum', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        if (EDITABLE_STATUSES.has(status)) {
          expect(() => assertQuoteEditable(status)).not.toThrow();
        } else {
          expect(() => assertQuoteEditable(status)).toThrow(QuoteFrozenError);
        }
      }),
    );
  });

  it('the thrown message names the exact non-editable status', () => {
    expect(() => assertQuoteEditable(QUOTE_STATUS.SENT)).toThrow(/"sent"/);
  });
});

describe('assertQuoteNotFrozen — property: throws QuoteFrozenError iff status is frozen', () => {
  it('agrees with an independent frozen-set reference over the whole enum', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        if (FROZEN_STATUSES.has(status)) {
          expect(() => assertQuoteNotFrozen(status)).toThrow(QuoteFrozenError);
        } else {
          expect(() => assertQuoteNotFrozen(status)).not.toThrow();
        }
      }),
    );
  });
});

describe('assertQuoteRevisable — property: throws IllegalTransitionError iff status is not revisable', () => {
  it('agrees with an independent revisable-set reference over the whole enum', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        if (REVISABLE_STATUSES.has(status)) {
          expect(() => assertQuoteRevisable(status)).not.toThrow();
        } else {
          expect(() => assertQuoteRevisable(status)).toThrow(IllegalTransitionError);
        }
      }),
    );
  });
});

describe('assertValidDiscount — property: throws InvalidDiscountError iff discountAmt < 0 or > subtotal', () => {
  const qtyArb = fc.integer({ min: 0, max: 1_000_000 }).map((n) => (n / 1000).toFixed(3));

  it('never throws when 0 <= discountAmt <= subtotal', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (a, b) => {
        const [lo, hi] = Number(a) <= Number(b) ? [a, b] : [b, a];
        expect(() => assertValidDiscount(Quantity.of(lo), Quantity.of(hi))).not.toThrow();
      }),
    );
  });

  it('always throws InvalidDiscountError when discountAmt > subtotal', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (a, b) => {
        const [lo, hi] = Number(a) <= Number(b) ? [a, b] : [b, a];
        // hi > lo strictly required for the "greater than" branch — skip equal pairs.
        if (hi === lo) return;
        expect(() => assertValidDiscount(Quantity.of(hi), Quantity.of(lo))).toThrow(InvalidDiscountError);
      }),
    );
  });

  it('discountAmt exactly equal to subtotal never throws (<=, not <)', () => {
    fc.assert(
      fc.property(qtyArb, (v) => {
        expect(() => assertValidDiscount(Quantity.of(v), Quantity.of(v))).not.toThrow();
      }),
    );
  });

  it('a negative discountAmt always throws InvalidDiscountError, regardless of subtotal', () => {
    expect(() => assertValidDiscount(Quantity.of('-0.001'), Quantity.of('100.000'))).toThrow(InvalidDiscountError);
  });

  it('zero discountAmt never throws, for any non-negative subtotal', () => {
    fc.assert(
      fc.property(qtyArb, (subtotal) => {
        expect(() => assertValidDiscount(Quantity.of('0.000'), Quantity.of(subtotal))).not.toThrow();
      }),
    );
  });
});

describe('assertAccountQualified — property: AccountNotFoundError iff null, else AccountNotQualifiedError iff closed/no CR', () => {
  const ACCOUNT_STATUS_CLOSED = 'closed';
  const statusStringArb = fc.constantFrom('active', 'closed', 'suspended');
  const crNumberArb = fc.option(fc.string({ minLength: 1 }), { nil: null });

  it('a null account always throws AccountNotFoundError', () => {
    expect(() => assertAccountQualified(null)).toThrow(AccountNotFoundError);
  });

  it('agrees with an independent reference for every (status, crNumber) combination', () => {
    fc.assert(
      fc.property(statusStringArb, crNumberArb, (status, crNumber) => {
        const account: AccountQualificationInput = { status, crNumber };
        const shouldThrow = status === ACCOUNT_STATUS_CLOSED || crNumber === null;
        if (shouldThrow) {
          expect(() => assertAccountQualified(account)).toThrow(AccountNotQualifiedError);
        } else {
          expect(() => assertAccountQualified(account)).not.toThrow();
        }
      }),
    );
  });

  it('closed status with a non-null crNumber still throws (either condition alone is sufficient)', () => {
    expect(() => assertAccountQualified({ status: 'closed', crNumber: 'CR-1' })).toThrow(AccountNotQualifiedError);
  });

  it('non-closed status with a null crNumber still throws (either condition alone is sufficient)', () => {
    expect(() => assertAccountQualified({ status: 'active', crNumber: null })).toThrow(AccountNotQualifiedError);
  });

  it('active status with a non-null crNumber never throws', () => {
    expect(() => assertAccountQualified({ status: 'active', crNumber: 'CR-1' })).not.toThrow();
  });
});

describe('todayIso — property: always the first 10 characters of clockNow.toISOString()', () => {
  it('agrees with an independent string-slicing reference for arbitrary dates', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }),
        (clockNow) => {
        const iso = clockNow.toISOString();
        const expected = `${iso.slice(0, 4)}-${iso.slice(5, 7)}-${iso.slice(8, 10)}`;
        expect(todayIso(clockNow)).toBe(expected);
        expect(todayIso(clockNow)).toHaveLength(10);
      }),
    );
  });

  it('a known fixed date produces the exact expected string', () => {
    expect(todayIso(new Date('2025-03-14T23:59:59.999Z'))).toBe('2025-03-14');
  });
});

describe('assertValidUntilNotPast — property: throws InvalidValidUntilError iff validUntil < today', () => {
  const isoDateArb = fc
    .integer({ min: 0, max: 3650 })
    .map((offset) => new Date(Date.parse('2020-01-01') + offset * 86_400_000).toISOString().slice(0, 10));

  it('agrees with an independent Date.parse-based comparison', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (validUntil, today) => {
        const shouldThrow = Date.parse(validUntil) < Date.parse(today);
        if (shouldThrow) {
          expect(() => assertValidUntilNotPast(validUntil, today)).toThrow(InvalidValidUntilError);
        } else {
          expect(() => assertValidUntilNotPast(validUntil, today)).not.toThrow();
        }
      }),
    );
  });

  it('validUntil exactly equal to today never throws (>= today is the rule)', () => {
    fc.assert(
      fc.property(isoDateArb, (today) => {
        expect(() => assertValidUntilNotPast(today, today)).not.toThrow();
      }),
    );
  });
});

describe('assertMarginInRange — boundary: exact limit, one below, one above numeric(6,3) max magnitude 999.999', () => {
  it('null always passes (empty/zero-subtotal quote)', () => {
    expect(() => assertMarginInRange(null)).not.toThrow();
  });

  it('exactly 999.999 never throws (the limit itself is legal)', () => {
    expect(() => assertMarginInRange(999.999)).not.toThrow();
    expect(() => assertMarginInRange(-999.999)).not.toThrow();
  });

  it('999.998 (one below the limit) never throws', () => {
    expect(() => assertMarginInRange(999.998)).not.toThrow();
  });

  it('1000.000 (one above the limit, positive) throws MarginOutOfRangeError', () => {
    expect(() => assertMarginInRange(1000)).toThrow(MarginOutOfRangeError);
  });

  it('-1000.000 (one above the limit in magnitude, negative) throws MarginOutOfRangeError', () => {
    expect(() => assertMarginInRange(-1000)).toThrow(MarginOutOfRangeError);
  });

  it('zero never throws', () => {
    expect(() => assertMarginInRange(0)).not.toThrow();
  });

  it('agrees with an independent Math.abs-based reference for arbitrary finite values', () => {
    fc.assert(
      fc.property(fc.double({ min: -2000, max: 2000, noNaN: true }), (pct) => {
        const shouldThrow = (pct < 0 ? -pct : pct) > 999.999;
        if (shouldThrow) {
          expect(() => assertMarginInRange(pct)).toThrow(MarginOutOfRangeError);
        } else {
          expect(() => assertMarginInRange(pct)).not.toThrow();
        }
      }),
    );
  });
});
