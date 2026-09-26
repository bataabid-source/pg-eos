// modules/wms/tests/take-occupancy-snapshot/errors.unit.test.ts — domain unit tests for
// modules/wms/domain/take-occupancy-snapshot/errors.ts (Stryker mutation gate, doc 40 Part F G16).
//
// Pure, no DB, no I/O. Constructs EVERY error class exported by errors.ts and pins `.name` (exact
// string), `.message` (exact pass-through, including the empty string), `instanceof Error`, and
// name uniqueness across the file.

import { describe, expect, it } from 'vitest';

import {
  MissingActorError,
  RoleRequiredError,
  ServiceNotFoundError,
  WarehouseNotFoundError,
} from '../../domain/take-occupancy-snapshot/errors.js';

const cases: ReadonlyArray<{ readonly ctor: new (message: string) => Error; readonly name: string }> = [
  { ctor: RoleRequiredError, name: 'RoleRequiredError' },
  { ctor: WarehouseNotFoundError, name: 'WarehouseNotFoundError' },
  { ctor: ServiceNotFoundError, name: 'ServiceNotFoundError' },
  { ctor: MissingActorError, name: 'MissingActorError' },
];

describe('take-occupancy-snapshot errors — name, message, instanceof', () => {
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

  it('every name above is unique (no copy/paste collision across 4 classes)', () => {
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(4);
  });
});
