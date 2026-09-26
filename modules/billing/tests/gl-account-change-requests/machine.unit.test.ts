// modules/billing/tests/gl-account-change-requests/machine.unit.test.ts — WBS 4.1a part 2.
//
// CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions — XState." Pure unit tests for
// the gl_account_change_requests status machine — no DB, no I/O. Mirrors the golden slice's own
// modules/wms/domain/receive-inbound/machine.ts idiom (setup/createMachine, `.can()`,
// `resolveState`/actorAt re-hydration, an exhaustive states x events table).
//
// SURFACE (built — modules/billing/domain/gl-account-change-requests/machine.ts exports every name
// below; this file exercises the real, live machine):
//
//   GL_ACCOUNT_CHANGE_REQUEST_STATUS — the 5-value status enum, verbatim from the brief's own
//     `status text not null default 'draft' check (status in
//     ('draft','pending_approval','approved','rejected','cancelled'))`:
//       { DRAFT: 'draft', PENDING_APPROVAL: 'pending_approval', APPROVED: 'approved',
//         REJECTED: 'rejected', CANCELLED: 'cancelled' }
//
//   GL_ACCOUNT_CHANGE_REQUEST_EVENTS — the 4 event-type constants this machine accepts:
//       { SUBMIT: 'SUBMIT_GL_ACCOUNT_CHANGE_REQUEST', APPROVE: 'APPROVE_GL_ACCOUNT_CHANGE_REQUEST',
//         REJECT: 'REJECT_GL_ACCOUNT_CHANGE_REQUEST', CANCEL: 'CANCEL_GL_ACCOUNT_CHANGE_REQUEST' }
//
//   glAccountChangeRequestMachine — a PURE XState v5 machine, `id: 'glAccountChangeRequest'`,
//     `initial: GL_ACCOUNT_CHANGE_REQUEST_STATUS.DRAFT`, one state per
//     GL_ACCOUNT_CHANGE_REQUEST_STATUS value, no context/guards/actions (same "pure state chart,
//     consulted only through .can()" shape as the golden slice's inboundOrderMachine) — the EDGES:
//       draft --SUBMIT--> pending_approval
//       pending_approval --APPROVE--> approved
//       pending_approval --REJECT--> rejected
//       pending_approval --CANCEL--> cancelled
//     approved / rejected / cancelled are `type: 'final'` — no event is ever legal from them.
//
//   canTransition(current, event): boolean — same shape as the golden slice's own canTransition.
//   allowedEventsFrom(current): GlAccountChangeRequestEventType[] — same shape as the golden slice's
//     own allowedEventsFrom, used by IllegalTransitionError's own message.
//
//   assertCancelAllowed(current, requestedBy, actorId): void — the OWNERSHIP guard the brief's own
//     Scenario ("an approver-only or a non-owner cancel attempt is rejected") needs, kept OUTSIDE
//     the pure machine's states (the machine only knows status, never who is calling) — same
//     "role/ownership gate as a plain exported function, consulted by the application layer BEFORE
//     any DB call" discipline as the golden slice's own INBOUND_EVENT_ROLES map, but here the gate
//     is OWNERSHIP (actorId === requestedBy), not a role code:
//       - throws IllegalTransitionError (../../domain/gl-account-change-requests/errors.js) iff
//         canTransition(current, GL_ACCOUNT_CHANGE_REQUEST_EVENTS.CANCEL) is false (e.g. from
//         'approved'/'rejected'/'cancelled'/'draft') — the SAME error the illegal-transition
//         scenario uses, checked FIRST;
//       - throws NotRequesterError (../../domain/gl-account-change-requests/errors.js, NEW — not yet
//         in the scaffolded errors.ts) iff the machine transition itself is legal but
//         actorId !== requestedBy;
//       - returns (no throw) iff canTransition is true AND actorId === requestedBy.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  GL_ACCOUNT_CHANGE_REQUEST_EVENTS,
  GL_ACCOUNT_CHANGE_REQUEST_STATUS,
  glAccountChangeRequestMachine,
  canTransition,
  allowedEventsFrom,
  assertCancelAllowed,
} from '../../domain/gl-account-change-requests/machine.js';
import { IllegalTransitionError, NotRequesterError } from '../../domain/gl-account-change-requests/errors.js';

