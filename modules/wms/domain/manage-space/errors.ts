// modules/wms/domain/manage-space/errors.ts — WBS 2.15 (lane 2).
//
// Typed errors for the manage-space use case (AllocateSpace/ReserveSpace, INV-C3-8). Every class
// sets `name` explicitly (CLAUDE.md · AGENT CONSTRAINTS; same discipline as
// ../receive-inbound/errors.ts) — an `Error` subclass does NOT get its constructor name for free
// at runtime. The api/ layer (../../api/manage-space/handlers.ts) maps these to the Problem
// envelope.

/** D7: `qty > 0` is thrown BEFORE any DB write — for AllocateSpace this is belt-and-braces
 *  alongside `wms.space_allocations`'s own `positive_qty` CHECK; for ReserveSpace it is the ONLY
 *  enforcement (`wms.space_reservations.qty` has no equivalent DB-level CHECK). Round-4 review
 *  finding: also thrown for a qty with more than QTY_DB_SCALE (3) decimals (invariants.ts's
 *  hasValidQtyScale) — the stored `numeric(14,3)` value would not be the positive qty requested
 *  (`0.0004` stores as zero) — and by the repository adapter as a backstop when
 *  `space_allocations`'s own `positive_qty` CHECK raises SQLSTATE 23514. Maps to HTTP 422. */
export class NonPositiveQtyError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'NonPositiveQtyError';
  }
}

/** D4: ReserveSpace's own duration pre-check — `(expiresAt - reservedFrom) > maxDays`, `maxDays`
 *  read from `platform.thresholds` key `space.reservation_max_days` (never hardcoded). Thrown
 *  BEFORE any DB write; `wms.trg_space_reservation_guard()` also enforces this threshold as a
 *  normal-path backstop (belt-and-braces, doc 36 §5-4 #2) — but CORRECTED (round-1 review finding
 *  1, brief Facts): the trigger does NOT prevent a race, it takes no row lock, so it is not a
 *  genuine concurrency guard; the application layer's own `SELECT ... FOR UPDATE` on the block row
 *  is what closes the race. Reserved SOLELY for the 30-day max-duration threshold — round-1 review
 *  finding 3: the plain `expiresAt <= reservedFrom` date-range check is a DIFFERENT, distinct
 *  failure and throws `ReservationDateRangeInvalidError` instead, never this class. */
export class ReservationTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReservationTooLongError';
  }
}

/** D4/round-1 review finding 3: the plain date-range check — `expiresAt` must be strictly after
 *  `reservedFrom` (mirrors the DB's own `reservation_has_expiry` CHECK). Distinct from
 *  `ReservationTooLongError` (reserved for the 30-day max-duration threshold specifically) — an
 *  inverted/equal range is a different failure than an over-long one, and gets its own typed
 *  error. Maps to HTTP 422. */
export class ReservationDateRangeInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReservationDateRangeInvalidError';
  }
}

/** INV-C3-8: `wms.check_space_available()` raised (SQLSTATE P0001) — the block's own sellable
 *  capacity (capacity − out-of-service − contracted − reserved) is less than the requested qty.
 *  The message carries the function's own text VERBATIM (it already states the exact sellable
 *  qty and the requested qty — never recomputed or reformatted here). Maps to HTTP 422. */
export class SpaceNotAvailableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'SpaceNotAvailableError';
  }
}

/** The caller does not hold the role a command requires (checked via `platform.my_roles()` inside
 *  the transaction — read, never guessed). D5: SALES_MGR only, both commands. */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** CORRECTED (round-1 review): entity is resolved from the REQUEST's own `blockId` —
 *  `select entity_id from wms.space_blocks where id = $1 for update` under that table's own
 *  `entity_scope` RLS — never `ctx.entityId`, never a caller-supplied field, and never the
 *  caller's own raw entity count (`SALES_MGR` is `all-scope`, so belonging to more than one
 *  `platform.entities` row is the NORMAL case for this role, not an ambiguity to reject). This
 *  error is REUSED for "no such block visible to the caller" (a block outside the caller's
 *  visible entities is simply invisible, same "indistinguishable from missing" convention every
 *  prior slice used for a NotFoundError) — same error type, a different resolution path. */
export class EntityScopeAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityScopeAmbiguousError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to `created_by`/`reserved_by`/audit `user_id`. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}
