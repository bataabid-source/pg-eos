// modules/billing/application/accounting-periods/lock-period.ts — WBS 4.19 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (golden slice:
// modules/wms/application/receive-inbound/approve-inbound.ts). Lock order
// (../../infrastructure/accounting-periods/repository.ts header): (0) the idempotency claim when
// input.idem is set, (1) period-row lock + expectedVersion check, (2) the CFO role gate (brief
// default: the doc 38 row 4.19 Owner locks as well as closes, 4.19 pre-build review D2), (3) the
// machine's legality check (LOCK, legal only from 'closed'; 'locked' is final), (4) the outbox row,
// (5) the status change + version bump, (6) the audit row, last. A locked period is never
// reopened. A caller outside the period's entity sees no row (RLS) -> PeriodNotFoundError.

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

const AUDIT_OPERATION_LOCK = 'lock';
const PERIODS_AGGREGATE_TYPE = 'billing.accounting_periods';
const LOCKED_EVENT_TYPE: CatalogedEventType = 'billing.accounting_period.locked';

export interface LockPeriodInput {
  readonly periodId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface LockPeriodResult {
  readonly version: number;
  readonly status: PeriodStatus;
}

export async function lockPeriod(
  ctx: WithContextCtx,
  input: LockPeriodInput,
  deps: AccountingPeriodsDeps,
): Promise<LockPeriodResult> {
  if (!ctx.userId) throw new MissingActorError('LockPeriod requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<LockPeriodResult>(ctx, input.idem, async (tx) => {
    const period = await deps.repo.getPeriodForUpdate(tx, input.periodId);
    if (period.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `LockPeriod: expectedVersion ${input.expectedVersion} no longer matches period ` +
          `${input.periodId}'s version ${period.version} (optimistic lock).`,
      );
    }

    const requiredRole = PERIOD_EVENT_ROLES[PERIOD_EVENTS.LOCK];
    if (requiredRole && !(await deps.repo.hasRole(tx, requiredRole))) {
      throw new RoleRequiredError(`LockPeriod requires role ${requiredRole} (platform.my_roles()).`);
    }

    // No if on the status string — advancePeriodStatus THROWS IllegalPeriodTransitionError itself.
    const newStatus = advancePeriodStatus(period.status, [PERIOD_EVENTS.LOCK]);
    const now = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: period.entityId,
      aggregateType: PERIODS_AGGREGATE_TYPE,
      aggregateId: input.periodId,
      eventType: LOCKED_EVENT_TYPE,
      payload: { periodId: input.periodId, startDate: period.startDate, endDate: period.endDate, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    const newVersion = await deps.repo.updatePeriodStatus(tx, input.periodId, newStatus);

    await deps.repo.writeAuditRow(tx, {
      entityId: period.entityId,
      target: 'period',
      recordId: input.periodId,
      operation: AUDIT_OPERATION_LOCK,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion },
      occurredAt: now,
    });

    return { version: newVersion, status: newStatus };
  });
}
