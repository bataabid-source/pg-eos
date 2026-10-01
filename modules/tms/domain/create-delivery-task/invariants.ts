// modules/tms/domain/create-delivery-task/invariants.ts — WBS 3.4 part 1.
//
// Pure domain rules of create-delivery-task (no I/O, no clock):
//   - INV-C4-2 (doc 40 line 274, verbatim): "Task creation rejected without area, block, street,
//     phone" — missing OR whitespace-only is refused (brief Decision 4); never derived from the
//     order's ship_to_* columns.
//   - the outbound order must be checked · packed · loaded (brief Decision 4; doc 40 lines 444-446
//     "after checked ... the delivery task is created").

import { AddressIncompleteError, OrderNotReadyError } from './errors.js';

/** wms.outbound_orders.status values a delivery task may follow (brief Decision 4). */
export const TASK_READY_ORDER_STATUSES: readonly string[] = ['checked', 'packed', 'loaded'];

export interface TaskAddressFields {
  readonly area: string;
  readonly block: string;
  readonly street: string;
  readonly recipientPhone: string;
}

const REQUIRED_ADDRESS_FIELDS: ReadonlyArray<keyof TaskAddressFields> = ['area', 'block', 'street', 'recipientPhone'];

/** INV-C4-2: throws AddressIncompleteError naming every blank field; one error for any number of
 *  blank fields. */
export function assertAddressComplete(input: TaskAddressFields): void {
  const blank = REQUIRED_ADDRESS_FIELDS.filter((field) => input[field].trim().length === 0);
  if (blank.length > 0) {
    throw new AddressIncompleteError(
      `INV-C4-2: a delivery task requires area, block, street and recipient phone; blank: ${blank.join(', ')}.`,
    );
  }
}

/** Throws OrderNotReadyError unless `orderStatus` is one of TASK_READY_ORDER_STATUSES. */
export function assertOrderReadyForTask(orderStatus: string): void {
  if (!TASK_READY_ORDER_STATUSES.includes(orderStatus)) {
    throw new OrderNotReadyError(
      `outbound order status ${JSON.stringify(orderStatus)} does not allow a delivery task ` +
        `(allowed: ${TASK_READY_ORDER_STATUSES.join(', ')}).`,
    );
  }
}
