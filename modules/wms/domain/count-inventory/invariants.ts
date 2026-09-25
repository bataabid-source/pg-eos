// modules/wms/domain/count-inventory/invariants.ts — WBS 2.13 (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/count-inventory/*) calls these BEFORE any DB write; a failed invariant
// throws a typed error from ./errors.ts. pg-tester adds property tests against these functions
// directly (P1/P2/P3, ../../tests/count-inventory/invariants.property.test.ts).

import { Quantity } from '@pg-eos/domain-kit';

import { CountFilterRequiredError, RecountRequiredError } from './errors.js';

const COUNT_TYPE_FULL = 'full';

/** P1: true iff the two quantities are NOT equal. */
export function hasVariance(qtyCounted: Quantity, qtySystem: Quantity): boolean {
  return !qtyCounted.equals(qtySystem);
}

export interface AdjustmentPlan {
  readonly direction: 'inflow' | 'outflow' | null;
  readonly magnitude: Quantity;
}

/** P2 (brief D5/D2): `direction` is 'inflow' when `final` > `qtySystem`, 'outflow' when
 *  `final` < `qtySystem`, and `null` (no movement) when they are equal. `magnitude` is ALWAYS
 *  abs(final - qtySystem), including the equal case (magnitude zero). */
export function planAdjustment(final: Quantity, qtySystem: Quantity): AdjustmentPlan {
  const diff = final.subtract(qtySystem);
  if (diff.isZero()) {
    return { direction: null, magnitude: Quantity.zero() };
  }
  return {
    direction: diff.isPositive() ? 'inflow' : 'outflow',
    magnitude: diff.isNegative() ? diff.negate() : diff,
  };
}

/** P3: true iff EVERY line has a non-null qtyCounted. An empty array is vacuously complete. */
export function isCountComplete(lines: ReadonlyArray<{ readonly qtyCounted: string | null }>): boolean {
  return lines.every((line) => line.qtyCounted !== null);
}

/** INV-C3-7's "recount mandatory on variance" guard: true iff `line` has a variance (P1) AND has
 *  never been recounted (`recountQty` still null). AdjustCount (../../application/count-inventory/
 *  adjust-count.ts) calls `assertAllVariancesRecounted` with every line of the count BEFORE posting
 *  any adjustment for it. */
export function lineNeedsRecount(line: {
  readonly qtyCounted: string | null;
  readonly qtySystem: string;
  readonly recountQty: string | null;
}): boolean {
  if (line.qtyCounted === null || line.recountQty !== null) return false;
  return hasVariance(Quantity.of(line.qtyCounted), Quantity.of(line.qtySystem));
}

/** Throws RecountRequiredError the moment ANY line in `lines` still needs a recount (per
 *  `lineNeedsRecount`). Called BEFORE any DB write in AdjustCount — an adjustment is never posted
 *  for a count that has an un-recounted variant line. */
export function assertAllVariancesRecounted(
  lines: ReadonlyArray<{ readonly qtyCounted: string | null; readonly qtySystem: string; readonly recountQty: string | null }>,
): void {
  if (lines.some((line) => lineNeedsRecount(line))) {
    throw new RecountRequiredError(
      'AdjustCount refused: at least one line has a variance (qty_counted <> qty_system) that has ' +
        'never been recounted (recount_qty is null) — INV-C3-7 "recount mandatory on variance". ' +
        '(Allowed: recount every variant line before adjusting)',
    );
  }
}

/** brief D6: `count_type` 'cycle'/'spot' require a caller-supplied filter — BOTH `locationIds`
 *  AND `skuIds`, non-empty, required together; 'full' needs neither. Thrown BEFORE any DB write. */
export function assertFilterProvidedForPartialCount(
  countType: string,
  locationIds: readonly string[] | undefined,
  skuIds: readonly string[] | undefined,
): void {
  if (countType === COUNT_TYPE_FULL) return;
  if (!locationIds || locationIds.length === 0 || !skuIds || skuIds.length === 0) {
    throw new CountFilterRequiredError(
      `StartCount: count_type "${countType}" requires BOTH locationIds and skuIds, non-empty ` +
        `(brief D6). (Allowed: locationIds and skuIds both supplied, or count_type "full")`,
    );
  }
}
