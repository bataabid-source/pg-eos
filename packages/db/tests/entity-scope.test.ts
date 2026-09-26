// packages/db/tests/entity-scope.test.ts — Master task P6b-1 (pg-tester), RED-first.
//
// Design ruled under D-190 (Master task P6b-1 brief, 2026-09-26):
//   - a request MAY carry the acting entity in the header `X-Entity-Id` (a header, not a body
//     field — no Zod contract change);
//   - header present + one of the caller's `identity.user_entities` -> use it;
//   - header present + NOT one of the caller's entities -> `EntityScopeForbiddenError` (maps to
//     HTTP 403 at the api layer — out of this part's scope, no route exists yet);
//   - header absent + caller holds exactly one entity -> use that entity, automatically;
//   - header absent + caller holds several (or zero) entities -> `EntityScopeRequiredError`
//     (maps to HTTP 422);
//   - a MALFORMED header (not a uuid) -> `EntityScopeForbiddenError` (decision taken here, per the
//     brief's "state which": a malformed value can never legitimately be one of the caller's real
//     entity ids, so it fails the exact same membership check as an out-of-scope one, with no
//     separate 400 validation branch needed).
//
// Review round 1 (7 findings) additions, this file's share:
//   - finding 1: headerValue is matched case-insensitively — an uppercase header naming a member
//     of the caller's own (lowercase) entities resolves to that member's OWN casing, never the
//     header's casing (the resolved value always comes from the lookup's own list).
//   - finding 7: `lookupUserEntities` is asserted `toHaveBeenCalledTimes(1)` on the absent-header
//     and malformed-header paths too, not only the header-present path; plus a case where the
//     lookup itself rejects — the resolver must propagate that rejection unchanged even when
//     headerValue looks like a syntactically valid entity id (it must never swallow or replace a
//     lookup failure with one of its own typed errors).
//
// Expected new domain surface — NONE OF THIS EXISTS YET (RED):
//   packages/db/src/entity-scope.ts
//     - `export type UserEntitiesLookup = (userId: string) => Promise<readonly string[]>;`
//     - `export function resolveActiveEntityId(headerValue: string | undefined, userId: string,
//        lookupUserEntities: UserEntitiesLookup): Promise<string>`
//     - `export class EntityScopeForbiddenError extends Error` — `readonly i18nKey =
//        'identity.entityScope.forbidden'` (same code-referenced-key pattern as
//        modules/fleet/domain/assert-vehicle-assignable/errors.ts's `VehicleNotAssignableError`;
//        there is no packages/i18n bootstrap yet, so the key lives as a readonly instance property
//        on the typed error, read by a future api/ layer).
//     - `export class EntityScopeRequiredError extends Error` — `readonly i18nKey =
//        'identity.entityScope.required'`.
//   packages/db/src/with-context.ts
//     - `WithContextCtx` gains a new OPTIONAL field: `readonly entityId?: string | null`.
//
// This file imports the module under test with a relative path — it does not exist yet, so the
// import itself fails to resolve (module-not-found), which is the RED for every test below, same
// discipline as packages/db/tests/with-context.test.ts's own header comment for WBS 0.11.

import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  EntityScopeForbiddenError,
  EntityScopeRequiredError,
  resolveActiveEntityId,
  type UserEntitiesLookup,
} from '../src/entity-scope.js';

function lookupReturning(entities: readonly string[]): UserEntitiesLookup {
  return vi.fn(async () => entities);
}

describe('resolveActiveEntityId — header present and valid (one of the caller\'s own entities)', () => {
  it('resolves to the header value when it is one of the entities the lookup returns', async () => {
    const userId = randomUUID();
    const chosen = randomUUID();
    const other = randomUUID();
    const lookup = lookupReturning([chosen, other]);

    const result = await resolveActiveEntityId(chosen, userId, lookup);

    expect(result).toBe(chosen);
    expect(lookup).toHaveBeenCalledWith(userId);
  });

  it('resolves to the header value when the caller holds exactly that one entity', async () => {
    const userId = randomUUID();
    const onlyEntity = randomUUID();
    const lookup = lookupReturning([onlyEntity]);

    const result = await resolveActiveEntityId(onlyEntity, userId, lookup);

    expect(result).toBe(onlyEntity);
  });

  it('resolves to the member\'s own (lowercase) casing when the header is that same member uppercased — review finding 1', async () => {
    const userId = randomUUID();
    // node's randomUUID() always returns lowercase hex — the canonical casing every seeded
    // identity.user_entities.entity_id / platform.entities.id value actually has.
    const memberLower = randomUUID();
    const lookup = lookupReturning([memberLower]);

    const result = await resolveActiveEntityId(memberLower.toUpperCase(), userId, lookup);

    expect(result).toBe(memberLower);
  });
});

