// modules/wms/domain/count-inventory/machine.ts — WBS 2.13 (lane 2).
//
// domain/ layer: pure state-transition rules for wms.inventory_counts.status, no I/O, no Date, no
// Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for state
// transitions — XState." The application layer (../../application/count-inventory/*) asks this
// machine whether an event is legal via `actor.getSnapshot().can({ type })`, never a hand-written
// if/switch on the status string. Same shape as the golden slice's own
// ../receive-inbound/machine.ts.
//
// Source: brief D1 (verbatim) — draft -> in_progress (StartCount) -> review (auto, every line
// counted) -> recount (auto, Recount first called on a variant line) -> review (auto, every
// variant line recounted) -> adjusted (AdjustCount). `closed` (chk_inventory_counts_status'
// sixth value) has NO edge into it from any of the four named commands (doc 40 line 260 names no
// fifth "CloseCount" command) — out of scope for this slice.
//
// `INVENTORY_COUNT_STATUS` is verbatim from chk_inventory_counts_status
// (database/schema/13B-Schema-Reference-Consolidation.sql:2333-2335).
//
// Two extra self-loop events, `COUNT_LINE` and `RECOUNT_LINE`, gate "may a line be written right
// now" for CountLocation/Recount (../../application/count-inventory/{count-location,recount}.ts) —
// CLAUDE.md · ARCHITECTURE: "No if/switch for state transitions — XState." Neither event changes
// `status`; each is legal from exactly the statuses its command already required via a hand-written
// if/else before this fix, matching the golden slice's cancel-inbound.ts:59 / receive-line.ts:113
// `canTransition` pattern.

import { createActor, createMachine } from 'xstate';

import { IllegalTransitionError } from './errors.js';

/** wms.inventory_counts.status — the 6-value check constraint, verbatim (chk_inventory_counts_status). */
export const INVENTORY_COUNT_STATUS = {
  DRAFT: 'draft',
  IN_PROGRESS: 'in_progress',
  REVIEW: 'review',
  RECOUNT: 'recount',
  ADJUSTED: 'adjusted',
  CLOSED: 'closed',
} as const;

export type InventoryCountStatus = (typeof INVENTORY_COUNT_STATUS)[keyof typeof INVENTORY_COUNT_STATUS];

/** The 5 status-changing event types (brief D1) plus 2 self-loop "may this command write a line
 *  right now" gates (COUNT_LINE, RECOUNT_LINE — see the file header). */
export const INVENTORY_COUNT_EVENTS = {
  START: 'START_COUNT',
  COMPLETE: 'COMPLETE_COUNT',
  FLAG_RECOUNT: 'FLAG_RECOUNT',
  RECOUNT_COMPLETE: 'RECOUNT_COMPLETE',
  ADJUST: 'ADJUST_COUNT',
  COUNT_LINE: 'COUNT_LINE',
  RECOUNT_LINE: 'RECOUNT_LINE',
} as const;

export type InventoryCountEventType = (typeof INVENTORY_COUNT_EVENTS)[keyof typeof INVENTORY_COUNT_EVENTS];

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes); this machine only decides WHETHER
 * one is legal from the current status. `id: 'inventoryCount'`, one state per
 * INVENTORY_COUNT_STATUS value, the 5 status-changing edges brief D1 describes (START, COMPLETE,
 * FLAG_RECOUNT, RECOUNT_COMPLETE, ADJUST) plus the 3 self-loop "may this command write a line
 * right now" gates (COUNT_LINE on 'in_progress'; RECOUNT_LINE on 'review' and on 'recount') — 8
 * edges total, and no others; in particular no edge of any kind reaches or leaves 'closed'.
 */
