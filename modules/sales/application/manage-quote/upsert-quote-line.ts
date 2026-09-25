// modules/sales/application/manage-quote/upsert-quote-line.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) quote-row lock + expectedVersion
// check, (2) assertQuoteEditable (Master decision 17 — QuoteFrozenError on a non-draft quote),
// (3) resolve the service and re-read its CURRENT min_price/standard_cost fresh (Master decision
// 3 — "a snapshot, re-read on every upsert, not cached from a prior call"), (4) the price-floor +
// exception check — BEFORE any write (Master decision 3), (5) recompute the WHOLE quote's
// candidate subtotal/total/estimated_margin_pct over every EXISTING line plus the new line (still
// not yet written), (6) the discount check (Master decision 4) and the margin-range check
// (pg-reviewer fix round 1, finding 10) — BOTH before any write (finding 11: a guard must run
// BEFORE the write it guards, not after), (7) the insert (this command always APPENDS a new
// sales.quote_lines row — its own input carries no lineId to target an update), (8) the
// unconditional version bump, (9) the audit row, last.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { Quantity } from '@pg-eos/domain-kit';

import { computeEstimatedMarginPct } from '../../domain/manage-quote/margin.js';
import {
  assertMarginInRange,
  assertPriceExceptionValid,
  assertQuoteEditable,
  assertValidDiscount,
  todayIso,
} from '../../domain/manage-quote/invariants.js';
import {
  InvalidPriceExceptionError,
  MissingActorError,
  ServiceNotFoundError,
  StaleVersionError,
} from '../../domain/manage-quote/errors.js';
import type { ManageQuoteDeps, QuoteLineRow } from './ports.js';

const AUDIT_OPERATION_UPSERT_LINE = 'upsert';
// margin.ts / D-blueprint 02 §165: "warning" band is [0, 15) — a negative margin is a worse
// finding than a warning (surfaced via the GM-escalation gate at ApproveFinance instead).
const MARGIN_WARNING_CEILING = 15;
const MARGIN_WARNING_FLOOR = 0;

export interface UpsertQuoteLineInput {
  readonly quoteId: string;
  readonly serviceId: string;
  readonly qty: string;
  readonly unitPrice: string;
  readonly exceptionId: string | null;
  readonly discountAmt: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface UpsertQuoteLineResult {
  readonly version: number;
  readonly lineId: string;
  readonly subtotal: string;
  readonly total: string;
  readonly estimatedMarginPct: number | null;
  readonly marginWarning: boolean;
}

function sumLineTotals(lines: readonly { readonly lineTotal: string }[]): Quantity {
  return lines.reduce((sum, line) => sum.add(Quantity.of(line.lineTotal)), Quantity.zero());
}

export async function upsertQuoteLine(
  ctx: WithContextCtx,
  input: UpsertQuoteLineInput,
  deps: ManageQuoteDeps,
): Promise<UpsertQuoteLineResult> {
  if (!ctx.userId) throw new MissingActorError('UpsertQuoteLine requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<UpsertQuoteLineResult>(ctx, input.idem, async (tx) => {
    const quote = await deps.repo.getQuoteForUpdate(tx, input.quoteId);
    if (quote.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `UpsertQuoteLine: expectedVersion ${input.expectedVersion} no longer matches quote ` +
          `${input.quoteId}'s version ${quote.version} (optimistic lock).`,
      );
    }

    assertQuoteEditable(quote.status);

    const service = await deps.repo.getServiceById(tx, input.serviceId);
    if (!service) {
      throw new ServiceNotFoundError(
        `no active catalog.services row for id ${input.serviceId} (Allowed: an existing, active ` +
          'service id).',
      );
    }

    const unitPrice = Quantity.of(input.unitPrice);
    const minPrice = service.minPrice === null ? null : Quantity.of(service.minPrice);

    const exception = input.exceptionId ? await deps.repo.getPriceExceptionById(tx, input.exceptionId) : null;
    if (input.exceptionId && !exception) {
      throw new InvalidPriceExceptionError(
        `no catalog.price_exceptions row visible for id ${input.exceptionId} (Master decision 3).`,
      );
    }

    assertPriceExceptionValid({
      unitPrice,
      minPrice,
      exception,
      accountId: quote.accountId,
      serviceId: service.id,
      today: todayIso(deps.clock.now()),
    });

    const lineTotal = unitPrice.multiply(input.qty);
    const existingLines: readonly QuoteLineRow[] = await deps.repo.getLinesForQuote(tx, input.quoteId);

    // pg-reviewer fix round 1, finding 11: every guard below runs on the CANDIDATE state (existing
    // lines + this new line, not yet written) BEFORE insertLine — "guard before write", not after.
    const allLinesForMargin = [
      ...existingLines.map((line) => ({ qty: line.qty, unitPrice: line.unitPrice, standardCost: line.standardCost })),
      { qty: input.qty, unitPrice: input.unitPrice, standardCost: service.standardCost },
    ];
    const allLineTotals = [...existingLines, { lineTotal: lineTotal.toString() }];

    const subtotal = sumLineTotals(allLineTotals);
    const discountAmt = Quantity.of(input.discountAmt);
    assertValidDiscount(discountAmt, subtotal);
    const total = subtotal.subtract(discountAmt);
    const estimatedMarginPct = computeEstimatedMarginPct(allLinesForMargin);
    assertMarginInRange(estimatedMarginPct);
    const marginWarning =
      estimatedMarginPct !== null && estimatedMarginPct >= MARGIN_WARNING_FLOOR && estimatedMarginPct < MARGIN_WARNING_CEILING;

    const inserted = await deps.repo.insertLine(tx, {
      quoteId: input.quoteId,
      serviceId: service.id,
      qty: input.qty,
      uom: service.uom,
      unitPrice: input.unitPrice,
      minPriceAtQuote: service.minPrice,
      exceptionId: input.exceptionId,
      lineTotal: lineTotal.toString(),
      sortOrder: existingLines.length,
    });

    const newVersion = await deps.repo.updateQuote(tx, input.quoteId, {
      subtotal: subtotal.toString(),
      discountAmt: discountAmt.toString(),
      total: total.toString(),
      estimatedMarginPct,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: quote.entityId,
      target: 'line',
      recordId: inserted.id,
      operation: AUDIT_OPERATION_UPSERT_LINE,
      correlationId: input.correlationId,
      actorId,
      newValue: { serviceId: service.id, qty: input.qty, unitPrice: input.unitPrice, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return {
      version: newVersion,
      lineId: inserted.id,
      subtotal: subtotal.toString(),
      total: total.toString(),
      estimatedMarginPct,
      marginWarning,
    };
  });
}
