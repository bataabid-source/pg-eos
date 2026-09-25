// modules/billing/tests/record-billable-event/invariants.property.test.ts — WBS 4.2 (lane 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/billing/domain/record-billable-event/invariants.ts (CLAUDE.md TESTING: property tests on
// every invariant). RESCOPED (round-1 review finding 1, FINAL round under D-186): the closed-list
// `sourceTable` validation and the client-match validation now live in domain/ too (round-1 finding
// 3 — they were application-layer checks before the rescope removed the application layer
// entirely).
//
// round-1 finding 2 (the real gap): the qty property test must NOT use `noNaN: true` /
// `noDefaultInfinity: true` to filter non-finite values OUT of the generator — that hid the exact
// bug it was meant to catch (the old `qty <= 0` check let `NaN` through, since `NaN <= 0` is
// `false`). The fix uses `Number.isFinite(qty) && qty > 0`; the invalid-direction property below
// explicitly INCLUDES NaN/Infinity/-Infinity in the values it generates, plus explicit unit cases
// for each, so a regression back to `qty <= 0` would fail immediately.
//
// EXPECTED NEW SURFACE (RED until pg-backend's parallel rewrite lands):
//   modules/billing/domain/record-billable-event/invariants.ts
//     - `assertPositiveQty(qty: number): void` — throws NonPositiveQtyError (../errors.js) iff
//       `!(Number.isFinite(qty) && qty > 0)`; returns (no throw) otherwise. Pure: no I/O, no Date,
//       no Math.random() (CLAUDE.md AGENT CONSTRAINTS).
//     - `BILLABLE_SOURCE_TABLES: readonly string[]` — the closed list of billing-source tables
//       named in doc 40 for shipped event hooks (brief D1): wms.inbound_orders,
//       wms.outbound_orders, wms.occupancy_snapshots, wms.inventory_counts, tms.delivery_tasks.
//     - `assertValidSourceTable(sourceTable: string): void` — throws InvalidSourceTableError
//       (../errors.js) iff `sourceTable` is not a member of `BILLABLE_SOURCE_TABLES`.
//     - `assertClientMatches(sourceClientId: string | null, callerClientId: string): void` — throws
//       ClientMismatchError (../errors.js) iff `sourceClientId` is non-null and differs from
//       `callerClientId`; a null `sourceClientId` (source row carries no client of its own) never
//       throws.
//     - `isNonDuplicateTriple(existing: readonly BillableEventTriple[], candidate:
//       BillableEventTriple): boolean` — D2's domain-level PRE-check (best-effort; the real
//       backstop is the DB's pre-existing unique index on (source_table, source_id, service_id),
//       proven by the sequential-duplicate integration scenario in ./record-billable-event.test.ts,
//       NOT by this pure function). Returns false iff `candidate` matches an entry in `existing` on
//       ALL THREE fields; true otherwise.
//   where `BillableEventTriple = { readonly sourceTable: string; readonly sourceId: string;
//   readonly serviceId: string }`.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet with this domain-level shape (RED).
import {
  assertBillableSourceTable,
  assertClientMatches,
  assertPositiveQty,
  BILLABLE_SOURCE_TABLES,
  isNonDuplicateTriple,
} from '../../domain/record-billable-event/invariants.js';
import {
  ClientMismatchError,
  InvalidSourceTableError,
  NonPositiveQtyError,
} from '../../domain/record-billable-event/errors.js';

const positiveQtyArb = fc.double({ min: Number.EPSILON, max: 1_000_000, noNaN: true, noDefaultInfinity: true });

