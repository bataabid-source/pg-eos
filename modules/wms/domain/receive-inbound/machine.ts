// modules/wms/domain/receive-inbound/machine.ts — WBS 2.9, THE GOLDEN SLICE.
//
// domain/ layer: pure state-transition rules for wms.inbound_orders.status, no I/O, no Date,
// no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for
// state transitions — XState." The application layer (../../application/receive-inbound/*) asks
// this machine whether an event is legal from the order's current status via
// `actor.getSnapshot().can({ type })`, never a hand-written if/switch on the status string.
//
// Source: doc 40 §C3 state machine (line ~256) — draft -> approved -> receiving -> received ->
// putaway -> closed | cancelled (SCR-WMS-INB-01 §1/§3): CLOSE is legal ONLY from 'putaway' — an
// order whose every line is a zero-qty receipt cannot close straight from 'received' and must be
// cancelled instead (see CANCEL below). CANCEL is legal from 'draft', 'approved' AND 'received'
// — NOT 'receiving': cancellation is refused once any line has been received with a positive
// quantity (see CancelInbound's own business rule,
// ../../application/receive-inbound/cancel-inbound.ts), and 'receiving' means at least one line
// already has qty_actual set, so a legal CANCEL from 'receiving' would always be refused by that
// rule anyway; the one order that legitimately reaches 'received' with CANCEL still open is one
// whose every line was received at qty_actual = 0 (SCR-WMS-INB-01 §1/§2). `INBOUND_ORDER_STATUS`
// is verbatim from 01-Data-Model.sql:748 / .claude/briefs/wms.brief.md §3 `inbound_orders.status`.
//
// TEMPLATE GUIDANCE for the next slice copied from this one via scripts/new-slice.sh: this file's
// shape — a status enum, an events enum, and a single flat XState v5 machine consulted only
// through `.can()` — is the pattern every later use-case's own `machine.ts` replicates. Do not
// build identifiers by string concatenation of the slug; every name here is a literal.

import { createActor, createMachine } from 'xstate';

import { IllegalTransitionError } from './errors.js';

/** wms.inbound_orders.status — the 7-value check constraint, verbatim (wms.brief.md §3). */
export const INBOUND_ORDER_STATUS = {
  DRAFT: 'draft',
  APPROVED: 'approved',
  RECEIVING: 'receiving',
  RECEIVED: 'received',
  PUTAWAY: 'putaway',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
} as const;

export type InboundOrderStatus = (typeof INBOUND_ORDER_STATUS)[keyof typeof INBOUND_ORDER_STATUS];

/**
 * The 8 event types this machine accepts. Every command call sends exactly the events that
 * describe it, and its legality comes from the machine alone: a middle ReceiveLine is the
 * self-transition RECEIVE_LINE on 'receiving', a later ConfirmPutaway is the self-transition
 * CONFIRM_PUTAWAY on 'putaway' — no command borrows another event to test its own legality.
 */
export const INBOUND_ORDER_EVENTS = {
  APPROVE: 'APPROVE_INBOUND',
  // WBS 2.9b round-1 review finding 12: ScheduleInbound (and ApproveInbound's optional
  // appointment-slot path, D2) is a fact-on-the-order, not a status transition — D1's own wording
  // is "no machine state change" (no NEW state), not "skip the machine". SCHEDULE is a
  // self-transition, legal from 'draft' and 'approved' only, landing on the SAME status — routed
  // through canTransition/advanceInboundOrder like every other event, never a raw string compare.
  SCHEDULE: 'SCHEDULE_INBOUND',
  RECEIVE_LINE_FIRST: 'RECEIVE_LINE_FIRST',
  RECEIVE_LINE: 'RECEIVE_LINE',
  RECEIVE_LINE_LAST: 'RECEIVE_LINE_LAST',
  CONFIRM_PUTAWAY_FIRST: 'CONFIRM_PUTAWAY_FIRST',
  CONFIRM_PUTAWAY: 'CONFIRM_PUTAWAY',
  CLOSE: 'CLOSE_INBOUND',
  CANCEL: 'CANCEL_INBOUND',
} as const;

export type InboundOrderEventType = (typeof INBOUND_ORDER_EVENTS)[keyof typeof INBOUND_ORDER_EVENTS];

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes); this machine only decides WHETHER
 * one is legal from the current status. `id: 'inboundOrder'`, one state per
 * INBOUND_ORDER_STATUS value, exactly the edges doc 40 §C3 + the CancelInbound default describe.
 */
