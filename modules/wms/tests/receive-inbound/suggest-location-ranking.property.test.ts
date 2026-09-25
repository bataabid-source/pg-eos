// modules/wms/tests/receive-inbound/suggest-location-ranking.property.test.ts — WBS 2.9, THE
// GOLDEN SLICE (pg-tester), written RED-first against the slice brief's SuggestLocation ranking
// default: "rank by (1) client-assigned match first, (2) enough remaining capacity for the
// quantity, (3) lower aisle/position number first" — doc 40 §C3 "A2: conditions, ABC, proximity to
// shipping, capacity, client assignment" (no ABC-class weighting: doc 40 gives no formula,
// recorded as a follow-up, not a G-01 invention).
//
// The capacity CHECK itself (whether a location has enough remaining weight/volume headroom) is
// NOT pure — it needs a DB read of current wms.stock_balance load (same reason WBS 2.4's
// evaluateLocationLimits keeps the arithmetic in SQL, see modules/wms/src/stock-ledger/domain.ts's
// own header comment). Only the RANKING of an already-computed, already-filtered candidate set is
// pure — that is what this file exercises.
//
// Expected new surface (RED until it exists — quoted verbatim for the build brief):
//   modules/wms/domain/receive-inbound/suggest-location-ranking.ts
//     - `RankableLocationCandidate` — `{ locationId: string; clientAssignedMatch: boolean;
//       remainingCapacityRatio: number; positionNo: number }`. `remainingCapacityRatio` is the
//       caller-computed (SQL) fraction of remaining headroom (0..1, higher = more room), the
//       proxy this slice uses for ranking criterion (2) ("enough remaining capacity" — the
//       candidate set is already filtered to locations that DO have enough capacity; ranking
//       within that set prefers more headroom).
//     - `compareLocationCandidates(a, b): number` — the total order: clientAssignedMatch (true
//       first) > remainingCapacityRatio (higher first) > positionNo (lower first). A plain
//       `Array.prototype.sort` comparator, exported so the property test below can assert
//       sortedness independently of `rankLocationCandidates`'s own implementation.
//     - `rankLocationCandidates(candidates): readonly RankableLocationCandidate[]` — returns a NEW
//       array (does not mutate `candidates`), sorted by `compareLocationCandidates`.
//
// ------------------------------------------------------------------------------------------------
// WBS 2.10 EXTENSION (pg-tester, RED-first) — doc 38 row 2.10 "Suggestion respects conditions,
// ABC, capacity, client assignment". docs/notes/slice-briefs/_slice-2.10.brief.md, Master decisions
// 1-3. The exact new surface this file now binds to (RED until pg-backend builds it):
//   - `RankableLocationCandidate` gains one new field: `abcClass: 'A' | 'B' | 'C' | null` (from
//     wms.skus.abc_class, passed through verbatim — same value on every candidate of one call).
//   - `compareLocationCandidates(a, b, abcClass: 'A' | 'B' | 'C' | null): number` — new total
//     order: clientAssignedMatch (true first, UNCHANGED) > [if abcClass === 'A': positionNo (lower
//     first) THEN remainingCapacityRatio (higher first) — proximity before capacity] > [else
//     ('B'/'C'/null): remainingCapacityRatio (higher first) THEN positionNo (lower first) —
//     UNCHANGED from 2.9] > 0 (stable tie-break).
//   - `rankLocationCandidates(candidates, abcClass): readonly RankableLocationCandidate[]` — same
//     second parameter, threaded straight into the comparator; still a NEW array, still
//     non-mutating, still permutation-preserving for ANY abcClass value.
//   - EVERY existing case below is preserved UNCHANGED in behaviour/assertion; the only edit is
//     passing the new mandatory third argument `null` (2.9's default, doc 38 row 2.10 Master
//     decision 6's own regression guarantee: abcClass null must rank IDENTICALLY to 2.9) and adding
//     the new mandatory `abcClass` field (`null`) to every existing `RankableLocationCandidate`
//     object literal / arbitrary. Nothing about what is asserted changes.
//
// FIX ROUND 1 (pg-reviewer FAIL) — item 5: the client-assignment-always-wins, sortedness and
// non-mutation invariants were only exercised with abcClass: null. `it.each(ALL_ABC_CLASSES)`
// variants are added ALONGSIDE the existing null-only cases (not replacing them) to prove each
// invariant for 'A'/'B'/'C' too.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — the WBS 2.10 surface (second comparator/rank parameter, abcClass field)
// does not exist yet (RED).
import {
  compareLocationCandidates,
  rankLocationCandidates,
  type RankableLocationCandidate,
} from '../../domain/receive-inbound/suggest-location-ranking.js';

