// modules/imile/tests/assign-driver-id/invariants.property.test.ts — WBS 3.12.
//
// Property tests (fast-check) for modules/imile/domain/assign-driver-id/invariants.ts — brief,
// Deliver: "invariants.ts exports whatever pure precondition checks are needed (e.g. validating the
// input shape) — no state-machine is built here: this command performs exactly ONE transition
// (available -> assigned) guarded by a precondition check, not a dispatched set of transitions".
//
// Expected new surface (RED until it exists):
//   modules/imile/domain/assign-driver-id/invariants.ts
//     - `isValidAssignDriverIdInput(raw: unknown): boolean` — pure, no I/O, no Date.now()/
//       new Date(), no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). Never throws for ANY input,
//       same "malformed input is data, not a crash" discipline as this module's own
//       evaluate-dtl-problem/invariants.ts `isG0Complete` and pull-shipments' `validatePortalRecord`.
//       Validates ONLY the input shape (brief, Contract: `{ driverIdRef: uuid, employeeId: uuid,
//       correlationId: uuid }`) — it is a precondition check, never a state-machine transition
//       table (brief line above).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import { isValidAssignDriverIdInput } from '../../domain/assign-driver-id/invariants.js';
// Round-2 fix round, finding 4 (partial, test side): `isAssignableStatus` is a pure predicate the
// coordinated pg-backend fix round is adding to domain/assign-driver-id/invariants.ts alongside
// `isValidAssignDriverIdInput` — true only for the live 'available' status
// (chk_driver_ids_status: 13B-Schema-Reference-Consolidation.sql:2513-2516), false for every other
// live status ('assigned'/'suspended') and any other string. Authored here ahead of the
// production file landing; RED until `isAssignableStatus` exists and is exported.
import { isAssignableStatus } from '../../domain/assign-driver-id/invariants.js';
// Round-2 fix round, finding 3 (test side, added in the fix round after pg-reviewer's round-1
// FAIL): the NEW gate this module's own invariants.ts now exports — this module's own copy of hr's
// WBS-3.3 INV-C4-1 `assertDriverAssignable` (hr's own
// modules/hr/domain/register-employee/invariants.ts:73-102), 'task' purpose only. Previously
// exercised ONLY end-to-end through the 4 integration cases in ./assign-driver-id.test.ts — this
// suite now covers it at the unit level too (brief, Deliver: "property tests on every invariant").
import { assertDriverAssignable, businessDateOf } from '../../domain/assign-driver-id/invariants.js';
import {
  DriverDocumentExpiredError,
  DriverDocumentMissingError,
  EmployeeNotActiveError,
} from '../../domain/assign-driver-id/errors.js';

const uuidArb = fc.uuid();
// Round-2 fix round, finding 7: invariants.ts's own isValidAssignDriverIdInput regex accepts UUID
// versions 1-8 (RFC 4122 v1-5 plus v6-v8), not just v1-5 — the negative-case generator below must
// exclude the SAME range so it is a true complement of what the code accepts, not a looser check.
const notAUuidArb = fc.string().filter((s) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s));

