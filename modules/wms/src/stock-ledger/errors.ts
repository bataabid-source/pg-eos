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
    super(
      `no wms.stock_movements row with id ${movementId} ` +
        `(Allowed: the id of an existing wms.stock_movements row)`,
    );
    this.name = 'MovementNotFoundError';
  }
}

/**
 * pg-reviewer gate finding 9 / doc 40 P4: rebuildBalance recomputes wms.stock_balance from the
 * FULL wms.stock_movements ledger for a (client, sku) pair. Under RLS, wms.stock_balance's policy
 * (internal_only) lets an internal caller see every balance row, but wms.stock_movements' policy
 * (entity_scope: `entity_id = any(platform.allowed_entities())`) restricts that same caller to only
 * the rows of the entities they belong to. A caller who cannot see every platform.entities row
 * would fold a PARTIAL ledger and overwrite balances built from the full one — corrupting them,
 * the opposite of doc 40 P4's "rebuildable with zero diff". Thrown before any read or write of the
 * ledger unless allowed = bypass OR (platform.is_internal() AND all_entities) — i.e. the caller's
 * role is superuser/BYPASSRLS, or the caller is internal (platform.is_internal()) AND
 * platform.allowed_entities() already covers every platform.entities row (pg-reviewer slice-close
 * round 2 finding 2: internal_only's own `wms.stock_balance` policy already requires
 * platform.is_internal() for the write this mechanism is about to make, so the scope check must
 * require it too, ahead of any read or write, rather than let a non-internal caller fail later on
 * that policy's own WITH CHECK).
 */
export class RebuildScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RebuildScopeError';
  }
}
