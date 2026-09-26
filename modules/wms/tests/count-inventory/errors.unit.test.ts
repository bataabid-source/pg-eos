// modules/wms/tests/count-inventory/errors.unit.test.ts — domain unit tests for
// modules/wms/domain/count-inventory/errors.ts (Stryker mutation gate, doc 40 Part F G16).
//
// Pure, no DB, no I/O. Constructs EVERY error class exported by errors.ts and pins `.name` (exact
// string — an Error subclass does not get it for free at runtime), `.message` (exact pass-through,
// including the empty string), `instanceof Error`, and name uniqueness across the file.

import { describe, expect, it } from 'vitest';

import {
  AdjustmentPostingError,
  AlreadyCountedError,
  CountFilterRequiredError,
  CountNotFoundError,
  IllegalTransitionError,
  LineNotFoundError,
  MissingActorError,
  MovementUomNotFoundError,
  NotFlaggedForRecountError,
  RecountRequiredError,
  RoleRequiredError,
  SkuNotFoundError,
  StaleVersionError,
  WarehouseNotFoundError,
} from '../../domain/count-inventory/errors.js';

const cases: ReadonlyArray<{ readonly ctor: new (message: string) => Error; readonly name: string }> = [
  { ctor: StaleVersionError, name: 'StaleVersionError' },
  { ctor: IllegalTransitionError, name: 'IllegalTransitionError' },
  { ctor: RoleRequiredError, name: 'RoleRequiredError' },
  { ctor: AlreadyCountedError, name: 'AlreadyCountedError' },
  { ctor: NotFlaggedForRecountError, name: 'NotFlaggedForRecountError' },
  { ctor: CountFilterRequiredError, name: 'CountFilterRequiredError' },
  { ctor: WarehouseNotFoundError, name: 'WarehouseNotFoundError' },
  { ctor: CountNotFoundError, name: 'CountNotFoundError' },
  { ctor: LineNotFoundError, name: 'LineNotFoundError' },
  { ctor: SkuNotFoundError, name: 'SkuNotFoundError' },
  { ctor: MissingActorError, name: 'MissingActorError' },
  { ctor: RecountRequiredError, name: 'RecountRequiredError' },
  { ctor: MovementUomNotFoundError, name: 'MovementUomNotFoundError' },
  { ctor: AdjustmentPostingError, name: 'AdjustmentPostingError' },
];

describe('count-inventory errors — name, message, instanceof', () => {
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
