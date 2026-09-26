// modules/hr/tests/calculate-daily-commission/invariants.property.test.ts — WBS 3.13 part 2.
//
// Property tests (fast-check) for modules/hr/domain/calculate-daily-commission/invariants.ts —
// brief, Deliver: "invariants.ts exports the pure tier-match/rule-selection logic (given a list of
// candidate rule rows + delivered_count, return the one matching rule or a discriminated
// none/ambiguous result) — no state machine: this command performs one insert guarded by
// preconditions, not a dispatched set of transitions (same precedent as RegisterVehicle/
// AssignDriverId)."
//
// Surface this file exercises (GREEN and built — same "test pins the contract" discipline as this
// module's own register-employee/invariants.property.test.ts and
// modules/imile/tests/assign-driver-id/invariants.property.test.ts precedents):
//   modules/hr/domain/calculate-daily-commission/invariants.ts
//     - `CommissionRuleCandidate { id: string; tierFrom: number; tierTo: number | null;
//        ratePerUnit: string; minDaily: string | null }` — mirrors hr.commission_rules'
//        tier_from/tier_to/rate_per_unit/min_daily columns
//        (database/schema/13-Schema-Additions.sql:349-362), tier_to null = open-ended top tier
//        (brief default 1: "tier_to is null = open-ended top tier").
//     - `selectCommissionRule(rules: readonly CommissionRuleCandidate[], deliveredCount: number):
//        CommissionRuleSelection` — pure, no I/O, no Date.now()/new Date(), no Math.random()
//        (CLAUDE.md · AGENT CONSTRAINTS). A candidate rule "matches" deliveredCount when
//        `deliveredCount >= tierFrom && (tierTo === null || deliveredCount < tierTo)` (brief
//        default 1's own plain reading of `[tier_from, tier_to)`).
//     - `CommissionRuleSelection` is a discriminated union:
//         { kind: 'matched'; rule: CommissionRuleCandidate }   -- exactly one matching rule
//         { kind: 'none' }                                     -- zero matching rules
//         { kind: 'ambiguous'; rules: readonly CommissionRuleCandidate[] } -- more than one match
//       (brief default 2: "zero matching rules -> NoApplicableCommissionRuleError ... more than one
//       matching rule for the same tier -> AmbiguousCommissionRuleError").

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test.
import {
  computeGrossCommission,
  selectCommissionRule,
  type CommissionRuleCandidate,
} from '../../domain/calculate-daily-commission/invariants.js';

const ratePerUnitArb = fc.integer({ min: 1, max: 100 }).map((n) => n.toFixed(3));

/** A single, non-overlapping candidate rule tier, generated as an ordered [tierFrom, tierTo) pair
 *  with tierTo either a finite integer strictly greater than tierFrom, or null (open-ended top
 *  tier — brief default 1). */
function tierArb(): fc.Arbitrary<{ tierFrom: number; tierTo: number | null }> {
  return fc.integer({ min: 0, max: 50 }).chain((tierFrom) =>
    fc.oneof(
      fc.constant<null>(null),
      fc.integer({ min: tierFrom + 1, max: tierFrom + 50 }),
    ).map((tierTo) => ({ tierFrom, tierTo })),
  );
}

function candidateArb(idPrefix: string): fc.Arbitrary<CommissionRuleCandidate> {
  return fc.tuple(tierArb(), ratePerUnitArb, fc.integer({ min: 0, max: 20 })).map(
    ([tier, ratePerUnit, id]): CommissionRuleCandidate => ({
      id: `${idPrefix}-${id}`,
      tierFrom: tier.tierFrom,
      tierTo: tier.tierTo,
      ratePerUnit,
      minDaily: null,
    }),
  );
}

/** the plain reading of the brief's own tier-window rule — deliberately re-derived here, not
 *  imported from production code, so the property test is a real oracle, not a tautology. */
function matches(rule: CommissionRuleCandidate, deliveredCount: number): boolean {
  return deliveredCount >= rule.tierFrom && (rule.tierTo === null || deliveredCount < rule.tierTo);
}

