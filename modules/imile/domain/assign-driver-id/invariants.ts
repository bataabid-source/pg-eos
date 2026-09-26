// modules/imile/domain/assign-driver-id/invariants.ts — WBS 3.12.
//
// domain/ layer: pure functions only — no I/O, no Date.now()/new Date(), no Math.random()
// (CLAUDE.md · AGENT CONSTRAINTS). The application layer
// (../../application/assign-driver-id/assign-driver-id.ts) validates its own input shape with
// this, mirroring this module's own evaluate-dtl-problem/invariants.ts `isG0Complete` discipline
// ("malformed input is data, not a crash").
//
// This command performs exactly ONE transition (available -> assigned) guarded by a precondition
// check, not a dispatched set of transitions — no state-machine is built here (brief, Deliver).

// Versions 1-8 (RFC 4122 v1-v5 plus the newer v6-v8), variant bits 8/9/a/b — matches the range
// fast-check's own `fc.uuid()` generates by default (this suite's own property-test arbitrary),
// same broad-version acceptance this module's own contract schemas already apply via z.string().uuid().
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuidString(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** brief, Contract: `{ driverIdRef: uuid, employeeId: uuid, correlationId: uuid }`. Never throws
 *  for ANY input, including primitives, null, arrays and garbage objects — true only when all
 *  three fields are present and well-formed UUID strings. */
export function isValidAssignDriverIdInput(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;

  return (
    isUuidString(raw['driverIdRef']) &&
    isUuidString(raw['employeeId']) &&
    isUuidString(raw['correlationId'])
  );
}

/** The live `chk_driver_ids_status` CHECK (13B-Schema-Reference-Consolidation.sql:2513-2516) allows
 *  only 'available' / 'assigned' / 'suspended'. This command performs exactly ONE transition
 *  (available -> assigned) guarded by this precondition check — true only for 'available', the one
 *  status a driver ID may be assigned FROM (round-2 fix round, finding 4: this rule previously lived
 *  only as an inline check in application/assign-driver-id/assign-driver-id.ts; moved here so the
 *  business rule lives in domain/, not application/). */
export function isAssignableStatus(status: string): boolean {
  const ASSIGNABLE_STATUS = 'available';
  return status === ASSIGNABLE_STATUS;
}
