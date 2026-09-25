// modules/wms/application/process-outbound/generate-pick-list.ts — WBS 2.11 part 2 (brief Master
// decision 3).
//
// Read-only: no row lock (getOrderForRead, not getOrderForUpdate), no Idempotency-Key, no state
// change, no outbox event, no audit row (brief Master decision 5). Legal only from
// 'allocated'/'partially_allocated' — IllegalTransitionError otherwise. Every allocated
// `order_lines` row (`location_id is not null`) joined to its location's `position_no`, ordered
// ascending (the shortest-path proxy 2.9/2.10's own SuggestLocation already uses — brief Scope),
// ties broken by `line_no`; sorted server-side by the repository's own ORDER BY
// (../../infrastructure/process-outbound/repository.ts's `getAllocatedPickListLines`), never
// re-ordered here.

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { OUTBOUND_ORDER_STATUS } from '../../domain/process-outbound/machine.js';
import { IllegalTransitionError, MissingActorError } from '../../domain/process-outbound/errors.js';
import type { PickListLineRow, ProcessOutboundDeps } from './ports.js';

const PICK_LIST_LEGAL_STATUSES: ReadonlySet<string> = new Set([
  OUTBOUND_ORDER_STATUS.ALLOCATED,
  OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED,
]);

export interface GeneratePickListInput {
  readonly orderId: string;
  readonly correlationId: string;
}

export interface GeneratePickListResult {
  readonly lines: readonly PickListLineRow[];
}

export async function generatePickList(
  ctx: WithContextCtx,
  input: GeneratePickListInput,
  deps: ProcessOutboundDeps,
): Promise<GeneratePickListResult> {
  if (!ctx.userId) throw new MissingActorError('GeneratePickList requires ctx.userId.');

  return withContext(ctx, async (tx) => {
    const order = await deps.repo.getOrderForRead(tx, input.orderId);
    if (!PICK_LIST_LEGAL_STATUSES.has(order.status)) {
      throw new IllegalTransitionError(
        `GeneratePickList is illegal from outbound-order status "${order.status}" (allowed only ` +
          `from "allocated"/"partially_allocated").`,
      );
    }

    const lines = await deps.repo.getAllocatedPickListLines(tx, input.orderId);
    return { lines };
  });
}
