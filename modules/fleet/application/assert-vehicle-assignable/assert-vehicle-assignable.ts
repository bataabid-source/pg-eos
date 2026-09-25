// modules/fleet/application/assert-vehicle-assignable/assert-vehicle-assignable.ts — WBS 3.1.
//
// assertVehicleAssignable — a pure read-and-assert, ONE withContext(ctx, fn) read transaction
// (brief, second Contract section: "No Idempotency-Key — this is a pure read-and-assert, no write,
// no side effect" — so this uses plain withContext, never withIdempotentContext). Order:
// (1) review-round 2 finding 1: BEFORE trusting the document read, refuse a non-internal caller —
// `tms.vehicle_documents`' own `internal_only` RLS policy makes a non-internal session's SELECT
// silently return ZERO rows (no error), so `expiredDocumentsOf([], at)` would always be empty and
// the "hard gate" would trivially pass for every vehicle. This is not a new "is internal" business
// rule invented from nothing — the application layer is the only place that can catch a silent RLS
// drop on a read; register-vehicle's own write path needs no equivalent check because an RLS
// rejection on an INSERT fails loudly instead. Reuses register-vehicle's own
// VehicleDocumentAccessDeniedError (the one cross-use-case reuse the brief authorizes here) rather
// than inventing a third error class. (2) fetch the vehicle's own plateNo + its
// tms.vehicle_documents rows (infrastructure translates a missing/unreadable vehicleId to
// VehicleNotFoundError). (3) call the SAME `expiredDocumentsOf` pure function
// ../register-vehicle/invariants.ts exports (review-round 2 finding 2: the module's one comparison
// implementation), passing the CALLER's own `at` as `asOf` — this command never reads a wall clock
// itself (CLAUDE.md domain/ clock-injection rule; the brief: "the caller's own `at` governs, the
// command never reads the wall clock itself"). (4) on a non-empty result, throw
// VehicleNotAssignableError carrying plateNo + the expired documents. (5) otherwise resolve with no
// value.

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { expiredDocumentsOf } from '../../domain/register-vehicle/invariants.js';
import { VehicleDocumentAccessDeniedError } from '../../domain/register-vehicle/errors.js';
import { VehicleNotAssignableError } from '../../domain/assert-vehicle-assignable/errors.js';
import type { AssertVehicleAssignableDeps } from './ports.js';

export interface AssertVehicleAssignableInput {
  readonly vehicleId: string;
  readonly at: Date;
  readonly correlationId: string;
}

export async function assertVehicleAssignable(
  ctx: WithContextCtx,
  input: AssertVehicleAssignableInput,
  deps: AssertVehicleAssignableDeps,
): Promise<void> {
  if (!ctx.isInternal) {
    throw new VehicleDocumentAccessDeniedError(
      `caller session is not internal — tms.vehicle_documents' own internal_only RLS policy would ` +
        `silently return zero rows for this read, which would make the expired-document gate pass ` +
        `vacuously regardless of the vehicle's real document state; refused before reading. ` +
        `(Allowed: an internal caller session.)`,
    );
  }

  await withContext(ctx, async (tx) => {
    const vehicle = await deps.repo.findVehicleForAssignabilityCheck(tx, input.vehicleId);

    const expiredDocuments = expiredDocumentsOf(vehicle.documents, input.at);
    if (expiredDocuments.length === 0) return;

    throw new VehicleNotAssignableError(
      `vehicle ${JSON.stringify(vehicle.plateNo)} has ${expiredDocuments.length} expired document(s) as of ` +
        `${input.at.toISOString()} and cannot be assigned (doc 40 INV-C4-1). (Allowed: a vehicle whose ` +
        `every document's expiry_date is on or after the Kuwait calendar date of the given instant.)`,
      { plateNo: vehicle.plateNo, expiredDocuments },
    );
  });
}
