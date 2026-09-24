// modules/catalog/application/maintain-price-list/activate-price-list.ts — WBS 1.2, M03 catalog.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) list-row lock + expectedVersion
// check, (2) role gate, (3) EmptyPriceListError gate (>= 1 line), (4) the tier-ladder check over
// the WHOLE list (Master decision 5), (5) the machine's own legality check (via advancePriceList,
// never an if on the status string), (6) the unconditional version bump with status='active', (7)
// ONE outbox event ('catalog.price_list.activated') in the SAME transaction, (8) the audit row,
// sharing the SAME correlation_id as the outbox row (G9) — slice brief Master decision 7.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent } from '@pg-eos/events';

import { validateTierLadder, type TierLadderLine } from '../../domain/maintain-price-list/tier-ladder.js';
import { PRICE_LIST_EVENTS, PRICE_LIST_STATUS, advancePriceList } from '../../domain/maintain-price-list/machine.js';
import { EmptyPriceListError, MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/maintain-price-list/errors.js';
import type { MaintainPriceListDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_ACTIVATE = 'activate';
// slice brief Master decision 7: publishing an own-module event needs no packages/events/catalog.ts
// entry (that file governs cross-module CONSUMPTION, and is frozen for this lane); the event type
// is a plain string — writeOutboxEvent's own input type (packages/events/src/outbox.ts) accepts
// any string, not only a CatalogedEventType.
const PRICE_LIST_ACTIVATED_EVENT_TYPE = 'catalog.price_list.activated';
const PRICE_LISTS_AGGREGATE_TYPE = 'catalog.price_lists';

export interface ActivatePriceListInput {
  readonly priceListId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ActivatePriceListResult {
  readonly version: number;
}

export async function activatePriceList(
  ctx: WithContextCtx,
  input: ActivatePriceListInput,
  deps: MaintainPriceListDeps,
): Promise<ActivatePriceListResult> {
  if (!ctx.userId) throw new MissingActorError('ActivatePriceList requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ActivatePriceListResult>(ctx, input.idem, async (tx) => {
    const list = await deps.repo.getPriceListForUpdate(tx, input.priceListId);
    if (list.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ActivatePriceList: expectedVersion ${input.expectedVersion} no longer matches price list ` +
          `${input.priceListId}'s version ${list.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`ActivatePriceList requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    const lines = await deps.repo.getAllLines(tx, input.priceListId);
    if (lines.length === 0) {
      throw new EmptyPriceListError(
        `price list ${input.priceListId} has zero lines — ActivatePriceList requires >= 1 (Master ` +
          'decision 7).',
      );
    }

    const ladderLines: TierLadderLine[] = lines.map((line) => ({
      serviceId: line.serviceId,
      tierFrom: line.tierFrom,
      tierTo: line.tierTo,
      freeUnits: line.freeUnits,
    }));
    validateTierLadder(ladderLines);

    // no if on the status string — advancePriceList asks the machine and THROWS
    // IllegalTransitionError itself when ACTIVATE is not legal from `list.status`.
    advancePriceList(list.status, [PRICE_LIST_EVENTS.ACTIVATE]);

    const newVersion = await deps.repo.updatePriceList(tx, input.priceListId, { status: PRICE_LIST_STATUS.ACTIVE });

    await writeOutboxEvent(tx, {
      entityId: list.entityId,
      aggregateType: PRICE_LISTS_AGGREGATE_TYPE,
      aggregateId: input.priceListId,
      eventType: PRICE_LIST_ACTIVATED_EVENT_TYPE,
      payload: {
        priceListId: input.priceListId,
        entityId: list.entityId,
        code: list.code,
        segmentId: list.segmentId,
        clientId: list.clientId,
        validFrom: list.validFrom,
        validTo: list.validTo,
        lineCount: lines.length,
      },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: list.entityId,
      target: 'list',
      recordId: input.priceListId,
      operation: AUDIT_OPERATION_ACTIVATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: PRICE_LIST_STATUS.ACTIVE, version: newVersion, lineCount: lines.length },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
