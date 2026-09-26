// packages/contracts/wms/process-outbound.ts — WBS 2.11 part 1.
//
// Zod input schemas for the process-outbound use case's part-1 commands: CreateOutbound,
// RunOutboundChecks, ApproveOutbound, CancelOutbound. `AllocateInputSchema`/
// `GeneratePickListInputSchema` are part 2's own additions to this file.
//
// Every id is a uuid; `expectedVersion` starts at 1 (`wms.outbound_orders.version int not null
// default 1` already exists — database/schema/13B-Schema-Reference-Consolidation.sql:164, no
// migration needed for this column, brief Master decision 9). `performedBy` does NOT exist on any
// schema — the actor is ALWAYS `ctx.userId`. `orderType` has no DB CHECK on
// `wms.outbound_orders.order_type` (known schema gap SCH-4, not fixed this slice) — enforced here
// at the application/contract level only, per the brief's four literal values.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
const ORDER_TYPE = z.enum(['standard', 'rush', 'transfer', 'return_to_client']);
const NON_EMPTY_STRING = z.string().min(1);

export const CreateOutboundInputSchema = z
  .object({
    entityId: UUID_ID,
    clientId: UUID_ID,
    warehouseId: UUID_ID,
    contractId: UUID_ID.optional(),
    orderType: ORDER_TYPE,
    requiredBy: z.iso.datetime().optional(),
    shipToName: z.string().optional(),
    shipToPhone: z.string().optional(),
    shipToAddress: z.string().optional(),
    shipToArea: z.string().optional(),
    clientRef: z.string().optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'CreateOutboundInput' });

export type CreateOutboundInput = z.infer<typeof CreateOutboundInputSchema>;

export const RunOutboundChecksInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'RunOutboundChecksInput' });

export type RunOutboundChecksInput = z.infer<typeof RunOutboundChecksInputSchema>;

export const ApproveOutboundInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ApproveOutboundInput' });

export type ApproveOutboundInput = z.infer<typeof ApproveOutboundInputSchema>;

export const CancelOutboundInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
    reason: NON_EMPTY_STRING,
  })
  .meta({ id: 'CancelOutboundInput' });

export type CancelOutboundInput = z.infer<typeof CancelOutboundInputSchema>;

// --- WBS 2.11 part 2: Allocate (FEFO/FIFO), GeneratePickList (shortest path) ---------------------

export const AllocateInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'AllocateInput' });

export type AllocateInput = z.infer<typeof AllocateInputSchema>;

// GeneratePickList is read-only (brief Master decision 5) — no expectedVersion (no optimistic
// lock on a command that never writes).
export const GeneratePickListInputSchema = z
  .object({
    orderId: UUID_ID,
    correlationId: UUID_ID,
  })
  .meta({ id: 'GeneratePickListInput' });

export type GeneratePickListInput = z.infer<typeof GeneratePickListInputSchema>;

// --- WBS 2.12 part 1: PickLine, CheckOrder (checker != picker) -----------------------------------

export const PickLineInputSchema = z
  .object({
    orderId: UUID_ID,
    lineId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    qtyActual: z.string().regex(/^\d+(\.\d{1,3})?$/),
    varianceReason: z.string().optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'PickLineInput' });

export type PickLineInput = z.infer<typeof PickLineInputSchema>;

export const CheckOrderInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'CheckOrderInput' });

export type CheckOrderInput = z.infer<typeof CheckOrderInputSchema>;
