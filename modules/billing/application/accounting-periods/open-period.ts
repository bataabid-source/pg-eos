// modules/billing/application/accounting-periods/open-period.ts — WBS 4.19 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (golden slice:
// modules/wms/application/receive-inbound/approve-inbound.ts). Order: (0) the idempotency claim
// when input.idem is set, (1) the fiscal year of the SAME entity must be visible
// (FiscalYearNotFoundError otherwise — RLS hides another entity's years), (2) the insert at the
// machine's initial status 'open' (the DB refuses a range outside the year, 23514, and an
// overlapping period of the same entity, 23P01), (3) the outbox row, (4) the audit row, last.
// No role gate (4.19 pre-build review D2): entity_scope RLS only.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { MissingActorError } from '../../domain/accounting-periods/errors.js';
import type { PeriodStatus } from '../../domain/accounting-periods/machine.js';
import type { AccountingPeriodsDeps } from './ports.js';

const AUDIT_OPERATION_OPEN = 'open';
const PERIODS_AGGREGATE_TYPE = 'billing.accounting_periods';
const OPENED_EVENT_TYPE: CatalogedEventType = 'billing.accounting_period.opened';

export interface OpenPeriodInput {
  readonly entityId: string;
  readonly fiscalYearId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface OpenPeriodResult {
  readonly id: string;
  readonly version: number;
  readonly status: PeriodStatus;
}

export async function openPeriod(
  ctx: WithContextCtx,
  input: OpenPeriodInput,
  deps: AccountingPeriodsDeps,
): Promise<OpenPeriodResult> {
  if (!ctx.userId) throw new MissingActorError('OpenPeriod requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<OpenPeriodResult>(ctx, input.idem, async (tx) => {
    await deps.repo.getFiscalYear(tx, input.entityId, input.fiscalYearId);

    const created = await deps.repo.insertPeriod(tx, {
      entityId: input.entityId,
      fiscalYearId: input.fiscalYearId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    const now = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: input.entityId,
      aggregateType: PERIODS_AGGREGATE_TYPE,
      aggregateId: created.id,
      eventType: OPENED_EVENT_TYPE,
      payload: {
        periodId: created.id,
        fiscalYearId: input.fiscalYearId,
        startDate: input.startDate,
        endDate: input.endDate,
        status: created.status,
      },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      target: 'period',
      recordId: created.id,
      operation: AUDIT_OPERATION_OPEN,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        fiscal_year_id: input.fiscalYearId,
        start_date: input.startDate,
        end_date: input.endDate,
        status: created.status,
        version: created.version,
      },
      occurredAt: now,
    });

    return { id: created.id, version: created.version, status: created.status };
  });
}
