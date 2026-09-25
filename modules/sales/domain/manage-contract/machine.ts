// modules/sales/domain/manage-contract/machine.ts — WBS 1.7, M02 sales.
//
// domain/ layer: pure state-transition rules for sales.contracts.status, no I/O, no Date, no
// Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for
// state transitions — XState." The application layer (../../application/manage-contract/*) asks
// this machine whether an event is legal from the contract's current status via
// `actor.getSnapshot().can({ type })`, never a hand-written if/switch on the status string —
// including "is this contract usable for an order" (decided via `hasTag(CONTRACT_TAG_USABLE_FOR_ORDER)`
// rather than a status-string comparison — mirrors manage-quote's QUOTE_TAG_EDITABLE idiom).
//
// Source: slice brief Master decision 1. `CONTRACT_STATUS` is verbatim from `chk_contracts_status`
// (database/schema/13B-Schema-Reference-Consolidation.sql:2317-2320) — 7 values.

import { createActor, createMachine } from 'xstate';

import { IllegalTransitionError } from './errors.js';

/** sales.contracts.status — the 7-value check constraint `chk_contracts_status`, verbatim. */
export const CONTRACT_STATUS = {
  DRAFT: 'draft',
  SIGNED: 'signed',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  EXPIRED: 'expired',
  RENEWED: 'renewed',
  TERMINATED: 'terminated',
} as const;

export type ContractStatus = (typeof CONTRACT_STATUS)[keyof typeof CONTRACT_STATUS];

/** The 5 event types this machine accepts (slice brief Master decision 1). EXPIRE_CONTRACT has TWO
 *  source edges (from `active` AND from `suspended`, both to `expired`) — a single event type with
 *  two `on` entries in two different state nodes, same XState idiom as quote's RETURN_TO_DRAFT. */
export const CONTRACT_EVENTS = {
  SIGN_CONTRACT: 'SIGN_CONTRACT',
  ACTIVATE_CONTRACT: 'ACTIVATE_CONTRACT',
  SUSPEND_CONTRACT: 'SUSPEND_CONTRACT',
  RESUME_CONTRACT: 'RESUME_CONTRACT',
  EXPIRE_CONTRACT: 'EXPIRE_CONTRACT',
} as const;

export type ContractEventType = (typeof CONTRACT_EVENTS)[keyof typeof CONTRACT_EVENTS];

/** The `active` state's own tag — `assertContractUsableForOrder` (./invariants.ts) asks the machine
 *  via `snapshot.hasTag(CONTRACT_TAG_USABLE_FOR_ORDER)` instead of branching on the status string.
 *  ONLY `active` carries it (Master decision 1). */
export const CONTRACT_TAG_USABLE_FOR_ORDER = 'usableForOrder';

/** Master decision 4 ("SetContractPriceList ... legal from draft/signed/active/suspended — i.e.
 *  any non-terminal status"): carried by every status EXCEPT the three terminal ones
 *  (expired/renewed/terminated) — `assertPriceListAssignable` (./invariants.ts) asks the machine
 *  via `snapshot.hasTag(CONTRACT_TAG_PRICE_LIST_ASSIGNABLE)` instead of branching on the status
 *  string. */
export const CONTRACT_TAG_PRICE_LIST_ASSIGNABLE = 'priceListAssignable';

/** pg-reviewer fix round 1, finding 1: Master decision 9 ("the contract row IS still locked for
 *  update first to serialise concurrent SLA additions and to check the contract exists and is in
 *  a state where SLA terms make sense (not terminated)") — carried by every status EXCEPT
 *  `terminated` — `assertSlaAssignable` (./invariants.ts) asks the machine via
 *  `snapshot.hasTag(CONTRACT_TAG_SLA_ASSIGNABLE)` instead of an if/switch comparing the status
 *  string to 'terminated' (the exact mistake WBS 1.6's review caught in return-to-draft.ts). */
export const CONTRACT_TAG_SLA_ASSIGNABLE = 'slaAssignable';

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (role gates, optimistic lock, DB writes); this machine only decides WHETHER
 * one is legal from the current status (and, via tags, which status is usable for an order).
 * `id: 'contract'`, one state per CONTRACT_STATUS value, exactly the 6 edges below and no others.
 * `renewed`/`terminated` are legal status values with NO producing edge in this slice
 * (RenewContract/TerminateContract deferred — brief Scope defaults).
 */