// doc 40 §C3 location code: position 01-99 (unchanged from 2.9).
const MIN_POSITION_NO = 1;
const MAX_POSITION_NO = 99;

// wms.skus.abc_class: char(1), 'A' | 'B' | 'C' | null (Master decision 1).
type AbcClass = 'A' | 'B' | 'C' | null;
const NON_A_ABC_CLASSES = ['B', 'C', null] as const;
// Fix round 1 (pg-reviewer FAIL, item 5): every abc_class value, used to prove the client-match,
// sortedness and non-mutation invariants hold for the 'A' branch too, not only the unchanged
// default branch.
const ALL_ABC_CLASSES = ['A', 'B', 'C', null] as const;

const candidateArb: fc.Arbitrary<RankableLocationCandidate> = fc.record({
  locationId: fc.uuid(),
  clientAssignedMatch: fc.boolean(),
  // fc-generated fraction, 0..1 inclusive — a resulting-load headroom ratio is always in this
  // range by construction (never negative, never over 1, per WBS 2.4's own hard-barrier rule that
  // a location at or under its max is the only kind ever offered as a candidate).
  remainingCapacityRatio: fc.double({ min: 0, max: 1, noNaN: true }),
  positionNo: fc.integer({ min: MIN_POSITION_NO, max: MAX_POSITION_NO }),
  // WBS 2.10: every candidate of one suggestLocation call shares the same abcClass (a per-call
  // constant, brief §Scope), but the arbitrary varies it across generated examples/runs — the
  // comparator/rankLocationCandidates never read `a.abcClass`/`b.abcClass` themselves, only the
  // explicit third parameter, so this field's own value must not affect any assertion below.
  abcClass: fc.constantFrom<AbcClass>('A', 'B', 'C', null),
});

const candidatesArb = fc.array(candidateArb, { minLength: 0, maxLength: 30 });

describe('rankLocationCandidates — property: permutation-preserving', () => {
  it('returns exactly the same set of locationIds as the input, for any candidate set', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const ranked = rankLocationCandidates(candidates, null);
        const inputIds = candidates.map((c) => c.locationId).sort();
        const rankedIds = ranked.map((c) => c.locationId).sort();
        expect(rankedIds).toEqual(inputIds);
      }),
    );
  });

  it('does not mutate the input array', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const before = candidates.map((c) => c.locationId);
        rankLocationCandidates(candidates, null);
        expect(candidates.map((c) => c.locationId)).toEqual(before);
      }),
    );
  });

  // Fix round 1 (pg-reviewer FAIL, item 5): the SAME non-mutation invariant, proven for every
  // abcClass branch (including 'A'), not only the null default used above.
  it.each(ALL_ABC_CLASSES)('does not mutate the input array, for abcClass %s', (abcClass) => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const before = candidates.map((c) => c.locationId);
        rankLocationCandidates(candidates, abcClass);
        expect(candidates.map((c) => c.locationId)).toEqual(before);
      }),
    );
  });
});

