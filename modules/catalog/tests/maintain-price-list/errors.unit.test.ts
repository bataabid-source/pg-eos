// modules/catalog/tests/maintain-price-list/errors.unit.test.ts — WBS 1.2, M03 catalog.
//
// Pure unit tests pinning the EXACT surface of every typed error in
// modules/catalog/domain/maintain-price-list/errors.ts — added to raise Stryker's mutation score
// on this file (surviving mutants: string-literal `name` values, and PriceBelowFloorError's
// instance-property wiring). No I/O, no pg, no withContext.
//
// Every class must: extend Error, set `this.name` to its EXACT class name (never the generic
// 'Error' a bare `extends Error` would give at runtime), and preserve the constructor's `message`
// verbatim on `.message`.

import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  EmptyPriceListError,
  IllegalTransitionError,
  InvalidValidityError,
  MissingActorError,
  PriceBelowFloorError,
  PriceListCodeTakenError,
  PriceListLockedError,
  PriceListNotFoundError,
  RoleRequiredError,
  SegmentAndClientError,
  ServiceNotFoundError,
  ServiceNotPriceableError,
  StaleVersionError,
  TierLadderError,
} from '../../domain/maintain-price-list/errors.js';

// [ClassName, exact expected `.name`, constructor] — every simple (message-only) error class.
const SIMPLE_ERROR_CASES: ReadonlyArray<{
  readonly ctor: new (message: string) => Error;
  readonly expectedName: string;
}> = [
  { ctor: StaleVersionError, expectedName: 'StaleVersionError' },
  { ctor: IllegalTransitionError, expectedName: 'IllegalTransitionError' },
  { ctor: RoleRequiredError, expectedName: 'RoleRequiredError' },
  { ctor: PriceListLockedError, expectedName: 'PriceListLockedError' },
  { ctor: ServiceNotFoundError, expectedName: 'ServiceNotFoundError' },
  { ctor: ServiceNotPriceableError, expectedName: 'ServiceNotPriceableError' },
  { ctor: CurrencyMismatchError, expectedName: 'CurrencyMismatchError' },
  { ctor: PriceListCodeTakenError, expectedName: 'PriceListCodeTakenError' },
  { ctor: SegmentAndClientError, expectedName: 'SegmentAndClientError' },
  { ctor: InvalidValidityError, expectedName: 'InvalidValidityError' },
  { ctor: EmptyPriceListError, expectedName: 'EmptyPriceListError' },
  { ctor: TierLadderError, expectedName: 'TierLadderError' },
  { ctor: MissingActorError, expectedName: 'MissingActorError' },
  { ctor: PriceListNotFoundError, expectedName: 'PriceListNotFoundError' },
];

describe('maintain-price-list errors — every simple error sets its OWN exact name and message', () => {
  for (const { ctor, expectedName } of SIMPLE_ERROR_CASES) {
    it(`${expectedName}: name === "${expectedName}", instanceof Error, message preserved verbatim`, () => {
      const message = `probe message for ${expectedName} — ${Math.random().toString(36).slice(2)}`;
      const err = new ctor(message);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(expectedName);
      expect(err.message).toBe(message);
      // The name must be the class's OWN name, not the generic 'Error' a missing `this.name =`
      // assignment would leave in place, and not another class's name (guards against a
      // string-literal mutant that swaps one class's `this.name` for another's).
      expect(err.name).not.toBe('Error');
    });
  }

  it('every SIMPLE_ERROR_CASES `expectedName` is unique (no two classes share a name)', () => {
    const names = SIMPLE_ERROR_CASES.map((c) => c.expectedName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('PriceBelowFloorError — exact instance properties (Master decision 4)', () => {
  it('name is exactly "PriceBelowFloorError"', () => {
    const err = new PriceBelowFloorError('price too low', {
      serviceCode: 'ST-01',
      price: '10.000',
      minPrice: '15.000',
    });
    expect(err.name).toBe('PriceBelowFloorError');
    expect(err).toBeInstanceOf(Error);
  });

  it('carries serviceCode/price/minPrice verbatim, and rowIndex is undefined when not passed', () => {
    const err = new PriceBelowFloorError('price too low', {
      serviceCode: 'ST-01',
      price: '10.000',
      minPrice: '15.000',
    });
    expect(err.serviceCode).toBe('ST-01');
    expect(err.price).toBe('10.000');
    expect(err.minPrice).toBe('15.000');
    expect(err.rowIndex).toBeUndefined();
  });

  it('carries rowIndex verbatim, including the falsy value 0, when passed (ImportPriceListLines)', () => {
    const errZero = new PriceBelowFloorError('row 0 too low', {
      serviceCode: 'ST-02',
      price: '1.000',
      minPrice: '2.000',
      rowIndex: 0,
    });
    expect(errZero.rowIndex).toBe(0);

    const errThree = new PriceBelowFloorError('row 3 too low', {
      serviceCode: 'ST-03',
      price: '1.000',
      minPrice: '2.000',
      rowIndex: 3,
    });
    expect(errThree.rowIndex).toBe(3);
  });

  it('message is preserved verbatim', () => {
    const message = 'exact price-below-floor message, probe 42';
    const err = new PriceBelowFloorError(message, { serviceCode: 'X', price: '1', minPrice: '2' });
    expect(err.message).toBe(message);
  });

  it('does not confuse serviceCode/price/minPrice with each other (each field is its own value)', () => {
    const err = new PriceBelowFloorError('m', { serviceCode: 'A', price: 'B', minPrice: 'C', rowIndex: 7 });
    expect(err.serviceCode).toBe('A');
    expect(err.price).toBe('B');
    expect(err.minPrice).toBe('C');
    expect(err.rowIndex).toBe(7);
    // Pin that the four fields are distinct properties (a mutant aliasing two params would fail).
    expect([err.serviceCode, err.price, err.minPrice, String(err.rowIndex)]).toEqual(['A', 'B', 'C', '7']);
  });
});
