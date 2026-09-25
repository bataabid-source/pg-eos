// modules/sales/domain/manage-contract/errors.ts — WBS 1.7, M02 sales.
//
// Typed errors for the manage-contract use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at runtime.
// The api/ layer (../../api/manage-contract/handlers.ts) maps every one of these to the RFC 9457
// Problem envelope: StaleVersionError/IdempotencyConflictError -> 409, every other typed error
// below -> 422 (slice brief, Master decision 13).

// type-only import — no runtime circularity with ./machine.ts (which imports IllegalTransitionError
// from this file): erased entirely at compile time.
import type { ContractStatus } from './machine.js';

/** No `sales.accounts` row is visible for the given id — it does not exist (or is hidden by RLS,
 *  indistinguishable from missing, by design). Never leaked as AccountNotQualifiedError (Master
 *  decision 2). */
export class AccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}

/** The account exists but fails the qualification gate — `status = 'closed'` or `cr_number is
 *  null` (Master decision 2, reusing the INV-C2-1-style check manage-quote already applies). */
export class AccountNotQualifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotQualifiedError';
  }
}

/** No `sales.contracts` row is visible for this id — it does not exist, or RLS (entity_scope)
 *  hides it from the caller. Maps to 422 (the Problem envelope has no 404). */
export class ContractNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractNotFoundError';
  }
}

/** INV-C2-2: ActivateContract was called with no `price_list_id` set on the contract (Master
 *  decision 5). */
export class ContractNotPriceableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractNotPriceableError';
  }
}

/** SetContractPriceList cited a `catalog.price_lists` row whose `entity_id` does not match the
 *  contract's own, or whose `client_id` is neither the contract's account nor null (Master
 *  decision 4). */
export class PriceListNotApplicableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceListNotApplicableError';
  }
}

/** Master decision 10: `assertContractUsableForOrder` rejected the contract because its status is
 *  not tagged `usableForOrder` (only `active` is). Carries the contract's own `status` so the
 *  caller (a future order-placing slice) can report it. */
export class ContractNotActiveError extends Error {
  readonly status: ContractStatus;

  constructor(message: string, status: ContractStatus) {
    super(message);
    this.name = 'ContractNotActiveError';
    this.status = status;
  }
}

/** pg-reviewer fix round 1, finding 2: distinct from ContractNotActiveError (which is about the
 *  status enum, independent of any date) — thrown by `assertContractNotExpiredByDate` when an
 *  `active` (or otherwise usable-for-order-tagged) contract's own `end_date` has already passed
 *  the caller's `asOfDate`, even though nobody has called ExpireContract yet. Carries `contractId`
 *  and the contract's own `endDate` so the caller can report both. */
export class ContractExpiredByDateError extends Error {
  readonly contractId: string;
  readonly endDate: string;

  constructor(message: string, contractId: string, endDate: string) {
    super(message);
    this.name = 'ContractExpiredByDateError';
    this.contractId = contractId;
    this.endDate = endDate;
  }
}

/** Master decision 8: ExpireContract was called but `end_date` is null, or `end_date >=
 *  asOfDate`. */
export class ContractNotYetExpirableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractNotYetExpirableError';
  }
}

/** Master decision 9: AddContractSla was called but the contract's own `sla_enabled` is false. */
export class SlaNotEnabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlaNotEnabledError';
  }
}

/** Optimistic-lock conflict: the caller's `expectedVersion` no longer matches the locked
 *  `sales.contracts` row's own `version`. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The contract state machine (./machine.ts) rejected the requested event from the contract's
 *  current status — a structurally illegal transition (Master decision 1). */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** Every command's actor is `ctx.userId` ONLY (Master decision 11). A null/missing userId is a
 *  typed error, not a silent `null` written to any actor column. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** Master decision 2: `startDate` must be `>= today` (the injected Clock's own "today", never
 *  `new Date()`). */
export class InvalidStartDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStartDateError';
  }
}

/** Master decision 2: `endDate`, when set, must be `>= startDate`. */
export class InvalidEndDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEndDateError';
  }
}

/** The caller does not hold the role a command requires (checked via `platform.my_roles()` inside
 *  the transaction — read, never guessed). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}