describe('rankLocationCandidates — property: sorted by compareLocationCandidates, adjacent pairs never inverted', () => {
  it('every adjacent pair in the output is already in order (never regresses)', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const ranked = rankLocationCandidates(candidates, null);
        for (let i = 0; i < ranked.length - 1; i += 1) {
          const a = ranked[i] as RankableLocationCandidate;
          const b = ranked[i + 1] as RankableLocationCandidate;
          expect(compareLocationCandidates(a, b, null)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  // Fix round 1 (pg-reviewer FAIL, item 5): the SAME sortedness invariant, proven for every
  // abcClass branch (including 'A'), not only the null default used above — the comparator and
  // rankLocationCandidates must be called with the SAME abcClass, since compareLocationCandidates's
  // total order depends on it.
  it.each(ALL_ABC_CLASSES)('every adjacent pair in the output is already in order, for abcClass %s', (abcClass) => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const ranked = rankLocationCandidates(candidates, abcClass);
        for (let i = 0; i < ranked.length - 1; i += 1) {
          const a = ranked[i] as RankableLocationCandidate;
          const b = ranked[i + 1] as RankableLocationCandidate;
          expect(compareLocationCandidates(a, b, abcClass)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe('rankLocationCandidates — property: a client-assigned match never ranks below a non-match', () => {
  it('for any two candidates, a clientAssignedMatch=true one never appears after a clientAssignedMatch=false one when both are present', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const ranked = rankLocationCandidates(candidates, null);
        const firstNonMatchIndex = ranked.findIndex((c) => !c.clientAssignedMatch);
        if (firstNonMatchIndex === -1) return; // all matched or empty — nothing to violate.
        // No matched candidate may appear AFTER the first non-matched one.
        const anyMatchAfter = ranked
          .slice(firstNonMatchIndex + 1)
          .some((c) => c.clientAssignedMatch);
        expect(anyMatchAfter).toBe(false);
      }),
    );
  });

  // Fix round 1 (pg-reviewer FAIL, item 5): the SAME client-assignment-always-wins invariant,
  // proven for every abcClass branch (including 'A') — clientAssignedMatch is UNCHANGED, the top
  // tier, regardless of which capacity/position order applies underneath it.
  it.each(ALL_ABC_CLASSES)(
    'a clientAssignedMatch=true candidate never appears after a clientAssignedMatch=false one, for abcClass %s',
    (abcClass) => {
      fc.assert(
        fc.property(candidatesArb, (candidates) => {
          const ranked = rankLocationCandidates(candidates, abcClass);
          const firstNonMatchIndex = ranked.findIndex((c) => !c.clientAssignedMatch);
          if (firstNonMatchIndex === -1) return; // all matched or empty — nothing to violate.
          const anyMatchAfter = ranked
            .slice(firstNonMatchIndex + 1)
            .some((c) => c.clientAssignedMatch);
          expect(anyMatchAfter).toBe(false);
        }),
      );
    },
  );
});

describe('rankLocationCandidates — deterministic examples (doc 40 §C3 A2 ranking criteria)', () => {
  it('ranks a client-assigned match above a non-match even with less capacity and a higher position', () => {
    const matchLowCapacityHighPosition: RankableLocationCandidate = {
      locationId: 'loc-match',
      clientAssignedMatch: true,
      remainingCapacityRatio: 0.1,
      positionNo: 99,
      abcClass: null,
    };
    const noMatchHighCapacityLowPosition: RankableLocationCandidate = {
      locationId: 'loc-nomatch',
      clientAssignedMatch: false,
      remainingCapacityRatio: 0.9,
      positionNo: 1,
      abcClass: null,
    };
    const ranked = rankLocationCandidates([noMatchHighCapacityLowPosition, matchLowCapacityHighPosition], null);
    expect(ranked.map((c) => c.locationId)).toEqual(['loc-match', 'loc-nomatch']);
  });

  it('within the same clientAssignedMatch group, ranks more remaining capacity first', () => {
    const low: RankableLocationCandidate = {
      locationId: 'loc-low',
      clientAssignedMatch: false,
      remainingCapacityRatio: 0.2,
      positionNo: 1,
      abcClass: null,
    };
    const high: RankableLocationCandidate = {
      locationId: 'loc-high',
      clientAssignedMatch: false,
      remainingCapacityRatio: 0.8,
      positionNo: 1,
      abcClass: null,
    };
    const ranked = rankLocationCandidates([low, high], null);
    expect(ranked.map((c) => c.locationId)).toEqual(['loc-high', 'loc-low']);
  });

  it('within the same match group and same capacity, ranks the lower position number first (nearer the door, doc 40 §C3)', () => {
    const far: RankableLocationCandidate = {
      locationId: 'loc-far',
      clientAssignedMatch: true,
      remainingCapacityRatio: 0.5,
      positionNo: 42,
      abcClass: null,
    };
    const near: RankableLocationCandidate = {
      locationId: 'loc-near',
      clientAssignedMatch: true,
      remainingCapacityRatio: 0.5,
      positionNo: 1,
      abcClass: null,
    };
    const ranked = rankLocationCandidates([far, near], null);
    expect(ranked.map((c) => c.locationId)).toEqual(['loc-near', 'loc-far']);
  });

  it('an empty candidate list ranks to an empty list', () => {
    expect(rankLocationCandidates([], null)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// WBS 2.10 — new property cases (docs/notes/slice-briefs/_slice-2.10.brief.md, "Property tests"
// section, cases (a)/(b)/(c); Master decision 2).

describe('rankLocationCandidates — property: abcClass A ranks positionNo before capacity (WBS 2.10, brief property (a))', () => {
  it("for abcClass 'A', given any two candidates with the SAME clientAssignedMatch, the one with the lower positionNo always ranks first, regardless of remainingCapacityRatio", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: MIN_POSITION_NO, max: MAX_POSITION_NO }),
        fc.integer({ min: MIN_POSITION_NO, max: MAX_POSITION_NO }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (clientAssignedMatch, positionA, positionB, capacityA, capacityB) => {
          fc.pre(positionA !== positionB);
          const a: RankableLocationCandidate = {
            locationId: 'a',
            clientAssignedMatch,
            remainingCapacityRatio: capacityA,
            positionNo: positionA,
            abcClass: 'A',
          };
          const b: RankableLocationCandidate = {
            locationId: 'b',
            clientAssignedMatch,
            remainingCapacityRatio: capacityB,
            positionNo: positionB,
            abcClass: 'A',
          };
          const result = compareLocationCandidates(a, b, 'A');
          const expectedSign = positionA < positionB ? -1 : 1;
          expect(Math.sign(result)).toBe(expectedSign);
        },
      ),
    );
  });
});

describe('rankLocationCandidates — property: abcClass B/C/null keeps the 2.9 capacity-before-proximity order (WBS 2.10, brief property (b))', () => {
  it.each(NON_A_ABC_CLASSES)(
    "for abcClass %s, given any two candidates with the SAME clientAssignedMatch and DIFFERENT remainingCapacityRatio, the higher-capacity one always ranks first, regardless of positionNo (2.9's own unchanged order)",
    (abcClass) => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.integer({ min: MIN_POSITION_NO, max: MAX_POSITION_NO }),
          fc.integer({ min: MIN_POSITION_NO, max: MAX_POSITION_NO }),
          (clientAssignedMatch, capacityA, capacityB, positionA, positionB) => {
            fc.pre(capacityA !== capacityB);
            const a: RankableLocationCandidate = {
              locationId: 'a',
              clientAssignedMatch,
              remainingCapacityRatio: capacityA,
              positionNo: positionA,
              abcClass,
            };
            const b: RankableLocationCandidate = {
              locationId: 'b',
              clientAssignedMatch,
              remainingCapacityRatio: capacityB,
              positionNo: positionB,
              abcClass,
            };
            const result = compareLocationCandidates(a, b, abcClass);
            const expectedSign = capacityA > capacityB ? -1 : 1;
            expect(Math.sign(result)).toBe(expectedSign);
          },
        ),
      );
    },
  );
});

describe('rankLocationCandidates — property: permutation-preserving regardless of abcClass (WBS 2.10, brief property (c))', () => {
  it('rankLocationCandidates(candidates, "A") and rankLocationCandidates(candidates, null) never add or drop a locationId — only a possible reordering', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const inputIds = candidates.map((c) => c.locationId).sort();

        const rankedA = rankLocationCandidates(candidates, 'A');
        expect(rankedA).toHaveLength(candidates.length);
        expect(rankedA.map((c) => c.locationId).sort()).toEqual(inputIds);

        const rankedNull = rankLocationCandidates(candidates, null);
        expect(rankedNull).toHaveLength(candidates.length);
        expect(rankedNull.map((c) => c.locationId).sort()).toEqual(inputIds);

        const rankedB = rankLocationCandidates(candidates, 'B');
        expect(rankedB).toHaveLength(candidates.length);
        expect(rankedB.map((c) => c.locationId).sort()).toEqual(inputIds);

        const rankedC = rankLocationCandidates(candidates, 'C');
        expect(rankedC).toHaveLength(candidates.length);
        expect(rankedC.map((c) => c.locationId).sort()).toEqual(inputIds);
      }),
    );
  });
});
