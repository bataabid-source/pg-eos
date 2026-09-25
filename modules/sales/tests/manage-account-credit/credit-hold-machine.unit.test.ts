// modules/sales/tests/manage-account-credit/credit-hold-machine.unit.test.ts — WBS 1.8, M02 sales.
//
// pg-reviewer fix round 1, finding 1: the credit-hold machine (domain/manage-account-credit/machine.ts,
// added on review — states `clear`/`held`, events `SET_HOLD`/`RELEASE`, tag `blocksOrders` on
// `held`) needs its own exhaustive unit test, mirroring
// modules/sales/tests/manage-contract/contract-machine.unit.test.ts's shape. No I/O — pure domain/
// unit test.
//
// ACTUAL production surface — modules/sales/domain/manage-account-credit/machine.ts (read, not
// guessed — pg-backend built this concurrently under a different Master decision than this file's
// FIRST draft assumed; names below are copied verbatim from the real file):
//   - `CREDIT_STATUS` — { CLEAR: 'clear', HELD: 'held' }.
//   - `CREDIT_EVENTS` — { SET_HOLD: 'SET_HOLD', RELEASE: 'RELEASE' }.
//   - `creditMachine` — `id: 'credit'`, `initial: CREDIT_STATUS.CLEAR`, one state per CREDIT_STATUS
//     value, exactly the 3 edges below and no others.
//   - `CREDIT_TAG_BLOCKS_ORDERS` — the `held` state's own tag — ONLY `held` carries it.
//   - `creditStateFromRow({ creditHold }): CreditStatus` — the ONE place the boolean-to-state
//     mapping happens.
//   - `canTransition(current, event): boolean` — asks the machine via `.can()`.
//   - `hasCreditTag(state, tag): boolean` — asks the machine via `.hasTag()`.
//   - `assertReleaseLegal(state): void` — throws NotOnHoldError (../errors.js) iff RELEASE is not a
//     legal transition from `state` (i.e. `state` is `clear`); returns (no throw) iff legal.
//
// LEGAL EDGES (the SINGLE source of truth this exhaustive table is checked against — only the
// named edges are legal, every other (state, event) pair REJECTS):
//   clear --SET_HOLD--> held
//   held  --SET_HOLD--> held   (self — re-placing an active hold updates it, Master decision 3)
//   held  --RELEASE-->  clear
// clear --RELEASE--> has NO edge in the chart — `assertReleaseLegal` turns that absence into
// NotOnHoldError at the application layer; this file proves the CHART fact, ./invariants.property.test.ts
// (assertOnHold) proves the thrown-error fact.
//
// Exhaustive: every one of the 2 states x 2 events = 4 combinations is checked via XState v5's own
// `actor.getSnapshot().can(event)` — never a hand-rolled comparison.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  CREDIT_EVENTS,
  CREDIT_STATUS,
  CREDIT_TAG_BLOCKS_ORDERS,
  creditMachine,
  assertReleaseLegal,
  canTransition,
  creditStateFromRow,
  hasCreditTag,
} from '../../domain/manage-account-credit/machine.js';
import { NotOnHoldError } from '../../domain/manage-account-credit/errors.js';

const STATES = Object.values(CREDIT_STATUS);
const EVENTS = Object.values(CREDIT_EVENTS);

const LEGAL_EDGES: ReadonlyArray<{ readonly from: string; readonly event: string; readonly to: string }> = [
  { from: CREDIT_STATUS.CLEAR, event: CREDIT_EVENTS.SET_HOLD, to: CREDIT_STATUS.HELD },
  { from: CREDIT_STATUS.HELD, event: CREDIT_EVENTS.SET_HOLD, to: CREDIT_STATUS.HELD },
  { from: CREDIT_STATUS.HELD, event: CREDIT_EVENTS.RELEASE, to: CREDIT_STATUS.CLEAR },
];

const LEGAL_EDGE_KEYS = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

