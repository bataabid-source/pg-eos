// modules/sales/domain/manage-quote/machine.ts — WBS 1.6, M02 sales.
//
// domain/ layer: pure state-transition rules for sales.quotes.status, no I/O, no Date,
// no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for
// state transitions — XState." The application layer (../../application/manage-quote/*) asks this
// machine whether an event is legal from the quote's current status via
// `actor.getSnapshot().can({ type })`, never a hand-written if/switch on the status string —
// including the "is this quote frozen" question, decided via `hasTag(QUOTE_TAG_FROZEN)` rather
// than a status-string comparison (mirrors catalog's PRICE_LIST_TAG_EDITABLE idiom, extended with
// a second tag for this aggregate's own frozen/revisable states).
//
// Source: slice brief Master decision 1. `QUOTE_STATUS` is verbatim from `chk_quotes_status`
// (database/schema/13B-Schema-Reference-Consolidation.sql:2314-2316) — 8 values.

import { createActor, createMachine } from 'xstate';

import { IllegalTransitionError } from './errors.js';

/** sales.quotes.status — the 8-value check constraint `chk_quotes_status`, verbatim. */
export const QUOTE_STATUS = {
  DRAFT: 'draft',
  COMMERCIAL_REVIEW: 'commercial_review',
  FINANCE_REVIEW: 'finance_review',
  APPROVED: 'approved',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const;

export type QuoteStatus = (typeof QUOTE_STATUS)[keyof typeof QUOTE_STATUS];

/** The 7 event types this machine accepts (slice brief Master decision 1). RecordDecision sends
 *  one of the two RECORD_DECISION_* events depending on the caller's own `decision` field — `sent`
 *  has two outgoing edges to two different terminal states, and an XState `on` map keys
 *  transitions by event type, not by a runtime payload value. */
export const QUOTE_EVENTS = {
  SUBMIT_FOR_REVIEW: 'SUBMIT_FOR_REVIEW',
  APPROVE_COMMERCIAL: 'APPROVE_COMMERCIAL',
  RETURN_TO_DRAFT: 'RETURN_TO_DRAFT',
  APPROVE_FINANCE: 'APPROVE_FINANCE',
  SEND_QUOTE: 'SEND_QUOTE',
  RECORD_DECISION_ACCEPTED: 'RECORD_DECISION_ACCEPTED',
  RECORD_DECISION_REJECTED: 'RECORD_DECISION_REJECTED',
} as const;

export type QuoteEventType = (typeof QUOTE_EVENTS)[keyof typeof QUOTE_EVENTS];

// pg-reviewer fix round 1, finding 3: which role(s) may call ReturnToDraft from a given status is
// DATA carried on the machine's own state nodes (`meta.returnRoles`), read via the machine/
// snapshot — never a status-string if/switch in the application layer (CLAUDE.md · ARCHITECTURE:
// "No if/switch for state transitions — XState").
const ROLE_SALES_MGR = 'SALES_MGR';
const ROLE_CFO = 'CFO';
const ROLE_GM = 'GM';

interface QuoteStateMeta {
  readonly returnRoles?: readonly string[];
}

/** The `draft` state's own tag — `assertQuoteEditable` (../invariants.ts) asks the machine via
 *  `snapshot.hasTag(QUOTE_TAG_EDITABLE)` instead of branching on the status string. Only `draft`
 *  carries it (Master decision 17 — "lines are mutable only while status is draft"). */
export const QUOTE_TAG_EDITABLE = 'editable';

/** The tag carried by every status where EVERY mutating command (not just line edits) is refused
 *  with QuoteFrozenError — `sent`, `accepted`, `rejected`, `expired` (Master decision 17). A
 *  workflow command (SubmitForReview/ApproveCommercial/ApproveFinance/ReturnToDraft/SendQuote)
 *  checks this tag BEFORE asking the machine for the specific event's legality, so a call on a
 *  frozen quote always surfaces QuoteFrozenError rather than the machine's own
 *  IllegalTransitionError. RecordDecision (legal only from `sent`) and ReviseQuote (legal only
 *  from a `QUOTE_TAG_REVISABLE` status) never check this tag themselves. */
export const QUOTE_TAG_FROZEN = 'frozen';

/** The tag carried by every status ReviseQuote may act on — `approved`, `sent`, `accepted`,
 *  `rejected`, `expired` (Master decision 12: "any status EXCEPT draft/commercial_review/
 *  finance_review"). */
export const QUOTE_TAG_REVISABLE = 'revisable';

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes); this machine only decides WHETHER
 * one is legal from the current status (and, via tags, which statuses are editable/frozen/
 * revisable). `id: 'quote'`, one state per QUOTE_STATUS value, exactly the 7 edges below and no
 * others. `expired` is a legal status value with NO producing edge in this slice (ExpireQuote
 * deferred — brief Scope defaults).
 */