const STATES = Object.values(GL_ACCOUNT_CHANGE_REQUEST_STATUS);
const EVENTS = Object.values(GL_ACCOUNT_CHANGE_REQUEST_EVENTS);

// The single source of truth this exhaustive table is checked against — the brief's own transitions
// section verbatim: "draft -> pending_approval -> approved | rejected; pending_approval -> cancelled
// (by the requester only, while still pending)".
const LEGAL_EDGES: ReadonlyArray<{ readonly from: string; readonly event: string; readonly to: string }> = [
  {
    from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.DRAFT,
    event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.SUBMIT,
    to: GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL,
  },
  {
    from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL,
    event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.APPROVE,
    to: GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED,
  },
  {
    from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL,
    event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.REJECT,
    to: GL_ACCOUNT_CHANGE_REQUEST_STATUS.REJECTED,
  },
  {
    from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL,
    event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.CANCEL,
    to: GL_ACCOUNT_CHANGE_REQUEST_STATUS.CANCELLED,
  },
];

const LEGAL_EDGE_KEYS = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

const REQUESTER_UUID = '00000000-0000-4000-8000-0000004a1a01';
const CFO_UUID = '00000000-0000-4000-8000-0000004a1a02';
const OTHER_ACCOUNTANT_UUID = '00000000-0000-4000-8000-0000004a1a03';

function actorAt(state: string) {
  // Same re-hydration idiom as the golden slice's own actorAt: start a fresh actor and re-hydrate
  // it at the target state via the machine's own initial snapshot shape, never a hand-written
  // transition table.
  const initial = createActor(glAccountChangeRequestMachine).getSnapshot();
  const snapshot = { ...initial, value: state };
  return createActor(glAccountChangeRequestMachine, { snapshot });
}

