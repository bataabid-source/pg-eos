// modules/sales/application/manage-account-credit/set-credit-hold.ts — WBS 1.8, M02 sales.
//
// ONE withIdempotentContext transaction. Lock order: (1) account-row lock + expectedVersion check,
// (2) role gate (CFO or GM — Master decision 3, a human stand-in for the deferred automatic
// trigger), (3) the unconditional version bump + hold columns. Idempotent in EFFECT but not in
// STATUS-CHECK: re-placing an already-active hold is legal (updates reason/who/when) — no
// AlreadyOnHoldError invented (Master decision 3).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertReasonPresent } from '../../domain/manage-account-credit/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-account-credit/errors.js';
import type { ManageAccountCreditDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const ROLE_GM = 'GM';

export interface SetCreditHoldInput {
  readonly accountId: string;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface SetCreditHoldResult {
  readonly version: number;
}

export async function setCreditHold(
  ctx: WithContextCtx,
  input: SetCreditHoldInput,
  deps: ManageAccountCreditDeps,
): Promise<SetCreditHoldResult> {
  if (!ctx.userId) throw new MissingActorError('SetCreditHold requires ctx.userId.');
  const actorId = ctx.userId;
  assertReasonPresent(input.reason);

  return withIdempotentContext<SetCreditHoldResult>(ctx, input.idem, async (tx) => {
    const account = await deps.repo.getAccountForUpdate(tx, input.accountId);
    if (account.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `SetCreditHold: expectedVersion ${input.expectedVersion} no longer matches account ` +
          `${input.accountId}'s version ${account.version} (optimistic lock).`,
      );
    }

    if (!((await deps.repo.hasRole(tx, ROLE_CFO)) || (await deps.repo.hasRole(tx, ROLE_GM)))) {
      throw new RoleRequiredError(`SetCreditHold requires role ${ROLE_CFO} or ${ROLE_GM} (platform.my_roles()).`);
    }

    const newVersion = await deps.repo.updateCreditHold(tx, input.accountId, {
      creditHold: true,
      holdReason: input.reason,
      holdSetBy: actorId,
      holdSetAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
