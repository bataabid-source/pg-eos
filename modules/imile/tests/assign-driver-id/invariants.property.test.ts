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
