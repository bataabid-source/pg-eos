// modules/catalog/application/maintain-price-list/expire-price-list.ts — WBS 1.2, M03 catalog.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) list-row lock + expectedVersion
// check, (2) role gate, (3) the machine's own legality check (via advancePriceList — active ->
// expired only; IllegalTransitionError otherwise, e.g. a draft list), (4) the unconditional
// version bump with status='expired' and valid_to set to today (the injected Clock) ONLY when
// valid_to is null or later than today — never moved earlier, (5) the audit row, last. No outbox
// event (Master decision 8 — nothing consumes it yet).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { PRICE_LIST_EVENTS, PRICE_LIST_STATUS, advancePriceList } from '../../domain/maintain-price-list/machine.js';
import { assertValidValidity } from '../../domain/maintain-price-list/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/maintain-price-list/errors.js';
import type { MaintainPriceListDeps, PriceListUpdateColumns } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_EXPIRE = 'expire';

export interface ExpirePriceListInput {
  readonly priceListId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ExpirePriceListResult {
  readonly version: number;
}

function isoDateOf(date: Date): string {
  const isoDate = date.toISOString().slice(0, 10);
  return isoDate;
}

export async function expirePriceList(
  ctx: WithContextCtx,
  input: ExpirePriceListInput,
  deps: MaintainPriceListDeps,
): Promise<ExpirePriceListResult> {
  if (!ctx.userId) throw new MissingActorError('ExpirePriceList requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ExpirePriceListResult>(ctx, input.idem, async (tx) => {
    const list = await deps.repo.getPriceListForUpdate(tx, input.priceListId);
    if (list.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ExpirePriceList: expectedVersion ${input.expectedVersion} no longer matches price list ` +
          `${input.priceListId}'s version ${list.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`ExpirePriceList requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    // no if on the status string — advancePriceList asks the machine and THROWS
    // IllegalTransitionError itself when EXPIRE is not legal from `list.status` (e.g. 'draft').
    advancePriceList(list.status, [PRICE_LIST_EVENTS.EXPIRE]);

    const today = isoDateOf(deps.clock.now());
    const shouldSetValidTo = list.validTo === null || list.validTo > today;
    const newValidTo = shouldSetValidTo ? today : list.validTo;

    // pg-reviewer fix round 1 (finding 4): invariants BEFORE any write — a list whose validFrom is
    // after today would otherwise write valid_to < valid_from silently.
    assertValidValidity({ validFrom: list.validFrom, validTo: newValidTo });

    const columns: PriceListUpdateColumns = shouldSetValidTo
      ? { status: PRICE_LIST_STATUS.EXPIRED, validTo: today }
      : { status: PRICE_LIST_STATUS.EXPIRED };
    const newVersion = await deps.repo.updatePriceList(tx, input.priceListId, columns);

    await deps.repo.writeAuditRow(tx, {
      entityId: list.entityId,
      target: 'list',
      recordId: input.priceListId,
      operation: AUDIT_OPERATION_EXPIRE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: PRICE_LIST_STATUS.EXPIRED, version: newVersion, validTo: columns.validTo ?? list.validTo },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion };
  });
}
