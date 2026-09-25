// modules/sales/tests/manage-quote/quote-machine.unit.test.ts — WBS 1.6, M02 sales.
//
// The XState v5 machine for sales.quotes.status, renamed from the golden
// modules/wms/tests/receive-inbound/inbound-machine.unit.test.ts / the nearer catalog precedent
// modules/catalog/tests/maintain-price-list/price-list-machine.unit.test.ts — same API shape, this
// aggregate's own 8-value status enum and events (slice brief Master decision 1).
//
// Expected new surface — modules/sales/domain/manage-quote/machine.ts:
//   - `QUOTE_STATUS` — verbatim from `chk_quotes_status`
//     (database/schema/13B-Schema-Reference-Consolidation.sql:2314-2316): draft ·
//     commercial_review · finance_review · approved · sent · accepted · rejected · expired.
//   - `QUOTE_EVENTS` — { SUBMIT_FOR_REVIEW, APPROVE_COMMERCIAL, RETURN_TO_DRAFT, APPROVE_FINANCE,
//     SEND_QUOTE, RECORD_DECISION_ACCEPTED, RECORD_DECISION_REJECTED } — 7 event types. (The single
//     `RecordDecision` command sends one of two DISTINCT event types depending on the caller's
//     `decision` field — `sent` has two outgoing edges to two different terminal states, and an
//     XState `on` map keys transitions by event type, not by a runtime payload value — this is the
//     pg-tester default for how the machine expresses "sent -> accepted | rejected"; reported as an
//     open question below since the brief itself does not spell out the machine's own event names
//     for RecordDecision.)
//   - `quoteMachine` — `id: 'quote'`, `initial: QUOTE_STATUS.DRAFT`, one state per QUOTE_STATUS
//     value, exactly the 7 edges below and no others. `expired` is a legal status value with NO
//     producing edge in this slice (ExpireQuote deferred — brief Scope defaults) — it still exists
//     as a state in the chart (unreached, per the brief: "the expired status value stays legal in
//     the DB and the domain machine's type").
//   - `QUOTE_TAG_EDITABLE` — the `draft` state's own tag (mirrors catalog's
//     `PRICE_LIST_TAG_EDITABLE`) — `assertQuoteEditable` (../invariants.ts) asks the machine via
//     `snapshot.hasTag(QUOTE_TAG_EDITABLE)` instead of branching on the status string (CLAUDE.md ·
//     AGENT CONSTRAINTS: "No if/switch for state transitions — XState").
//   - `canTransition(current, event): boolean` — asks the machine via `.can()`.
//   - `advanceQuote(current, events): status` — sends each event in order, THROWS
//     IllegalTransitionError (../errors.js) the moment one is illegal.
//
// LEGAL EDGES (slice brief Master decision 1, the SINGLE source of truth this exhaustive table is
// checked against — only the named edges are legal, every other (status, event) pair REJECTS):
//   draft               --SUBMIT_FOR_REVIEW-->     commercial_review
//   commercial_review   --APPROVE_COMMERCIAL-->    finance_review
//   commercial_review   --RETURN_TO_DRAFT-->        draft
//   finance_review      --APPROVE_FINANCE-->        approved
//   finance_review      --RETURN_TO_DRAFT-->        draft
//   approved            --SEND_QUOTE-->             sent
//   sent                --RECORD_DECISION_ACCEPTED--> accepted
//   sent                --RECORD_DECISION_REJECTED--> rejected
//
// Exhaustive: every one of the 8 states x 7 events = 56 combinations is checked via XState v5's own
// `actor.getSnapshot().can(event)` — never a hand-rolled comparison.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  QUOTE_EVENTS,
  QUOTE_STATUS,
  QUOTE_TAG_EDITABLE,
  quoteMachine,
  advanceQuote,
  canTransition,
} from '../../domain/manage-quote/machine.js';
import { IllegalTransitionError } from '../../domain/manage-quote/errors.js';

const STATES = Object.values(QUOTE_STATUS);
const EVENTS = Object.values(QUOTE_EVENTS);

