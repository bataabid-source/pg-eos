// modules/sales/tests/resolve-price/tiered-pricing.property.test.ts — WBS 1.4, pricing engine.
//
// Property tests (fast-check) for the pure domain calculation in
// modules/sales/domain/resolve-price/tiered-pricing.ts — slice brief "Master decisions" 4 and
// "Property tests" (a)/(b)/(c).
//
// Expected new surface (RED until it exists — quoted verbatim for the build brief; pg-tester's own
// naming choice since the brief's decision 4 only fixes the FILE, not the export names):
//   modules/sales/domain/resolve-price/tiered-pricing.ts
//     - `TieredPriceLine` — `{ readonly price: string; readonly tierFrom: string | null;
//       readonly tierTo: string | null; readonly freeUnits: string }` — one catalog.price_list_lines
//       row for one service, already fetched and sorted by tier_from ascending (a flat line has
//       tierFrom = null, tierTo = null and is the sole line).
//     - `computeTieredPrice(lines: readonly TieredPriceLine[], qty: Quantity): Money` — pure, no
//       I/O. A flat line: `total = Money.of(price).multiply(qty)`. A tiered ladder: walk tiers in
//       order; for each tier `[from, to)` (last tier's `to` may be null = unbounded), apply
//       `freeUnits` as a per-tier allowance subtracted from the billable quantity WITHIN that tier
//       only (never carried to another tier), clamped so a tier's billable quantity is never
//       negative. Sums `billableInTier × price` per tier — never the last tier's rate applied to
//       the whole quantity (INV-C1-3). ASSUMES the ladder already passed catalog module 1.2's
//       validateTierLadder (contiguous, no gap, no overlap, no inverted/zero-width tier) — does NOT
//       re-validate contiguity; a malformed ladder (should not exist, since 1.2 validates on write)
//       throws `MalformedTierLadderError` (./errors.js), never a silent miscalculation. This test's
//       own malformed-ladder checks below use ARBITRARY malformed shapes (duplicate tierFrom, a gap,
//       a flat+tiered mix, an inverted tier, a zero-width tier) since the exact detection rule is
//       production's to design — only the throw + error class is asserted here, never the message
//       text.
//
// Anti-vacuous-test rule (same finding pg-reviewer raised on WBS 1.2's tier-ladder property test,
// and repeated on this slice's own fix round 1, finding 9): the reference calculation below is
// INDEPENDENTLY written — a different structure/order than decision 4's own phrasing (it computes
// `clamp(qty, from, to) - from` THEN subtracts freeUnits as a separate step, rather than the single
// combined expression decision 4 spells out) — and never imports or calls
// computeTieredPrice/anything from tiered-pricing.ts. It ALSO never calls `Number()` on a
// numeric(14,3) value: every price/qty/tier-boundary/free_units value is generated DIRECTLY as a
// scaled bigint (thousandths — "milli-units" below) and the reference walk does every arithmetic
// step (clamp, subtract, multiply, round-half-up) in bigint, so fractional (.001-.999) fixtures
// never lose precision the way a float reference calc would. `Money.of`/`.equals()` (packages/
// domain-kit) IS reused only to construct/compare the FINAL total string — that is a trusted,
// separately-tested primitive, not the function under test, so reusing it does not make this
// vacuous; only the TIER-WALKING LOOP and its own round-half-up helper being independent matters.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Money, Quantity } from '@pg-eos/domain-kit';

// The module under test — does not exist yet (RED).
import { computeTieredPrice, type TieredPriceLine } from '../../domain/resolve-price/tiered-pricing.js';
import { MalformedTierLadderError } from '../../domain/resolve-price/errors.js';

const ZERO_FREE_UNITS = '0.000';
const MILLI_SCALE = 1000n; // numeric(14,3) — three fractional decimal digits, scaled to an integer bigint.

// --- milli-unit (scaled-bigint) helpers — the test's OWN decimal<->bigint conversion, independent
// of packages/domain-kit's private implementation (Money/Quantity are reused only as trusted,
// already-tested primitives for the FINAL comparison, per the anti-vacuous-test note above). ------

