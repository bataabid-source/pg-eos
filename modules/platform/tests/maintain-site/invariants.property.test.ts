// modules/platform/tests/maintain-site/invariants.property.test.ts — WBS 5.5a part 1 (lane 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/platform/domain/maintain-site/invariants.ts — one property per invariant named in
// docs/notes/slice-briefs/_slice-5.5a-part1.brief.md's "Property tests" section (P1, P2, P3). No
// machine unit test (brief D1 — no XState machine; is_active is a plain boolean).
//
// Expected domain surface:
//   modules/platform/domain/maintain-site/invariants.ts
//     - `isValidKind(kind: string): boolean` — P1. `kind ∈ {warehouse, office, client_pickup,
//       housing, other}` (chk_sites_kind, migration 0015).
//     - `requiresAccount(kind: string, accountId: string | null | undefined): void` — P2. Throws
//       SiteAccountRequiredError iff `kind === 'client_pickup' && accountId is null/undefined`
//       (chk_sites_client_pickup_account, migration 0015 — dual-enforced per doc 36 §5-4 #2).
//     - `isValidRadius(radiusM: number | undefined): boolean` — P3. `radiusM === undefined ||
//       radiusM > 0` (brief D5: an omitted radiusM lets the DB column default fire; a
//       caller-supplied value must be strictly positive).
//
//   modules/platform/domain/maintain-site/errors.ts — SiteAccountRequiredError (see ./errors.js).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test.
import { isValidKind, isValidRadius, requiresAccount } from '../../domain/maintain-site/invariants.js';
import { SiteAccountRequiredError } from '../../domain/maintain-site/errors.js';

// migration 0015's chk_sites_kind — the five values SCR-HR-SHIFT-01 §2.4 names (Facts, brief).
const VALID_KINDS = ['warehouse', 'office', 'client_pickup', 'housing', 'other'] as const;

// --- P1: isValidKind(kind) <=> kind ∈ {warehouse, office, client_pickup, housing, other} --------

describe('isValidKind — property (P1)', () => {
  it('true for every value in the enum', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_KINDS), (kind) => {
        expect(isValidKind(kind)).toBe(true);
      }),
    );
  });

  it('for any arbitrary string, isValidKind(kind) <=> kind is one of the five enum values', () => {
    fc.assert(
      fc.property(fc.string(), (kind) => {
        const expected = (VALID_KINDS as readonly string[]).includes(kind);
        expect(isValidKind(kind)).toBe(expected);
      }),
    );
  });
});

// --- P2: requiresAccount(kind, accountId) <=> kind = 'client_pickup' ∧ accountId is null throws --

describe('requiresAccount — property (P2)', () => {
  it('throws SiteAccountRequiredError iff kind = "client_pickup" and accountId is null/undefined', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_KINDS),
        fc.option(fc.uuid(), { nil: undefined }),
        (kind, accountId) => {
          const shouldThrow = kind === 'client_pickup' && (accountId === null || accountId === undefined);
          if (shouldThrow) {
            expect(() => requiresAccount(kind, accountId)).toThrow(SiteAccountRequiredError);
          } else {
            expect(() => requiresAccount(kind, accountId)).not.toThrow();
          }
        },
      ),
    );
  });

  it('never throws for kind = "client_pickup" when accountId is a present uuid', () => {
    fc.assert(
      fc.property(fc.uuid(), (accountId) => {
        expect(() => requiresAccount('client_pickup', accountId)).not.toThrow();
      }),
    );
  });

  it('never throws for any non-client_pickup kind, regardless of accountId', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_KINDS.filter((k) => k !== 'client_pickup')),
        fc.option(fc.uuid(), { nil: undefined }),
        (kind, accountId) => {
          expect(() => requiresAccount(kind, accountId)).not.toThrow();
        },
      ),
    );
  });
});

// --- P3: isValidRadius(radiusM) <=> radiusM is undefined ∨ radiusM > 0 ---------------------------

describe('isValidRadius — property (P3)', () => {
  it('always true when radiusM is undefined (omitted -> the DB column default fires, brief D5)', () => {
    expect(isValidRadius(undefined)).toBe(true);
  });

  it('true iff radiusM > 0, for any finite number', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, min: -1_000_000, max: 1_000_000 }), (radiusM) => {
        expect(isValidRadius(radiusM)).toBe(radiusM > 0);
      }),
    );
  });

  it('false for zero and every negative number', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, min: -1_000_000, max: 0 }), (radiusM) => {
        expect(isValidRadius(radiusM)).toBe(false);
      }),
    );
  });
});