const LEGAL_EDGES: ReadonlyArray<{ readonly from: string; readonly event: string; readonly to: string }> = [
  { from: QUOTE_STATUS.DRAFT, event: QUOTE_EVENTS.SUBMIT_FOR_REVIEW, to: QUOTE_STATUS.COMMERCIAL_REVIEW },
  { from: QUOTE_STATUS.COMMERCIAL_REVIEW, event: QUOTE_EVENTS.APPROVE_COMMERCIAL, to: QUOTE_STATUS.FINANCE_REVIEW },
  { from: QUOTE_STATUS.COMMERCIAL_REVIEW, event: QUOTE_EVENTS.RETURN_TO_DRAFT, to: QUOTE_STATUS.DRAFT },
  { from: QUOTE_STATUS.FINANCE_REVIEW, event: QUOTE_EVENTS.APPROVE_FINANCE, to: QUOTE_STATUS.APPROVED },
  { from: QUOTE_STATUS.FINANCE_REVIEW, event: QUOTE_EVENTS.RETURN_TO_DRAFT, to: QUOTE_STATUS.DRAFT },
  { from: QUOTE_STATUS.APPROVED, event: QUOTE_EVENTS.SEND_QUOTE, to: QUOTE_STATUS.SENT },
  { from: QUOTE_STATUS.SENT, event: QUOTE_EVENTS.RECORD_DECISION_ACCEPTED, to: QUOTE_STATUS.ACCEPTED },
  { from: QUOTE_STATUS.SENT, event: QUOTE_EVENTS.RECORD_DECISION_REJECTED, to: QUOTE_STATUS.REJECTED },
];

const LEGAL_EDGE_KEYS = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

function actorAt(state: string) {
  const initial = createActor(quoteMachine).getSnapshot();
  const snapshot = { ...initial, value: state };
  return createActor(quoteMachine, { snapshot });
}

