// modules/sales/domain/resolve-price/tiered-pricing.ts — WBS 1.4, M02 sales pricing engine.
//
// Pure tiered/progressive price calculation (Master decision 4, slice brief) — no I/O, no Date,
// no Math.random(). Given one price list's (or contract annex's) `catalog.price_list_lines` rows
// for a single service, already fetched and sorted by `tier_from` ascending, and a quantity,
// computes the total via Money/Quantity numeric(14,3) arithmetic — never Number()/parseFloat() on
// a stored value.
//
// A FLAT line (`tierFrom`/`tierTo` both null, the sole line) is `total = price × qty`.
// A TIERED ladder: walk tiers in order; for each tier `[from, to)` (last tier's `to` may be null =
// unbounded), `billableInTier = max(0, min(qty, to ?? qty) - from - freeUnits)` (freeUnits applies
// PER TIER, never carried to another tier). Sum `billableInTier × price` per tier — each tier at
// its own rate (INV-C1-3), never the last tier's rate applied to the whole quantity.
//
// ASSUMES the ladder already passed catalog module 1.2's validateTierLadder (contiguous, no gap,
// no overlap) on write — this function does NOT re-validate contiguity beyond detecting the
// specific malformed shapes below; a malformed ladder found here throws MalformedTierLadderError,
// never a silent miscalculation.

import { Money, Quantity } from '@pg-eos/domain-kit';

import { MalformedTierLadderError } from './errors.js';

/** One `catalog.price_list_lines` row for one service, already fetched and sorted by `tier_from`
 *  ascending. A flat line has `tierFrom = null, tierTo = null` and is the sole line. */
export interface TieredPriceLine {
  readonly price: string;
  readonly tierFrom: string | null;
  readonly tierTo: string | null;
  readonly freeUnits: string;
}

function quantityMax(a: Quantity, b: Quantity): Quantity {
  return a.compare(b) >= 0 ? a : b;
}

function quantityMin(a: Quantity, b: Quantity): Quantity {
  return a.compare(b) <= 0 ? a : b;
}

/** Throws MalformedTierLadderError for any shape other than a single flat line or a contiguous,
 *  strictly-ascending ladder whose only unbounded (`tierTo = null`) tier is the last one. */
function assertValidLadder(lines: readonly TieredPriceLine[]): void {
  if (lines.length === 0) {
    throw new MalformedTierLadderError('computeTieredPrice: expected at least one price_list_lines row, got none');
  }

  if (lines.length === 1 && lines[0]!.tierFrom === null && lines[0]!.tierTo === null) {
    return; // the flat-line shape.
  }

  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;

    if (line.tierFrom === null) {
      throw new MalformedTierLadderError(
        `computeTieredPrice: tier at index ${index} has a null tierFrom in a multi-line ladder ` +
          `(only a single flat line may have a null tierFrom)`,
      );
    }
    if (line.tierTo === null && !isLast) {
      throw new MalformedTierLadderError(
        `computeTieredPrice: tier at index ${index} has a null (unbounded) tierTo but is not the ` +
          `last tier — only the last tier of a ladder may be unbounded`,
      );
    }
    // pg-reviewer round 1 finding 3: an inverted/zero-width tier (e.g. [0-50],[50-40],[40-null])
    // must never silently overbill — a tier's own tierTo must strictly exceed its own tierFrom.
    if (line.tierTo !== null && Quantity.of(line.tierTo).compare(Quantity.of(line.tierFrom!)) <= 0) {
      throw new MalformedTierLadderError(
        `computeTieredPrice: tier at index ${index} has tierTo (${line.tierTo}) <= its own tierFrom ` +
          `(${line.tierFrom}) — a tier's span must be strictly positive`,
      );
    }

    if (index > 0) {
      const previous = lines[index - 1]!;
      if (previous.tierTo === null) {
        throw new MalformedTierLadderError(
          `computeTieredPrice: tier at index ${index - 1} is unbounded but is followed by another ` +
            `tier at index ${index}`,
        );
      }
      if (!Quantity.of(previous.tierTo).equals(Quantity.of(line.tierFrom))) {
        throw new MalformedTierLadderError(
          `computeTieredPrice: tier at index ${index - 1} ends at ${previous.tierTo} but tier at ` +
            `index ${index} starts at ${line.tierFrom} — the ladder must be contiguous, no gap, no overlap`,
        );
      }
    }
  });
}

/** Pure — no I/O. See file header for the exact formula. */
export function computeTieredPrice(lines: readonly TieredPriceLine[], qty: Quantity): Money {
  assertValidLadder(lines);

  const firstLine = lines[0]!;
  if (lines.length === 1 && firstLine.tierFrom === null && firstLine.tierTo === null) {
    return Money.of(firstLine.price).multiply(qty.toString());
  }

  let total = Money.zero();

  for (const line of lines) {
    const from = Quantity.of(line.tierFrom!);
    const to = line.tierTo === null ? qty : Quantity.of(line.tierTo);
    const freeUnits = Quantity.of(line.freeUnits);

    const billableSpan = quantityMax(Quantity.zero(), quantityMin(qty, to).subtract(from));
    const billableInTier = quantityMax(Quantity.zero(), billableSpan.subtract(freeUnits));

    if (billableInTier.isPositive()) {
      total = total.add(Money.of(line.price).multiply(billableInTier.toString()));
    }
  }

  return total;
}
