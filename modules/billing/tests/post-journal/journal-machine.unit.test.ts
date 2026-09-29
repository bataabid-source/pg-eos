// modules/billing/tests/post-journal/journal-machine.unit.test.ts — WBS 4.20 (lane 2).
//
// Pure domain unit test, no DB. CLAUDE.md: "No if/switch for state transitions — XState." Settled
// design (pre-migration review): the machine is per entry, created in `posted` (no draft rows ever);
// exactly ONE edge REVERSE: posted -> reversed; `reversed` is final. Guards: not already reversed,
// same entity, version matches. No status column exists (01 has none): the state is derived from
// `reversed_by` (posted when null, reversed when set).
//
// Surface — modules/billing/domain/post-journal/machine.ts (builder to provide):
//   - `JOURNAL_STATUS` = { POSTED: 'posted', REVERSED: 'reversed' }; type `JournalStatus`.
//   - `JOURNAL_EVENTS` = { REVERSE: 'REVERSE_JOURNAL' }.
//   - `journalMachine` — XState v5 machine, id 'journalEntry', initial 'posted', 'reversed' typed final.
//   - `canTransitionJournal(current: JournalStatus, eventType: string): boolean` — structural edge check.
//   - `advanceJournalStatus(entry: { status: JournalStatus; entityId: string; version: number },
//       event: { type: 'REVERSE_JOURNAL'; entityId: string; expectedVersion: number }): JournalStatus`
//     returns the next status; THROWS (domain/post-journal/errors.js):
//       entity mismatch          -> EntityNotInScopeError  (guard: same entity)
//       from 'reversed'          -> AlreadyReversedError   (guard: not already reversed)
//       expectedVersion mismatch -> StaleVersionError      (guard: version matches)
//       an event type the machine has no edge for -> IllegalJournalTransitionError.
//     Guard precedence when several fail (Master ruling): entity, then reversed, then version
//     (an out-of-scope caller learns nothing about the entry's state).

import { beforeAll, describe, expect, it } from 'vitest';

import {
  JOURNAL_EVENTS,
  JOURNAL_STATUS,
  advanceJournalStatus,
  canTransitionJournal,
  journalMachine,
} from '../../domain/post-journal/machine.js';
import {
  AlreadyReversedError,
  EntityNotInScopeError,
  IllegalJournalTransitionError,
  StaleVersionError,
} from '../../domain/post-journal/errors.js';

const ENTITY = '11111111-1111-4111-8111-111111111111';
const OTHER_ENTITY = '22222222-2222-4222-8222-222222222222';
const VERSION = 3;

describe('journalMachine — id, initial state, single edge, "reversed" is final', () => {
  it('has id "journalEntry", starts at "posted" (no draft state exists)', () => {
    expect(journalMachine.id).toBe('journalEntry');
    expect(journalMachine.config.initial).toBe(JOURNAL_STATUS.POSTED);
  });

  it('has exactly the two states posted and reversed, and "reversed" is final', () => {
    expect(Object.values(JOURNAL_STATUS).sort()).toEqual(['posted', 'reversed']);
    const states = journalMachine.config.states as Record<string, { type?: string; on?: Record<string, unknown> }>;
    expect(Object.keys(states).sort()).toEqual(['posted', 'reversed']);
    expect(states['reversed']?.type).toBe('final');
    expect(states['posted']?.type).not.toBe('final');
  });

  it('exposes exactly one event REVERSE = "REVERSE_JOURNAL"', () => {
    expect(JOURNAL_EVENTS.REVERSE).toBe('REVERSE_JOURNAL');
    expect(Object.keys(JOURNAL_EVENTS)).toEqual(['REVERSE']);
  });
});

