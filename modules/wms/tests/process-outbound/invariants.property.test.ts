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

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertNonBlockedLocationsSufficient,
  assertSkuBelongsToOrderClient,
  assertSufficientStock,
  type StockedLocationForBlockCheck,
} from '../../domain/process-outbound/invariants.js';
import { InsufficientStockError, LocationBlockedError, SkuClientMismatchError } from '../../domain/process-outbound/errors.js';

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
        expect(() => assertSkuBelongsToOrderClient(skuOwnershipCheck(a, b))).toThrow(SkuClientMismatchError);
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

  it('always throws LocationBlockedError when the NON-blocked-only sum < ordered — even if the TOTAL (including blocked) would cover it (finding 7: condition 7 must never accept blocked stock as sufficient)', () => {
    fc.assert(
      fc.property(fc.array(locationArb, { maxLength: 8 }), fc.integer({ min: 1, max: 1000 }), (locations, deficit) => {
        const ordered = (nonBlockedSum(locations) + deficit).toFixed(3);
        expect(() => assertNonBlockedLocationsSufficient(locations, ordered, 'sku-1')).toThrow(LocationBlockedError);
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
            LocationBlockedError,
          );
        },
      ),
    );
  });
});
