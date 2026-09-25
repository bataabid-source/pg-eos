// modules/sales/application/manage-quote/revise-quote.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) SOURCE quote-row lock (read-
// only — this command never writes to the source row, so no version bump/expectedVersion check
// applies to it), (2) assertQuoteRevisable (Master decision 12 — IllegalTransitionError from
// draft/commercial_review/finance_review), (3) re-check INV-C2-1 (pg-reviewer fix round 1, finding
// 6 — the account may have gone unqualified since the source was built) and validUntil >= today
// (finding 6 — validUntil is COPIED from the source, then RE-CHECKED against today; a source
// whose validUntil has since lapsed is InvalidValidUntilError, not silently carried forward), (4)
// for EVERY source line: resolve the service and re-read its CURRENT min_price/standard_cost
// fresh (never copied stale), then run the SAME exception-validity check UpsertQuoteLine runs
// (existence, client+service match, validity today, approved_price — finding 7/9) — ALL of this
// BEFORE any write, (5) recompute the candidate subtotal/estimated_margin_pct and the margin-range
// check (finding 10) — still before any write, (6) insert the brand-new quote (status draft,
// version 1, a fresh doc_no from the same QTE series) and its cloned lines, (7) the audit row on
// the NEW quote, last. The source quote's own row is never updated — "the original quote's row is
// completely unchanged" (the scenario's own words).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { Quantity } from '@pg-eos/domain-kit';

import {
  assertAccountQualified,
  assertMarginInRange,
  assertPriceExceptionValid,
  assertQuoteRevisable,
  assertValidUntilNotPast,
  todayIso,
} from '../../domain/manage-quote/invariants.js';
import { computeEstimatedMarginPct } from '../../domain/manage-quote/margin.js';
import { InvalidPriceExceptionError, MissingActorError, ServiceNotFoundError } from '../../domain/manage-quote/errors.js';
import type { ManageQuoteDeps } from './ports.js';

const AUDIT_OPERATION_REVISE = 'revise';
const DEFAULT_DISCOUNT = '0.000';

export interface ReviseQuoteInput {
  readonly quoteId: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ReviseQuoteResult {
  readonly newQuoteId: string;
  readonly newDocNo: string;
}

interface ResolvedCloneLine {
  readonly serviceId: string;
  readonly qty: string;
  readonly uom: string;
  readonly unitPrice: string;
  readonly minPriceAtQuote: string | null;
  readonly exceptionId: string | null;
  readonly lineTotal: string;
  readonly standardCost: string | null;
}

export async function reviseQuote(
  ctx: WithContextCtx,
  input: ReviseQuoteInput,
  deps: ManageQuoteDeps,
): Promise<ReviseQuoteResult> {
  if (!ctx.userId) throw new MissingActorError('ReviseQuote requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ReviseQuoteResult>(ctx, input.idem, async (tx) => {
    // ReviseQuote never mutates the source row: no expectedVersion on this command's own input
    // (decision 12's own `{ newQuoteId, newDocNo }` result shape) — the row lock here is only to
    // read a consistent snapshot while another writer cannot concurrently mutate it mid-read.
    const source = await deps.repo.getQuoteForUpdate(tx, input.quoteId);

    assertQuoteRevisable(source.status);
    assertAccountQualified(await deps.repo.getAccountById(tx, source.accountId));

    const today = todayIso(deps.clock.now());
    // validUntil is copied-then-re-checked (not a fresh input on this command — decision 12 lists
    // no new caller-supplied fields): a source whose validUntil has since lapsed is a typed 422,
    // never silently carried into the new quote.
    assertValidUntilNotPast(source.validUntil, today);

    const sourceLines = await deps.repo.getLinesForQuote(tx, input.quoteId);

    // Resolve and validate EVERY cloned line BEFORE any write (guard-before-write, same principle
    // as upsert-quote-line.ts's own fix — pg-reviewer fix round 1, findings 7/9/11).
    const resolvedLines: ResolvedCloneLine[] = [];
    for (const line of sourceLines) {
      const service = await deps.repo.getServiceById(tx, line.serviceId);
      if (!service) {
        throw new ServiceNotFoundError(
          `no active catalog.services row for id ${line.serviceId} — ReviseQuote cannot clone a ` +
            'line whose service is no longer active.',
        );
      }

      const unitPrice = Quantity.of(line.unitPrice);
      const minPrice = service.minPrice === null ? null : Quantity.of(service.minPrice);
      const exception = line.exceptionId ? await deps.repo.getPriceExceptionById(tx, line.exceptionId) : null;
      if (line.exceptionId && !exception) {
        throw new InvalidPriceExceptionError(
          `no catalog.price_exceptions row visible for id ${line.exceptionId} (Master decision 3).`,
        );
      }
      assertPriceExceptionValid({
        unitPrice,
        minPrice,
        exception,
        accountId: source.accountId,
        serviceId: service.id,
        today,
      });

      const lineTotal = unitPrice.multiply(line.qty);
      resolvedLines.push({
        serviceId: line.serviceId,
        qty: line.qty,
        uom: line.uom,
        unitPrice: line.unitPrice,
        minPriceAtQuote: service.minPrice,
        exceptionId: line.exceptionId,
        lineTotal: lineTotal.toString(),
        standardCost: service.standardCost,
      });
    }

    const subtotal = resolvedLines.reduce((sum, line) => sum.add(Quantity.of(line.lineTotal)), Quantity.zero());
    const estimatedMarginPct = computeEstimatedMarginPct(
      resolvedLines.map((line) => ({ qty: line.qty, unitPrice: line.unitPrice, standardCost: line.standardCost })),
    );
    assertMarginInRange(estimatedMarginPct);

    const created = await deps.repo.insertQuote(tx, {
      entityId: source.entityId,
      accountId: source.accountId,
      opportunityId: source.opportunityId,
      validUntil: source.validUntil,
      currency: source.currency,
      termsAr: source.termsAr,
      termsEn: source.termsEn,
      preparedBy: actorId,
    });

    for (const [index, line] of resolvedLines.entries()) {
      await deps.repo.insertLine(tx, {
        quoteId: created.id,
        serviceId: line.serviceId,
        qty: line.qty,
        uom: line.uom,
        unitPrice: line.unitPrice,
        minPriceAtQuote: line.minPriceAtQuote,
        exceptionId: line.exceptionId,
        lineTotal: line.lineTotal,
        sortOrder: index,
      });
    }

    await deps.repo.updateQuote(tx, created.id, {
      subtotal: subtotal.toString(),
      discountAmt: DEFAULT_DISCOUNT,
      total: subtotal.toString(),
      estimatedMarginPct,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: source.entityId,
      target: 'quote',
      recordId: created.id,
      operation: AUDIT_OPERATION_REVISE,
      correlationId: input.correlationId,
      actorId,
      newValue: { sourceQuoteId: input.quoteId, docNo: created.docNo, lineCount: sourceLines.length },
      occurredAt: deps.clock.now(),
    });

    return { newQuoteId: created.id, newDocNo: created.docNo };
  });
}
