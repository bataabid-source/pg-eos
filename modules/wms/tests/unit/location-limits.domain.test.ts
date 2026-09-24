// modules/wms/tests/unit/location-limits.domain.test.ts — WBS 2.4 (pg-tester), fix round 2
// finding 7 (F7), REVISED per the Master's signature-change directive (fix round 2, mid-task):
// Quantity is fixed at 3 decimal places and cannot hold volume (wms.skus.volume_cbm is
// numeric(10,4), wms.locations.max_volume_cbm is numeric(10,5) — see database/schema/
// 01-Data-Model.sql:648 and 019-Warehouse-WH1-Setup.sql:44), so the exact resulting-load
// arithmetic stays in SQL numeric (proven by the integration suite,
// modules/wms/tests/integration/location-limits.test.ts) and this PURE function covers ONLY the
// DECISION logic — which of the five outcomes applies, given booleans the caller has already
// computed from that SQL arithmetic.
//
// Exact contract (the Master's directive, verbatim):
//   evaluateLocationLimits({
//     locationType: string, isBlocked: boolean,
//     hasMaxWeight: boolean, hasMaxVolume: boolean,
//     skuHasWeight: boolean, skuHasVolume: boolean,
//     weightExceeds: boolean, volumeExceeds: boolean,
//   }) => { ok: true } | { ok: false, reason: 'blocked' | 'missing_weight' | 'missing_volume'
//                                            | 'over_weight' | 'over_volume' }
//
// Rules, in order (the Master's directive, verbatim):
//   1. blocked -> 'blocked' (any type)
//   2. a type other than 'pallet' or 'shelf' -> ok
//   3. hasMaxWeight && !skuHasWeight -> 'missing_weight'
//   4. hasMaxVolume && !skuHasVolume -> 'missing_volume'
//   5. hasMaxWeight && weightExceeds -> 'over_weight'
//   6. hasMaxVolume && volumeExceeds -> 'over_volume'
//   7. else -> ok
//
// Boundaries (exactly at the max is ok) are covered by the integration suite (the arithmetic that
// produces `weightExceeds`/`volumeExceeds` lives in SQL, not here). Exported from
// modules/wms/src/stock-ledger (the index barrel) — same precedent as
// modules/wms/tests/unit/sku-registration.domain.test.ts / stock-ledger.domain.test.ts.
//
// Pure domain only: no DB, no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). The domain
// here (a locationType out of 4 values crossed with 7 independent booleans — isBlocked,
// hasMaxWeight, hasMaxVolume, skuHasWeight, skuHasVolume, weightExceeds, volumeExceeds — so
// 4 * 2^7 = 512 combinations) is small enough to prove EXHAUSTIVELY, not just sampled — the
// strongest test this contract can have — alongside fast-check properties for the named invariants.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED until pg-backend adds it to
// modules/wms/src/stock-ledger/domain.ts and re-exports it from index.ts, alongside the existing
// balanceKey/planTransfer/etc. barrel).
import { evaluateLocationLimits } from '../../index.js';

// 13B chk (019-Warehouse-WH1-Setup.sql's own location_type check, 13B-Schema-Reference-
// Consolidation.sql:3560): the only four legal values.
const STORAGE_LOCATION_TYPES = ['pallet', 'shelf'] as const;
const NON_STORAGE_LOCATION_TYPES = ['operational', 'structural'] as const;
const ALL_LOCATION_TYPES = [...STORAGE_LOCATION_TYPES, ...NON_STORAGE_LOCATION_TYPES] as const;

type LocationLimitReason =
  | 'blocked'
  | 'missing_weight'
  | 'missing_volume'
  | 'over_weight'
  | 'over_volume';
type LocationLimitResult = { ok: true } | { ok: false; reason: LocationLimitReason };

interface LocationLimitInput {
  readonly locationType: string;
  readonly isBlocked: boolean;
  readonly hasMaxWeight: boolean;
  readonly hasMaxVolume: boolean;
  readonly skuHasWeight: boolean;
  readonly skuHasVolume: boolean;
  readonly weightExceeds: boolean;
  readonly volumeExceeds: boolean;
}

/**
 * An INDEPENDENT reference oracle, written directly from the Master's rule list above (never from
 * reading modules/wms/src/stock-ledger/domain.ts) — the authority every property below checks
 * `evaluateLocationLimits` against.
 */
