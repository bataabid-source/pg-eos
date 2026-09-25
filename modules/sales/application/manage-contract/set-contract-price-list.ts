// modules/sales/application/manage-contract/set-contract-price-list.ts — WBS 1.7, M02 sales.
//
// ONE withIdempotentContext transaction. Lock order: (1) contract-row lock + expectedVersion
// check, (2) assertPriceListAssignable (legal from any non-terminal status — Master decision 4),
// (3) role gate (CFO), (4) resolve the cited catalog.price_lists row AND the contract's own
// account's segment_id, then assertPriceListApplicable — entity_id must match, the list must not
// be internal (transfer-pricing), status must be 'active', and its own client_id/segment_id must
// be null or equal to the contract's account/segment (pg-reviewer fix round 1, finding 3) — else
// PriceListNotApplicableError, (5) the unconditional version bump, (6) the audit row. No machine
// event is sent — this command never changes the contract's own status.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertPriceListApplicable, assertPriceListAssignable } from '../../domain/manage-contract/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-contract/errors.js';
import type { ManageContractDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_SET_PRICE_LIST = 'set_price_list';

export interface SetContractPriceListInput {
  readonly contractId: string;
  readonly priceListId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface SetContractPriceListResult {
  readonly version: number;
}

export async function setContractPriceList(
  ctx: WithContextCtx,
  input: SetContractPriceListInput,
  deps: ManageContractDeps,
): Promise<SetContractPriceListResult> {
  if (!ctx.userId) throw new MissingActorError('SetContractPriceList requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<SetContractPriceListResult>(ctx, input.idem, async (tx) => {
    const contract = await deps.repo.getContractForUpdate(tx, input.contractId);
    if (contract.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `SetContractPriceList: expectedVersion ${input.expectedVersion} no longer matches contract ` +
          `${input.contractId}'s version ${contract.version} (optimistic lock).`,
      );
    }

    assertPriceListAssignable(contract.status);

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`SetContractPriceList requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    const [priceList, accountSegmentId] = await Promise.all([
      deps.repo.getPriceListById(tx, input.priceListId),
      deps.repo.getAccountSegmentId(tx, contract.accountId),
    ]);
    assertPriceListApplicable(priceList, {
      entityId: contract.entityId,
      accountId: contract.accountId,
      accountSegmentId,
    });

    const newVersion = await deps.repo.updateContract(tx, input.contractId, { priceListId: input.priceListId });

    await deps.repo.writeAuditRow(tx, {
      entityId: contract.entityId,
      target: 'contract',
      recordId: input.contractId,
      operation: AUDIT_OPERATION_SET_PRICE_LIST,
      correlationId: input.correlationId,
      actorId,
      newValue: { priceListId: input.priceListId, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
