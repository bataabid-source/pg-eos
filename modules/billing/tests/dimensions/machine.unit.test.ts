// modules/billing/tests/dimensions/machine.unit.test.ts — WBS 4.1b PART 2 (lane 2).
//
// Pre-build review round 1 finding 13: renamed from ./dimension-value-machine.unit.test.ts to
// `machine.unit.test.ts`, importing `../../domain/dimensions/machine.js` — the golden slice's own
// literal file name (modules/wms/domain/receive-inbound/machine.ts), never a slug-built identifier
// ("Do not build identifiers by string concatenation of the slug; every name here is a literal" —
// modules/wms/domain/receive-inbound/machine.ts's own header).
//
// Pure domain-layer unit test — no DB, no I/O. CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for
// state transitions — XState." `billing.dimension_values.is_active` has exactly ONE legal edge
// this slice ever builds (D-190: "Deactivate is the only is_active edge" —
// packages/contracts/billing/dimensions.ts's own comment on CreateDimensionValueInputSchema, "the
// create body carries no isActive"): active -> inactive. There is no reactivate route in this
// slice's contract (only create-dimension-value / deactivate-dimension-value are registered), so
// 'inactive' is a terminal (`type: 'final'`) state here — same shape discipline as the golden slice,
// applied to the smallest machine this domain actually needs (2 states, 1 event).
//
// Expected surface — modules/billing/domain/dimensions/machine.ts (does not exist yet — RED):
//   - `DIMENSION_VALUE_STATUS` — { ACTIVE: 'active', INACTIVE: 'inactive' }.
//   - `DIMENSION_VALUE_EVENTS` — { DEACTIVATE: 'DEACTIVATE_DIMENSION_VALUE' }, the one event this
//     slice's DeactivateDimensionValue command sends.
//   - `dimensionValueMachine` — an XState v5 machine, `id: 'dimensionValue'`,
//     `initial: DIMENSION_VALUE_STATUS.ACTIVE`, exactly the one edge below, and 'inactive' typed
//     `{ type: 'final' }` (asserted directly against the machine's own config below — round-1
//     finding 13).
//   - `canTransitionDimensionValue(current, event): boolean` — mirrors
//     modules/wms/domain/receive-inbound/machine.ts's own `canTransition`.
//   - `advanceDimensionValueStatus(current, events): DimensionValueStatus` — mirrors
//     `advanceInboundOrder`; THROWS `IllegalDimensionValueTransitionError`
//     (./errors.js — extends part 1's existing modules/billing/domain/dimensions/errors.ts) the
//     moment an event is illegal from the actor's current state (e.g. DEACTIVATE sent twice). Round-1
//     finding 12: the thrown message states the FROM state ("inactive") and the allowed-events list
//     literally, empty (`[]`) for a terminal state — mirroring
//     modules/wms/domain/receive-inbound/machine.ts's own `allowedEventsFrom`/message-building
//     convention (there rendered as "none, terminal state"; here the empty list itself, `[]`, is
//     asserted literally since finding 12 names it that way).
//
// modules/billing/application/dimensions/deactivate-dimension-value.ts asks THIS machine whether
// DEACTIVATE is legal from the value's current status, never a hand-written
// `if (value.isActive) ... else ...`.

import { describe, expect, it } from 'vitest';

import {
  DIMENSION_VALUE_EVENTS,
  DIMENSION_VALUE_STATUS,
  advanceDimensionValueStatus,
  canTransitionDimensionValue,
  dimensionValueMachine,
  type DimensionValueStatus,
} from '../../domain/dimensions/machine.js';
import { IllegalDimensionValueTransitionError } from '../../domain/dimensions/errors.js';

const STATES = Object.values(DIMENSION_VALUE_STATUS);
const EVENTS = Object.values(DIMENSION_VALUE_EVENTS);

