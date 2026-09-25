// modules/wms/domain/manage-space/invariants.ts — WBS 2.15 (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date.now(), no Math.random(). The application
// layer (../../application/manage-space/{allocate-space,reserve-space}.ts) calls these BEFORE any
// DB write; a failed invariant throws a typed error from ./errors.ts. pg-tester's property tests
// (../../tests/manage-space/invariants.property.test.ts, P1/P2) exercise these functions directly.

/** P2/D7: true iff `qty > 0`. `wms.space_reservations.qty` has no DB-level positive-qty CHECK
 *  (unlike `space_allocations.qty`'s `positive_qty` constraint) — this function is the ONLY
 *  enforcement for ReserveSpace, not redundant belt-and-braces. */
export function isPositiveQty(qty: number): boolean {
  return qty > 0;
}

/** The scale of `wms.space_allocations.qty` and `wms.space_reservations.qty`, both `numeric(14,3)`
 *  (13B). A schema fact, not a business threshold — mirrored here so the domain can reject a qty
 *  the column would silently round. */
export const QTY_DB_SCALE = 3;
const QTY_SCALE_FACTOR = 10 ** QTY_DB_SCALE;

/** Round-4 review finding: true iff `qty` is finite and survives rounding to QTY_DB_SCALE decimals
 *  unchanged — i.e. the value the `numeric(14,3)` column stores is exactly the value the caller
 *  asked for. Without it `0.0004` passes isPositiveQty yet is stored as `0.000` (for ReserveSpace,
 *  D7: an `active` zero-qty reservation, nothing else catches it). Kept separate from isPositiveQty
 *  so P2 (`isPositiveQty(qty) ⇔ qty > 0`) stays exact; callers apply both, BEFORE any DB write. */
export function hasValidQtyScale(qty: number): boolean {
  return Number.isFinite(qty) && Math.round(qty * QTY_SCALE_FACTOR) / QTY_SCALE_FACTOR === qty;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** P1/D4: true iff `(expiresAt - reservedFrom) <= maxDays`, inclusive at the boundary. Both dates
 *  are ISO date strings ('YYYY-MM-DD', same shape as the contract's `z.iso.date()`) — ALWAYS
 *  caller-supplied arguments, never read from the system clock inside this function (CLAUDE.md ·
 *  AGENT CONSTRAINTS: no `new Date()` in domain/ driving the computation's own "now"). */
export function isWithinMaxDuration(reservedFrom: string, expiresAt: string, maxDays: number): boolean {
  const from = new Date(`${reservedFrom}T00:00:00.000Z`).getTime();
  const to = new Date(`${expiresAt}T00:00:00.000Z`).getTime();
  const durationDays = Math.round((to - from) / MS_PER_DAY);
  return durationDays <= maxDays;
}

/** D4/round-1 review finding 3 · round-2 review finding 1: true iff `expiresAt` is strictly after
 *  `reservedFrom` (mirrors the DB's own `reservation_has_expiry` CHECK). Both dates are ISO date
 *  strings ('YYYY-MM-DD', same shape as the contract's `z.iso.date()`) — a plain string comparison
 *  is safe and equivalent to a date comparison for this fixed-width ISO shape, same discipline as
 *  ../../../hr/domain/maintain-shift/invariants.ts's own string-range checks. This is the ONLY
 *  place the reservation date-range rule is expressed — the application layer (../../application/
 *  manage-space/reserve-space.ts) calls this instead of an inline comparison. */
export function isValidReservationRange(reservedFrom: string, expiresAt: string): boolean {
  return expiresAt > reservedFrom;
}