// round-1 finding 2: the invalid-direction generator EXPLICITLY includes NaN/Infinity/-Infinity —
// no `noNaN`/`noDefaultInfinity` filtering that would hide them.
const nonFinitePositiveQtyArb = fc.oneof(
  fc.double({ min: -1_000_000, max: 0, noNaN: true, noDefaultInfinity: true }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
);

const tripleArb = fc.record({
  sourceTable: fc.constantFrom('wms.inbound_orders', 'wms.outbound_orders', 'tms.trips', 'cc.tickets'),
  sourceId: fc.uuid(),
  serviceId: fc.uuid(),
});

describe('assertPositiveQty — property (round-1 finding 2: Number.isFinite(qty) && qty > 0)', () => {
  it('never throws for a finite, strictly positive qty', () => {
    fc.assert(
      fc.property(positiveQtyArb, (qty) => {
        expect(() => assertPositiveQty(qty)).not.toThrow();
      }),
    );
  });

  it('always throws NonPositiveQtyError for a non-finite or non-positive qty (NaN, Infinity, -Infinity, 0, or negative)', () => {
    fc.assert(
      fc.property(nonFinitePositiveQtyArb, (qty) => {
        expect(() => assertPositiveQty(qty)).toThrow(NonPositiveQtyError);
      }),
    );
  });

  it('qty exactly NaN always throws (the exact round-1 gap: `NaN <= 0` is `false`, so the OLD check let it through)', () => {
    expect(() => assertPositiveQty(Number.NaN)).toThrow(NonPositiveQtyError);
  });

  it('qty exactly Infinity always throws', () => {
    expect(() => assertPositiveQty(Number.POSITIVE_INFINITY)).toThrow(NonPositiveQtyError);
  });

  it('qty exactly -Infinity always throws', () => {
    expect(() => assertPositiveQty(Number.NEGATIVE_INFINITY)).toThrow(NonPositiveQtyError);
  });

  it('qty exactly 0 always throws', () => {
    expect(() => assertPositiveQty(0)).toThrow(NonPositiveQtyError);
  });
});

describe('assertBillableSourceTable — property (D1 closed-list validation, moved to domain/ per round-1 finding 3)', () => {
  it('never throws for any member of BILLABLE_SOURCE_TABLES', () => {
    fc.assert(
      fc.property(fc.constantFrom(...BILLABLE_SOURCE_TABLES), (sourceTable) => {
        expect(() => assertBillableSourceTable(sourceTable)).not.toThrow();
      }),
    );
  });

  it('always throws InvalidSourceTableError for a string outside the closed list', () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => !(BILLABLE_SOURCE_TABLES as readonly string[]).includes(value)),
        (sourceTable) => {
          expect(() => assertBillableSourceTable(sourceTable)).toThrow(InvalidSourceTableError);
        },
      ),
    );
  });

  it('exposes exactly the five closed-list tables named in the brief (D1)', () => {
    expect([...BILLABLE_SOURCE_TABLES].sort()).toEqual(
      [
        'wms.inbound_orders',
        'wms.outbound_orders',
        'wms.occupancy_snapshots',
        'wms.inventory_counts',
        'tms.delivery_tasks',
      ].sort(),
    );
  });
});

describe('assertClientMatches — property (D1 client-match validation, moved to domain/ per round-1 finding 3)', () => {
  it('never throws when sourceClientId is null (the source row carries no client of its own)', () => {
    fc.assert(
      fc.property(fc.uuid(), (callerClientId) => {
        expect(() => assertClientMatches(null, callerClientId)).not.toThrow();
      }),
    );
  });

  it('never throws when sourceClientId equals callerClientId', () => {
    fc.assert(
      fc.property(fc.uuid(), (clientId) => {
        expect(() => assertClientMatches(clientId, clientId)).not.toThrow();
      }),
    );
  });

  it('always throws ClientMismatchError when sourceClientId is non-null and differs from callerClientId', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (sourceClientId, callerClientId) => {
        fc.pre(sourceClientId !== callerClientId);
        expect(() => assertClientMatches(sourceClientId, callerClientId)).toThrow(ClientMismatchError);
      }),
    );
  });
});

describe('isNonDuplicateTriple — property (D2 domain-level pre-check, best-effort)', () => {
  it('returns true for any candidate against an empty existing list', () => {
    fc.assert(
      fc.property(tripleArb, (candidate) => {
        expect(isNonDuplicateTriple([], candidate)).toBe(true);
      }),
    );
  });

  it('returns false when the candidate exactly matches an entry already in `existing`', () => {
    fc.assert(
      fc.property(tripleArb, fc.array(tripleArb, { maxLength: 5 }), (candidate, others) => {
        const existing = [...others, candidate];
        expect(isNonDuplicateTriple(existing, candidate)).toBe(false);
      }),
    );
  });

  it('returns true when the candidate differs in at least one of the three fields from every entry in `existing`', () => {
    fc.assert(
      fc.property(tripleArb, tripleArb, (a, b) => {
        fc.pre(a.sourceTable !== b.sourceTable || a.sourceId !== b.sourceId || a.serviceId !== b.serviceId);
        expect(isNonDuplicateTriple([a], b)).toBe(true);
      }),
    );
  });

  it('a shared sourceId/sourceTable with a DIFFERENT serviceId is still non-duplicate (the triple, not a partial match, is what counts)', () => {
    fc.assert(
      fc.property(tripleArb, fc.uuid(), (existingTriple, differentServiceId) => {
        fc.pre(differentServiceId !== existingTriple.serviceId);
        const candidate = { ...existingTriple, serviceId: differentServiceId };
        expect(isNonDuplicateTriple([existingTriple], candidate)).toBe(true);
      }),
    );
  });
});
