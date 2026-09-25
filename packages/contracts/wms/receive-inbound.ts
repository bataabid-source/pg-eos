// packages/contracts/wms/receive-inbound.ts — WBS 2.9, THE GOLDEN SLICE.
//
// Zod input schemas for the receive-inbound use case's six commands. Every id is a uuid; every
// quantity is a numeric(14,3) string, non-negative (a fully-short receipt, qtyActual=0
// with a varianceReason, is legal — never negative). `expiryDate` is `z.iso.date()` (zod v4).
// `performedBy` does NOT exist on any schema: the actor is ALWAYS `ctx.userId`, never a
// caller-supplied field. Every order-mutating command carries `expectedVersion` — the
// optimistic-lock token the caller read most recently; a stale one -> StaleVersionError (409).
//
// SCR-WMS-INB-01 §4 (migration 0010_M_idempotency-keys-variance-photo.sql): `wms.order_lines`
// now carries `variance_photo_url`/`variance_photo_sha256`, so ReceiveLineInputSchema accepts
// `variancePhotoUrl`/`variancePhotoSha256` — both or neither (`.refine` below), sha256 hex
// validated at the contract boundary; whether a photo may accompany THIS receipt (only on a
// variance) is a domain invariant
// (modules/wms/domain/receive-inbound/invariants.ts's assertVariancePhotoRequiresVariance), not a
// contract-level rule.
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// numeric(14,3). qtyActual may be 0 (a fully-short receipt with a varianceReason); every other
// quantity is strictly positive.
const NON_NEGATIVE_QUANTITY = z.string().regex(/^\d{1,11}(?:\.\d{1,3})?$/);
const POSITIVE_QUANTITY = NON_NEGATIVE_QUANTITY.refine((value) => Number(value) > 0, {
  message: 'must be greater than 0',
});
// wms.inbound_orders.version starts at 1 (migration 0008: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
// migration 0010: `variance_photo_sha256 text check (variance_photo_sha256 ~ '^[0-9a-f]{64}$')`.
const SHA256_HEX = z.string().regex(/^[0-9a-f]{64}$/);

// WBS 2.9b (D2, migration 0023): optional appointment slot on ApproveInbound — when `expectedAt`
// is present, ApproveInbound also writes the ScheduleInbound-style columns and emits
// `wms.inbound.scheduled` alongside `wms.inbound.approved`; the four logistics terms are
// caller-supplied only (D6 — no sales.contracts default wired this slice). `vehicleType` is
// validated against migration 0023's closed list at the domain layer
// (modules/wms/domain/schedule-inbound/invariants.ts's isValidVehicleType), the DB CHECK is the
// belt-and-braces backstop — the contract itself accepts any non-empty string, same discipline
// ScheduleInboundInputSchema below uses.
export const ApproveInboundInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
    expectedAt: z.iso.datetime().optional(),
    dockCode: z.string().min(1).optional(),
    handoverPoint: z.string().min(1).optional(),
    transportBy: z.string().min(1).optional(),
    vehicleType: z.string().min(1).optional(),
    labourBy: z.string().min(1).optional(),
    labourCount: z.number().int().min(0).optional(),
  })
  .meta({ id: 'ApproveInboundInput' });

export type ApproveInboundInput = z.infer<typeof ApproveInboundInputSchema>;

export const ReceiveLineInputSchema = z
  .object({
    orderId: UUID_ID,
    lineId: UUID_ID,
    qtyActual: NON_NEGATIVE_QUANTITY,
    batchNo: z.string().optional(),
    expiryDate: z.iso.date().optional(),
    varianceReason: z.string().optional(),
    variancePhotoUrl: z.string().min(1).optional(),
    variancePhotoSha256: SHA256_HEX.optional(),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .refine((value) => (value.variancePhotoUrl === undefined) === (value.variancePhotoSha256 === undefined), {
    message: 'variancePhotoUrl and variancePhotoSha256 must both be present or both absent',
    path: ['variancePhotoSha256'],
  })
  .meta({ id: 'ReceiveLineInput' });

export type ReceiveLineInput = z.infer<typeof ReceiveLineInputSchema>;

export const SuggestLocationInputSchema = z
  .object({
    skuId: UUID_ID,
    qty: POSITIVE_QUANTITY,
    warehouseId: UUID_ID,
  })
  .meta({ id: 'SuggestLocationInput' });

export type SuggestLocationInput = z.infer<typeof SuggestLocationInputSchema>;

export const ConfirmPutawayInputSchema = z
  .object({
    orderId: UUID_ID,
    lineId: UUID_ID,
    toLocationId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ConfirmPutawayInput' });

export type ConfirmPutawayInput = z.infer<typeof ConfirmPutawayInputSchema>;

export const CloseInboundInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'CloseInboundInput' });

export type CloseInboundInput = z.infer<typeof CloseInboundInputSchema>;

// WBS 2.9b (D3, migration 0023): `reason` renamed `cancelReason`, made MANDATORY (min length 1) —
// persisted to the new wms.inbound_orders.cancel_reason column and carried by wms.inbound.cancelled.
export const CancelInboundInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
    cancelReason: z.string().min(1),
  })
  .meta({ id: 'CancelInboundInput' });

export type CancelInboundInput = z.infer<typeof CancelInboundInputSchema>;
