// modules/sales/application/manage-quote/send-quote.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) quote-row lock +
// expectedVersion check, (2) assertQuoteNotFrozen, (3) advanceQuote (approved -> sent), (4) build
// frozen_snapshot (the whole quote + its lines, as JSON — Master decision 10), (5) the
// unconditional version bump with sent_at = clock.now(), (6) the audit row. No outbox event (doc
// 40 names only sales.quote.approved).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertQuoteNotFrozen } from '../../domain/manage-quote/invariants.js';
import { MissingActorError, StaleVersionError } from '../../domain/manage-quote/errors.js';
import { QUOTE_EVENTS, QUOTE_STATUS, advanceQuote } from '../../domain/manage-quote/machine.js';
import type { ManageQuoteDeps } from './ports.js';

const AUDIT_OPERATION_SEND = 'send';

export interface SendQuoteInput {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface SendQuoteResult {
  readonly version: number;
}

export async function sendQuote(
  ctx: WithContextCtx,
  input: SendQuoteInput,
  deps: ManageQuoteDeps,
): Promise<SendQuoteResult> {
  if (!ctx.userId) throw new MissingActorError('SendQuote requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<SendQuoteResult>(ctx, input.idem, async (tx) => {
    const quote = await deps.repo.getQuoteForUpdate(tx, input.quoteId);
    if (quote.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `SendQuote: expectedVersion ${input.expectedVersion} no longer matches quote ` +
          `${input.quoteId}'s version ${quote.version} (optimistic lock).`,
      );
    }

    assertQuoteNotFrozen(quote.status);
    advanceQuote(quote.status, [QUOTE_EVENTS.SEND_QUOTE]);

    const lines = await deps.repo.getLinesForQuote(tx, input.quoteId);
    const sentAt = deps.clock.now();
    const frozenSnapshot = {
      quote: {
        id: quote.id,
        entityId: quote.entityId,
        docNo: quote.docNo,
        accountId: quote.accountId,
        opportunityId: quote.opportunityId,
        validUntil: quote.validUntil,
        currency: quote.currency,
        subtotal: quote.subtotal,
        discountAmt: quote.discountAmt,
        total: quote.total,
        estimatedMarginPct: quote.estimatedMarginPct,
        termsAr: quote.termsAr,
        termsEn: quote.termsEn,
      },
      lines: lines.map((line) => ({
        id: line.id,
        serviceId: line.serviceId,
        qty: line.qty,
        uom: line.uom,
        unitPrice: line.unitPrice,
        minPriceAtQuote: line.minPriceAtQuote,
        exceptionId: line.exceptionId,
        lineTotal: line.lineTotal,
      })),
      sentAt: sentAt.toISOString(),
    };

    const newVersion = await deps.repo.updateQuote(tx, input.quoteId, {
      status: QUOTE_STATUS.SENT,
      frozenSnapshot,
      sentAt,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: quote.entityId,
      target: 'quote',
      recordId: input.quoteId,
      operation: AUDIT_OPERATION_SEND,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: QUOTE_STATUS.SENT, version: newVersion },
      occurredAt: sentAt,
    });

    return { version: newVersion };
  });
}