export const inboundOrderMachine = createMachine({
  id: 'inboundOrder',
  initial: INBOUND_ORDER_STATUS.DRAFT,
  states: {
    [INBOUND_ORDER_STATUS.DRAFT]: {
      on: {
        [INBOUND_ORDER_EVENTS.APPROVE]: INBOUND_ORDER_STATUS.APPROVED,
        [INBOUND_ORDER_EVENTS.CANCEL]: INBOUND_ORDER_STATUS.CANCELLED,
        // WBS 2.9b round-1 review finding 12: self-transition, no state change.
        [INBOUND_ORDER_EVENTS.SCHEDULE]: INBOUND_ORDER_STATUS.DRAFT,
      },
    },
    [INBOUND_ORDER_STATUS.APPROVED]: {
      on: {
        [INBOUND_ORDER_EVENTS.RECEIVE_LINE_FIRST]: INBOUND_ORDER_STATUS.RECEIVING,
        [INBOUND_ORDER_EVENTS.CANCEL]: INBOUND_ORDER_STATUS.CANCELLED,
        // WBS 2.9b round-1 review finding 12: self-transition, no state change.
        [INBOUND_ORDER_EVENTS.SCHEDULE]: INBOUND_ORDER_STATUS.APPROVED,
      },
    },
    [INBOUND_ORDER_STATUS.RECEIVING]: {
      on: {
        [INBOUND_ORDER_EVENTS.RECEIVE_LINE]: INBOUND_ORDER_STATUS.RECEIVING,
        [INBOUND_ORDER_EVENTS.RECEIVE_LINE_LAST]: INBOUND_ORDER_STATUS.RECEIVED,
        // No CANCEL edge here: cancelling is refused once any line has been received
        // (SCR-WMS-INB-01 §3), whatever the quantity. The one exception is an order whose EVERY
        // line was received at 0, which only exists in 'received' (SCR-WMS-INB-01 §1).
      },
    },
    [INBOUND_ORDER_STATUS.RECEIVED]: {
      on: {
        [INBOUND_ORDER_EVENTS.CONFIRM_PUTAWAY_FIRST]: INBOUND_ORDER_STATUS.PUTAWAY,
        // No CLOSE edge from 'received' — a fully-short order (every line qty_actual = 0) has no
        // put-away to do and must be CANCELLED instead (SCR-WMS-INB-01 §1). CancelInbound's own
        // business rule still refuses this if any line has qty_actual > 0.
        [INBOUND_ORDER_EVENTS.CANCEL]: INBOUND_ORDER_STATUS.CANCELLED,
      },
    },
    [INBOUND_ORDER_STATUS.PUTAWAY]: {
      on: {
        [INBOUND_ORDER_EVENTS.CONFIRM_PUTAWAY]: INBOUND_ORDER_STATUS.PUTAWAY,
        [INBOUND_ORDER_EVENTS.CLOSE]: INBOUND_ORDER_STATUS.CLOSED,
      },
    },
    [INBOUND_ORDER_STATUS.CLOSED]: {
      type: 'final',
    },
    [INBOUND_ORDER_STATUS.CANCELLED]: {
      type: 'final',
    },
  },
});

// the role (identity.roles.code) a command must hold BEFORE it may send this event — read by
// every application command instead of each one hard-coding its own role literal. `undefined`
// (an event absent from this map) means no role gate (e.g. any authenticated internal caller may
// scan a receipt). 13B-Schema-Reference-Consolidation.sql:557 (WH_MGR) / :558 (WH_SUP).
// REPLACE-ON-COPY: the role codes that gate this use case's events (identity.roles.code).
export const INBOUND_EVENT_ROLES: Readonly<Partial<Record<InboundOrderEventType, string>>> = {
  [INBOUND_ORDER_EVENTS.APPROVE]: 'WH_MGR',
  [INBOUND_ORDER_EVENTS.CANCEL]: 'WH_MGR',
  [INBOUND_ORDER_EVENTS.CLOSE]: 'WH_SUP',
};

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API, — never a hand-spread of an internal snapshot shape. */
function actorAt(state: InboundOrderStatus) {
  const snapshot = inboundOrderMachine.resolveState({ value: state });
  return createActor(inboundOrderMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: InboundOrderStatus): InboundOrderEventType[] {
  return Object.values(INBOUND_ORDER_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer (../../application/receive-inbound/*) uses this INSTEAD OF an if/switch on
 * the status string — CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions —
 * XState."
 */
export function canTransition(current: InboundOrderStatus, event: InboundOrderEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * Sends each of `events`, in order, to a single actor started at `current`. THROWS
 * IllegalTransitionError the moment any event in the sequence is not legal in the actor's state at
 * that point — it never skips one silently. Callers (../../application/receive-inbound/*) are
 * responsible for building `events` from ONLY the transitions the current call actually needs
 * (e.g. a single-line order's one ReceiveLine call is simultaneously "first" and "last", so it
 * offers [RECEIVE_LINE_FIRST, RECEIVE_LINE_LAST] and both apply on the SAME actor, landing on
 * 'received' in one call); an empty `events` array is a legitimate "no transition needed" no-op
 * and returns `current` unchanged.
 */
export function advanceInboundOrder(
  current: InboundOrderStatus,
  events: readonly InboundOrderEventType[],
): InboundOrderStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as InboundOrderStatus;
      actor.stop();
      const allowed = allowedEventsFrom(from);
      throw new IllegalTransitionError(
        `${event} is not a legal transition from inbound-order status "${from}". ` +
          `(Allowed from "${from}": ${allowed.length > 0 ? allowed.join(', ') : 'none, terminal state'})`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as InboundOrderStatus;
  actor.stop();
  return result;
}
