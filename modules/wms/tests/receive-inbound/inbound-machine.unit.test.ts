// modules/wms/tests/receive-inbound/inbound-machine.unit.test.ts — WBS 2.9, THE GOLDEN SLICE
// (pg-tester), against the state machine doc 40 §C3 (line ~256) describes.
//
// CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions — XState." This is the pure,
// data-only state machine the application-layer commands (approve-inbound.ts, receive-line.ts,
// confirm-putaway.ts, close-inbound.ts, cancel-inbound.ts) must consult to decide whether a
// transition is legal, instead of hand-written if/switch on `status` strings.
//
// Expected surface — modules/wms/domain/receive-inbound/machine.ts:
//   - `INBOUND_ORDER_STATUS` — the 7-value enum object (draft/approved/receiving/received/
//     putaway/closed/cancelled), verbatim from 01-Data-Model.sql:748 /
//     .claude/briefs/wms.brief.md §3 `inbound_orders.status`.
//   - `INBOUND_ORDER_EVENTS` — the 8 event-type constants this machine accepts.
//   - `inboundOrderMachine` — an XState v5 machine, `id: 'inboundOrder'`,
//     `initial: INBOUND_ORDER_STATUS.DRAFT`, one state per INBOUND_ORDER_STATUS value, exactly
//     the edges in LEGAL_EDGES below and no others.
//
// Table-driven and exhaustive: every one of the 7 states x 8 events = 56 combinations is checked
// via XState v5's own `actor.getSnapshot().can(event)` — never a hand-rolled comparison against a
// parallel if/switch, which would just relocate the CLAUDE.md violation into the test.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  INBOUND_ORDER_EVENTS,
  INBOUND_ORDER_STATUS,
  inboundOrderMachine,
} from '../../domain/receive-inbound/machine.js';

const STATES = Object.values(INBOUND_ORDER_STATUS);
const EVENTS = Object.values(INBOUND_ORDER_EVENTS);

// doc 40 §C3 state machine — the SINGLE source of truth this test's exhaustive table is checked
// against. CloseInbound is legal ONLY from 'putaway'. CancelInbound's machine EDGE exists from
// 'draft', 'approved' and 'received' — NOT from 'receiving'; CancelInbound's own business rule
// (CancelBlockedError when any line has qty_actual > 0) then decides whether a given call from
// 'received' may actually take it (in practice only an all-zero-qty order).
const LEGAL_EDGES: ReadonlyArray<{
  readonly from: string;
  readonly event: string;
  readonly to: string;
}> = [
  { from: INBOUND_ORDER_STATUS.DRAFT, event: INBOUND_ORDER_EVENTS.APPROVE, to: INBOUND_ORDER_STATUS.APPROVED },
  { from: INBOUND_ORDER_STATUS.DRAFT, event: INBOUND_ORDER_EVENTS.CANCEL, to: INBOUND_ORDER_STATUS.CANCELLED },
  // WBS 2.9b round-1 review finding 12: SCHEDULE_INBOUND is a self-transition (no state change),
  // legal from 'draft' and 'approved' only — routed through the machine like every other event.
  { from: INBOUND_ORDER_STATUS.DRAFT, event: INBOUND_ORDER_EVENTS.SCHEDULE, to: INBOUND_ORDER_STATUS.DRAFT },
  {
    from: INBOUND_ORDER_STATUS.APPROVED,
    event: INBOUND_ORDER_EVENTS.RECEIVE_LINE_FIRST,
    to: INBOUND_ORDER_STATUS.RECEIVING,
  },
  { from: INBOUND_ORDER_STATUS.APPROVED, event: INBOUND_ORDER_EVENTS.CANCEL, to: INBOUND_ORDER_STATUS.CANCELLED },
  { from: INBOUND_ORDER_STATUS.APPROVED, event: INBOUND_ORDER_EVENTS.SCHEDULE, to: INBOUND_ORDER_STATUS.APPROVED },
  {
    from: INBOUND_ORDER_STATUS.RECEIVING,
    event: INBOUND_ORDER_EVENTS.RECEIVE_LINE_LAST,
    to: INBOUND_ORDER_STATUS.RECEIVED,
  },
  {
    from: INBOUND_ORDER_STATUS.RECEIVED,
    event: INBOUND_ORDER_EVENTS.CONFIRM_PUTAWAY_FIRST,
    to: INBOUND_ORDER_STATUS.PUTAWAY,
  },
  // Self-transitions: a middle ReceiveLine on 'receiving', a later ConfirmPutaway on 'putaway'.
  { from: INBOUND_ORDER_STATUS.RECEIVING, event: INBOUND_ORDER_EVENTS.RECEIVE_LINE, to: INBOUND_ORDER_STATUS.RECEIVING },
  { from: INBOUND_ORDER_STATUS.PUTAWAY, event: INBOUND_ORDER_EVENTS.CONFIRM_PUTAWAY, to: INBOUND_ORDER_STATUS.PUTAWAY },
  { from: INBOUND_ORDER_STATUS.PUTAWAY, event: INBOUND_ORDER_EVENTS.CLOSE, to: INBOUND_ORDER_STATUS.CLOSED },
  { from: INBOUND_ORDER_STATUS.RECEIVED, event: INBOUND_ORDER_EVENTS.CANCEL, to: INBOUND_ORDER_STATUS.CANCELLED },
];

