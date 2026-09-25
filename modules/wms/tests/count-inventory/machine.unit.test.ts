// modules/wms/tests/count-inventory/machine.unit.test.ts — WBS 2.13 (lane 2).
//
// CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions — XState." This is the pure,
// data-only state machine the application-layer commands (start-count.ts, count-location.ts,
// recount.ts, adjust-count.ts) must consult to decide whether a transition is legal, instead of
// hand-written if/switch on `status` strings. Same exhaustive, table-driven shape as the golden
// slice's own modules/wms/tests/receive-inbound/inbound-machine.unit.test.ts.
//
// Expected surface — modules/wms/domain/count-inventory/machine.ts:
//   - `INVENTORY_COUNT_STATUS` — the 6-value enum object (draft/in_progress/review/recount/
//     adjusted/closed), verbatim from chk_inventory_counts_status
//     (database/schema/13B-Schema-Reference-Consolidation.sql:2334-2335) / the slice brief D1.
//   - `INVENTORY_COUNT_EVENTS` — 7 event-type constants: the 5 STATUS-CHANGING ones brief D1 names
//     — START (draft -> in_progress, StartCount), COMPLETE (in_progress -> review, auto — every
//     line counted), FLAG_RECOUNT (review -> recount, auto — Recount first called on a variant
//     line), RECOUNT_COMPLETE (recount -> review, auto — every variant line now recounted), ADJUST
//     (review -> adjusted, AdjustCount) — PLUS 2 self-loop "may a line be written right now" gates
//     the application layer added on top of brief D1 to keep CountLocation/Recount's own status
//     checks inside XState too (CLAUDE.md · ARCHITECTURE "No if/switch for state transitions —
//     XState", machine.ts's own header comment): COUNT_LINE (legal, self-loop, from in_progress
//     only — CountLocation) and RECOUNT_LINE (legal, self-loop, from review AND recount — Recount).
//   - `inventoryCountMachine` — an XState v5 machine, `id: 'inventoryCount'`,
//     `initial: INVENTORY_COUNT_STATUS.DRAFT`, one state per INVENTORY_COUNT_STATUS value, exactly
//     the 8 edges in LEGAL_EDGES below and no others (5 status-changing edges from brief D1 plus
//     the 2 self-loop "may a line be written right now" gates below — REVIEW's RECOUNT_LINE
//     self-loop and RECOUNT's RECOUNT_LINE self-loop are separate edges, one per legal from-state,
//     which is what brings the total to 8).
//
// Brief D1 (verbatim): "`closed` has no edge into it from any of the four named commands — doc 40
// names no fifth 'CloseCount' command ... No edge reaches `closed`; the machine simply has no
// transition defined for it." This file's dedicated describe block below asserts exactly that,
// across all 6 states x 7 events, not just the happy path.
//
// Table-driven and exhaustive: every one of the 6 states x 7 events = 42 combinations is checked
// via XState v5's own `actor.getSnapshot().can(event)` — never a hand-rolled comparison against a
// parallel if/switch, which would just relocate the CLAUDE.md violation into the test.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import {
  INVENTORY_COUNT_EVENTS,
  INVENTORY_COUNT_STATUS,
  inventoryCountMachine,
} from '../../domain/count-inventory/machine.js';

const STATES = Object.values(INVENTORY_COUNT_STATUS);
const EVENTS = Object.values(INVENTORY_COUNT_EVENTS);

// brief D1 — the SINGLE source of truth this test's exhaustive table is checked against.
const LEGAL_EDGES: ReadonlyArray<{
  readonly from: string;
  readonly event: string;
  readonly to: string;
}> = [
  { from: INVENTORY_COUNT_STATUS.DRAFT, event: INVENTORY_COUNT_EVENTS.START, to: INVENTORY_COUNT_STATUS.IN_PROGRESS },
  {
    from: INVENTORY_COUNT_STATUS.IN_PROGRESS,
    event: INVENTORY_COUNT_EVENTS.COMPLETE,
    to: INVENTORY_COUNT_STATUS.REVIEW,
  },
  {
    from: INVENTORY_COUNT_STATUS.REVIEW,
    event: INVENTORY_COUNT_EVENTS.FLAG_RECOUNT,
    to: INVENTORY_COUNT_STATUS.RECOUNT,
  },
  {
    from: INVENTORY_COUNT_STATUS.RECOUNT,
    event: INVENTORY_COUNT_EVENTS.RECOUNT_COMPLETE,
    to: INVENTORY_COUNT_STATUS.REVIEW,
  },
  {
    from: INVENTORY_COUNT_STATUS.REVIEW,
    event: INVENTORY_COUNT_EVENTS.ADJUST,
    to: INVENTORY_COUNT_STATUS.ADJUSTED,
  },
  // The 2 self-loop "may a line be written right now" gates (see the header comment) — status
  // unchanged, machine.ts's own file header names exactly these two.
  {
    from: INVENTORY_COUNT_STATUS.IN_PROGRESS,
    event: INVENTORY_COUNT_EVENTS.COUNT_LINE,
    to: INVENTORY_COUNT_STATUS.IN_PROGRESS,
  },
  {
    from: INVENTORY_COUNT_STATUS.REVIEW,
    event: INVENTORY_COUNT_EVENTS.RECOUNT_LINE,
    to: INVENTORY_COUNT_STATUS.REVIEW,
  },
  {
    from: INVENTORY_COUNT_STATUS.RECOUNT,
    event: INVENTORY_COUNT_EVENTS.RECOUNT_LINE,
    to: INVENTORY_COUNT_STATUS.RECOUNT,
  },
];

