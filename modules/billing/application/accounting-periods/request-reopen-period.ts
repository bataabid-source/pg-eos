// modules/billing/application/accounting-periods/request-reopen-period.ts — WBS 4.19 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (golden slice:
// modules/wms/application/receive-inbound/approve-inbound.ts). OD-12: "reopen via Decision Inbox" —
// this command only FILES the request (4.19 pre-build review D8): (0) the idempotency claim when
// input.idem is set, (1) period-row lock + expectedVersion check, (2) the machine's legality check
// (REOPEN is legal only from 'closed' — IllegalPeriodTransitionError otherwise, nothing filed),
// (3) ONE platform.decisions row, status 'open', assigned_role read from platform.approval_chains
// (D1), context {requestedBy, periodId, entityId, periodVersion, startDate, endDate}. The period
// itself is unchanged — no period outbox row and no period audit row; the state change happens in
// applyPeriodReopenDecision once the decision is approved. No role gate: any member of the entity
// (D2) — a caller outside it sees no row (RLS) -> PeriodNotFoundError.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { MissingActorError, StaleVersionError } from '../../domain/accounting-periods/errors.js';
import { PERIOD_EVENTS, advancePeriodStatus } from '../../domain/accounting-periods/machine.js';
import type { AccountingPeriodsDeps } from './ports.js';

export interface RequestReopenPeriodInput {
  readonly periodId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface RequestReopenPeriodResult {
  readonly decisionId: string;
}

export async function requestReopenPeriod(
  ctx: WithContextCtx,
  input: RequestReopenPeriodInput,
  deps: AccountingPeriodsDeps,
): Promise<RequestReopenPeriodResult> {
  if (!ctx.userId) throw new MissingActorError('RequestReopenPeriod requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<RequestReopenPeriodResult>(ctx, input.idem, async (tx) => {
    const period = await deps.repo.getPeriodForUpdate(tx, input.periodId);
    if (period.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `RequestReopenPeriod: expectedVersion ${input.expectedVersion} no longer matches period ` +
          `${input.periodId}'s version ${period.version} (optimistic lock).`,
      );
    }

    // Legality only — the REOPEN edge is not applied here (D8); THROWS from any status but 'closed'.
    advancePeriodStatus(period.status, [PERIOD_EVENTS.REOPEN]);

    const decision = await deps.repo.insertReopenDecision(tx, {
      entityId: period.entityId,
      context: {
        requestedBy: actorId,
        periodId: period.id,
        entityId: period.entityId,
        periodVersion: period.version,
        startDate: period.startDate,
        endDate: period.endDate,
      },
    });

    deps.logger.info(
      { correlationId: input.correlationId, periodId: period.id, decisionId: decision.id },
      'billing.accounting-periods: reopen decision filed',
    );

    return { decisionId: decision.id };
  });
}
