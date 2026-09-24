// modules/hr/tests/register-employee/invariants.property.test.ts — WBS 3.3.
//
// Property tests (fast-check) for the pure domain invariants and the state machine in
// modules/hr/domain/register-employee/{invariants.ts,machine.ts} — one property per invariant
// named in docs/notes/slice-briefs/_slice-3.3.brief.md's "Property tests" section (P1, P2, P3).
//
// Expected domain surface:
//   modules/hr/domain/register-employee/invariants.ts
//     - `isDocumentExpired(doc: { expiryDate: string }, today: string): boolean` — P1. ISO date
//       (`YYYY-MM-DD`) string comparison only — `doc.expiryDate < today`, no time-of-day effect.
//       bp06 §4.3 KPI: `expiry_date < current_date` — valid THROUGH the expiry day, so a document
//       expiring exactly `today` is NOT expired.
//     - `requiredDocTypesFor(purpose: 'task' | 'vehicle'): readonly string[]` — brief D4:
//       required('task') = ['residency']; required('vehicle') = ['residency', 'license'].
//     - `assertDriverAssignable(employee: { status: string }, docs: readonly { docType: string;
//       expiryDate: string }[], purpose: 'task' | 'vehicle', today: string): void` — P2. Throws
//       EmployeeNotActiveError iff employee.status !== 'active'; else, for every required doc_type,
//       reads the row with the GREATEST expiryDate (brief D3 — a renewal is a new row, the gate
//       reads the latest), throws DriverDocumentMissingError iff no row of that doc_type exists,
//       DriverDocumentExpiredError iff the latest row is expired (per isDocumentExpired); returns
//       (no throw) iff status='active' AND every required doc_type has a latest row with
//       expiryDate >= today.
//
//   modules/hr/domain/register-employee/machine.ts (P3) — see ./employee-machine.unit.test.ts's
//   own header for the full surface; this file only drives it with a fast-check sequence.

import fc from 'fast-check';
import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

// The module under test.
import {
  assertDriverAssignable,
  isDocumentExpired,
  requiredDocTypesFor,
  // businessDateOf / BUSINESS_TIME_ZONE — the Asia/Kuwait business-date conversion (see the
  // "businessDateOf" describe block below).
  businessDateOf,
  BUSINESS_TIME_ZONE,
} from '../../domain/register-employee/invariants.js';
import {
  DriverDocumentExpiredError,
  DriverDocumentMissingError,
  EmployeeNotActiveError,
} from '../../domain/register-employee/errors.js';
import { EMPLOYEE_EVENTS, EMPLOYEE_STATUS, employeeMachine } from '../../domain/register-employee/machine.js';

// --- date arbitraries: ISO YYYY-MM-DD strings, ordered by plain string comparison ----------------

function isoDate(daysFromEpoch: number): string {
  const ms = daysFromEpoch * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

const isoDateArb = fc.integer({ min: 0, max: 40000 }).map(isoDate);

// --- P1: isDocumentExpired(doc, today) <=> doc.expiryDate < today -------------------------------

describe('isDocumentExpired — property (P1)', () => {
  it('never expired when expiryDate >= today', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40000 }), fc.integer({ min: 0, max: 100 }), (todayOffset, aheadDays) => {
        const today = isoDate(todayOffset);
        const expiryDate = isoDate(todayOffset + aheadDays); // aheadDays >= 0 -> expiryDate >= today.
        expect(isDocumentExpired({ expiryDate }, today)).toBe(false);
      }),
    );
  });

  it('always expired when expiryDate < today', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40000 }), fc.integer({ min: 1, max: 100 }), (todayOffset, behindDays) => {
        const today = isoDate(todayOffset);
        const expiryDate = isoDate(Math.max(0, todayOffset - behindDays));
        fc.pre(expiryDate < today);
        expect(isDocumentExpired({ expiryDate }, today)).toBe(true);
      }),
    );
  });

  it('a document expiring exactly today is never expired (bp06 §4.3: valid through the expiry day)', () => {
    fc.assert(
      fc.property(isoDateArb, (today) => {
        expect(isDocumentExpired({ expiryDate: today }, today)).toBe(false);
      }),
    );
  });
});

// --- P2: assertDriverAssignable — status + per-doc_type latest-row gate -------------------------

const DOC_TYPE_RESIDENCY = 'residency';
const DOC_TYPE_LICENSE = 'license';
const purposeArb = fc.constantFrom<'task' | 'vehicle'>('task', 'vehicle');
const statusArb = fc.constantFrom('active', 'on_leave', 'suspended', 'terminated');

/** One doc_type's history: zero or more rows at arbitrary expiryDates. `latest` is the greatest
 *  expiryDate among them, matching brief D3 (a renewal is a new row; the gate reads the max). */
function docHistoryArb() {
  return fc.array(isoDateArb, { minLength: 0, maxLength: 4 });
}

