// modules/billing/domain/dimensions/machine.ts — WBS 4.1b PART 2 (lane 2).
//
// domain/ layer: pure state-transition rules for billing.dimension_values.is_active, no I/O, no
// Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch
// for state transitions — XState." ../../application/dimensions/deactivate-dimension-value.ts asks
// this machine whether DEACTIVATE is legal from the value's current status, never a hand-written
// `if (value.isActive)`.
//
// Source: D-190 (SCR-ACC-01 #9) — a value is created active and deactivation is its only edge
// (packages/contracts/billing/dimensions.ts: "Deactivate is the only is_active edge"). No reactivate
// route exists, so 'inactive' is a final state. Shape copied from the golden slice
// (modules/wms/domain/receive-inbound/machine.ts): a status enum, an events enum, one flat XState v5
// machine consulted only through `.can()`.

import { createActor, createMachine } from 'xstate';

import { IllegalDimensionValueTransitionError } from './errors.js';

/** billing.dimension_values.is_active, as a status: true = 'active', false = 'inactive'. */
export const DIMENSION_VALUE_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;

export type DimensionValueStatus = (typeof DIMENSION_VALUE_STATUS)[keyof typeof DIMENSION_VALUE_STATUS];

/** The one event this use case sends — DeactivateDimensionValue. */
export const DIMENSION_VALUE_EVENTS = {
  DEACTIVATE: 'DEACTIVATE_DIMENSION_VALUE',
} as const;

export type DimensionValueEventType = (typeof DIMENSION_VALUE_EVENTS)[keyof typeof DIMENSION_VALUE_EVENTS];

/** Pure state chart — no actions, no guards, no context: the application layer decides everything
 *  ABOUT a transition (optimistic lock, DB writes); this machine only decides WHETHER one is legal. */
export const dimensionValueMachine = createMachine({
  id: 'dimensionValue',
  initial: DIMENSION_VALUE_STATUS.ACTIVE,
  states: {
    [DIMENSION_VALUE_STATUS.ACTIVE]: {
      on: {
        [DIMENSION_VALUE_EVENTS.DEACTIVATE]: DIMENSION_VALUE_STATUS.INACTIVE,
      },
    },
    [DIMENSION_VALUE_STATUS.INACTIVE]: {
      type: 'final',
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5). */
function actorAt(state: DimensionValueStatus) {
  const snapshot = dimensionValueMachine.resolveState({ value: state });
  return createActor(dimensionValueMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalDimensionValueTransitionError. */
export function allowedDimensionValueEventsFrom(state: DimensionValueStatus): DimensionValueEventType[] {
  return Object.values(DIMENSION_VALUE_EVENTS).filter((event) => canTransitionDimensionValue(state, event));
}

/** True iff `event` is a legal transition from `current` per the state chart above. */
export function canTransitionDimensionValue(current: DimensionValueStatus, event: string): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event as DimensionValueEventType });
  actor.stop();
  return can;
}

/** Sends each of `events`, in order, to one actor started at `current`. THROWS
 *  IllegalDimensionValueTransitionError the moment an event is not legal from the actor's state;
 *  an empty `events` array returns `current` unchanged. */
export function advanceDimensionValueStatus(
  current: DimensionValueStatus,
  events: readonly DimensionValueEventType[],
): DimensionValueStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as DimensionValueStatus;
      actor.stop();
      const allowed = allowedDimensionValueEventsFrom(from);
      throw new IllegalDimensionValueTransitionError(
        `${event} is not a legal transition from dimension-value status "${from}". ` +
          `(Allowed from "${from}": [${allowed.join(', ')}])`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as DimensionValueStatus;
  actor.stop();
  return result;
}
