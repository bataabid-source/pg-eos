// modules/platform/domain/maintain-site/errors.ts — WBS 5.5a part 1 (lane 2).
//
// Typed errors for the maintain-site use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS; same discipline as modules/wms/domain/receive-inbound/errors.ts, THE GOLDEN
// SLICE) — an `Error` subclass does NOT get its constructor name for free at runtime. The api/
// layer (../../api/maintain-site/handlers.ts) maps these to the Problem envelope:
// StaleVersionError -> 409, everything else -> 422/400 per that layer's own map.
// IdempotencyConflictError is NOT declared here — it comes from `@pg-eos/db`
// (packages/db/src/idempotency.ts), same as the hr precedent.

/** brief D4/D5, chk_sites_client_pickup_account (migration 0015): `kind = 'client_pickup'`
 *  requires a non-null `accountId`. Thrown BEFORE any DB write — never relies on the DB CHECK's
 *  own error. Maps to HTTP 422. */
export class SiteAccountRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteAccountRequiredError';
  }
}

/** brief D5: a caller-supplied `radiusM` must be strictly positive. Thrown BEFORE any DB write.
 *  Maps to HTTP 422. */
export class SiteRadiusInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteRadiusInvalidError';
  }
}

/** brief D4, chk_sites_kind (migration 0015): `kind` must be one of the five values the DB CHECK
 *  allows. Thrown BEFORE any DB write — never relies on the DB CHECK's own `23514` error. Maps to
 *  HTTP 422. */
export class SiteKindInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteKindInvalidError';
  }
}

/** No platform.sites row is visible for this id — it does not exist, or RLS hides it from the
 *  caller (a site outside the caller's entities is indistinguishable from a missing one, by
 *  design — same convention as 3.3's EmployeeNotFoundError). Maps to 422 (the Problem envelope
 *  has no 404). */
export class SiteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteNotFoundError';
  }
}

/** Optimistic-lock conflict: `expectedVersion` no longer matches the locked platform.sites row's
 *  own `version` — another caller already advanced it (brief D8). Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The caller does not hold any of the roles a command requires (checked via
 *  `platform.my_roles()` inside the transaction — read, never guessed, brief D3). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to platform.audit_log.user_id / platform.outbox.actor_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** brief D6 (3.3 D9 precedent): "entity_id = ctx.entityId (never caller-supplied)" — resolved
 *  from `platform.allowed_entities()`. Thrown, never defaulted, when the caller's own entity
 *  scope is not exactly one entity. Thrown BEFORE any write. */
export class EntityScopeAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityScopeAmbiguousError';
  }
}
