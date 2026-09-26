// modules/wms/domain/process-outbound/machine.ts — WBS 2.11 part 1, copied from the golden slice
// (../../domain/receive-inbound/machine.ts).
//
// domain/ layer: pure state-transition rules for wms.outbound_orders.status, no I/O, no Date, no
// Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for state
// transitions — XState." The application layer (../../application/process-outbound/*) asks this
// machine whether an event is legal via `canTransition`/`advanceOutboundOrder`, never a
// hand-written if/switch on the status string.
//
// `OUTBOUND_ORDER_STATUS` is verbatim from `chk_outbound_orders_status`
// (13B-Schema-Reference-Consolidation.sql:2326-2327) — all 14 values. This part (brief Master
// decision 1) builds ONLY:
//   draft --RUN_CHECKS_PASS--> checks_pending
//   draft --RUN_CHECKS_CREDIT_FAIL--> credit_rejected
//   checks_pending --APPROVE--> approved
//   {draft, checks_pending, credit_rejected, approved} --CANCEL--> cancelled
// Part 2 (_slice-2.11.brief.md part 2, Master decision 1) ADDS:
//   approved --ALLOCATE_FULL--> allocated
//   approved --ALLOCATE_PARTIAL--> partially_allocated
//   {allocated, partially_allocated} --CANCEL--> cancelled
// WBS 2.12 part 1 (_slice-2.12.brief.md, Master decision 1) ADDS:
//   {allocated, partially_allocated} --START_PICKING--> picking
//   picking --COMPLETE_PICKING--> picked
//   picked --CHECK--> checked
// Every other status (packed, loaded, dispatched, delivered) is still a legal enum VALUE with NO
// producing/outgoing edge (part 2's job) — `canTransition`/`allowedEventsFrom` treat those states
// exactly like a foreign status: no event is ever legal from them here.

import { createActor, createMachine } from 'xstate';

import { IllegalTransitionError } from './errors.js';

/** wms.outbound_orders.status — the 14-value check constraint, verbatim
 *  (13B-Schema-Reference-Consolidation.sql:2326-2327). */
export const OUTBOUND_ORDER_STATUS = {
  DRAFT: 'draft',
  CHECKS_PENDING: 'checks_pending',
  CREDIT_REJECTED: 'credit_rejected',
  APPROVED: 'approved',
  ALLOCATED: 'allocated',
  PARTIALLY_ALLOCATED: 'partially_allocated',
  PICKING: 'picking',
  PICKED: 'picked',
  CHECKED: 'checked',
  PACKED: 'packed',
  LOADED: 'loaded',
  DISPATCHED: 'dispatched',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
} as const;

export type OutboundOrderStatus = (typeof OUTBOUND_ORDER_STATUS)[keyof typeof OUTBOUND_ORDER_STATUS];

/** The 9 event types this machine accepts (2.11 part 1's own 4 + part 2's own 2 —
 *  ALLOCATE_FULL/ALLOCATE_PARTIAL — + 2.12 part 1's own 3 — START_PICKING/COMPLETE_PICKING/CHECK). */
export const OUTBOUND_ORDER_EVENTS = {
  RUN_CHECKS_PASS: 'RUN_CHECKS_PASS',
  RUN_CHECKS_CREDIT_FAIL: 'RUN_CHECKS_CREDIT_FAIL',
  APPROVE: 'APPROVE_OUTBOUND',
  CANCEL: 'CANCEL_OUTBOUND',
  ALLOCATE_FULL: 'ALLOCATE_FULL',
  ALLOCATE_PARTIAL: 'ALLOCATE_PARTIAL',
  START_PICKING: 'START_PICKING',
  COMPLETE_PICKING: 'COMPLETE_PICKING',
  CHECK: 'CHECK_ORDER',
} as const;

export type OutboundOrderEventType = (typeof OUTBOUND_ORDER_EVENTS)[keyof typeof OUTBOUND_ORDER_EVENTS];

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes); this machine only decides WHETHER
 * one is legal from the current status. One state per OUTBOUND_ORDER_STATUS value; only the five
 * states this part touches (draft, checks_pending, credit_rejected, approved, cancelled) carry an
 * `on` block — every other status is declared with none, so no event is ever legal from it here.
 */
