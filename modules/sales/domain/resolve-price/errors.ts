// modules/sales/domain/resolve-price/errors.ts — WBS 1.4, M02 sales pricing engine.
//
// Typed errors for the resolve-price use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS; same discipline as the golden slice's own errors.ts) — an `Error` subclass
// does NOT get its constructor name for free at runtime.
//
// Master decision 5 (slice brief): "no match" for a legitimate business case is NEVER a thrown
// error — it is the `pending` status. A typed error IS thrown only for a genuine data-integrity
// problem: an unknown serviceId/accountId, or a malformed tier ladder (should not exist, since
// catalog module 1.2 validates every ladder on write).

/** No `catalog.services` row is visible for the given `serviceId` — it does not exist, or RLS
 *  hides it from the caller (indistinguishable from missing, by design). */
export class ServiceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceNotFoundError';
  }
}

/** No `sales.accounts` row is visible for the given `accountId`. */
export class AccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}

/** ../tiered-pricing.ts's computeTieredPrice assumes its input ladder already passed catalog
 *  module 1.2's validateTierLadder (contiguous, no gap, no overlap) — it does NOT re-validate
 *  contiguity. A malformed ladder found here surfaces this typed error, never a silent
 *  miscalculation (Master decision 4). */
export class MalformedTierLadderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedTierLadderError';
  }
}
