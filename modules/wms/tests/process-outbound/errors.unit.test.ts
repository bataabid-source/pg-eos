// modules/wms/tests/process-outbound/errors.unit.test.ts — domain unit tests for
// modules/wms/domain/process-outbound/errors.ts (Stryker mutation gate, doc 40 Part F G16).
//
// Pure, no DB, no I/O. Constructs EVERY error class exported by errors.ts and pins:
//   - `.name` (exact string, an Error subclass does not get it for free at runtime);
//   - `.message` (exact pass-through of the constructor argument, including the empty string);
//   - every instance property carried on the OutboundCheckError subclasses (`.i18nKey`, `.params`,
//     including the "not passed"/empty-object branch);
//   - `instanceof Error` / `instanceof OutboundCheckError` for the right subset;
//   - `.name` uniqueness across the whole file (no two classes share a name — a copy/paste mutant).

import { describe, expect, it } from 'vitest';

import {
  CancelReasonRequiredError,
  ClientNotQualifiedError,
  ContractExpiredError,
  ContractNotActiveError,
  CreditHoldError,
  DeliveryAddressIncompleteError,
  IllegalTransitionError,
  InsufficientStockError,
  LineAlreadyPickedError,
  LineNotReservedForPickError,
  MissingActorError,
  NoServicePriceError,
  OrderLineNotFoundError,
  OrderNotFoundError,
  OrderQuantityExceededError,
  OutboundCheckError,
  OutboundLocationBlockedError,
  PickQuantityExceedsReservedError,
  RoleRequiredError,
  SelfCheckNotAllowedError,
  ShelfLifeTooShortError,
  SkuBlockedError,
  SkuClientMismatchError,
  SkuNotFoundError,
  StaleVersionError,
  StockBalanceRowMissingError,
  VarianceReasonRequiredError,
} from '../../domain/process-outbound/errors.js';

// --- plain Error subclasses (message-only constructor) -------------------------------------------