describe('selectCommissionRule — property (pure tier-match/rule-selection logic, no I/O)', () => {
  it('never throws for arbitrary rule lists and delivered counts', () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb('r'), { maxLength: 8 }),
        fc.integer({ min: -10, max: 200 }),
        (rules, deliveredCount) => {
          expect(() => selectCommissionRule(rules, deliveredCount)).not.toThrow();
        },
      ),
    );
  });

  it('returns { kind: "none" } when zero candidate rules match deliveredCount (brief default 2)', () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb('r'), { maxLength: 8 }),
        fc.integer({ min: -10, max: 200 }),
        (rules, deliveredCount) => {
          const matching = rules.filter((r) => matches(r, deliveredCount));
          fc.pre(matching.length === 0);
          expect(selectCommissionRule(rules, deliveredCount)).toEqual({ kind: 'none' });
        },
      ),
    );
  });

  it('returns { kind: "matched", rule } naming the SAME rule when exactly one candidate rule matches', () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb('r'), { maxLength: 8 }),
        fc.integer({ min: -10, max: 200 }),
        (rules, deliveredCount) => {
          const matching = rules.filter((r) => matches(r, deliveredCount));
          fc.pre(matching.length === 1);
          const result = selectCommissionRule(rules, deliveredCount);
          expect(result.kind).toBe('matched');
          expect(result.kind === 'matched' && result.rule.id).toBe(matching[0]?.id);
        },
      ),
    );
  });

  it('returns { kind: "ambiguous", rules } listing every matching rule when more than one candidate matches (brief default 2 — no tie-break invented)', () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb('r'), { maxLength: 8 }),
        fc.integer({ min: -10, max: 200 }),
        (rules, deliveredCount) => {
          const matching = rules.filter((r) => matches(r, deliveredCount));
          fc.pre(matching.length > 1);
          const result = selectCommissionRule(rules, deliveredCount);
          expect(result.kind).toBe('ambiguous');
          const resultIds = result.kind === 'ambiguous' ? result.rules.map((r) => r.id).sort() : [];
          expect(resultIds).toEqual(matching.map((r) => r.id).sort());
        },
      ),
    );
  });

  it('an empty rule list always yields { kind: "none" }, for any deliveredCount', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 200 }), (deliveredCount) => {
        expect(selectCommissionRule([], deliveredCount)).toEqual({ kind: 'none' });
      }),
    );
  });

  it('a rule with tierTo null (open-ended top tier) matches any deliveredCount >= its tierFrom', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        ratePerUnitArb,
        fc.integer({ min: 0, max: 200 }),
        (tierFrom, ratePerUnit, extra) => {
          const deliveredCount = tierFrom + extra;
          const rule: CommissionRuleCandidate = { id: 'open', tierFrom, tierTo: null, ratePerUnit, minDaily: null };
          const result = selectCommissionRule([rule], deliveredCount);
          expect(result).toEqual({ kind: 'matched', rule });
        },
      ),
    );
  });
});

// Concrete example from the feature's own scenario (brief Scenario 1: tier_from 0, tier_to null,
// deliveredCount 3 -> that one rule).
describe('selectCommissionRule — the feature scenario\'s own concrete example', () => {
  it('tier_from 0, tier_to null, deliveredCount 3 -> matched', () => {
    const rule: CommissionRuleCandidate = { id: 'rule-1', tierFrom: 0, tierTo: null, ratePerUnit: '5.000', minDaily: null };
    expect(selectCommissionRule([rule], 3)).toEqual({ kind: 'matched', rule });
  });
});

// --- computeGrossCommission — property tests (fix round finding 3: this pure function had NO
// property/unit test at all — only integration-level coverage in calculate-daily-commission.test.ts,
// and every property arbitrary there pins minDaily to null). Brief default 3, invariants.ts's own
// header: `greatest(delivered_count * rate_per_unit, coalesce(min_daily, 0))`, exact-decimal
// arithmetic via @pg-eos/domain-kit's Money (numeric(14,3), never a float).
//
// The oracle below is deliberately a PLAIN bigint scaled-integer re-derivation, independent of
// Money's own internals (Money.of/multiply are the very primitives computeGrossCommission calls),
// so this is a real independent check for floating-point drift, not a tautology that would also
// pass a buggy float-based reimplementation.