describe('isValidAssignDriverIdInput — property (pure, no I/O)', () => {
  it('never throws for arbitrary garbage input', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => isValidAssignDriverIdInput(raw)).not.toThrow();
      }),
    );
  });

  it('is always true when driverIdRef, employeeId and correlationId are all well-formed uuid strings', () => {
    fc.assert(
      fc.property(uuidArb, uuidArb, uuidArb, (driverIdRef, employeeId, correlationId) => {
        expect(
          isValidAssignDriverIdInput({ driverIdRef, employeeId, correlationId }),
        ).toBe(true);
      }),
    );
  });

  it('is always false when driverIdRef is not a well-formed uuid string', () => {
    fc.assert(
      fc.property(notAUuidArb, uuidArb, uuidArb, (driverIdRef, employeeId, correlationId) => {
        expect(
          isValidAssignDriverIdInput({ driverIdRef, employeeId, correlationId }),
        ).toBe(false);
      }),
    );
  });

  it('is always false when employeeId is not a well-formed uuid string', () => {
    fc.assert(
      fc.property(uuidArb, notAUuidArb, uuidArb, (driverIdRef, employeeId, correlationId) => {
        expect(
          isValidAssignDriverIdInput({ driverIdRef, employeeId, correlationId }),
        ).toBe(false);
      }),
    );
  });

  it('is always false when correlationId is not a well-formed uuid string', () => {
    fc.assert(
      fc.property(uuidArb, uuidArb, notAUuidArb, (driverIdRef, employeeId, correlationId) => {
        expect(
          isValidAssignDriverIdInput({ driverIdRef, employeeId, correlationId }),
        ).toBe(false);
      }),
    );
  });

  it('is always false for null, undefined, arrays and primitives — not a plain object', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(undefined), fc.array(fc.anything()), fc.string(), fc.integer(), fc.boolean()),
        (raw) => {
          expect(isValidAssignDriverIdInput(raw)).toBe(false);
        },
      ),
    );
  });

  it('is always false when a required field is missing entirely', () => {
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb,
        uuidArb,
        fc.constantFrom<'driverIdRef' | 'employeeId' | 'correlationId'>('driverIdRef', 'employeeId', 'correlationId'),
        (driverIdRef, employeeId, correlationId, omit) => {
          const full: Record<string, string> = { driverIdRef, employeeId, correlationId };
          delete full[omit];
          expect(isValidAssignDriverIdInput(full)).toBe(false);
        },
      ),
    );
  });
});

describe('isAssignableStatus — property (pure, no I/O; round-2 fix round finding 4)', () => {
  it('is true only for "available", the live chk_driver_ids_status value a driver ID must have to be assigned', () => {
    expect(isAssignableStatus('available')).toBe(true);
  });

  it('is false for every other live imile.driver_ids status', () => {
    fc.assert(
      fc.property(fc.constantFrom('assigned', 'suspended'), (status) => {
        expect(isAssignableStatus(status)).toBe(false);
      }),
    );
  });

  it('is false for any arbitrary string that is not exactly "available"', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== 'available'),
        (status) => {
          expect(isAssignableStatus(status)).toBe(false);
        },
      ),
    );
  });
});

// --- assertDriverAssignable — property (round-2 fix round, finding 3) --------------------------
//
// This module's own copy of hr's WBS-3.3 INV-C4-1 `assertDriverAssignable`
// (modules/hr/domain/register-employee/invariants.ts:73-102, mirrored in
// modules/hr/tests/register-employee/invariants.property.test.ts's own "P2" describe block), 'task'
// purpose only — this module never takes a `purpose` parameter (brief DEFAULT, no 'vehicle'
// support). Previously exercised ONLY end-to-end through ./assign-driver-id.test.ts's 4 integration
// cases; this suite now covers it at the unit level too (brief, Deliver: "property tests on every
// invariant").

const DOC_TYPE_RESIDENCY = 'residency';
const EMPLOYEE_STATUSES = ['active', 'on_leave', 'suspended', 'terminated'] as const;

