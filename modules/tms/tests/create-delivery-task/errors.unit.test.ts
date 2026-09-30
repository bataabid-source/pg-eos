// modules/tms/tests/create-delivery-task/errors.unit.test.ts — WBS 3.4 part 1.
//
// Pure, no DB. Pins `.name` (exact string), `.message` pass-through, `instanceof Error` and — for the
// three business-rule errors the api layer surfaces in the Problem body — the exact `i18nKey`
// (brief Decision 4). The rules that THROW these errors are asserted once each, in
// ./invariants.unit.test.ts and ./create-delivery-task.test.ts, not here.

import { describe, expect, it } from 'vitest';

import {
  AddressIncompleteError,
  DeliveryTaskAlreadyExistsError,
  MissingActorError,
  OrderNotFoundError,
  OrderNotReadyError,
  StaleVersionError,
} from '../../domain/create-delivery-task/errors.js';

const cases: ReadonlyArray<{
  readonly ctor: new (message: string) => Error & { readonly i18nKey?: string };
  readonly name: string;
  readonly i18nKey: string | undefined;
}> = [
  { ctor: StaleVersionError, name: 'StaleVersionError', i18nKey: undefined },
  { ctor: OrderNotFoundError, name: 'OrderNotFoundError', i18nKey: undefined },
  { ctor: MissingActorError, name: 'MissingActorError', i18nKey: undefined },
  { ctor: AddressIncompleteError, name: 'AddressIncompleteError', i18nKey: 'tms.task.create.addressIncomplete' },
  { ctor: OrderNotReadyError, name: 'OrderNotReadyError', i18nKey: 'tms.task.create.orderNotReady' },
  { ctor: DeliveryTaskAlreadyExistsError, name: 'DeliveryTaskAlreadyExistsError', i18nKey: 'tms.task.create.alreadyExists' },
];

describe('create-delivery-task errors — name, message, i18nKey, instanceof', () => {
  it.each(cases)('$name carries the exact name, message and i18nKey', ({ ctor, name, i18nKey }) => {
    const err = new ctor(`a distinctive message for ${name}`);
    expect(err.name).toBe(name);
    expect(err.message).toBe(`a distinctive message for ${name}`);
    expect(err.i18nKey).toBe(i18nKey);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ctor);
  });

  it('carries the empty-string message unchanged', () => {
    expect(new AddressIncompleteError('').message).toBe('');
  });

  it('every name is unique', () => {
    const names = cases.map((c) => new c.ctor('x').name);
    expect(new Set(names).size).toBe(names.length);
  });
});
