// modules/sales/application/manage-quote/approve-finance.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) quote-row lock +
// expectedVersion check, (2) assertQuoteNotFrozen, (3) re-check LIVE whether any line has
// exception_id set OR estimatedMarginPct < 10 (Master decision 8 — both re-checked live, never
// trusted from a stale read); the escalation gate: CFO normally, GM required when either
// condition holds — else RoleRequiredError naming the role actually needed, (4) advanceQuote, (5)
// the unconditional version bump with approved_by = ctx.userId, (6) ONE outbox event
// ('sales.quote.approved') in the SAME transaction, (7) the audit row, sharing the SAME
// correlation_id as the outbox row (G9).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent } from '@pg-eos/events';

import { assertMarginInRange, assertQuoteNotFrozen } from '../../domain/manage-quote/invariants.js';
import { computeEstimatedMarginPct } from '../../domain/manage-quote/margin.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-quote/errors.js';
import { QUOTE_EVENTS, QUOTE_STATUS, advanceQuote } from '../../domain/manage-quote/machine.js';
import type { ManageQuoteDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const ROLE_GM = 'GM';
const AUDIT_OPERATION_APPROVE_FINANCE = 'approve_finance';
const QUOTE_APPROVED_EVENT_TYPE = 'sales.quote.approved'; // doc 40 §C2's own named event.
const QUOTES_AGGREGATE_TYPE = 'sales.quotes';
// D-blueprint 02 §165: "under 10% [margin] is not approved except by GM".
const MARGIN_GM_ESCALATION_CEILING = 10;

export interface ApproveFinanceInput {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ApproveFinanceResult {
  readonly version: number;
}

export async function approveFinance(
  ctx: WithContextCtx,
  input: ApproveFinanceInput,
  deps: ManageQuoteDeps,
): Promise<ApproveFinanceResult> {
  if (!ctx.userId) throw new MissingActorError('ApproveFinance requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ApproveFinanceResult>(ctx, input.idem, async (tx) => {
    const quote = await deps.repo.getQuoteForUpdate(tx, input.quoteId);
    if (quote.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ApproveFinance: expectedVersion ${input.expectedVersion} no longer matches quote ` +
          `${input.quoteId}'s version ${quote.version} (optimistic lock).`,
      );
    }

    assertQuoteNotFrozen(quote.status);

    const lines = await deps.repo.getLinesForQuote(tx, input.quoteId);
    const hasException = lines.some((line) => line.exceptionId !== null);
    const estimatedMarginPct = computeEstimatedMarginPct(
      lines.map((line) => ({ qty: line.qty, unitPrice: line.unitPrice, standardCost: line.standardCost })),
    );
    const requiresGm = hasException || (estimatedMarginPct !== null && estimatedMarginPct < MARGIN_GM_ESCALATION_CEILING);

    // pg-reviewer fix round 2, finding 1: checked BEFORE the role gate — a raw Postgres
    // numeric-overflow (500) must never reach the write below, on any code path.
    assertMarginInRange(estimatedMarginPct);

    // pg-reviewer fix round 1, finding 2: GM is the top of the role hierarchy — a superset of
    // CFO's authority here (same pattern return-to-draft.ts already uses for its own CFO/GM
    // branch) — so a GM actor is ALWAYS accepted, even on a non-escalated (healthy) quote.
    const isGm = await deps.repo.hasRole(tx, ROLE_GM);
    if (!isGm) {
      if (requiresGm) {
        throw new RoleRequiredError(
          `ApproveFinance requires role ${ROLE_GM} (platform.my_roles()) — this quote has a ` +
            'below-floor exception line or estimatedMarginPct < 10 (Master decision 8).',
        );
      }
      if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
        throw new RoleRequiredError(`ApproveFinance requires role ${ROLE_CFO} or ${ROLE_GM} (platform.my_roles()) — the normal CFO gate.`);
      }
    }

    advanceQuote(quote.status, [QUOTE_EVENTS.APPROVE_FINANCE]);

    const newVersion = await deps.repo.updateQuote(tx, input.quoteId, {
      status: QUOTE_STATUS.APPROVED,
      approvedBy: actorId,
      // pg-reviewer fix round 1, finding 16: write the live-recomputed margin back to the quote
      // row, in the SAME transaction, so the stored column never disagrees with the value just
      // published in the outbox event below.
      estimatedMarginPct,
    });

    await writeOutboxEvent(tx, {
      entityId: quote.entityId,
      aggregateType: QUOTES_AGGREGATE_TYPE,
      aggregateId: input.quoteId,
      eventType: QUOTE_APPROVED_EVENT_TYPE,
      payload: {
        quoteId: input.quoteId,
        entityId: quote.entityId,
        accountId: quote.accountId,
        total: quote.total,
        estimatedMarginPct,
        approvedBy: actorId,
      },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: quote.entityId,
      target: 'quote',
      recordId: input.quoteId,
      operation: AUDIT_OPERATION_APPROVE_FINANCE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: QUOTE_STATUS.APPROVED, version: newVersion, approvedBy: actorId },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