const LEGAL_EDGE_KEYS = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

function actorAt(state: string) {
  // XState v5: start an actor and immediately re-hydrate it at the target state via its own
  // persisted-snapshot shape — the machine's OWN initial-state snapshot, with `value` overwritten,
  // is what `createActor(machine, { snapshot })` expects (no hand-written transition table).
  const initial = createActor(inboundOrderMachine).getSnapshot();
  const snapshot = { ...initial, value: state };
  return createActor(inboundOrderMachine, { snapshot });
}

describe('inboundOrderMachine — exhaustive legal/illegal transition table (7 states x 8 events)', () => {
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

describe('inboundOrderMachine — the happy-path walk lands on each named state in order', () => {
  it('draft -> approved -> receiving -> received -> putaway -> closed', () => {
    const actor = createActor(inboundOrderMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.DRAFT);

    actor.send({ type: INBOUND_ORDER_EVENTS.APPROVE });
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.APPROVED);

    actor.send({ type: INBOUND_ORDER_EVENTS.RECEIVE_LINE_FIRST });
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.RECEIVING);

    actor.send({ type: INBOUND_ORDER_EVENTS.RECEIVE_LINE_LAST });
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.RECEIVED);

    actor.send({ type: INBOUND_ORDER_EVENTS.CONFIRM_PUTAWAY_FIRST });
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.PUTAWAY);

    actor.send({ type: INBOUND_ORDER_EVENTS.CLOSE });
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.CLOSED);
    actor.stop();
  });

  it('draft -> cancelled is reachable', () => {
    const actor = createActor(inboundOrderMachine);
    actor.start();
    actor.send({ type: INBOUND_ORDER_EVENTS.CANCEL });
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.CANCELLED);
    actor.stop();
  });

  it('approved -> cancelled is reachable', () => {
    const actor = createActor(inboundOrderMachine);
    actor.start();
    actor.send({ type: INBOUND_ORDER_EVENTS.APPROVE });
    actor.send({ type: INBOUND_ORDER_EVENTS.CANCEL });
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.CANCELLED);
    actor.stop();
  });

  it('received -> cancelled is reachable (the machine edge alone — CancelInbound\'s own qty_actual > 0 business rule is exercised at the application layer, not here)', () => {
    const actor = actorAt(INBOUND_ORDER_STATUS.RECEIVED);
    actor.start();
    actor.send({ type: INBOUND_ORDER_EVENTS.CANCEL });
    expect(actor.getSnapshot().value).toBe(INBOUND_ORDER_STATUS.CANCELLED);
    actor.stop();
  });
});

describe('inboundOrderMachine — CANCEL is illegal from "receiving"', () => {
  it('REJECTS CANCEL_INBOUND from "receiving" (the edge does not exist on this machine)', () => {
    const actor = actorAt(INBOUND_ORDER_STATUS.RECEIVING);
    actor.start();
    expect(actor.getSnapshot().can({ type: INBOUND_ORDER_EVENTS.CANCEL })).toBe(false);
    actor.stop();
  });
});

describe('inboundOrderMachine — closed and cancelled are terminal (no event is ever legal)', () => {
  it.each([INBOUND_ORDER_STATUS.CLOSED, INBOUND_ORDER_STATUS.CANCELLED])(
    '%s accepts no event at all',
    (terminalState) => {
      const actor = actorAt(terminalState);
      actor.start();
      for (const event of EVENTS) {
        expect(actor.getSnapshot().can({ type: event })).toBe(false);
      }
      actor.stop();
    },
  );
});
