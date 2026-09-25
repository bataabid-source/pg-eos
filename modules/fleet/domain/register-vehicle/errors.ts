// modules/fleet/domain/register-vehicle/errors.ts — WBS 3.1.
//
// Typed errors for the register-vehicle use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at runtime.
// `fleet` has no earlier slice of its own; `resolveCallerEntityId`/`EntityScopeAmbiguousError`
// replicate the cross-module pattern modules/hr/register-employee already established (brief Read
// ONLY: modules/hr/infrastructure/register-employee/repository.ts) to work around `WithContextCtx`
// having no `entityId` field — a known, frozen-path gap (PROJECT_STATE.md's batched-Master-tasks
// note), not this module's own invention. The api/ layer (../../api/register-vehicle/handlers.ts)
// maps these to the RFC 9457 Problem envelope: DuplicatePlateNoError -> 409,
// VehicleDocumentAccessDeniedError -> 422, everything else -> 422/400 per that layer's own map.
// pg-reviewer round 1, Finding 3: an RLS policy violation on tms.vehicle_documents (SQLSTATE 42501)
// is translated to VehicleDocumentAccessDeniedError below so it surfaces as a meaningful 422
// instead of a generic 500 — this TRANSLATES the database's own rejection, it does NOT reimplement
// the "is internal" check as an application-level rule (the RLS policy itself remains the sole
// enforcement — brief: "the database is the enforcement layer").

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to platform.audit_log.user_id / platform.outbox.actor_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** brief: "entityId ... come[s] from ctx, never the caller" — resolved from
 *  `platform.allowed_entities()`. Thrown, never defaulted, when the caller's own entity scope is
 *  not exactly one entity (zero, or more than one) — RegisterVehicle refuses to guess which entity
 *  a write belongs to. Thrown BEFORE any write, same discipline as modules/hr/register-employee's
 *  own `resolveCallerEntityId`/`EntityScopeAmbiguousError` pattern, replicated here (see file
 *  header — this is a cross-module pattern, not `fleet`'s own precedent). */
export class EntityScopeAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityScopeAmbiguousError';
  }
}

/** mapped from a unique violation on `tms.vehicles.plate_no` (01-Data-Model.sql:846 `plate_no text
 *  not null unique`) — doc 07/40 give no other business rule for the collision, the DB constraint
 *  is the source of truth (brief, Scenario "A duplicate plate number is rejected"). Maps to
 *  HTTP 409. */
export class DuplicatePlateNoError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'DuplicatePlateNoError';
  }
}

/** Two legitimate uses, both mapped to HTTP 422:
 *  (a) WRITE path (pg-reviewer round 1, Finding 3, this module): mapped from a genuine row-level
 *  security violation (SQLSTATE 42501) on `tms.vehicle_documents` — that table's own `internal_only`
 *  RLS policy (`using (platform.is_internal())`, brief Scenario "A non-internal actor cannot write
 *  vehicle_documents") rejecting the insert. This TRANSLATES the database's own loud rejection into
 *  a typed, plain-language error; it adds no new application-level "is internal" check on the write
 *  path — the RLS policy remains the sole enforcement layer there.
 *  (b) READ path (WBS 3.1 part 2, assert-vehicle-assignable, reused as-is, no second class): a
 *  non-internal caller's SELECT against `tms.vehicle_documents` is not rejected by RLS at all — the
 *  same `internal_only` policy silently returns zero rows instead of erroring. Left unchecked, that
 *  would let the expired-document gate pass vacuously for every vehicle. So the application layer
 *  proactively checks `ctx.isInternal` BEFORE attempting the read and throws this same class to
 *  refuse it — a genuine application-level check on this path, since RLS itself cannot signal a
 *  hidden SELECT the way it signals a rejected INSERT. */
export class VehicleDocumentAccessDeniedError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'VehicleDocumentAccessDeniedError';
  }
}
