// modules/billing/application/accounting-periods/create-fiscal-year.ts — WBS 4.19 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (golden slice:
// modules/wms/application/receive-inbound/approve-inbound.ts). Order: (0) the idempotency claim
// when input.idem is set, (1) the CFO role gate (4.19 pre-build review D2), (2) the insert (the DB
// refuses an overlapping year of the same entity, 23P01, and a reversed range, 23514), (3) the
// outbox row, (4) the audit row, last. A caller outside the entity is refused by entity_scope RLS.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { MissingActorError, RoleRequiredError } from '../../domain/accounting-periods/errors.js';
import { FISCAL_YEAR_CREATE_ROLE } from '../../domain/accounting-periods/machine.js';
import type { AccountingPeriodsDeps } from './ports.js';

const AUDIT_OPERATION_CREATE = 'create';
const FISCAL_YEARS_AGGREGATE_TYPE = 'billing.fiscal_years';
const CREATED_EVENT_TYPE: CatalogedEventType = 'billing.fiscal_year.created';

export interface CreateFiscalYearInput {
  readonly entityId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateFiscalYearResult {
  readonly id: string;
  readonly version: number;
}

export async function createFiscalYear(
  ctx: WithContextCtx,
  input: CreateFiscalYearInput,
  deps: AccountingPeriodsDeps,
): Promise<CreateFiscalYearResult> {
  if (!ctx.userId) throw new MissingActorError('CreateFiscalYear requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateFiscalYearResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasRole(tx, FISCAL_YEAR_CREATE_ROLE))) {
      throw new RoleRequiredError(`CreateFiscalYear requires role ${FISCAL_YEAR_CREATE_ROLE} (platform.my_roles()).`);
    }

    const created = await deps.repo.insertFiscalYear(tx, {
      entityId: input.entityId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    const now = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: input.entityId,
      aggregateType: FISCAL_YEARS_AGGREGATE_TYPE,
      aggregateId: created.id,
      eventType: CREATED_EVENT_TYPE,
      payload: { fiscalYearId: created.id, entityId: input.entityId, startDate: input.startDate, endDate: input.endDate },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      target: 'fiscal_year',
      recordId: created.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { start_date: input.startDate, end_date: input.endDate, version: created.version },
      occurredAt: now,
    });

    return { id: created.id, version: created.version };
  });
}
