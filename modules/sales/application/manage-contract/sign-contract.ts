// modules/sales/application/manage-contract/sign-contract.ts — WBS 1.7, M02 sales.
//
// ONE withIdempotentContext transaction. Lock order: (1) contract-row lock + expectedVersion
// check, (2) role gate (CFO), (3) advanceContract (draft -> signed; IllegalTransitionError for any
// other status), (4) the unconditional version bump with signed_at = clock.now() and
// signed_by_client, (5) the audit row.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-contract/errors.js';
import { CONTRACT_EVENTS, CONTRACT_STATUS, advanceContract } from '../../domain/manage-contract/machine.js';
import type { ManageContractDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_SIGN = 'sign';

export interface SignContractInput {
  readonly contractId: string;
  readonly signedByClient: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface SignContractResult {
  readonly version: number;
}

export async function signContract(
  ctx: WithContextCtx,
  input: SignContractInput,
  deps: ManageContractDeps,
): Promise<SignContractResult> {
  if (!ctx.userId) throw new MissingActorError('SignContract requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<SignContractResult>(ctx, input.idem, async (tx) => {
    const contract = await deps.repo.getContractForUpdate(tx, input.contractId);
    if (contract.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `SignContract: expectedVersion ${input.expectedVersion} no longer matches contract ` +
          `${input.contractId}'s version ${contract.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`SignContract requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    advanceContract(contract.status, [CONTRACT_EVENTS.SIGN_CONTRACT]);

    const signedAt = deps.clock.now();
    const newVersion = await deps.repo.updateContract(tx, input.contractId, {
      status: CONTRACT_STATUS.SIGNED,
      signedAt,
      signedByClient: input.signedByClient,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: contract.entityId,
      target: 'contract',
      recordId: input.contractId,
      operation: AUDIT_OPERATION_SIGN,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: CONTRACT_STATUS.SIGNED, version: newVersion },
      occurredAt: signedAt,
    });

    return { version: newVersion };
  });
}
