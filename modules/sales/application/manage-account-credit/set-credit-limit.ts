// modules/sales/application/manage-account-credit/set-credit-limit.ts — WBS 1.8, M02 sales.
//
// ONE withIdempotentContext transaction. Lock order: (1) account-row lock + expectedVersion check,
// (2) role gate (CFO — Master decision 2), (3) assertCreditLimitValid (zero legal, negative
// rejected), (4) the unconditional version bump. No audit event this slice (Master decision 9: no
// outbox event; no audit target is named in the brief for sales.accounts).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertCreditLimitValid } from '../../domain/manage-account-credit/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-account-credit/errors.js';
import type { ManageAccountCreditDeps } from './ports.js';

const ROLE_CFO = 'CFO';

export interface SetCreditLimitInput {
  readonly accountId: string;
  readonly creditLimit: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface SetCreditLimitResult {
  readonly version: number;
}

export async function setCreditLimit(
  ctx: WithContextCtx,
  input: SetCreditLimitInput,
  deps: ManageAccountCreditDeps,
): Promise<SetCreditLimitResult> {
  if (!ctx.userId) throw new MissingActorError('SetCreditLimit requires ctx.userId.');

  return withIdempotentContext<SetCreditLimitResult>(ctx, input.idem, async (tx) => {
    const account = await deps.repo.getAccountForUpdate(tx, input.accountId);
    if (account.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `SetCreditLimit: expectedVersion ${input.expectedVersion} no longer matches account ` +
          `${input.accountId}'s version ${account.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`SetCreditLimit requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    assertCreditLimitValid(input.creditLimit);

    const newVersion = await deps.repo.updateCreditLimit(tx, input.accountId, { creditLimit: input.creditLimit });

    return { version: newVersion };
  });
}
