// modules/wms/tests/manage-space/errors.unit.test.ts — domain unit tests for
// modules/wms/domain/manage-space/errors.ts (Stryker mutation gate, doc 40 Part F G16).
//
// Pure, no DB, no I/O. Constructs EVERY error class exported by errors.ts and pins `.name` (exact
// string), `.message` (exact pass-through, including empty string), `instanceof Error`, and name
// uniqueness. NonPositiveQtyError/SpaceNotAvailableError also accept an optional `{ cause }` —
// pinned as its own case (a mutant dropping the `options` forwarding would surface as `.cause`
// silently becoming `undefined`).

import { describe, expect, it } from 'vitest';

import {
  EntityScopeAmbiguousError,
  MissingActorError,
  NonPositiveQtyError,
  ReservationDateRangeInvalidError,
  ReservationTooLongError,
  RoleRequiredError,
  SpaceNotAvailableError,
} from '../../domain/manage-space/errors.js';

const simpleCases: ReadonlyArray<{ readonly ctor: new (message: string) => Error; readonly name: string }> = [
  { ctor: ReservationTooLongError, name: 'ReservationTooLongError' },
  { ctor: ReservationDateRangeInvalidError, name: 'ReservationDateRangeInvalidError' },
  { ctor: RoleRequiredError, name: 'RoleRequiredError' },
  { ctor: EntityScopeAmbiguousError, name: 'EntityScopeAmbiguousError' },
  { ctor: MissingActorError, name: 'MissingActorError' },
];

describe('manage-space simple errors — name, message, instanceof', () => {
  it.each(simpleCases)('$name carries the exact name and the exact message given', ({ ctor, name }) => {
    const err = new ctor('a distinctive message for ' + name);
    expect(err.name).toBe(name);
    expect(err.message).toBe('a distinctive message for ' + name);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ctor);
  });

  it.each(simpleCases)('$name carries the empty-string message unchanged', ({ ctor, name }) => {
    const err = new ctor('');
    expect(err.name).toBe(name);
    expect(err.message).toBe('');
  });
});

const causeCases: ReadonlyArray<{
  readonly ctor: new (message: string, options?: { readonly cause?: unknown }) => Error;
  readonly name: string;
}> = [
  { ctor: NonPositiveQtyError, name: 'NonPositiveQtyError' },
  { ctor: SpaceNotAvailableError, name: 'SpaceNotAvailableError' },
];

describe('manage-space errors with an optional cause — name, message, cause forwarding', () => {
  it.each(causeCases)('$name carries the exact name and message with no options passed', ({ ctor, name }) => {
    const err = new ctor('a distinctive message for ' + name);
    expect(err.name).toBe(name);
    expect(err.message).toBe('a distinctive message for ' + name);
    expect(err.cause).toBeUndefined();
  });

  it.each(causeCases)('$name forwards a supplied cause verbatim via options', ({ ctor, name }) => {
    const cause = new Error('underlying SQLSTATE 23514');
    const err = new ctor('a distinctive message for ' + name, { cause });
    expect(err.cause).toBe(cause);
  });

  it.each(causeCases)('$name carries the empty-string message unchanged', ({ ctor, name }) => {
    const err = new ctor('');
    expect(err.name).toBe(name);
    expect(err.message).toBe('');
  });
});

describe('manage-space errors — full name uniqueness across the file', () => {
  it('every name above is unique (no copy/paste collision across 7 classes)', () => {
    const names = [...simpleCases.map((c) => c.name), ...causeCases.map((c) => c.name)];
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(7);
  });
});