function milliToDecimal(milli: bigint): string {
  const negative = milli < 0n;
  const absolute = negative ? -milli : milli;
  const whole = absolute / MILLI_SCALE;
  const fraction = (absolute % MILLI_SCALE).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

function decimalToMilli(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');
  const paddedFraction = fractionPart.padEnd(3, '0').slice(0, 3);
  const milli = BigInt(wholePart) * MILLI_SCALE + BigInt(paddedFraction === '' ? '0' : paddedFraction);
  return negative ? -milli : milli;
}

/** Round-half-up on a numerator/denominator pair of non-negative-denominator bigints — the test's
 *  own helper (not imported from domain-kit), used only by referenceTotal below. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absoluteNumerator = negative ? -numerator : numerator;
  const quotient = absoluteNumerator / denominator;
  const remainder = absoluteNumerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** A valid, contiguous tiered ladder built directly from milli-unit (bigint) widths — every
 *  boundary is therefore an exact scaled integer, never a Number-derived approximation.
 *  `widthsMilli` (each >= 1n) are the tier sizes in thousandths; the last tier's tierTo is null.
 *  `freeUnitsPerTier`, when supplied, sets each tier's freeUnits (defaults to zero for every
 *  tier). */
function buildLadder(
  widthsMilli: readonly bigint[],
  prices: readonly string[],
  freeUnitsPerTier?: readonly string[],
): TieredPriceLine[] {
  const lines: TieredPriceLine[] = [];
  let cursor = 0n;
  for (const [index, widthMilli] of widthsMilli.entries()) {
    const from = cursor;
    const to = cursor + widthMilli;
    const isLast = index === widthsMilli.length - 1;
    lines.push({
      price: prices[index % prices.length] as string,
      tierFrom: milliToDecimal(from),
      tierTo: isLast ? null : milliToDecimal(to),
      freeUnits: freeUnitsPerTier?.[index] ?? ZERO_FREE_UNITS,
    });
    cursor = to;
  }
  return lines;
}

function buildFlatLine(price: string): TieredPriceLine {
  return { price, tierFrom: null, tierTo: null, freeUnits: ZERO_FREE_UNITS };
}

/** Independent reference calculation — see the anti-vacuous-test note above. Deliberately walks the
 *  ladder as "clamp the quantity into this tier's span, THEN subtract the free allowance", a
 *  different decomposition than decision 4's single combined expression, entirely in bigint
 *  milli-units (never Number()). */
function referenceTotal(lines: readonly TieredPriceLine[], qtyMilli: bigint): Money {
  let totalMilli = 0n;
  for (const line of lines) {
    const fromMilli = line.tierFrom === null ? 0n : decimalToMilli(line.tierFrom);
    const toMilliValue = line.tierTo === null ? null : decimalToMilli(line.tierTo);
    const freeMilli = decimalToMilli(line.freeUnits);

    const upperMilli = toMilliValue === null ? qtyMilli : qtyMilli < toMilliValue ? qtyMilli : toMilliValue;
    const clampedMilli = upperMilli < fromMilli ? fromMilli : upperMilli;
    const spanConsumedMilli = clampedMilli - fromMilli;
    const billableMilli = spanConsumedMilli - freeMilli;
    const billableMilliClamped = billableMilli < 0n ? 0n : billableMilli;

    if (billableMilliClamped > 0n) {
      const priceMilli = decimalToMilli(line.price);
      // Both operands are scale-1000 fixed-point; their raw product is scale-1,000,000 — divide
      // back down to scale-1000 (money) with round-half-up, the same convention numeric(14,3)
      // columns use.
      const productScale1e6 = billableMilliClamped * priceMilli;
      totalMilli += divRoundHalfUp(productScale1e6, MILLI_SCALE);
    }
  }
  return Money.of(milliToDecimal(totalMilli));
}

// --- generators — every value is a DIRECTLY-generated scaled bigint (milli-units), so fractional
// (.001-.999) prices/quantities/boundaries/free_units are exercised, not only whole numbers -------

const milliArb = (min: number, max: number) => fc.integer({ min, max }).map((n) => BigInt(n));

const priceArb = milliArb(0, 999_999).map(milliToDecimal); // 0.000 .. 999.999, thousandths included.
const widthMilliArb = milliArb(1, 50_000); // a tier's own width, 0.001 .. 50.000 units.
const widthsMilliArb = (minTiers: number, maxTiers: number) =>
  fc.array(widthMilliArb, { minLength: minTiers, maxLength: maxTiers });
const qtyMilliArb = milliArb(0, 500_000); // 0.000 .. 500.000 units.

// --- property (a): a valid contiguous ladder matches an independent reference calc ----------

describe('computeTieredPrice — property (a): matches an independent reference calc for any valid ladder', () => {
  it('a multi-tier ladder (1-8 tiers), any non-negative qty, any per-tier price (including fractional thousandths), zero free_units', () => {
    fc.assert(
      fc.property(
        widthsMilliArb(1, 8),
        fc.array(priceArb, { minLength: 1, maxLength: 8 }),
        qtyMilliArb,
        (widthsMilli, prices, qtyMilli) => {
          fc.pre(prices.length > 0);
          const lines = buildLadder(widthsMilli, prices);
          const qty = Quantity.of(milliToDecimal(qtyMilli));
          const expected = referenceTotal(lines, qtyMilli);
          expect(computeTieredPrice(lines, qty).equals(expected)).toBe(true);
        },
      ),
    );
  });

  it('a multi-tier ladder WITH fractional free_units per tier (bounded to at most the tier width) still matches', () => {
    fc.assert(
      fc.property(
        widthsMilliArb(1, 6),
        fc.array(priceArb, { minLength: 1, maxLength: 6 }),
        qtyMilliArb,
        fc.array(milliArb(0, 50_000), { minLength: 1, maxLength: 6 }),
        (widthsMilli, prices, qtyMilli, freeSeedsMilli) => {
          fc.pre(prices.length > 0);
          // Clamp each tier's free_units seed to that tier's own width so the ladder stays a
          // realistic fixture (a free_units value far beyond a tier's own width is exercised
          // separately by property (c) below).
          const freeUnitsPerTier = widthsMilli.map((widthMilli, index) => {
            const seedMilli = freeSeedsMilli[index % freeSeedsMilli.length] ?? 0n;
            const clampedMilli = seedMilli < widthMilli ? seedMilli : widthMilli;
            return milliToDecimal(clampedMilli);
          });
          const lines = buildLadder(widthsMilli, prices, freeUnitsPerTier);
          const qty = Quantity.of(milliToDecimal(qtyMilli));
          const expected = referenceTotal(lines, qtyMilli);
          expect(computeTieredPrice(lines, qty).equals(expected)).toBe(true);
        },
      ),
    );
  });
});

// --- property (b): a flat line always totals qty x price -------------------------------------

describe('computeTieredPrice — property (b): a flat line always totals qty × price', () => {
  it('for any price (including fractional thousandths) and any non-negative qty', () => {
    fc.assert(
      fc.property(priceArb, qtyMilliArb, (price, qtyMilli) => {
        const line = buildFlatLine(price);
        const qtyDecimal = milliToDecimal(qtyMilli);
        const qty = Quantity.of(qtyDecimal);
        const expected = Money.of(price).multiply(qtyDecimal);
        expect(computeTieredPrice([line], qty).equals(expected)).toBe(true);
      }),
    );
  });
});

// --- property (c): free_units never produces a negative billable-in-tier (clamped at zero) ---

describe('computeTieredPrice — property (c): free_units never produces a negative billable-in-tier', () => {
  it('the total is never negative, for any single-tier ladder and any free_units (including far beyond the tier width, and fractional)', () => {
    fc.assert(
      fc.property(priceArb, widthMilliArb, milliArb(0, 5_000_000), qtyMilliArb, (price, widthMilli, freeUnitsMilli, qtyMilli) => {
        const lines = buildLadder([widthMilli], [price], [milliToDecimal(freeUnitsMilli)]);
        const qty = Quantity.of(milliToDecimal(qtyMilli));
        expect(computeTieredPrice(lines, qty).isNegative()).toBe(false);
      }),
    );
  });

  it('free_units at or beyond the tier width yields EXACTLY zero for that tier (clamped, not negative-then-ignored)', () => {
    fc.assert(
      fc.property(priceArb, widthMilliArb, milliArb(0, 200_000), (price, widthMilli, overshootMilli) => {
        const freeUnitsMilli = widthMilli + overshootMilli; // always >= the tier's own width.
        const lines = buildLadder([widthMilli], [price], [milliToDecimal(freeUnitsMilli)]);
        // qty set to exactly the tier's own span so the whole tier is "in range".
        const qty = Quantity.of(milliToDecimal(widthMilli));
        expect(computeTieredPrice(lines, qty).isZero()).toBe(true);
      }),
    );
  });
});

// --- MalformedTierLadderError: a malformed ladder surfaces a typed error, never a silent miscalc --

describe('computeTieredPrice — a malformed ladder throws MalformedTierLadderError, never a silent miscalculation', () => {
  it('two lines sharing the same tierFrom (duplicate boundary) throws', () => {
    const lines: TieredPriceLine[] = [
      { price: '1.000', tierFrom: '0.000', tierTo: '50.000', freeUnits: ZERO_FREE_UNITS },
      { price: '2.000', tierFrom: '0.000', tierTo: '100.000', freeUnits: ZERO_FREE_UNITS },
    ];
    expect(() => computeTieredPrice(lines, Quantity.of('10.000'))).toThrow(MalformedTierLadderError);
  });

  it('a gap between two tiers throws', () => {
    const lines: TieredPriceLine[] = [
      { price: '1.000', tierFrom: '0.000', tierTo: '50.000', freeUnits: ZERO_FREE_UNITS },
      { price: '2.000', tierFrom: '60.000', tierTo: null, freeUnits: ZERO_FREE_UNITS }, // gap 50-60.
    ];
    expect(() => computeTieredPrice(lines, Quantity.of('70.000'))).toThrow(MalformedTierLadderError);
  });

  it('a flat line mixed with a tiered line throws', () => {
    const lines: TieredPriceLine[] = [
      { price: '1.000', tierFrom: null, tierTo: null, freeUnits: ZERO_FREE_UNITS },
      { price: '2.000', tierFrom: '0.000', tierTo: null, freeUnits: ZERO_FREE_UNITS },
    ];
    expect(() => computeTieredPrice(lines, Quantity.of('10.000'))).toThrow(MalformedTierLadderError);
  });

  // Fix round 1 (pg-reviewer finding 3) — an inverted tier (tierTo <= tierFrom) is invalid on its
  // own terms, independent of gap/overlap detection against its neighbour.
  it('an inverted tier (tierTo < tierFrom) throws — e.g. [0-50],[50-40],[40-null]', () => {
    const lines: TieredPriceLine[] = [
      { price: '1.000', tierFrom: '0.000', tierTo: '50.000', freeUnits: ZERO_FREE_UNITS },
      { price: '2.000', tierFrom: '50.000', tierTo: '40.000', freeUnits: ZERO_FREE_UNITS }, // inverted: tierTo < tierFrom.
      { price: '3.000', tierFrom: '40.000', tierTo: null, freeUnits: ZERO_FREE_UNITS },
    ];
    expect(() => computeTieredPrice(lines, Quantity.of('60.000'))).toThrow(MalformedTierLadderError);
  });

  // Fix round 1 (pg-reviewer finding 3) — a zero-width tier (tierTo === tierFrom) throws too: it is
  // neither a valid span nor the sentinel "both null" flat-line shape.
  it('a zero-width tier (tierTo === tierFrom) throws', () => {
    const lines: TieredPriceLine[] = [
      { price: '1.000', tierFrom: '0.000', tierTo: '50.000', freeUnits: ZERO_FREE_UNITS },
      { price: '2.000', tierFrom: '50.000', tierTo: '50.000', freeUnits: ZERO_FREE_UNITS }, // zero-width.
      { price: '3.000', tierFrom: '50.000', tierTo: null, freeUnits: ZERO_FREE_UNITS },
    ];
    expect(() => computeTieredPrice(lines, Quantity.of('60.000'))).toThrow(MalformedTierLadderError);
  });
});
