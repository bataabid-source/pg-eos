// modules/wms/tests/unit/stock-ledger.domain.test.ts — WBS 2.8 (pg-tester), written RED-first on
// 2026-09-23 against `modules/wms/src/stock-ledger/domain.ts`'s contract, exactly the "Public
// surface" block pins down (.claude/briefs/_slice-2.8.brief.md) — same RED-first precedent as
// packages/domain-kit's own WBS 0.14 suites and packages/identity's WBS 0.17 suite. It is now the
// permanent unit + property proof suite for that surface.
//
// Pure domain only: no DB, no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). Every
// arbitrary is built from fast-check primitives or from `@pg-eos/domain-kit`'s `Quantity`, never
// from a raw JS float (CLAUDE.md: "Numeric comparisons via ... Quantity.equals, never JS floats").
//
// Property list, copied verbatim from the brief's "Property tests" section:
//   - deriveBalances is permutation-invariant (any order of the same entries -> the same map).
//   - Conservation: for any base entry and any (from, to), deriveBalances(planTransfer(...)) sums
//     to zero per (client, sku, batch).
//   - Cancellation: deriveBalances([e, planReversal(e)]) is all-zero.
//   - validateEntry rejects qty <= 0, both sides set, neither side set, movementType outside
//     MOVEMENT_TYPES; accepts otherwise.
//   - Quantity scale: every derived value has <= 3 decimals (numeric(14,3)).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Quantity } from '@pg-eos/domain-kit';

// The module under test, per the brief's Public surface block.
import {
  MOVEMENT_TYPES,
  balanceKey,
  deriveBalances,
  planReversal,
  planTransfer,
  validateEntry,
  type LedgerEntry,
  type MovementType,
} from '../../index.js';
import {
  InvalidLedgerEntryError,
  InvalidQuantityError,
} from '../../index.js';

const PROPERTY_SEED = 2_008_000; // WBS 2.8 — fixed, printed seed (test names below), reproducible.
const NUM_RUNS = 1000; // doc 38 row 2.8 acceptance: "1,000 random movements" — the domain-side
// analogue is 1,000 property runs per fast-check convention (packages/domain-kit precedent).

// 13B chk_stock_movements_type (§13B-24) — the ONLY legal movement_type list. Copied from the
// brief's Public surface block, which itself copies 13B verbatim; never re-typed independently
// here so this suite cannot silently drift from MOVEMENT_TYPES's own export.
const EXPECTED_MOVEMENT_TYPES = [
  'receipt',
  'putaway',
  'pick',
  'pack',
  'ship',
  'issue',
  'transfer',
  'adjust',
  'count',
  'damage',
  'return',
  'scrap',
] as const;

// --- arbitraries -----------------------------------------------------------------------------

const uuidArb = (): fc.Arbitrary<string> => fc.uuid();

// A positive numeric(14,3) decimal string, capped well under the numeric(14,3) integer-digit
// ceiling so that summing a handful of them (conservation / cancellation properties) can never
// itself overflow Quantity's own numeric(14,3) range check — same bounding rationale as
// packages/domain-kit/tests/quantity.test.ts's `validBoundedDecimalString`.
const positiveQtyStringArb = (): fc.Arbitrary<string> =>
  fc
    .tuple(fc.nat({ max: 99_999 }), fc.integer({ min: 1, max: 999 }))
    .map(([intPart, fracPart]) => `${intPart}.${String(fracPart).padStart(3, '0')}`);

const nonPositiveQtyStringArb = (): fc.Arbitrary<string> =>
  fc
    .tuple(fc.nat({ max: 99_999 }), fc.nat({ max: 999 }))
    .map(([intPart, fracPart]) => `-${intPart}.${String(fracPart).padStart(3, '0')}`)
    .map((negative) => (negative === '-0.000' ? '0.000' : negative));

