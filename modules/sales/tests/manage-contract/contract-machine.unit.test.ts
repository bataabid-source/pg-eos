// modules/sales/tests/manage-contract/contract-machine.unit.test.ts — WBS 1.7, M02 sales.
//
// Rewrite of the golden `quote-machine.unit.test.ts` (../manage-quote/quote-machine.unit.test.ts)
// for the sales.contracts state machine (slice brief Master decision 1). No I/O — pure domain/
// unit test.
//
// Expected new surface — modules/sales/domain/manage-contract/machine.ts:
//   - `CONTRACT_STATUS` — verbatim from `chk_contracts_status`
//     (database/schema/13B-Schema-Reference-Consolidation.sql:2317-2320) — 7 values: draft ·
//     signed · active · suspended · expired · renewed · terminated.
//   - `CONTRACT_EVENTS` — { SIGN_CONTRACT, ACTIVATE_CONTRACT, SUSPEND_CONTRACT, RESUME_CONTRACT,
//     EXPIRE_CONTRACT } — 5 event types (Master decision 1: EXPIRE_CONTRACT has TWO source edges,
//     from `active` AND from `suspended`, both to `expired` — a single event type with two `on`
//     entries in two different state nodes, same XState idiom as quote's RETURN_TO_DRAFT).
//   - `contractMachine` — `id: 'contract'`, `initial: CONTRACT_STATUS.DRAFT`, one state per
//     CONTRACT_STATUS value, exactly the 6 edges below and no others. `renewed`/`terminated` are
//     legal status values with NO producing edge in this slice (RenewContract/TerminateContract
//     deferred — brief Scope defaults) — they still exist as states in the chart (unreached).
//   - `CONTRACT_TAG_USABLE_FOR_ORDER` — the `active` state's own tag (mirrors quote's
//     `QUOTE_TAG_EDITABLE`) — `assertContractUsableForOrder` (../invariants.ts) asks the machine via
//     `snapshot.hasTag(CONTRACT_TAG_USABLE_FOR_ORDER)` instead of branching on the status string
//     (CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions — XState"). ONLY `active`
//     carries it (Master decision 1: "`active` is tagged `usableForOrder` — nothing else is").
//   - `canTransition(current, event): boolean` — asks the machine via `.can()`.
//   - `hasContractTag(state, tag): boolean` — asks the machine via `.hasTag()`.
//   - `advanceContract(current, events): status` — sends each event in order, THROWS
//     IllegalTransitionError (../errors.js) the moment one is illegal.
//
// LEGAL EDGES (slice brief Master decision 1, the SINGLE source of truth this exhaustive table is
// checked against — only the named edges are legal, every other (status, event) pair REJECTS):
//   draft       --SIGN_CONTRACT-->     signed
//   signed      --ACTIVATE_CONTRACT--> active
//   active      --SUSPEND_CONTRACT-->  suspended
//   suspended   --RESUME_CONTRACT-->   active
//   active      --EXPIRE_CONTRACT-->   expired
//   suspended   --EXPIRE_CONTRACT-->   expired
//
// Exhaustive: every one of the 7 states x 5 events = 35 combinations is checked via XState v5's own
// `actor.getSnapshot().can(event)` — never a hand-rolled comparison.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  CONTRACT_EVENTS,
  CONTRACT_STATUS,
  CONTRACT_TAG_PRICE_LIST_ASSIGNABLE,
  CONTRACT_TAG_SLA_ASSIGNABLE,
  CONTRACT_TAG_USABLE_FOR_ORDER,
  contractMachine,
  advanceContract,
  canTransition,
  hasContractTag,
} from '../../domain/manage-contract/machine.js';
import { ContractNotActiveError, IllegalTransitionError } from '../../domain/manage-contract/errors.js';
import { assertContractUsableForOrder } from '../../domain/manage-contract/invariants.js';

const STATES = Object.values(CONTRACT_STATUS);
const EVENTS = Object.values(CONTRACT_EVENTS);

