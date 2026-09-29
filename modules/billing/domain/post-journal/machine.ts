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
// reversed, version matches — `sameEntity` and `versionMatches` are named XState guards on the
// REVERSE edge over the machine's context (the entry's entityId/version, given as input); "not
// already reversed" is the chart itself (`reversed` is final, it has no edge). Legality is decided
// only by the machine (snapshot.can); advanceJournalStatus maps the first refused probe, in the
// precedence order, to its typed error (PR #214 review). The database enforces the same edge in billing.mark_journal_reversed()
// and the immutability trigger (migration 0041, T4/T6).

import { and, createActor, setup } from 'xstate';

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

/** The machine's context: the entry's own entity and version (given as input). */
interface JournalContext {
  readonly entityId: string;
  readonly version: number;
}

/** The event the REVERSE edge is guarded on. */
interface JournalMachineEvent {
  readonly type: JournalEventType;
  readonly entityId: string;
  readonly expectedVersion: number;
}

/** One entry's state chart — the REVERSE edge carries the two named guards. */
export const journalMachine = setup({
  types: {
    context: {} as JournalContext,
    input: {} as JournalContext,
    events: {} as JournalMachineEvent,
  },
  guards: {
    sameEntity: ({ context, event }) => event.entityId === context.entityId,
    versionMatches: ({ context, event }) => event.expectedVersion === context.version,
  },
}).createMachine({
  id: 'journalEntry',
  initial: JOURNAL_STATUS.POSTED,
  context: ({ input }) => input,
  states: {
    [JOURNAL_STATUS.POSTED]: {
      on: {
        [JOURNAL_EVENTS.REVERSE]: {
          target: JOURNAL_STATUS.REVERSED,
          guard: and(['sameEntity', 'versionMatches']),
        },
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

const KNOWN_EVENTS: readonly string[] = Object.values(JOURNAL_EVENTS);

function isJournalEventType(value: string): value is JournalEventType {
  return KNOWN_EVENTS.includes(value);
}

function actorAt(state: JournalStatus, context: JournalContext) {
  const snapshot = journalMachine.resolveState({ value: state, context });
  return createActor(journalMachine, { snapshot, input: context });
}

/** True iff the machine, at `state` with `context`, accepts `event` (edge + guards). */
function machineAccepts(state: JournalStatus, context: JournalContext, event: JournalMachineEvent): boolean {
  const actor = actorAt(state, context);
  actor.start();
  const can = actor.getSnapshot().can(event);
  actor.stop();
  return can;
}

// Structural probe for canTransitionJournal: an event whose entity and version match the context,
// so only the edge itself decides.
/** journal_entries.version starts at 1 (migration 0041 chk_journal_entries_version). */
const FIRST_VERSION = 1;
const STRUCTURAL_CONTEXT: JournalContext = { entityId: '', version: FIRST_VERSION };

/** True iff `eventType` is a legal edge from `current` (per the state chart above). */
export function canTransitionJournal(current: JournalStatus, eventType: string): boolean {
  if (!isJournalEventType(eventType)) return false;
  return machineAccepts(current, STRUCTURAL_CONTEXT, {
    type: eventType,
    entityId: STRUCTURAL_CONTEXT.entityId,
    expectedVersion: STRUCTURAL_CONTEXT.version,
  });
}

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

/** One refusal probe: the (state, event) the machine is asked about, and the error its refusal
 *  maps to. Each probe neutralises the guards checked after it, so the FIRST refused probe names
 *  the reason, in the ruling's precedence. */
interface RefusalProbe {
  readonly probe: (entry: JournalEntryState, event: JournalMachineEvent) => { readonly state: JournalStatus; readonly event: JournalMachineEvent };
  readonly refuse: (entry: JournalEntryState, event: JournalMachineEvent) => Error;
}

const REFUSAL_PROBES: readonly RefusalProbe[] = [
  {
    // sameEntity alone: from `posted`, with the entry's own version.
    probe: (entry, event) => ({ state: JOURNAL_STATUS.POSTED, event: { ...event, expectedVersion: entry.version } }),
    refuse: (_entry, event) =>
      new EntityNotInScopeError(
        `the reversal is made in entity ${event.entityId}, not the entry's own entity ` +
          '(Allowed: a reversal in the same entity as the entry)',
      ),
  },
  {
    // the chart alone: from the entry's status, with its own entity and version.
    probe: (entry, event) => ({ state: entry.status, event: { ...event, entityId: entry.entityId, expectedVersion: entry.version } }),
    refuse: (entry) =>
      new AlreadyReversedError(`the journal entry is already "${entry.status}" (Allowed: one reversal of a posted entry)`),
  },
  {
    // versionMatches: the full event from the entry's status.
    probe: (entry, event) => ({ state: entry.status, event }),
    refuse: (entry, event) =>
      new StaleVersionError(
        `expectedVersion ${event.expectedVersion} no longer matches the entry's version ${entry.version} (optimistic lock)`,
      ),
  },
];

/**
 * Applies `event` to `entry` and returns the next status. THROWS, in this precedence (an
 * out-of-scope caller learns nothing about the entry's state): IllegalJournalTransitionError for an
 * event with no edge anywhere, EntityNotInScopeError, AlreadyReversedError, StaleVersionError —
 * each decided by the machine's own guards/chart (snapshot.can), never by a hand-written check.
 */
export function advanceJournalStatus(entry: JournalEntryState, event: ReverseJournalEvent): JournalStatus {
  if (!isJournalEventType(event.type)) {
    throw new IllegalJournalTransitionError(
      `${String(event.type)} is not a journal-entry event (Allowed: [${KNOWN_EVENTS.join(', ')}])`,
    );
  }
  const context: JournalContext = { entityId: entry.entityId, version: entry.version };
  const machineEvent: JournalMachineEvent = { type: event.type, entityId: event.entityId, expectedVersion: event.expectedVersion };
  const refused = REFUSAL_PROBES.find(({ probe }) => {
    const asked = probe(entry, machineEvent);
    return !machineAccepts(asked.state, context, asked.event);
  });
  if (refused) throw refused.refuse(entry, machineEvent);

  const actor = actorAt(entry.status, context);
  actor.start();
  actor.send(machineEvent);
  const next = actor.getSnapshot().value;
  actor.stop();
  if (!isJournalStatus(next)) {
    throw new IllegalJournalTransitionError(
      `the journal machine reached an unknown state (Allowed: ${JOURNAL_STATUS_VALUES.join(', ')})`,
    );
  }
  return next;
}