describe('plain Error subclasses — name, message, instanceof', () => {
  const cases: ReadonlyArray<{
    readonly ctor: new (message: string) => Error;
    readonly name: string;
  }> = [
    { ctor: StaleVersionError, name: 'StaleVersionError' },
    { ctor: IllegalTransitionError, name: 'IllegalTransitionError' },
    { ctor: RoleRequiredError, name: 'RoleRequiredError' },
    { ctor: OrderNotFoundError, name: 'OrderNotFoundError' },
    { ctor: MissingActorError, name: 'MissingActorError' },
    { ctor: ClientNotQualifiedError, name: 'ClientNotQualifiedError' },
    { ctor: CancelReasonRequiredError, name: 'CancelReasonRequiredError' },
  ];

  it.each(cases)('$name carries the exact name and the exact message given', ({ ctor, name }) => {
    const err = new ctor('a distinctive message for ' + name);
    expect(err.name).toBe(name);
    expect(err.message).toBe('a distinctive message for ' + name);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ctor);
  });

  it.each(cases)('$name carries the empty-string message unchanged', ({ ctor, name }) => {
    const err = new ctor('');
    expect(err.name).toBe(name);
    expect(err.message).toBe('');
  });

  it('every plain-Error-subclass name above is unique (no copy/paste collision)', () => {
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// --- OutboundCheckError subclasses (message + params constructor) --------------------------------

describe('OutboundCheckError subclasses — name, message, i18nKey, params, instanceof', () => {
  // Each entry constructs its own instance directly (constructors take mutually incompatible
  // narrowed `params` shapes, so a single shared `ctor` field would need `any` — CLAUDE.md
  // forbids it); `build` closes over a fixed `message`/`params` pair so every case still runs
  // through the same shared assertions below.
  const cases: ReadonlyArray<{
    readonly build: (message: string) => OutboundCheckError;
    readonly name: string;
    readonly i18nKey: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly isInstanceOf: (err: OutboundCheckError) => boolean;
  }> = [
    {
      build: (message) => new ContractNotActiveError(message, {}),
      name: 'ContractNotActiveError',
      i18nKey: 'wms.outbound.check.contractNotActive',
      params: {},
      isInstanceOf: (err) => err instanceof ContractNotActiveError,
    },
    {
      build: (message) => new ContractExpiredError(message, { expiryDate: '2024-01-01' }),
      name: 'ContractExpiredError',
      i18nKey: 'wms.outbound.check.contractExpired',
      params: { expiryDate: '2024-01-01' },
      isInstanceOf: (err) => err instanceof ContractExpiredError,
    },
    {
      build: (message) => new CreditHoldError(message, { holdReason: 'over limit' }),
      name: 'CreditHoldError',
      i18nKey: 'wms.outbound.check.creditHold',
      params: { holdReason: 'over limit' },
      isInstanceOf: (err) => err instanceof CreditHoldError,
    },
    {
      build: (message) =>
        new InsufficientStockError(message, {
          skuId: 's-1',
          skuCode: 'SKU-1',
          available: '1.000',
          ordered: '2.000',
          location: null,
        }),
      name: 'InsufficientStockError',
      i18nKey: 'wms.outbound.check.insufficientStock',
      params: { skuId: 's-1', skuCode: 'SKU-1', available: '1.000', ordered: '2.000', location: null },
      isInstanceOf: (err) => err instanceof InsufficientStockError,
    },
    {
      build: (message) => new SkuClientMismatchError(message, { skuId: 's-1', skuCode: 'SKU-1' }),
      name: 'SkuClientMismatchError',
      i18nKey: 'wms.outbound.check.skuClientMismatch',
      params: { skuId: 's-1', skuCode: 'SKU-1' },
      isInstanceOf: (err) => err instanceof SkuClientMismatchError,
    },
    {
      build: (message) => new SkuNotFoundError(message, { skuId: 's-1' }),
      name: 'SkuNotFoundError',
      i18nKey: 'wms.outbound.check.skuNotFound',
      params: { skuId: 's-1' },
      isInstanceOf: (err) => err instanceof SkuNotFoundError,
    },
    {
      build: (message) =>
        new ShelfLifeTooShortError(message, {
          skuCode: 'SKU-1',
          batchNo: 'LOT-1',
          remainingDays: 1,
          minRemainingLifeIssueDays: 5,
        }),
      name: 'ShelfLifeTooShortError',
      i18nKey: 'wms.outbound.check.shelfLifeTooShort',
      params: { skuCode: 'SKU-1', batchNo: 'LOT-1', remainingDays: 1, minRemainingLifeIssueDays: 5 },
      isInstanceOf: (err) => err instanceof ShelfLifeTooShortError,
    },
    {
      build: (message) => new SkuBlockedError(message, { skuId: 's-1', skuCode: 'SKU-1', status: 'blocked' }),
      name: 'SkuBlockedError',
      i18nKey: 'wms.outbound.check.skuBlocked',
      params: { skuId: 's-1', skuCode: 'SKU-1', status: 'blocked' },
      isInstanceOf: (err) => err instanceof SkuBlockedError,
    },
    {
      build: (message) =>
        new OutboundLocationBlockedError(message, {
          skuId: 's-1',
          available: '0.000',
          ordered: '1.000',
          locationCode: 'A-1',
          blockReason: 'damaged',
        }),
      name: 'OutboundLocationBlockedError',
      i18nKey: 'wms.outbound.check.locationBlocked',
      params: { skuId: 's-1', available: '0.000', ordered: '1.000', locationCode: 'A-1', blockReason: 'damaged' },
      isInstanceOf: (err) => err instanceof OutboundLocationBlockedError,
    },
    {
      build: (message) => new DeliveryAddressIncompleteError(message, { missingFields: ['shipToName'] }),
      name: 'DeliveryAddressIncompleteError',
      i18nKey: 'wms.outbound.check.deliveryAddressIncomplete',
      params: { missingFields: ['shipToName'] },
      isInstanceOf: (err) => err instanceof DeliveryAddressIncompleteError,
    },
    {
      build: (message) => new NoServicePriceError(message, { serviceCode: 'OF-01' }),
      name: 'NoServicePriceError',
      i18nKey: 'wms.outbound.check.noServicePrice',
      params: { serviceCode: 'OF-01' },
      isInstanceOf: (err) => err instanceof NoServicePriceError,
    },
    {
      build: (message) => new OrderQuantityExceededError(message, { skuCode: 'SKU-1', ordered: '10.000', limit: '5.000' }),
      name: 'OrderQuantityExceededError',
      i18nKey: 'wms.outbound.check.orderQuantityExceeded',
      params: { skuCode: 'SKU-1', ordered: '10.000', limit: '5.000' },
      isInstanceOf: (err) => err instanceof OrderQuantityExceededError,
    },
    {
      build: (message) =>
        new VarianceReasonRequiredError(message, { lineId: 'l-1', qtyOrdered: '10.000', qtyActual: '5.000' }),
      name: 'VarianceReasonRequiredError',
      i18nKey: 'wms.outbound.pick.varianceReasonRequired',
      params: { lineId: 'l-1', qtyOrdered: '10.000', qtyActual: '5.000' },
      isInstanceOf: (err) => err instanceof VarianceReasonRequiredError,
    },
    {
      build: (message) => new SelfCheckNotAllowedError(message, { orderId: 'o-1', actorId: 'u-1' }),
      name: 'SelfCheckNotAllowedError',
      i18nKey: 'wms.outbound.check.selfCheckNotAllowed',
      params: { orderId: 'o-1', actorId: 'u-1' },
      isInstanceOf: (err) => err instanceof SelfCheckNotAllowedError,
    },
    {
      build: (message) => new OrderLineNotFoundError(message, { lineId: 'l-1', orderId: 'o-1' }),
      name: 'OrderLineNotFoundError',
      i18nKey: 'wms.outbound.pick.lineNotFound',
      params: { lineId: 'l-1', orderId: 'o-1' },
      isInstanceOf: (err) => err instanceof OrderLineNotFoundError,
    },
    {
      build: (message) => new LineAlreadyPickedError(message, { lineId: 'l-1' }),
      name: 'LineAlreadyPickedError',
      i18nKey: 'wms.outbound.pick.lineAlreadyPicked',
      params: { lineId: 'l-1' },
      isInstanceOf: (err) => err instanceof LineAlreadyPickedError,
    },
    {
      build: (message) =>
        new PickQuantityExceedsReservedError(message, { lineId: 'l-1', reserved: '5.000', qtyActual: '6.000' }),
      name: 'PickQuantityExceedsReservedError',
      i18nKey: 'wms.outbound.pick.qtyExceedsReserved',
      params: { lineId: 'l-1', reserved: '5.000', qtyActual: '6.000' },
      isInstanceOf: (err) => err instanceof PickQuantityExceedsReservedError,
    },
    {
      build: (message) => new LineNotReservedForPickError(message, { lineId: 'l-1', qtyActual: '1.000' }),
      name: 'LineNotReservedForPickError',
      i18nKey: 'wms.outbound.pick.lineNotReserved',
      params: { lineId: 'l-1', qtyActual: '1.000' },
      isInstanceOf: (err) => err instanceof LineNotReservedForPickError,
    },
  ];

  it.each(cases)('$name: name, message, i18nKey and params are exact', ({ build, name, i18nKey, params, isInstanceOf }) => {
    const message = 'distinctive message for ' + name;
    const err = build(message);
    expect(err.name).toBe(name);
    expect(err.message).toBe(message);
    expect(err.i18nKey).toBe(i18nKey);
    expect(err.params).toEqual(params);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OutboundCheckError);
    expect(isInstanceOf(err)).toBe(true);
  });

  it('ContractNotActiveError constructed with an empty params object carries it verbatim (no fabricated key)', () => {
    const err = new ContractNotActiveError('no active contract', {});
    expect(err.params).toEqual({});
    expect(Object.keys(err.params)).toHaveLength(0);
  });

  it('every OutboundCheckError subclass i18nKey above is unique (no copy/paste collision)', () => {
    const keys = cases.map((c) => c.i18nKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every OutboundCheckError subclass name above is unique (no copy/paste collision)', () => {
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// --- StockBalanceRowMissingError (structured params, not a plain Record) -------------------------

describe('StockBalanceRowMissingError — structured params', () => {
  it('carries the exact name, message, i18nKey and every named param, including a null batchNo', () => {
    const params = { clientId: 'c-1', skuId: 's-1', locationId: 'loc-1', batchNo: null };
    const err = new StockBalanceRowMissingError('row missing', params);
    expect(err.name).toBe('StockBalanceRowMissingError');
    expect(err.message).toBe('row missing');
    expect(err.i18nKey).toBe('wms.outbound.allocation.stockBalanceRowMissing');
    expect(err.params).toEqual(params);
    expect(err).toBeInstanceOf(OutboundCheckError);
  });

  it('carries a non-null batchNo verbatim', () => {
    const params = { clientId: 'c-1', skuId: 's-1', locationId: 'loc-1', batchNo: 'LOT-9' };
    const err = new StockBalanceRowMissingError('row missing', params);
    expect(err.params).toEqual(params);
  });
});

// --- cross-class discrimination -------------------------------------------------------------------

describe('cross-class discrimination — every OutboundCheckError subclass is NOT any of its siblings', () => {
  it('ContractNotActiveError is never a ContractExpiredError and vice versa (distinct conditions, same base)', () => {
    const notActive = new ContractNotActiveError('x', {});
    const expired = new ContractExpiredError('y', { expiryDate: '2024-01-01' });
    expect(notActive).not.toBeInstanceOf(ContractExpiredError);
    expect(expired).not.toBeInstanceOf(ContractNotActiveError);
  });

  it('SkuNotFoundError is never a SkuClientMismatchError and vice versa (distinct preconditions of condition 4)', () => {
    const notFound = new SkuNotFoundError('x', { skuId: 's-1' });
    const mismatch = new SkuClientMismatchError('y', { skuId: 's-1', skuCode: 'SKU-1' });
    expect(notFound).not.toBeInstanceOf(SkuClientMismatchError);
    expect(mismatch).not.toBeInstanceOf(SkuNotFoundError);
  });
});
