// modules/billing/application/dimensions/deactivate-dimension-value.ts — WBS 4.1b PART 2 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (golden slice:
// modules/wms/application/receive-inbound/approve-inbound.ts). Lock order
// (../../infrastructure/dimensions/repository.ts header): (0) the idempotency claim when input.idem
// is set, (1) value-row lock + expectedVersion check, (2) the machine's legality check (via
// advanceDimensionValueStatus, never an if on is_active), (3) outbox, (4) the version bump,
// (5) the audit row, last. A replay with the same key returns the first result without re-running
// (so it never meets its own bumped version). A caller outside the value's entity sees no row (RLS)
// -> DimensionValueNotFoundError. No role gate (R3). Existing tags are untouched: deactivation only
// makes billing.assert_dimension_value() refuse NEW tags (migration 0038).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { MissingActorError, StaleVersionError } from '../../domain/dimensions/errors.js';
import { DIMENSION_VALUE_EVENTS, advanceDimensionValueStatus } from '../../domain/dimensions/machine.js';
import type { DimensionsDeps } from './ports.js';

const AUDIT_OPERATION_DEACTIVATE = 'deactivate';
const DIMENSION_VALUES_AGGREGATE_TYPE = 'billing.dimension_values';
const DEACTIVATED_EVENT_TYPE: CatalogedEventType = 'billing.dimension_value.deactivated';

export interface DeactivateDimensionValueInput {
  readonly dimensionValueId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface DeactivateDimensionValueResult {
  readonly version: number;
}

export async function deactivateDimensionValue(
  ctx: WithContextCtx,
  input: DeactivateDimensionValueInput,
  deps: DimensionsDeps,
): Promise<DeactivateDimensionValueResult> {
  if (!ctx.userId) throw new MissingActorError('DeactivateDimensionValue requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<DeactivateDimensionValueResult>(ctx, input.idem, async (tx) => {
    const value = await deps.repo.getValueForUpdate(tx, input.dimensionValueId);
    if (value.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `DeactivateDimensionValue: expectedVersion ${input.expectedVersion} no longer matches value ` +
          `${input.dimensionValueId}'s version ${value.version} (optimistic lock).`,
        input.expectedVersion,
        value.version,
      );
    }

    // No if on is_active — the machine THROWS IllegalDimensionValueTransitionError itself when
    // DEACTIVATE is not legal from the value's current status.
    const newStatus = advanceDimensionValueStatus(value.status, [DIMENSION_VALUE_EVENTS.DEACTIVATE]);
    const now = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: value.entityId,
      aggregateType: DIMENSION_VALUES_AGGREGATE_TYPE,
      aggregateId: input.dimensionValueId,
      eventType: DEACTIVATED_EVENT_TYPE,
      payload: { dimensionValueId: input.dimensionValueId, dimensionTypeId: value.dimensionTypeId, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    const newVersion = await deps.repo.updateValueStatus(tx, input.dimensionValueId, newStatus);

    await deps.repo.writeAuditRow(tx, {
      entityId: value.entityId,
      recordId: input.dimensionValueId,
      operation: AUDIT_OPERATION_DEACTIVATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { is_active: false, version: newVersion },
      occurredAt: now,
    });

    return { version: newVersion };
  });
}
