// modules/billing/application/dimensions/create-dimension-value.ts — WBS 4.1b PART 2 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (golden slice:
// modules/wms/application/receive-inbound/approve-inbound.ts). Step 0 is the idempotency claim when
// input.idem is set; then the insert (entity_scope RLS WITH CHECK refuses a caller outside the
// entity, 42501; the (entity_id, dimension_type_id) composite FK refuses another entity's type,
// 23503; unique (entity_id, dimension_type_id, code) refuses a duplicate code, 23505 — typed errors
// for the last two are 4.1b part 3, R5), then `billing.dimension_value.created` to platform.outbox,
// then the audit row — all in the same transaction (doc 40 §B3). No role gate (R3): entity_scope
// RLS is the wall. A value is created active (D-190: the create body carries no isActive).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { MissingActorError } from '../../domain/dimensions/errors.js';
import { DIMENSION_VALUE_STATUS } from '../../domain/dimensions/machine.js';
import type { DimensionsDeps } from './ports.js';

const AUDIT_OPERATION_CREATE = 'create';
const DIMENSION_VALUES_AGGREGATE_TYPE = 'billing.dimension_values';
const CREATED_EVENT_TYPE: CatalogedEventType = 'billing.dimension_value.created';

export interface CreateDimensionValueInput {
  readonly entityId: string;
  readonly dimensionTypeId: string;
  readonly code: string;
  readonly name: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateDimensionValueResult {
  readonly id: string;
  readonly version: number;
}

export async function createDimensionValue(
  ctx: WithContextCtx,
  input: CreateDimensionValueInput,
  deps: DimensionsDeps,
): Promise<CreateDimensionValueResult> {
  if (!ctx.userId) throw new MissingActorError('CreateDimensionValue requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateDimensionValueResult>(ctx, input.idem, async (tx) => {
    const now = deps.clock.now();
    const created = await deps.repo.insertValue(tx, {
      entityId: input.entityId,
      dimensionTypeId: input.dimensionTypeId,
      code: input.code,
      name: input.name,
    });

    await writeOutboxEvent(tx, {
      entityId: input.entityId,
      aggregateType: DIMENSION_VALUES_AGGREGATE_TYPE,
      aggregateId: created.id,
      eventType: CREATED_EVENT_TYPE,
      payload: {
        dimensionValueId: created.id,
        dimensionTypeId: input.dimensionTypeId,
        code: input.code,
        status: DIMENSION_VALUE_STATUS.ACTIVE,
        version: created.version,
      },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      recordId: created.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        dimension_type_id: input.dimensionTypeId,
        code: input.code,
        name: input.name,
        is_active: true,
        version: created.version,
      },
      occurredAt: now,
    });

    return { id: created.id, version: created.version };
  });
}
