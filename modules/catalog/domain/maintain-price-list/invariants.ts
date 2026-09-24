// modules/catalog/domain/maintain-price-list/invariants.ts — WBS 1.2, M03 catalog.
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/maintain-price-list/*) calls these BEFORE any DB write; a failed invariant
// throws a typed error from ./errors.ts. pg-tester's property tests exercise these functions
// directly (invariants.property.test.ts).

import { createActor } from 'xstate';

import { Quantity } from '@pg-eos/domain-kit';

import { InvalidValidityError, PriceBelowFloorError, PriceListLockedError } from './errors.js';
import { PRICE_LIST_TAG_EDITABLE, priceListMachine, type PriceListStatus } from './machine.js';

/** assertPriceMeetsFloor does not know the service's code or a row index — the caller (the
 *  application layer) catches the bare error this throws and re-throws an enriched
 *  PriceBelowFloorError carrying `serviceCode` (and, for ImportPriceListLines, `rowIndex`). */
const UNKNOWN_SERVICE_CODE = '';

/** Master decision 4 (the acceptance criterion): throws PriceBelowFloorError iff
 *  `price < minPrice`; returns (no throw) iff `price >= minPrice` — the floor itself is
 *  acceptable. */
export function assertPriceMeetsFloor(price: Quantity, minPrice: Quantity): void {
  if (price.compare(minPrice) < 0) {
    throw new PriceBelowFloorError(
      `price ${price.toString()} is below the floor ${minPrice.toString()} (Master decision 4, ` +
        `the acceptance criterion "price below floor rejected").`,
      { serviceCode: UNKNOWN_SERVICE_CODE, price: price.toString(), minPrice: minPrice.toString() },
    );
  }
}

/** Master decision 3: throws PriceListLockedError iff `status` is not tagged
 *  PRICE_LIST_TAG_EDITABLE by the machine (./machine.ts — today only `draft` carries it) — lines
 *  are written only while the list is editable; an active/expired list is frozen. pg-reviewer fix
 *  round 1 (finding 6): the machine decides this via its own tag, never an if/switch on the
 *  status string (CLAUDE.md · AGENT CONSTRAINTS). */
export function assertListEditable(status: PriceListStatus): void {
  const snapshot = priceListMachine.resolveState({ value: status });
  const actor = createActor(priceListMachine, { snapshot });
  actor.start();
  const editable = actor.getSnapshot().hasTag(PRICE_LIST_TAG_EDITABLE);
  actor.stop();

  if (!editable) {
    throw new PriceListLockedError(
      `catalog.price_lists: lines may be written only while the list's status carries the ` +
        `"${PRICE_LIST_TAG_EDITABLE}" tag; this list's status is "${status}" (Master decision 3 ` +
        '— an active list is frozen).',
    );
  }
}

export interface ValidityInput {
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly reviewAt?: string | null;
}

/** Master decisions 6/9 combined: throws InvalidValidityError iff `validTo !== null && validTo <
 *  validFrom`, OR `reviewAt` is present (not null/undefined) and `reviewAt < validFrom`. Compares
 *  ISO date strings ('YYYY-MM-DD') lexicographically — valid for that format, no Date parsing
 *  needed (CLAUDE.md: no `new Date()` in domain/). */
export function assertValidValidity(input: ValidityInput): void {
  if (input.validTo !== null && input.validTo < input.validFrom) {
    throw new InvalidValidityError(
      `validTo (${input.validTo}) is before validFrom (${input.validFrom}) (Master decision 6).`,
    );
  }
  if (input.reviewAt !== null && input.reviewAt !== undefined && input.reviewAt < input.validFrom) {
    throw new InvalidValidityError(
      `reviewAt (${input.reviewAt}) is before validFrom (${input.validFrom}) (Master decision 9).`,
    );
  }
}
