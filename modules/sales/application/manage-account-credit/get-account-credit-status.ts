// modules/sales/application/manage-account-credit/get-account-credit-status.ts — WBS 1.8, M02 sales.
//
// Read-only application query — Master decision 5: read-only, no lock, no `entityId` parameter at
// all (Scope: "genuinely group-level, not entity-scoped" — the guard never once consults which
// entity is asking, proven by the S6 scenario calling this under four different entity contexts).
// Runs a single withContext(ctx, fn) (never withIdempotentContext — there is no Idempotency-Key on
// a pure read, same as 1.7's getContractForOrder). Throws AccountNotFoundError when no
// `sales.accounts` row is visible (missing, or RLS client_portal_scope hides it — never leaked as
// a distinct error). Throws AccountOnCreditHoldError{accountId, reason} when `credit_hold = true`;
// otherwise returns `{ accountId, creditLimit, creditHold: false }`.

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { assertAccountCreditOk } from '../../domain/manage-account-credit/invariants.js';
import { AccountNotFoundError } from '../../domain/manage-account-credit/errors.js';
import type { ManageAccountCreditDeps } from './ports.js';

export interface GetAccountCreditStatusInput {
  readonly accountId: string;
}

export interface GetAccountCreditStatusResult {
  readonly accountId: string;
  /** `sales.accounts.credit_limit` is nullable — a genuine NULL surfaces as `null`, never a
   *  fabricated `'0.000'` default (pg-reviewer fix round 1, finding 2). */
  readonly creditLimit: string | null;
  readonly creditHold: false;
}

export async function getAccountCreditStatus(
  ctx: WithContextCtx,
  input: GetAccountCreditStatusInput,
  deps: ManageAccountCreditDeps,
): Promise<GetAccountCreditStatusResult> {
  return withContext<GetAccountCreditStatusResult>(ctx, async (tx) => {
    const account = await deps.repo.getAccountById(tx, input.accountId);
    if (!account) {
      throw new AccountNotFoundError(
        `no sales.accounts row visible for id ${input.accountId} (Allowed: an existing, visible account).`,
      );
    }

    assertAccountCreditOk({ accountId: account.id, creditHold: account.creditHold, holdReason: account.holdReason });

    return { accountId: account.id, creditLimit: account.creditLimit, creditHold: false };
  });
}