function isoDate(daysFromEpoch: number): string {
  const ms = daysFromEpoch * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

const isoDateArb = fc.integer({ min: 0, max: 40000 }).map(isoDate);

function docHistoryArb() {
  return fc.array(isoDateArb, { minLength: 0, maxLength: 4 });
}

describe('assertDriverAssignable — property (round-2 fix round, finding 3)', () => {
  it('throws EmployeeNotActiveError iff employee.status !== "active", regardless of documents', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EMPLOYEE_STATUSES),
        isoDateArb,
        (status, today) => {
          // Far-future residency document — documents must never mask the status gate.
          const docs = [{ docType: DOC_TYPE_RESIDENCY, expiryDate: isoDate(400000) }];
          if (status !== 'active') {
            expect(() => assertDriverAssignable({ status }, docs, today)).toThrow(EmployeeNotActiveError);
          } else {
            expect(() => assertDriverAssignable({ status }, docs, today)).not.toThrow();
          }
        },
      ),
    );
  });

  it('an active employee with zero "residency" doc rows throws DriverDocumentMissingError', () => {
    fc.assert(
      fc.property(isoDateArb, (today) => {
        expect(() => assertDriverAssignable({ status: 'active' }, [], today)).toThrow(
          DriverDocumentMissingError,
        );
      }),
    );
  });

  it('never throws iff status="active" AND the latest "residency" row has expiryDate >= today', () => {
    fc.assert(
      fc.property(isoDateArb, docHistoryArb(), (today, history) => {
        const docs = history.map((expiryDate) => ({ docType: DOC_TYPE_RESIDENCY, expiryDate }));
        const expectedAssignable =
          docs.length > 0 && docs.reduce((a, b) => (a.expiryDate >= b.expiryDate ? a : b)).expiryDate >= today;

        if (expectedAssignable) {
          expect(() => assertDriverAssignable({ status: 'active' }, docs, today)).not.toThrow();
        } else {
          expect(() => assertDriverAssignable({ status: 'active' }, docs, today)).toThrow();
        }
      }),
    );
  });

  it('tie-break: when an OLDER expired row and a NEWER valid row both exist, the GREATEST expiryDate wins — the gate does not throw (proves "latest", not "any row")', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40000 }), (todayOffset) => {
        const today = isoDate(todayOffset);
        const olderExpired = isoDate(Math.max(0, todayOffset - 100)); // long expired.
        const newerValid = isoDate(todayOffset + 10); // still valid.
        fc.pre(olderExpired < today);
        // Two rows of the SAME doc_type; only their expiryDate differs. Order in the array must
        // not matter — the reduce tie-break in assertDriverAssignable picks the max regardless of
        // insertion order.
        const docsOldFirst = [
          { docType: DOC_TYPE_RESIDENCY, expiryDate: olderExpired },
          { docType: DOC_TYPE_RESIDENCY, expiryDate: newerValid },
        ];
        const docsNewFirst = [
          { docType: DOC_TYPE_RESIDENCY, expiryDate: newerValid },
          { docType: DOC_TYPE_RESIDENCY, expiryDate: olderExpired },
        ];
        expect(() => assertDriverAssignable({ status: 'active' }, docsOldFirst, today)).not.toThrow();
        expect(() => assertDriverAssignable({ status: 'active' }, docsNewFirst, today)).not.toThrow();
      }),
    );
  });

  it('an expiryDate exactly equal to today does NOT throw (boundary — matches hr\'s own isDocumentExpired-equivalent strict "<" comparison: valid through the expiry day)', () => {
    fc.assert(
      fc.property(isoDateArb, (today) => {
        const docs = [{ docType: DOC_TYPE_RESIDENCY, expiryDate: today }];
        expect(() => assertDriverAssignable({ status: 'active' }, docs, today)).not.toThrow();
      }),
    );
  });

  it('an expired-only latest row throws DriverDocumentExpiredError', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40000 }), (todayOffset) => {
        const today = isoDate(todayOffset);
        const expired = isoDate(todayOffset - 1);
        const docs = [{ docType: DOC_TYPE_RESIDENCY, expiryDate: expired }];
        expect(() => assertDriverAssignable({ status: 'active' }, docs, today)).toThrow(
          DriverDocumentExpiredError,
        );
      }),
    );
  });
});

// --- businessDateOf sanity (this module's own copy of hr's own utility, imported above so this
// suite fails loudly if the two ever drift) ------------------------------------------------------

describe('businessDateOf — Asia/Kuwait business date (same one-liner as hr\'s own precedent)', () => {
  it('a UTC instant at/after 21:00 rolls to the NEXT Kuwait calendar day (Kuwait UTC+3, no DST)', () => {
    expect(businessDateOf(new Date('2026-09-24T22:30:00Z'))).toBe('2026-09-25');
  });

  it('a UTC instant just before 21:00 stays on the SAME Kuwait calendar day', () => {
    expect(businessDateOf(new Date('2026-09-24T20:59:59Z'))).toBe('2026-09-24');
  });
});
