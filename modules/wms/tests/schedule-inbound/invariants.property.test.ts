// modules/wms/tests/schedule-inbound/invariants.property.test.ts — WBS 2.9b (lane 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/wms/domain/schedule-inbound/invariants.ts — one property per invariant (CLAUDE.md
// TESTING; doc 36 §5-5). Sources: docs/notes/slice-briefs/_slice-2.9b.brief.md Scenario section
// ("isFutureTimestamp, isValidVehicleType, isNonEmptyReason (or equivalent) on every new
// invariant"), migration 0023_2_schedule-inbound.sql's own CHECK lists.
//
// Expected new surface (RED until it exists):
//   modules/wms/domain/schedule-inbound/invariants.ts
//     - isFutureTimestamp(candidate: Date, now: Date): boolean — true iff candidate is strictly
//       after now (an equal timestamp is NOT future — D1 "must be in the future"). Pure: no I/O, no
//       Date.now()/new Date() internally, no Math.random() (CLAUDE.md domain/ discipline) — both
//       timestamps are parameters.
//     - isValidVehicleType(value: string | null | undefined): boolean — true when value is null or
//       undefined (the field is optional, D6) OR is one of the closed list (migration 0023's
//       chk_inbound_orders_vehicle_type: container_20, container_40, truck, trailer, van, pickup,
//       other); false for any other non-empty string.
//     - isNonEmptyReason(value: string | null | undefined): boolean — true iff value is a string of
//       length >= 1; false for null/undefined/empty string. Reused by
//       ../../application/receive-inbound/cancel-inbound.ts's mandatory cancelReason check (D3) —
//       recorded default (this predicate has no brief-named home; domain/receive-inbound/
//       invariants.ts is not in this slice's Write ONLY list, so it is placed here and imported by
//       cancel-inbound.ts instead), flagged in the closing report.

//
// Round-2 review finding 2 (opus escalation): the four logistics-term invariants added in round 1
// (isValidHandoverPoint, isValidTransportBy, isValidLabourBy, isNonNegativeLabourCount) had no
// property test. Each closed list below is copied from migration 0023_2_schedule-inbound.sql's own
// CHECK (chk_inbound_orders_handover_point / _transport_by / _labour_by / _labour_count — brief
// Schema section), never invented.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test.
import {
  isFutureTimestamp,
  isNonEmptyReason,
  isNonNegativeLabourCount,
  isValidHandoverPoint,
  isValidLabourBy,
  isValidTransportBy,
  isValidVehicleType,
} from '../../domain/schedule-inbound/invariants.js';

const VALID_VEHICLE_TYPES = ['container_20', 'container_40', 'truck', 'trailer', 'van', 'pickup', 'other'] as const;
// migration 0023 CHECK chk_inbound_orders_handover_point.
const VALID_HANDOVER_POINTS = ['premium_warehouse', 'client_site'] as const;
// migration 0023 CHECK chk_inbound_orders_transport_by.
const VALID_TRANSPORT_BY = ['client', 'premium'] as const;
// migration 0023 CHECK chk_inbound_orders_labour_by.
const VALID_LABOUR_BY = ['client', 'premium', 'shared'] as const;

const validVehicleTypeArb = fc.constantFrom(...VALID_VEHICLE_TYPES);
// Any string that is NOT one of the closed-list values.
const invalidVehicleTypeArb = fc.string({ minLength: 1 }).filter((s) => !(VALID_VEHICLE_TYPES as readonly string[]).includes(s));

/** Any non-empty string outside `closedList` — includes near-misses (case changes, padding) so a
 *  case-insensitive or trimming implementation is caught, not only random noise. */
function outsideClosedListArb(closedList: readonly string[]): fc.Arbitrary<string> {
  const nearMiss = fc
    .constantFrom(...closedList)
    .chain((value) => fc.constantFrom(value.toUpperCase(), ` ${value}`, `${value} `, `${value}_x`));
  return fc
    .oneof(fc.string({ minLength: 1 }), nearMiss)
    .filter((s) => !closedList.includes(s));
}

describe('isFutureTimestamp — property (D1: "must be in the future")', () => {
  it('is true whenever candidate is strictly after now, for any positive millisecond delta', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }), fc.integer({ min: 1, max: 1000 * 60 * 60 * 24 * 365 }), (now, deltaMs) => {
        const candidate = new Date(now.getTime() + deltaMs);
        expect(isFutureTimestamp(candidate, now)).toBe(true);
      }),
    );
  });

  it('is false whenever candidate is equal to or before now, for any non-positive millisecond delta', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }), fc.integer({ min: 0, max: 1000 * 60 * 60 * 24 * 365 }), (now, deltaMs) => {
        const candidate = new Date(now.getTime() - deltaMs);
        expect(isFutureTimestamp(candidate, now)).toBe(false);
      }),
    );
  });
});