const LEGAL_EDGES: ReadonlyArray<{ readonly from: string; readonly event: string; readonly to: string }> = [
  { from: CONTRACT_STATUS.DRAFT, event: CONTRACT_EVENTS.SIGN_CONTRACT, to: CONTRACT_STATUS.SIGNED },
  { from: CONTRACT_STATUS.SIGNED, event: CONTRACT_EVENTS.ACTIVATE_CONTRACT, to: CONTRACT_STATUS.ACTIVE },
  { from: CONTRACT_STATUS.ACTIVE, event: CONTRACT_EVENTS.SUSPEND_CONTRACT, to: CONTRACT_STATUS.SUSPENDED },
  { from: CONTRACT_STATUS.SUSPENDED, event: CONTRACT_EVENTS.RESUME_CONTRACT, to: CONTRACT_STATUS.ACTIVE },
  { from: CONTRACT_STATUS.ACTIVE, event: CONTRACT_EVENTS.EXPIRE_CONTRACT, to: CONTRACT_STATUS.EXPIRED },
  { from: CONTRACT_STATUS.SUSPENDED, event: CONTRACT_EVENTS.EXPIRE_CONTRACT, to: CONTRACT_STATUS.EXPIRED },
];

const LEGAL_EDGE_KEYS = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

// pg-reviewer fix round 2, finding 11: `contractMachine.resolveState({ value })` — never a
// hand-spread of an internal snapshot shape (machine.ts's own `actorAt` comment forbids exactly
// that pattern; this file's own copy was the one violation).
function actorAt(state: string) {
  const snapshot = contractMachine.resolveState({ value: state });
  return createActor(contractMachine, { snapshot });
}