describe('computeGrossCommission — property (pure, exact-decimal greatest(delivered*rate, coalesce(min_daily, 0)))', () => {
  const SCALE = 1000n;

  /** independent bigint-scaled-integer parse — never routes through Money, so a floating-point
   *  drift in computeGrossCommission's own use of Money would surface as a mismatch here. */
  function toScaled(value: string): bigint {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [intPart = '0', fracPart = ''] = unsigned.split('.');
    const padded = fracPart.padEnd(3, '0').slice(0, 3);
    const magnitude = BigInt(intPart) * SCALE + BigInt(padded);
    return negative ? -magnitude : magnitude;
  }

  function fromScaled(scaled: bigint): string {
    const negative = scaled < 0n;
    const absolute = negative ? -scaled : scaled;
    const intPart = absolute / SCALE;
    const fracPart = (absolute % SCALE).toString().padStart(3, '0');
    return `${negative ? '-' : ''}${intPart.toString()}.${fracPart}`;
  }

  // exactly 3 fractional digits, matching numeric(14,3) and this module's own RATE_PER_UNIT fixture
  // convention ('5.000') — small integer part to keep delivered*rate comfortably inside
  // numeric(14,3)'s magnitude bound even at the largest deliveredCount this arbitrary generates.
  const ratePerUnitArb2 = fc
    .tuple(fc.integer({ min: 0, max: 1_000 }), fc.integer({ min: 0, max: 999 }))
    .map(([intPart, frac]) => `${intPart}.${frac.toString().padStart(3, '0')}`);

  const minDailyAmountArb = fc
    .tuple(fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: 0, max: 999 }))
    .map(([intPart, frac]) => `${intPart}.${frac.toString().padStart(3, '0')}`);

  // null sometimes, a real value sometimes (including sometimes GREATER than deliveredCount*rate
  // and sometimes LESS — finding 3's own complaint: "every property arbitrary there pins minDaily
  // to null").
  const minDailyArb: fc.Arbitrary<string | null> = fc.oneof(
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 3, arbitrary: minDailyAmountArb },
  );

  const deliveredCountArb = fc.integer({ min: 0, max: 100_000 });

  it('(a) the result is always >= deliveredCount*ratePerUnit AND >= minDaily (when minDaily is not null)', () => {
    fc.assert(
      fc.property(deliveredCountArb, ratePerUnitArb2, minDailyArb, (deliveredCount, ratePerUnit, minDaily) => {
        const result = computeGrossCommission(deliveredCount, ratePerUnit, minDaily);
        const tieredScaled = toScaled(ratePerUnit) * BigInt(deliveredCount);
        const resultScaled = toScaled(result.toString());

        expect(resultScaled >= tieredScaled).toBe(true);
        if (minDaily !== null) {
          expect(resultScaled >= toScaled(minDaily)).toBe(true);
        }
      }),
    );
  });

  it('(b) the result always equals exactly ONE of the two operands (never a third computed value)', () => {
    fc.assert(
      fc.property(deliveredCountArb, ratePerUnitArb2, minDailyArb, (deliveredCount, ratePerUnit, minDaily) => {
        const result = computeGrossCommission(deliveredCount, ratePerUnit, minDaily);
        const tieredScaled = toScaled(ratePerUnit) * BigInt(deliveredCount);
        const minDailyScaled = minDaily === null ? 0n : toScaled(minDaily);
        const resultScaled = toScaled(result.toString());

        expect(resultScaled === tieredScaled || resultScaled === minDailyScaled).toBe(true);
      }),
    );
  });

  it('(c) exact-decimal correctness — the result string matches an independent bigint-scaled oracle exactly, no floating-point drift', () => {
    fc.assert(
      fc.property(deliveredCountArb, ratePerUnitArb2, minDailyArb, (deliveredCount, ratePerUnit, minDaily) => {
        const tieredScaled = toScaled(ratePerUnit) * BigInt(deliveredCount);
        const minDailyScaled = minDaily === null ? 0n : toScaled(minDaily);
        const expectedScaled = tieredScaled >= minDailyScaled ? tieredScaled : minDailyScaled;
        const expected = fromScaled(expectedScaled);

        const result = computeGrossCommission(deliveredCount, ratePerUnit, minDaily);
        expect(result.toString()).toBe(expected);
      }),
    );
  });

  // concrete examples pinning the three branches finding 3 named explicitly.
  it('concrete: minDaily null -> floor is 0, tiered amount wins whenever deliveredCount > 0', () => {
    const result = computeGrossCommission(4, '5.000', null);
    expect(result.toString()).toBe('20.000');
  });

  it('concrete: minDaily GREATER than deliveredCount*ratePerUnit -> minDaily wins', () => {
    const result = computeGrossCommission(2, '1.000', '100.000');
    expect(result.toString()).toBe('100.000');
  });

  it('concrete: minDaily LESS than deliveredCount*ratePerUnit -> the tiered amount wins', () => {
    const result = computeGrossCommission(50, '5.000', '100.000');
    expect(result.toString()).toBe('250.000');
  });

  it('concrete: minDaily EQUAL to deliveredCount*ratePerUnit -> either operand, same value, is returned (never throws on the tie)', () => {
    const result = computeGrossCommission(20, '5.000', '100.000');
    expect(result.toString()).toBe('100.000');
  });
});
