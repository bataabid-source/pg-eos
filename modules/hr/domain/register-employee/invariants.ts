// modules/hr/domain/register-employee/invariants.ts — WBS 3.3.
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/register-employee/{record-employee-document,check-driver-assignable}.ts)
// calls these BEFORE any DB write; a failed invariant throws a typed error from ./errors.ts.
// pg-tester's property tests (../../tests/register-employee/invariants.property.test.ts) exercise
// these functions directly (P1, P2).

import { EMPLOYEE_STATUS } from './machine.js';
import {
  DocumentDatesInvalidError,
  DocumentTypeInvalidError,
  DriverDocumentExpiredError,
  DriverDocumentMissingError,
  EmployeeCodeFormatInvalidError,
  EmployeeNotActiveError,
} from './errors.js';

/** database/schema/01-Data-Model.sql:8 — "التوقيت: timestamptz (UTC مخزَّن، Asia/Kuwait معروض)"
 *  (timestamps: timestamptz, stored UTC, DISPLAYED Asia/Kuwait). Every business "today" this use
 *  case computes (the driver-document expiry gate, ChangeEmployeeStatus's own end_date) is the
 *  Kuwait calendar date, never the raw UTC date — pg-reviewer FAIL round 1, Finding 1. */
export const BUSINESS_TIME_ZONE = 'Asia/Kuwait' as const;

/** Pure: the Kuwait (business) calendar date of `instant`, as ISO `YYYY-MM-DD` — `instant` is
 *  always the injected Clock's own `now()` return value (no `new Date()` in domain/ —
 *  CLAUDE.md · AGENT CONSTRAINTS). `en-CA` is the shortest built-in Intl locale that formats as
 *  `YYYY-MM-DD` directly, so no further string surgery is needed. */
