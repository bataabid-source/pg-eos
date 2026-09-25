// modules/sales/application/manage-contract/create-contract.ts — WBS 1.7, M02 sales.
//
// ONE withIdempotentContext transaction (step 0 — runs first when input.idem is set). No row is
// locked (a fresh insert): role gate (CFO — slice brief Master decision 2), startDate >= today
// (InvalidStartDateError) and endDate null or >= startDate (InvalidEndDateError), resolve the
// account and check INV-C2-1 (assertAccountQualified, reused from manage-quote), then the insert
// (doc_no via platform.next_doc_no, inside the repository), then the audit row, last.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertAccountQualified, assertValidEndDate, assertValidStartDate, todayIso } from '../../domain/manage-contract/invariants.js';
import { MissingActorError, RoleRequiredError } from '../../domain/manage-contract/errors.js';
import { CONTRACT_STATUS } from '../../domain/manage-contract/machine.js';
import type { ManageContractDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_CREATE = 'create';

// Master decision 2's defaults — applied here so a caller (this application layer's own callers,
// including tests that bypass the Zod contract) never has to repeat them.
const DEFAULT_BILLING_CYCLE = 'monthly';
const DEFAULT_PAYMENT_TERMS_DAYS = 30;
const DEFAULT_NOTICE_DAYS = 30;
const DEFAULT_MIN_MONTHLY_CHARGE = '0.000';

export interface CreateContractInput {
  readonly entityId: string;
  readonly accountId: string;
  readonly quoteId: string | null;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly billingCycle?: string | undefined;
  readonly paymentTermsDays?: number | undefined;
  readonly autoRenew?: boolean | undefined;
  readonly noticeDays?: number | undefined;
  readonly minMonthlyCharge?: string | undefined;
  readonly slaEnabled?: boolean | undefined;
  readonly billsFailedAttempt?: boolean | undefined;
  readonly billsReturn?: boolean | undefined;
  readonly billsWaiting?: boolean | undefined;
  readonly billsReschedule?: boolean | undefined;
  readonly billsPartialDelivery?: boolean | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateContractResult {
  readonly contractId: string;
  readonly docNo: string;
  readonly version: number;
}

export async function createContract(
  ctx: WithContextCtx,
  input: CreateContractInput,
  deps: ManageContractDeps,
): Promise<CreateContractResult> {
  if (!ctx.userId) throw new MissingActorError('CreateContract requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateContractResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`CreateContract requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    const today = todayIso(deps.clock.now());
    assertValidStartDate(input.startDate, today);
    assertValidEndDate(input.endDate, input.startDate);
    assertAccountQualified(await deps.repo.getAccountById(tx, input.accountId));

    const created = await deps.repo.insertContract(tx, {
      entityId: input.entityId,
      accountId: input.accountId,
      quoteId: input.quoteId,
      title: input.title,
      startDate: input.startDate,
      endDate: input.endDate,
      billingCycle: input.billingCycle ?? DEFAULT_BILLING_CYCLE,
      paymentTermsDays: input.paymentTermsDays ?? DEFAULT_PAYMENT_TERMS_DAYS,
      autoRenew: input.autoRenew ?? false,
      noticeDays: input.noticeDays ?? DEFAULT_NOTICE_DAYS,
      minMonthlyCharge: input.minMonthlyCharge ?? DEFAULT_MIN_MONTHLY_CHARGE,
      slaEnabled: input.slaEnabled ?? false,
      billsFailedAttempt: input.billsFailedAttempt ?? false,
      billsReturn: input.billsReturn ?? false,
      billsWaiting: input.billsWaiting ?? false,
      billsReschedule: input.billsReschedule ?? false,
      billsPartialDelivery: input.billsPartialDelivery ?? false,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      target: 'contract',
      recordId: created.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: CONTRACT_STATUS.DRAFT, version: created.version, docNo: created.docNo },
      occurredAt: deps.clock.now(),
    });

    return { contractId: created.id, docNo: created.docNo, version: created.version };
  });
}
