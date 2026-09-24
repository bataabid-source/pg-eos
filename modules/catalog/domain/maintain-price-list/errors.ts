// modules/catalog/domain/maintain-price-list/errors.ts — WBS 1.2, M03 catalog.
//
// Typed errors for the maintain-price-list use case. Every class sets `name` explicitly (CLAUDE.md
// · AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at
// runtime. The api/ layer (../../api/maintain-price-list/handlers.ts) maps every one of these to
// the RFC 9457 Problem envelope: StaleVersionError/IdempotencyConflictError -> 409, every other
// typed error below -> 422 (slice brief, Master decision 12).

/** Optimistic-lock conflict: the caller's `expectedVersion` no longer matches the locked
 *  `catalog.price_lists` row's own `version`. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The price-list state machine (./machine.ts) rejected the requested event from the list's
 *  current status. Maps to HTTP 422. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** The caller does not hold the role a command requires (checked via `platform.my_roles()`
 *  inside the transaction — read, never guessed). CFO for every list-mutating command, GM for
 *  GrantPriceException (slice brief, Master decisions 6-9). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** Master decision 3: a `catalog.price_list_lines` write was attempted while the owning list is
 *  not 'draft' — an active list is frozen; a price change is a new list. */
export class PriceListLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceListLockedError';
  }
}

/** Master decision 4 (the acceptance criterion): a line's price is below the service's
 *  `min_price`. `rowIndex` is set only when thrown from ImportPriceListLines (zero-based, the
 *  offending row's own index in the `rows` array); absent for a single UpsertPriceListLine. */
export class PriceBelowFloorError extends Error {
  readonly serviceCode: string;
  readonly price: string;
  readonly minPrice: string;
  readonly rowIndex?: number;

  constructor(
    message: string,
    params: { readonly serviceCode: string; readonly price: string; readonly minPrice: string; readonly rowIndex?: number },
  ) {
    super(message);
    this.name = 'PriceBelowFloorError';
    this.serviceCode = params.serviceCode;
    this.price = params.price;
    this.minPrice = params.minPrice;
    if (params.rowIndex !== undefined) this.rowIndex = params.rowIndex;
  }
}

/** No `catalog.services` row is visible for the given code/id, or it is not `is_active` — an
 *  inactive service is indistinguishable from a missing one for pricing purposes (Master
 *  decision 4). */
export class ServiceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceNotFoundError';
  }
}

/** INV-C1-1: the service has no `min_price` set — the floor rule cannot be evaluated, so the
 *  service may not be priced at all (Master decision 4/9). */
export class ServiceNotPriceableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceNotPriceableError';
  }
}

/** Master decision 4 (default): every line of one `catalog.price_lists` row shares one currency —
 *  the first line written decides it; a later line in a different currency is refused. */
export class CurrencyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrencyMismatchError';
  }
}

/** Master decision 6: `catalog.price_lists` unique (entity_id, code) — SQLSTATE 23505 on that
 *  constraint, matched via the error's own `cause` chain. */
export class PriceListCodeTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceListCodeTakenError';
  }
}

/** Master decision 6: CreatePriceList named both `segmentId` and `clientId` — at most one may be
 *  set (neither means the entity's standard list). */
export class SegmentAndClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentAndClientError';
  }
}

/** Master decisions 6/9: `validTo` earlier than `validFrom`, or `reviewAt` earlier than
 *  `validFrom`. */
export class InvalidValidityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidValidityError';
  }
}

/** Master decision 7: ActivatePriceList was called on a list with zero
 *  `catalog.price_list_lines` rows. */
export class EmptyPriceListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyPriceListError';
  }
}

/** INV-C1-3 (Master decision 5): a service's tiers within the list are not a valid progressive
 *  ladder (gap, overlap, non-zero start, a flat line mixed with tiers, or negative free_units). */
export class TierLadderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TierLadderError';
  }
}

/** Every command's actor is `ctx.userId` ONLY (Master decision 10). A null/missing userId is a
 *  typed error, not a silent `null` written to `approved_by`/audit `user_id`. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** No `catalog.price_lists` row is visible for this id — it does not exist, or RLS (entity_scope)
 *  hides it from the caller (a list outside the caller's entities is indistinguishable from a
 *  missing one, by design). Maps to 422 (the Problem envelope has no 404). */
export class PriceListNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceListNotFoundError';
  }
}
