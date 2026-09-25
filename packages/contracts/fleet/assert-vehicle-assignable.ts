// packages/contracts/fleet/assert-vehicle-assignable.ts — WBS 3.1.
//
// Zod input schema for the assert-vehicle-assignable use case's ONE command,
// AssertVehicleAssignable. Field shapes derive from tms.vehicles / tms.vehicle_documents
// (database/schema/01-Data-Model.sql:843-866) — never a column not on those tables (brief, second
// Contract section). `at` is caller-supplied, never read from a wall clock inside the command
// (CLAUDE.md domain/ clock-injection rule). No result schema — the command resolves with no value
// on success (brief: "Result: resolves with no value on success").
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

const UUID_ID = z.string().uuid();

export const AssertVehicleAssignableInputSchema = z
  .object({
    vehicleId: UUID_ID,
    // caller-supplied instant the gate is evaluated as of — never a wall clock read inside the
    // command (brief, second Contract section).
    at: z.iso.datetime(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'AssertVehicleAssignableInput' });

export type AssertVehicleAssignableInput = z.infer<typeof AssertVehicleAssignableInputSchema>;