describe('canTransitionJournal — the full 2 states x 1 event table', () => {
  it('posted + REVERSE is legal', () => {
    expect(canTransitionJournal(JOURNAL_STATUS.POSTED, JOURNAL_EVENTS.REVERSE)).toBe(true);
  });

  it('reversed + REVERSE is illegal (final state)', () => {
    expect(canTransitionJournal(JOURNAL_STATUS.REVERSED, JOURNAL_EVENTS.REVERSE)).toBe(false);
  });

  it('an unknown event is illegal from every state', () => {
    for (const status of Object.values(JOURNAL_STATUS)) {
      expect(canTransitionJournal(status, 'EDIT_JOURNAL')).toBe(false);
      expect(canTransitionJournal(status, 'DELETE_JOURNAL')).toBe(false);
    }
  });
});

/** Matches by `.name`, so an undefined/missing class can never satisfy the assertion (RED review #1). */
function expectThrowsNamed(fn: () => unknown, name: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${name} to be thrown`).toBeInstanceOf(Error);
  expect((thrown as Error).name).toBe(name);
}

describe('advanceJournalStatus — guards', () => {
  beforeAll(() => {
    for (const [label, value] of Object.entries({ AlreadyReversedError, EntityNotInScopeError, IllegalJournalTransitionError, StaleVersionError, advanceJournalStatus, canTransitionJournal })) {
      expect(typeof value, label).toBe('function');
    }
  });

  const posted = { status: JOURNAL_STATUS.POSTED, entityId: ENTITY, version: VERSION };

  it('posted + REVERSE with matching entity and version -> reversed', () => {
    expect(advanceJournalStatus(posted, { type: 'REVERSE_JOURNAL', entityId: ENTITY, expectedVersion: VERSION })).toBe('reversed');
  });

  it('already reversed -> AlreadyReversedError', () => {
    expectThrowsNamed(() => advanceJournalStatus({ ...posted, status: JOURNAL_STATUS.REVERSED }, { type: 'REVERSE_JOURNAL', entityId: ENTITY, expectedVersion: VERSION }), 'AlreadyReversedError');
  });

  it('different entity -> EntityNotInScopeError', () => {
    expectThrowsNamed(() => advanceJournalStatus(posted, { type: 'REVERSE_JOURNAL', entityId: OTHER_ENTITY, expectedVersion: VERSION }), 'EntityNotInScopeError');
  });

  it('stale version (lower and higher) -> StaleVersionError', () => {
    expectThrowsNamed(() => advanceJournalStatus(posted, { type: 'REVERSE_JOURNAL', entityId: ENTITY, expectedVersion: VERSION - 1 }), 'StaleVersionError');
    expectThrowsNamed(() => advanceJournalStatus(posted, { type: 'REVERSE_JOURNAL', entityId: ENTITY, expectedVersion: VERSION + 1 }), 'StaleVersionError');
  });

  it('guard precedence (Master ruling): entity, then already-reversed, then version', () => {
    const reversed = { ...posted, status: JOURNAL_STATUS.REVERSED };
    // out-of-scope caller learns nothing about the entry's state: entity wins over reversed and stale.
    expectThrowsNamed(() => advanceJournalStatus(reversed, { type: 'REVERSE_JOURNAL', entityId: OTHER_ENTITY, expectedVersion: VERSION + 1 }), 'EntityNotInScopeError');
    expectThrowsNamed(() => advanceJournalStatus(posted, { type: 'REVERSE_JOURNAL', entityId: OTHER_ENTITY, expectedVersion: VERSION + 1 }), 'EntityNotInScopeError');
    // in scope: reversed wins over a stale version.
    expectThrowsNamed(() => advanceJournalStatus(reversed, { type: 'REVERSE_JOURNAL', entityId: ENTITY, expectedVersion: VERSION + 1 }), 'AlreadyReversedError');
  });

  it('an event with no edge -> IllegalJournalTransitionError', () => {
    expectThrowsNamed(() => advanceJournalStatus(posted, { type: 'EDIT_JOURNAL', entityId: ENTITY, expectedVersion: VERSION } as unknown as Parameters<typeof advanceJournalStatus>[1]), 'IllegalJournalTransitionError');
  });
});
