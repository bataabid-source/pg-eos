// modules/billing/domain/accounting-periods/machine.ts — WBS 4.19 (lane 2).
//
// domain/ layer: pure state-transition rules for billing.accounting_periods.status, no I/O, no Date,
// no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for
// state transitions — XState." The application layer (../../application/accounting-periods/*) asks
// this machine whether an event is legal from the period's current status, never a hand-written
// if/switch on the status string (golden slice: modules/wms/domain/receive-inbound/machine.ts).
//
// Source: ADR-0004 D1 5 ("Periods open/closed/locked per entity") names the three states; D3 OD-12
// ("CFO closes; reopen via Decision Inbox") and the 4.19 brief name the only three edges:
// CLOSE open -> closed, LOCK closed -> locked, REOPEN closed -> open. `locked` is final (4.19
// pre-build review D4). The same edges are enforced in the database by
// billing.guard_accounting_period() (migration 0040).

import { createActor, createMachine } from 'xstate';

import { IllegalPeriodTransitionError } from './errors.js';

/** billing.accounting_periods.status — the 3-value check constraint (ADR-0004 D1 5, verbatim). */
export const PERIOD_STATUS = {
  OPEN: 'open',
  CLOSED: 'closed',
  LOCKED: 'locked',
} as const;

export type PeriodStatus = (typeof PERIOD_STATUS)[keyof typeof PERIOD_STATUS];

/** The 3 event types this machine accepts — one per OD-12 edge. */
export const PERIOD_EVENTS = {
  CLOSE: 'CLOSE_PERIOD',
  LOCK: 'LOCK_PERIOD',
  REOPEN: 'REOPEN_PERIOD',
} as const;

export type PeriodEventType = (typeof PERIOD_EVENTS)[keyof typeof PERIOD_EVENTS];

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, the Decision Inbox, optimistic lock, DB writes); this machine only
 * decides WHETHER one is legal from the current status.
 */
export const periodMachine = createMachine({
  id: 'accountingPeriod',
  initial: PERIOD_STATUS.OPEN,
  states: {
    [PERIOD_STATUS.OPEN]: {
      on: {
        [PERIOD_EVENTS.CLOSE]: PERIOD_STATUS.CLOSED,
      },
    },
    [PERIOD_STATUS.CLOSED]: {
      on: {
        [PERIOD_EVENTS.LOCK]: PERIOD_STATUS.LOCKED,
        // Driven only by applyPeriodReopenDecision, after the Decision Inbox approval (D9).
        [PERIOD_EVENTS.REOPEN]: PERIOD_STATUS.OPEN,
      },
    },
    [PERIOD_STATUS.LOCKED]: {
      type: 'final',
    },
  },
});

// The role (identity.roles.code) a command must hold BEFORE it may send this event (4.19 pre-build
// review D2; OD-12 "CFO closes"; the brief's default names the doc 38 row 4.19 Owner, CFO, for lock
// too). REOPEN has no entry: its approver role is DATA in platform.approval_chains
// ('accounting_period_reopen', step 1), never a literal here (D1).
export const PERIOD_EVENT_ROLES: Readonly<Partial<Record<PeriodEventType, string>>> = {
  [PERIOD_EVENTS.CLOSE]: 'CFO',
  [PERIOD_EVENTS.LOCK]: 'CFO',
};

/** The role CreateFiscalYear requires (4.19 pre-build review D2 — the doc 38 row 4.19 Owner). */
export const FISCAL_YEAR_CREATE_ROLE = 'CFO';

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5). */
function actorAt(state: PeriodStatus) {
  const snapshot = periodMachine.resolveState({ value: state });
  return createActor(periodMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalPeriodTransitionError so the caller learns
 *  what is allowed (doc 36 §5-4 #7). */
export function allowedPeriodEventsFrom(state: PeriodStatus): PeriodEventType[] {
  return Object.values(PERIOD_EVENTS).filter((event) => canTransitionPeriod(state, event));
}

/** True iff `event` is a legal transition from `current` (per the state chart above). */
export function canTransitionPeriod(current: PeriodStatus, event: string): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * Sends each of `events`, in order, to a single actor started at `current`. THROWS
 * IllegalPeriodTransitionError the moment any event is not legal in the actor's state at that
 * point, naming the FROM state and the allowed-events list (`[]` for the terminal 'locked'). An
 * empty `events` array is a no-op and returns `current` unchanged.
 */
export function advancePeriodStatus(current: PeriodStatus, events: readonly string[]): PeriodStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as PeriodStatus;
      actor.stop();
      throw new IllegalPeriodTransitionError(
        `${event} is not a legal transition from accounting-period status "${from}". ` +
          `(Allowed from "${from}": [${allowedPeriodEventsFrom(from).join(', ')}])`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as PeriodStatus;
  actor.stop();
  return result;
}
