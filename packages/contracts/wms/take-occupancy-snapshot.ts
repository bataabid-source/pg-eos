// packages/contracts/wms/take-occupancy-snapshot.ts — WBS 2.14 (lane 2).
//
// Zod input schema for the take-occupancy-snapshot use case's one command (doc 40 line 260:
// TakeOccupancySnapshot). `warehouseId` is a uuid; `snapshotDate` is an optional `z.iso.date()`
// (zod v4) — the server defaults it to the injected Clock's own Asia/Kuwait business date when
// omitted (brief D6). `performedBy` does NOT exist on this schema: the actor is ALWAYS
// `ctx.userId`, never a caller-supplied field.
//
// Result schema: `{ warehouseId, snapshotDate, clientsSnapshotted, clientsInOverflow }` — a
// summary, not a per-client dump (brief "Contract" section — no screen consumes this yet, keep
// the response minimal per lean design).

import { z } from 'zod';

const UUID_ID = z.string().uuid();

export const TakeOccupancySnapshotInputSchema = z
  .object({
    warehouseId: UUID_ID,
    snapshotDate: z.iso.date().optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'TakeOccupancySnapshotInput' });

export type TakeOccupancySnapshotInput = z.infer<typeof TakeOccupancySnapshotInputSchema>;

export const TakeOccupancySnapshotResultSchema = z
  .object({
    warehouseId: UUID_ID,
    snapshotDate: z.iso.date(),
    clientsSnapshotted: z.number().int().min(0),
    clientsInOverflow: z.number().int().min(0),
  })
  .meta({ id: 'TakeOccupancySnapshotResult' });

export type TakeOccupancySnapshotResult = z.infer<typeof TakeOccupancySnapshotResultSchema>;