export const outboundOrderMachine = createMachine({
  id: 'outboundOrder',
  initial: OUTBOUND_ORDER_STATUS.DRAFT,
  states: {
    [OUTBOUND_ORDER_STATUS.DRAFT]: {
      on: {
        [OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS]: OUTBOUND_ORDER_STATUS.CHECKS_PENDING,
        [OUTBOUND_ORDER_EVENTS.RUN_CHECKS_CREDIT_FAIL]: OUTBOUND_ORDER_STATUS.CREDIT_REJECTED,
        [OUTBOUND_ORDER_EVENTS.CANCEL]: OUTBOUND_ORDER_STATUS.CANCELLED,
      },
    },
    [OUTBOUND_ORDER_STATUS.CHECKS_PENDING]: {
      on: {
        [OUTBOUND_ORDER_EVENTS.APPROVE]: OUTBOUND_ORDER_STATUS.APPROVED,
        [OUTBOUND_ORDER_EVENTS.CANCEL]: OUTBOUND_ORDER_STATUS.CANCELLED,
      },
    },
    [OUTBOUND_ORDER_STATUS.CREDIT_REJECTED]: {
      on: {
        [OUTBOUND_ORDER_EVENTS.CANCEL]: OUTBOUND_ORDER_STATUS.CANCELLED,
      },
    },
    [OUTBOUND_ORDER_STATUS.APPROVED]: {
      on: {
        [OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL]: OUTBOUND_ORDER_STATUS.ALLOCATED,
        [OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL]: OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED,
        [OUTBOUND_ORDER_EVENTS.CANCEL]: OUTBOUND_ORDER_STATUS.CANCELLED,
      },
    },
    // Part 2 (brief Master decision 1): the CANCEL release path — {allocated, partially_allocated}
    // now carry a CANCEL edge. No OTHER event is legal from either (no re-allocation).
    [OUTBOUND_ORDER_STATUS.ALLOCATED]: {
      on: {
        [OUTBOUND_ORDER_EVENTS.CANCEL]: OUTBOUND_ORDER_STATUS.CANCELLED,
        [OUTBOUND_ORDER_EVENTS.START_PICKING]: OUTBOUND_ORDER_STATUS.PICKING,
      },
    },
    [OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED]: {
      on: {
        [OUTBOUND_ORDER_EVENTS.CANCEL]: OUTBOUND_ORDER_STATUS.CANCELLED,
        [OUTBOUND_ORDER_EVENTS.START_PICKING]: OUTBOUND_ORDER_STATUS.PICKING,
      },
    },
    // WBS 2.12 part 1 (brief Master decision 1): {allocated, partially_allocated} --START_PICKING-->
    // picking --COMPLETE_PICKING--> picked --CHECK--> checked. PackOrder/LoadOrder (part 2) add no
    // edge here yet.
    [OUTBOUND_ORDER_STATUS.PICKING]: {
      on: {
        [OUTBOUND_ORDER_EVENTS.COMPLETE_PICKING]: OUTBOUND_ORDER_STATUS.PICKED,
      },
    },
    [OUTBOUND_ORDER_STATUS.PICKED]: {
      on: {
        [OUTBOUND_ORDER_EVENTS.CHECK]: OUTBOUND_ORDER_STATUS.CHECKED,
      },
    },
    [OUTBOUND_ORDER_STATUS.CHECKED]: {},
    [OUTBOUND_ORDER_STATUS.PACKED]: {},
    [OUTBOUND_ORDER_STATUS.LOADED]: {},
    [OUTBOUND_ORDER_STATUS.DISPATCHED]: {},
    [OUTBOUND_ORDER_STATUS.DELIVERED]: {},
    [OUTBOUND_ORDER_STATUS.CANCELLED]: {
      type: 'final',
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState`. */
function actorAt(state: OutboundOrderStatus) {
  const snapshot = outboundOrderMachine.resolveState({ value: state });
  return createActor(outboundOrderMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: OutboundOrderStatus): OutboundOrderEventType[] {
  return Object.values(OUTBOUND_ORDER_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer (../../application/process-outbound/*) uses this INSTEAD OF an if/switch on
 * the status string — CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions —
 * XState."
 */
export function canTransition(current: OutboundOrderStatus, event: OutboundOrderEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * Sends each of `events`, in order, to a single actor started at `current`. THROWS
 * IllegalTransitionError the moment any event in the sequence is not legal in the actor's state at
 * that point. An empty `events` array is a legitimate "no transition needed" no-op and returns
 * `current` unchanged.
 */
export function advanceOutboundOrder(
  current: OutboundOrderStatus,
  events: readonly OutboundOrderEventType[],
): OutboundOrderStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as OutboundOrderStatus;
      actor.stop();
      const allowed = allowedEventsFrom(from);
      throw new IllegalTransitionError(
        `${event} is not a legal transition from outbound-order status "${from}". ` +
          `(Allowed from "${from}": ${allowed.length > 0 ? allowed.join(', ') : 'none, terminal state'})`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as OutboundOrderStatus;
  actor.stop();
  return result;
}

// the role (identity.roles.code) a command must hold BEFORE it may send this event.
// `undefined` means no role gate. 13B-Schema-Reference-Consolidation.sql (WH_MGR).
export const OUTBOUND_EVENT_ROLES: Readonly<Partial<Record<OutboundOrderEventType, string>>> = {
  [OUTBOUND_ORDER_EVENTS.APPROVE]: 'WH_MGR',
  [OUTBOUND_ORDER_EVENTS.CANCEL]: 'WH_MGR',
};
