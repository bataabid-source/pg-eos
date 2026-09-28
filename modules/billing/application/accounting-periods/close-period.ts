// modules/billing/application/accounting-periods/close-period.ts — WBS 4.19 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (golden slice:
// modules/wms/application/receive-inbound/approve-inbound.ts). Lock order
// (../../infrastructure/accounting-periods/repository.ts header): (0) the idempotency claim when
// input.idem is set, (1) period-row lock + expectedVersion check, (2) the CFO role gate (OD-12
// "CFO closes", 4.19 pre-build review D2), (3) the machine's legality check (CLOSE, never an if on
// the status string), (4) the outbox row, (5) the status change + version bump, (6) the audit row,
// last. From the commit on, the DB refuses every posting dated inside the period (migration 0040).
// A caller outside the period's entity sees no row (RLS) -> PeriodNotFoundError.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/accounting-periods/errors.js';
import {
  PERIOD_EVENT_ROLES,
  PERIOD_EVENTS,
  advancePeriodStatus,
  type PeriodStatus,
} from '../../domain/accounting-periods/machine.js';
import type { AccountingPeriodsDeps } from './ports.js';

const AUDIT_OPERATION_CLOSE = 'close';
const PERIODS_AGGREGATE_TYPE = 'billing.accounting_periods';
const CLOSED_EVENT_TYPE: CatalogedEventType = 'billing.accounting_period.closed';

export interface ClosePeriodInput {
  readonly periodId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ClosePeriodResult {
  readonly version: number;
  readonly status: PeriodStatus;
}

export async function closePeriod(
  ctx: WithContextCtx,
  input: ClosePeriodInput,
  deps: AccountingPeriodsDeps,
): Promise<ClosePeriodResult> {
  if (!ctx.userId) throw new MissingActorError('ClosePeriod requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ClosePeriodResult>(ctx, input.idem, async (tx) => {
    const period = await deps.repo.getPeriodForUpdate(tx, input.periodId);
    if (period.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ClosePeriod: expectedVersion ${input.expectedVersion} no longer matches period ` +
          `${input.periodId}'s version ${period.version} (optimistic lock).`,
      );
    }

    const requiredRole = PERIOD_EVENT_ROLES[PERIOD_EVENTS.CLOSE];
    if (requiredRole && !(await deps.repo.hasRole(tx, requiredRole))) {
      throw new RoleRequiredError(`ClosePeriod requires role ${requiredRole} (platform.my_roles()).`);
    }

    // No if on the status string — advancePeriodStatus THROWS IllegalPeriodTransitionError itself.
    const newStatus = advancePeriodStatus(period.status, [PERIOD_EVENTS.CLOSE]);
    const now = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: period.entityId,
      aggregateType: PERIODS_AGGREGATE_TYPE,
      aggregateId: input.periodId,
      eventType: CLOSED_EVENT_TYPE,
      payload: { periodId: input.periodId, startDate: period.startDate, endDate: period.endDate, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    const newVersion = await deps.repo.updatePeriodStatus(tx, input.periodId, newStatus);

    await deps.repo.writeAuditRow(tx, {
      entityId: period.entityId,
      target: 'period',
      recordId: input.periodId,
      operation: AUDIT_OPERATION_CLOSE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion },
      occurredAt: now,
    });

    return { version: newVersion, status: newStatus };
  });
}