describe('quoteMachine — exhaustive legal/illegal transition table (8 states x 7 events = 56)', () => {
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

describe('quoteMachine — draft is tagged editable, no other state is', () => {
  it('QUOTE_TAG_EDITABLE is present only on draft', () => {
    for (const state of STATES) {
      const actor = actorAt(state);
      actor.start();
      expect(actor.getSnapshot().hasTag(QUOTE_TAG_EDITABLE)).toBe(state === QUOTE_STATUS.DRAFT);
      actor.stop();
    }
  });
});

describe('quoteMachine — terminal states accept no event at all', () => {
  it.each([QUOTE_STATUS.ACCEPTED, QUOTE_STATUS.REJECTED, QUOTE_STATUS.EXPIRED])('%s accepts no event', (state) => {
    const actor = actorAt(state);
    actor.start();
    for (const event of EVENTS) {
      expect(actor.getSnapshot().can({ type: event })).toBe(false);
    }
    actor.stop();
  });
});

describe('quoteMachine — the happy-path walk lands on each named state in order', () => {
  it('draft -> commercial_review -> finance_review -> approved -> sent -> accepted', () => {
    const actor = createActor(quoteMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(QUOTE_STATUS.DRAFT);

    actor.send({ type: QUOTE_EVENTS.SUBMIT_FOR_REVIEW });
    expect(actor.getSnapshot().value).toBe(QUOTE_STATUS.COMMERCIAL_REVIEW);

    actor.send({ type: QUOTE_EVENTS.APPROVE_COMMERCIAL });
    expect(actor.getSnapshot().value).toBe(QUOTE_STATUS.FINANCE_REVIEW);

    actor.send({ type: QUOTE_EVENTS.APPROVE_FINANCE });
    expect(actor.getSnapshot().value).toBe(QUOTE_STATUS.APPROVED);

    actor.send({ type: QUOTE_EVENTS.SEND_QUOTE });
    expect(actor.getSnapshot().value).toBe(QUOTE_STATUS.SENT);

    actor.send({ type: QUOTE_EVENTS.RECORD_DECISION_ACCEPTED });
    expect(actor.getSnapshot().value).toBe(QUOTE_STATUS.ACCEPTED);
    actor.stop();
  });

  it('a reviewer can send a quote back to draft from either review step', () => {
    const fromCommercial = actorAt(QUOTE_STATUS.COMMERCIAL_REVIEW);
    fromCommercial.start();
    fromCommercial.send({ type: QUOTE_EVENTS.RETURN_TO_DRAFT });
    expect(fromCommercial.getSnapshot().value).toBe(QUOTE_STATUS.DRAFT);
    fromCommercial.stop();

    const fromFinance = actorAt(QUOTE_STATUS.FINANCE_REVIEW);
    fromFinance.start();
    fromFinance.send({ type: QUOTE_EVENTS.RETURN_TO_DRAFT });
    expect(fromFinance.getSnapshot().value).toBe(QUOTE_STATUS.DRAFT);
    fromFinance.stop();
  });
});

describe('canTransition — pure query, matches the exhaustive table above', () => {
  it('true for draft/SUBMIT_FOR_REVIEW, false for draft/APPROVE_FINANCE', () => {
    expect(canTransition(QUOTE_STATUS.DRAFT, QUOTE_EVENTS.SUBMIT_FOR_REVIEW)).toBe(true);
    expect(canTransition(QUOTE_STATUS.DRAFT, QUOTE_EVENTS.APPROVE_FINANCE)).toBe(false);
    expect(canTransition(QUOTE_STATUS.SENT, QUOTE_EVENTS.RECORD_DECISION_ACCEPTED)).toBe(true);
    expect(canTransition(QUOTE_STATUS.SENT, QUOTE_EVENTS.RECORD_DECISION_REJECTED)).toBe(true);
    expect(canTransition(QUOTE_STATUS.ACCEPTED, QUOTE_EVENTS.RECORD_DECISION_ACCEPTED)).toBe(false);
  });
});

describe('advanceQuote — assertTransition-style helper', () => {
  it('returns the new status for a legal single-event sequence', () => {
    expect(advanceQuote(QUOTE_STATUS.DRAFT, [QUOTE_EVENTS.SUBMIT_FOR_REVIEW])).toBe(QUOTE_STATUS.COMMERCIAL_REVIEW);
  });

  it('walks draft -> commercial_review -> finance_review -> approved -> sent -> rejected across five events', () => {
    expect(
      advanceQuote(QUOTE_STATUS.DRAFT, [
        QUOTE_EVENTS.SUBMIT_FOR_REVIEW,
        QUOTE_EVENTS.APPROVE_COMMERCIAL,
        QUOTE_EVENTS.APPROVE_FINANCE,
        QUOTE_EVENTS.SEND_QUOTE,
        QUOTE_EVENTS.RECORD_DECISION_REJECTED,
      ]),
    ).toBe(QUOTE_STATUS.REJECTED);
  });

  it('an empty events array is a no-op and returns `current` unchanged', () => {
    expect(advanceQuote(QUOTE_STATUS.DRAFT, [])).toBe(QUOTE_STATUS.DRAFT);
  });

  it.each([
    [QUOTE_STATUS.DRAFT, QUOTE_EVENTS.APPROVE_FINANCE],
    [QUOTE_STATUS.COMMERCIAL_REVIEW, QUOTE_EVENTS.SEND_QUOTE],
    [QUOTE_STATUS.FINANCE_REVIEW, QUOTE_EVENTS.SUBMIT_FOR_REVIEW],
    [QUOTE_STATUS.APPROVED, QUOTE_EVENTS.APPROVE_FINANCE],
    [QUOTE_STATUS.SENT, QUOTE_EVENTS.SUBMIT_FOR_REVIEW],
    [QUOTE_STATUS.ACCEPTED, QUOTE_EVENTS.RECORD_DECISION_ACCEPTED],
    [QUOTE_STATUS.REJECTED, QUOTE_EVENTS.RECORD_DECISION_REJECTED],
    [QUOTE_STATUS.EXPIRED, QUOTE_EVENTS.SUBMIT_FOR_REVIEW],
  ])('throws IllegalTransitionError for %s -> %s', (from, event) => {
    expect(() => advanceQuote(from, [event])).toThrow(IllegalTransitionError);
  });
});
