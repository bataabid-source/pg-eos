// packages/db/src/entity-scope.ts — Master task P6b-1.
//
// resolveActiveEntityId(headerValue, userId, lookupUserEntities) — decides which
// identity.user_entities row a request acts as, per D-190 (Master task P6b-1 brief,
// 2026-09-26; see packages/db/tests/entity-scope.test.ts's header comment for the full rule
// table this implements verbatim):
//   - header present + one of the caller's own entities  -> use it;
//   - header present + NOT one of the caller's entities, OR malformed (not uuid-shaped,
//     including an empty string) -> EntityScopeForbiddenError (403);
//   - header absent + caller holds exactly one entity -> use that entity, automatically;
//   - header absent + caller holds 0 or 2+ entities -> EntityScopeRequiredError (422).
//
// `lookupUserEntities` is called EXACTLY ONCE, unconditionally, before any branch returns or
// throws — the header is never trusted on its own; every accepted value is proven against a
// fresh read of the caller's own scope first.
//
// Both error classes follow the existing typed-error, code-referenced-i18n-key pattern (see
// modules/fleet/domain/assert-vehicle-assignable/errors.ts's `VehicleNotAssignableError`): the
// key is a `readonly` instance property, read by a future api/ layer — there is no
// packages/i18n bootstrap yet.

import { sql } from 'drizzle-orm';

import { withContext, type WithContextCtx } from './with-context.js';

/** doc 40 · identity.entityScope.forbidden — header present but not one of the caller's own
 *  entities, or not uuid-shaped at all (a malformed value can never legitimately be one of the
 *  caller's real entity ids, so it fails the exact same membership check). */
const ENTITY_SCOPE_FORBIDDEN_I18N_KEY = 'identity.entityScope.forbidden';

/** doc 40 · identity.entityScope.required — header absent and the caller's own entity count is
 *  not exactly one, so no automatic choice can be made without guessing. */
const ENTITY_SCOPE_REQUIRED_I18N_KEY = 'identity.entityScope.required';

/** RFC 4122 textual shape (case-insensitive) — the one format `platform.entities.id` /
 *  `identity.user_entities.entity_id` can ever hold as a uuid column. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown when the `X-Entity-Id` header names an entity the caller does not hold, or is not
 *  uuid-shaped at all. Maps to HTTP 403 at a future api/ layer — no route exists yet. */
export class EntityScopeForbiddenError extends Error {
  readonly i18nKey = ENTITY_SCOPE_FORBIDDEN_I18N_KEY;

  constructor(message: string) {
    super(message);
    this.name = 'EntityScopeForbiddenError';
  }
}

/** Thrown when no `X-Entity-Id` header was sent and the caller's own entity count is not exactly
 *  one, so the active entity cannot be chosen automatically. Maps to HTTP 422 at a future api/
 *  layer — no route exists yet. */
export class EntityScopeRequiredError extends Error {
  readonly i18nKey = ENTITY_SCOPE_REQUIRED_I18N_KEY;

  constructor(message: string) {
    super(message);
    this.name = 'EntityScopeRequiredError';
  }
}

/** Reads the full set of entity ids a given user belongs to (identity.user_entities). Never
 *  trusted for anything other than a membership check — the caller-supplied header is checked
 *  against this, never the other way around. */
export type UserEntitiesLookup = (userId: string) => Promise<readonly string[]>;

export async function resolveActiveEntityId(
  headerValue: string | undefined,
  userId: string,
  lookupUserEntities: UserEntitiesLookup,
): Promise<string> {
  // Called unconditionally, exactly once, BEFORE any branch below returns or throws — the header
  // is never trusted before this call has resolved.
  const entities = await lookupUserEntities(userId);

  if (headerValue !== undefined) {
    if (!UUID_PATTERN.test(headerValue)) {
      throw new EntityScopeForbiddenError(
        `X-Entity-Id header does not name an entity that user ${userId} belongs to. Allowed: ` +
          'X-Entity-Id = one of your own entities, or omit it when you hold exactly one.',
      );
    }
    // Postgres returns uuid text in lowercase (identity.user_entities.entity_id is a uuid
    // column) — normalize the header the same way before the membership check, so an
    // otherwise-valid, differently-cased header is not rejected as out-of-scope, and the value
    // this function returns matches the lookup's own casing exactly.
    const candidate = headerValue.toLowerCase();
    if (!entities.includes(candidate)) {
      throw new EntityScopeForbiddenError(
        `X-Entity-Id header does not name an entity that user ${userId} belongs to. Allowed: ` +
          'X-Entity-Id = one of your own entities, or omit it when you hold exactly one.',
      );
    }
    return candidate;
  }

  if (entities.length === 1) {
    const [onlyEntity] = entities;
    if (onlyEntity !== undefined) {
      return onlyEntity;
    }
  }

  throw new EntityScopeRequiredError(
    `User ${userId} holds ${entities.length} entities, not exactly one — X-Entity-Id is ` +
      `required. Allowed: send X-Entity-Id with one of your ${entities.length} entities.`,
  );
}

/**
 * Production `UserEntitiesLookup` over `identity.user_entities`, run inside `withContext` (never
 * a bare `db.*` call — the lint rule in eslint-rules/no-db-outside-with-context.js forbids that
 * outside this package's own plumbing).
 *
 * SECURITY (review round 1, finding 2): `identity.user_entities` itself carries no RLS policy
 * (migration 0007 grants `pgeos_app` a bare SELECT on it), so a query parameterized on an
 * arbitrary `userId` argument could read another user's memberships. This reads
 * `platform.allowed_entities()` instead — the SECURITY DEFINER function keyed on
 * `platform.current_user_id()` (itself read back from the `app.user_id` GUC `withContext` sets
 * from `ctx.userId`), the exact same set every entity-scoped RLS policy in this schema already
 * trusts. The `UserEntitiesLookup` parameter is kept (tests exercise that shape), but the
 * production path never lets it choose whose entities are read: a mismatch against `ctx.userId`
 * throws rather than silently reading the session's own scope for a different id.
 */
export function createUserEntitiesLookup(ctx: WithContextCtx): UserEntitiesLookup {
  return (userId) => {
    if (userId !== ctx.userId) {
      throw new Error(
        `createUserEntitiesLookup: requested userId ${userId} does not match this session's own ` +
          `ctx.userId ${String(ctx.userId)} — the production lookup only ever reads the ` +
          'session\'s own entity scope (platform.allowed_entities()), never another user\'s.',
      );
    }
    return withContext(ctx, async (tx) => {
      const result = await tx.execute<{ entity_id: string }>(sql`
        select unnest(platform.allowed_entities()) as entity_id
      `);
      return result.rows.map((row) => row.entity_id);
    });
  };
}
