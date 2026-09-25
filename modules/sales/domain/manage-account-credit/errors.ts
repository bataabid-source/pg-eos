// modules/sales/domain/manage-account-credit/errors.ts — WBS 1.8, M02 sales.
//
// Typed errors for the manage-account-credit use case. Every class sets `name` explicitly
// (CLAUDE.md · AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free
// at runtime. The api/ layer (../../api/manage-account-credit/handlers.ts) maps every one of these
// to the RFC 9457 Problem envelope: StaleVersionError/IdempotencyConflictError -> 409, every other
// typed error below -> 422 (slice brief, Master decision 8).

/** No `sales.accounts` row is visible for the given id — it does not exist, or RLS
 *  (client_portal_scope) hides it from the caller. Never leaked as a 403/404 — indistinguishable
 *  from missing, by design (Master decision 5). */
export class AccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}

/** getAccountCreditStatus's own guard (Master decision 5): the account IS visible but
 *  `credit_hold = true`. Carries the account id and its own `hold_reason` so a future
 *  order-placing slice can report both — the guard never once consults which entity is asking
 *  (Scope: genuinely group-level). */
export class AccountOnCreditHoldError extends Error {
  readonly accountId: string;
  readonly reason: string;

  constructor(message: string, accountId: string, reason: string) {
    super(message);
    this.name = 'AccountOnCreditHoldError';
    this.accountId = accountId;
    this.reason = reason;
  }
}

/** ReleaseCreditHold was called on an account that is NOT currently on hold — a genuine no-op the
 *  caller should notice (Master decision 4), unlike re-setting an already-active hold (legal). */
export class NotOnHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotOnHoldError';
  }
}

/** The caller does not hold the role a command requires (CFO for SetCreditLimit; CFO or GM for
 *  SetCreditHold/ReleaseCreditHold — Master decisions 2-4), checked via `platform.my_roles()`
 *  inside the transaction — read, never guessed. */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** Optimistic-lock conflict: the caller's `expectedVersion` no longer matches the locked
 *  `sales.accounts` row's own `version`. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** Every command's actor is `ctx.userId` ONLY (Master decision 6). A null/missing userId is a
 *  typed error, not a silent `null` written to `hold_set_by`. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** pg-reviewer fix round 1, finding 3: a caller that bypasses the contract boundary (calling
 *  setCreditHold/releaseCreditHold directly) and passes an empty or all-whitespace `reason` is
 *  still rejected — defence in depth, same reasoning as InvalidCreditLimitError below. */
export class InvalidReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReasonError';
  }
}

/** assertCreditLimitValid rejected a negative numeric(14,3) string — zero and any positive value
 *  are legal (Master decision 5, S7 trial-client case). This is domain-layer defence-in-depth: the
 *  contract boundary (packages/contracts/sales/manage-account-credit.ts) already rejects a
 *  negative creditLimit at 400, but the application layer never trusts the contract alone for a
 *  business invariant. */
export class InvalidCreditLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCreditLimitError';
  }
}
