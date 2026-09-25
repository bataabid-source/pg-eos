// packages/contracts/wms/count-inventory.ts — WBS 2.13 (lane 2).
//
// Zod input schemas for the count-inventory use case's four commands (doc 40 line 260: StartCount,
// CountLocation, Recount, AdjustCount). Every id is a uuid; every quantity is a numeric(14,3)
// string, non-negative (same convention as ../receive-inbound.ts's NON_NEGATIVE_QUANTITY —
// verified against ./count-inventory.test.ts / handlers.test.ts, which round-trip a string like
// '7.000' through these schemas). `performedBy`/`entityId` do NOT exist on any schema: the actor
// is ALWAYS `ctx.userId`. D3 (brief): only `StartCountInputSchema` has no `expectedVersion` (a
// new count has no prior version to have read) NOR does `CountLocationInputSchema`/
// `RecountInputSchema` (D3 — guarded by the line's own state under a lock on the parent count
// row, never a client-visible version); `AdjustCountInputSchema` is the one schema that carries
// `expectedVersion`.
//
// D2 — the blind-count contract enforced at the response-schema layer, not just application
// discipline: `CountLocationResultSchema`/`RecountResultSchema` carry ONLY
// `{ lineId, recorded: true }` — never qtySystem/variance/recountQty/the original qtyCounted.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// numeric(14,3), non-negative (a count of 0 on-hand stock is legal).
const NON_NEGATIVE_QUANTITY = z.string().regex(/^\d{1,11}(?:\.\d{1,3})?$/);
// wms.inventory_counts.version starts at 1 (migration 0018: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
// wms.inventory_counts.count_type — free text per 01:804's own comment, no DB CHECK; doc 40's own
// three named values (brief Facts).
const COUNT_TYPE = z.enum(['full', 'cycle', 'spot']);

export const StartCountInputSchema = z
  .object({
    warehouseId: UUID_ID,
    countType: COUNT_TYPE,
    locationIds: z.array(UUID_ID).optional(),
    skuIds: z.array(UUID_ID).optional(),
    clientId: UUID_ID.optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'StartCountInput' });

export type StartCountInput = z.infer<typeof StartCountInputSchema>;

export const CountLocationInputSchema = z
  .object({
    lineId: UUID_ID,
    qtyCounted: NON_NEGATIVE_QUANTITY,
    correlationId: UUID_ID,
  })
  .meta({ id: 'CountLocationInput' });

export type CountLocationInput = z.infer<typeof CountLocationInputSchema>;

export const RecountInputSchema = z
  .object({
    lineId: UUID_ID,
    recountQty: NON_NEGATIVE_QUANTITY,
    correlationId: UUID_ID,
  })
  .meta({ id: 'RecountInput' });

export type RecountInput = z.infer<typeof RecountInputSchema>;

export const AdjustCountInputSchema = z
  .object({
    countId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'AdjustCountInput' });

export type AdjustCountInput = z.infer<typeof AdjustCountInputSchema>;

// D2 — the blind-count contract: ONLY these two keys, ever.
export const CountLocationResultSchema = z
  .object({
    lineId: UUID_ID,
    recorded: z.literal(true),
  })
  .meta({ id: 'CountLocationResult' });

export type CountLocationResult = z.infer<typeof CountLocationResultSchema>;

export const RecountResultSchema = z
  .object({
    lineId: UUID_ID,
    recorded: z.literal(true),
  })
  .meta({ id: 'RecountResult' });

export type RecountResult = z.infer<typeof RecountResultSchema>;