describe('assertDriverAssignable — property (P2)', () => {
  it('EmployeeNotActiveError iff status !== "active", regardless of documents', () => {
    fc.assert(
      fc.property(statusArb, purposeArb, isoDateArb, (status, purpose, today) => {
        const docs = requiredDocTypesFor(purpose).map((docType) => ({ docType, expiryDate: isoDate(400000) })); // far future.
        if (status !== 'active') {
          expect(() => assertDriverAssignable({ status }, docs, purpose, today)).toThrow(EmployeeNotActiveError);
        } else {
          expect(() => assertDriverAssignable({ status }, docs, purpose, today)).not.toThrow();
        }
      }),
    );
  });

  it('never throws iff status="active" AND every required doc_type has a latest row with expiryDate >= today', () => {
    fc.assert(
      fc.property(
        purposeArb,
        isoDateArb,
        docHistoryArb(),
        docHistoryArb(),
        (purpose, today, residencyHistory, licenseHistory) => {
          const docs = [
            ...residencyHistory.map((expiryDate) => ({ docType: DOC_TYPE_RESIDENCY, expiryDate })),
            ...licenseHistory.map((expiryDate) => ({ docType: DOC_TYPE_LICENSE, expiryDate })),
          ];
          const required = requiredDocTypesFor(purpose);
          const expectedAssignable = required.every((docType) => {
            const rows = docs.filter((d) => d.docType === docType);
            if (rows.length === 0) return false;
            const latest = rows.reduce((a, b) => (a.expiryDate >= b.expiryDate ? a : b));
            return !isDocumentExpired(latest, today);
          });

          if (expectedAssignable) {
            expect(() => assertDriverAssignable({ status: 'active' }, docs, purpose, today)).not.toThrow();
          } else {
            expect(() => assertDriverAssignable({ status: 'active' }, docs, purpose, today)).toThrow();
          }
        },
      ),
    );
  });

  it('a missing required doc_type throws DriverDocumentMissingError, never DriverDocumentExpiredError', () => {
    fc.assert(
      fc.property(purposeArb, isoDateArb, (purpose, today) => {
        expect(() => assertDriverAssignable({ status: 'active' }, [], purpose, today)).toThrow(
          DriverDocumentMissingError,
        );
      }),
    );
  });

  it('an expired-only latest row throws DriverDocumentExpiredError', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40000 }), (todayOffset) => {
        const today = isoDate(todayOffset);
        const expired = isoDate(todayOffset - 1);
        const docs = requiredDocTypesFor('task').map((docType) => ({ docType, expiryDate: expired }));
        expect(() => assertDriverAssignable({ status: 'active' }, docs, 'task', today)).toThrow(
          DriverDocumentExpiredError,
        );
      }),
    );
  });
});

// --- businessDateOf must be Asia/Kuwait, not UTC -------------------------------------------------
//
// database/schema/01-Data-Model.sql:8 — "التوقيت: timestamptz (UTC مخزَّن، Asia/Kuwait معروض)"
// ("time: timestamptz stored as UTC, displayed as Asia/Kuwait"). check-driver-assignable.ts and
// change-employee-status.ts compute "today" via businessDateOf, in the business time zone. Kuwait
// is UTC+3 with no DST, so any instant at or after 21:00 UTC is already the next calendar day in
// Kuwait.

describe('businessDateOf — Asia/Kuwait business date', () => {
  it('BUSINESS_TIME_ZONE is exactly "Asia/Kuwait" (database/schema/01-Data-Model.sql:8)', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Kuwait');
  });

  it('22:30 UTC on 2026-09-24 is 01:30 Kuwait time on 2026-09-25 -> "2026-09-25"', () => {
    expect(businessDateOf(new Date('2026-09-24T22:30:00Z'))).toBe('2026-09-25');
  });

  it('20:59:59 UTC on 2026-09-24 is still 23:59:59 Kuwait time on 2026-09-24 -> "2026-09-24"', () => {
    expect(businessDateOf(new Date('2026-09-24T20:59:59Z'))).toBe('2026-09-24');
  });

  it('property: businessDateOf always equals the en-CA Intl date formatted in Asia/Kuwait, and never differs from the UTC calendar date by more than one day', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40000 }),
        fc.integer({ min: 0, max: 24 * 60 * 60 * 1000 - 1 }),
        (dayOffset, msOfDay) => {
          const instant = new Date(dayOffset * 24 * 60 * 60 * 1000 + msOfDay);
          const expected = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE }).format(instant);

          expect(businessDateOf(instant)).toBe(expected);

          const utcDate = instant.toISOString().slice(0, 10);
          const diffDays =
            Math.abs(Date.parse(`${businessDateOf(instant)}T00:00:00Z`) - Date.parse(`${utcDate}T00:00:00Z`)) /
            (24 * 60 * 60 * 1000);
          expect(diffDays).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

// --- P3: the employeeMachine never leaves 'terminated' and never reaches 'suspended' from
// 'on_leave' or vice-versa without passing through 'active' -------------------------------------

const eventArb = fc.constantFrom(...Object.values(EMPLOYEE_EVENTS));

describe('employeeMachine — property (P3): sequence invariants over random event sequences', () => {
  it('never leaves "terminated" once reached', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 0, maxLength: 20 }), (events) => {
        const actor = createActor(employeeMachine);
        actor.start();
        let sawTerminated = false;
        for (const event of events) {
          if (actor.getSnapshot().can({ type: event })) {
            actor.send({ type: event });
          }
          if (actor.getSnapshot().value === EMPLOYEE_STATUS.TERMINATED) sawTerminated = true;
          if (sawTerminated) {
            expect(actor.getSnapshot().value).toBe(EMPLOYEE_STATUS.TERMINATED);
          }
        }
        actor.stop();
      }),
    );
  });

  it('never transitions directly between "on_leave" and "suspended" without passing through "active"', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 0, maxLength: 20 }), (events) => {
        const actor = createActor(employeeMachine);
        actor.start();
        let previous = actor.getSnapshot().value as string;
        for (const event of events) {
          if (!actor.getSnapshot().can({ type: event })) continue;
          actor.send({ type: event });
          const current = actor.getSnapshot().value as string;
          const forbiddenPair =
            (previous === EMPLOYEE_STATUS.ON_LEAVE && current === EMPLOYEE_STATUS.SUSPENDED) ||
            (previous === EMPLOYEE_STATUS.SUSPENDED && current === EMPLOYEE_STATUS.ON_LEAVE);
          expect(forbiddenPair).toBe(false);
          previous = current;
        }
        actor.stop();
      }),
    );
  });
});
