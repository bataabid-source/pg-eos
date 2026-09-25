// packages/contracts/wms/manage-space.ts — WBS 2.15 (lane 2).
//
// Zod input schemas for the manage-space use case's two commands (doc 40 line 260: AllocateSpace,
// ReserveSpace — docs/notes/slice-briefs/_slice-2.15.brief.md, "Contract" section). Neither schema
// carries `performedBy` (the actor is ALWAYS `ctx.userId`) nor `expectedVersion` (D1: neither
// `wms.space_allocations` nor `wms.space_reservations` has a version column — both commands only
// ever INSERT a fresh row at status='active'). `entityId` is never caller-supplied either — it is
// resolved by the application layer from the request's own `blockId` (`select entity_id from
// wms.space_blocks where id = $1 for update`), never from `ctx.entityId` (round-1 review
// correction — see docs/notes/slice-briefs/_slice-2.15.brief.md Facts/D3/D4).

import { z } from 'zod';

const UUID_ID = z.string().uuid();
const ALLOC_TYPE = z.enum(['dedicated', 'shared', 'overflow']);
const SPACE_UOM = z.enum(['pallet', 'sqm', 'cbm']);
const RESERVATION_REASON = z.enum(['quote_pending', 'incoming_client', 'seasonal_peak', 'internal']);

export const AllocateSpaceInputSchema = z
  .object({
    contractId: UUID_ID,
    clientId: UUID_ID,
    blockId: UUID_ID,
    allocType: ALLOC_TYPE.optional(),
    qty: z.number().positive(),
    uom: SPACE_UOM,
    serviceId: UUID_ID.optional(),
    validFrom: z.iso.date(),
    validTo: z.iso.date().optional(),
    minChargeApplies: z.boolean().optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'AllocateSpaceInput' });

export type AllocateSpaceInput = z.infer<typeof AllocateSpaceInputSchema>;

export const ReserveSpaceInputSchema = z
  .object({
    blockId: UUID_ID,
    clientId: UUID_ID.optional(),
    quoteId: UUID_ID.optional(),
    opportunityId: UUID_ID.optional(),
    qty: z.number().positive(),
    uom: SPACE_UOM,
    reservedFrom: z.iso.date(),
    expiresAt: z.iso.date(),
    reason: RESERVATION_REASON,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ReserveSpaceInput' });

export type ReserveSpaceInput = z.infer<typeof ReserveSpaceInputSchema>;