describe('contractMachine — exhaustive legal/illegal transition table (7 states x 5 events = 35)', () => {
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

describe('contractMachine — active is tagged usableForOrder, no other state is (Master decision 1)', () => {
  it('CONTRACT_TAG_USABLE_FOR_ORDER is present only on active', () => {
    for (const state of STATES) {
      const actor = actorAt(state);
      actor.start();
      expect(actor.getSnapshot().hasTag(CONTRACT_TAG_USABLE_FOR_ORDER)).toBe(state === CONTRACT_STATUS.ACTIVE);
      actor.stop();
    }
  });

  it('hasContractTag matches the exhaustive table above', () => {
    expect(hasContractTag(CONTRACT_STATUS.ACTIVE, CONTRACT_TAG_USABLE_FOR_ORDER)).toBe(true);
    for (const state of STATES) {
      if (state === CONTRACT_STATUS.ACTIVE) continue;
      expect(hasContractTag(state, CONTRACT_TAG_USABLE_FOR_ORDER)).toBe(false);
    }
  });
});

// pg-reviewer fix round 3, finding 3: WHICH statuses carry the price-list-eligibility tag was
// previously proven only by the one "SetContractPriceList on an expired contract" integration test
// — wrongly adding the tag to `renewed` or `terminated` would still have passed every existing
// test. Master decision 4 ("legal from draft/signed/active/suspended — i.e. any non-terminal
// status") names FOUR statuses exactly; this asserts the tag over the WHOLE 7-value enum.
describe('contractMachine — CONTRACT_TAG_PRICE_LIST_ASSIGNABLE is present ONLY on draft/signed/active/suspended (pg-reviewer fix round 3, finding 3)', () => {
  const PRICE_LIST_ASSIGNABLE_STATUSES = new Set<string>([
    CONTRACT_STATUS.DRAFT,
    CONTRACT_STATUS.SIGNED,
    CONTRACT_STATUS.ACTIVE,
    CONTRACT_STATUS.SUSPENDED,
  ]);

  it.each(STATES)('CONTRACT_TAG_PRICE_LIST_ASSIGNABLE on %s matches Master decision 4 exactly', (state) => {
    const actor = actorAt(state);
    actor.start();
    expect(actor.getSnapshot().hasTag(CONTRACT_TAG_PRICE_LIST_ASSIGNABLE)).toBe(PRICE_LIST_ASSIGNABLE_STATUSES.has(state));
    actor.stop();
  });

  it('expired/renewed/terminated do NOT carry it', () => {
    for (const state of [CONTRACT_STATUS.EXPIRED, CONTRACT_STATUS.RENEWED, CONTRACT_STATUS.TERMINATED]) {
      expect(hasContractTag(state, CONTRACT_TAG_PRICE_LIST_ASSIGNABLE)).toBe(false);
    }
  });
});

// pg-reviewer fix round 2, finding 5 (item a): a new machine tag, `CONTRACT_TAG_SLA_ASSIGNABLE`,
// present on every status EXCEPT `terminated` (AddContractSla's own status check moves from an
// if/switch on `CONTRACT_STATUS.TERMINATED` to this tag — CLAUDE.md · ARCHITECTURE: "No if/switch
// for state transitions — XState").
describe('contractMachine — every status except terminated carries CONTRACT_TAG_SLA_ASSIGNABLE (pg-reviewer fix round 2)', () => {
  it('CONTRACT_TAG_SLA_ASSIGNABLE is present on every state except terminated', () => {
    for (const state of STATES) {
      const actor = actorAt(state);
      actor.start();
      expect(actor.getSnapshot().hasTag(CONTRACT_TAG_SLA_ASSIGNABLE)).toBe(state !== CONTRACT_STATUS.TERMINATED);
      actor.stop();
    }
  });
});

// pg-reviewer fix round 2, finding 6: `assertContractUsableForOrder` itself (not just the tag
// table) must reject every non-active status with ContractNotActiveError carrying that EXACT
// status.
describe('assertContractUsableForOrder — rejects every non-active status with its own ContractNotActiveError.status', () => {
  it.each([
    CONTRACT_STATUS.DRAFT,
    CONTRACT_STATUS.SIGNED,
    CONTRACT_STATUS.SUSPENDED,
    CONTRACT_STATUS.EXPIRED,
    CONTRACT_STATUS.RENEWED,
    CONTRACT_STATUS.TERMINATED,
  ])('throws ContractNotActiveError with status=%s', (status) => {
    try {
      assertContractUsableForOrder(status);
      throw new Error(`expected ContractNotActiveError for status ${status}, but assertContractUsableForOrder returned`);
    } catch (error) {
      expect(error).toBeInstanceOf(ContractNotActiveError);
      expect((error as ContractNotActiveError).status).toBe(status);
    }
  });

  it('does NOT throw for active', () => {
    expect(() => assertContractUsableForOrder(CONTRACT_STATUS.ACTIVE)).not.toThrow();
  });
});

describe('contractMachine — terminal states accept no event at all', () => {
  it.each([CONTRACT_STATUS.EXPIRED, CONTRACT_STATUS.RENEWED, CONTRACT_STATUS.TERMINATED])('%s accepts no event', (state) => {
    const actor = actorAt(state);
    actor.start();
    for (const event of EVENTS) {
      expect(actor.getSnapshot().can({ type: event })).toBe(false);
    }
    actor.stop();
  });
});

describe('contractMachine — the happy-path walk lands on each named state in order', () => {
  it('draft -> signed -> active -> suspended -> active -> expired', () => {
    const actor = createActor(contractMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(CONTRACT_STATUS.DRAFT);

    actor.send({ type: CONTRACT_EVENTS.SIGN_CONTRACT });
    expect(actor.getSnapshot().value).toBe(CONTRACT_STATUS.SIGNED);

    actor.send({ type: CONTRACT_EVENTS.ACTIVATE_CONTRACT });
    expect(actor.getSnapshot().value).toBe(CONTRACT_STATUS.ACTIVE);

    actor.send({ type: CONTRACT_EVENTS.SUSPEND_CONTRACT });
    expect(actor.getSnapshot().value).toBe(CONTRACT_STATUS.SUSPENDED);

    actor.send({ type: CONTRACT_EVENTS.RESUME_CONTRACT });
    expect(actor.getSnapshot().value).toBe(CONTRACT_STATUS.ACTIVE);

    actor.send({ type: CONTRACT_EVENTS.EXPIRE_CONTRACT });
    expect(actor.getSnapshot().value).toBe(CONTRACT_STATUS.EXPIRED);
    actor.stop();
  });

  it('suspended can also expire directly, without returning to active first', () => {
    const fromSuspended = actorAt(CONTRACT_STATUS.SUSPENDED);
    fromSuspended.start();
    fromSuspended.send({ type: CONTRACT_EVENTS.EXPIRE_CONTRACT });
    expect(fromSuspended.getSnapshot().value).toBe(CONTRACT_STATUS.EXPIRED);
    fromSuspended.stop();
  });
});

describe('canTransition — pure query, matches the exhaustive table above', () => {
  it('true for draft/SIGN_CONTRACT, false for draft/ACTIVATE_CONTRACT', () => {
    expect(canTransition(CONTRACT_STATUS.DRAFT, CONTRACT_EVENTS.SIGN_CONTRACT)).toBe(true);
    expect(canTransition(CONTRACT_STATUS.DRAFT, CONTRACT_EVENTS.ACTIVATE_CONTRACT)).toBe(false);
    expect(canTransition(CONTRACT_STATUS.ACTIVE, CONTRACT_EVENTS.EXPIRE_CONTRACT)).toBe(true);
    expect(canTransition(CONTRACT_STATUS.SUSPENDED, CONTRACT_EVENTS.EXPIRE_CONTRACT)).toBe(true);
    expect(canTransition(CONTRACT_STATUS.EXPIRED, CONTRACT_EVENTS.EXPIRE_CONTRACT)).toBe(false);
  });
});

describe('advanceContract — assertTransition-style helper', () => {
  it('returns the new status for a legal single-event sequence', () => {
    expect(advanceContract(CONTRACT_STATUS.DRAFT, [CONTRACT_EVENTS.SIGN_CONTRACT])).toBe(CONTRACT_STATUS.SIGNED);
  });

  it('walks draft -> signed -> active -> suspended -> expired across four events', () => {
    expect(
      advanceContract(CONTRACT_STATUS.DRAFT, [
        CONTRACT_EVENTS.SIGN_CONTRACT,
        CONTRACT_EVENTS.ACTIVATE_CONTRACT,
        CONTRACT_EVENTS.SUSPEND_CONTRACT,
        CONTRACT_EVENTS.EXPIRE_CONTRACT,
      ]),
    ).toBe(CONTRACT_STATUS.EXPIRED);
  });

  it('an empty events array is a no-op and returns `current` unchanged', () => {
    expect(advanceContract(CONTRACT_STATUS.DRAFT, [])).toBe(CONTRACT_STATUS.DRAFT);
  });

  it.each([
    [CONTRACT_STATUS.DRAFT, CONTRACT_EVENTS.ACTIVATE_CONTRACT],
    [CONTRACT_STATUS.DRAFT, CONTRACT_EVENTS.SUSPEND_CONTRACT],
    [CONTRACT_STATUS.DRAFT, CONTRACT_EVENTS.RESUME_CONTRACT],
    [CONTRACT_STATUS.DRAFT, CONTRACT_EVENTS.EXPIRE_CONTRACT],
    [CONTRACT_STATUS.SIGNED, CONTRACT_EVENTS.SIGN_CONTRACT],
    [CONTRACT_STATUS.SIGNED, CONTRACT_EVENTS.SUSPEND_CONTRACT],
    [CONTRACT_STATUS.SIGNED, CONTRACT_EVENTS.RESUME_CONTRACT],
    [CONTRACT_STATUS.SIGNED, CONTRACT_EVENTS.EXPIRE_CONTRACT],
    [CONTRACT_STATUS.ACTIVE, CONTRACT_EVENTS.SIGN_CONTRACT],
    [CONTRACT_STATUS.ACTIVE, CONTRACT_EVENTS.ACTIVATE_CONTRACT],
    [CONTRACT_STATUS.ACTIVE, CONTRACT_EVENTS.RESUME_CONTRACT],
    [CONTRACT_STATUS.SUSPENDED, CONTRACT_EVENTS.SIGN_CONTRACT],
    [CONTRACT_STATUS.SUSPENDED, CONTRACT_EVENTS.ACTIVATE_CONTRACT],
    [CONTRACT_STATUS.SUSPENDED, CONTRACT_EVENTS.SUSPEND_CONTRACT],
    [CONTRACT_STATUS.EXPIRED, CONTRACT_EVENTS.SIGN_CONTRACT],
    [CONTRACT_STATUS.RENEWED, CONTRACT_EVENTS.SIGN_CONTRACT],
    [CONTRACT_STATUS.TERMINATED, CONTRACT_EVENTS.SIGN_CONTRACT],
  ])('throws IllegalTransitionError for %s -> %s', (from, event) => {
    expect(() => advanceContract(from, [event])).toThrow(IllegalTransitionError);
  });
});
