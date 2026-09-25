// modules/sales/domain/manage-quote/margin.ts — WBS 1.6, M02 sales.
//
// domain/ layer: pure margin formula (slice brief Master decision 5), no I/O, no Date, no
// Math.random(). `computeEstimatedMarginPct` never uses Number()/parseFloat() on a numeric(14,3)
// string for the underlying revenue/cost accumulation — every amount is parsed and summed as a
// fixed-point bigint scaled by 1000 (3 fractional decimal digits), the same representation
// @pg-eos/domain-kit's Money/Quantity use internally; only the FINAL ratio (which is not itself a
// stored numeric(14,3) column — `sales.quotes.estimated_margin_pct` is numeric(6,3) but this
// function returns a plain `number` per the brief's own signature) is converted to a JS number.
//
// Formula: estimatedMarginPct = subtotal.isZero() ? null
//   : ((subtotal - sum(qty * standard_cost per line)) / subtotal) * 100, rounded to numeric(6,3).
//   A line whose service has a null standard_cost contributes 0 cost for that line.
//
// pg-reviewer fix round 1, finding 12: this file hand-rolls its own scaled-bigint parser instead
// of calling into @pg-eos/domain-kit's Money/Quantity. That is deliberate, not an oversight:
// Money/Quantity expose `multiply`/`add`/`subtract`/`compare` but NEITHER exposes a `divide` (this
// use case's own comment in upsert-quote-line.ts notes the same gap) — the margin ratio here is a
// division, and dividing two Money/Quantity instances would require unwrapping their own private
// `#amount` bigint first anyway (there is no public accessor), so this function keeps the SAME
// scaled-bigint representation domain-kit uses internally (`FRACTIONAL_DIGITS` digits, matching
// numeric(14,3)) and implements only the one operation (round-half-up division) domain-kit does
// not provide. Recorded for CHANGELOG per pg-reviewer's finding.

const SCALE = 1000n;
// numeric(14,3)'s own fractional-digit count, derived from SCALE (1000 = 10^3) rather than a bare
// literal `3` repeated at each parse site.
const FRACTIONAL_DIGITS = SCALE.toString().length - 1;
// Optional sign, 1-11 integer digits, optional '.' + up to FRACTIONAL_DIGITS decimal digits —
// matches numeric(14,3).
const DECIMAL_PATTERN = new RegExp(`^-?\\d{1,11}(?:\\.\\d{1,${FRACTIONAL_DIGITS}})?$`);
// The 3-decimal scale of the ratio this function returns (numeric(6,3)) — same scale as SCALE,
// named separately because it represents a different column's own precision.
const RATIO_SCALE = SCALE;
const PERCENT_MULTIPLIER = 100n;

export interface MarginLine {
  readonly qty: string;
  readonly unitPrice: string;
  readonly standardCost: string | null;
}

function parseScaledAmount(value: string, label: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new RangeError(
      `computeEstimatedMarginPct: expected an optional '-', 1-11 integer digits and at most ` +
        `${FRACTIONAL_DIGITS} decimal digits (numeric(14,3)) for ${label}; got ${JSON.stringify(value)}`,
    );
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart = '0', fractionalPart = ''] = unsigned.split('.');
  const paddedFraction = fractionalPart.padEnd(FRACTIONAL_DIGITS, '0');
  const magnitude = BigInt(integerPart) * SCALE + BigInt(paddedFraction);
  return negative ? -magnitude : magnitude;
}

/** Round-half-up on a numerator/denominator pair of bigints (denominator > 0). */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const quotient = absNumerator / denominator;
  const remainder = absNumerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Pure margin formula (Master decision 5). `lines` is the WHOLE quote's line set (already written
 * + the one just upserted, in the caller's own read order — summation is commutative so order
 * never matters here). Returns `null` iff the subtotal is exactly zero (an empty line set, or
 * every line's `qty * unitPrice` sums to zero) — never a division by zero.
 *
 * Each line's `qty * amount` product is accumulated at the FULL, un-rounded scale (SCALE * SCALE)
 * — never rounded back down to a numeric(14,3)-shaped intermediate per line. Rounding each line's
 * product to 3 decimals before summing would silently lose an arbitrarily small line's
 * contribution (e.g. qty "0.001" * unitPrice "0.001" rounds to exactly 0 at 3 decimals even
 * though it is not mathematically zero); the margin FORMULA itself (subtotal, cost, and their
 * ratio) has no such per-line rounding step, so this function keeps full precision through the
 * whole accumulation and only rounds the FINAL ratio to numeric(6,3).
 */
export function computeEstimatedMarginPct(lines: readonly MarginLine[]): number | null {
  let rawSubtotal = 0n; // scale: SCALE * SCALE (qty and amount are each scaled by SCALE).
  let rawCost = 0n;

  for (const line of lines) {
    const qtyScaled = parseScaledAmount(line.qty, 'qty');
    const unitPriceScaled = parseScaledAmount(line.unitPrice, 'unitPrice');
    const standardCostScaled = line.standardCost === null ? 0n : parseScaledAmount(line.standardCost, 'standardCost');

    rawSubtotal += qtyScaled * unitPriceScaled;
    rawCost += qtyScaled * standardCostScaled;
  }

  if (rawSubtotal === 0n) return null;

  // marginPct * RATIO_SCALE = ((subtotal - cost) * 100 * RATIO_SCALE) / subtotal — the shared raw
  // scale factor on rawSubtotal/rawCost cancels algebraically, so the ratio is computed directly
  // on the full-precision bigints without ever converting to a JS number until the very last step.
  const numerator = (rawSubtotal - rawCost) * PERCENT_MULTIPLIER * RATIO_SCALE;
  const marginScaled = divRoundHalfUp(numerator, rawSubtotal);

  return Number(marginScaled) / Number(RATIO_SCALE);
}
