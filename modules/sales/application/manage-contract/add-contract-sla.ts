// modules/sales/application/manage-contract/add-contract-sla.ts — WBS 1.7, M02 sales.
//
// ONE withIdempotentContext transaction. Lock order: (1) contract-row lock + expectedVersion check
// (serialises concurrent SLA additions on the same contract and confirms the contract exists), (2)
// assertSlaAssignable — the machine's own CONTRACT_TAG_SLA_ASSIGNABLE tag, every status except
// `terminated` (pg-reviewer fix round 1, finding 1: never an if/switch comparing the status string
// to 'terminated'), (3) role gate (CFO), (4) sla_enabled = true, else SlaNotEnabledError, (5) the
// contract_sla insert — NO version bump on the contract row for this (Master decision 9: a child
// insert, not a change to the contract's own mutable fields) — the contract's own UNCHANGED version
// is echoed back for the caller's convenience, (6) the audit row (target 'sla').

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertSlaAssignable } from '../../domain/manage-contract/invariants.js';
import { SlaNotEnabledError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-contract/errors.js';
import type { ManageContractDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_ADD_SLA = 'add_sla';

export interface AddContractSlaInput {
  readonly contractId: string;
  readonly metric: string;
  readonly targetValue: string;
  readonly direction: string;
  readonly penaltyType?: string | undefined;
  readonly penaltyValue?: string | undefined;
  readonly bonusValue?: string | undefined;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface AddContractSlaResult {
  readonly slaId: string;
  readonly version: number;
}

export async function addContractSla(
  ctx: WithContextCtx,
  input: AddContractSlaInput,
  deps: ManageContractDeps,
): Promise<AddContractSlaResult> {
  if (!ctx.userId) throw new MissingActorError('AddContractSla requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<AddContractSlaResult>(ctx, input.idem, async (tx) => {
    const contract = await deps.repo.getContractForUpdate(tx, input.contractId);
    if (contract.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `AddContractSla: expectedVersion ${input.expectedVersion} no longer matches contract ` +
          `${input.contractId}'s version ${contract.version} (optimistic lock).`,
      );
    }

    assertSlaAssignable(contract.status);

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`AddContractSla requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    if (!contract.slaEnabled) {
      throw new SlaNotEnabledError(
        `sales.contracts ${input.contractId} has sla_enabled = false — AddContractSla requires it ` +
          '(Master decision 9).',
      );
    }

    const inserted = await deps.repo.insertContractSla(tx, {
      contractId: input.contractId,
      metric: input.metric,
      targetValue: input.targetValue,
      direction: input.direction,
      penaltyType: input.penaltyType ?? null,
      penaltyValue: input.penaltyValue ?? null,
      bonusValue: input.bonusValue ?? null,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: contract.entityId,
      target: 'sla',
      recordId: inserted.id,
      operation: AUDIT_OPERATION_ADD_SLA,
      correlationId: input.correlationId,
      actorId,
      newValue: { contractId: input.contractId, metric: input.metric, targetValue: input.targetValue },
      occurredAt: deps.clock.now(),
    });

    return { slaId: inserted.id, version: contract.version };
  });
}
