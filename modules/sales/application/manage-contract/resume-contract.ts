// modules/sales/application/manage-contract/resume-contract.ts — WBS 1.7, M02 sales.
//
// ONE withIdempotentContext transaction. Lock order: (1) contract-row lock + expectedVersion
// check, (2) role gate (CFO), (3) advanceContract (suspended -> active; IllegalTransitionError for
// any other status — no extra check, Master decision 7), (4) the unconditional version bump, (5)
// the audit row.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-contract/errors.js';
import { CONTRACT_EVENTS, CONTRACT_STATUS, advanceContract } from '../../domain/manage-contract/machine.js';
import type { ManageContractDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_RESUME = 'resume';

export interface ResumeContractInput {
  readonly contractId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ResumeContractResult {
  readonly version: number;
}

export async function resumeContract(
  ctx: WithContextCtx,
  input: ResumeContractInput,
  deps: ManageContractDeps,
): Promise<ResumeContractResult> {
  if (!ctx.userId) throw new MissingActorError('ResumeContract requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ResumeContractResult>(ctx, input.idem, async (tx) => {
    const contract = await deps.repo.getContractForUpdate(tx, input.contractId);
    if (contract.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ResumeContract: expectedVersion ${input.expectedVersion} no longer matches contract ` +
          `${input.contractId}'s version ${contract.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`ResumeContract requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    advanceContract(contract.status, [CONTRACT_EVENTS.RESUME_CONTRACT]);

    const newVersion = await deps.repo.updateContract(tx, input.contractId, { status: CONTRACT_STATUS.ACTIVE });

    await deps.repo.writeAuditRow(tx, {
      entityId: contract.entityId,
      target: 'contract',
      recordId: input.contractId,
      operation: AUDIT_OPERATION_RESUME,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: CONTRACT_STATUS.ACTIVE, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
