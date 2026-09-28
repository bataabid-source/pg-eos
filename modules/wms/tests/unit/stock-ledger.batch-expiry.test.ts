// modules/wms/tests/unit/stock-ledger.batch-expiry.test.ts — WBS 2.9 part 2 (pg-tester).
// Unit + property proof for the pure `resolveBatchExpiry(recorded, offered)` in
// src/stock-ledger/domain.ts (decision 2: one expiry per wms.stock_balance row; a second, different
// expiry is a conflict, never a silent overwrite). No DB, no Date, no Math.random() — gate ② runs it.
// Imported from the domain file directly: the function is not (yet) re-exported by the module index.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { resolveBatchExpiry } from '../../src/stock-ledger/domain.js';

const PROPERTY_SEED = 2_009_002; // WBS 2.9 part 2 — fixed seed, reproducible.
const NUM_RUNS = 1000; // same per-property run count as stock-ledger.domain.test.ts.

// ISO `YYYY-MM-DD` text, the exact form the database returns for a `date` column (domain.ts doc).
const EXPIRY_A = '2027-03-15';
const EXPIRY_B = '2028-11-30';

const MIN_YEAR = 2000;
const MAX_YEAR = 2099;
const MAX_MONTH = 12;
const MAX_DAY_ALL_MONTHS = 28; // valid in every month, so every generated text is a real date.

const isoDateArb = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.integer({ min: MIN_YEAR, max: MAX_YEAR }),
      fc.integer({ min: 1, max: MAX_MONTH }),
      fc.integer({ min: 1, max: MAX_DAY_ALL_MONTHS }),
    )
    .map(
      ([year, month, day]) =>
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    );

const nullableExpiryArb = (): fc.Arbitrary<string | null> =>
  fc.oneof(fc.constant(null), isoDateArb());

describe('resolveBatchExpiry (WBS 2.9 part 2 decision 2) — cases', () => {
  it('(null, null) keeps null', () => {
    expect(resolveBatchExpiry(null, null)).toEqual({ kind: 'keep', expiry: null });
  });

  it('(X, null) keeps the recorded X', () => {
    expect(resolveBatchExpiry(EXPIRY_A, null)).toEqual({ kind: 'keep', expiry: EXPIRY_A });
  });

  it('(null, X) fills with the offered X', () => {
    expect(resolveBatchExpiry(null, EXPIRY_A)).toEqual({ kind: 'fill', expiry: EXPIRY_A });
  });

  it('(X, X) keeps X', () => {
    expect(resolveBatchExpiry(EXPIRY_A, EXPIRY_A)).toEqual({ kind: 'keep', expiry: EXPIRY_A });
  });

  it('(X, Y) is a conflict carrying recorded X and offered Y', () => {
    expect(resolveBatchExpiry(EXPIRY_A, EXPIRY_B)).toEqual({
      kind: 'conflict',
      recorded: EXPIRY_A,
      offered: EXPIRY_B,
    });
  });
});

describe('Property: resolveBatchExpiry (WBS 2.9 part 2 decision 2)', () => {
  it('is a conflict iff both expiries are non-null and differ, carrying both values', () => {
    fc.assert(
      fc.property(nullableExpiryArb(), nullableExpiryArb(), (recorded, offered) => {
        const result = resolveBatchExpiry(recorded, offered);
        const expectConflict = recorded !== null && offered !== null && recorded !== offered;
        expect(result.kind === 'conflict').toBe(expectConflict);
        if (result.kind === 'conflict') {
          expect(result.recorded).toBe(recorded);
          expect(result.offered).toBe(offered);
        }
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });

  it('otherwise the resulting expiry is `recorded ?? offered`', () => {
    fc.assert(
      fc.property(nullableExpiryArb(), nullableExpiryArb(), (recorded, offered) => {
        const result = resolveBatchExpiry(recorded, offered);
        if (result.kind === 'conflict') {
          return; // covered by the conflict property above
        }
        expect(result.expiry).toBe(recorded ?? offered);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });

  it('a recorded expiry is never overwritten (fill only when nothing was recorded)', () => {
    fc.assert(
      fc.property(nullableExpiryArb(), nullableExpiryArb(), (recorded, offered) => {
        const result = resolveBatchExpiry(recorded, offered);
        expect(result.kind === 'fill').toBe(recorded === null && offered !== null);
        if (recorded !== null && result.kind !== 'conflict') {
          expect(result.expiry).toBe(recorded);
        }
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});