export function businessDateOf(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** doc 40 §C4/§C7, bp06 §4.3: the two purposes CheckDriverAssignable's hard gate is called for. */
export type DriverAssignmentPurpose = 'task' | 'vehicle';

/** hr.employee_documents.doc_type values this gate reads (brief D4) — 01-Data-Model.sql:1303
 *  names five doc_type values in total; the gate only ever requires these two. */
const DOC_TYPE_RESIDENCY = 'residency';
const DOC_TYPE_LICENSE = 'license';

/** brief D4: required('task') = [residency]; required('vehicle') = [residency, license]. */
const REQUIRED_DOC_TYPES: Readonly<Record<DriverAssignmentPurpose, readonly string[]>> = {
  task: [DOC_TYPE_RESIDENCY],
  vehicle: [DOC_TYPE_RESIDENCY, DOC_TYPE_LICENSE],
};

/** P1: `doc.expiryDate < today` — plain ISO (`YYYY-MM-DD`) string comparison, date-only, no
 *  time-of-day effect. bp06 §4.3 KPI: `expiry_date < current_date` — a document expiring exactly
 *  `today` is NOT expired (valid through the expiry day). */
export function isDocumentExpired(doc: { readonly expiryDate: string }, today: string): boolean {
  return doc.expiryDate < today;
}

/** brief D4 — the required doc_type list for a CheckDriverAssignable purpose. */
export function requiredDocTypesFor(purpose: DriverAssignmentPurpose): readonly string[] {
  return REQUIRED_DOC_TYPES[purpose];
}

/**
 * doc 40 INV-C4-1, the hard gate: throws EmployeeNotActiveError iff `employee.status !== 'active'`
 * (brief D5); otherwise, for every doc_type `requiredDocTypesFor(purpose)` names, reads the row
 * with the GREATEST expiryDate among `docs` (brief D3 — a renewal is a new row, the gate reads the
 * latest): throws DriverDocumentMissingError iff no row of that doc_type exists at all (a missing
 * document blocks like an expired one — the gate cannot prove validity), else
 * DriverDocumentExpiredError iff that latest row `isDocumentExpired`. Returns (no throw) iff every
 * required doc_type has a latest row with `expiryDate >= today`. P2.
 */
export function assertDriverAssignable(
  employee: { readonly status: string },
  docs: readonly { readonly docType: string; readonly expiryDate: string }[],
  purpose: DriverAssignmentPurpose,
  today: string,
): void {
  if (employee.status !== EMPLOYEE_STATUS.ACTIVE) {
    throw new EmployeeNotActiveError(
      `employee status "${employee.status}" is not "${EMPLOYEE_STATUS.ACTIVE}" (doc 40 INV-C4-1, brief D5). ` +
        `(Allowed: only an active employee is assignable)`,
    );
  }

  for (const docType of requiredDocTypesFor(purpose)) {
    const rows = docs.filter((doc) => doc.docType === docType);
    if (rows.length === 0) {
      throw new DriverDocumentMissingError(
        `no hr.employee_documents row of doc_type "${docType}" exists for this employee ` +
          `(doc 40 INV-C4-1, purpose "${purpose}"). (Allowed: at least one row of doc_type "${docType}")`,
      );
    }
    const latest = rows.reduce((a, b) => (a.expiryDate >= b.expiryDate ? a : b));
    if (isDocumentExpired(latest, today)) {
      throw new DriverDocumentExpiredError(
        `the latest doc_type "${docType}" document expired on ${latest.expiryDate} (today: ${today}, ` +
          `doc 40 INV-C4-1, purpose "${purpose}"). (Allowed: a renewal with expiry_date >= today)`,
      );
    }
  }
}

/** brief "issue_date after expiry_date is rejected": RecordEmployeeDocument's own issueDate, when
 *  supplied, must not be later than its own expiryDate. Thrown BEFORE any DB write. */
export function assertDocumentDatesValid(issueDate: string | null, expiryDate: string): void {
  if (issueDate !== null && issueDate > expiryDate) {
    throw new DocumentDatesInvalidError(
      `issueDate (${issueDate}) is after expiryDate (${expiryDate}). (Allowed: issueDate <= expiryDate)`,
    );
  }
}

/** SCR-HR-EMP-01 §1 row 2, copied verbatim from 01-Data-Model.sql:1303's column comment (never
 *  invented) — the five hr.employee_documents.doc_type values, mirroring the DB's
 *  `chk_employee_documents_doc_type` (migration 0029). */
const VALID_DOC_TYPES = ['residency', 'passport', 'license', 'health_card', 'contract'] as const;

/** SCR-HR-EMP-01 §1 row 2 / 01-Data-Model.sql:1303: RecordEmployeeDocument's own docType, before
 *  any DB write, mirroring the DB's `chk_employee_documents_doc_type` (migration 0029). */
export function assertDocTypeAllowed(docType: string): void {
  if (!(VALID_DOC_TYPES as readonly string[]).includes(docType)) {
    throw new DocumentTypeInvalidError(
      `docType "${docType}" is not one of the documented values (${VALID_DOC_TYPES.join(', ')}). ` +
        `(Allowed: ${VALID_DOC_TYPES.join(', ')})`,
    );
  }
}

/** doc 40 §C7 "code PG-####" (40-Build-Specification-EN.md:328) — ASCII digits only, mirroring the
 *  DB's `chk_employees_code_format` (migration 0029). RegisterEmployee's own code, before any DB
 *  write. */
const EMPLOYEE_CODE_FORMAT = /^PG-[0-9]{4}$/;

/** doc 40 §C7 / 40-Build-Specification-EN.md:328: RegisterEmployee's own code must match
 *  `^PG-[0-9]{4}$` (ASCII digits only — Arabic-Indic digits do not match), mirroring the DB's
 *  `chk_employees_code_format` (migration 0029). */
export function assertEmployeeCodeFormat(code: string): void {
  if (!EMPLOYEE_CODE_FORMAT.test(code)) {
    throw new EmployeeCodeFormatInvalidError(
      `code "${code}" does not match ^PG-[0-9]{4}$ (doc 40 §C7). (Allowed: PG- followed by 4 ASCII digits)`,
    );
  }
}