const batchNoArb = (): fc.Arbitrary<string> => fc.constantFrom('', 'BATCH-A', 'BATCH-B', 'BATCH-C');
const uomArb = (): fc.Arbitrary<string> => fc.constantFrom('EA', 'CTN', 'PLT', 'KG');
const movementTypeArb = (): fc.Arbitrary<MovementType> => fc.constantFrom(...MOVEMENT_TYPES);

interface BaseEntryFields {
  readonly clientId: string;
  readonly skuId: string;
  readonly qty: Quantity;
  readonly batchNo: string;
  readonly uom: string;
}

const baseEntryFieldsArb = (): fc.Arbitrary<BaseEntryFields> =>
  fc
    .record({
      clientId: uuidArb(),
      skuId: uuidArb(),
      qtyStr: positiveQtyStringArb(),
      batchNo: batchNoArb(),
      uom: uomArb(),
    })
    .map((r) => ({
      clientId: r.clientId,
      skuId: r.skuId,
      qty: Quantity.of(r.qtyStr),
      batchNo: r.batchNo,
      uom: r.uom,
    }));

// A single, valid, single-sided LedgerEntry — decision 1 (exactly one side set, qty > 0).
const validLedgerEntryArb = (): fc.Arbitrary<LedgerEntry> =>
  fc
    .record({
      base: baseEntryFieldsArb(),
      locationId: uuidArb(),
      movementType: movementTypeArb(),
      isInbound: fc.boolean(),
    })
    .map(({ base, locationId, movementType, isInbound }) => ({
      clientId: base.clientId,
      skuId: base.skuId,
      fromLocationId: isInbound ? null : locationId,
      toLocationId: isInbound ? locationId : null,
      qty: base.qty,
      batchNo: base.batchNo,
      movementType,
      uom: base.uom,
    }));

const mapsEqual = (
  a: ReadonlyMap<string, Quantity>,
  b: ReadonlyMap<string, Quantity>,
): boolean => {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || !other.equals(value)) {
      return false;
    }
  }
  return true;
};

// --- MOVEMENT_TYPES / balanceKey — smoke unit tests -------------------------------------------

describe('MOVEMENT_TYPES (13B chk_stock_movements_type (§13B-24))', () => {
  it('is exactly the twelve legal movement types, no other', () => {
    expect([...MOVEMENT_TYPES].sort()).toEqual([...EXPECTED_MOVEMENT_TYPES].sort());
    expect(MOVEMENT_TYPES).toHaveLength(12);
  });
});

describe('balanceKey (brief Public surface: `${clientId}|${skuId}|${locationId}|${batchNo}`)', () => {
  it('joins the four parts with "|" in clientId, skuId, locationId, batchNo order', () => {
    expect(balanceKey('c1', 's1', 'l1', 'B1')).toBe('c1|s1|l1|B1');
  });

  it("preserves an empty batchNo (01 wms.stock_balance.batch_no default '') as a trailing empty segment", () => {
    expect(balanceKey('c1', 's1', 'l1', '')).toBe('c1|s1|l1|');
  });
});

// --- Property: deriveBalances is permutation-invariant -----------------------------------------

