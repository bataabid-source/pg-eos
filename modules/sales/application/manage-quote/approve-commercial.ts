// modules/sales/application/manage-quote/approve-commercial.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) quote-row lock +
// expectedVersion check, (2) assertQuoteNotFrozen, (3) role gate (SALES_MGR), (4) advanceQuote
// (IllegalTransitionError for any other illegal call), (5) the unconditional version bump with
// reviewed_by = ctx.userId (Master decision 7 — reviewed_by is set HERE, not at ApproveFinance),
// (6) the audit row.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertQuoteNotFrozen } from '../../domain/manage-quote/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-quote/errors.js';
import { QUOTE_EVENTS, QUOTE_STATUS, advanceQuote } from '../../domain/manage-quote/machine.js';
import type { ManageQuoteDeps } from './ports.js';

const ROLE_SALES_MGR = 'SALES_MGR';
const AUDIT_OPERATION_APPROVE_COMMERCIAL = 'approve_commercial';

export interface ApproveCommercialInput {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ApproveCommercialResult {
  readonly version: number;
}

export async function approveCommercial(
  ctx: WithContextCtx,
  input: ApproveCommercialInput,
  deps: ManageQuoteDeps,
): Promise<ApproveCommercialResult> {
  if (!ctx.userId) throw new MissingActorError('ApproveCommercial requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ApproveCommercialResult>(ctx, input.idem, async (tx) => {
    const quote = await deps.repo.getQuoteForUpdate(tx, input.quoteId);
    if (quote.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ApproveCommercial: expectedVersion ${input.expectedVersion} no longer matches quote ` +
          `${input.quoteId}'s version ${quote.version} (optimistic lock).`,
      );
    }

    assertQuoteNotFrozen(quote.status);

    if (!(await deps.repo.hasRole(tx, ROLE_SALES_MGR))) {
      throw new RoleRequiredError(`ApproveCommercial requires role ${ROLE_SALES_MGR} (platform.my_roles()).`);
    }

    advanceQuote(quote.status, [QUOTE_EVENTS.APPROVE_COMMERCIAL]);

    const newVersion = await deps.repo.updateQuote(tx, input.quoteId, {
      status: QUOTE_STATUS.FINANCE_REVIEW,
      reviewedBy: actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: quote.entityId,
      target: 'quote',
      recordId: input.quoteId,
      operation: AUDIT_OPERATION_APPROVE_COMMERCIAL,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: QUOTE_STATUS.FINANCE_REVIEW, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
