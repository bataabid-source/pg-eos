// modules/sales/application/manage-quote/create-quote.ts — WBS 1.6, M02 sales.
//
// ONE withIdempotentContext transaction (step 0 — runs first when input.idem is set). No row is
// locked (a fresh insert): role gate (SALES_REP — pg-reviewer fix round 1, finding 4), the
// validUntil >= today check (finding 5), resolve the account and check INV-C2-1 (Master decision
// 2), then the insert (doc_no via platform.next_doc_no, inside the repository), then the audit
// row, last.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertAccountQualified, assertValidUntilNotPast, todayIso } from '../../domain/manage-quote/invariants.js';
import { MissingActorError, RoleRequiredError } from '../../domain/manage-quote/errors.js';
import { QUOTE_STATUS } from '../../domain/manage-quote/machine.js';
import type { ManageQuoteDeps } from './ports.js';

const ROLE_SALES_REP = 'SALES_REP';
const AUDIT_OPERATION_CREATE = 'create';

export interface CreateQuoteInput {
  readonly entityId: string;
  readonly accountId: string;
  readonly opportunityId: string | null;
  readonly validUntil: string;
  readonly currency: string;
  readonly termsAr: string | null;
  readonly termsEn: string | null;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateQuoteResult {
  readonly quoteId: string;
  readonly docNo: string;
  readonly version: number;
}

export async function createQuote(
  ctx: WithContextCtx,
  input: CreateQuoteInput,
  deps: ManageQuoteDeps,
): Promise<CreateQuoteResult> {
  if (!ctx.userId) throw new MissingActorError('CreateQuote requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateQuoteResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasRole(tx, ROLE_SALES_REP))) {
      throw new RoleRequiredError(`CreateQuote requires role ${ROLE_SALES_REP} (platform.my_roles()).`);
    }

    assertValidUntilNotPast(input.validUntil, todayIso(deps.clock.now()));
    assertAccountQualified(await deps.repo.getAccountById(tx, input.accountId));

    const created = await deps.repo.insertQuote(tx, {
      entityId: input.entityId,
      accountId: input.accountId,
      opportunityId: input.opportunityId,
      validUntil: input.validUntil,
      currency: input.currency,
      termsAr: input.termsAr,
      termsEn: input.termsEn,
      preparedBy: actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      target: 'quote',
      recordId: created.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: QUOTE_STATUS.DRAFT, version: created.version, docNo: created.docNo },
      occurredAt: deps.clock.now(),
    });

    return { quoteId: created.id, docNo: created.docNo, version: created.version };
  });
}
