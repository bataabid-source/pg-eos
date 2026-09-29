// modules/billing/domain/post-journal/machine.ts — WBS 4.20 (lane 2).
//
// domain/ layer: pure state-transition rules for one billing.journal_entries row, no I/O, no Date,
// no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for
// state transitions — XState." (golden slice: modules/wms/domain/receive-inbound/machine.ts).
//
// Settled design (4.20 pre-migration review): 01 has no status column, so the state is derived from
// the columns — `posted` while reversed_by is null, `reversed` once it is set. An entry is created
// in `posted` (no draft rows ever); the ONE edge is REVERSE posted -> reversed; `reversed` is final.
// Guards (pre-migration + RED review ruling, precedence in this order): same entity, not already
// reversed, version matches. The database enforces the same edge in billing.mark_journal_reversed()
// and the immutability trigger (migration 0041, T4/T6).

import { createActor, createMachine } from 'xstate';

import { AlreadyReversedError, EntityNotInScopeError, IllegalJournalTransitionError, StaleVersionError } from './errors.js';

/** The two states the columns express (posted_at set; reversed_by null or set). */
export const JOURNAL_STATUS = {
  POSTED: 'posted',
  REVERSED: 'reversed',
} as const;

export type JournalStatus = (typeof JOURNAL_STATUS)[keyof typeof JOURNAL_STATUS];

const JOURNAL_STATUS_VALUES: readonly string[] = Object.values(JOURNAL_STATUS);

/** Narrows an XState snapshot value to a JournalStatus without an unchecked cast. */
export function isJournalStatus(value: unknown): value is JournalStatus {
  return typeof value === 'string' && JOURNAL_STATUS_VALUES.includes(value);
}

/** The one event this machine accepts. */
export const JOURNAL_EVENTS = {
  REVERSE: 'REVERSE_JOURNAL',
} as const;

export type JournalEventType = (typeof JOURNAL_EVENTS)[keyof typeof JOURNAL_EVENTS];

/** Pure state chart — no actions, no context: the guards are the functions below. */
export const journalMachine = createMachine({
  id: 'journalEntry',
  initial: JOURNAL_STATUS.POSTED,
  states: {
    [JOURNAL_STATUS.POSTED]: {
      on: {
        [JOURNAL_EVENTS.REVERSE]: JOURNAL_STATUS.REVERSED,
      },
    },
    [JOURNAL_STATUS.REVERSED]: {
      type: 'final',
    },
  },
});

/** The status the columns express: reversed once `reversed_by` is set. */
export function journalStatusOf(reversedBy: string | null): JournalStatus {
  return reversedBy === null ? JOURNAL_STATUS.POSTED : JOURNAL_STATUS.REVERSED;
}

function actorAt(state: JournalStatus) {
  const snapshot = journalMachine.resolveState({ value: state });
  return createActor(journalMachine, { snapshot });
}

/** True iff `eventType` is a legal edge from `current` (per the state chart above). */
export function canTransitionJournal(current: JournalStatus, eventType: string): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: eventType });
  actor.stop();
  return can;
}

const KNOWN_EVENTS: readonly string[] = Object.values(JOURNAL_EVENTS);

export interface JournalEntryState {
  readonly status: JournalStatus;
  readonly entityId: string;
  readonly version: number;
}

export interface ReverseJournalEvent {
  readonly type: typeof JOURNAL_EVENTS.REVERSE;
  /** The entity the reversal is made in (the reversal period's entity). */
  readonly entityId: string;
  readonly expectedVersion: number;
}

/**
 * Applies `event` to `entry` and returns the next status. THROWS, in this precedence (an
 * out-of-scope caller learns nothing about the entry's state): IllegalJournalTransitionError for an
 * event with no edge anywhere, EntityNotInScopeError, AlreadyReversedError, StaleVersionError.
 */
export function advanceJournalStatus(entry: JournalEntryState, event: ReverseJournalEvent): JournalStatus {
  if (!KNOWN_EVENTS.includes(event.type)) {
    throw new IllegalJournalTransitionError(
      `${event.type} is not a journal-entry event (Allowed: [${KNOWN_EVENTS.join(', ')}])`,
    );
  }
  if (event.entityId !== entry.entityId) {
    throw new EntityNotInScopeError(
      `the reversal is made in entity ${event.entityId}, not the entry's own entity ` +
        '(Allowed: a reversal in the same entity as the entry)',
    );
  }
  if (!canTransitionJournal(entry.status, event.type)) {
    throw new AlreadyReversedError(
      `the journal entry is already "${entry.status}" (Allowed: one reversal of a posted entry)`,
    );
  }
  if (event.expectedVersion !== entry.version) {
    throw new StaleVersionError(
      `expectedVersion ${event.expectedVersion} no longer matches the entry's version ${entry.version} (optimistic lock)`,
    );
  }
  const actor = actorAt(entry.status);
  actor.start();
  actor.send({ type: event.type });
  const next = actor.getSnapshot().value;
  actor.stop();
  if (!isJournalStatus(next)) {
    throw new IllegalJournalTransitionError(
      `the journal machine reached an unknown state (Allowed: ${JOURNAL_STATUS_VALUES.join(', ')})`,
    );
  }
  return next;
}
