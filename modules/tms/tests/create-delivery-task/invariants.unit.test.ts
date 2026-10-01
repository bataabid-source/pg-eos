// modules/tms/tests/create-delivery-task/invariants.unit.test.ts — WBS 3.4 part 1.
//
// Domain unit tests (D-208: INV-C4-2 is not a stock/money/security invariant, so an ordinary unit
// test, not fast-check). Sources: doc 40 line 274 (INV-C4-2, "Task creation rejected without area,
// block, street, phone"); doc 03 line 132; brief Decision 4 (missing OR whitespace-only
// area/block/street/phone -> typed error (i18nKey pinned in ./errors.unit.test.ts); order status
// must be one of checked · packed · loaded, else `tms.task.create.orderNotReady`).
//
// Expected surface — modules/tms/domain/create-delivery-task/invariants.ts:
//   assertAddressComplete(input: { area: string; block: string; street: string; recipientPhone: string }): void
//   assertOrderReadyForTask(orderStatus: string): void

import { describe, expect, it } from 'vitest';

/** The error `fn` throws (undefined when it does not throw) — asserted with toBeInstanceOf, which
 *  fails loudly when the error class itself is missing (toThrow(undefined) would pass on any throw). */
function thrownBy(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

import { AddressIncompleteError, OrderNotReadyError } from '../../domain/create-delivery-task/errors.js';
import { assertAddressComplete, assertOrderReadyForTask } from '../../domain/create-delivery-task/invariants.js';

const COMPLETE = { area: 'Salmiya', block: '5', street: 'Salem Al-Mubarak', recipientPhone: '+96550000000' } as const;
const REQUIRED_FIELDS = ['area', 'block', 'street', 'recipientPhone'] as const;
const BLANK_VALUES = ['', ' ', '   ', '\t', '\n', ' \t\n '] as const;

describe('INV-C4-2 assertAddressComplete', () => {
  it('a complete address passes', () => {
    expect(() => assertAddressComplete(COMPLETE)).not.toThrow();
  });

  for (const field of REQUIRED_FIELDS) {
    it.each(BLANK_VALUES)(`${field} = %j is refused with AddressIncompleteError`, (blank) => {
      expect(thrownBy(() => assertAddressComplete({ ...COMPLETE, [field]: blank }))).toBeInstanceOf(AddressIncompleteError);
    });
  }

  it('several missing fields at once are still one AddressIncompleteError', () => {
    expect(thrownBy(() => assertAddressComplete({ area: '', block: ' ', street: '', recipientPhone: '' }))).toBeInstanceOf(
      AddressIncompleteError,
    );
  });
});

// wms.outbound_orders.status list, 13B-Schema-Reference-Consolidation.sql:2327 (chk on wms.outbound_orders.status); the allowed set is brief Decision 4.
const READY_STATUSES = ['checked', 'packed', 'loaded'] as const;
const NOT_READY_STATUSES = [
  'draft',
  'checks_pending',
  'credit_rejected',
  'approved',
  'allocated',
  'partially_allocated',
  'picking',
  'picked',
  'dispatched',
  'delivered',
  'cancelled',
] as const;

describe('assertOrderReadyForTask (order status in checked | packed | loaded)', () => {
  it.each(READY_STATUSES)('%s passes', (status) => {
    expect(() => assertOrderReadyForTask(status)).not.toThrow();
  });

  it.each(NOT_READY_STATUSES)('%s is refused with OrderNotReadyError', (status) => {
    expect(thrownBy(() => assertOrderReadyForTask(status))).toBeInstanceOf(OrderNotReadyError);
  });
});