describe('isValidVehicleType — property (migration 0023 chk_inbound_orders_vehicle_type)', () => {
  it('is true for null and for undefined (the field is optional, D6)', () => {
    expect(isValidVehicleType(null)).toBe(true);
    expect(isValidVehicleType(undefined)).toBe(true);
  });

  it('is true for every closed-list value', () => {
    fc.assert(
      fc.property(validVehicleTypeArb, (value) => {
        expect(isValidVehicleType(value)).toBe(true);
      }),
    );
  });

  it('is false for any non-empty string outside the closed list', () => {
    fc.assert(
      fc.property(invalidVehicleTypeArb, (value) => {
        expect(isValidVehicleType(value)).toBe(false);
      }),
    );
  });
});

describe('isNonEmptyReason — property (D3: CancelInbound.cancelReason mandatory, min length 1)', () => {
  it('is false for null, undefined, and the empty string', () => {
    expect(isNonEmptyReason(null)).toBe(false);
    expect(isNonEmptyReason(undefined)).toBe(false);
    expect(isNonEmptyReason('')).toBe(false);
  });

  it('is true for any non-empty string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (value) => {
        expect(isNonEmptyReason(value)).toBe(true);
      }),
    );
  });
});

// --- Round-2 review finding 2: the four logistics-term invariants ---------------------------------

describe('isValidHandoverPoint — property (migration 0023 chk_inbound_orders_handover_point)', () => {
  it('is true for null and for undefined (the field is optional, D6)', () => {
    expect(isValidHandoverPoint(null)).toBe(true);
    expect(isValidHandoverPoint(undefined)).toBe(true);
  });

  it('is true for every closed-list value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_HANDOVER_POINTS), (value) => {
        expect(isValidHandoverPoint(value)).toBe(true);
      }),
    );
  });

  it('is false for any non-empty string outside the closed list (including case/padding near-misses)', () => {
    fc.assert(
      fc.property(outsideClosedListArb(VALID_HANDOVER_POINTS), (value) => {
        expect(isValidHandoverPoint(value)).toBe(false);
      }),
    );
  });

  it('is false for the empty string', () => {
    expect(isValidHandoverPoint('')).toBe(false);
  });
});

describe('isValidTransportBy — property (migration 0023 chk_inbound_orders_transport_by)', () => {
  it('is true for null and for undefined (the field is optional, D6)', () => {
    expect(isValidTransportBy(null)).toBe(true);
    expect(isValidTransportBy(undefined)).toBe(true);
  });

  it('is true for every closed-list value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_TRANSPORT_BY), (value) => {
        expect(isValidTransportBy(value)).toBe(true);
      }),
    );
  });

  it('is false for any non-empty string outside the closed list (including case/padding near-misses)', () => {
    fc.assert(
      fc.property(outsideClosedListArb(VALID_TRANSPORT_BY), (value) => {
        expect(isValidTransportBy(value)).toBe(false);
      }),
    );
  });

  it('is false for "shared" — a labour_by value that is NOT a transport_by value', () => {
    expect(isValidTransportBy('shared')).toBe(false);
  });
});

describe('isValidLabourBy — property (migration 0023 chk_inbound_orders_labour_by)', () => {
  it('is true for null and for undefined (the field is optional, D6)', () => {
    expect(isValidLabourBy(null)).toBe(true);
    expect(isValidLabourBy(undefined)).toBe(true);
  });

  it('is true for every closed-list value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_LABOUR_BY), (value) => {
        expect(isValidLabourBy(value)).toBe(true);
      }),
    );
  });

  it('is false for any non-empty string outside the closed list (including case/padding near-misses)', () => {
    fc.assert(
      fc.property(outsideClosedListArb(VALID_LABOUR_BY), (value) => {
        expect(isValidLabourBy(value)).toBe(false);
      }),
    );
  });
});

describe('isNonNegativeLabourCount — property (migration 0023 chk_inbound_orders_labour_count: labour_count >= 0)', () => {
  it('is true for null and for undefined (the field is optional, D6)', () => {
    expect(isNonNegativeLabourCount(null)).toBe(true);
    expect(isNonNegativeLabourCount(undefined)).toBe(true);
  });

  it('is true for zero and every positive integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (value) => {
        expect(isNonNegativeLabourCount(value)).toBe(true);
      }),
    );
  });

  it('is false for every negative integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: Number.MIN_SAFE_INTEGER, max: -1 }), (value) => {
        expect(isNonNegativeLabourCount(value)).toBe(false);
      }),
    );
  });

  it('the boundary: 0 is valid, -1 is not', () => {
    expect(isNonNegativeLabourCount(0)).toBe(true);
    expect(isNonNegativeLabourCount(-1)).toBe(false);
  });
});
