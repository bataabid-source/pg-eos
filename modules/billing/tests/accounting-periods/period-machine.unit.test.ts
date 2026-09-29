// modules/billing/tests/accounting-periods/period-machine.unit.test.ts — WBS 4.19 (lane 2).
//
// Renamed from ./inbound-machine.unit.test.ts (scaffold copy of the golden slice's own
// modules/wms/tests/receive-inbound/inbound-machine.unit.test.ts) — this file replaces it
// entirely with the accounting-period state machine's own exhaustive transition table.
//
// Pure domain-layer unit test — no DB, no I/O. CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for
// state transitions — XState." ADR-0004 D1 5 ("Periods open/closed/locked per entity") names the
// three states verbatim; the brief's own "Machine" line names the three edges verbatim: CLOSE
// (open->closed), LOCK (closed->locked), REOPEN (closed->open). "Any other edge: STOP and report"
// — this file proves the machine has NO other edge, over the full 3 states x 3 events table.
//
// `locked` is a genuine XState final state (4.19 pre-build review D4: "locked is final") —
// asserted directly against the machine's own config, same discipline as
// modules/billing/tests/dimensions/machine.unit.test.ts's own "inactive" assertion.
//
// NOTE — the REOPEN edge modelled here (closed -> open) is the one the INTERNAL
// applyPeriodReopenDecision function drives once a platform.decisions row is decided/approved
// (4.19 pre-build review D9); the public requestReopenPeriod command never sends REOPEN to this
// machine — it
// only files the decision, leaving the period's status unchanged (see
// ./accounting-periods.test.ts, Scenario "Reopen goes through the Decision Inbox"). This machine
// only decides whether an edge is LEGAL from a status, not who may drive it or when.
//
// Surface this file exercises — modules/billing/domain/accounting-periods/machine.ts (STATUS:
// GREEN against pgeos_lane2, database/migrations/0040_2_accounting-periods.sql applied):
//   - `PERIOD_STATUS` — { OPEN: 'open', CLOSED: 'closed', LOCKED: 'locked' } (ADR-0004 D1 5, verbatim).
//   - `PERIOD_EVENTS` — { CLOSE: 'CLOSE_PERIOD', LOCK: 'LOCK_PERIOD', REOPEN: 'REOPEN_PERIOD' }.
//   - `periodMachine` — XState v5 machine, `id: 'accountingPeriod'`, `initial: PERIOD_STATUS.OPEN`,
//     exactly the 3 edges above; 'locked' typed `{ type: 'final' }`.
//   - `canTransitionPeriod(current, event): boolean` — mirrors
//     modules/wms/domain/receive-inbound/machine.ts's own `canTransition`.
//   - `advancePeriodStatus(current, events): PeriodStatus` — mirrors `advanceInboundOrder`; THROWS
//     `IllegalPeriodTransitionError` (./errors.js) the moment an event is illegal from the actor's
//     current state, naming the FROM state and the allowed-events list (empty `[]` for 'locked',
//     terminal) in the message — same convention as the golden slice / dimensions machine.

import { describe, expect, it } from 'vitest';

import {
  PERIOD_EVENTS,
  PERIOD_STATUS,
  advancePeriodStatus,
  canTransitionPeriod,
  periodMachine,
  type PeriodStatus,
} from '../../domain/accounting-periods/machine.js';
import { IllegalPeriodTransitionError } from '../../domain/accounting-periods/errors.js';

const STATES = Object.values(PERIOD_STATUS);
const EVENTS = Object.values(PERIOD_EVENTS);

// The SINGLE source of truth this exhaustive table is checked against — the brief's own "Edges
// ONLY" line, verbatim: CLOSE open->closed; LOCK closed->locked; REOPEN closed->open. Every other
// (state, event) pair in the 3x3 table below MUST be refused.
const LEGAL_EDGES: ReadonlyArray<{
  readonly from: PeriodStatus;
  readonly event: string;
  readonly to: PeriodStatus;
}> = [
  { from: PERIOD_STATUS.OPEN, event: PERIOD_EVENTS.CLOSE, to: PERIOD_STATUS.CLOSED },
  { from: PERIOD_STATUS.CLOSED, event: PERIOD_EVENTS.LOCK, to: PERIOD_STATUS.LOCKED },
  { from: PERIOD_STATUS.CLOSED, event: PERIOD_EVENTS.REOPEN, to: PERIOD_STATUS.OPEN },
];

