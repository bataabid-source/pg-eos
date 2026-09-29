// modules/billing/domain/post-journal/errors.ts — WBS 4.20 (lane 2).
//
// Typed errors for the post-journal use case. Every class sets `name` explicitly — an `Error`
// subclass does NOT get its constructor name for free at runtime (golden slice:
// modules/wms/domain/receive-inbound/errors.ts). The api/ layer (../../api/post-journal/handlers.ts)
// maps these to the Problem envelope: StaleVersionError -> 409, every other class here -> 422.

/** Optimistic-lock conflict: the caller's expectedVersion no longer matches the entry's version.
 *  Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** Every command's actor is `ctx.userId` only; a missing one is a typed error, never a silent
 *  `null` written to posted_by, the outbox or the audit row. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** No journal entry with that id is visible to the caller (RLS hides another entity's entries). */
export class JournalEntryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalEntryNotFoundError';
  }
}

/** sum(debit) <> sum(credit) — SCR-ACC-01 #6; the DB refuses the same at COMMIT (T1/T2). */
export class UnbalancedEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedEntryError';
  }
}

/** Fewer than two lines: a one-side-only entry cannot balance (01:1212). */
export class InsufficientLinesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientLinesError';
  }
}

/** A line's account is not an account of the entry's entity — SCR-ACC-01 #8. */
export class AccountNotInEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotInEntityError';
  }
}

/** A line's account has is_postable = false — SCR-ACC-01 #8. */
export class AccountNotPostableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotPostableError';
  }
}

/** A manual journal touches a revenue account — ADR-0004 D3 OD-15 ("except revenue accounts"). */
export class ManualRevenueJournalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualRevenueJournalRefusedError';
  }
}

/** A manual journal needs CFO approval (OD-15); the approved path is 4.20 part 2 (the contract
 *  carries no approval reference yet). */
export class ManualJournalApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualJournalApprovalRequiredError';
  }
}

/** The entry already carries reversed_by — one reversal per entry. */
export class AlreadyReversedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyReversedError';
  }
}

/** The target entity is not one of the caller's entities (platform.allowed_entities()). */
export class EntityNotInScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityNotInScopeError';
  }
}

/** The period is not an open period of the entity covering the entry date (4.19 carried). */
export class PeriodNotOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodNotOpenError';
  }
}

/** The journal state machine (./machine.ts) has no edge for the event from the entry's state. */
export class IllegalJournalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalJournalTransitionError';
  }
}

/** An amount is not a numeric(14,3) decimal string (the contract's AMOUNT shape). */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}
