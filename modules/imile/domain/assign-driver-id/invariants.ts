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

// WBS 3.12 part 2c-i — doc 40 INV-C4-1: this module's own copy of
// modules/hr/domain/register-employee/invariants.ts's `businessDateOf`/`assertDriverAssignable`
// (lines 29-36, 73-102 — the source of the replicated rule). A direct TypeScript import across
// `modules/*` fails lint (CLAUDE.md · ARCHITECTURE, eslint-plugin-boundaries), so this is the SAME
// business rule, re-expressed here, not reinvented. This module only ever needs the 'task' purpose
// (brief DEFAULT: assigning an iMile driver ID authorizes delivery TASKS, not a vehicle assignment —
// fleet's own, separate WBS 3.1 gate on tms.vehicle_documents is never called from here).

import {
  DriverDocumentExpiredError,
  DriverDocumentMissingError,
  EmployeeNotActiveError,
} from './errors.js';

/** hr.employee_documents.doc_type this gate reads for the 'task' purpose — hr's own
 *  `REQUIRED_DOC_TYPES.task` (modules/hr/domain/register-employee/invariants.ts:47-50) names only
 *  `'residency'`; this module never needs `'license'` (that is 'vehicle', fleet's own gate, brief
 *  DEFAULT). */
export const DOC_TYPE_RESIDENCY = 'residency';

/** database/schema/01-Data-Model.sql:8 — timestamps are stored UTC, DISPLAYED/business-computed as
 *  Asia/Kuwait. Same one-liner as hr's own `businessDateOf`
 *  (modules/hr/domain/register-employee/invariants.ts:29-36) — a two-line date-formatting utility,
 *  not itself a business rule, safe to duplicate without a cross-module import. The caller passes
 *  the resulting `today` string in; no Date is read inside this pure invariants file itself. */
export function businessDateOf(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuwait',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

const EMPLOYEE_STATUS_ACTIVE = 'active';

/**
 * doc 40 INV-C4-1, the hard gate — this module's own copy of hr's own `assertDriverAssignable`
 * (modules/hr/domain/register-employee/invariants.ts:73-102), replicated verbatim for the 'task'
 * purpose only (brief DEFAULT, no `purpose` parameter here — this module never needs 'vehicle'):
 * throws `EmployeeNotActiveError` iff `employee.status !== 'active'`; otherwise, for the one
 * required doc_type (`DOC_TYPE_RESIDENCY`), reads the row with the GREATEST `expiryDate` among
 * `documents` (same `reduce` tie-break hr's own gate uses): throws `DriverDocumentMissingError` iff
 * no row of that doc_type exists at all, else `DriverDocumentExpiredError` iff that latest row's
 * `expiryDate < today` (plain ISO string comparison, date-only — a document expiring exactly `today`
 * is NOT expired). Returns (no throw) iff the required doc_type has a latest row with
 * `expiryDate >= today`. No I/O, no Date/Math.random inside this function — `today` is already
 * computed by the caller (CLAUDE.md · AGENT CONSTRAINTS).
 */
export function assertDriverAssignable(
  employee: { readonly status: string },
  documents: readonly { readonly docType: string; readonly expiryDate: string }[],
  today: string,
): void {
  if (employee.status !== EMPLOYEE_STATUS_ACTIVE) {
    throw new EmployeeNotActiveError(
      `employee status "${employee.status}" is not "${EMPLOYEE_STATUS_ACTIVE}" (doc 40 INV-C4-1). ` +
        `(Allowed: only an active employee is assignable)`,
    );
  }

  const rows = documents.filter((doc) => doc.docType === DOC_TYPE_RESIDENCY);
  if (rows.length === 0) {
    throw new DriverDocumentMissingError(
      `no hr.employee_documents row of doc_type "${DOC_TYPE_RESIDENCY}" exists for this employee ` +
        `(doc 40 INV-C4-1). (Allowed: at least one row of doc_type "${DOC_TYPE_RESIDENCY}")`,
    );
  }
  const latest = rows.reduce((a, b) => (a.expiryDate >= b.expiryDate ? a : b));
  if (latest.expiryDate < today) {
    throw new DriverDocumentExpiredError(
      `the latest doc_type "${DOC_TYPE_RESIDENCY}" document expired on ${latest.expiryDate} ` +
        `(today: ${today}, doc 40 INV-C4-1). (Allowed: a renewal with expiry_date >= today)`,
    );
  }
}
