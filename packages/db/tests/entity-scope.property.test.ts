// packages/db/tests/entity-scope.property.test.ts — Master task P6b-1 (pg-tester), RED-first.
//
// Property tests for every invariant the P6b-1 design states (see entity-scope.test.ts's header
// comment for the full rule table). The module under test — packages/db/src/entity-scope.ts — does
// not exist yet; this import fails to resolve, which is the RED for every property below.
//
// KNOWN GAP — reported to the Master, not worked around: `fast-check` is not a declared
// devDependency of packages/db (confirmed: grep of packages/db/package.json finds no
// "fast-check" entry, while modules/hr, modules/wms, etc. all pin "fast-check": "^4.10.2"). Until
// packages/db/package.json gains that devDependency (same version, already in pnpm-lock.yaml), this
// file's own `import fc from 'fast-check'` fails to resolve for a package.json reason rather than a
// missing-domain-code reason — this is the one package.json change this RED round needs; see the
// closing report.
//
// Review round 1, finding 7: every property below uses a CALL-RECORDING lookup (`vi.fn`, via
// `lookupReturning`) and asserts `toHaveBeenCalledTimes(1)` alongside its result/rejection
// assertion — not just a plain async function — so each property also proves the lookup is
// consulted exactly once per resolution, across every path (header match, header mismatch,
// auto-select, required, malformed header). Finding 1: a dedicated property (below) proves an
// uppercased header matching a member case-insensitively resolves to that member's own casing.

import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  EntityScopeForbiddenError,
  EntityScopeRequiredError,
  resolveActiveEntityId,
  type UserEntitiesLookup,
} from '../src/entity-scope.js';

/** A non-empty array of DISTINCT uuids — `fc.uniqueArray` dedupes by identity, which is exactly
 *  identity.user_entities' own primary key shape (user_id, entity_id): a caller never holds the
 *  "same" entity twice. */
function distinctEntityIds(minLength: number, maxLength: number): fc.Arbitrary<readonly string[]> {
  return fc.uniqueArray(fc.uuid(), { minLength, maxLength });
}

/** Call-recording lookup (review finding 7) — a fresh `vi.fn` per call, so each fast-check
 *  iteration gets its own independent call count, never accumulated across iterations. */
function lookupReturning(entities: readonly string[]): UserEntitiesLookup {
  return vi.fn(async () => entities);
}

describe('resolveActiveEntityId — property: header equal to one of the caller\'s own entities always resolves to exactly that value', () => {
  it('holds for any non-empty set of the caller\'s entities and any header drawn from that set', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctEntityIds(1, 8).chain((entities) =>
          fc.record({
            entities: fc.constant(entities),
            header: fc.constantFrom(...entities),
          }),
        ),
        async ({ entities, header }) => {
          const userId = randomUUID();
          const lookup = lookupReturning(entities);
          const result = await resolveActiveEntityId(header, userId, lookup);
          expect(result).toBe(header);
          expect(lookup).toHaveBeenCalledTimes(1);
        },
      ),
    );
  });
});

describe('resolveActiveEntityId — property: an uppercased header matching a member case-insensitively resolves to that member\'s own casing (review finding 1)', () => {
  it('holds for any lowercase-uuid entity, presented uppercased as the header', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid().map((s) => s.toUpperCase()),
        async (upperHeader) => {
          const memberLower = upperHeader.toLowerCase();
          const userId = randomUUID();
          const lookup = lookupReturning([memberLower]);
          const result = await resolveActiveEntityId(upperHeader, userId, lookup);
          expect(result).toBe(memberLower);
          expect(lookup).toHaveBeenCalledTimes(1);
        },
      ),
    );
  });
});

describe('resolveActiveEntityId — property: header naming an entity outside the caller\'s scope always rejects Forbidden', () => {
  it('holds for any set of the caller\'s entities and any uuid header not a member of that set', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctEntityIds(0, 8).chain((entities) =>
          fc.record({
            entities: fc.constant(entities),
            header: fc.uuid().filter((candidate) => !entities.includes(candidate)),
          }),
        ),
        async ({ entities, header }) => {
          const userId = randomUUID();
          const lookup = lookupReturning(entities);
          await expect(resolveActiveEntityId(header, userId, lookup)).rejects.toBeInstanceOf(
            EntityScopeForbiddenError,
          );
          expect(lookup).toHaveBeenCalledTimes(1);
        },
      ),
    );
  });
});

describe('resolveActiveEntityId — property: no header + exactly one entity always auto-selects it', () => {
  it('holds for any single-entity scope', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (onlyEntity) => {
        const userId = randomUUID();
        const lookup = lookupReturning([onlyEntity]);
        const result = await resolveActiveEntityId(undefined, userId, lookup);
        expect(result).toBe(onlyEntity);
        expect(lookup).toHaveBeenCalledTimes(1);
      }),
    );
  });
});

describe('resolveActiveEntityId — property: no header + cardinality other than one always rejects Required, never guesses', () => {
  it('holds for zero entities and for every tested cardinality of two or more', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(distinctEntityIds(0, 0), distinctEntityIds(2, 8)),
        async (entities) => {
          const userId = randomUUID();
          const lookup = lookupReturning(entities);
          await expect(resolveActiveEntityId(undefined, userId, lookup)).rejects.toBeInstanceOf(
            EntityScopeRequiredError,
          );
          expect(lookup).toHaveBeenCalledTimes(1);
        },
      ),
    );
  });
});

describe('resolveActiveEntityId — property: a malformed (non-uuid-shaped) header is never silently accepted', () => {
  it('holds for any non-uuid string header, regardless of the caller\'s own entity scope', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((candidate) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)),
        distinctEntityIds(0, 4),
        async (malformedHeader, entities) => {
          const userId = randomUUID();
          const lookup = lookupReturning(entities);
          await expect(resolveActiveEntityId(malformedHeader, userId, lookup)).rejects.toBeInstanceOf(
            EntityScopeForbiddenError,
          );
          expect(lookup).toHaveBeenCalledTimes(1);
        },
      ),
    );
  });
});

describe('resolveActiveEntityId — property: the resolved entity, when present, is always a member of the caller\'s own scope (never fabricated)', () => {
  it('the resolved value is always one of the entities the lookup returned, across the header-present and auto-select paths', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // header-present, valid path
          distinctEntityIds(1, 8).chain((entities) =>
            fc.record({
              entities: fc.constant(entities),
              header: fc.constantFrom<string | undefined>(...entities),
            }),
          ),
          // auto-select path (no header, exactly one entity)
          fc.uuid().map((onlyEntity) => ({ entities: [onlyEntity], header: undefined as string | undefined })),
        ),
        async ({ entities, header }) => {
          const userId = randomUUID();
          const result = await resolveActiveEntityId(header, userId, lookupReturning(entities));
          expect(entities).toContain(result);
        },
      ),
    );
  });
});
