// modules/platform/domain/evaluate-alerts/machine.ts — WBS 5.13 part 1, replicated (shape only)
// from the golden slice's machine.ts (modules/wms/domain/receive-inbound/machine.ts) — this use
// case's state machine is a platform.alert_log row's own lifecycle, not an inbound order's.
//
// domain/ layer: pure state-transition rules for platform.alert_log's own lifecycle, no I/O, no
// Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch
// for state transitions — XState." The application layer
// (../../application/evaluate-alerts/acknowledge-alert.ts) asks this machine whether ACKNOWLEDGE
// is legal from the row's current status via `canTransition`, never a hand-written if/switch on
// `acknowledged_at`/`escalated_at`/`resolved_at` being null or not.
//
// Part 1 scope (slice brief "Explicitly OUT of scope"): only fired -> acknowledged is exercised.
// ESCALATED/RESOLVED mirror the table's own escalated_at/resolved_at columns and are declared for
// forward-shape, but no transition into or out of them is offered yet — that is part 2
// (escalation execution) work.

import { createActor, createMachine } from 'xstate';

/** platform.alert_log's own lifecycle — fired_at/acknowledged_at/escalated_at/resolved_at
 *  (13B L519-529, migration 0011). */
export const ALERT_LOG_STATUS = {
  FIRED: 'fired',
  ACKNOWLEDGED: 'acknowledged',
  ESCALATED: 'escalated',
  RESOLVED: 'resolved',
} as const;

export type AlertLogStatus = (typeof ALERT_LOG_STATUS)[keyof typeof ALERT_LOG_STATUS];

/** Part 1 declares only the one event its own commands send. */
export const ALERT_LOG_EVENTS = {
  ACKNOWLEDGE: 'ACKNOWLEDGE',
} as const;

export type AlertLogEventType = (typeof ALERT_LOG_EVENTS)[keyof typeof ALERT_LOG_EVENTS];

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes); this machine only decides WHETHER
 * one is legal from the current status. `id: 'alertLog'`, initial 'fired'. `acknowledged`,
 * `escalated` and `resolved` offer no outgoing edges yet (part 1 scope) — re-acknowledging is a
 * domain error (AlertAlreadyAcknowledgedError), not a machine transition.
 */
export const alertLogMachine = createMachine({
  id: 'alertLog',
  initial: ALERT_LOG_STATUS.FIRED,
  states: {
    [ALERT_LOG_STATUS.FIRED]: {
      on: {
        [ALERT_LOG_EVENTS.ACKNOWLEDGE]: ALERT_LOG_STATUS.ACKNOWLEDGED,
      },
    },
    [ALERT_LOG_STATUS.ACKNOWLEDGED]: {},
    [ALERT_LOG_STATUS.ESCALATED]: {},
    [ALERT_LOG_STATUS.RESOLVED]: {},
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: AlertLogStatus) {
  const snapshot = alertLogMachine.resolveState({ value: state });
  return createActor(alertLogMachine, { snapshot });
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer (../../application/evaluate-alerts/acknowledge-alert.ts) uses this INSTEAD OF
 * an if/switch on `acknowledged_at` being null — CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for
 * state transitions — XState."
 */
export function canTransition(current: AlertLogStatus, event: AlertLogEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}
