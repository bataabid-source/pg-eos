// modules/sales/application/manage-contract/expire-contract.ts — WBS 1.7, M02 sales.
//
// Role gate FIRST, before any transaction opens: any INTERNAL caller (Master decision 8: "a manual
// stand-in for a future scheduler"; checked via `ctx.isInternal`, never a specific role code — read
// straight off `ctx`, so it needs no DB round trip and no lock). pg-reviewer fix round 1, finding
// 8: this is the correct order (cheapest check first, no wasted transaction on an unauthorised
// caller) — only the header comment previously disagreed with the code.
//
// Then ONE withIdempotentContext transaction. Lock order: (1) contract-row lock + expectedVersion
// check, (2) advanceContract (active|suspended -> expired; IllegalTransitionError for any other
// status), (3) end_date is non-null and end_date < asOfDate (injected Clock), else
// ContractNotYetExpirableError, (4) the unconditional version bump, (5) the audit row.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertContractExpirable, todayIso } from '../../domain/manage-contract/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-contract/errors.js';
import { CONTRACT_EVENTS, CONTRACT_STATUS, advanceContract } from '../../domain/manage-contract/machine.js';
import type { ManageContractDeps } from './ports.js';

const AUDIT_OPERATION_EXPIRE = 'expire';

export interface ExpireContractInput {
  readonly contractId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ExpireContractResult {
  readonly version: number;
}

export async function expireContract(
  ctx: WithContextCtx,
  input: ExpireContractInput,
  deps: ManageContractDeps,
): Promise<ExpireContractResult> {
  if (!ctx.userId) throw new MissingActorError('ExpireContract requires ctx.userId.');
  const actorId = ctx.userId;
  if (!ctx.isInternal) {
    throw new RoleRequiredError('ExpireContract requires an internal caller (Master decision 8).');
  }

  return withIdempotentContext<ExpireContractResult>(ctx, input.idem, async (tx) => {
    const contract = await deps.repo.getContractForUpdate(tx, input.contractId);
    if (contract.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ExpireContract: expectedVersion ${input.expectedVersion} no longer matches contract ` +
          `${input.contractId}'s version ${contract.version} (optimistic lock).`,
      );
    }

    advanceContract(contract.status, [CONTRACT_EVENTS.EXPIRE_CONTRACT]);

    const asOfDate = todayIso(deps.clock.now());
    assertContractExpirable(contract.endDate, asOfDate);

    const newVersion = await deps.repo.updateContract(tx, input.contractId, { status: CONTRACT_STATUS.EXPIRED });

    await deps.repo.writeAuditRow(tx, {
      entityId: contract.entityId,
      target: 'contract',
      recordId: input.contractId,
      operation: AUDIT_OPERATION_EXPIRE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: CONTRACT_STATUS.EXPIRED, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
