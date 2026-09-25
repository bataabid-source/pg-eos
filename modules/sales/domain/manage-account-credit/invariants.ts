// modules/sales/domain/manage-account-credit/invariants.ts — WBS 1.8, M02 sales.
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/manage-account-credit/*) calls these BEFORE any DB write; a failed invariant
// throws a typed error from ./errors.ts.
//
// pg-reviewer fix round 1, finding 1 (overturns the original Master decision 1 reasoning):
// `credit_hold` IS a two-state transition table (`clear`/`held`) — `assertOnHold` below asks
// ./machine.ts's `assertReleaseLegal` instead of a hand-written `if`. `assertAccountCreditOk`
// stays a plain boolean predicate (a fact check, not a transition) — pg-reviewer confirmed this
// one is fine as-is.

import { Money } from '@pg-eos/domain-kit';

import { AccountOnCreditHoldError, InvalidCreditLimitError, InvalidReasonError } from './errors.js';
import { assertReleaseLegal, creditStateFromRow } from './machine.js';

/** Master decision 2, 5: `creditLimit` (a numeric(14,3) string) must not be negative — zero and
 *  any positive value are legal (S7's trial-client case, `credit_limit = 0`). Parsed via `Money`
 *  (domain-kit), never `Number()`/`parseFloat()`. */
export function assertCreditLimitValid(creditLimit: string): void {
  if (Money.of(creditLimit).isNegative()) {
    throw new InvalidCreditLimitError(
      `SetCreditLimit: creditLimit (${creditLimit}) must be non-negative — zero is legal (Master decision 5).`,
    );
  }
}

/** The minimal shape `assertAccountCreditOk`/`assertOnHold` need — deliberately NOT the
 *  application layer's own `AccountRow` (ports.ts), since domain/ never imports from
 *  application/. */
export interface AccountCreditGuardInput {
  readonly accountId: string;
  readonly creditHold: boolean;
  readonly holdReason: string | null;
}

/** Master decision 5: getAccountCreditStatus's own guard — throws AccountOnCreditHoldError{
 *  accountId, reason} iff `account.creditHold === true`; returns (no throw) iff false. A plain
 *  boolean predicate (Master decision 1) — NOT the if/switch-on-state the "no if/switch for state
 *  transitions" rule forbids (there is no enum of states to switch over, only a boolean fact to
 *  check). */
export function assertAccountCreditOk(account: AccountCreditGuardInput): void {
  if (account.creditHold) {
    throw new AccountOnCreditHoldError(
      `sales.accounts ${account.accountId} is on credit hold: ${account.holdReason ?? '(no reason recorded)'}`,
      account.accountId,
      account.holdReason ?? '',
    );
  }
}

/** Master decision 4: ReleaseCreditHold's own no-op guard — throws NotOnHoldError iff RELEASE is
 *  not a legal transition from the account's current credit state (i.e. it is `clear`); returns
 *  (no throw) iff legal (i.e. `held`). Delegates to ./machine.ts's `assertReleaseLegal` — the
 *  machine decides transition legality, never a hand-written `if` on the boolean (pg-reviewer fix
 *  round 1, finding 1). */
export function assertOnHold(account: { readonly creditHold: boolean }): void {
  assertReleaseLegal(creditStateFromRow(account));
}

/** pg-reviewer fix round 1, finding 3: `reason` (SetCreditHold/ReleaseCreditHold) must be
 *  non-empty after trimming — defence in depth for a caller that bypasses the contract boundary
 *  (packages/contracts/sales/manage-account-credit.ts's own `.trim().min(1)`) and calls the
 *  application function directly. */
export function assertReasonPresent(reason: string): void {
  if (reason.trim().length === 0) {
    throw new InvalidReasonError('reason must be a non-empty, non-whitespace-only string.');
  }
}
