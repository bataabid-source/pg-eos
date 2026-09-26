// modules/wms/tests/process-outbound/invariants.property.test.ts — WBS 2.11 part 1, fix round 1
// finding 11.
//
// Property tests (fast-check) for the pure domain invariants in
// modules/wms/domain/process-outbound/invariants.ts (landed under fix round 1 finding 11 —
// RunOutboundChecks' nine condition-check functions moved out of the application layer into pure,
// no-I/O functions, mirroring the golden slice's domain/receive-inbound/invariants.ts +
// tests/receive-inbound/invariants.property.test.ts pattern). At minimum (per the finding):
//   - the SKU-client-ownership invariant (INV-C3-3 equivalent) — assertSkuBelongsToOrderClient;
//   - the stock-sufficiency arithmetic (condition 3/7 interaction — finding 7 was a logic bug
//     specifically here: condition 3 sums availability across ALL locations including blocked
//     ones, condition 7 sums only NON-blocked locations) — assertSufficientStock and
//     assertNonBlockedLocationsSufficient.
// Every function is pure: no I/O, no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS) — the
// property tests below call them directly, no DB, no withContext.
//
// Escalated fix round (pg-reviewer round 2):
//   - finding 9: one property block per remaining invariants.ts export — assertContractActive,
//     daysBetween, assertShelfLifeSufficient, assertSkuNotBlocked, assertDeliveryAddressComplete,
//     assertServicePriced, evaluateCreditHold — plus assertSkuResolved (finding 11's new
//     SkuNotFoundError precondition of condition 4).
//   - finding 7: the stock-sufficiency arithmetic now runs on `Quantity` (exact numeric(14,3)),
//     so the condition 3/7 properties below also GENERATE FRACTIONAL 3-decimal quantities and
//     compute the expected sum exactly in integer thousandths — the whole-number generators above
//     could never expose the IEEE-754 drift (0.100 + 0.700 summing to 0.7999999999999999).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Quantity } from '@pg-eos/domain-kit';

import {
  allocateFromSingleLot,
  assertCheckerNotPicker,
  assertContractActive,
  assertDeliveryAddressComplete,
  assertLineNotAlreadyPicked,
  assertLineReservedForPick,
  assertNonBlockedLocationsSufficient,
  assertOrderQuantityWithinLimit,
  assertPickedWithinReserved,
  assertServicePriced,
  assertShelfLifeSufficient,
  assertSkuBelongsToOrderClient,
  assertSkuNotBlocked,
  assertSkuResolved,
  assertSufficientStock,
  assertVarianceReasonRequired,
  daysBetween,
  evaluateCreditHold,
  type AllocationLotCandidate,
  type AllocationResult,
  type DeliveryAddressCheck,
  type ShelfLifeCandidateLot,
  type StockedLocationForBlockCheck,
} from '../../domain/process-outbound/invariants.js';
import {
  ContractExpiredError,
  ContractNotActiveError,
  DeliveryAddressIncompleteError,
  InsufficientStockError,
  LineAlreadyPickedError,
  LineNotReservedForPickError,
  OutboundLocationBlockedError,
  NoServicePriceError,
  PickQuantityExceedsReservedError,
  OrderQuantityExceededError,
  SelfCheckNotAllowedError,
  ShelfLifeTooShortError,
  SkuBlockedError,
  SkuClientMismatchError,
  SkuNotFoundError,
  VarianceReasonRequiredError,
} from '../../domain/process-outbound/errors.js';

