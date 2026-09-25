// modules/wms/domain/count-inventory/errors.ts — WBS 2.13 (lane 2).
//
// Typed errors for the count-inventory use case (INV-C3-7). Every class sets `name` explicitly
// (CLAUDE.md · AGENT CONSTRAINTS; same discipline as ../receive-inbound/errors.ts) — an `Error`
// subclass does NOT get its constructor name for free at runtime. The api/ layer
// (../../api/count-inventory/handlers.ts) maps these to the Problem envelope.

/** Optimistic-lock conflict on `wms.inventory_counts` — `expectedVersion` no longer matches the
 *  locked row's own version. Thrown by AdjustCount only (D3: of the four commands, only
 *  AdjustCount takes a caller-supplied `expectedVersion`; StartCount inserts a fresh row with no
 *  prior version to have read, and CountLocation/Recount are guarded by the line's own state under
 *  a lock on the parent count row instead). Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The inventory-count state machine (./machine.ts) rejected the requested event from the count's
 *  current status, or a command was called while the count is in a status it does not support
 *  (e.g. CountLocation while not 'in_progress'). Maps to HTTP 422. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** The caller does not hold a role a command requires (checked via `platform.my_roles()` inside
 *  the transaction — read, never guessed). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** INV-C3-7's blind-count re-entry guard: CountLocation was called on a line whose qty_counted is
 *  already set. */
export class AlreadyCountedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyCountedError';
  }
}

/** INV-C3-7's mandatory-recount guard: Recount was called on a line that either has no variance
 *  (qty_counted equals qty_system) or already has a recount_qty set. */
export class NotFlaggedForRecountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFlaggedForRecountError';
  }
}

/** brief D6: `count_type` other than 'full' requires BOTH `locationIds` and `skuIds` — thrown
 *  before any DB write when only one (or neither) is supplied. */
export class CountFilterRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountFilterRequiredError';
  }
}

/** No `wms.warehouses` row is visible for this id — it does not exist, or RLS hides it from the
 *  caller. Maps to 422 like every other "not found" here (the Problem envelope has no 404). */
export class WarehouseNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarehouseNotFoundError';
  }
}

/** No `wms.inventory_counts` row is visible for this id. */
export class CountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountNotFoundError';
  }
}

/** No `wms.inventory_count_lines` row matches (lineId[, countId]) — the line does not exist, or
 *  does not belong to the count the caller (implicitly) named. */
export class LineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineNotFoundError';
  }
}

/** No `wms.skus` row is visible for a count line's own `sku_id` — defensive, should be
 *  unreachable (a line's sku_id is a FK to wms.skus). A typed error, never a plain `Error`
 *  reaching the api/ layer as an unmapped 500 (finding 13). Maps to HTTP 422. */
export class SkuNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkuNotFoundError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to stock_movements.performed_by / audit user_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** doc 40 INV-C3-7's "recount mandatory on variance" guard, enforced at AdjustCount: thrown when
 *  ANY variant line (hasVariance(qty_counted, qty_system) true, ../invariants.ts) still has
 *  `recount_qty IS NULL` — i.e. it was never recounted. Thrown BEFORE any adjustment is posted for
 *  the count. Maps to HTTP 422. */
export class RecountRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecountRequiredError';
  }
}

/** AdjustCount looks up the uom of the most recent `wms.stock_movements` row for the line's own
 *  (client, sku, location, batch) — a `wms.stock_balance` row cannot exist without at least one
 *  prior movement (G1), so this should be unreachable in practice; it exists so a broken invariant
 *  never silently defaults to a fabricated uom. Maps to HTTP 422. */
export class MovementUomNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementUomNotFoundError';
  }
}

/** The reused ledger port (postMovementInTx, via
 *  ../../infrastructure/count-inventory/ledger.ts) returned no movement id for a posting
 *  AdjustCount just made — defensive, should be unreachable (postMovementInTx always inserts
 *  exactly one wms.stock_movements row per call here). A typed error, never a plain `Error`
 *  reaching the api/ layer as an unmapped 500 (finding 13). Maps to HTTP 422. */
export class AdjustmentPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdjustmentPostingError';
  }
}
