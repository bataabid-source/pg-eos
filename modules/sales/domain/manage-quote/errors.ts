// modules/sales/domain/manage-quote/errors.ts — WBS 1.6, M02 sales.
//
// Typed errors for the manage-quote use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at runtime.
// The api/ layer (../../api/manage-quote/handlers.ts) maps every one of these to the RFC 9457
// Problem envelope: StaleVersionError/IdempotencyConflictError -> 409, every other typed error
// below -> 422 (slice brief, Master decision 15).

/** No `sales.accounts` row is visible for the given id — it does not exist (or is hidden by RLS,
 *  indistinguishable from missing, by design). Never leaked as AccountNotQualifiedError (Master
 *  decision 2). */
export class AccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}

/** INV-C2-1: the account exists but fails the qualification gate — `status = 'closed'` or
 *  `cr_number is null` (Master decision 2). */
export class AccountNotQualifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotQualifiedError';
  }
}

/** No `sales.quotes` row is visible for this id — it does not exist, or RLS (entity_scope) hides
 *  it from the caller. Maps to 422 (the Problem envelope has no 404). */
export class QuoteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteNotFoundError';
  }
}

/** Master decisions 3/17: a mutating command was attempted on a quote whose status is not
 *  editable (lines) or is frozen (sent/accepted/rejected/expired for every mutating command) —
 *  steers the caller to ReviseQuote. */
export class QuoteFrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteFrozenError';
  }
}

/** Optimistic-lock conflict: the caller's `expectedVersion` no longer matches the locked
 *  `sales.quotes` row's own `version`. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** Master decision 6: SubmitForReview was called on a quote with zero `sales.quote_lines` rows. */
export class EmptyQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyQuoteError';
  }
}

/** The caller does not hold the role a command requires (checked via `platform.my_roles()` inside
 *  the transaction — read, never guessed). Names the role actually needed (Master decision 8's
 *  CFO/GM escalation). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** Master decision 3: a line's `unitPrice` is below the service's `min_price_at_quote` and either
 *  no `exceptionId` was cited, or the cited `catalog.price_exceptions` row does not match
 *  `(client_id=account_id, service_id)`, or is not valid today. */
export class InvalidPriceExceptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPriceExceptionError';
  }
}

/** Master decision 4: `discountAmt` is negative, or greater than the quote's own `subtotal`. */
export class InvalidDiscountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDiscountError';
  }
}

/** No active `catalog.services` row for the given id (Master decision 3). */
export class ServiceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceNotFoundError';
  }
}

/** The quote state machine (./machine.ts) rejected the requested event from the quote's current
 *  status — a structurally illegal transition that is NOT already covered by QuoteFrozenError
 *  (Master decision 1). */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** Every command's actor is `ctx.userId` ONLY (Master decision 13). A null/missing userId is a
 *  typed error, not a silent `null` written to `prepared_by`/`approved_by`/audit `user_id`. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** Master decision 2: `validUntil` must be `>= today` (the injected Clock's own "today", never
 *  `new Date()`) — CreateQuote's own input, and ReviseQuote's copied-then-re-checked value
 *  (pg-reviewer fix round 1, finding 5/6). */
export class InvalidValidUntilError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidValidUntilError';
  }
}

/** pg-reviewer fix round 1, finding 10: `sales.quotes.estimated_margin_pct` is `numeric(6,3)` (max
 *  magnitude ~999.999) — a computed margin whose magnitude would overflow that column is a typed
 *  422, never a raw Postgres numeric-overflow 500. */
export class MarginOutOfRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarginOutOfRangeError';
  }
}
