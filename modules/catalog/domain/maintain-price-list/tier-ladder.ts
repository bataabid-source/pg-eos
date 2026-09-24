// modules/catalog/domain/maintain-price-list/tier-ladder.ts — WBS 1.2, M03 catalog.
//
// domain/ layer: pure validation of INV-C1-3 (progressive tiered pricing) — no I/O, no Date, no
// Math.random(). Called by the application layer BEFORE any write, on every UpsertPriceListLine/
// ImportPriceListLines call (against the touched service's existing + new lines) and again at
// ActivatePriceList (over the whole list) — slice brief Master decision 5.

import { Quantity } from '@pg-eos/domain-kit';

import { TierLadderError } from './errors.js';

export interface TierLadderLine {
  readonly serviceId: string;
  readonly tierFrom: string | null;
  readonly tierTo: string | null;
  readonly freeUnits: string;
}

function isFlatLine(line: TierLadderLine): boolean {
  return line.tierFrom === null && line.tierTo === null;
}

function hasTierFrom(line: TierLadderLine): line is TierLadderLine & { readonly tierFrom: string } {
  return line.tierFrom !== null;
}

/** Validates one service's own group of lines: either exactly ONE flat line (tierFrom/tierTo both
 *  null), or an ordered ladder where the first tier starts at 0, each next tier's tierFrom equals
 *  the previous tier's tierTo (no gap, no overlap), and only the LAST tierTo may be null. */
function validateGroup(serviceId: string, group: readonly TierLadderLine[]): void {
  const flatLines = group.filter(isFlatLine);

  if (group.length === 1 && flatLines.length === 1) {
    return; // the group's only line, flat — valid (Master decision 5).
  }

  if (flatLines.length > 0) {
    throw new TierLadderError(
      `service ${serviceId}: a flat line (tierFrom/tierTo both null) is legal only as the sole ` +
        `line for a service — found ${flatLines.length} flat line(s) among ${group.length} total ` +
        `(INV-C1-3, no flat+tier mix).`,
    );
  }

  const tiered = group.filter(hasTierFrom);
  if (tiered.length !== group.length) {
    throw new TierLadderError(
      `service ${serviceId}: every tiered line must have a non-null tierFrom (INV-C1-3).`,
    );
  }

  // pg-reviewer fix round 1 (finding 2): reject a duplicate tierFrom within one service's group
  // BEFORE any gap/overlap check — two tiers claiming the same starting point is never a valid
  // ladder, and (for ImportPriceListLines) this catches a duplicate (serviceCode, tierFrom) pair
  // in one payload before any write, so lineCount can never over-count.
  const seenTierFrom = new Set<string>();
  for (const line of tiered) {
    const key = Quantity.of(line.tierFrom).toString();
    if (seenTierFrom.has(key)) {
      throw new TierLadderError(
        `service ${serviceId}: duplicate tierFrom ${line.tierFrom} within one service's lines ` +
          `(INV-C1-3).`,
      );
    }
    seenTierFrom.add(key);
  }

  // pg-reviewer fix round 1 (finding 2): every tier's own range must be non-inverted — tierTo is
  // either null (only legal on the last tier, checked below) or strictly greater than tierFrom.
  for (const line of tiered) {
    if (line.tierTo !== null && !(Quantity.of(line.tierTo).compare(Quantity.of(line.tierFrom)) > 0)) {
      throw new TierLadderError(
        `service ${serviceId}: tier starting at ${line.tierFrom} has tierTo ${line.tierTo}, which ` +
          `is not strictly greater than tierFrom (INV-C1-3: an inverted tier is never valid).`,
      );
    }
  }

  const sorted = [...tiered].sort((a, b) => Quantity.of(a.tierFrom).compare(Quantity.of(b.tierFrom)));

  const first = sorted[0];
  if (first === undefined || !Quantity.of(first.tierFrom).isZero()) {
    throw new TierLadderError(
      `service ${serviceId}: the first tier must start at 0 (INV-C1-3); got ` +
        `${first?.tierFrom ?? 'no lines'}.`,
    );
  }

  for (let index = 0; index < sorted.length; index += 1) {
    const line = sorted[index];
    if (line === undefined) continue;
    const isLast = index === sorted.length - 1;
    if (isLast) continue;

    if (line.tierTo === null) {
      throw new TierLadderError(
        `service ${serviceId}: only the LAST tier may have a null tierTo (INV-C1-3); tier ` +
          `${index} (tierFrom ${line.tierFrom}) does not.`,
      );
    }

    const next = sorted[index + 1];
    if (next === undefined) continue;
    if (!Quantity.of(line.tierTo).equals(Quantity.of(next.tierFrom))) {
      throw new TierLadderError(
        `service ${serviceId}: tier ${index} ends at ${line.tierTo} but the next tier starts at ` +
          `${next.tierFrom} (INV-C1-3: no gap, no overlap).`,
      );
    }
  }
}

/** Groups `lines` by `serviceId` and validates EACH group independently — a violation in one
 *  service's group does not affect another service's group. `freeUnits` must be >= 0 for every
 *  line, checked across all lines first. Throws TierLadderError on the first violation found;
 *  returns (no throw) when every group is valid. */
export function validateTierLadder(lines: readonly TierLadderLine[]): void {
  for (const line of lines) {
    if (Quantity.of(line.freeUnits).isNegative()) {
      throw new TierLadderError(
        `service ${line.serviceId}: freeUnits must be >= 0 (INV-C1-3); got ${line.freeUnits}.`,
      );
    }
  }

  const byService = new Map<string, TierLadderLine[]>();
  for (const line of lines) {
    const group = byService.get(line.serviceId);
    if (group) {
      group.push(line);
    } else {
      byService.set(line.serviceId, [line]);
    }
  }

  for (const [serviceId, group] of byService) {
    validateGroup(serviceId, group);
  }
}
