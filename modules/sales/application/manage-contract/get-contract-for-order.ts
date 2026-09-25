// modules/sales/application/manage-contract/get-contract-for-order.ts — WBS 1.7, M02 sales.
//
// Read-only application query — Master decision 10: "makes NO write". Runs a single
// withContext(ctx, fn) (never withIdempotentContext — there is no Idempotency-Key on a pure read).
// Finds the account's contract for the given entity whose start_date <= asOfDate (tie-break:
// latest start_date, then id, for a deterministic result — pg-reviewer fix round 1, finding 2c/2d),
// then applies two independent checks: assertContractUsableForOrder (status-tag based —
// ContractNotActiveError{status}) and assertContractNotExpiredByDate (date based —
// ContractExpiredByDateError — pg-reviewer fix round 1, finding 2: an `active` contract whose own
// end_date has already passed asOfDate is functionally expired even though nobody has called
// ExpireContract yet). Throws ContractNotFoundError when no contract exists at all for
// (accountId, entityId, asOfDate) — pg-tester's own default (brief decision 10 names no explicit
// error for the "no contract"/"not yet started" case).

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { assertContractNotExpiredByDate, assertContractUsableForOrder } from '../../domain/manage-contract/invariants.js';
import { ContractNotFoundError } from '../../domain/manage-contract/errors.js';
import type { ManageContractDeps } from './ports.js';

export interface GetContractForOrderInput {
  readonly accountId: string;
  readonly entityId: string;
  readonly asOfDate: string;
}

export interface GetContractForOrderResult {
  readonly contractId: string;
  readonly status: string;
  readonly priceListId: string | null;
}

export async function getContractForOrder(
  ctx: WithContextCtx,
  input: GetContractForOrderInput,
  deps: ManageContractDeps,
): Promise<GetContractForOrderResult> {
  return withContext<GetContractForOrderResult>(ctx, async (tx) => {
    const found = await deps.repo.findContractForAccountEntity(tx, {
      accountId: input.accountId,
      entityId: input.entityId,
      asOfDate: input.asOfDate,
    });
    if (!found) {
      throw new ContractNotFoundError(
        `no sales.contracts row visible for account ${input.accountId} / entity ${input.entityId} ` +
          `with start_date <= ${input.asOfDate} (Allowed: an existing, already-started contract in ` +
          "the caller's entities).",
      );
    }

    assertContractUsableForOrder(found.status);
    assertContractNotExpiredByDate(found.contractId, found.endDate, input.asOfDate);

    return { contractId: found.contractId, status: found.status, priceListId: found.priceListId };
  });
}
