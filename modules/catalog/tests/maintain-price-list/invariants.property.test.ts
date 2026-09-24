// modules/catalog/tests/maintain-price-list/invariants.property.test.ts — WBS 1.2, M03 catalog.
//
// Property tests (fast-check) for the pure domain invariants in
// modules/catalog/domain/maintain-price-list/invariants.ts — one property per invariant listed in
// the slice brief's "Property tests" section (a) and the validity checks of Master decisions 3/6/9.
//
// Expected new surface (RED until it exists):
//   modules/catalog/domain/maintain-price-list/invariants.ts
//     - `assertPriceMeetsFloor(price: Quantity, minPrice: Quantity): void` — Master decision 4.
//       Throws PriceBelowFloorError (../errors.js) iff price < minPrice; returns (no throw) iff
//       price >= minPrice. Pure: no I/O, no Date, no Math.random().
//     - `assertListEditable(status: PriceListStatus): void` — Master decision 3. Throws
//       PriceListLockedError iff status !== 'draft'; returns otherwise.
//     - `assertValidValidity(input: { validFrom: string; validTo: string | null; reviewAt?: string
//       | null }): void` — Master decisions 6/9 combined (CreatePriceList's `validTo >= validFrom`,
//       GrantPriceException's `reviewAt >= validFrom`). Throws InvalidValidityError iff
//       `validTo !== null && validTo < validFrom`, OR `reviewAt` is present (not null/undefined)
//       and `reviewAt < validFrom`. Compares ISO date strings ('YYYY-MM-DD') lexicographically —
//       valid for that format, no Date parsing needed. PG-BACKEND: this exact name/shape, chosen by
//       pg-tester since the brief names only assertPriceMeetsFloor/assertListEditable explicitly
//       (default taken, batched in the closing report).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Quantity } from '@pg-eos/domain-kit';

// The module under test — does not exist yet (RED).
import {
  assertListEditable,
  assertPriceMeetsFloor,
  assertValidValidity,
} from '../../domain/maintain-price-list/invariants.js';
import { InvalidValidityError, PriceBelowFloorError, PriceListLockedError } from '../../domain/maintain-price-list/errors.js';
import { PRICE_LIST_STATUS } from '../../domain/maintain-price-list/machine.js';

// numeric(14,3) fixture range: 0..10^11-1 integer part, 0..999 thousandths — same pad width other
// suites in this workspace use (see modules/wms/tests/receive-inbound/invariants.property.test.ts).
const qtyArb = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 999 }))
  .map(([whole, frac]) => Quantity.of(`${whole}.${String(frac).padStart(3, '0')}`));

describe('assertPriceMeetsFloor — property: accepts iff price >= minPrice', () => {
  it('never throws when price > minPrice', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (a, b) => {
        fc.pre(a.compare(b) > 0);
        expect(() => assertPriceMeetsFloor(a, b)).not.toThrow();
      }),
    );
  });

  it('never throws when price === minPrice (the floor itself is acceptable)', () => {
    fc.assert(
      fc.property(qtyArb, (price) => {
        expect(() => assertPriceMeetsFloor(price, price)).not.toThrow();
      }),
    );
  });

  it('always throws PriceBelowFloorError when price < minPrice', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (a, b) => {
        fc.pre(a.compare(b) < 0);
        expect(() => assertPriceMeetsFloor(a, b)).toThrow(PriceBelowFloorError);
      }),
    );
  });
});

describe('assertListEditable — property: throws PriceListLockedError iff status !== "draft"', () => {
  it('never throws for "draft"', () => {
    expect(() => assertListEditable(PRICE_LIST_STATUS.DRAFT)).not.toThrow();
  });

  it('always throws PriceListLockedError for "active" and "expired"', () => {
    fc.assert(
      fc.property(fc.constantFrom(PRICE_LIST_STATUS.ACTIVE, PRICE_LIST_STATUS.EXPIRED), (status) => {
        expect(() => assertListEditable(status)).toThrow(PriceListLockedError);
      }),
    );
  });
});

// ISO date strings built from a fixed epoch offset in days — lexicographic string comparison of
// 'YYYY-MM-DD' matches calendar-date ordering, so this arbitrary is sufficient without a real
// calendar library and without Date (CLAUDE.md: no `new Date()` in domain/ or its property tests).
const EPOCH_DAY_MS = 86_400_000;
const isoDateArb = fc
  .integer({ min: 0, max: 3650 })
  .map((days) => new Date(Date.UTC(2020, 0, 1) + days * EPOCH_DAY_MS).toISOString().slice(0, 10));

describe('assertValidValidity — property: validTo >= validFrom (Master decision 6)', () => {
  it('never throws when validTo is null', () => {
    fc.assert(
      fc.property(isoDateArb, (validFrom) => {
        expect(() => assertValidValidity({ validFrom, validTo: null })).not.toThrow();
      }),
    );
  });

  it('never throws when validTo >= validFrom', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (a, b) => {
        fc.pre(a <= b);
        expect(() => assertValidValidity({ validFrom: a, validTo: b })).not.toThrow();
      }),
    );
  });

  it('always throws InvalidValidityError when validTo < validFrom', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (a, b) => {
        fc.pre(a < b);
        // a < b, so validFrom=b, validTo=a is the violating order.
        expect(() => assertValidValidity({ validFrom: b, validTo: a })).toThrow(InvalidValidityError);
      }),
    );
  });
});

describe('assertValidValidity — property: reviewAt >= validFrom (Master decision 9)', () => {
  it('never throws when reviewAt is omitted', () => {
    fc.assert(
      fc.property(isoDateArb, (validFrom) => {
        expect(() => assertValidValidity({ validFrom, validTo: null })).not.toThrow();
      }),
    );
  });

  it('never throws when reviewAt >= validFrom', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (a, b) => {
        fc.pre(a <= b);
        expect(() => assertValidValidity({ validFrom: a, validTo: null, reviewAt: b })).not.toThrow();
      }),
    );
  });

  it('always throws InvalidValidityError when reviewAt < validFrom', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (a, b) => {
        fc.pre(a < b);
        expect(() => assertValidValidity({ validFrom: b, validTo: null, reviewAt: a })).toThrow(
          InvalidValidityError,
        );
      }),
    );
  });
});