// Never a hand-spread of an internal snapshot shape (contract-machine.unit.test.ts's own precedent,
// pg-reviewer fix round 2 finding 11 there) — `resolveState({ value })` is the sanctioned XState v5
// API.
function actorAt(state: string) {
  const snapshot = creditMachine.resolveState({ value: state });
  return createActor(creditMachine, { snapshot });
}

describe('creditMachine — exhaustive legal/illegal transition table (2 states x 2 events = 4)', () => {
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

describe('creditMachine — clear/RELEASE has no edge in the chart itself', () => {
  it('clear does not accept RELEASE', () => {
    const actor = actorAt(CREDIT_STATUS.CLEAR);
    actor.start();
    expect(actor.getSnapshot().can({ type: CREDIT_EVENTS.RELEASE })).toBe(false);
    actor.stop();
  });
});

describe('creditMachine — held is tagged blocksOrders, clear is not', () => {
  it('CREDIT_TAG_BLOCKS_ORDERS is present only on held', () => {
    for (const state of STATES) {
      const actor = actorAt(state);
      actor.start();
      expect(actor.getSnapshot().hasTag(CREDIT_TAG_BLOCKS_ORDERS)).toBe(state === CREDIT_STATUS.HELD);
      actor.stop();
    }
  });

  it('hasCreditTag matches the exhaustive table above', () => {
    expect(hasCreditTag(CREDIT_STATUS.HELD, CREDIT_TAG_BLOCKS_ORDERS)).toBe(true);
    expect(hasCreditTag(CREDIT_STATUS.CLEAR, CREDIT_TAG_BLOCKS_ORDERS)).toBe(false);
  });
});

describe('creditMachine — the happy-path walk lands on each named state in order', () => {
  it('clear -> held -> held (re-placed) -> clear', () => {
    const actor = createActor(creditMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(CREDIT_STATUS.CLEAR);

    actor.send({ type: CREDIT_EVENTS.SET_HOLD });
    expect(actor.getSnapshot().value).toBe(CREDIT_STATUS.HELD);

    actor.send({ type: CREDIT_EVENTS.SET_HOLD }); // self-loop: re-placing an active hold.
    expect(actor.getSnapshot().value).toBe(CREDIT_STATUS.HELD);

    actor.send({ type: CREDIT_EVENTS.RELEASE });
    expect(actor.getSnapshot().value).toBe(CREDIT_STATUS.CLEAR);
    actor.stop();
  });
});

describe('canTransition — pure query, matches the exhaustive table above', () => {
  it('true for clear/SET_HOLD, false for clear/RELEASE, true for held/SET_HOLD (self) and held/RELEASE', () => {
    expect(canTransition(CREDIT_STATUS.CLEAR, CREDIT_EVENTS.SET_HOLD)).toBe(true);
    expect(canTransition(CREDIT_STATUS.CLEAR, CREDIT_EVENTS.RELEASE)).toBe(false);
    expect(canTransition(CREDIT_STATUS.HELD, CREDIT_EVENTS.SET_HOLD)).toBe(true);
    expect(canTransition(CREDIT_STATUS.HELD, CREDIT_EVENTS.RELEASE)).toBe(true);
  });
});

describe('creditStateFromRow — the ONE boolean-to-state mapping', () => {
  it('creditHold=false -> clear, creditHold=true -> held', () => {
    expect(creditStateFromRow({ creditHold: false })).toBe(CREDIT_STATUS.CLEAR);
    expect(creditStateFromRow({ creditHold: true })).toBe(CREDIT_STATUS.HELD);
  });
});

describe('assertReleaseLegal — throws NotOnHoldError iff RELEASE is illegal from the given state', () => {
  it('throws NotOnHoldError for clear', () => {
    expect(() => assertReleaseLegal(CREDIT_STATUS.CLEAR)).toThrow(NotOnHoldError);
  });

  it('does NOT throw for held', () => {
    expect(() => assertReleaseLegal(CREDIT_STATUS.HELD)).not.toThrow();
  });
});
