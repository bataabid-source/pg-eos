// packages/contracts/fleet/register-vehicle.ts — WBS 3.1.
//
// Zod input/result schema for the register-vehicle use case's ONE command, RegisterVehicle.
// Field shapes derive from tms.vehicles / tms.vehicle_documents (database/schema/
// 01-Data-Model.sql:843-866) — never a column not on those tables (brief, Contract line).
// `entityId` and `actorId` are NEVER caller-supplied fields — they come from `ctx` only, same
// discipline as every prior slice's own entity-scoped insert command. `status`/`ownership` are not
// settable beyond what their own column defaults already are — this schema carries no `status`
// field at all (brief, Contract line: "status stays at its own column default").
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// tms.vehicles.year int — no fractional part.
const YEAR = z.number().int().nullable();
// tms.vehicles.capacity_kg numeric(10,2) / capacity_cbm numeric(10,3) — decimal. pg-reviewer round
// 1, Finding 6: a non-negative restriction has no source in 01/13/13B/019/40 (01-Data-Model.sql:
// 843-866 gives no CHECK on either column) — removed; accepts whatever the numeric column itself
// accepts, same as every other unconstrained numeric field in this contract.
const CAPACITY = z.number().nullable();
// tms.vehicle_documents.alert_days_before int not null default 30 — the caller always supplies a
// value explicitly (the DB column default is never relied on for THIS field, unlike status).
// pg-reviewer round 1, Finding 6: no non-negative restriction has a source in 01/13/13B/019/40 —
// removed, same as CAPACITY above.
const ALERT_DAYS_BEFORE = z.number().int();

const RegisterVehicleDocumentInputSchema = z.object({
  // tms.vehicle_documents.doc_type text not null — registration · insurance · permit · inspection.
  docType: z.string().min(1),
  docNo: z.string().nullable(),
  issueDate: z.iso.date().nullable(),
  // tms.vehicle_documents.expiry_date date not null — required, never optional (brief Contract line).
  expiryDate: z.iso.date(),
  fileUrl: z.string().nullable(),
  alertDaysBefore: ALERT_DAYS_BEFORE,
});

export type RegisterVehicleDocumentInput = z.infer<typeof RegisterVehicleDocumentInputSchema>;

export const RegisterVehicleInputSchema = z
  .object({
    // tms.vehicles.plate_no text not null unique.
    plateNo: z.string().min(1),
    make: z.string().nullable(),
    model: z.string().nullable(),
    year: YEAR,
    // tms.vehicles.vehicle_type text not null — van · pickup · truck_3t · truck_7t · refrigerated
    // · motorcycle.
    vehicleType: z.string().min(1),
    capacityKg: CAPACITY,
    capacityCbm: CAPACITY,
    isRefrigerated: z.boolean(),
    // tms.vehicles.ownership text not null default 'owned' — owned · leased · subcontracted.
    ownership: z.string().min(1),
    assignedClientId: UUID_ID.nullable(),
    documents: z.array(RegisterVehicleDocumentInputSchema),
    correlationId: UUID_ID,
  })
  .meta({ id: 'RegisterVehicleInput' });

export type RegisterVehicleInput = z.infer<typeof RegisterVehicleInputSchema>;

export const RegisterVehicleResultSchema = z
  .object({
    id: UUID_ID,
    documentIds: z.array(UUID_ID),
    // computed once from the documents just inserted (doc 40 INV-C4-1's vehicle half) — never a
    // stored column (brief: "canBeAssigned is computed ONCE ... it is NOT a stored column").
    canBeAssigned: z.boolean(),
  })
  .meta({ id: 'RegisterVehicleResult' });

export type RegisterVehicleResult = z.infer<typeof RegisterVehicleResultSchema>;