const LEGAL_EDGE_KEYS = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

function actorAt(state: string) {
  // XState v5: start an actor and immediately re-hydrate it at the target state via its own
  // persisted-snapshot shape — the machine's OWN initial-state snapshot, with `value` overwritten,
  // is what `createActor(machine, { snapshot })` expects (no hand-written transition table).
  const initial = createActor(inventoryCountMachine).getSnapshot();
  const snapshot = { ...initial, value: state };
  return createActor(inventoryCountMachine, { snapshot });
}

describe('inventoryCountMachine — exhaustive legal/illegal transition table (6 states x 7 events)', () => {
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

describe('inventoryCountMachine — NO edge reaches "closed" (brief D1, verbatim)', () => {
  it('no (state, event) pair in the legal-edge table targets "closed"', () => {
    for (const edge of LEGAL_EDGES) {
      expect(edge.to).not.toBe(INVENTORY_COUNT_STATUS.CLOSED);
    }
  });

  it('every event from every state either stays off "closed" or is illegal — "closed" is never reachable by sending any single event from any state', () => {
    for (const from of STATES) {
      for (const event of EVENTS) {
        const actor = actorAt(from);
        actor.start();
        if (actor.getSnapshot().can({ type: event })) {
          actor.send({ type: event });
          expect(actor.getSnapshot().value).not.toBe(INVENTORY_COUNT_STATUS.CLOSED);
        }
        actor.stop();
      }
    }
  });

  it('"closed" itself accepts no event at all (out of scope for this slice — brief D1)', () => {
    const actor = actorAt(INVENTORY_COUNT_STATUS.CLOSED);
    actor.start();
    for (const event of EVENTS) {
      expect(actor.getSnapshot().can({ type: event })).toBe(false);
    }
    actor.stop();
  });
});

describe('inventoryCountMachine — the happy-path walk lands on each named state in order', () => {
  it('draft -> in_progress -> review -> recount -> review -> adjusted', () => {
    const actor = createActor(inventoryCountMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(INVENTORY_COUNT_STATUS.DRAFT);

    actor.send({ type: INVENTORY_COUNT_EVENTS.START });
    expect(actor.getSnapshot().value).toBe(INVENTORY_COUNT_STATUS.IN_PROGRESS);

    actor.send({ type: INVENTORY_COUNT_EVENTS.COMPLETE });
    expect(actor.getSnapshot().value).toBe(INVENTORY_COUNT_STATUS.REVIEW);

    actor.send({ type: INVENTORY_COUNT_EVENTS.FLAG_RECOUNT });
    expect(actor.getSnapshot().value).toBe(INVENTORY_COUNT_STATUS.RECOUNT);

    actor.send({ type: INVENTORY_COUNT_EVENTS.RECOUNT_COMPLETE });
    expect(actor.getSnapshot().value).toBe(INVENTORY_COUNT_STATUS.REVIEW);

    actor.send({ type: INVENTORY_COUNT_EVENTS.ADJUST });
    expect(actor.getSnapshot().value).toBe(INVENTORY_COUNT_STATUS.ADJUSTED);
    actor.stop();
  });

  it('review -> adjusted is reachable directly, without ever visiting "recount" — PURE STATE-CHART fact only, for a count with no variant lines at all', () => {
    // This machine has no notion of "lines" or "variance" — it only tracks wms.inventory_counts.
    // status, so ADJUST is legal from 'review' whether or not the count HAS variant lines. Brief
    // finding 1 (docs/notes/slice-briefs/_slice-2.13.brief.md fix round): the application layer
    // (../../application/count-inventory/adjust-count.ts) adds its OWN guard on top of this
    // machine — assertAllVariancesRecounted (../../domain/count-inventory/invariants.ts) — and
    // throws RecountRequiredError BEFORE ever calling this machine when any variant line is still
    // un-recounted. "Variant lines never recounted" is therefore NOT a legal business path to
    // 'adjusted' (see count-inventory.test.ts's "Finding 1" describe block) even though this pure
    // state chart alone would allow the ADJUST event from 'review'.
    const actor = createActor(inventoryCountMachine);
    actor.start();
    actor.send({ type: INVENTORY_COUNT_EVENTS.START });
    actor.send({ type: INVENTORY_COUNT_EVENTS.COMPLETE });
    actor.send({ type: INVENTORY_COUNT_EVENTS.ADJUST });
    expect(actor.getSnapshot().value).toBe(INVENTORY_COUNT_STATUS.ADJUSTED);
    actor.stop();
  });
});

describe('inventoryCountMachine — "adjusted" is terminal (no event is ever legal, same as "closed")', () => {
  it('"adjusted" accepts no event at all', () => {
    const actor = actorAt(INVENTORY_COUNT_STATUS.ADJUSTED);
    actor.start();
    for (const event of EVENTS) {
      expect(actor.getSnapshot().can({ type: event })).toBe(false);
    }
    actor.stop();
  });
});
