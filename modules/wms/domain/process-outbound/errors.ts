// modules/wms/domain/process-outbound/errors.ts — WBS 2.11 part 1, copied from the golden slice
// (../../domain/receive-inbound/errors.ts).
//
// Typed errors for the process-outbound use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS). The api/ layer (../../api/process-outbound/handlers.ts) maps these to the
// Problem envelope: StaleVersionError/IdempotencyConflictError -> 409, every other typed error
// below -> 422 (brief Master decision 8).
//
// Condition-check errors (RunOutboundChecks, brief D-blueprint 03 §4.2.1) each carry `.i18nKey`
// and `.params` — CLAUDE.md "No embedded UI strings — i18n": the message is a developer-facing
// default only, never the translated string shown to a user.

/** Optimistic-lock conflict: `UPDATE ... WHERE id=$1 AND version=$2` matched zero rows. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The outbound-order state machine (./machine.ts) rejected the requested event from the order's
 *  current status. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** The caller does not hold the role a command requires (checked via `platform.my_roles()`). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** No order row is visible for this id — it does not exist, or RLS hides it from the caller. */
export class OrderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFoundError';
  }
}

/** every command's actor is `ctx.userId` ONLY. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** CreateOutbound's qualified-account gate (brief Master decision 13): the client does not
 *  exist, is soft-deleted, or is not status='active'. */
export class ClientNotQualifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientNotQualifiedError';
  }
}

/** CancelOutbound was called with no reason (brief scenario "CancelOutbound without a reason is
 *  rejected"). */
export class CancelReasonRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelReasonRequiredError';
  }
}

/** A base class for a condition-check failure: carries the i18n key + params the api layer's
 *  Problem envelope surfaces alongside the developer-facing `message` (CLAUDE.md "No embedded UI
 *  strings — i18n"). */
export abstract class OutboundCheckError extends Error {
  abstract readonly i18nKey: string;
  readonly params: Readonly<Record<string, unknown>>;

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message);
    this.params = params;
  }
}

/** Condition 1: no active `sales.contracts` row resolves at all for (clientId, entityId) —
 *  missing, wrong client/entity, or status <> 'active'. Distinct from ContractExpiredError (an
 *  active contract whose end_date has passed) — this key carries no date param, fix round 1
 *  finding 5: a generic "no active contract" message, `wms.outbound.check.contractNotActive` is a
 *  NEW key this round, recorded for the i18n batch. */
export class ContractNotActiveError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.contractNotActive';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'ContractNotActiveError';
  }
}

/** Condition 1: the order's contract is active but `end_date` has passed. */
export class ContractExpiredError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.contractExpired';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'ContractExpiredError';
  }
}

/** Condition 2 (checked last — never thrown, the order transitions to 'credit_rejected'
 *  instead). Fix round 1 finding 9: constructed (not thrown) by
 *  ../../application/process-outbound/run-outbound-checks.ts to derive the `i18nKey`/`params`
 *  pair returned on the `credit_rejected` outcome — the same i18n-keyed shape every thrown
 *  OutboundCheckError carries, reused here as a plain data holder. */
export class CreditHoldError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.creditHold';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'CreditHoldError';
  }
}

/** Condition 3: the warehouse's available stock for a line's SKU is below the ordered quantity. */
export class InsufficientStockError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.insufficientStock';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'InsufficientStockError';
  }
}

/** Condition 4 (INV-C3-3 pattern): an order line's SKU is owned by a different client than the
 *  order itself. */
export class SkuClientMismatchError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.skuClientMismatch';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'SkuClientMismatchError';
  }
}

/** Precondition of condition 4 (escalated fix round, finding 11 — Master ruling b): the order
 *  line's `wms.skus` row does not resolve at all (absent, or hidden by RLS). Distinct from
 *  SkuClientMismatchError, which requires the row to exist and belong to another client. Params:
 *  `{ skuId }` — no SKU code is knowable when the row itself does not resolve. */
export class SkuNotFoundError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.skuNotFound';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'SkuNotFoundError';
  }
}

/** Condition 5: a candidate lot's remaining shelf life is below the SKU's own minimum issue
 *  days. */
export class ShelfLifeTooShortError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.shelfLifeTooShort';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'ShelfLifeTooShortError';
  }
}

/** Condition 6: the line's SKU status is not 'active'. */
export class SkuBlockedError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.skuBlocked';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'SkuBlockedError';
  }
}

/** Condition 7 (fix round 1 finding 7): the quantity available at NON-blocked locations holding
 *  stock of the line's SKU for this client, alone, is insufficient for the order — a blocked
 *  location's stock never counts, even when it would push the total (condition 3's own sum) over
 *  the ordered quantity. */
export class OutboundLocationBlockedError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.locationBlocked';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'OutboundLocationBlockedError';
  }
}

/** Condition 8: the order type implies delivery and a required ship-to field is missing. */
export class DeliveryAddressIncompleteError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.deliveryAddressIncomplete';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'DeliveryAddressIncompleteError';
  }
}

/** Condition 9: no active priced-list line (or price exception) exists for service OF-01 at
 *  this account/entity as-of today. */
export class NoServicePriceError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.noServicePrice';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'NoServicePriceError';
  }
}

/** Condition 10 (WBS 2.11 part 5, D-189, SCR-WMS-OUT-02 §6): the line's ordered quantity exceeds
 *  the per-contract, per-SKU `sales.contract_sku_limits.max_order_qty` cap. A missing limit row
 *  means no cap at all (never thrown in that case) — see
 *  ../../domain/process-outbound/invariants.ts's `assertOrderQuantityWithinLimit`. */