export const inventoryCountMachine = createMachine({
  id: 'inventoryCount',
  initial: INVENTORY_COUNT_STATUS.DRAFT,
  states: {
    [INVENTORY_COUNT_STATUS.DRAFT]: {
      on: {
        [INVENTORY_COUNT_EVENTS.START]: INVENTORY_COUNT_STATUS.IN_PROGRESS,
      },
    },
    [INVENTORY_COUNT_STATUS.IN_PROGRESS]: {
      on: {
        [INVENTORY_COUNT_EVENTS.COMPLETE]: INVENTORY_COUNT_STATUS.REVIEW,
        // CountLocation writes a line only while 'in_progress' — self-loop, status unchanged.
        [INVENTORY_COUNT_EVENTS.COUNT_LINE]: INVENTORY_COUNT_STATUS.IN_PROGRESS,
      },
    },
    [INVENTORY_COUNT_STATUS.REVIEW]: {
      on: {
        [INVENTORY_COUNT_EVENTS.FLAG_RECOUNT]: INVENTORY_COUNT_STATUS.RECOUNT,
        [INVENTORY_COUNT_EVENTS.ADJUST]: INVENTORY_COUNT_STATUS.ADJUSTED,
        // Recount writes a line while 'review' or 'recount' — self-loop, status unchanged (the
        // review->recount/recount->review transition itself still goes through FLAG_RECOUNT /
        // RECOUNT_COMPLETE, sent alongside this one in the same call — see recount.ts).
        [INVENTORY_COUNT_EVENTS.RECOUNT_LINE]: INVENTORY_COUNT_STATUS.REVIEW,
      },
    },
    [INVENTORY_COUNT_STATUS.RECOUNT]: {
      on: {
        [INVENTORY_COUNT_EVENTS.RECOUNT_COMPLETE]: INVENTORY_COUNT_STATUS.REVIEW,
        [INVENTORY_COUNT_EVENTS.RECOUNT_LINE]: INVENTORY_COUNT_STATUS.RECOUNT,
      },
    },
    [INVENTORY_COUNT_STATUS.ADJUSTED]: {
      type: 'final',
    },
    [INVENTORY_COUNT_STATUS.CLOSED]: {
      type: 'final',
      // No command in this slice ever sends an event while a count is 'closed', and no legal
      // edge in this chart ever transitions INTO 'closed' — this state exists only so
      // INVENTORY_COUNT_STATUS' 6th value has a corresponding machine state (brief D1).
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: InventoryCountStatus) {
  const snapshot = inventoryCountMachine.resolveState({ value: state });
  return createActor(inventoryCountMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: InventoryCountStatus): InventoryCountEventType[] {
  return Object.values(INVENTORY_COUNT_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer (../../application/count-inventory/*) uses this INSTEAD OF an if/switch on
 * the status string — CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions —
 * XState."
 */
export function canTransition(current: InventoryCountStatus, event: InventoryCountEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * Sends each of `events`, in order, to a single actor started at `current`. THROWS
 * IllegalTransitionError the moment any event in the sequence is not legal in the actor's state at
 * that point. Callers (../../application/count-inventory/*) build `events` from ONLY the
 * transition(s) the current call actually needs. Most commands send at most one event per call;
 * StartCount and Recount are the two exceptions — each may legally send TWO events in one call
 * (StartCount: START then, when the snapshot has zero lines, also COMPLETE, landing directly in
 * 'review'; Recount: FLAG_RECOUNT and/or RECOUNT_COMPLETE, see recount.ts) so a count can never
 * get stuck mid-flow.
 */
export function advanceInventoryCount(
  current: InventoryCountStatus,
  events: readonly InventoryCountEventType[],
): InventoryCountStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as InventoryCountStatus;
      actor.stop();
      const allowed = allowedEventsFrom(from);
      throw new IllegalTransitionError(
        `${event} is not a legal transition from inventory-count status "${from}". ` +
          `(Allowed from "${from}": ${allowed.length > 0 ? allowed.join(', ') : 'none, terminal state'})`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as InventoryCountStatus;
  actor.stop();
  return result;
}
