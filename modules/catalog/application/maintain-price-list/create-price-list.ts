// modules/catalog/application/maintain-price-list/create-price-list.ts — WBS 1.2, M03 catalog.
//
// ONE withIdempotentContext transaction (step 0 — packages/db/src/idempotency.ts — runs first
// when input.idem is set). No row is locked (a fresh insert): role gate, then the pure business
// invariants (at most one of segmentId/clientId; validTo/validFrom), then the insert (a unique
// (entity_id, code) violation is mapped to PriceListCodeTakenError), then the audit row, last.
// Slice brief Master decision 6.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertValidValidity } from '../../domain/maintain-price-list/invariants.js';
import { MissingActorError, RoleRequiredError, SegmentAndClientError } from '../../domain/maintain-price-list/errors.js';
import { PRICE_LIST_STATUS } from '../../domain/maintain-price-list/machine.js';
import type { MaintainPriceListDeps } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_CREATE = 'create';

export interface CreatePriceListInput {
  readonly entityId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly segmentId: string | null;
  /** Optional (default null) — a caller building the standard list for its entity may omit both
   *  segmentId and clientId entirely. */
  readonly clientId?: string | null | undefined;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly isInternal: boolean;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreatePriceListResult {
  readonly priceListId: string;
  readonly version: number;
}

export async function createPriceList(
  ctx: WithContextCtx,
  input: CreatePriceListInput,
  deps: MaintainPriceListDeps,
): Promise<CreatePriceListResult> {
  if (!ctx.userId) throw new MissingActorError('CreatePriceList requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreatePriceListResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`CreatePriceList requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    const clientId = input.clientId ?? null;
    if (input.segmentId !== null && clientId !== null) {
      throw new SegmentAndClientError(
        'CreatePriceList: at most one of segmentId/clientId may be set (neither means the ' +
          "entity's standard list) — Master decision 6.",
      );
    }
    assertValidValidity({ validFrom: input.validFrom, validTo: input.validTo });

    const created = await deps.repo.insertPriceList(tx, {
      entityId: input.entityId,
      code: input.code,
      nameAr: input.nameAr,
      segmentId: input.segmentId,
      clientId,
      validFrom: input.validFrom,
      validTo: input.validTo,
      isInternal: input.isInternal,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      target: 'list',
      recordId: created.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: PRICE_LIST_STATUS.DRAFT, version: created.version, code: input.code },
      occurredAt: deps.clock.now(),
    });

    return { priceListId: created.id, version: created.version };
  });
}
