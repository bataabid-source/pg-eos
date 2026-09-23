// modules/wms/src/stock-ledger/errors.ts — WBS 2.8 (pg-backend).
//
// Typed errors for the stock-ledger mechanism (brief "Public surface" block). Every class sets
// `name` explicitly (CLAUDE.md · AGENT CONSTRAINTS, brief implementation notes: "typed classes
// with name set") — an `Error` subclass does NOT get its constructor name for free at runtime.

/** decision 1: an entry with both/neither of fromLocationId, toLocationId set, or a movementType
 *  outside MOVEMENT_TYPES (13B chk_stock_movements_type (§13B-24)). Thrown by validateEntry before any DB call. */
export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

/** decision 4: qty <= 0 (01 wms.stock_movements constraint qty_not_zero, plus decision 1's qty > 0).
 *  Thrown by validateEntry before any DB call — never a racy pre-check against the ledger. */
export class InvalidQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQuantityError';
  }
}

/** decision 3: 01 wms.stock_balance constraint no_negative_stock rejected the posting. The
 *  transaction that raised it is rolled back by withContext before this is thrown, so no ledger
 *  row, outbox row or audit row survives for the attempt. */
export class NegativeStockError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'NegativeStockError';
  }
}

/** decision 5: reverseMovement was asked to reverse an id with no wms.stock_movements row. */
export class MovementNotFoundError extends Error {
  constructor(movementId: string) {
    super(`no wms.stock_movements row with id ${movementId}`);
    this.name = 'MovementNotFoundError';
  }
}
