// modules/catalog/tests/maintain-price-list/price-list-machine.unit.test.ts — WBS 1.2, M03 catalog.
//
// The XState machine for catalog.price_lists.status, renamed from the golden
// modules/wms/tests/receive-inbound/inbound-machine.unit.test.ts — same API shape, this
// aggregate's own status enum and events (Master decision 2, slice brief):
//   `draft -> active -> expired`; events ACTIVATE_PRICE_LIST, EXPIRE_PRICE_LIST; NO other edge.
//
// Expected surface — modules/catalog/domain/maintain-price-list/machine.ts:
//   - `PRICE_LIST_STATUS` — { DRAFT: 'draft', ACTIVE: 'active', EXPIRED: 'expired' }, verbatim from
//     `chk_price_lists_status` (13B-Schema-Reference-Consolidation.sql:2413-2415).
//   - `PRICE_LIST_EVENTS` — { ACTIVATE: 'ACTIVATE_PRICE_LIST', EXPIRE: 'EXPIRE_PRICE_LIST' }.
//   - `priceListMachine` — an XState v5 machine, `id: 'priceList'`, `initial:
//     PRICE_LIST_STATUS.DRAFT`, one state per PRICE_LIST_STATUS value, exactly the two edges below
//     and no others (`active` and `expired` are terminal — no event is ever legal from either).
//   - `canTransition(current, event): boolean` — asks the machine via `.can()`, never an if/switch
//     on the status string (CLAUDE.md · AGENT CONSTRAINTS).
//   - `advancePriceList(current, events): status` — the `assertTransition`-style helper the brief
//     asks for: sends each event in order and THROWS IllegalTransitionError (../errors.js) the
//     moment one is illegal, mirroring the golden `advanceInboundOrder`.
//
// Exhaustive: every one of the 3 states x 2 events = 6 combinations is checked via XState v5's own
// `actor.getSnapshot().can(event)` — never a hand-rolled comparison.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  PRICE_LIST_EVENTS,
  PRICE_LIST_STATUS,
  priceListMachine,
  advancePriceList,
  canTransition,
} from '../../domain/maintain-price-list/machine.js';
import { IllegalTransitionError } from '../../domain/maintain-price-list/errors.js';

const STATES = Object.values(PRICE_LIST_STATUS);
const EVENTS = Object.values(PRICE_LIST_EVENTS);

// Master decision 2 (slice brief) — the SINGLE source of truth this exhaustive table is checked
// against: only draft->ACTIVATE and active->EXPIRE are legal. No self-transitions, no other edge.
const LEGAL_EDGES: ReadonlyArray<{ readonly from: string; readonly event: string; readonly to: string }> = [
  { from: PRICE_LIST_STATUS.DRAFT, event: PRICE_LIST_EVENTS.ACTIVATE, to: PRICE_LIST_STATUS.ACTIVE },
  { from: PRICE_LIST_STATUS.ACTIVE, event: PRICE_LIST_EVENTS.EXPIRE, to: PRICE_LIST_STATUS.EXPIRED },
];

const LEGAL_EDGE_KEYS = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

function actorAt(state: string) {
  const initial = createActor(priceListMachine).getSnapshot();
  const snapshot = { ...initial, value: state };
  return createActor(priceListMachine, { snapshot });
}

describe('priceListMachine — exhaustive legal/illegal transition table (3 states x 2 events)', () => {
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

describe('priceListMachine — the happy-path walk lands on each named state in order', () => {
  it('draft -> active -> expired', () => {
    const actor = createActor(priceListMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(PRICE_LIST_STATUS.DRAFT);

    actor.send({ type: PRICE_LIST_EVENTS.ACTIVATE });
    expect(actor.getSnapshot().value).toBe(PRICE_LIST_STATUS.ACTIVE);

    actor.send({ type: PRICE_LIST_EVENTS.EXPIRE });
    expect(actor.getSnapshot().value).toBe(PRICE_LIST_STATUS.EXPIRED);
    actor.stop();
  });
});

describe('priceListMachine — expired is terminal (no event is ever legal)', () => {
  it('EXPIRED accepts no event at all', () => {
    const actor = actorAt(PRICE_LIST_STATUS.EXPIRED);
    actor.start();
    for (const event of EVENTS) {
      expect(actor.getSnapshot().can({ type: event })).toBe(false);
    }
    actor.stop();
  });
});

describe('priceListMachine — draft has no self-transition and no EXPIRE edge', () => {
  it('REJECTS EXPIRE_PRICE_LIST from draft (only ExpirePriceList on an ACTIVE list is legal)', () => {
    const actor = actorAt(PRICE_LIST_STATUS.DRAFT);
    actor.start();
    expect(actor.getSnapshot().can({ type: PRICE_LIST_EVENTS.EXPIRE })).toBe(false);
    actor.stop();
  });
});

describe('canTransition — pure query, matches the exhaustive table above', () => {
  it('true for draft/ACTIVATE, false for draft/EXPIRE and active/ACTIVATE', () => {
    expect(canTransition(PRICE_LIST_STATUS.DRAFT, PRICE_LIST_EVENTS.ACTIVATE)).toBe(true);
    expect(canTransition(PRICE_LIST_STATUS.DRAFT, PRICE_LIST_EVENTS.EXPIRE)).toBe(false);
    expect(canTransition(PRICE_LIST_STATUS.ACTIVE, PRICE_LIST_EVENTS.ACTIVATE)).toBe(false);
    expect(canTransition(PRICE_LIST_STATUS.ACTIVE, PRICE_LIST_EVENTS.EXPIRE)).toBe(true);
  });
});

describe('advancePriceList — assertTransition-style helper', () => {
  it('returns the new status for a legal single-event sequence', () => {
    expect(advancePriceList(PRICE_LIST_STATUS.DRAFT, [PRICE_LIST_EVENTS.ACTIVATE])).toBe(PRICE_LIST_STATUS.ACTIVE);
  });

  it('walks draft -> active -> expired across two events on one call', () => {
    expect(
      advancePriceList(PRICE_LIST_STATUS.DRAFT, [PRICE_LIST_EVENTS.ACTIVATE, PRICE_LIST_EVENTS.EXPIRE]),
    ).toBe(PRICE_LIST_STATUS.EXPIRED);
  });

  it('an empty events array is a no-op and returns `current` unchanged', () => {
    expect(advancePriceList(PRICE_LIST_STATUS.DRAFT, [])).toBe(PRICE_LIST_STATUS.DRAFT);
  });

  it.each([
    [PRICE_LIST_STATUS.DRAFT, PRICE_LIST_EVENTS.EXPIRE],
    [PRICE_LIST_STATUS.ACTIVE, PRICE_LIST_EVENTS.ACTIVATE],
    [PRICE_LIST_STATUS.EXPIRED, PRICE_LIST_EVENTS.ACTIVATE],
    [PRICE_LIST_STATUS.EXPIRED, PRICE_LIST_EVENTS.EXPIRE],
  ])('throws IllegalTransitionError for %s -> %s', (from, event) => {
    expect(() => advancePriceList(from, [event])).toThrow(IllegalTransitionError);
  });
});
