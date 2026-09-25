// modules/fleet/domain/assert-vehicle-assignable/errors.ts — WBS 3.1.
//
// Typed errors for the assert-vehicle-assignable use case. This file does NOT import
// ../register-vehicle/errors.ts for its OWN classes below — D-179 use-case isolation, each use
// case owns its own errors.ts. The two legitimate cross-use-case reuses this brief authorizes are:
// the pure predicate `expiredDocumentsOf` from ../register-vehicle/invariants.ts (the module's one
// comparison implementation, never reimplemented here) and register-vehicle's own
// `VehicleDocumentAccessDeniedError` class (reused as-is by
// ../../application/assert-vehicle-assignable/assert-vehicle-assignable.ts for the fail-closed
// `ctx.isInternal` check) — never a second implementation of either, and never added to this file.
//
// Every class sets `name` explicitly (CLAUDE.md · AGENT CONSTRAINTS) — an `Error` subclass does NOT
// get its constructor name for free at runtime.

/** Thrown when `expiredDocumentsOf` (register-vehicle's own invariants.ts) finds at least one
 *  expired document as of the caller's own `at` — brief, second Contract section (Master design
 *  correction). Carries structured params for the i18n key `fleet.vehicle.notAssignable` —
 *  `plateNo` and `expiredDocuments` are direct instance properties (never a hardcoded interpolated
 *  message string is the source of truth), same discipline as every prior slice's typed-error
 *  params. Review-round 2 finding 5: `i18nKey` is a `readonly` instance property (same pattern as
 *  modules/wms/domain/process-outbound/errors.ts's OutboundCheckError-derived classes) so the api/
 *  layer's Problem-details response body can surface it, not just the developer-facing `message`. */
export class VehicleNotAssignableError extends Error {
  readonly i18nKey = 'fleet.vehicle.notAssignable';
  readonly plateNo: string;
  readonly expiredDocuments: ReadonlyArray<{ readonly docType: string; readonly expiryDate: string }>;

  constructor(
    message: string,
    params: {
      readonly plateNo: string;
      readonly expiredDocuments: ReadonlyArray<{ readonly docType: string; readonly expiryDate: string }>;
    },
  ) {
    super(message);
    this.name = 'VehicleNotAssignableError';
    this.plateNo = params.plateNo;
    this.expiredDocuments = params.expiredDocuments;
  }
}

/** A typed `VehicleNotFoundError` mapped to 404 (see ../../api/assert-vehicle-assignable/handlers.ts)
 *  when the given vehicleId does not resolve to a tms.vehicles row this caller can read (its own
 *  entity_scope RLS policy included — a row outside the caller's scope is indistinguishable from a
 *  row that does not exist, same discipline as every other RLS-scoped read in this codebase). */
export class VehicleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VehicleNotFoundError';
  }
}
