// modules/wms/domain/receive-inbound/invariants.ts — WBS 2.9, THE GOLDEN SLICE.
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/receive-inbound/receive-line.ts) calls these BEFORE any DB write; a failed
// invariant throws a typed error from ./errors.ts. pg-tester adds property tests against these
// functions directly.

import { Quantity } from '@pg-eos/domain-kit';

import { SkuClientMismatchError, VarianceReasonRequiredError, VariancePhotoWithoutVarianceError } from './errors.js';

/** INV-C3-3: the order line's SKU must be owned by the SAME client as the order itself. */
export function assertSkuBelongsToOrderClient(skuClientId: string, orderClientId: string): void {
  if (skuClientId !== orderClientId) {
    throw new SkuClientMismatchError(
      `order line's SKU belongs to client ${skuClientId}, but the order belongs to client ` +
        `${orderClientId} (INV-C3-3). (Allowed: a SKU owned by the order's own client)`,
    );
  }
}

/** a fully-short receipt (qtyActual = 0) is itself a variance and needs a reason like any
 *  other — this function does not special-case it; the SPECIAL handling (no ledger row, put-away
 *  skipped, counts as complete for Close with location_id null) lives in
 *  ../../application/receive-inbound/receive-line.ts and close-inbound.ts, driven by
 *  isFullyShortReceipt below. */
export function isVarianceReceipt(qtyActual: Quantity, qtyOrdered: Quantity): boolean {
  return !qtyActual.equals(qtyOrdered);
}

/** INV-C3-5: a variance (qty_actual != qty_ordered, INCLUDING qty_actual = 0) requires a
 *  varianceReason, checked BEFORE any DB write — never relies on the DB CHECK
 *  `variance_needs_reason`'s own error. */
export function assertVarianceHasReason(
  qtyActual: Quantity,
  qtyOrdered: Quantity,
  varianceReason: string | null | undefined,
): void {
  if (isVarianceReceipt(qtyActual, qtyOrdered) && !varianceReason) {
    throw new VarianceReasonRequiredError(
      `qty_actual (${qtyActual.toString()}) differs from qty_ordered (${qtyOrdered.toString()}) ` +
        `but no varianceReason was supplied (INV-C3-5). (Allowed: a varianceReason string)`,
    );
  }
}

/** A variance photo (variancePhotoUrl/variancePhotoSha256, both or neither per the contract) is
 *  allowed ONLY on a variance receipt (SCR-WMS-INB-01 §4) — otherwise
 *  VariancePhotoWithoutVarianceError, thrown BEFORE any DB write, same discipline as
 *  assertVarianceHasReason above. */
export function assertVariancePhotoRequiresVariance(
  qtyActual: Quantity,
  qtyOrdered: Quantity,
  hasVariancePhoto: boolean,
): void {
  if (hasVariancePhoto && !isVarianceReceipt(qtyActual, qtyOrdered)) {
    throw new VariancePhotoWithoutVarianceError(
      `a variance photo was supplied but qty_actual (${qtyActual.toString()}) equals qty_ordered ` +
        `(${qtyOrdered.toString()}) — no variance occurred. (Allowed: a photo only on a variance receipt)`,
    );
  }
}

/** true iff this receipt is fully short (nothing physically arrived). Such a line posts NO
 *  ledger row and is skipped from put-away entirely — it counts as 'complete' for CloseInbound's
 *  own gate even with location_id still null, ONLY in this one case. */
export function isFullyShortReceipt(qtyActual: Quantity): boolean {
  return qtyActual.isZero();
}

/** SCR-WMS-INB-01 §6: true iff EVERY line of the order has qty_actual = 0 — called only once the
 *  order's last line has just been receipted (every qty_actual is therefore non-null). The
 *  application layer (../../application/receive-inbound/receive-line.ts) uses this to skip the
 *  GRN document and the 'wms.inbound.received' outbox event for such an order. */
export function isAllZeroOrder(lineQtyActuals: readonly string[]): boolean {
  return lineQtyActuals.every((qty) => Quantity.of(qty).isZero());
}