export class OrderQuantityExceededError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.orderQuantityExceeded';

  constructor(message: string, params: Readonly<Record<string, unknown>>) {
    super(message, params);
    this.name = 'OrderQuantityExceededError';
  }
}

/** WBS 2.11 part 2 fix round 1, finding 2: Allocate's `incrementLotAllocated` / CancelOutbound's
 *  `decrementLotAllocated` targeted one specific `wms.stock_balance` row (by client/sku/location/
 *  batch) — the row this same command already locked with `for update` a moment earlier — and the
 *  UPDATE matched zero rows. Should never happen inside the same transaction; thrown defensively
 *  rather than silently doing nothing (which would leave `qty_allocated` un-adjusted with no trace).
 *  Carries an i18n key + params like every OutboundCheckError subclass (CLAUDE.md "No embedded UI
 *  strings — i18n"); `wms.outbound.allocation.stockBalanceRowMissing` is a code-referenced key
 *  recorded for the i18n batch. */
export class StockBalanceRowMissingError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.allocation.stockBalanceRowMissing';

  constructor(
    message: string,
    params: {
      readonly clientId: string;
      readonly skuId: string;
      readonly locationId: string;
      readonly batchNo: string | null;
    },
  ) {
    super(message, params);
    this.name = 'StockBalanceRowMissingError';
  }
}

/** WBS 2.12 part 1 (_slice-2.12.brief.md, Master decision 2): PickLine's own shortage gate —
 *  `qty_actual < qty_ordered` with a blank/null `variance_reason` (reuses `wms.order_lines`' own
 *  `variance_needs_reason` check pattern, application-layer enforced BEFORE any write so the DB
 *  constraint itself is never relied on to reject). Params: `{ lineId, qtyOrdered, qtyActual }`. */
export class VarianceReasonRequiredError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.pick.varianceReasonRequired';

  constructor(
    message: string,
    params: { readonly lineId: string; readonly qtyOrdered: string; readonly qtyActual: string },
  ) {
    super(message, params);
    this.name = 'VarianceReasonRequiredError';
  }
}

/** WBS 2.12 part 1 (Master decision 3, doc 38 row 2.12's own literal acceptance line "Self-check
 *  rejected"), widened by part 3 (SCR-WMS-OUT-03, D-190 option a): CheckOrder's own mandatory
 *  invariant — the checker (`ctx.userId`) must not be `picked_by` of ANY line on the order, nor
 *  `performed_by` of any pick movement on the order (no longer a comparison to a single
 *  order-level `picked_by` column). Params: `{ orderId, actorId }` — `actorId` is the checker who
 *  was rejected. */
export class SelfCheckNotAllowedError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.check.selfCheckNotAllowed';

  constructor(message: string, params: { readonly orderId: string; readonly actorId: string }) {
    super(message, params);
    this.name = 'SelfCheckNotAllowedError';
  }
}

/** WBS 2.12 part 1, fix round 1 finding 7: `PickLine` was given a `lineId` that resolves to no
 *  `order_lines` row on the given order (does not exist, belongs to a different order, or RLS
 *  hides it) — a typed 422, not a bare `Error` surfacing as a 500. Params: `{ lineId, orderId }`. */
export class OrderLineNotFoundError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.pick.lineNotFound';

  constructor(message: string, params: { readonly lineId: string; readonly orderId: string }) {
    super(message, params);
    this.name = 'OrderLineNotFoundError';
  }
}

/** WBS 2.12 part 1, fix round 1 finding 2: the targeted line already carries a posted `pick`
 *  ledger row (or, for a zero-quantity pick that intentionally posts none, an already-recorded
 *  zero `qty_actual` — see ./invariants.ts's `assertLineNotAlreadyPicked` doc comment) — picking
 *  the same line twice is rejected before any write. Params: `{ lineId }`. */
export class LineAlreadyPickedError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.pick.lineAlreadyPicked';

  constructor(message: string, params: { readonly lineId: string }) {
    super(message, params);
    this.name = 'LineAlreadyPickedError';
  }
}

/** WBS 2.12 part 1, fix round 1 finding 3: `qtyActual` exceeds the line's own reserved quantity
 *  (`order_lines.qty_actual`, Allocate's own stamp) — an over-pick that would otherwise silently
 *  eat another order's `qty_allocated` (no DB floor on that column). Params:
 *  `{ lineId, reserved, qtyActual }`. */
export class PickQuantityExceedsReservedError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.pick.qtyExceedsReserved';

  constructor(message: string, params: { readonly lineId: string; readonly reserved: string; readonly qtyActual: string }) {
    super(message, params);
    this.name = 'PickQuantityExceedsReservedError';
  }
}

/** WBS 2.12 part 1, fix round 1 finding 6: a positive `qtyActual` was submitted for a line with no
 *  reservation (`location_id is null` — never allocated, e.g. the open remainder of a
 *  partially_allocated order). Params: `{ lineId, qtyActual }`. */
export class LineNotReservedForPickError extends OutboundCheckError {
  readonly i18nKey = 'wms.outbound.pick.lineNotReserved';

  constructor(message: string, params: { readonly lineId: string; readonly qtyActual: string }) {
    super(message, params);
    this.name = 'LineNotReservedForPickError';
  }
}
