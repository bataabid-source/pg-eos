// modules/sales/application/manage-quote/return-to-draft.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) quote-row lock +
// expectedVersion check, (2) assertQuoteNotFrozen, (3) role gate — SALES_MGR from
// commercial_review, or CFO/GM from finance_review (Master decision 9), (4) advanceQuote, (5) the
// unconditional version bump, (6) the audit row. No other business check (Master decision 9).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { assertQuoteNotFrozen } from '../../domain/manage-quote/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/manage-quote/errors.js';
import { QUOTE_EVENTS, QUOTE_STATUS, advanceQuote, getReturnRoles, type QuoteStatus } from '../../domain/manage-quote/machine.js';
import type { ManageQuoteDeps } from './ports.js';

const AUDIT_OPERATION_RETURN_TO_DRAFT = 'return_to_draft';

export interface ReturnToDraftInput {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ReturnToDraftResult {
  readonly version: number;
}

/** Master decision 9 (pg-reviewer fix round 1, finding 3): the allowed role(s) come from the
 *  machine's own `meta.returnRoles` for `status` (../../domain/manage-quote/machine.ts's
 *  `getReturnRoles`) — never a status-string if/switch here. An empty array (no ReturnToDraft edge
 *  originates from this status at all) is a no-op; `advanceQuote` below throws
 *  IllegalTransitionError for it regardless. */
async function assertReturnRole(deps: ManageQuoteDeps, tx: NodePgDatabase, status: QuoteStatus): Promise<void> {
  const allowedRoles = getReturnRoles(status);
  if (allowedRoles.length === 0) return;

  for (const role of allowedRoles) {
    if (await deps.repo.hasRole(tx, role)) return;
  }
  throw new RoleRequiredError(`ReturnToDraft from ${status} requires role ${allowedRoles.join(' or ')}.`);
}

export async function returnToDraft(
  ctx: WithContextCtx,
  input: ReturnToDraftInput,
  deps: ManageQuoteDeps,
): Promise<ReturnToDraftResult> {
  if (!ctx.userId) throw new MissingActorError('ReturnToDraft requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ReturnToDraftResult>(ctx, input.idem, async (tx) => {
    const quote = await deps.repo.getQuoteForUpdate(tx, input.quoteId);
    if (quote.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ReturnToDraft: expectedVersion ${input.expectedVersion} no longer matches quote ` +
          `${input.quoteId}'s version ${quote.version} (optimistic lock).`,
      );
    }

    assertQuoteNotFrozen(quote.status);
    await assertReturnRole(deps, tx, quote.status);

    advanceQuote(quote.status, [QUOTE_EVENTS.RETURN_TO_DRAFT]);

    const newVersion = await deps.repo.updateQuote(tx, input.quoteId, { status: QUOTE_STATUS.DRAFT });

    await deps.repo.writeAuditRow(tx, {
      entityId: quote.entityId,
      target: 'quote',
      recordId: input.quoteId,
      operation: AUDIT_OPERATION_RETURN_TO_DRAFT,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: QUOTE_STATUS.DRAFT, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
