// modules/hr/domain/register-employee/machine.ts — WBS 3.3.
//
// domain/ layer: pure state-transition rules for hr.employees.status, no I/O, no Date, no
// Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for
// state transitions — XState." ../../application/register-employee/change-employee-status.ts asks
// this machine whether an event is legal from the employee's current status via
// `actor.getSnapshot().can({ type })`, never a hand-written if/switch on the status string.
//
// Source: 01-Data-Model.sql:1279 `hr.employees.status` (chk_employees_status, 13B:2445) — 4-value
// check constraint (active · on_leave · suspended · terminated). Edges are slice-3.3 brief D7:
// active <-> on_leave, active <-> suspended, {active, on_leave, suspended} -> terminated
// (terminal). on_leave -> suspended and suspended -> on_leave are BOTH illegal — a status must
// pass through 'active' first.
//
// Shape copied from the golden slice's own machine.ts (modules/wms/domain/receive-inbound/
// machine.ts): a status enum, an events enum, and a single flat XState v5 machine consulted only
// through `.can()`.

import { createActor, createMachine } from 'xstate';

import { IllegalTransitionError } from './errors.js';

/** hr.employees.status — the 4-value check constraint, verbatim (01-Data-Model.sql:1279,
 *  chk_employees_status 13B:2445). */
export const EMPLOYEE_STATUS = {
  ACTIVE: 'active',
  ON_LEAVE: 'on_leave',
  SUSPENDED: 'suspended',
  TERMINATED: 'terminated',
} as const;

export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[keyof typeof EMPLOYEE_STATUS];

/** One event per TARGET status — ChangeEmployeeStatus sends the event named after the caller's
 *  requested newStatus (see EMPLOYEE_STATUS_TO_EVENT below). */
export const EMPLOYEE_EVENTS = {
  TO_ACTIVE: 'TO_ACTIVE',
  TO_ON_LEAVE: 'TO_ON_LEAVE',
  TO_SUSPENDED: 'TO_SUSPENDED',
  TO_TERMINATED: 'TO_TERMINATED',
} as const;

export type EmployeeEventType = (typeof EMPLOYEE_EVENTS)[keyof typeof EMPLOYEE_EVENTS];

/** Every EmployeeStatus maps to exactly the event ChangeEmployeeStatus sends to reach it — the
 *  application layer never string-concatenates `TO_${newStatus}`. */
export const EMPLOYEE_STATUS_TO_EVENT: Readonly<Record<EmployeeStatus, EmployeeEventType>> = {
  [EMPLOYEE_STATUS.ACTIVE]: EMPLOYEE_EVENTS.TO_ACTIVE,
  [EMPLOYEE_STATUS.ON_LEAVE]: EMPLOYEE_EVENTS.TO_ON_LEAVE,
  [EMPLOYEE_STATUS.SUSPENDED]: EMPLOYEE_EVENTS.TO_SUSPENDED,
  [EMPLOYEE_STATUS.TERMINATED]: EMPLOYEE_EVENTS.TO_TERMINATED,
};

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes); this machine only decides WHETHER
 * one is legal from the current status. `id: 'employee'`, one state per EMPLOYEE_STATUS value,
 * exactly the edges brief D7 describes.
 */
export const employeeMachine = createMachine({
  id: 'employee',
  initial: EMPLOYEE_STATUS.ACTIVE,
  states: {
    [EMPLOYEE_STATUS.ACTIVE]: {
      on: {
        [EMPLOYEE_EVENTS.TO_ON_LEAVE]: EMPLOYEE_STATUS.ON_LEAVE,
        [EMPLOYEE_EVENTS.TO_SUSPENDED]: EMPLOYEE_STATUS.SUSPENDED,
        [EMPLOYEE_EVENTS.TO_TERMINATED]: EMPLOYEE_STATUS.TERMINATED,
      },
    },
    [EMPLOYEE_STATUS.ON_LEAVE]: {
      on: {
        [EMPLOYEE_EVENTS.TO_ACTIVE]: EMPLOYEE_STATUS.ACTIVE,
        [EMPLOYEE_EVENTS.TO_TERMINATED]: EMPLOYEE_STATUS.TERMINATED,
        // No TO_SUSPENDED edge here — a status must pass through 'active' first (brief D7).
      },
    },
    [EMPLOYEE_STATUS.SUSPENDED]: {
      on: {
        [EMPLOYEE_EVENTS.TO_ACTIVE]: EMPLOYEE_STATUS.ACTIVE,
        [EMPLOYEE_EVENTS.TO_TERMINATED]: EMPLOYEE_STATUS.TERMINATED,
        // No TO_ON_LEAVE edge here — same rule, symmetric.
      },
    },
    [EMPLOYEE_STATUS.TERMINATED]: {
      type: 'final',
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: EmployeeStatus) {
  const snapshot = employeeMachine.resolveState({ value: state });
  return createActor(employeeMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: EmployeeStatus): EmployeeEventType[] {
  return Object.values(EMPLOYEE_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer (../../application/register-employee/change-employee-status.ts) uses this
 * INSTEAD OF an if/switch on the status string — CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for
 * state transitions — XState."
 */
export function canTransition(current: EmployeeStatus, event: EmployeeEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * Sends each of `events`, in order, to a single actor started at `current`. THROWS
 * IllegalTransitionError the moment any event in the sequence is not legal in the actor's state at
 * that point. ChangeEmployeeStatus (../../application/register-employee/change-employee-status.ts)
 * always sends exactly one event (the target status's own), but the sequence form is kept for
 * parity with the golden slice's own advanceInboundOrder.
 */
export function advanceEmployeeStatus(
  current: EmployeeStatus,
  events: readonly EmployeeEventType[],
): EmployeeStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as EmployeeStatus;
      actor.stop();
      const allowed = allowedEventsFrom(from);
      throw new IllegalTransitionError(
        `${event} is not a legal transition from employee status "${from}". ` +
          `(Allowed from "${from}": ${allowed.length > 0 ? allowed.join(', ') : 'none, terminal state'})`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as EmployeeStatus;
  actor.stop();
  return result;
}
