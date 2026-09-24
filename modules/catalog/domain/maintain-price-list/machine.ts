// modules/catalog/domain/maintain-price-list/machine.ts — WBS 1.2, M03 catalog.
//
// domain/ layer: pure state-transition rules for catalog.price_lists.status, no I/O, no Date,
// no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for
// state transitions — XState." The application layer (../../application/maintain-price-list/*)
// asks this machine whether an event is legal from the list's current status via
// `actor.getSnapshot().can({ type })`, never a hand-written if/switch on the status string.
//
// Source: slice brief Master decision 2 — `draft -> active -> expired`; events
// ACTIVATE_PRICE_LIST, EXPIRE_PRICE_LIST; no other edge. `PRICE_LIST_STATUS` is verbatim from
// `chk_price_lists_status` (13B-Schema-Reference-Consolidation.sql:2413-2415).

import { createActor, createMachine } from 'xstate';

import { IllegalTransitionError } from './errors.js';

/** catalog.price_lists.status — the 3-value check constraint `chk_price_lists_status`,
 *  verbatim. */
export const PRICE_LIST_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  EXPIRED: 'expired',
} as const;

export type PriceListStatus = (typeof PRICE_LIST_STATUS)[keyof typeof PRICE_LIST_STATUS];

/** The 2 event types this machine accepts (slice brief Master decision 2). */
export const PRICE_LIST_EVENTS = {
  ACTIVATE: 'ACTIVATE_PRICE_LIST',
  EXPIRE: 'EXPIRE_PRICE_LIST',
} as const;

export type PriceListEventType = (typeof PRICE_LIST_EVENTS)[keyof typeof PRICE_LIST_EVENTS];

/** pg-reviewer fix round 1 (finding 6): the `draft` state's own tag — `assertListEditable`
 *  (../invariants.ts) asks the machine via `snapshot.hasTag(PRICE_LIST_TAG_EDITABLE)` instead of
 *  branching on the status string (CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state
 *  transitions — XState"). */
export const PRICE_LIST_TAG_EDITABLE = 'editable';

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes); this machine only decides WHETHER
 * one is legal from the current status (and, via tags, which statuses are "editable"). `id:
 * 'priceList'`, one state per PRICE_LIST_STATUS value, exactly the two edges the slice brief
 * describes — `active` and `expired` are terminal.
 */
export const priceListMachine = createMachine({
  id: 'priceList',
  initial: PRICE_LIST_STATUS.DRAFT,
  states: {
    [PRICE_LIST_STATUS.DRAFT]: {
      tags: [PRICE_LIST_TAG_EDITABLE],
      on: {
        [PRICE_LIST_EVENTS.ACTIVATE]: PRICE_LIST_STATUS.ACTIVE,
      },
    },
    [PRICE_LIST_STATUS.ACTIVE]: {
      on: {
        [PRICE_LIST_EVENTS.EXPIRE]: PRICE_LIST_STATUS.EXPIRED,
      },
    },
    [PRICE_LIST_STATUS.EXPIRED]: {
      type: 'final',
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: PriceListStatus) {
  const snapshot = priceListMachine.resolveState({ value: state });
  return createActor(priceListMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: PriceListStatus): PriceListEventType[] {
  return Object.values(PRICE_LIST_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer uses this INSTEAD OF an if/switch on the status string — CLAUDE.md · AGENT
 * CONSTRAINTS: "No if/switch for state transitions — XState."
 */
export function canTransition(current: PriceListStatus, event: PriceListEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * Sends each of `events`, in order, to a single actor started at `current`. THROWS
 * IllegalTransitionError the moment any event in the sequence is not legal in the actor's state at
 * that point — it never skips one silently. An empty `events` array is a legitimate "no
 * transition needed" no-op and returns `current` unchanged.
 */
export function advancePriceList(
  current: PriceListStatus,
  events: readonly PriceListEventType[],
): PriceListStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as PriceListStatus;
      actor.stop();
      const allowed = allowedEventsFrom(from);
      throw new IllegalTransitionError(
        `${event} is not a legal transition from price-list status "${from}". ` +
          `(Allowed from "${from}": ${allowed.length > 0 ? allowed.join(', ') : 'none, terminal state'})`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as PriceListStatus;
  actor.stop();
  return result;
}
