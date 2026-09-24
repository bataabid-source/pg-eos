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

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import {
  compareLocationCandidates,
  rankLocationCandidates,
  type RankableLocationCandidate,
} from '../../domain/receive-inbound/suggest-location-ranking.js';

const candidateArb: fc.Arbitrary<RankableLocationCandidate> = fc.record({
  locationId: fc.uuid(),
  clientAssignedMatch: fc.boolean(),
  // fc-generated fraction, 0..1 inclusive — a resulting-load headroom ratio is always in this
  // range by construction (never negative, never over 1, per WBS 2.4's own hard-barrier rule that
  // a location at or under its max is the only kind ever offered as a candidate).
  remainingCapacityRatio: fc.double({ min: 0, max: 1, noNaN: true }),
  positionNo: fc.integer({ min: 1, max: 99 }), // doc 40 §C3 location code: position 01-99.
});

const candidatesArb = fc.array(candidateArb, { minLength: 0, maxLength: 30 });

describe('rankLocationCandidates — property: permutation-preserving', () => {
  it('returns exactly the same set of locationIds as the input, for any candidate set', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const ranked = rankLocationCandidates(candidates);
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
        rankLocationCandidates(candidates);
        expect(candidates.map((c) => c.locationId)).toEqual(before);
      }),
    );
  });
});

describe('rankLocationCandidates — property: sorted by compareLocationCandidates, adjacent pairs never inverted', () => {
  it('every adjacent pair in the output is already in order (never regresses)', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const ranked = rankLocationCandidates(candidates);
        for (let i = 0; i < ranked.length - 1; i += 1) {
          const a = ranked[i] as RankableLocationCandidate;
          const b = ranked[i + 1] as RankableLocationCandidate;
          expect(compareLocationCandidates(a, b)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe('rankLocationCandidates — property: a client-assigned match never ranks below a non-match', () => {
  it('for any two candidates, a clientAssignedMatch=true one never appears after a clientAssignedMatch=false one when both are present', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const ranked = rankLocationCandidates(candidates);
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
});

describe('rankLocationCandidates — deterministic examples (doc 40 §C3 A2 ranking criteria)', () => {
  it('ranks a client-assigned match above a non-match even with less capacity and a higher position', () => {
    const matchLowCapacityHighPosition: RankableLocationCandidate = {
      locationId: 'loc-match',
      clientAssignedMatch: true,
      remainingCapacityRatio: 0.1,
      positionNo: 99,
    };
    const noMatchHighCapacityLowPosition: RankableLocationCandidate = {
      locationId: 'loc-nomatch',
      clientAssignedMatch: false,
      remainingCapacityRatio: 0.9,
      positionNo: 1,
    };
    const ranked = rankLocationCandidates([noMatchHighCapacityLowPosition, matchLowCapacityHighPosition]);
    expect(ranked.map((c) => c.locationId)).toEqual(['loc-match', 'loc-nomatch']);
  });

  it('within the same clientAssignedMatch group, ranks more remaining capacity first', () => {
    const low: RankableLocationCandidate = {
      locationId: 'loc-low',
      clientAssignedMatch: false,
      remainingCapacityRatio: 0.2,
      positionNo: 1,
    };
    const high: RankableLocationCandidate = {
      locationId: 'loc-high',
      clientAssignedMatch: false,
      remainingCapacityRatio: 0.8,
      positionNo: 1,
    };
    const ranked = rankLocationCandidates([low, high]);
    expect(ranked.map((c) => c.locationId)).toEqual(['loc-high', 'loc-low']);
  });

  it('within the same match group and same capacity, ranks the lower position number first (nearer the door, doc 40 §C3)', () => {
    const far: RankableLocationCandidate = {
      locationId: 'loc-far',
      clientAssignedMatch: true,
      remainingCapacityRatio: 0.5,
      positionNo: 42,
    };
    const near: RankableLocationCandidate = {
      locationId: 'loc-near',
      clientAssignedMatch: true,
      remainingCapacityRatio: 0.5,
      positionNo: 1,
    };
    const ranked = rankLocationCandidates([far, near]);
    expect(ranked.map((c) => c.locationId)).toEqual(['loc-near', 'loc-far']);
  });

  it('an empty candidate list ranks to an empty list', () => {
    expect(rankLocationCandidates([])).toEqual([]);
  });
});
