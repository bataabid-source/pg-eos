// modules/hr/tests/register-employee/employee-machine.unit.test.ts — WBS 3.3.
//
// CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions — XState." This is the pure,
// data-only state machine ChangeEmployeeStatus (../../application/register-employee/change-employee-status.ts)
// must consult to decide whether a requested status transition is legal, instead of a hand-written
// if/switch on `status` strings.
//
// Expected surface — modules/hr/domain/register-employee/machine.ts:
//   - `EMPLOYEE_STATUS` — the 4-value enum object (active/on_leave/suspended/terminated), verbatim
//     from database/schema/01-Data-Model.sql:1279 `hr.employees.status` (chk_employees_status,
//     13B:2445).
//   - `EMPLOYEE_EVENTS` — 4 event-type constants, one per TARGET status: `TO_ACTIVE`,
//     `TO_ON_LEAVE`, `TO_SUSPENDED`, `TO_TERMINATED` — ChangeEmployeeStatus sends the event named
//     after the caller's requested newStatus.
//   - `employeeMachine` — an XState v5 machine, `id: 'employee'`, `initial: EMPLOYEE_STATUS.ACTIVE`,
//     one state per EMPLOYEE_STATUS value, exactly the edges in LEGAL_EDGES below (slice-3.3 brief
//     D7) and no others: active <-> on_leave, active <-> suspended, {active, on_leave, suspended}
//     -> terminated (terminal, no edge back). on_leave -> suspended and suspended -> on_leave are
//     BOTH illegal — a status must pass through 'active' first.
//
// Table-driven and exhaustive: every one of the 4 states x 4 events = 16 combinations is checked
// via XState v5's own `actor.getSnapshot().can(event)` — never a hand-rolled comparison against a
// parallel if/switch, which would just relocate the CLAUDE.md violation into the test.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { EMPLOYEE_EVENTS, EMPLOYEE_STATUS, employeeMachine } from '../../domain/register-employee/machine.js';

const STATES = Object.values(EMPLOYEE_STATUS);
const EVENTS = Object.values(EMPLOYEE_EVENTS);

// slice-3.3 brief D7 — the SINGLE source of truth this test's exhaustive table is checked against.
const LEGAL_EDGES: ReadonlyArray<{ readonly from: string; readonly event: string; readonly to: string }> = [
  { from: EMPLOYEE_STATUS.ACTIVE, event: EMPLOYEE_EVENTS.TO_ON_LEAVE, to: EMPLOYEE_STATUS.ON_LEAVE },
  { from: EMPLOYEE_STATUS.ACTIVE, event: EMPLOYEE_EVENTS.TO_SUSPENDED, to: EMPLOYEE_STATUS.SUSPENDED },
  { from: EMPLOYEE_STATUS.ACTIVE, event: EMPLOYEE_EVENTS.TO_TERMINATED, to: EMPLOYEE_STATUS.TERMINATED },
  { from: EMPLOYEE_STATUS.ON_LEAVE, event: EMPLOYEE_EVENTS.TO_ACTIVE, to: EMPLOYEE_STATUS.ACTIVE },
  { from: EMPLOYEE_STATUS.ON_LEAVE, event: EMPLOYEE_EVENTS.TO_TERMINATED, to: EMPLOYEE_STATUS.TERMINATED },
  { from: EMPLOYEE_STATUS.SUSPENDED, event: EMPLOYEE_EVENTS.TO_ACTIVE, to: EMPLOYEE_STATUS.ACTIVE },
  { from: EMPLOYEE_STATUS.SUSPENDED, event: EMPLOYEE_EVENTS.TO_TERMINATED, to: EMPLOYEE_STATUS.TERMINATED },
];

const LEGAL_EDGE_KEYS = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

function actorAt(state: string) {
  const initial = createActor(employeeMachine).getSnapshot();
  const snapshot = { ...initial, value: state };
  return createActor(employeeMachine, { snapshot });
}

describe('employeeMachine — exhaustive legal/illegal transition table (4 states x 4 events)', () => {
  for (const from of STATES) {
    for (const event of EVENTS) {
      const isLegal = LEGAL_EDGE_KEYS.has(`${from}|${event}`);
      const label = isLegal ? 'ALLOWS' : 'REJECTS';

      it(`${label} ${event} from ${from}`, () => {
        const actor = actorAt(from);
        actor.start();
        expect(actor.getSnapshot().can({ type: event })).toBe(isLegal);
        actor.stop();
      });
    }
  }
});

describe('employeeMachine — every D7 edge is individually reachable', () => {
  it('active -> on_leave -> active', () => {
    const actor = createActor(employeeMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(EMPLOYEE_STATUS.ACTIVE);
    actor.send({ type: EMPLOYEE_EVENTS.TO_ON_LEAVE });
    expect(actor.getSnapshot().value).toBe(EMPLOYEE_STATUS.ON_LEAVE);
    actor.send({ type: EMPLOYEE_EVENTS.TO_ACTIVE });
    expect(actor.getSnapshot().value).toBe(EMPLOYEE_STATUS.ACTIVE);
    actor.stop();
  });

  it('active -> suspended -> active', () => {
    const actor = createActor(employeeMachine);
    actor.start();
    actor.send({ type: EMPLOYEE_EVENTS.TO_SUSPENDED });
    expect(actor.getSnapshot().value).toBe(EMPLOYEE_STATUS.SUSPENDED);
    actor.send({ type: EMPLOYEE_EVENTS.TO_ACTIVE });
    expect(actor.getSnapshot().value).toBe(EMPLOYEE_STATUS.ACTIVE);
    actor.stop();
  });

  it.each([EMPLOYEE_STATUS.ACTIVE, EMPLOYEE_STATUS.ON_LEAVE, EMPLOYEE_STATUS.SUSPENDED])(
    '%s -> terminated is reachable',
    (from) => {
      const actor = actorAt(from);
      actor.start();
      actor.send({ type: EMPLOYEE_EVENTS.TO_TERMINATED });
      expect(actor.getSnapshot().value).toBe(EMPLOYEE_STATUS.TERMINATED);
      actor.stop();
    },
  );
});

describe('employeeMachine — on_leave and suspended never transition directly into each other', () => {
  it('REJECTS TO_SUSPENDED from on_leave (must pass through active)', () => {
    const actor = actorAt(EMPLOYEE_STATUS.ON_LEAVE);
    actor.start();
    expect(actor.getSnapshot().can({ type: EMPLOYEE_EVENTS.TO_SUSPENDED })).toBe(false);
    actor.stop();
  });

  it('REJECTS TO_ON_LEAVE from suspended (must pass through active)', () => {
    const actor = actorAt(EMPLOYEE_STATUS.SUSPENDED);
    actor.start();
    expect(actor.getSnapshot().can({ type: EMPLOYEE_EVENTS.TO_ON_LEAVE })).toBe(false);
    actor.stop();
  });
});

describe('employeeMachine — terminated is terminal (no event is ever legal)', () => {
  it('accepts no event at all', () => {
    const actor = actorAt(EMPLOYEE_STATUS.TERMINATED);
    actor.start();
    for (const event of EVENTS) {
      expect(actor.getSnapshot().can({ type: event })).toBe(false);
    }
    actor.stop();
  });
});