export const quoteMachine = createMachine({
  id: 'quote',
  initial: QUOTE_STATUS.DRAFT,
  states: {
    [QUOTE_STATUS.DRAFT]: {
      tags: [QUOTE_TAG_EDITABLE],
      on: {
        [QUOTE_EVENTS.SUBMIT_FOR_REVIEW]: QUOTE_STATUS.COMMERCIAL_REVIEW,
      },
    },
    [QUOTE_STATUS.COMMERCIAL_REVIEW]: {
      meta: { returnRoles: [ROLE_SALES_MGR] } satisfies QuoteStateMeta,
      on: {
        [QUOTE_EVENTS.APPROVE_COMMERCIAL]: QUOTE_STATUS.FINANCE_REVIEW,
        [QUOTE_EVENTS.RETURN_TO_DRAFT]: QUOTE_STATUS.DRAFT,
      },
    },
    [QUOTE_STATUS.FINANCE_REVIEW]: {
      meta: { returnRoles: [ROLE_CFO, ROLE_GM] } satisfies QuoteStateMeta,
      on: {
        [QUOTE_EVENTS.APPROVE_FINANCE]: QUOTE_STATUS.APPROVED,
        [QUOTE_EVENTS.RETURN_TO_DRAFT]: QUOTE_STATUS.DRAFT,
      },
    },
    [QUOTE_STATUS.APPROVED]: {
      tags: [QUOTE_TAG_REVISABLE],
      on: {
        [QUOTE_EVENTS.SEND_QUOTE]: QUOTE_STATUS.SENT,
      },
    },
    [QUOTE_STATUS.SENT]: {
      tags: [QUOTE_TAG_FROZEN, QUOTE_TAG_REVISABLE],
      on: {
        [QUOTE_EVENTS.RECORD_DECISION_ACCEPTED]: QUOTE_STATUS.ACCEPTED,
        [QUOTE_EVENTS.RECORD_DECISION_REJECTED]: QUOTE_STATUS.REJECTED,
      },
    },
    [QUOTE_STATUS.ACCEPTED]: {
      tags: [QUOTE_TAG_FROZEN, QUOTE_TAG_REVISABLE],
      type: 'final',
    },
    [QUOTE_STATUS.REJECTED]: {
      tags: [QUOTE_TAG_FROZEN, QUOTE_TAG_REVISABLE],
      type: 'final',
    },
    [QUOTE_STATUS.EXPIRED]: {
      tags: [QUOTE_TAG_FROZEN, QUOTE_TAG_REVISABLE],
      type: 'final',
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: QuoteStatus) {
  const snapshot = quoteMachine.resolveState({ value: state });
  return createActor(quoteMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: QuoteStatus): QuoteEventType[] {
  return Object.values(QUOTE_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer uses this INSTEAD OF an if/switch on the status string — CLAUDE.md · AGENT
 * CONSTRAINTS: "No if/switch for state transitions — XState."
 */
export function canTransition(current: QuoteStatus, event: QuoteEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * True iff `state` carries `tag` (e.g. QUOTE_TAG_EDITABLE/QUOTE_TAG_FROZEN/QUOTE_TAG_REVISABLE) —
 * the machine's own tag lookup, never a status-string comparison.
 */
export function hasQuoteTag(state: QuoteStatus, tag: string): boolean {
  const actor = actorAt(state);
  actor.start();
  const has = actor.getSnapshot().hasTag(tag);
  actor.stop();
  return has;
}

/**
 * The role(s) allowed to call ReturnToDraft FROM `state` — read from the machine's own
 * `meta.returnRoles` (via `getSnapshot().getMeta()`), never a status-string if/switch in the
 * application layer. An empty array means "no ReturnToDraft edge originates here at all" (the
 * caller falls through to `advanceQuote`'s own IllegalTransitionError).
 */
export function getReturnRoles(state: QuoteStatus): readonly string[] {
  const actor = actorAt(state);
  actor.start();
  const meta = actor.getSnapshot().getMeta()[`quote.${state}`] as QuoteStateMeta | undefined;
  actor.stop();
  return meta?.returnRoles ?? [];
}

/**
 * Sends each of `events`, in order, to a single actor started at `current`. THROWS
 * IllegalTransitionError the moment any event in the sequence is not legal in the actor's state at
 * that point — it never skips one silently. An empty `events` array is a legitimate "no
 * transition needed" no-op and returns `current` unchanged.
 */
export function advanceQuote(current: QuoteStatus, events: readonly QuoteEventType[]): QuoteStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as QuoteStatus;
      actor.stop();
      const allowed = allowedEventsFrom(from);
      throw new IllegalTransitionError(
        `${event} is not a legal transition from quote status "${from}". ` +
          `(Allowed from "${from}": ${allowed.length > 0 ? allowed.join(', ') : 'none, terminal state'})`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as QuoteStatus;
  actor.stop();
  return result;
}
