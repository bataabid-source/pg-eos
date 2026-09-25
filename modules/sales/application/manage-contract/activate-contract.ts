// modules/sales/application/manage-contract/activate-contract.ts — WBS 1.7, M02 sales.
//
// ONE withIdempotentContext transaction. Lock order: (1) contract-row lock + expectedVersion
// check, (2) role gate (CFO), (3) advanceContract (signed -> active; IllegalTransitionError for
// any other status), (4) INV-C2-2 — price_list_id is not null, else ContractNotPriceableError,
// (5) the unconditional version bump, (6) the audit row.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { ContractNotPriceableError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-contract/errors.js';
import { CONTRACT_EVENTS, CONTRACT_STATUS, advanceContract } from '../../domain/manage-contract/machine.js';
import type { ManageContractDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_ACTIVATE = 'activate';

export interface ActivateContractInput {
  readonly contractId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ActivateContractResult {
  readonly version: number;
}

export async function activateContract(
  ctx: WithContextCtx,
  input: ActivateContractInput,
  deps: ManageContractDeps,
): Promise<ActivateContractResult> {
  if (!ctx.userId) throw new MissingActorError('ActivateContract requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ActivateContractResult>(ctx, input.idem, async (tx) => {
    const contract = await deps.repo.getContractForUpdate(tx, input.contractId);
    if (contract.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ActivateContract: expectedVersion ${input.expectedVersion} no longer matches contract ` +
          `${input.contractId}'s version ${contract.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`ActivateContract requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    advanceContract(contract.status, [CONTRACT_EVENTS.ACTIVATE_CONTRACT]);

    if (contract.priceListId === null) {
      throw new ContractNotPriceableError(
        `INV-C2-2: contract ${input.contractId} has no price_list_id — ActivateContract requires ` +
          'one to already be set (Master decision 5).',
      );
    }

    const newVersion = await deps.repo.updateContract(tx, input.contractId, { status: CONTRACT_STATUS.ACTIVE });

    await deps.repo.writeAuditRow(tx, {
      entityId: contract.entityId,
      target: 'contract',
      recordId: input.contractId,
      operation: AUDIT_OPERATION_ACTIVATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: CONTRACT_STATUS.ACTIVE, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