// The SINGLE source of truth this exhaustive table is checked against: DEACTIVATE is legal ONLY
// from 'active', landing on 'inactive'; 'inactive' has no outgoing edge in this slice (no
// reactivate route exists yet — a later slice, if ever built, adds its own edge and its own test
// row here, never a silent widening of this one).
const LEGAL_EDGES: ReadonlyArray<{
  readonly from: DimensionValueStatus;
  readonly event: string;
  readonly to: DimensionValueStatus;
}> = [
  {
    from: DIMENSION_VALUE_STATUS.ACTIVE,
    event: DIMENSION_VALUE_EVENTS.DEACTIVATE,
    to: DIMENSION_VALUE_STATUS.INACTIVE,
  },
];

describe('dimensionValueMachine — id, initial state, and "inactive" is a genuine final state', () => {
  it('has id "dimensionValue" and starts at "active"', () => {
    expect(dimensionValueMachine.id).toBe('dimensionValue');
    expect(dimensionValueMachine.config.initial).toBe(DIMENSION_VALUE_STATUS.ACTIVE);
  });

  // Round-1 finding 13: asserted directly against the machine's own config, not merely inferred
  // from canTransitionDimensionValue returning false for every event from 'inactive' (a machine
  // could return false from an ordinary non-final state with no outgoing edges too — this asserts
  // the STRONGER, more specific fact the finding names).
  it('the "inactive" state is configured as a genuine XState final state (type: "final")', () => {
    const inactiveStateConfig = (
      dimensionValueMachine.config.states as Record<string, { type?: string }>
    )[DIMENSION_VALUE_STATUS.INACTIVE];
    expect(inactiveStateConfig?.type).toBe('final');
  });
});

describe('canTransitionDimensionValue — exhaustive 2 states x 1 event table', () => {
  for (const from of STATES) {
    for (const event of EVENTS) {
      const legal = LEGAL_EDGES.some((edge) => edge.from === from && edge.event === event);
      it(`${legal ? 'ALLOWS' : 'REFUSES'} ${event} from "${from}"`, () => {
        expect(canTransitionDimensionValue(from, event)).toBe(legal);
      });
    }
  }
});

describe('advanceDimensionValueStatus — the one legal edge lands on the right state', () => {
  it('DEACTIVATE from "active" lands on "inactive"', () => {
    expect(
      advanceDimensionValueStatus(DIMENSION_VALUE_STATUS.ACTIVE, [DIMENSION_VALUE_EVENTS.DEACTIVATE]),
    ).toBe(DIMENSION_VALUE_STATUS.INACTIVE);
  });

  it('an empty events array is a no-op, returning the state unchanged', () => {
    expect(advanceDimensionValueStatus(DIMENSION_VALUE_STATUS.ACTIVE, [])).toBe(
      DIMENSION_VALUE_STATUS.ACTIVE,
    );
    expect(advanceDimensionValueStatus(DIMENSION_VALUE_STATUS.INACTIVE, [])).toBe(
      DIMENSION_VALUE_STATUS.INACTIVE,
    );
  });
});

describe('advanceDimensionValueStatus — an illegal transition throws IllegalDimensionValueTransitionError', () => {
  it('DEACTIVATE sent a SECOND time (already "inactive") throws, naming the state and the empty allowed-list', () => {
    expect(() =>
      advanceDimensionValueStatus(DIMENSION_VALUE_STATUS.INACTIVE, [DIMENSION_VALUE_EVENTS.DEACTIVATE]),
    ).toThrow(IllegalDimensionValueTransitionError);
  });

  it('the thrown error is a genuine Error with its own name, and its message states the FROM state ("inactive") and the allowed-events list literally ("[]", terminal state)', () => {
    let caught: unknown;
    try {
      advanceDimensionValueStatus(DIMENSION_VALUE_STATUS.INACTIVE, [DIMENSION_VALUE_EVENTS.DEACTIVATE]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(IllegalDimensionValueTransitionError);
    const asError = caught as IllegalDimensionValueTransitionError;
    expect(asError.name).toBe('IllegalDimensionValueTransitionError');
    expect(asError.message.length).toBeGreaterThan(0);
    expect(asError.message).toContain('inactive');
    expect(asError.message).toContain('[]');
  });
});
