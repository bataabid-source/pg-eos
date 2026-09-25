// modules/sales/application/manage-quote/submit-for-review.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) quote-row lock +
// expectedVersion check, (2) assertQuoteNotFrozen (a frozen quote -> QuoteFrozenError, checked
// BEFORE the machine, so a call on a sent/accepted/rejected/expired quote is always
// QuoteFrozenError rather than IllegalTransitionError — Master decision 17), (3) re-check
// INV-C2-1 (account still qualified), (4) require >= 1 line (EmptyQuoteError, Master decision 6),
// (5) advanceQuote (the machine's own legality check — IllegalTransitionError for any OTHER
// illegal call, e.g. already past draft), (6) the unconditional version bump, (7) the audit row.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertAccountQualified, assertQuoteNotFrozen } from '../../domain/manage-quote/invariants.js';
import { EmptyQuoteError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-quote/errors.js';
import { QUOTE_EVENTS, QUOTE_STATUS, advanceQuote } from '../../domain/manage-quote/machine.js';
import type { ManageQuoteDeps } from './ports.js';

const AUDIT_OPERATION_SUBMIT = 'submit_for_review';
const ROLE_SALES_REP = 'SALES_REP';

export interface SubmitForReviewInput {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface SubmitForReviewResult {
  readonly version: number;
}

export async function submitForReview(
  ctx: WithContextCtx,
  input: SubmitForReviewInput,
  deps: ManageQuoteDeps,
): Promise<SubmitForReviewResult> {
  if (!ctx.userId) throw new MissingActorError('SubmitForReview requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<SubmitForReviewResult>(ctx, input.idem, async (tx) => {
    const quote = await deps.repo.getQuoteForUpdate(tx, input.quoteId);
    if (quote.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `SubmitForReview: expectedVersion ${input.expectedVersion} no longer matches quote ` +
          `${input.quoteId}'s version ${quote.version} (optimistic lock).`,
      );
    }

    assertQuoteNotFrozen(quote.status);

    if (!(await deps.repo.hasRole(tx, ROLE_SALES_REP))) {
      throw new RoleRequiredError(`SubmitForReview requires role ${ROLE_SALES_REP} (platform.my_roles()).`);
    }

    assertAccountQualified(await deps.repo.getAccountById(tx, quote.accountId));

    // no if on the status string — advanceQuote asks the machine and THROWS
    // IllegalTransitionError itself when the event is not legal from `quote.status`. Checked
    // BEFORE the line-count gate below: a quote that is already past `draft` (e.g. forced to
    // commercial_review directly) is a structurally illegal call, not an "empty quote" business
    // rejection, even if it also happens to have zero lines.
    advanceQuote(quote.status, [QUOTE_EVENTS.SUBMIT_FOR_REVIEW]);

    const lines = await deps.repo.getLinesForQuote(tx, input.quoteId);
    if (lines.length === 0) {
      throw new EmptyQuoteError(`quote ${input.quoteId} has zero lines — SubmitForReview requires >= 1 (Master decision 6).`);
    }

    const newVersion = await deps.repo.updateQuote(tx, input.quoteId, { status: QUOTE_STATUS.COMMERCIAL_REVIEW });

    await deps.repo.writeAuditRow(tx, {
      entityId: quote.entityId,
      target: 'quote',
      recordId: input.quoteId,
      operation: AUDIT_OPERATION_SUBMIT,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: QUOTE_STATUS.COMMERCIAL_REVIEW, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