describe('Property: deriveBalances is permutation-invariant', () => {
  it('deriveBalances(entries) equals deriveBalances(any reordering of entries)', () => {
    const entriesWithShuffleArb = fc
      .array(validLedgerEntryArb(), { minLength: 0, maxLength: 20 })
      .chain((entries) =>
        fc
          .shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length })
          .map((shuffled) => [entries, shuffled] as const),
      );

    fc.assert(
      fc.property(entriesWithShuffleArb, ([entries, shuffled]) => {
        expect(mapsEqual(deriveBalances(entries), deriveBalances(shuffled))).toBe(true);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

// --- Property: transfer conservation ------------------------------------------------------------

describe('Property: planTransfer conserves quantity across locations (decision 1)', () => {
  it('deriveBalances(planTransfer(base, from, to)) sums to zero per (client, sku, batch)', () => {
    fc.assert(
      fc.property(
        baseEntryFieldsArb(),
        uuidArb(),
        uuidArb(),
        (base, from, to) => {
          fc.pre(from !== to);

          const [outRow, inRow] = planTransfer(base, from, to);
          const balances = deriveBalances([outRow, inRow]);

          const prefix = `${base.clientId}|${base.skuId}|`;
          const suffix = `|${base.batchNo}`;
          let total = Quantity.zero();
          for (const [key, qty] of balances) {
            if (key.startsWith(prefix) && key.endsWith(suffix)) {
              total = total.add(qty);
            }
          }

          expect(total.isZero()).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

// --- Property: reversal cancellation -------------------------------------------------------------

describe('Property: reversal cancels the original entry (decision 5)', () => {
  it('deriveBalances([e, planReversal(e)]) is all-zero', () => {
    fc.assert(
      fc.property(validLedgerEntryArb(), (entry) => {
        const reversal = planReversal(entry);
        const balances = deriveBalances([entry, reversal]);

        for (const qty of balances.values()) {
          expect(qty.isZero()).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

// --- Property: validateEntry accepts/rejects exactly the documented cases ------------------------

describe('Property: validateEntry (decisions 1 and 4)', () => {
  it('accepts every valid single-sided, positive-qty, in-list-movement-type entry', () => {
    fc.assert(
      fc.property(validLedgerEntryArb(), (entry) => {
        expect(() => validateEntry(entry)).not.toThrow();
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });

  it("rejects qty <= 0 with InvalidQuantityError (decision 4, 01 wms.stock_movements constraint qty_not_zero, plus decision 1's qty > 0)", () => {
    fc.assert(
      fc.property(
        validLedgerEntryArb(),
        nonPositiveQtyStringArb(),
        (entry, badQtyStr) => {
          const badEntry: LedgerEntry = { ...entry, qty: Quantity.of(badQtyStr) };
          expect(() => validateEntry(badEntry)).toThrow(InvalidQuantityError);
        },
      ),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });

  it('rejects an entry with BOTH from_location_id and to_location_id set (decision 1)', () => {
    fc.assert(
      fc.property(validLedgerEntryArb(), uuidArb(), (entry, otherLocationId) => {
        const bothSides: LedgerEntry = {
          ...entry,
          fromLocationId: entry.fromLocationId ?? otherLocationId,
          toLocationId: entry.toLocationId ?? otherLocationId,
        };
        expect(() => validateEntry(bothSides)).toThrow(InvalidLedgerEntryError);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });

  it('rejects an entry with NEITHER from_location_id nor to_location_id set (decision 1)', () => {
    fc.assert(
      fc.property(validLedgerEntryArb(), (entry) => {
        const neitherSide: LedgerEntry = { ...entry, fromLocationId: null, toLocationId: null };
        expect(() => validateEntry(neitherSide)).toThrow(InvalidLedgerEntryError);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });

  it('rejects a movementType outside MOVEMENT_TYPES (13B chk_stock_movements_type (§13B-24))', () => {
    const invalidMovementTypeArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => !(MOVEMENT_TYPES as readonly string[]).includes(s));

    fc.assert(
      fc.property(validLedgerEntryArb(), invalidMovementTypeArb, (entry, badType) => {
        const badEntry: LedgerEntry = {
          ...entry,
          movementType: badType as MovementType,
        };
        expect(() => validateEntry(badEntry)).toThrow(InvalidLedgerEntryError);
      }),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});

// --- Property: numeric(14,3) scale is preserved through derivation --------------------------------

describe('Property: every deriveBalances value has at most 3 decimal digits (numeric(14,3))', () => {
  it('every derived Quantity formats as -?digits.NNN', () => {
    fc.assert(
      fc.property(
        fc.array(validLedgerEntryArb(), { minLength: 0, maxLength: 20 }),
        (entries) => {
          const balances = deriveBalances(entries);
          for (const qty of balances.values()) {
            expect(qty.toString()).toMatch(/^-?\d+\.\d{3}$/);
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: PROPERTY_SEED },
    );
  });
});