export const contractMachine = createMachine({
  id: 'contract',
  initial: CONTRACT_STATUS.DRAFT,
  states: {
    [CONTRACT_STATUS.DRAFT]: {
      tags: [CONTRACT_TAG_PRICE_LIST_ASSIGNABLE, CONTRACT_TAG_SLA_ASSIGNABLE],
      on: {
        [CONTRACT_EVENTS.SIGN_CONTRACT]: CONTRACT_STATUS.SIGNED,
      },
    },
    [CONTRACT_STATUS.SIGNED]: {
      tags: [CONTRACT_TAG_PRICE_LIST_ASSIGNABLE, CONTRACT_TAG_SLA_ASSIGNABLE],
      on: {
        [CONTRACT_EVENTS.ACTIVATE_CONTRACT]: CONTRACT_STATUS.ACTIVE,
      },
    },
    [CONTRACT_STATUS.ACTIVE]: {
      tags: [CONTRACT_TAG_USABLE_FOR_ORDER, CONTRACT_TAG_PRICE_LIST_ASSIGNABLE, CONTRACT_TAG_SLA_ASSIGNABLE],
      on: {
        [CONTRACT_EVENTS.SUSPEND_CONTRACT]: CONTRACT_STATUS.SUSPENDED,
        [CONTRACT_EVENTS.EXPIRE_CONTRACT]: CONTRACT_STATUS.EXPIRED,
      },
    },
    [CONTRACT_STATUS.SUSPENDED]: {
      tags: [CONTRACT_TAG_PRICE_LIST_ASSIGNABLE, CONTRACT_TAG_SLA_ASSIGNABLE],
      on: {
        [CONTRACT_EVENTS.RESUME_CONTRACT]: CONTRACT_STATUS.ACTIVE,
        [CONTRACT_EVENTS.EXPIRE_CONTRACT]: CONTRACT_STATUS.EXPIRED,
      },
    },
    [CONTRACT_STATUS.EXPIRED]: {
      tags: [CONTRACT_TAG_SLA_ASSIGNABLE],
      type: 'final',
    },
    [CONTRACT_STATUS.RENEWED]: {
      tags: [CONTRACT_TAG_SLA_ASSIGNABLE],
      type: 'final',
    },
    [CONTRACT_STATUS.TERMINATED]: {
      type: 'final',
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: ContractStatus) {
  const snapshot = contractMachine.resolveState({ value: state });
  return createActor(contractMachine, { snapshot });
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: ContractStatus): ContractEventType[] {
  return Object.values(CONTRACT_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). The
 * application layer uses this INSTEAD OF an if/switch on the status string — CLAUDE.md · AGENT
 * CONSTRAINTS: "No if/switch for state transitions — XState."
 */
export function canTransition(current: ContractStatus, event: ContractEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/**
 * True iff `state` carries `tag` (e.g. CONTRACT_TAG_USABLE_FOR_ORDER) — the machine's own tag
 * lookup, never a status-string comparison.
 */
export function hasContractTag(state: ContractStatus, tag: string): boolean {
  const actor = actorAt(state);
  actor.start();
  const has = actor.getSnapshot().hasTag(tag);
  actor.stop();
  return has;
}

/**
 * Sends each of `events`, in order, to a single actor started at `current`. THROWS
 * IllegalTransitionError the moment any event in the sequence is not legal in the actor's state at
 * that point — it never skips one silently. An empty `events` array is a legitimate "no
 * transition needed" no-op and returns `current` unchanged.
 */
export function advanceContract(current: ContractStatus, events: readonly ContractEventType[]): ContractStatus {
  const actor = actorAt(current);
  actor.start();
  for (const event of events) {
    if (!actor.getSnapshot().can({ type: event })) {
      const from = actor.getSnapshot().value as ContractStatus;
      actor.stop();
      const allowed = allowedEventsFrom(from);
      throw new IllegalTransitionError(
        `${event} is not a legal transition from contract status "${from}". ` +
          `(Allowed from "${from}": ${allowed.length > 0 ? allowed.join(', ') : 'none, terminal state'})`,
      );
    }
    actor.send({ type: event });
  }
  const result = actor.getSnapshot().value as ContractStatus;
  actor.stop();
  return result;
}
