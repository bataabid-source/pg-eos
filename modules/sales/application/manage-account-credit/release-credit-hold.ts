// modules/sales/application/manage-account-credit/release-credit-hold.ts — WBS 1.8, M02 sales.
//
// ONE withIdempotentContext transaction. Lock order: (1) account-row lock + expectedVersion check,
// (2) role gate (GM or CFO ONLY — Master decision 4, D-blueprint 02 §4.5 step 7: "releasing stays
// human"), (3) assertOnHold (NotOnHoldError iff the account is NOT currently on hold — a genuine
// no-op, distinct from SetCreditHold's own re-place-is-legal rule), (4) the unconditional version
// bump — `hold_reason` is OVERWRITTEN with the release's own reason (Master decision 4: "the last
// word on WHY the account is in its current state").

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertOnHold, assertReasonPresent } from '../../domain/manage-account-credit/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-account-credit/errors.js';
import type { ManageAccountCreditDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const ROLE_GM = 'GM';

export interface ReleaseCreditHoldInput {
  readonly accountId: string;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ReleaseCreditHoldResult {
  readonly version: number;
}

export async function releaseCreditHold(
  ctx: WithContextCtx,
  input: ReleaseCreditHoldInput,
  deps: ManageAccountCreditDeps,
): Promise<ReleaseCreditHoldResult> {
  if (!ctx.userId) throw new MissingActorError('ReleaseCreditHold requires ctx.userId.');
  const actorId = ctx.userId;
  assertReasonPresent(input.reason);

  return withIdempotentContext<ReleaseCreditHoldResult>(ctx, input.idem, async (tx) => {
    const account = await deps.repo.getAccountForUpdate(tx, input.accountId);
    if (account.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ReleaseCreditHold: expectedVersion ${input.expectedVersion} no longer matches account ` +
          `${input.accountId}'s version ${account.version} (optimistic lock).`,
      );
    }

    if (!((await deps.repo.hasRole(tx, ROLE_GM)) || (await deps.repo.hasRole(tx, ROLE_CFO)))) {
      throw new RoleRequiredError(`ReleaseCreditHold requires role ${ROLE_GM} or ${ROLE_CFO} (platform.my_roles()).`);
    }

    assertOnHold(account);

    const newVersion = await deps.repo.updateCreditHold(tx, input.accountId, {
      creditHold: false,
      holdReason: input.reason,
      holdSetBy: actorId,
      holdSetAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
