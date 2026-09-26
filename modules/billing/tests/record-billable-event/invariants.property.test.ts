// modules/billing/tests/record-billable-event/invariants.property.test.ts — WBS 4.2 (lane 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/billing/domain/record-billable-event/invariants.ts (CLAUDE.md TESTING: property tests on
// every invariant). RESCOPED (round-1 review finding 1, FINAL round under D-186): the closed-list
// `sourceTable` validation and the client-match validation now live in domain/ too (round-1 finding
// 3 — they were application-layer checks before the rescope removed the application layer
// entirely).
//
// round-1 finding 2 (the real gap): the qty property test must NOT filter non-finite/malformed
// values OUT of the generator — that hid the exact bug it was meant to catch (the old `qty <= 0`
// check let `NaN` through, since `NaN <= 0` is `false`). The fix uses `Quantity.of(qty).isPositive()`
// (WBS 4.2 part 2, round-1 (part 2) finding 2 — qty is an exact `numeric(14,3)` decimal STRING, never
// a JS `number`); the invalid-direction property below explicitly INCLUDES NaN/Infinity/-Infinity
// (as malformed decimal-string text `Quantity.of` rejects) in the values it generates, plus explicit
// unit cases for each, so a regression back to a weaker check would fail immediately.
//
// ACTUAL SURFACE (modules/billing/domain/record-billable-event/invariants.ts):
//   - `assertPositiveQty(qty: string): Quantity` — throws NonPositiveQtyError (../errors.js) iff
//     `Quantity.of(qty)` throws or the parsed value is not `.isPositive()`; returns the parsed
//     `Quantity` (its canonical `.toString()` form) otherwise. Pure: no I/O, no Date, no
//     Math.random() (CLAUDE.md AGENT CONSTRAINTS).
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

// The module under test.
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

// WBS 4.2 part 2 (quantity discipline): `assertPositiveQty` takes an exact `numeric(14,3)` decimal
// STRING (billing.billable_events.qty, 01-Data-Model.sql:1055), never a JS `number` — these
// generators build valid/invalid decimal-string shapes directly, never routed through a JS `number`
// (same discipline as `positiveDecimalStringArb`/`nonPositiveDecimalStringArb` further below, which
// this block now shares).

// A generator for exact numeric(14,3)-shaped decimal STRINGS, strictly positive, built from integer
// and fractional digit strings directly — NEVER routed through a JS `number` — so a value like
// '99999999999.999' (11 integer digits) stays perfectly exact, something IEEE-754 cannot represent.
const positiveDecimalStringArb = fc
  .tuple(
    fc.integer({ min: 1, max: 99_999_999_999 }), // 1-11 integer digits, never zero-only (qty > 0)
    fc.integer({ min: 0, max: 999 }), // 0-3 fractional digits
  )
  .map(([integerPart, fractionalPart]) => `${integerPart}.${fractionalPart.toString().padStart(3, '0')}`);

// Non-positive numeric(14,3)-shaped decimal strings: zero, and negative magnitudes.
const nonPositiveDecimalStringArb = fc.oneof(
  fc.constant('0.000'),
  fc.constant('0'),
  fc
    .tuple(fc.integer({ min: 1, max: 99_999_999_999 }), fc.integer({ min: 0, max: 999 }))
    .map(([integerPart, fractionalPart]) => `-${integerPart}.${fractionalPart.toString().padStart(3, '0')}`),
);

const positiveQtyArb = positiveDecimalStringArb;

// round-1 finding 2: the invalid-direction generator EXPLICITLY includes NaN/Infinity/-Infinity (as
// the literal, malformed decimal-string text `Quantity.of` rejects) — no filtering that would hide
// them.
const nonFinitePositiveQtyArb = fc.oneof(
  nonPositiveDecimalStringArb,
  fc.constant('NaN'),
  fc.constant('Infinity'),
  fc.constant('-Infinity'),
);

const tripleArb = fc.record({
  sourceTable: fc.constantFrom('wms.inbound_orders', 'wms.outbound_orders', 'tms.trips', 'cc.tickets'),
  sourceId: fc.uuid(),
  serviceId: fc.uuid(),
});

describe('assertPositiveQty — property (round-1 finding 2 / part 2: Quantity.of(qty).isPositive())', () => {
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

  it('qty exactly "NaN" always throws (the exact round-1 gap: `NaN <= 0` is `false`, so the OLD check let it through)', () => {
    expect(() => assertPositiveQty('NaN')).toThrow(NonPositiveQtyError);
  });

  it('qty exactly "Infinity" always throws', () => {
    expect(() => assertPositiveQty('Infinity')).toThrow(NonPositiveQtyError);
  });

  it('qty exactly "-Infinity" always throws', () => {
    expect(() => assertPositiveQty('-Infinity')).toThrow(NonPositiveQtyError);
  });

  it('qty exactly "0" always throws', () => {
    expect(() => assertPositiveQty('0')).toThrow(NonPositiveQtyError);
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

// WBS 4.2 part 2: qty quantity-discipline — exact decimal `Quantity`, never a plain JS `number`
// (CLAUDE.md AGENT CONSTRAINTS: no Math.random()/new Date() in domain/, and doc 40/CLAUDE.md
// quantity discipline: exact decimal via `Quantity` from @pg-eos/domain-kit, text in / text out,
// same convention as modules/wms/domain/{count-inventory,process-outbound,receive-inbound}/
// invariants.ts — NEVER a raw Number() on the value). `assertPositiveQty` takes a genuine
// `numeric(14,3)` decimal STRING (the wire/DB representation, `billing.billable_events.qty` is
// `numeric(14,3) not null`, database/schema/01-Data-Model.sql:1055) — round-1 (part 2) finding 2:
// it RETURNS the parsed `Quantity` (not `void`) so callers use its canonical `.toString()` form
// downstream, never the caller's raw string.

describe('assertPositiveQty — Quantity string type discipline (WBS 4.2 part 2)', () => {
  it('never throws for a strictly positive numeric(14,3) decimal STRING (a real Quantity, not a JS number)', () => {
    fc.assert(
      fc.property(positiveDecimalStringArb, (qty) => {
        expect(() => assertPositiveQty(qty)).not.toThrow();
      }),
    );
  });

  it('always throws NonPositiveQtyError for a zero or negative numeric(14,3) decimal STRING', () => {
    fc.assert(
      fc.property(nonPositiveDecimalStringArb, (qty) => {
        expect(() => assertPositiveQty(qty)).toThrow(NonPositiveQtyError);
      }),
    );
  });

  it('accepts the exact numeric(14,3) boundary value "99999999999.999" — 11 integer digits, unrepresentable exactly as a JS number', () => {
    const maxQty = '99999999999.999';
    expect(() => assertPositiveQty(maxQty)).not.toThrow();
  });

  it('round-1 (part 2) finding 7: returns a Quantity whose .toString() is the EXACT input text, proving no Number() round trip anywhere in the check', () => {
    fc.assert(
      fc.property(positiveDecimalStringArb, (qty) => {
        expect(assertPositiveQty(qty).toString()).toBe(qty);
      }),
    );
  });

  it('a three-decimal-place quantity string round-trips through .toString() with its exact textual form unchanged', () => {
    const qty = '12.345';
    expect(assertPositiveQty(qty).toString()).toBe(qty);
  });

  it('the numeric(14,3) boundary value "99999999999.999" round-trips through .toString() with no precision loss', () => {
    const maxQty = '99999999999.999';
    expect(assertPositiveQty(maxQty).toString()).toBe(maxQty);
  });
});
