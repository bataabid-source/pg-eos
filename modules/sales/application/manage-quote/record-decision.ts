// modules/sales/application/manage-quote/record-decision.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) quote-row lock +
// expectedVersion check, (2) advanceQuote (sent -> accepted|rejected — the ONLY legal source is
// `sent`, which the machine itself enforces; this command does NOT call assertQuoteNotFrozen,
// since `sent` is exactly the state RecordDecision is legal from), (3) the unconditional version
// bump with decided_at = clock.now(), (4) the audit row.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { MissingActorError, StaleVersionError } from '../../domain/manage-quote/errors.js';
import { QUOTE_EVENTS, advanceQuote, type QuoteEventType } from '../../domain/manage-quote/machine.js';
import type { ManageQuoteDeps } from './ports.js';

const AUDIT_OPERATION_RECORD_DECISION = 'record_decision';

const DECISION_EVENT: Readonly<Record<'accepted' | 'rejected', QuoteEventType>> = {
  accepted: QUOTE_EVENTS.RECORD_DECISION_ACCEPTED,
  rejected: QUOTE_EVENTS.RECORD_DECISION_REJECTED,
};

export interface RecordDecisionInput {
  readonly quoteId: string;
  readonly decision: 'accepted' | 'rejected';
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface RecordDecisionResult {
  readonly version: number;
}

export async function recordDecision(
  ctx: WithContextCtx,
  input: RecordDecisionInput,
  deps: ManageQuoteDeps,
): Promise<RecordDecisionResult> {
  if (!ctx.userId) throw new MissingActorError('RecordDecision requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<RecordDecisionResult>(ctx, input.idem, async (tx) => {
    const quote = await deps.repo.getQuoteForUpdate(tx, input.quoteId);
    if (quote.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `RecordDecision: expectedVersion ${input.expectedVersion} no longer matches quote ` +
          `${input.quoteId}'s version ${quote.version} (optimistic lock).`,
      );
    }

    const newStatus = advanceQuote(quote.status, [DECISION_EVENT[input.decision]]);

    const decidedAt = deps.clock.now();
    const newVersion = await deps.repo.updateQuote(tx, input.quoteId, { status: newStatus, decidedAt });

    await deps.repo.writeAuditRow(tx, {
      entityId: quote.entityId,
      target: 'quote',
      recordId: input.quoteId,
      operation: AUDIT_OPERATION_RECORD_DECISION,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, decision: input.decision },
      occurredAt: decidedAt,
    });

    return { version: newVersion };
  });
}