describe('glAccountChangeRequestMachine — exhaustive legal/illegal transition table (5 states x 4 events)', () => {
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

describe('glAccountChangeRequestMachine — the two legal happy-path walks', () => {
  it('draft -> pending_approval -> approved', () => {
    const actor = createActor(glAccountChangeRequestMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(GL_ACCOUNT_CHANGE_REQUEST_STATUS.DRAFT);

    actor.send({ type: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.SUBMIT });
    expect(actor.getSnapshot().value).toBe(GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL);

    actor.send({ type: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.APPROVE });
    expect(actor.getSnapshot().value).toBe(GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED);
    actor.stop();
  });

  it('draft -> pending_approval -> rejected', () => {
    const actor = createActor(glAccountChangeRequestMachine);
    actor.start();
    actor.send({ type: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.SUBMIT });
    actor.send({ type: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.REJECT });
    expect(actor.getSnapshot().value).toBe(GL_ACCOUNT_CHANGE_REQUEST_STATUS.REJECTED);
    actor.stop();
  });

  it('pending_approval -> cancelled (the machine EDGE alone — assertCancelAllowed\'s own ownership check is exercised separately below)', () => {
    const actor = actorAt(GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL);
    actor.start();
    actor.send({ type: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.CANCEL });
    expect(actor.getSnapshot().value).toBe(GL_ACCOUNT_CHANGE_REQUEST_STATUS.CANCELLED);
    actor.stop();
  });
});

describe('glAccountChangeRequestMachine — illegal transitions are rejected by the machine itself, before any DB call', () => {
  it.each([
    { from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED, event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.CANCEL },
    { from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.CANCELLED, event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.APPROVE },
    { from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.REJECTED, event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.APPROVE },
    { from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.DRAFT, event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.APPROVE },
    { from: GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL, event: GL_ACCOUNT_CHANGE_REQUEST_EVENTS.SUBMIT },
  ])('REJECTS $event from $from (canTransition returns false)', ({ from, event }) => {
    expect(canTransition(from, event)).toBe(false);
  });

  it('canTransition returns true only for the four documented edges', () => {
    for (const from of STATES) {
      for (const event of EVENTS) {
        expect(canTransition(from, event)).toBe(LEGAL_EDGE_KEYS.has(`${from}|${event}`));
      }
    }
  });

  it('allowedEventsFrom lists exactly the legal events for a mid-flow state', () => {
    const allowed = allowedEventsFrom(GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL);
    expect(new Set(allowed)).toEqual(
      new Set([
        GL_ACCOUNT_CHANGE_REQUEST_EVENTS.APPROVE,
        GL_ACCOUNT_CHANGE_REQUEST_EVENTS.REJECT,
        GL_ACCOUNT_CHANGE_REQUEST_EVENTS.CANCEL,
      ]),
    );
  });

  it.each([GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED, GL_ACCOUNT_CHANGE_REQUEST_STATUS.REJECTED, GL_ACCOUNT_CHANGE_REQUEST_STATUS.CANCELLED])(
    '%s is terminal — allowedEventsFrom returns an empty list',
    (terminal) => {
      expect(allowedEventsFrom(terminal)).toEqual([]);
    },
  );
});

describe('assertCancelAllowed — the ownership guard (approver-role or non-owner cancel is rejected before any DB call)', () => {
  it('does not throw when the request is pending_approval and actorId is the requester', () => {
    expect(() =>
      assertCancelAllowed(GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL, REQUESTER_UUID, REQUESTER_UUID),
    ).not.toThrow();
  });

  it('throws NotRequesterError when the request is pending_approval but actorId is the CFO (approver), not the requester', () => {
    expect(() =>
      assertCancelAllowed(GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL, REQUESTER_UUID, CFO_UUID),
    ).toThrow(NotRequesterError);
  });

  it('throws NotRequesterError when the request is pending_approval but actorId is a DIFFERENT accountant (non-owner), not the requester', () => {
    expect(() =>
      assertCancelAllowed(GL_ACCOUNT_CHANGE_REQUEST_STATUS.PENDING_APPROVAL, REQUESTER_UUID, OTHER_ACCOUNTANT_UUID),
    ).toThrow(NotRequesterError);
  });

  it.each([
    GL_ACCOUNT_CHANGE_REQUEST_STATUS.DRAFT,
    GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED,
    GL_ACCOUNT_CHANGE_REQUEST_STATUS.REJECTED,
    GL_ACCOUNT_CHANGE_REQUEST_STATUS.CANCELLED,
  ])('throws IllegalTransitionError from %s, even for the requester themself (the machine edge does not exist)', (from) => {
    expect(() => assertCancelAllowed(from, REQUESTER_UUID, REQUESTER_UUID)).toThrow(IllegalTransitionError);
  });

  it('checks the machine transition BEFORE ownership: a non-owner cancelling from a terminal state gets IllegalTransitionError, not NotRequesterError', () => {
    expect(() => assertCancelAllowed(GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED, REQUESTER_UUID, CFO_UUID)).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('glAccountChangeRequestMachine — terminal states accept no event at all', () => {
  it.each([
    GL_ACCOUNT_CHANGE_REQUEST_STATUS.APPROVED,
    GL_ACCOUNT_CHANGE_REQUEST_STATUS.REJECTED,
    GL_ACCOUNT_CHANGE_REQUEST_STATUS.CANCELLED,
  ])('%s accepts no event', (terminalState) => {
    const actor = actorAt(terminalState);
    actor.start();
    for (const event of EVENTS) {
      expect(actor.getSnapshot().can({ type: event })).toBe(false);
    }
    actor.stop();
  });
});
