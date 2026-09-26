// modules/billing/domain/gl-account-change-requests/machine.ts — WBS 4.1a part 2.
//
// domain/ layer: pure state-transition rules for billing.gl_account_change_requests.status, no I/O,
// no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No
// if/switch for state transitions — XState." Same idiom as the golden slice's own
// modules/wms/domain/receive-inbound/machine.ts — a status enum, an events enum, and a single flat
// XState v5 machine consulted only through `.can()`.
//
// Source: docs/notes/slice-briefs/_slice-4.1a-part2.brief.md "Status transitions" section —
// `draft -> pending_approval -> approved | rejected`; `pending_approval -> cancelled` (by the
// requester only, while still pending). The DB CHECK on `status` (migration
// 0034_2_gl-account-change-requests.sql) is the backstop, never the only line of defence; this
// machine is the single source of truth for which transitions are legal.

import { createActor, createMachine } from 'xstate';

import { IllegalTransitionError, NotRequesterError } from './errors.js';

/** billing.gl_account_change_requests.status — the 5-value check constraint, verbatim (brief's
 *  own "Schema design" section). */
export const GL_ACCOUNT_CHANGE_REQUEST_STATUS = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
} as const;

export type GlAccountChangeRequestStatus =
  (typeof GL_ACCOUNT_CHANGE_REQUEST_STATUS)[keyof typeof GL_ACCOUNT_CHANGE_REQUEST_STATUS];

/** The 4 event types this machine accepts — one per legal edge in the brief's own transitions
 *  section. */
export const GL_ACCOUNT_CHANGE_REQUEST_EVENTS = {
  SUBMIT: 'SUBMIT_GL_ACCOUNT_CHANGE_REQUEST',
  APPROVE: 'APPROVE_GL_ACCOUNT_CHANGE_REQUEST',
  REJECT: 'REJECT_GL_ACCOUNT_CHANGE_REQUEST',
  CANCEL: 'CANCEL_GL_ACCOUNT_CHANGE_REQUEST',
} as const;

export type GlAccountChangeRequestEventType =
  (typeof GL_ACCOUNT_CHANGE_REQUEST_EVENTS)[keyof typeof GL_ACCOUNT_CHANGE_REQUEST_EVENTS];

/**
 * Pure state chart — no actions, no guards, no context: the application layer (when built, part 2b)
 * decides everything ABOUT a transition (role/ownership gates, optimistic lock, DB writes); this
 * machine only decides WHETHER one is legal from the current status. `id: 'glAccountChangeRequest'`,
 * one state per GL_ACCOUNT_CHANGE_REQUEST_STATUS value, exactly the edges the brief's own
 * "Status transitions" section describes. `approved`/`rejected`/`cancelled` are `type: 'final'` — no
 * event is ever legal from them.
 */
export const glAccountChangeRequestMachine = createMachine({
  id: 'glAccountChangeRequest',
  initial: GL_ACCOUNT_CHANGE_REQUEST_STATUS.DRAFT,
  states: {
    [GL_ACCOUNT_CHANGE_REQUEST_STATUS.DRAFT]: {
      on: {
        [GL_ACCOUNT_CHANGE_REQUEST_EVENTS.SUBMIT]: GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL,
      },
    },
    [GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL]: {
      on: {
        [GL_ACCOUNT_CHANGE_REQUEST_EVENTS.APPROVE]: GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED,
        [GL_ACCOUNT_CHANGE_REQUEST_EVENTS.REJECT]: GL_ACCOUNT_CHANGE_REQUEST_STATUS.REJECTED,
        [GL_ACCOUNT_CHANGE_REQUEST_EVENTS.CANCEL]: GL_ACCOUNT_CHANGE_REQUEST_STATUS.CANCELLED,
      },
    },
    [GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED]: {
      type: 'final',
    },
    [GL_ACCOUNT_CHANGE_REQUEST_STATUS.REJECTED]: {
      type: 'final',
    },
    [GL_ACCOUNT_CHANGE_REQUEST_STATUS.CANCELLED]: {
      type: 'final',
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: GlAccountChangeRequestStatus) {
  const snapshot = glAccountChangeRequestMachine.resolveState({ value: state });
  return createActor(glAccountChangeRequestMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: GlAccountChangeRequestStatus): GlAccountChangeRequestEventType[] {
  return Object.values(GL_ACCOUNT_CHANGE_REQUEST_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer (when built) uses this INSTEAD OF an if/switch on the status string —
 * CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions — XState."
 */
export function canTransition(
  current: GlAccountChangeRequestStatus,
  event: GlAccountChangeRequestEventType,
): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * The requester-only ownership guard for CANCEL (brief's own Scenario: "The requester cancels
 * their own still-pending request; an approver-only or a non-owner cancel attempt is rejected").
 * Kept OUTSIDE the pure machine's states — the machine only knows status, never who is calling.
 *
 * Checks the machine transition FIRST: throws `IllegalTransitionError` iff
 * `canTransition(current, CANCEL)` is false (e.g. from 'approved'/'rejected'/'cancelled'/'draft') —
 * the SAME error the illegal-transition scenario uses. Only once the transition itself is legal
 * does it check ownership: throws `NotRequesterError` iff `actorId !== requestedBy`. Returns (no
 * throw) iff both checks pass.
 */
export function assertCancelAllowed(
  current: GlAccountChangeRequestStatus,
  requestedBy: string,
  actorId: string,
): void {
  if (!canTransition(current, GL_ACCOUNT_CHANGE_REQUEST_EVENTS.CANCEL)) {
    const allowed = allowedEventsFrom(current);
    throw new IllegalTransitionError(
      `${GL_ACCOUNT_CHANGE_REQUEST_EVENTS.CANCEL} is not a legal transition from gl-account-change-request ` +
        `status "${current}". (Allowed from "${current}": ${allowed.length > 0 ? allowed.join(', ') : 'none, terminal state'})`,
    );
  }

  if (actorId !== requestedBy) {
    throw new NotRequesterError(
      `gl-account-change-request: only the requester (${requestedBy}) may cancel this request — ` +
        `actor ${actorId} is not the requester.`,
    );
  }
}