describe('periodMachine — id, initial state, and "locked" is a genuine final state', () => {
  it('has id "accountingPeriod" and starts at "open"', () => {
    expect(periodMachine.id).toBe('accountingPeriod');
    expect(periodMachine.config.initial).toBe(PERIOD_STATUS.OPEN);
  });

  it('the "locked" state is configured as a genuine XState final state (type: "final")', () => {
    const lockedStateConfig = (
      periodMachine.config.states as Record<string, { type?: string }>
    )[PERIOD_STATUS.LOCKED];
    expect(lockedStateConfig?.type).toBe('final');
  });
});

describe('canTransitionPeriod — exhaustive 3 states x 3 events table (brief: "Any other edge: STOP and report")', () => {
  for (const from of STATES) {
    for (const event of EVENTS) {
      const legal = LEGAL_EDGES.some((edge) => edge.from === from && edge.event === event);
      it(`${legal ? 'ALLOWS' : 'REFUSES'} ${event} from "${from}"`, () => {
        expect(canTransitionPeriod(from, event)).toBe(legal);
      });
    }
  }
});

describe('advancePeriodStatus — every legal edge lands on the right state', () => {
  it.each(LEGAL_EDGES)('$event from "$from" lands on "$to"', ({ from, event, to }) => {
    expect(advancePeriodStatus(from, [event])).toBe(to);
  });

  it('an empty events array is a no-op, returning the state unchanged, for every state', () => {
    for (const state of STATES) {
      expect(advancePeriodStatus(state, [])).toBe(state);
    }
  });

  it('CLOSE then LOCK, sent in sequence to one actor, lands on "locked"', () => {
    expect(advancePeriodStatus(PERIOD_STATUS.OPEN, [PERIOD_EVENTS.CLOSE, PERIOD_EVENTS.LOCK])).toBe(
      PERIOD_STATUS.LOCKED,
    );
  });

  it('CLOSE then REOPEN, sent in sequence to one actor, lands back on "open"', () => {
    expect(
      advancePeriodStatus(PERIOD_STATUS.OPEN, [PERIOD_EVENTS.CLOSE, PERIOD_EVENTS.REOPEN]),
    ).toBe(PERIOD_STATUS.OPEN);
  });
});

describe('advancePeriodStatus — an illegal transition throws IllegalPeriodTransitionError', () => {
  it('LOCK sent directly from "open" (skipping "closed") throws', () => {
    expect(() => advancePeriodStatus(PERIOD_STATUS.OPEN, [PERIOD_EVENTS.LOCK])).toThrow(
      IllegalPeriodTransitionError,
    );
  });

  it('every event sent from "locked" throws (terminal state)', () => {
    for (const event of EVENTS) {
      expect(() => advancePeriodStatus(PERIOD_STATUS.LOCKED, [event])).toThrow(
        IllegalPeriodTransitionError,
      );
    }
  });

  it('the thrown error is a genuine Error with its own name, and its message states the FROM state ("locked") and the empty allowed-events list ("[]", terminal state)', () => {
    let caught: unknown;
    try {
      advancePeriodStatus(PERIOD_STATUS.LOCKED, [PERIOD_EVENTS.REOPEN]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(IllegalPeriodTransitionError);
    const asError = caught as IllegalPeriodTransitionError;
    expect(asError.name).toBe('IllegalPeriodTransitionError');
    expect(asError.message.length).toBeGreaterThan(0);
    expect(asError.message).toContain('locked');
    expect(asError.message).toContain('[]');
  });

  it('CLOSE sent a second time (already "closed") throws, naming the allowed events (LOCK, REOPEN)', () => {
    let caught: unknown;
    try {
      advancePeriodStatus(PERIOD_STATUS.CLOSED, [PERIOD_EVENTS.CLOSE]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IllegalPeriodTransitionError);
    const asError = caught as IllegalPeriodTransitionError;
    expect(asError.message).toContain('closed');
    expect(asError.message).toContain(PERIOD_EVENTS.LOCK);
    expect(asError.message).toContain(PERIOD_EVENTS.REOPEN);
  });
});
