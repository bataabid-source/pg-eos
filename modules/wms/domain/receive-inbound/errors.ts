// modules/wms/domain/receive-inbound/errors.ts — WBS 2.9, THE GOLDEN SLICE.
//
// Typed errors for the receive-inbound use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS; same discipline as ../../src/stock-ledger/errors.ts) — an `Error` subclass
// does NOT get its constructor name for free at runtime. The api/ layer
// (../../api/receive-inbound/*) maps these to the Problem envelope via PROBLEM_STATUS:
// StaleVersionError -> 409, IllegalTransitionError -> 422, everything else -> 400/422 per that
// layer's own map.

/** Optimistic-lock conflict: `UPDATE ... WHERE id=$1 AND version=$2` matched zero rows — another
 *  caller already advanced the order's version. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The inbound-order state machine (./machine.ts) rejected the requested event from the order's
 *  current status. Maps to HTTP 422. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** The caller does not hold the role a command requires (checked via `platform.my_roles()` inside
 *  the transaction — read, never guessed). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** INV-C3-3: the order line's SKU is owned by a different client than the order itself. */
export class SkuClientMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkuClientMismatchError';
  }
}

/** INV-C3-5: qty_actual differs from qty_ordered and no varianceReason was supplied. Thrown
 *  before any DB write — never relies on the DB CHECK `variance_needs_reason`'s own error. */
export class VarianceReasonRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VarianceReasonRequiredError';
  }
}

/** CloseInbound was called while at least one wms.order_lines row for the order is not
 *  status='complete'/'cancelled', or its location_id is still null. */
export class CloseBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloseBlockedError';
  }
}

/** CancelInbound's own business rule refused it because at least one line already has
 *  qty_actual > 0 (stock has physically moved) — SCR-WMS-INB-01 §1/§3. An illegal status (the
 *  machine allows CANCEL only from 'draft', 'approved' or 'received') is a separate
 *  IllegalTransitionError, checked first (see ./cancel-inbound.ts). */
export class CancelBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelBlockedError';
  }
}


/** No order row is visible for this id — it does not exist, or RLS hides it from the caller (an
 *  order outside the caller's entities is indistinguishable from a missing one, by design).
 *  Maps to 422 like LineNotFoundError (the Problem envelope has no 404). */
export class OrderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFoundError';
  }
}

/** no wms.order_lines row matches (lineId, orderId, order_table) — the line does not belong
 *  to the order the caller named. Maps to 404 (or 422, if the Problem envelope has no 404 status
 *  — see api/receive-inbound/handlers.ts's own mapping comment). */
export class LineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineNotFoundError';
  }
}

/** ReceiveLine's re-entry guard — `UPDATE ... WHERE qty_actual IS NULL` matched zero rows,
 *  meaning this line was already receipted by an earlier call. Raised BEFORE any ledger post. */
export class LineAlreadyReceivedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineAlreadyReceivedError';
  }
}

/** ConfirmPutaway's re-entry guard — `UPDATE ... WHERE status <> 'complete' AND location_id
 *  IS NULL` matched zero rows, meaning this line was already put away. Raised BEFORE any ledger
 *  post. */
export class LineAlreadyPutAwayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineAlreadyPutAwayError';
  }
}

/** ConfirmPutaway found no positive wms.stock_balance row for this line's client/sku/batch in any
 *  of the warehouse's RCV locations — ReceiveLine must post a receipt (with qty_actual > 0) first.
 *  A qty_actual = 0 line never reaches this: it is skipped from put-away entirely. */
export class RcvBalanceMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RcvBalanceMissingError';
  }
}

/** ReceiveLine was supplied variancePhotoUrl/variancePhotoSha256 for a receipt that is NOT a
 *  variance (qty_actual === qty_ordered) — a photo is meaningful only alongside a variance
 *  (SCR-WMS-INB-01 §4). Maps to HTTP 422. */
export class VariancePhotoWithoutVarianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VariancePhotoWithoutVarianceError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to stock_movements.performed_by / documents.generated_by / audit
 *  user_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}
