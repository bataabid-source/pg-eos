// modules/fleet/tests/register-vehicle/errors.unit.test.ts — WBS 3.1, domain unit.
//
// Every typed error is mapped by name in api/register-vehicle/handlers.ts; pin the names so a
// rename cannot silently turn a 409/422 into a 500.
import { describe, expect, it } from 'vitest';

import {
  DuplicatePlateNoError,
  EntityScopeAmbiguousError,
  MissingActorError,
  VehicleDocumentAccessDeniedError,
} from '../../domain/register-vehicle/errors.js';

describe('register-vehicle typed errors', () => {
  it.each([
    [MissingActorError, 'MissingActorError'],
    [EntityScopeAmbiguousError, 'EntityScopeAmbiguousError'],
  ] as const)('%s carries its message and name', (Ctor, name) => {
    const error = new Ctor('why');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.message).toBe('why');
  });

  it.each([
    [DuplicatePlateNoError, 'DuplicatePlateNoError'],
    [VehicleDocumentAccessDeniedError, 'VehicleDocumentAccessDeniedError'],
  ] as const)('%s keeps the database cause it translates', (Ctor, name) => {
    const cause = new Error('23505');
    const error = new Ctor('translated', { cause });
    expect(error.name).toBe(name);
    expect(error.cause).toBe(cause);
  });
});