function expectedVerdict(input: LocationLimitInput): LocationLimitResult {
  if (input.isBlocked) {
    return { ok: false, reason: 'blocked' };
  }
  if (input.locationType !== 'pallet' && input.locationType !== 'shelf') {
    return { ok: true };
  }
  if (input.hasMaxWeight && !input.skuHasWeight) {
    return { ok: false, reason: 'missing_weight' };
  }
  if (input.hasMaxVolume && !input.skuHasVolume) {
    return { ok: false, reason: 'missing_volume' };
  }
  if (input.hasMaxWeight && input.weightExceeds) {
    return { ok: false, reason: 'over_weight' };
  }
  if (input.hasMaxVolume && input.volumeExceeds) {
    return { ok: false, reason: 'over_volume' };
  }
  return { ok: true };
}

const BOOLEANS = [false, true] as const;

function allInputs(): LocationLimitInput[] {
  const inputs: LocationLimitInput[] = [];
  for (const locationType of ALL_LOCATION_TYPES) {
    for (const isBlocked of BOOLEANS) {
      for (const hasMaxWeight of BOOLEANS) {
        for (const hasMaxVolume of BOOLEANS) {
          for (const skuHasWeight of BOOLEANS) {
            for (const skuHasVolume of BOOLEANS) {
              for (const weightExceeds of BOOLEANS) {
                for (const volumeExceeds of BOOLEANS) {
                  inputs.push({
                    locationType,
                    isBlocked,
                    hasMaxWeight,
                    hasMaxVolume,
                    skuHasWeight,
                    skuHasVolume,
                    weightExceeds,
                    volumeExceeds,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return inputs;
}

// --- arbitraries -----------------------------------------------------------------------------

const anyLocationTypeArb = (): fc.Arbitrary<(typeof ALL_LOCATION_TYPES)[number]> =>
  fc.constantFrom(...ALL_LOCATION_TYPES);
const nonStorageLocationTypeArb = (): fc.Arbitrary<(typeof NON_STORAGE_LOCATION_TYPES)[number]> =>
  fc.constantFrom(...NON_STORAGE_LOCATION_TYPES);

const inputArb = (): fc.Arbitrary<LocationLimitInput> =>
  fc.record({
    locationType: anyLocationTypeArb(),
    isBlocked: fc.boolean(),
    hasMaxWeight: fc.boolean(),
    hasMaxVolume: fc.boolean(),
    skuHasWeight: fc.boolean(),
    skuHasVolume: fc.boolean(),
    weightExceeds: fc.boolean(),
    volumeExceeds: fc.boolean(),
  });

// --- property: the verdict equals the independent reference oracle, EXHAUSTIVELY ----------------

describe('evaluateLocationLimits: matches the independent reference oracle for every one of the 4 x 2^7 = 512 combinations', () => {
  it('holds for every combination of locationType and the seven booleans (exhaustive, not sampled)', () => {
    const inputs = allInputs();
    expect(inputs).toHaveLength(ALL_LOCATION_TYPES.length * 2 ** 7);

    for (const input of inputs) {
      const result = evaluateLocationLimits(input) as LocationLimitResult;
      expect(result, JSON.stringify(input)).toEqual(expectedVerdict(input));
    }
  });
});

// --- property: blocked always wins, regardless of every other field -----------------------------

describe('evaluateLocationLimits: blocked always wins', () => {
  const PROPERTY_SEED = 2_004_001;
  const NUM_RUNS = 1000;

  it(`holds for ${NUM_RUNS} random inputs with isBlocked forced true (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const result = evaluateLocationLimits({ ...input, isBlocked: true }) as LocationLimitResult;
        expect(result).toEqual({ ok: false, reason: 'blocked' });
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

// --- property: non-storage types are never rejected except for blocked --------------------------

describe('evaluateLocationLimits: non-storage types (operational, structural) are never rejected except for blocked', () => {
  const PROPERTY_SEED = 2_004_002;
  const NUM_RUNS = 1000;

  it(`holds for ${NUM_RUNS} random inputs (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(
        nonStorageLocationTypeArb(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (
          locationType,
          isBlocked,
          hasMaxWeight,
          hasMaxVolume,
          skuHasWeight,
          skuHasVolume,
          weightExceeds,
          volumeExceeds,
        ) => {
          const result = evaluateLocationLimits({
            locationType,
            isBlocked,
            hasMaxWeight,
            hasMaxVolume,
            skuHasWeight,
            skuHasVolume,
            weightExceeds,
            volumeExceeds,
          }) as LocationLimitResult;
          if (isBlocked) {
            expect(result).toEqual({ ok: false, reason: 'blocked' });
          } else {
            expect(result).toEqual({ ok: true });
          }
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

// --- property: ok iff no rule fires --------------------------------------------------------------

describe('evaluateLocationLimits: ok iff no rejecting rule fires', () => {
  const PROPERTY_SEED = 2_004_003;
  const NUM_RUNS = 1000;

  it(`holds for ${NUM_RUNS} random inputs (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const result = evaluateLocationLimits(input) as LocationLimitResult;
        const expected = expectedVerdict(input);
        expect(result.ok).toBe(expected.ok);

        const noRuleFires =
          !input.isBlocked &&
          (input.locationType !== 'pallet' && input.locationType !== 'shelf'
            ? true
            : !(input.hasMaxWeight && !input.skuHasWeight) &&
              !(input.hasMaxVolume && !input.skuHasVolume) &&
              !(input.hasMaxWeight && input.weightExceeds) &&
              !(input.hasMaxVolume && input.volumeExceeds));
        expect(result.ok).toBe(noRuleFires);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

// --- property: reason priority order (blocked > missing_weight > missing_volume > over_weight >
//     over_volume) — explicit, conflicting-flag cases, each proving the earlier rule wins ---------

describe('evaluateLocationLimits: reason priority order', () => {
  it('blocked wins over every other simultaneously-true rejection', () => {
    const result = evaluateLocationLimits({
      locationType: 'pallet',
      isBlocked: true,
      hasMaxWeight: true,
      hasMaxVolume: true,
      skuHasWeight: false,
      skuHasVolume: false,
      weightExceeds: true,
      volumeExceeds: true,
    }) as LocationLimitResult;
    expect(result).toEqual({ ok: false, reason: 'blocked' });
  });

  it('missing_weight wins over missing_volume when both are missing', () => {
    const result = evaluateLocationLimits({
      locationType: 'shelf',
      isBlocked: false,
      hasMaxWeight: true,
      hasMaxVolume: true,
      skuHasWeight: false,
      skuHasVolume: false,
      weightExceeds: false,
      volumeExceeds: false,
    }) as LocationLimitResult;
    expect(result).toEqual({ ok: false, reason: 'missing_weight' });
  });

  it('missing_volume wins over over_weight (weight present and exceeding, volume missing)', () => {
    const result = evaluateLocationLimits({
      locationType: 'pallet',
      isBlocked: false,
      hasMaxWeight: true,
      hasMaxVolume: true,
      skuHasWeight: true,
      skuHasVolume: false,
      weightExceeds: true,
      volumeExceeds: false,
    }) as LocationLimitResult;
    expect(result).toEqual({ ok: false, reason: 'missing_volume' });
  });

  it('over_weight wins over over_volume when both exceed', () => {
    const result = evaluateLocationLimits({
      locationType: 'shelf',
      isBlocked: false,
      hasMaxWeight: true,
      hasMaxVolume: true,
      skuHasWeight: true,
      skuHasVolume: true,
      weightExceeds: true,
      volumeExceeds: true,
    }) as LocationLimitResult;
    expect(result).toEqual({ ok: false, reason: 'over_weight' });
  });

  it('over_volume fires only when weight does not exceed (or has no max)', () => {
    const result = evaluateLocationLimits({
      locationType: 'pallet',
      isBlocked: false,
      hasMaxWeight: true,
      hasMaxVolume: true,
      skuHasWeight: true,
      skuHasVolume: true,
      weightExceeds: false,
      volumeExceeds: true,
    }) as LocationLimitResult;
    expect(result).toEqual({ ok: false, reason: 'over_volume' });
  });

  it('ok when no max is set at all, even if skuHasWeight/skuHasVolume are false', () => {
    const result = evaluateLocationLimits({
      locationType: 'pallet',
      isBlocked: false,
      hasMaxWeight: false,
      hasMaxVolume: false,
      skuHasWeight: false,
      skuHasVolume: false,
      weightExceeds: false,
      volumeExceeds: false,
    }) as LocationLimitResult;
    expect(result).toEqual({ ok: true });
  });
});