describe('resolveActiveEntityId — header present but outside the caller\'s own entities (403)', () => {
  it('throws EntityScopeForbiddenError when the header names an entity the caller does not hold', async () => {
    const userId = randomUUID();
    const headerEntity = randomUUID();
    const lookup = lookupReturning([randomUUID(), randomUUID()]);

    await expect(resolveActiveEntityId(headerEntity, userId, lookup)).rejects.toBeInstanceOf(
      EntityScopeForbiddenError,
    );
  });

  it('throws EntityScopeForbiddenError when the header names an entity and the caller holds none at all', async () => {
    const userId = randomUUID();
    const headerEntity = randomUUID();
    const lookup = lookupReturning([]);

    await expect(resolveActiveEntityId(headerEntity, userId, lookup)).rejects.toBeInstanceOf(
      EntityScopeForbiddenError,
    );
  });

  it('the rejected error carries the identity.entityScope.forbidden i18n key', async () => {
    const userId = randomUUID();
    const lookup = lookupReturning([randomUUID()]);

    await expect(resolveActiveEntityId(randomUUID(), userId, lookup)).rejects.toMatchObject({
      name: 'EntityScopeForbiddenError',
      i18nKey: 'identity.entityScope.forbidden',
    });
  });
});

describe('resolveActiveEntityId — header absent, caller holds exactly one entity (auto-select)', () => {
  it('resolves to the caller\'s sole entity with no header at all', async () => {
    const userId = randomUUID();
    const onlyEntity = randomUUID();
    const lookup = lookupReturning([onlyEntity]);

    const result = await resolveActiveEntityId(undefined, userId, lookup);

    expect(result).toBe(onlyEntity);
    expect(lookup).toHaveBeenCalledWith(userId);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('resolveActiveEntityId — header absent, caller holds several entities (422)', () => {
  it('throws EntityScopeRequiredError when the caller holds two or more entities and sent no header', async () => {
    const userId = randomUUID();
    const lookup = lookupReturning([randomUUID(), randomUUID(), randomUUID()]);

    await expect(resolveActiveEntityId(undefined, userId, lookup)).rejects.toBeInstanceOf(
      EntityScopeRequiredError,
    );
  });

  it('throws EntityScopeRequiredError (never guesses) when the caller holds zero entities and sent no header', async () => {
    const userId = randomUUID();
    const lookup = lookupReturning([]);

    await expect(resolveActiveEntityId(undefined, userId, lookup)).rejects.toBeInstanceOf(
      EntityScopeRequiredError,
    );
  });

  it('the rejected error carries the identity.entityScope.required i18n key', async () => {
    const userId = randomUUID();
    const lookup = lookupReturning([randomUUID(), randomUUID()]);

    await expect(resolveActiveEntityId(undefined, userId, lookup)).rejects.toMatchObject({
      name: 'EntityScopeRequiredError',
      i18nKey: 'identity.entityScope.required',
    });
  });
});

describe('resolveActiveEntityId — malformed header (not a uuid) (decision: 403, not 400)', () => {
  it('throws EntityScopeForbiddenError for a header value that is not uuid-shaped, even if it collides textually with the start of a real entity id', async () => {
    const userId = randomUUID();
    const realEntity = randomUUID();
    const lookup = lookupReturning([realEntity]);
    const malformedHeader = 'not-a-uuid';

    await expect(resolveActiveEntityId(malformedHeader, userId, lookup)).rejects.toBeInstanceOf(
      EntityScopeForbiddenError,
    );
    // review finding 7: the lookup is still consulted exactly once even for a malformed header —
    // rejection comes from the SAME membership check as an out-of-scope header, not a separate
    // pre-lookup format-validation branch.
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('throws EntityScopeForbiddenError for an empty-string header rather than treating it as "absent"', async () => {
    const userId = randomUUID();
    const lookup = lookupReturning([randomUUID()]);

    await expect(resolveActiveEntityId('', userId, lookup)).rejects.toBeInstanceOf(
      EntityScopeForbiddenError,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('resolveActiveEntityId — a rejecting lookup is never swallowed (review finding 7)', () => {
  it('propagates the lookup\'s own rejection unchanged even when headerValue looks like a syntactically valid entity id', async () => {
    const userId = randomUUID();
    const plausibleHeader = randomUUID();
    const lookupFailure = new Error('user_entities lookup backend unavailable');
    const lookup: UserEntitiesLookup = vi.fn(async () => {
      throw lookupFailure;
    });

    await expect(resolveActiveEntityId(plausibleHeader, userId, lookup)).rejects.toBe(lookupFailure);
  });

  it('propagates the lookup\'s own rejection unchanged when headerValue is absent too', async () => {
    const userId = randomUUID();
    const lookupFailure = new Error('user_entities lookup backend unavailable');
    const lookup: UserEntitiesLookup = vi.fn(async () => {
      throw lookupFailure;
    });

    await expect(resolveActiveEntityId(undefined, userId, lookup)).rejects.toBe(lookupFailure);
  });
});

describe('resolveActiveEntityId — never trusts the header without calling the lookup first', () => {
  it('calls lookupUserEntities exactly once even when the header is present and looks valid', async () => {
    const userId = randomUUID();
    const chosen = randomUUID();
    const lookup = lookupReturning([chosen]);

    await resolveActiveEntityId(chosen, userId, lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(userId);
  });
});
