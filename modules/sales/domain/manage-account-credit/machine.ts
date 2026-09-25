// modules/sales/domain/manage-account-credit/machine.ts — WBS 1.8, M02 sales.
//
// domain/ layer: pure state-transition rules for sales.accounts.credit_hold, no I/O, no Date, no
// Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for state
// transitions — XState."
//
// pg-reviewer fix round 1, finding 1 (overturns the original Master decision 1 reasoning):
// `credit_hold` IS a two-state transition table (`clear`/`held`) with a role on each edge and ONE
// forbidden move (RELEASE when not held) — exactly what the "no if/switch for state transitions"
// rule targets. `assertOnHold` (./invariants.ts) asks this machine's own `assertReleaseLegal`
// instead of a hand-written `if (!creditHold)`. `assertAccountCreditOk` (the read-only S6 guard)
// stays a plain boolean predicate — the reviewer confirmed that one is fine as-is: it checks a
// fact (`creditHold === true`), it does not decide whether a TRANSITION is legal.
//
// `sales.accounts.credit_hold` itself stays a boolean column (Master decision 10's migration
// already applied) — this machine is a pure domain-layer view over that boolean, derived via
// `creditStateFromRow`, never persisted as a separate enum column (no schema change, no G-01 item).

import { createActor, createMachine } from 'xstate';

import { NotOnHoldError } from './errors.js';

export const CREDIT_STATUS = {
  CLEAR: 'clear',
  HELD: 'held',
} as const;

export type CreditStatus = (typeof CREDIT_STATUS)[keyof typeof CREDIT_STATUS];

/** SET_HOLD: clear -> held, AND held -> held (a self-transition — Master decision 3: re-placing an
 *  already-active hold with a new reason is legal). RELEASE: held -> clear ONLY — illegal from
 *  `clear` (Master decision 4's own no-op guard; the chart has no such edge at all). */
export const CREDIT_EVENTS = {
  SET_HOLD: 'SET_HOLD',
  RELEASE: 'RELEASE',
} as const;

export type CreditEventType = (typeof CREDIT_EVENTS)[keyof typeof CREDIT_EVENTS];

/** The `held` state's own tag (D-blueprint 02 §4.5 step 6: a hold "blocks new outbound orders,
 *  delivery tasks and CC queues in all entities"). Not consumed by any invariant in THIS slice
 *  (there is no order-placing path yet — Scope) but named here so a future order-placing slice can
 *  ask `hasCreditTag(state, CREDIT_TAG_BLOCKS_ORDERS)` instead of re-deriving the boolean itself. */
export const CREDIT_TAG_BLOCKS_ORDERS = 'blocksOrders';

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes, the reason string); this machine
 * only decides WHETHER one is legal from the current state. `id: 'credit'`, 2 states, 3 edges
 * (SET_HOLD x2, RELEASE x1) and no others.
 */
export const creditMachine = createMachine({
  id: 'credit',
  initial: CREDIT_STATUS.CLEAR,
  states: {
    [CREDIT_STATUS.CLEAR]: {
      on: {
        [CREDIT_EVENTS.SET_HOLD]: CREDIT_STATUS.HELD,
      },
    },
    [CREDIT_STATUS.HELD]: {
      tags: [CREDIT_TAG_BLOCKS_ORDERS],
      on: {
        [CREDIT_EVENTS.SET_HOLD]: CREDIT_STATUS.HELD,
        [CREDIT_EVENTS.RELEASE]: CREDIT_STATUS.CLEAR,
      },
    },
  },
});

/** `sales.accounts.credit_hold` (boolean) -> this machine's own two-value state — the ONE place
 *  the boolean-to-state mapping happens. */
export function creditStateFromRow(row: { readonly creditHold: boolean }): CreditStatus {
  return row.creditHold ? CREDIT_STATUS.HELD : CREDIT_STATUS.CLEAR;
}

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: CreditStatus) {
  const snapshot = creditMachine.resolveState({ value: state });
  return createActor(creditMachine, { snapshot });
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer uses this INSTEAD OF an if/switch on the boolean — CLAUDE.md · AGENT
 * CONSTRAINTS: "No if/switch for state transitions — XState."
 */
export function canTransition(current: CreditStatus, event: CreditEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * True iff `state` carries `tag` (e.g. CREDIT_TAG_BLOCKS_ORDERS) — the machine's own tag lookup,
 * never a boolean comparison.
 */
export function hasCreditTag(state: CreditStatus, tag: string): boolean {
  const actor = actorAt(state);
  actor.start();
  const has = actor.getSnapshot().hasTag(tag);
  actor.stop();
  return has;
}

/** Master decision 4: ReleaseCreditHold's own no-op guard — throws NotOnHoldError iff RELEASE is
 *  not a legal transition from `state` (i.e. `state` is `clear`, which has no RELEASE edge at all
 *  in the chart above); returns (no throw) iff legal (i.e. `state` is `held`). Replaces the former
 *  hand-written `if (!creditHold)` (pg-reviewer fix round 1, finding 1) — the machine decides
 *  legality, never an if/switch on the boolean. */
export function assertReleaseLegal(state: CreditStatus): void {
  if (!canTransition(state, CREDIT_EVENTS.RELEASE)) {
    throw new NotOnHoldError(
      `ReleaseCreditHold: RELEASE is not a legal transition from credit state "${state}" — the ` +
        'account is not currently on hold (Master decision 4).',
    );
  }
}
