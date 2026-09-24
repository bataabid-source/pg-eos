// modules/catalog/tests/maintain-price-list/tier-ladder.property.test.ts — WBS 1.2, M03 catalog.
//
// Property tests (fast-check) for INV-C1-3 — Master decision 5, slice brief "Property tests" (b):
// "a ladder built as contiguous tiers from 0 always validates, and any single mutation (gap,
// overlap, non-zero start, flat+tier mix, negative free_units) fails".
//
// Expected new surface (RED until it exists):
//   modules/catalog/domain/maintain-price-list/tier-ladder.ts
//     - `validateTierLadder(lines: ReadonlyArray<{ serviceId: string; tierFrom: string | null;
//       tierTo: string | null; freeUnits: string }>): void` — pure, no I/O. Groups `lines` by
//       `serviceId` and validates EACH group independently (a violation in one service's group
//       does not affect another service's group). Per group: either exactly ONE flat line
//       (tierFrom === null && tierTo === null), or an ordered ladder where the first tier's
//       tierFrom === '0'/'0.000', each next tierFrom equals the previous tierTo (no gap, no
//       overlap), only the LAST tierTo may be null, and no line has both tierFrom and tierTo null
//       unless it is the group's only line (no flat+tier mix). `freeUnits` must be >= 0 for every
//       line. Throws TierLadderError (../errors.js) on the first violation found; returns (no
//       throw) when every group is valid.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateTierLadder } from '../../domain/maintain-price-list/tier-ladder.js';
import { TierLadderError } from '../../domain/maintain-price-list/errors.js';

const ZERO_FREE_UNITS = '0.000';

interface TierLine {
  readonly serviceId: string;
  readonly tierFrom: string | null;
  readonly tierTo: string | null;
  readonly freeUnits: string;
}

function boundary(n: number): string {
  return `${n}.000`;
}

/** A valid, contiguous ladder for one service: `widths` (each >= 1) are the tier sizes; the last
 *  tier's tierTo is null. `widths.length === 1` still produces a TIERED (non-flat) single-tier
 *  line starting at 0 — a separate helper below builds the FLAT (both-null) single-line case. */
function buildTieredLadder(serviceId: string, widths: readonly number[]): TierLine[] {
  const lines: TierLine[] = [];
  let cursor = 0;
  for (const [index, width] of widths.entries()) {
    const from = cursor;
    const to = cursor + width;
    const isLast = index === widths.length - 1;
    lines.push({
      serviceId,
      tierFrom: boundary(from),
      tierTo: isLast ? null : boundary(to),
      freeUnits: ZERO_FREE_UNITS,
    });
    cursor = to;
  }
  return lines;
}

function buildFlatLine(serviceId: string): TierLine {
  return { serviceId, tierFrom: null, tierTo: null, freeUnits: ZERO_FREE_UNITS };
}

const uuidArb = fc.uuid();
const widthArb = fc.integer({ min: 1, max: 50 });
const widthsArb = (minTiers: number, maxTiers: number) =>
  fc.array(widthArb, { minLength: minTiers, maxLength: maxTiers });

describe('validateTierLadder — a contiguous ladder from 0 always validates', () => {
  it('a single flat line (tierFrom/tierTo both null) always passes', () => {
    fc.assert(
      fc.property(uuidArb, (serviceId) => {
        expect(() => validateTierLadder([buildFlatLine(serviceId)])).not.toThrow();
      }),
    );
  });

  it('a contiguous multi-tier ladder starting at 0, only the last tierTo null, always passes', () => {
    fc.assert(
      fc.property(uuidArb, widthsArb(1, 8), (serviceId, widths) => {
        expect(() => validateTierLadder(buildTieredLadder(serviceId, widths))).not.toThrow();
      }),
    );
  });
});

describe('validateTierLadder — ladders for different services are independent', () => {
  it('two independently-valid ladders for two different services both pass in the same call', () => {
    fc.assert(
      fc.property(uuidArb, uuidArb, widthsArb(1, 5), widthsArb(1, 5), (serviceA, serviceB, widthsA, widthsB) => {
        fc.pre(serviceA !== serviceB);
        const lines = [...buildTieredLadder(serviceA, widthsA), ...buildTieredLadder(serviceB, widthsB)];
        expect(() => validateTierLadder(lines)).not.toThrow();
      }),
    );
  });

  it('a broken ladder for one service still throws even when the other service is valid', () => {
    fc.assert(
      fc.property(uuidArb, uuidArb, widthsArb(2, 5), (serviceA, serviceB, widthsB) => {
        fc.pre(serviceA !== serviceB);
        // serviceA gets two flat lines (always invalid); serviceB is a valid tiered ladder.
        const lines = [buildFlatLine(serviceA), buildFlatLine(serviceA), ...buildTieredLadder(serviceB, widthsB)];
        expect(() => validateTierLadder(lines)).toThrow(TierLadderError);
      }),
    );
  });
});

