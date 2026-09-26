// modules/wms/tests/receive-inbound/errors.unit.test.ts — domain unit tests for
// modules/wms/domain/receive-inbound/errors.ts (Stryker mutation gate, doc 40 Part F G16, golden
// slice).
//
// Pure, no DB, no I/O. Constructs EVERY error class exported by errors.ts and pins `.name` (exact
// string), `.message` (exact pass-through, including the empty string), `instanceof Error`, and
// name uniqueness across the file.

import { describe, expect, it } from 'vitest';

import {
  CancelBlockedError,
  CloseBlockedError,
  IllegalTransitionError,
  LineAlreadyPutAwayError,
  LineAlreadyReceivedError,
  LineNotFoundError,
  MissingActorError,
  OrderNotFoundError,
  RcvBalanceMissingError,
  RoleRequiredError,
  SkuClientMismatchError,
  StaleVersionError,
  VarianceReasonRequiredError,
  VariancePhotoWithoutVarianceError,
} from '../../domain/receive-inbound/errors.js';

const cases: ReadonlyArray<{ readonly ctor: new (message: string) => Error; readonly name: string }> = [
  { ctor: StaleVersionError, name: 'StaleVersionError' },
  { ctor: IllegalTransitionError, name: 'IllegalTransitionError' },
  { ctor: RoleRequiredError, name: 'RoleRequiredError' },
  { ctor: SkuClientMismatchError, name: 'SkuClientMismatchError' },
  { ctor: VarianceReasonRequiredError, name: 'VarianceReasonRequiredError' },
  { ctor: CloseBlockedError, name: 'CloseBlockedError' },
  { ctor: CancelBlockedError, name: 'CancelBlockedError' },
  { ctor: OrderNotFoundError, name: 'OrderNotFoundError' },
  { ctor: LineNotFoundError, name: 'LineNotFoundError' },
  { ctor: LineAlreadyReceivedError, name: 'LineAlreadyReceivedError' },
  { ctor: LineAlreadyPutAwayError, name: 'LineAlreadyPutAwayError' },
  { ctor: RcvBalanceMissingError, name: 'RcvBalanceMissingError' },
  { ctor: VariancePhotoWithoutVarianceError, name: 'VariancePhotoWithoutVarianceError' },
  { ctor: MissingActorError, name: 'MissingActorError' },
];

describe('receive-inbound errors — name, message, instanceof', () => {
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

  it('every name above is unique (no copy/paste collision across 14 classes)', () => {
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(14);
  });
});