const uuidArb = fc.uuid();
// numeric(14,3) fixture range, same pad-width convention as receive-inbound.test.ts's own qtyArb.
const qtyStringArb = fc
  .tuple(fc.integer({ min: 0, max: 999999 }), fc.integer({ min: 0, max: 999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(3, '0')}`);

function skuOwnershipCheck(skuClientId: string, orderClientId: string) {
  return { skuId: 'sku-1', skuCode: 'SKU-1', skuClientId, orderClientId };
}

// --- assertSkuBelongsToOrderClient (INV-C3-3 equivalent) -----------------------------------------

describe('assertSkuBelongsToOrderClient — property (condition 4, INV-C3-3 equivalent)', () => {
  it('never throws when skuClientId === orderClientId', () => {
    fc.assert(
      fc.property(uuidArb, (clientId) => {
        expect(() => assertSkuBelongsToOrderClient(skuOwnershipCheck(clientId, clientId))).not.toThrow();
      }),
    );
  });

  it('always throws SkuClientMismatchError when skuClientId !== orderClientId', () => {
    fc.assert(
      fc.property(uuidArb, uuidArb, (a, b) => {
        fc.pre(a !== b);
        let caught: unknown;
        try {
          assertSkuBelongsToOrderClient(skuOwnershipCheck(a, b));
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SkuClientMismatchError);
        expect((caught as SkuClientMismatchError).params).toMatchObject({
          skuId: 'sku-1',
          skuCode: 'SKU-1',
        });
      }),
    );
  });
});

// --- assertSufficientStock (condition 3) ----------------------------------------------------------

describe('assertSufficientStock — property (condition 3)', () => {
  it('never throws when availableSum >= ordered', () => {
    fc.assert(
      fc.property(qtyStringArb, fc.integer({ min: 0, max: 1000 }), (ordered, extra) => {
        const availableSum = (Number(ordered) + extra).toFixed(3);
        expect(() =>
          assertSufficientStock({ skuId: 'sku-1', skuCode: 'SKU-1', availableSum, ordered, singleLocationCode: null }),
        ).not.toThrow();
      }),
    );
  });

  it('always throws InsufficientStockError when availableSum < ordered', () => {
    fc.assert(
      fc.property(qtyStringArb, fc.integer({ min: 1, max: 1000 }), (availableSum, deficit) => {
        const ordered = (Number(availableSum) + deficit).toFixed(3);
        expect(() =>
          assertSufficientStock({ skuId: 'sku-1', skuCode: 'SKU-1', availableSum, ordered, singleLocationCode: null }),
        ).toThrow(InsufficientStockError);
      }),
    );
  });

  it('the boundary availableSum === ordered never throws (>=, not >)', () => {
    fc.assert(
      fc.property(qtyStringArb, (qty) => {
        expect(() =>
          assertSufficientStock({ skuId: 'sku-1', skuCode: 'SKU-1', availableSum: qty, ordered: qty, singleLocationCode: null }),
        ).not.toThrow();
      }),
    );
  });
});

// --- assertNonBlockedLocationsSufficient (condition 7 — finding 7's own arithmetic) ---------------

const locationArb: fc.Arbitrary<StockedLocationForBlockCheck> = fc.record({
  locationCode: fc.string({ minLength: 1, maxLength: 8 }),
  blockReason: fc.option(fc.string(), { nil: null }),
  isBlocked: fc.boolean(),
  qtyAvailable: fc.integer({ min: 0, max: 1000 }).map((n) => n.toFixed(3)),
});

function nonBlockedSum(locations: readonly StockedLocationForBlockCheck[]): number {
  return locations.filter((l) => !l.isBlocked).reduce((sum, l) => sum + Number(l.qtyAvailable), 0);
}

describe('assertNonBlockedLocationsSufficient — property (condition 7, finding 7)', () => {
  it('never throws when the NON-blocked-only sum >= ordered, however much blocked stock exists', () => {
    fc.assert(
      fc.property(fc.array(locationArb, { maxLength: 8 }), (locations) => {
        const ordered = nonBlockedSum(locations).toFixed(3);
        expect(() => assertNonBlockedLocationsSufficient(locations, ordered, 'sku-1')).not.toThrow();
      }),
    );
  });

  it('always throws OutboundLocationBlockedError when the NON-blocked-only sum < ordered — even if the TOTAL (including blocked) would cover it (finding 7: condition 7 must never accept blocked stock as sufficient)', () => {
    fc.assert(
      fc.property(fc.array(locationArb, { maxLength: 8 }), fc.integer({ min: 1, max: 1000 }), (locations, deficit) => {
        const ordered = (nonBlockedSum(locations) + deficit).toFixed(3);
        expect(() => assertNonBlockedLocationsSufficient(locations, ordered, 'sku-1')).toThrow(OutboundLocationBlockedError);
      }),
    );
  });

  it('every location blocked and any positive ordered quantity always throws (the degenerate case the brief names)', () => {
    fc.assert(
      fc.property(
        fc.array(locationArb.map((l) => ({ ...l, isBlocked: true })), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 1000 }),
        (allBlocked, orderedInt) => {
          expect(() => assertNonBlockedLocationsSufficient(allBlocked, orderedInt.toFixed(3), 'sku-1')).toThrow(
            OutboundLocationBlockedError,
          );
        },
      ),
    );
  });
});

// =================================================================================================
// Escalated fix round — finding 7: FRACTIONAL quantities, exact (Quantity) arithmetic.
// =================================================================================================

// numeric(14,3): a quantity is an integer count of thousandths. Generated as an integer (exact in
// JS up to 2^53, far above anything summed below) and rendered to the repository's own `::text`
// shape, so the expected sum is computed EXACTLY here, independently of the code under test.
const THOUSANDTHS_PER_UNIT = 1000;
const MAX_QTY_THOUSANDTHS = 999_999_999; // 999999.999 — same upper bound as qtyStringArb above.

function thousandthsToQty(thousandths: number): string {
  const whole = Math.floor(thousandths / THOUSANDTHS_PER_UNIT);
  const frac = thousandths % THOUSANDTHS_PER_UNIT;
  return `${whole}.${String(frac).padStart(3, '0')}`;
}

// Biased toward sub-unit fractions (where float drift lives) while still covering the full range.
const thousandthsArb = fc.oneof(
  fc.integer({ min: 0, max: THOUSANDTHS_PER_UNIT - 1 }),
  fc.integer({ min: 0, max: MAX_QTY_THOUSANDTHS }),
);

const fractionalLocationArb = fc
  .record({
    locationCode: fc.string({ minLength: 1, maxLength: 8 }),
    blockReason: fc.option(fc.string(), { nil: null }),
    isBlocked: fc.boolean(),
    thousandths: thousandthsArb,
  })
  .map(({ thousandths, ...rest }) => ({ ...rest, thousandths, qtyAvailable: thousandthsToQty(thousandths) }));

function exactNonBlockedThousandths(locations: ReadonlyArray<{ readonly isBlocked: boolean; readonly thousandths: number }>): number {
  return locations.filter((l) => !l.isBlocked).reduce((sum, l) => sum + l.thousandths, 0);
}

function toBlockCheck(l: { readonly locationCode: string; readonly blockReason: string | null; readonly isBlocked: boolean; readonly qtyAvailable: string }): StockedLocationForBlockCheck {
  return { locationCode: l.locationCode, blockReason: l.blockReason, isBlocked: l.isBlocked, qtyAvailable: l.qtyAvailable };
}

describe('assertNonBlockedLocationsSufficient — property with FRACTIONAL 3-decimal quantities (finding 7, exact Quantity arithmetic)', () => {
  it('regression: 0.100 + 0.700 at non-blocked locations exactly covers an order of 0.800 (a float sum gives 0.7999999999999999 and wrongly fails)', () => {
    const locations: StockedLocationForBlockCheck[] = [
      { locationCode: 'L1', blockReason: null, isBlocked: false, qtyAvailable: '0.100' },
      { locationCode: 'L2', blockReason: null, isBlocked: false, qtyAvailable: '0.700' },
    ];
    expect(() => assertNonBlockedLocationsSufficient(locations, '0.800', 'sku-1')).not.toThrow();
  });

  it('never throws when ordered === the EXACT non-blocked sum (fractional)', () => {
    fc.assert(
      fc.property(fc.array(fractionalLocationArb, { maxLength: 8 }), (locations) => {
        const ordered = thousandthsToQty(exactNonBlockedThousandths(locations));
        expect(() => assertNonBlockedLocationsSufficient(locations.map(toBlockCheck), ordered, 'sku-1')).not.toThrow();
      }),
    );
  });

  it('always throws OutboundLocationBlockedError when ordered exceeds the EXACT non-blocked sum by as little as 0.001, reporting the exact available sum', () => {
    fc.assert(
      fc.property(
        fc.array(fractionalLocationArb, { maxLength: 8 }),
        fc.integer({ min: 1, max: THOUSANDTHS_PER_UNIT }),
        (locations, deficitThousandths) => {
          const exactSum = exactNonBlockedThousandths(locations);
          const ordered = thousandthsToQty(exactSum + deficitThousandths);
          const error = (() => {
            try {
              assertNonBlockedLocationsSufficient(locations.map(toBlockCheck), ordered, 'sku-1');
              return null;
            } catch (err: unknown) {
              return err;
            }
          })();
          expect(error).toBeInstanceOf(OutboundLocationBlockedError);
          expect((error as OutboundLocationBlockedError).params).toMatchObject({ available: thousandthsToQty(exactSum), ordered });
        },
      ),
    );
  });
});

describe('assertSufficientStock — property with FRACTIONAL 3-decimal quantities (finding 7, exact Quantity comparison)', () => {
  it('never throws when availableSum is the exact fractional sum and ordered equals it', () => {
    fc.assert(
      fc.property(fc.array(thousandthsArb, { minLength: 1, maxLength: 8 }), (parts) => {
        const availableSum = thousandthsToQty(parts.reduce((a, b) => a + b, 0));
        expect(() =>
          assertSufficientStock({ skuId: 'sku-1', skuCode: 'SKU-1', availableSum, ordered: availableSum, singleLocationCode: null }),
        ).not.toThrow();
      }),
    );
  });

  it('never throws when available >= ordered and always throws InsufficientStockError when available < ordered — decided on exact thousandths', () => {
    fc.assert(
      fc.property(thousandthsArb, thousandthsArb, (availableT, orderedT) => {
        const check = {
          skuId: 'sku-1',
          skuCode: 'SKU-1',
          availableSum: thousandthsToQty(availableT),
          ordered: thousandthsToQty(orderedT),
          singleLocationCode: null,
        };
        if (availableT >= orderedT) {
          expect(() => assertSufficientStock(check)).not.toThrow();
        } else {
          expect(() => assertSufficientStock(check)).toThrow(InsufficientStockError);
        }
      }),
    );
  });

  it('a 0.001 shortfall on a fractional quantity always throws', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_QTY_THOUSANDTHS - 1 }), (availableT) => {
        expect(() =>
          assertSufficientStock({
            skuId: 'sku-1',
            skuCode: 'SKU-1',
            availableSum: thousandthsToQty(availableT),
            ordered: thousandthsToQty(availableT + 1),
            singleLocationCode: null,
          }),
        ).toThrow(InsufficientStockError);
      }),
    );
  });
});

// =================================================================================================
// Escalated fix round — finding 9: the remaining invariants.ts functions.
// =================================================================================================

// ISO dates (`YYYY-MM-DD`) built from a whole-day offset against a fixed UTC anchor — test-side
// date construction only (the functions under test take plain ISO strings, never a Date).
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_ANCHOR_MS = Date.UTC(2000, 0, 1);
const MAX_DAY_OFFSET = 36_500; // ~100 years of whole days after the anchor.

function isoFromDayOffset(offset: number): string {
  return new Date(DATE_ANCHOR_MS + offset * MS_PER_DAY).toISOString().slice(0, 10);
}

const dayOffsetArb = fc.integer({ min: 0, max: MAX_DAY_OFFSET });
const orderIdArb = fc.uuid();

// --- assertContractActive (condition 1) -----------------------------------------------------------

describe('assertContractActive — property (condition 1)', () => {
  it('no active contract row (null) always throws ContractNotActiveError, key wms.outbound.check.contractNotActive, no expiryDate param', () => {
    fc.assert(
      fc.property(dayOffsetArb, orderIdArb, (asOf, orderId) => {
        const error = (() => {
          try {
            assertContractActive(null, isoFromDayOffset(asOf), orderId);
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        expect(error).toBeInstanceOf(ContractNotActiveError);
        expect(error).not.toBeInstanceOf(ContractExpiredError);
        expect((error as ContractNotActiveError).i18nKey).toBe('wms.outbound.check.contractNotActive');
        expect((error as ContractNotActiveError).params).not.toHaveProperty('expiryDate');
      }),
    );
  });

  it('an open-ended contract (endDate null) never throws, whatever the as-of date', () => {
    fc.assert(
      fc.property(dayOffsetArb, orderIdArb, (asOf, orderId) => {
        expect(() => assertContractActive({ endDate: null }, isoFromDayOffset(asOf), orderId)).not.toThrow();
      }),
    );
  });

  it('endDate on or after the as-of date never throws (the end date itself is still in force)', () => {
    fc.assert(
      fc.property(dayOffsetArb, fc.integer({ min: 0, max: MAX_DAY_OFFSET }), orderIdArb, (asOf, daysLeft, orderId) => {
        expect(() =>
          assertContractActive({ endDate: isoFromDayOffset(asOf + daysLeft) }, isoFromDayOffset(asOf), orderId),
        ).not.toThrow();
      }),
    );
  });

  it('endDate before the as-of date always throws ContractExpiredError carrying that exact expiryDate', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_DAY_OFFSET }), fc.integer({ min: 1, max: MAX_DAY_OFFSET }), orderIdArb, (asOf, daysPast, orderId) => {
        const endDate = isoFromDayOffset(asOf - daysPast);
        const error = (() => {
          try {
            assertContractActive({ endDate }, isoFromDayOffset(asOf), orderId);
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        expect(error).toBeInstanceOf(ContractExpiredError);
        expect((error as ContractExpiredError).i18nKey).toBe('wms.outbound.check.contractExpired');
        expect((error as ContractExpiredError).params).toEqual({ expiryDate: endDate });
      }),
    );
  });
});

// --- daysBetween -----------------------------------------------------------------------------------

describe('daysBetween — property', () => {
  it('equals the whole-day offset between the two dates', () => {
    fc.assert(
      fc.property(dayOffsetArb, dayOffsetArb, (a, b) => {
        expect(daysBetween(isoFromDayOffset(a), isoFromDayOffset(b))).toBe(b - a);
      }),
    );
  });

  it('is zero for the same date', () => {
    fc.assert(
      fc.property(dayOffsetArb, (a) => {
        expect(daysBetween(isoFromDayOffset(a), isoFromDayOffset(a))).toBe(0);
      }),
    );
  });

  it('is antisymmetric and additive', () => {
    fc.assert(
      fc.property(dayOffsetArb, dayOffsetArb, dayOffsetArb, (a, b, c) => {
        const [da, db, dc] = [isoFromDayOffset(a), isoFromDayOffset(b), isoFromDayOffset(c)];
        expect(daysBetween(da, db) + daysBetween(db, da)).toBe(0);
        expect(daysBetween(da, db) + daysBetween(db, dc)).toBe(daysBetween(da, dc));
      }),
    );
  });
});

// --- assertShelfLifeSufficient (condition 5) -------------------------------------------------------

const MAX_MIN_LIFE_DAYS = 3650;
const minLifeArb = fc.integer({ min: 0, max: MAX_MIN_LIFE_DAYS });

describe('assertShelfLifeSufficient — property (condition 5)', () => {
  it('never throws when every lot has remaining life >= the minimum, or no expiry date at all', () => {
    fc.assert(
      fc.property(
        dayOffsetArb,
        minLifeArb,
        fc.array(fc.record({ extra: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }), batchNo: fc.string() }), { maxLength: 8 }),
        (asOf, minDays, specs) => {
          const lots: ShelfLifeCandidateLot[] = specs.map(({ extra, batchNo }) => ({
            expiryDate: extra === null ? null : isoFromDayOffset(asOf + minDays + extra),
            batchNo,
          }));
          expect(() => assertShelfLifeSufficient(lots, isoFromDayOffset(asOf), minDays, 'SKU-1')).not.toThrow();
        },
      ),
    );
  });

  it('throws ShelfLifeTooShortError naming the FIRST lot below the minimum, with its exact remaining days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_MIN_LIFE_DAYS, max: MAX_DAY_OFFSET }),
        fc.integer({ min: 1, max: MAX_MIN_LIFE_DAYS }),
        fc.array(fc.record({ remaining: fc.option(fc.integer({ min: -MAX_MIN_LIFE_DAYS, max: 2 * MAX_MIN_LIFE_DAYS }), { nil: null }) }), {
          minLength: 1,
          maxLength: 8,
        }),
        (asOf, minDays, specs) => {
          const lots: ShelfLifeCandidateLot[] = specs.map(({ remaining }, index) => ({
            expiryDate: remaining === null ? null : isoFromDayOffset(asOf + remaining),
            batchNo: `LOT-${index}`,
          }));
          const firstShortIndex = specs.findIndex(({ remaining }) => remaining !== null && remaining < minDays);
          const run = (): void => assertShelfLifeSufficient(lots, isoFromDayOffset(asOf), minDays, 'SKU-1');
          if (firstShortIndex === -1) {
            expect(run).not.toThrow();
            return;
          }
          const error = (() => {
            try {
              run();
              return null;
            } catch (err: unknown) {
              return err;
            }
          })();
          expect(error).toBeInstanceOf(ShelfLifeTooShortError);
          expect((error as ShelfLifeTooShortError).i18nKey).toBe('wms.outbound.check.shelfLifeTooShort');
          expect((error as ShelfLifeTooShortError).params).toEqual({
            skuCode: 'SKU-1',
            batchNo: `LOT-${firstShortIndex}`,
            remainingDays: specs[firstShortIndex]?.remaining,
            minRemainingLifeIssueDays: minDays,
          });
        },
      ),
    );
  });

  it('the boundary remaining === minimum never throws (>=, not >)', () => {
    fc.assert(
      fc.property(dayOffsetArb, minLifeArb, (asOf, minDays) => {
        const lots: ShelfLifeCandidateLot[] = [{ expiryDate: isoFromDayOffset(asOf + minDays), batchNo: 'LOT-EDGE' }];
        expect(() => assertShelfLifeSufficient(lots, isoFromDayOffset(asOf), minDays, 'SKU-1')).not.toThrow();
      }),
    );
  });
});

// --- assertSkuNotBlocked (condition 6) -------------------------------------------------------------

describe('assertSkuNotBlocked — property (condition 6)', () => {
  it('status "active" never throws', () => {
    fc.assert(
      fc.property(uuidArb, fc.string(), (skuId, skuCode) => {
        expect(() => assertSkuNotBlocked({ skuId, skuCode, status: 'active' })).not.toThrow();
      }),
    );
  });

  it('any status other than "active" always throws SkuBlockedError carrying the SKU code and the actual status', () => {
    fc.assert(
      fc.property(uuidArb, fc.string(), fc.string().filter((status) => status !== 'active'), (skuId, skuCode, status) => {
        const error = (() => {
          try {
            assertSkuNotBlocked({ skuId, skuCode, status });
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        expect(error).toBeInstanceOf(SkuBlockedError);
        expect((error as SkuBlockedError).i18nKey).toBe('wms.outbound.check.skuBlocked');
        expect((error as SkuBlockedError).params).toEqual({ skuId, skuCode, status });
      }),
    );
  });
});

// --- assertSkuResolved (condition 4 precondition, finding 11) --------------------------------------

describe('assertSkuResolved — property (condition 4 precondition, finding 11)', () => {
  it('a resolved row never throws', () => {
    fc.assert(
      fc.property(uuidArb, uuidArb, (skuId, clientId) => {
        expect(() => assertSkuResolved({ code: 'SKU-1', clientId }, skuId)).not.toThrow();
      }),
    );
  });

  it('an unresolved row (null or undefined) always throws SkuNotFoundError { skuId } — never SkuClientMismatchError', () => {
    fc.assert(
      fc.property(uuidArb, fc.constantFrom(null, undefined), (skuId, missing) => {
        const error = (() => {
          try {
            assertSkuResolved(missing, skuId);
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        expect(error).toBeInstanceOf(SkuNotFoundError);
        expect(error).not.toBeInstanceOf(SkuClientMismatchError);
        expect((error as SkuNotFoundError).i18nKey).toBe('wms.outbound.check.skuNotFound');
        expect((error as SkuNotFoundError).params).toEqual({ skuId });
      }),
    );
  });
});

// --- assertDeliveryAddressComplete (condition 8) ----------------------------------------------------

// Brief Master decision 2 (orderType enum) + decision 3 condition 8 (no address for these two).
const NO_DELIVERY_ORDER_TYPES: ReadonlySet<string> = new Set(['transfer', 'return_to_client']);
const DELIVERY_ORDER_TYPES = ['standard', 'rush'] as const;
const SHIP_TO_FIELDS = ['shipToName', 'shipToPhone', 'shipToAddress', 'shipToArea'] as const;

// A field value that is either blank (null / empty / whitespace-only) or genuinely filled.
const blankFieldArb = fc.constantFrom<string | null>(null, '', ' ', '\t', '   ');
const filledFieldArb = fc.string({ minLength: 1 }).filter((v) => v.trim().length > 0);
const fieldArb = fc.oneof(blankFieldArb, filledFieldArb);

function isBlank(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

describe('assertDeliveryAddressComplete — property (condition 8)', () => {
  it('a non-delivery order type never throws, whatever the ship-to fields hold', () => {
    fc.assert(
      fc.property(fc.constantFrom(...NO_DELIVERY_ORDER_TYPES), fieldArb, fieldArb, fieldArb, fieldArb, (orderType, name, phone, address, area) => {
        const check: DeliveryAddressCheck = { orderId: 'o-1', orderType, shipToName: name, shipToPhone: phone, shipToAddress: address, shipToArea: area };
        expect(() => assertDeliveryAddressComplete(check, NO_DELIVERY_ORDER_TYPES)).not.toThrow();
      }),
    );
  });

  it('a delivery order type throws DeliveryAddressIncompleteError iff a field is blank, listing EXACTLY the blank fields in order', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DELIVERY_ORDER_TYPES), fieldArb, fieldArb, fieldArb, fieldArb, (orderType, name, phone, address, area) => {
        const values = [name, phone, address, area];
        const check: DeliveryAddressCheck = { orderId: 'o-1', orderType, shipToName: name, shipToPhone: phone, shipToAddress: address, shipToArea: area };
        const expectedMissing = SHIP_TO_FIELDS.filter((_, index) => isBlank(values[index] ?? null));
        const error = (() => {
          try {
            assertDeliveryAddressComplete(check, NO_DELIVERY_ORDER_TYPES);
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        if (expectedMissing.length === 0) {
          expect(error).toBeNull();
        } else {
          expect(error).toBeInstanceOf(DeliveryAddressIncompleteError);
          expect((error as DeliveryAddressIncompleteError).i18nKey).toBe('wms.outbound.check.deliveryAddressIncomplete');
          expect((error as DeliveryAddressIncompleteError).params).toEqual({ missingFields: expectedMissing });
        }
      }),
    );
  });
});

// --- assertServicePriced (condition 9) --------------------------------------------------------------

describe('assertServicePriced — property (condition 9)', () => {
  it('throws NoServicePriceError (quoting the service code) iff there is neither a priced line nor a price exception', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.string({ minLength: 1 }), orderIdArb, (hasLine, hasException, serviceCode, orderId) => {
        const error = (() => {
          try {
            assertServicePriced(hasLine, hasException, serviceCode, orderId);
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        if (hasLine || hasException) {
          expect(error).toBeNull();
        } else {
          expect(error).toBeInstanceOf(NoServicePriceError);
          expect((error as NoServicePriceError).i18nKey).toBe('wms.outbound.check.noServicePrice');
          expect((error as NoServicePriceError).params).toEqual({ serviceCode });
        }
      }),
    );
  });
});

// --- assertOrderQuantityWithinLimit (condition 10, WBS 2.11 part 5, D-189) --------------------------
//
// numeric(14,3) fixture range, same thousandths discipline as the condition 3/7 fractional blocks
// above (finding 7) — fractional 3-decimal quantities, exact thousandths comparison, never a plain
// float `Number()` compare.

describe('assertOrderQuantityWithinLimit — property (condition 10, D-189)', () => {
  it('a null limit never throws, whatever the ordered quantity', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), thousandthsArb, (skuCode, orderedT) => {
        expect(() =>
          assertOrderQuantityWithinLimit({ skuCode, ordered: thousandthsToQty(orderedT), limit: null }),
        ).not.toThrow();
      }),
    );
  });

  it('ordered <= limit never throws (exact thousandths comparison)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), thousandthsArb, fc.integer({ min: 0, max: THOUSANDTHS_PER_UNIT }), (skuCode, limitT, extra) => {
        const orderedT = Math.max(0, limitT - extra);
        expect(() =>
          assertOrderQuantityWithinLimit({
            skuCode,
            ordered: thousandthsToQty(orderedT),
            limit: thousandthsToQty(limitT),
          }),
        ).not.toThrow();
      }),
    );
  });

  it('the boundary ordered === limit never throws (inclusive)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), thousandthsArb, (skuCode, limitT) => {
        const qty = thousandthsToQty(limitT);
        expect(() => assertOrderQuantityWithinLimit({ skuCode, ordered: qty, limit: qty })).not.toThrow();
      }),
    );
  });

  it('ordered > limit always throws OrderQuantityExceededError carrying the exact skuCode, ordered and limit', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        thousandthsArb,
        fc.integer({ min: 1, max: THOUSANDTHS_PER_UNIT }),
        (skuCode, limitT, excess) => {
          const orderedT = limitT + excess;
          const ordered = thousandthsToQty(orderedT);
          const limit = thousandthsToQty(limitT);
          const error = (() => {
            try {
              assertOrderQuantityWithinLimit({ skuCode, ordered, limit });
              return null;
            } catch (err: unknown) {
              return err;
            }
          })();
          expect(error).toBeInstanceOf(OrderQuantityExceededError);
          expect((error as OrderQuantityExceededError).i18nKey).toBe('wms.outbound.check.orderQuantityExceeded');
          expect((error as OrderQuantityExceededError).params).toEqual({ skuCode, ordered, limit });
        },
      ),
    );
  });
});

// --- evaluateCreditHold (condition 2 — decision only, never throws) --------------------------------

describe('evaluateCreditHold — property (condition 2)', () => {
  it('no account row (null) is never on hold', () => {
    expect(evaluateCreditHold(null)).toEqual({ onHold: false, holdReason: null });
  });

  it('never throws; onHold mirrors credit_hold; the reason is carried only when on hold', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.option(fc.string(), { nil: null }), (creditHold, holdReason) => {
        const decision = evaluateCreditHold({ creditHold, holdReason });
        expect(decision).toEqual(creditHold ? { onHold: true, holdReason } : { onHold: false, holdReason: null });
      }),
    );
  });
});

// --- allocateFromSingleLot (WBS 2.11 part 2, Master decision 2, fix round 1 findings 1/3) ------
//
// Pure decision function part 2's own Allocate command needs: given `orderedQty` and `lots`
// ALREADY ordered by the application/repository layer (FEFO — expiry_date ascending, nulls last;
// FIFO — stock_balance.last_movement_at ascending; LIFO — reverse of FIFO — SQL's own job, not this
// function's), selects a SINGLE lot (Master ruling, fix round 1 findings 1/3 — `wms.order_lines`
// has one `location_id`/`batch_no` per line, no per-lot allocation child table exists, G-01 filed
// as SCR-WMS-OUT-01, never split across two lots): the FIRST lot (in policy order) whose own
// `available` covers the ENTIRE `orderedQty`, taken in full; else the FIRST lot in policy order,
// taking `min(available, ordered)`, whatever is left over is `shortfall`; empty `lots` (or none with
// positive `available`) leaves the whole `orderedQty` as `shortfall`. part 1's own fix-round finding
// 7 was exactly an IEEE-754 rounding bug in this class of arithmetic — every property below
// generates FRACTIONAL 3-decimal quantities (qtyStringArb-shaped), never whole numbers only, and
// checks the sums through `Quantity`, never `Number()` + `toFixed`.

// Kept SMALL (0.001..99.999) so a 6-lot array's sum stays comfortably inside numeric(14,3) under
// fc's shrinking — the fractional-precision behaviour under test does not need large magnitudes.
const positiveLotQtyArb = fc
  .tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(3, '0')}`)
  .filter((qty) => Number(qty) > 0);

const lotsArb = fc
  .array(positiveLotQtyArb, { minLength: 1, maxLength: 6 })
  .map((qtys): AllocationLotCandidate[] => qtys.map((available, index) => ({ lotKey: `lot-${index}`, available })));

describe('allocateFromSingleLot — property (WBS 2.11 part 2, Allocate, single-lot rule)', () => {
  it('consumed.qty summed + shortfall === orderedQty, exactly (fractional 3-decimal, finding-7 regression guard)', () => {
    fc.assert(
      fc.property(positiveLotQtyArb, lotsArb, (orderedQty, lots) => {
        const result: AllocationResult = allocateFromSingleLot(orderedQty, lots);
        const consumedSum = result.consumed.reduce((acc, c) => acc.add(Quantity.of(c.qty)), Quantity.zero());
        expect(consumedSum.add(Quantity.of(result.shortfall)).toString()).toBe(Quantity.of(orderedQty).toString());
      }),
    );
  });

  it('never consumes more than a lot\'s own available, and never emits a zero/negative consumption row', () => {
    fc.assert(
      fc.property(positiveLotQtyArb, lotsArb, (orderedQty, lots) => {
        const result: AllocationResult = allocateFromSingleLot(orderedQty, lots);
        const availableByKey = new Map(lots.map((lot) => [lot.lotKey, Quantity.of(lot.available)]));
        for (const c of result.consumed) {
          const available = availableByKey.get(c.lotKey);
          expect(available).toBeDefined();
          const qty = Quantity.of(c.qty);
          expect(qty.isPositive()).toBe(true);
          expect(qty.compare(available as Quantity)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  // --- Fix round 1 (Master ruling, findings 1/3): a line is allocated from a SINGLE lot, never
  // split across two (`wms.order_lines` has one `location_id`/`batch_no` per line, no per-lot
  // allocation child table exists — G-01 filed as SCR-WMS-OUT-01). The properties below pin the
  // single-lot contract: preference 1 is the FIRST lot (in policy order) whose OWN `available` covers the
  // ENTIRE `orderedQty`, taken in full; else preference 2 is the FIRST lot in policy order,
  // taking `min(available, ordered)`, whatever is left is `shortfall`.

  it('never selects more than one lot — a line is never split across two lots (Master ruling, findings 1/3)', () => {
    fc.assert(
      fc.property(positiveLotQtyArb, lotsArb, (orderedQty, lots) => {
        const result: AllocationResult = allocateFromSingleLot(orderedQty, lots);
        expect(result.consumed.length).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('when a lot in the given (policy) order fully covers orderedQty, the FIRST such lot alone is consumed in full, shortfall is "0.000", and every other lot is left untouched', () => {
    fc.assert(
      fc.property(positiveLotQtyArb, lotsArb, (orderedQty, lots) => {
        const ordered = Quantity.of(orderedQty);
        const fullyCoveringIndex = lots.findIndex((lot) => Quantity.of(lot.available).compare(ordered) >= 0);
        fc.pre(fullyCoveringIndex !== -1);
        const chosen = lots[fullyCoveringIndex] as AllocationLotCandidate;
        const result: AllocationResult = allocateFromSingleLot(orderedQty, lots);
        expect(result.consumed).toEqual([{ lotKey: chosen.lotKey, qty: ordered.toString() }]);
        expect(result.shortfall).toBe('0.000');
      }),
    );
  });

  it('when NO lot in the given (policy) order fully covers orderedQty, the FIRST lot alone (still the best by FEFO/FIFO/LIFO) is consumed for min(available, ordered), the remainder is shortfall, and every other lot is left untouched', () => {
    fc.assert(
      fc.property(positiveLotQtyArb, lotsArb, (orderedQty, lots) => {
        const ordered = Quantity.of(orderedQty);
        fc.pre(!lots.some((lot) => Quantity.of(lot.available).compare(ordered) >= 0));
        const first = lots[0] as AllocationLotCandidate;
        const firstAvailable = Quantity.of(first.available);
        const expectedTake = firstAvailable.compare(ordered) < 0 ? firstAvailable : ordered;
        const result: AllocationResult = allocateFromSingleLot(orderedQty, lots);
        expect(result.consumed).toEqual([{ lotKey: first.lotKey, qty: expectedTake.toString() }]);
        expect(result.shortfall).toBe(ordered.subtract(expectedTake).toString());
      }),
    );
  });

  it('an empty lot list never throws — the whole orderedQty is shortfall', () => {
    fc.assert(
      fc.property(positiveLotQtyArb, (orderedQty) => {
        const result: AllocationResult = allocateFromSingleLot(orderedQty, []);
        expect(result.consumed).toEqual([]);
        expect(result.shortfall).toBe(Quantity.of(orderedQty).toString());
      }),
    );
  });
});

// =================================================================================================
// WBS 2.12 part 1 (_slice-2.12.brief.md) — PickLine + CheckOrder pure invariants. RED until
// domain/process-outbound/invariants.ts exports assertVarianceReasonRequired/assertCheckerNotPicker
// and domain/process-outbound/errors.ts exports VarianceReasonRequiredError/SelfCheckNotAllowedError.
// Reuses thousandthsArb/thousandthsToQty (finding 7's own exact-thousandths discipline, above) and
// blankFieldArb/filledFieldArb (condition 8's own blank-vs-filled discipline, above) — never a new
// ad-hoc generator for the same shape.
// =================================================================================================

// --- assertVarianceReasonRequired (PickLine shortage check, brief Master decision 2) ---------------

describe('assertVarianceReasonRequired — property (PickLine shortage check, WBS 2.12 part 1)', () => {
  it('never throws when qtyActual === qtyOrdered, whatever the varianceReason (including blank/null)', () => {
    fc.assert(
      fc.property(thousandthsArb, fieldArb, uuidArb, (qtyT, varianceReason, lineId) => {
        const qty = thousandthsToQty(qtyT);
        expect(() =>
          assertVarianceReasonRequired({ lineId, qtyOrdered: qty, qtyActual: qty, varianceReason }),
        ).not.toThrow();
      }),
    );
  });

  it('never throws when qtyActual < qtyOrdered and varianceReason is a non-blank string', () => {
    fc.assert(
      fc.property(
        thousandthsArb,
        fc.integer({ min: 1, max: THOUSANDTHS_PER_UNIT }),
        filledFieldArb,
        uuidArb,
        (orderedT, deficit, reason, lineId) => {
          const actualT = Math.max(0, orderedT - deficit);
          fc.pre(actualT < orderedT);
          expect(() =>
            assertVarianceReasonRequired({
              lineId,
              qtyOrdered: thousandthsToQty(orderedT),
              qtyActual: thousandthsToQty(actualT),
              varianceReason: reason,
            }),
          ).not.toThrow();
        },
      ),
    );
  });

  it('always throws VarianceReasonRequiredError when qtyActual < qtyOrdered and varianceReason is blank/null, carrying i18nKey wms.outbound.pick.varianceReasonRequired', () => {
    fc.assert(
      fc.property(
        thousandthsArb,
        fc.integer({ min: 1, max: THOUSANDTHS_PER_UNIT }),
        blankFieldArb,
        uuidArb,
        (orderedT, deficit, reason, lineId) => {
          const actualT = Math.max(0, orderedT - deficit);
          fc.pre(actualT < orderedT);
          const qtyOrdered = thousandthsToQty(orderedT);
          const qtyActual = thousandthsToQty(actualT);
          const error = (() => {
            try {
              assertVarianceReasonRequired({ lineId, qtyOrdered, qtyActual, varianceReason: reason });
              return null;
            } catch (err: unknown) {
              return err;
            }
          })();
          expect(error).toBeInstanceOf(VarianceReasonRequiredError);
          expect((error as VarianceReasonRequiredError).i18nKey).toBe('wms.outbound.pick.varianceReasonRequired');
          expect((error as VarianceReasonRequiredError).params).toEqual({ lineId, qtyOrdered, qtyActual });
        },
      ),
    );
  });

  it('a 0.001 shortfall on a fractional quantity with no reason always throws (finding-7-style regression guard, exact thousandths)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_QTY_THOUSANDTHS }), uuidArb, (orderedT, lineId) => {
        expect(() =>
          assertVarianceReasonRequired({
            lineId,
            qtyOrdered: thousandthsToQty(orderedT),
            qtyActual: thousandthsToQty(orderedT - 1),
            varianceReason: null,
          }),
        ).toThrow(VarianceReasonRequiredError);
      }),
    );
  });
});

// --- assertPickedWithinReserved (PickLine over-pick gate, fix round 1 finding 3 — WBS 2.12 part 2
// item 1, deferred by part 1's review cap, doc `docs/notes/slice-briefs/_slice-2.12.brief.md`
// Master decision 4) --------------------------------------------------------------------------------

describe('assertPickedWithinReserved — property (PickLine over-pick gate, WBS 2.12 part 2)', () => {
  it('never throws when qtyActual <= reserved', () => {
    fc.assert(
      fc.property(thousandthsArb, fc.integer({ min: 0, max: MAX_QTY_THOUSANDTHS }), uuidArb, (reservedT, deficit, lineId) => {
        const qtyActualT = Math.max(0, reservedT - deficit);
        const reserved = thousandthsToQty(reservedT);
        const qtyActual = thousandthsToQty(qtyActualT);
        expect(() => assertPickedWithinReserved({ lineId, reserved, qtyActual })).not.toThrow();
      }),
    );
  });

  it('always throws PickQuantityExceedsReservedError when qtyActual > reserved, carrying i18nKey wms.outbound.pick.qtyExceedsReserved', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_QTY_THOUSANDTHS - 1 }),
        fc.integer({ min: 1, max: THOUSANDTHS_PER_UNIT }),
        uuidArb,
        (reservedT, excess, lineId) => {
          const overT = reservedT + excess;
          const reserved = thousandthsToQty(reservedT);
          const qtyActual = thousandthsToQty(overT);
          const error = (() => {
            try {
              assertPickedWithinReserved({ lineId, reserved, qtyActual });
              return null;
            } catch (err: unknown) {
              return err;
            }
          })();
          expect(error).toBeInstanceOf(PickQuantityExceedsReservedError);
          expect((error as PickQuantityExceedsReservedError).i18nKey).toBe('wms.outbound.pick.qtyExceedsReserved');
          expect((error as PickQuantityExceedsReservedError).params).toEqual({ lineId, reserved, qtyActual });
        },
      ),
    );
  });
});

// --- assertLineReservedForPick (PickLine no-reservation gate, fix round 1 finding 6 — WBS 2.12
// part 2 item 1) -------------------------------------------------------------------------------------

describe('assertLineReservedForPick — property (PickLine no-reservation gate, WBS 2.12 part 2)', () => {
  it('never throws when locationId is non-null, whatever qtyActual', () => {
    fc.assert(
      fc.property(thousandthsArb, uuidArb, uuidArb, (qtyT, locationId, lineId) => {
        const qtyActual = thousandthsToQty(qtyT);
        expect(() => assertLineReservedForPick({ lineId, locationId, qtyActual })).not.toThrow();
      }),
    );
  });

  it('never throws when locationId is null and qtyActual is exactly zero', () => {
    fc.assert(
      fc.property(uuidArb, (lineId) => {
        expect(() => assertLineReservedForPick({ lineId, locationId: null, qtyActual: '0.000' })).not.toThrow();
      }),
    );
  });

  it('always throws LineNotReservedForPickError when locationId is null and qtyActual > 0, carrying i18nKey wms.outbound.pick.lineNotReserved', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_QTY_THOUSANDTHS }), uuidArb, (qtyT, lineId) => {
        const qtyActual = thousandthsToQty(qtyT);
        const error = (() => {
          try {
            assertLineReservedForPick({ lineId, locationId: null, qtyActual });
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        expect(error).toBeInstanceOf(LineNotReservedForPickError);
        expect((error as LineNotReservedForPickError).i18nKey).toBe('wms.outbound.pick.lineNotReserved');
        expect((error as LineNotReservedForPickError).params).toEqual({ lineId, qtyActual });
      }),
    );
  });
});

// --- assertLineNotAlreadyPicked (PickLine double-pick guard, fix round 1 finding 2 — WBS 2.12
// part 2 item 1, trivial boolean-in property still required for coverage parity, Master decision 4)
// -----------------------------------------------------------------------------------------------------

describe('assertLineNotAlreadyPicked — property (PickLine double-pick guard, WBS 2.12 part 2)', () => {
  it('never throws when alreadyPicked is false', () => {
    fc.assert(
      fc.property(uuidArb, (lineId) => {
        expect(() => assertLineNotAlreadyPicked(lineId, false)).not.toThrow();
      }),
    );
  });

  it('always throws LineAlreadyPickedError when alreadyPicked is true, carrying i18nKey wms.outbound.pick.lineAlreadyPicked', () => {
    fc.assert(
      fc.property(uuidArb, (lineId) => {
        const error = (() => {
          try {
            assertLineNotAlreadyPicked(lineId, true);
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        expect(error).toBeInstanceOf(LineAlreadyPickedError);
        expect((error as LineAlreadyPickedError).i18nKey).toBe('wms.outbound.pick.lineAlreadyPicked');
        expect((error as LineAlreadyPickedError).params).toEqual({ lineId });
      }),
    );
  });
});

// --- assertCheckerNotPicker (CheckOrder self-check gate — doc 38 row 2.12's own acceptance line).
// WBS 2.12 part 2, Master decision 3/5 (_slice-2.12.brief.md): the invariant's signature widens from
// `{orderId, checkerId, pickedBy}` to `{orderId, checkerId, wasPicker: boolean}` — the checker is
// rejected whenever they touched this order's picking in ANY way (the last picked_by OR any posted
// pick movement's performed_by), not merely when they equal the order's own last picked_by. RED
// until pg-backend lands the new signature on domain/process-outbound/invariants.ts's own
// assertCheckerNotPicker (this file will not even compile against today's `pickedBy`-shaped
// signature, which IS the point). ----------------------------------------------------------------

describe('assertCheckerNotPicker — property (CheckOrder self-check gate, WBS 2.12 part 2)', () => {
  it('never throws when wasPicker is false', () => {
    fc.assert(
      fc.property(uuidArb, orderIdArb, (checkerId, orderId) => {
        expect(() => assertCheckerNotPicker({ orderId, checkerId, wasPicker: false })).not.toThrow();
      }),
    );
  });

  it('always throws SelfCheckNotAllowedError when wasPicker is true, carrying i18nKey wms.outbound.check.selfCheckNotAllowed', () => {
    fc.assert(
      fc.property(uuidArb, orderIdArb, (actorId, orderId) => {
        const error = (() => {
          try {
            assertCheckerNotPicker({ orderId, checkerId: actorId, wasPicker: true });
            return null;
          } catch (err: unknown) {
            return err;
          }
        })();
        expect(error).toBeInstanceOf(SelfCheckNotAllowedError);
        expect((error as SelfCheckNotAllowedError).i18nKey).toBe('wms.outbound.check.selfCheckNotAllowed');
        expect((error as SelfCheckNotAllowedError).params).toEqual({ orderId, actorId });
      }),
    );
  });
});