describe('validateTierLadder — every single mutation of a valid ladder throws TierLadderError', () => {
  it('a gap between two tiers throws', () => {
    fc.assert(
      fc.property(uuidArb, widthsArb(2, 6), fc.integer({ min: 1, max: 9 }), (serviceId, widths, gapSize) => {
        const lines = buildTieredLadder(serviceId, widths);
        // Widen the gap after the FIRST tier: bump every subsequent tierFrom/tierTo by gapSize,
        // except leave the very first line's tierFrom at 0 — this opens a gap right after tier 1.
        const mutated = lines.map((line, index) => {
          if (index === 0) return line;
          const shift = (value: string | null): string | null =>
            value === null ? null : boundary(Number(value) + gapSize);
          return { ...line, tierFrom: shift(line.tierFrom), tierTo: shift(line.tierTo) };
        });
        expect(() => validateTierLadder(mutated)).toThrow(TierLadderError);
      }),
    );
  });

  it('an overlap between two tiers throws', () => {
    fc.assert(
      fc.property(uuidArb, widthsArb(2, 6), (serviceId, widths) => {
        const lines = buildTieredLadder(serviceId, widths);
        const first = lines[0] as TierLine;
        const overlapAmount = 1;
        // Pull tier 2's tierFrom BACK into tier 1's range — an overlap, not a gap.
        const secondTierFrom = Number(first.tierTo) - overlapAmount;
        fc.pre(secondTierFrom > Number(first.tierFrom));
        const mutated = lines.map((line, index) =>
          index === 1 ? { ...line, tierFrom: boundary(secondTierFrom) } : line,
        );
        expect(() => validateTierLadder(mutated)).toThrow(TierLadderError);
      }),
    );
  });

  it('a non-zero start throws', () => {
    fc.assert(
      fc.property(uuidArb, widthsArb(1, 6), fc.integer({ min: 1, max: 20 }), (serviceId, widths, offset) => {
        const lines = buildTieredLadder(serviceId, widths);
        const mutated = lines.map((line, index) => (index === 0 ? { ...line, tierFrom: boundary(offset) } : line));
        expect(() => validateTierLadder(mutated)).toThrow(TierLadderError);
      }),
    );
  });

  it('mixing one flat line with tiered lines for the SAME service throws', () => {
    fc.assert(
      fc.property(uuidArb, widthsArb(1, 6), (serviceId, widths) => {
        const lines = [...buildTieredLadder(serviceId, widths), buildFlatLine(serviceId)];
        expect(() => validateTierLadder(lines)).toThrow(TierLadderError);
      }),
    );
  });

  it('negative free_units on any line throws', () => {
    fc.assert(
      fc.property(uuidArb, widthsArb(1, 6), fc.nat({ max: 5 }), (serviceId, widths, mutateIndexSeed) => {
        const lines = buildTieredLadder(serviceId, widths);
        const mutateIndex = mutateIndexSeed % lines.length;
        const mutated = lines.map((line, index) => (index === mutateIndex ? { ...line, freeUnits: '-1.000' } : line));
        expect(() => validateTierLadder(mutated)).toThrow(TierLadderError);
      }),
    );
  });

  it('two flat lines for one service throws', () => {
    fc.assert(
      fc.property(uuidArb, (serviceId) => {
        expect(() => validateTierLadder([buildFlatLine(serviceId), buildFlatLine(serviceId)])).toThrow(
          TierLadderError,
        );
      }),
    );
  });

  // Fix round 1 (pg-reviewer F2a) — an inverted tier (tierTo < tierFrom) is invalid on its own
  // terms, independent of gap/overlap detection against its neighbour.
  it('an inverted tier (tierTo < tierFrom) throws — e.g. [0-100, 100-50]', () => {
    fc.assert(
      fc.property(uuidArb, (serviceId) => {
        const lines: TierLine[] = [
          { serviceId, tierFrom: boundary(0), tierTo: boundary(100), freeUnits: ZERO_FREE_UNITS },
          { serviceId, tierFrom: boundary(100), tierTo: boundary(50), freeUnits: ZERO_FREE_UNITS }, // inverted.
        ];
        expect(() => validateTierLadder(lines)).toThrow(TierLadderError);
      }),
    );
  });

  // Fix round 1 (pg-reviewer F2b) — two rows sharing the same (serviceId, tierFrom) can slip past a
  // naive "sorted, walk consecutive pairs" gap/overlap check when they also share the same sort
  // key; this must still throw.
  it('two rows with the same (serviceId, tierFrom) in one ladder throw, even with different tierTo', () => {
    fc.assert(
      fc.property(uuidArb, (serviceId) => {
        const lines: TierLine[] = [
          { serviceId, tierFrom: boundary(0), tierTo: boundary(100), freeUnits: ZERO_FREE_UNITS },
          { serviceId, tierFrom: boundary(0), tierTo: boundary(50), freeUnits: ZERO_FREE_UNITS }, // duplicate tierFrom.
        ];
        expect(() => validateTierLadder(lines)).toThrow(TierLadderError);
      }),
    );
  });
});

describe('validateTierLadder — a valid contiguous ladder never has an inverted or zero-width tier', () => {
  it('every tier satisfies tierTo === null || Number(tierTo) > Number(tierFrom)', () => {
    fc.assert(
      fc.property(uuidArb, widthsArb(1, 8), (serviceId, widths) => {
        const lines = buildTieredLadder(serviceId, widths);
        expect(() => validateTierLadder(lines)).not.toThrow();
        for (const line of lines) {
          expect(line.tierTo === null || Number(line.tierTo) > Number(line.tierFrom)).toBe(true);
        }
      }),
    );
  });
});
