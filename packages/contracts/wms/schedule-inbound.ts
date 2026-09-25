// packages/contracts/wms/schedule-inbound.ts — WBS 2.9b (lane 2).
//
// Zod input schema for the schedule-inbound use case's ScheduleInbound command. Same discipline
// as packages/contracts/wms/receive-inbound.ts (THE GOLDEN SLICE): every id is a uuid,
// `performedBy` does NOT exist (the actor is ALWAYS `ctx.userId`), the command carries
// `expectedVersion` — a stale one -> StaleVersionError (409). `expectedAt` must be in the future
// relative to the injected clock — enforced at the domain layer
// (modules/wms/domain/schedule-inbound/invariants.ts's isFutureTimestamp), not at the contract
// boundary (the contract cannot see the clock). `vehicleType` is validated against migration
// 0023's closed list at the domain layer (isValidVehicleType); the DB CHECK
// (chk_inbound_orders_vehicle_type) is the belt-and-braces backstop — the contract itself accepts
// any non-empty string. The four logistics terms are caller-supplied only (D6 — no
// sales.contracts default wired this slice).
//
// docs/notes/slice-briefs/_slice-2.9b.brief.md D1.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// wms.inbound_orders.version starts at 1 (migration 0008: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);

export const ScheduleInboundInputSchema = z
  .object({
    orderId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
    expectedAt: z.iso.datetime(),
    dockCode: z.string().min(1).optional(),
    scheduleNote: z.string().min(1).optional(),
    handoverPoint: z.string().min(1).optional(),
    transportBy: z.string().min(1).optional(),
    vehicleType: z.string().min(1).optional(),
    labourBy: z.string().min(1).optional(),
    labourCount: z.number().int().min(0).optional(),
  })
  .meta({ id: 'ScheduleInboundInput' });

export type ScheduleInboundInput = z.infer<typeof ScheduleInboundInputSchema>;
