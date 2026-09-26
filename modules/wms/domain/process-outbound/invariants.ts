// modules/wms/domain/process-outbound/invariants.ts — WBS 2.11 part 1, fix round 1 finding 11.
//
// domain/ layer: pure decision logic for RunOutboundChecks' ten conditions — no I/O, no Date, no
// Math.random() (CLAUDE.md · AGENT CONSTRAINTS). Given data the application layer
// (../../application/process-outbound/run-outbound-checks.ts) already fetched via
// ../../infrastructure/process-outbound/repository.ts, each function below decides pass/fail and
// throws the matching typed error from ./errors.ts with the right i18n params. The as-of date is
// ALWAYS a caller-supplied ISO string (`YYYY-MM-DD`) — never `new Date()` in here (CLAUDE.md, no
// exceptions). Direct precedent: ../receive-inbound/invariants.ts (the golden slice's own
// domain/-layer invariant functions).
//
// pg-tester adds property tests against these functions directly (fix round 1, findings routed to
// pg-tester: 11(property tests)).
//
// Quantities (escalated fix round, finding 7 — Master ruling: "Quantity from @pg-eos/domain-kit
// everywhere, never JS floats — a domain invariant"): every quantity input arrives as the
// numeric(14,3) text the repository selects (`::text`); every sum and every comparison below goes
// through `Quantity` (bigint scaled by 1000, no IEEE-754 drift) — never `Number()`. Precedent:
// ../receive-inbound/invariants.ts and ../count-inventory/invariants.ts.

import { Quantity } from '@pg-eos/domain-kit';

import {
  ContractExpiredError,
  ContractNotActiveError,
  DeliveryAddressIncompleteError,
  InsufficientStockError,
  LineAlreadyPickedError,
  LineNotReservedForPickError,
  OrderQuantityExceededError,
  OutboundLocationBlockedError,
  PickQuantityExceedsReservedError,
  SelfCheckNotAllowedError,
  ShelfLifeTooShortError,
  SkuBlockedError,
  SkuClientMismatchError,
  SkuNotFoundError,
  NoServicePriceError,
  VarianceReasonRequiredError,
} from './errors.js';

// --- condition 1: contract active --------------------------------------------------------------

export interface ContractForCheck {
  /** ISO date (`YYYY-MM-DD`) or null — never a Date instance (CLAUDE.md "no Date in domain/"). */
  readonly endDate: string | null;
}

/** Condition 1 (brief Master decision 3, fix round 1 finding 4): `contract` is the active
 *  `sales.contracts` row for (clientId, entityId) already resolved by the repository — `null`
 *  means no active contract row exists at all (ContractNotActiveError, no date param). A
 *  non-null contract whose `endDate` has passed `asOfDate` is ContractExpiredError instead
 *  (carries `expiryDate`). */
export function assertContractActive(
  contract: ContractForCheck | null,
  asOfDate: string,
  orderId: string,
): asserts contract is ContractForCheck {
  if (!contract) {
    throw new ContractNotActiveError(
      `RunOutboundChecks: order ${orderId} has no active sales.contracts row for its own ` +
        `client/entity. (Allowed: an existing active contract)`,
      {},
    );
  }
  if (contract.endDate !== null && contract.endDate < asOfDate) {
    throw new ContractExpiredError(
      `RunOutboundChecks: order ${orderId}'s contract expired on ${contract.endDate} — renewal ` +
        `required.`,
      { expiryDate: contract.endDate },
    );
  }
}

// --- condition 3: sufficient stock -------------------------------------------------------------

export interface StockSufficiencyCheck {
  readonly skuId: string;
  readonly skuCode: string;
  readonly availableSum: string;
  readonly ordered: string;
  readonly singleLocationCode: string | null;
}

/** Condition 3 (fix round 1 finding 6): total available stock across the warehouse, ALL locations
 *  including blocked ones (brief Master decision 3), must cover the ordered quantity. Compared as
 *  `Quantity` (exact decimal), never as JS numbers. */
export function assertSufficientStock(check: StockSufficiencyCheck): void {
  if (Quantity.of(check.availableSum).compare(Quantity.of(check.ordered)) < 0) {
    throw new InsufficientStockError(
      `RunOutboundChecks: only ${check.availableSum} of SKU ${check.skuCode} available, ` +
        `${check.ordered} ordered` +
        (check.singleLocationCode ? ` (location ${check.singleLocationCode})` : '') +
        '.',
      {
        skuId: check.skuId,
        skuCode: check.skuCode,
        available: check.availableSum,
        ordered: check.ordered,
        location: check.singleLocationCode,
      },
    );
  }
}

// --- condition 4: SKU belongs to the order's own client ----------------------------------------

/** Precondition of condition 4 (escalated fix round, finding 11 — Master ruling b): the line's
 *  `wms.skus` row must resolve at all (it may not exist, or RLS may hide it). A missing row is
 *  SkuNotFoundError carrying `{ skuId }` only — no SKU code can be known when the row does not
 *  resolve (`wms.order_lines` carries `sku_id` alone). SkuClientMismatchError is reserved for a row
 *  that exists and belongs to another client (assertSkuBelongsToOrderClient below). */
export function assertSkuResolved<T>(sku: T | null | undefined, skuId: string): asserts sku is T {
  if (sku === null || sku === undefined) {
    throw new SkuNotFoundError(
      `RunOutboundChecks: no visible wms.skus row for id ${skuId}.`,
      { skuId },
    );
  }
}

export interface SkuOwnershipCheck {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuClientId: string;
  readonly orderClientId: string;
}

/** Condition 4 (INV-C3-3 pattern, reused from 2.9's own check). */
export function assertSkuBelongsToOrderClient(check: SkuOwnershipCheck): void {
  if (check.skuClientId !== check.orderClientId) {
    throw new SkuClientMismatchError(
      `RunOutboundChecks: SKU ${check.skuCode} is registered to a different client than this ` +
        `order's own client.`,
      { skuId: check.skuId, skuCode: check.skuCode },
    );
  }
}

// --- condition 5: remaining shelf life ----------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Pure day-count between two ISO dates (`YYYY-MM-DD`) — never `new Date()` for "now" (the caller
 *  injects `asOfDate`; both arguments here are plain date-math inputs, not clock reads). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((new Date(toIso).getTime() - new Date(fromIso).getTime()) / MS_PER_DAY);
}

export interface ShelfLifeCandidateLot {
  readonly expiryDate: string | null;
  readonly batchNo: string;
}

/** Condition 5: for a line whose SKU tracks expiry, every candidate lot's remaining shelf life
 *  (in days, as of `asOfDate`) must be >= the SKU's own minimum. Fix round 1 finding 6: the error
 *  now names the failing lot's batch/lot number. */
export function assertShelfLifeSufficient(
  lots: readonly ShelfLifeCandidateLot[],
  asOfDate: string,
  minRemainingLifeIssueDays: number,
  skuCode: string,
): void {
  for (const lot of lots) {
    if (lot.expiryDate === null) continue;
    const remainingDays = daysBetween(asOfDate, lot.expiryDate);
    if (remainingDays < minRemainingLifeIssueDays) {
      throw new ShelfLifeTooShortError(
        `RunOutboundChecks: SKU ${skuCode}'s candidate lot ${lot.batchNo} has ${remainingDays} ` +
          `day(s) of shelf life remaining, below the minimum of ${minRemainingLifeIssueDays}.`,
        { skuCode, batchNo: lot.batchNo, remainingDays, minRemainingLifeIssueDays },
      );
    }
  }
}

// --- condition 6: SKU not blocked ---------------------------------------------------------------

const SKU_STATUS_ACTIVE = 'active';

export interface SkuBlockedCheck {
  readonly skuId: string;
  readonly skuCode: string;
  readonly status: string;
}

/** Condition 6. */
export function assertSkuNotBlocked(check: SkuBlockedCheck): void {
  if (check.status !== SKU_STATUS_ACTIVE) {
    throw new SkuBlockedError(
      `RunOutboundChecks: SKU ${check.skuCode} status is "${check.status}", not "${SKU_STATUS_ACTIVE}".`,
      { skuId: check.skuId, skuCode: check.skuCode, status: check.status },
    );
  }
}

// --- condition 7: non-blocked locations hold enough stock ---------------------------------------

export interface StockedLocationForBlockCheck {
  readonly locationCode: string;
  readonly blockReason: string | null;
  readonly isBlocked: boolean;
  readonly qtyAvailable: string;
}

/** Condition 7 (fix round 1 finding 7, brief Master decision 3): fails when the quantity available
 *  at NON-blocked stocked locations alone is insufficient for the order — NOT "every location is
 *  blocked". A blocked location's stock never counts toward satisfying this condition, even when
 *  condition 3's total-across-all-locations sum (assertSufficientStock above) passed. The reported
 *  location is the first blocked one found holding stock (representative — the message names one
 *  location, per the D-blueprint template). */
export function assertNonBlockedLocationsSufficient(
  locations: readonly StockedLocationForBlockCheck[],
  ordered: string,
  skuId: string,
): void {
  const nonBlockedAvailable = locations
    .filter((location) => !location.isBlocked)
    .reduce((sum, location) => sum.add(Quantity.of(location.qtyAvailable)), Quantity.zero());
  if (nonBlockedAvailable.compare(Quantity.of(ordered)) < 0) {
    const blocked = locations.find((location) => location.isBlocked) ?? null;
    throw new OutboundLocationBlockedError(
      `RunOutboundChecks: only ${nonBlockedAvailable} of SKU ${skuId} available at non-blocked ` +
        `locations, ${ordered} ordered` +
        (blocked ? ` (location ${blocked.locationCode} blocked: ${blocked.blockReason ?? 'n/a'})` : '') +
        '.',
      {
        skuId,
        available: nonBlockedAvailable.toString(),
        ordered,
        locationCode: blocked?.locationCode ?? null,
        blockReason: blocked?.blockReason ?? null,
      },
    );
  }
}

// --- condition 8: delivery address complete ------------------------------------------------------

export interface DeliveryAddressCheck {
  readonly orderId: string;
  readonly orderType: string;
  readonly shipToName: string | null;
  readonly shipToPhone: string | null;
  readonly shipToAddress: string | null;
  readonly shipToArea: string | null;
}

/** Condition 8: only when `orderType` implies delivery (brief Master decision 3 — any type other
 *  than `transfer`/`return_to_client`, given as `noDeliveryOrderTypes`) — every `shipTo*` field
 *  must be non-empty. */
export function assertDeliveryAddressComplete(
  check: DeliveryAddressCheck,
  noDeliveryOrderTypes: ReadonlySet<string>,
): void {
  if (noDeliveryOrderTypes.has(check.orderType)) return;
  const missingFields = (
    [
      ['shipToName', check.shipToName],
      ['shipToPhone', check.shipToPhone],
      ['shipToAddress', check.shipToAddress],
      ['shipToArea', check.shipToArea],
    ] as const
  )
    .filter(([, value]) => !value || value.trim().length === 0)
    .map(([field]) => field);
  if (missingFields.length > 0) {
    throw new DeliveryAddressIncompleteError(
      `RunOutboundChecks: order ${check.orderId}'s delivery address is missing: ${missingFields.join(', ')}.`,
      { missingFields },
    );
  }
}

// --- condition 9: a service price exists ---------------------------------------------------------

/** Condition 9: `hasPricedLine`/`hasPriceException` are already-resolved booleans from the
 *  repository's dated/active-status-filtered reads (fix round 1 finding 8). */
export function assertServicePriced(
  hasPricedLine: boolean,
  hasPriceException: boolean,
  serviceCode: string,
  orderId: string,
): void {
  if (!hasPricedLine && !hasPriceException) {
    throw new NoServicePriceError(
      `RunOutboundChecks: no price for service ${serviceCode} in order ${orderId}'s client's ` +
        `contract.`,
      { serviceCode },
    );
  }
}

// --- condition 10: per-contract, per-SKU order-quantity limit (WBS 2.11 part 5, D-189) ----------

export interface OrderQuantityLimitCheck {
  readonly skuCode: string;
  readonly ordered: string;
  /** `sales.contract_sku_limits.max_order_qty` as numeric(14,3) text, or `null` when no row exists
   *  for this (contract, sku) — null/absent always means no cap (D-189, SCR-WMS-OUT-02 §6). */
  readonly limit: string | null;
}

/** Condition 10 (D-189): a null `limit` never throws (no row = no cap); `ordered` <= `limit` never
 *  throws (the limit is inclusive); `ordered` > `limit` throws OrderQuantityExceededError carrying
 *  the exact skuCode/ordered/limit. Compared as `Quantity` (exact decimal), never JS numbers —
 *  same discipline as every other quantity invariant above (finding 7). */
export function assertOrderQuantityWithinLimit(check: OrderQuantityLimitCheck): void {
  if (check.limit === null) return;
  if (Quantity.of(check.ordered).compare(Quantity.of(check.limit)) > 0) {
    throw new OrderQuantityExceededError(
      `RunOutboundChecks: SKU ${check.skuCode}'s ordered quantity ${check.ordered} exceeds the ` +
        `contract's agreed limit of ${check.limit}.`,
      { skuCode: check.skuCode, ordered: check.ordered, limit: check.limit },
    );
  }
}

// --- condition 2: credit hold (decision only — never throws, brief Master decision 3) -----------

export interface CreditHoldDecision {
  readonly onHold: boolean;
  readonly holdReason: string | null;
}

export interface AccountCreditForCheck {
  readonly creditHold: boolean;
  readonly holdReason: string | null;
}

/** Condition 2 is checked LAST and never throws — it decides the order's own outcome
 *  (`checks_pending` vs `credit_rejected`) instead. Pure decision, no I/O. */
export function evaluateCreditHold(account: AccountCreditForCheck | null): CreditHoldDecision {
  if (!account || !account.creditHold) return { onHold: false, holdReason: null };
  return { onHold: true, holdReason: account.holdReason };
}

// --- allocateFromSingleLot (WBS 2.11 part 2, Master decision 2) ----------------------------------

/** One candidate lot, ALREADY ordered by the caller (repository/SQL) per the SKU's own
 *  `picking_policy` — FEFO: `expiry_date` ascending, nulls last; FIFO:
 *  `stock_balance.last_movement_at` ascending; LIFO: reverse of FIFO. This function never
 *  re-orders `lots` — it scans them in the given order and reserves from ONE of them. `lotKey` is
 *  an opaque identifier the caller uses to map the chosen lot back to its own (location_id,
 *  batch_no) pair. */
export interface AllocationLotCandidate {
  readonly lotKey: string;
  /** `wms.stock_balance.qty_available` as the numeric(14,3) text the repository selects. */
  readonly available: string;
}

export interface AllocationLotConsumption {
  readonly lotKey: string;
  readonly qty: string;
}

export interface AllocationResult {
  /** At most ONE entry — the single lot the line reserves from (empty when no lot has stock). */
  readonly consumed: readonly AllocationLotConsumption[];
  readonly shortfall: string;
}

/**
 * WBS 2.11 part 2, fix round 1 (Master ruling, findings 1/3): a line is allocated from a SINGLE
 * lot, never split across two — `wms.order_lines` has one `location_id`/`batch_no` per line and no
 * per-lot allocation child table exists in the schema (G-01 filed separately, SCR-WMS-OUT-01).
 * `lots` is ALREADY ordered by the caller (repository/SQL) per the SKU's own `picking_policy`
 * (FEFO/FIFO/LIFO) and pre-filtered to `qty_available > 0`. Preference order:
 *   1. the FIRST lot (in policy order) whose own `available` covers the ENTIRE `orderedQty` —
 *      taken in full, no shortfall.
 *   2. else the FIRST lot in policy order (still the best lot by FEFO/FIFO/LIFO) — take
 *      `min(lot.available, orderedQty)`, whatever is left over is `shortfall` (line ends up
 *      'partial').
 *   3. `lots` empty (or none has positive `available`, which the caller's own SQL filter already
 *      prevents) — the whole `orderedQty` is `shortfall`, nothing consumed (line stays 'open').
 * Pure, no I/O, `Quantity` arithmetic throughout (part 1's own fix-round finding 7 — never a raw
 * `Number()` on a quantity).
 */
export function allocateFromSingleLot(
  orderedQty: string,
  lots: readonly AllocationLotCandidate[],
): AllocationResult {
  const ordered = Quantity.of(orderedQty);
  if (lots.length === 0 || !ordered.isPositive()) {
    return { consumed: [], shortfall: ordered.toString() };
  }

  const fullyCoveringLot = lots.find((lot) => Quantity.of(lot.available).compare(ordered) >= 0);
  const chosenLot = fullyCoveringLot ?? lots[0];
  if (!chosenLot) {
    return { consumed: [], shortfall: ordered.toString() };
  }

  const available = Quantity.of(chosenLot.available);
  const take = available.compare(ordered) < 0 ? available : ordered;
  if (!take.isPositive()) {
    return { consumed: [], shortfall: ordered.toString() };
  }

  return {
    consumed: [{ lotKey: chosenLot.lotKey, qty: take.toString() }],
    shortfall: ordered.subtract(take).toString(),
  };
}

// --- assertVarianceReasonRequired (PickLine shortage gate, WBS 2.12 part 1) ---------------------

export interface VarianceReasonCheck {
  readonly lineId: string;
  readonly qtyOrdered: string;
  readonly qtyActual: string;
  readonly varianceReason: string | null | undefined;
}

/** PickLine's own shortage gate (brief Master decision 2): a blank/null `varianceReason` is only
 *  illegal when `qtyActual` is strictly below `qtyOrdered` (exact `Quantity` comparison — never
 *  `Number()`, same discipline as every other quantity invariant in this file). `qtyActual ===
 *  qtyOrdered` never throws, whatever `varianceReason` holds. */
export function assertVarianceReasonRequired(check: VarianceReasonCheck): void {
  if (Quantity.of(check.qtyActual).compare(Quantity.of(check.qtyOrdered)) >= 0) return;
  if (check.varianceReason !== null && check.varianceReason !== undefined && check.varianceReason.trim().length > 0) return;
  throw new VarianceReasonRequiredError(
    `PickLine: line ${check.lineId}'s picked quantity ${check.qtyActual} is short of the ordered ` +
      `${check.qtyOrdered} and carries no variance_reason.`,
    { lineId: check.lineId, qtyOrdered: check.qtyOrdered, qtyActual: check.qtyActual },
  );
}

// --- assertCheckerNotPicker (CheckOrder self-check gate, WBS 2.12 part 1) -----------------------

export interface CheckerNotPickerCheck {
  readonly orderId: string;
  readonly checkerId: string;
  readonly pickedBy: string;
}

/** CheckOrder's mandatory invariant (brief Master decision 3, doc 38 row 2.12's own literal
 *  acceptance line "Self-check rejected"): the checker must differ from the order's own
 *  `picked_by`. */
export function assertCheckerNotPicker(check: CheckerNotPickerCheck): void {
  if (check.checkerId !== check.pickedBy) return;
  throw new SelfCheckNotAllowedError(
    `CheckOrder: order ${check.orderId} was picked by ${check.pickedBy} — the same actor may not ` +
      `also check it (self-check rejected).`,
    { orderId: check.orderId, actorId: check.checkerId },
  );
}

// --- PickLine fix round 1 (findings 2/3/6): pre-write gates, mirroring the discipline every other
// invariant in this file already follows — pure, Quantity-exact, thrown BEFORE any write. -------

/** Finding 2: rejects a PickLine call on a line that has already been picked. `alreadyPicked` is
 *  a boolean the application layer derives from I/O (../../application/process-outbound/
 *  pick-line.ts): either a posted `wms.stock_movements` 'pick' row already exists for this line
 *  (keyed by `ref_table='wms.order_lines'`/`ref_id`=lineId, same precedent
 *  ../count-inventory/ledger.ts already uses), OR — for a zero-quantity pick, which intentionally
 *  posts no ledger row (finding 5) — the line's own `qty_actual` already reads `0` (a reserved
 *  line's `qty_actual` is always positive until PickLine records a zero pick on it; Allocate never
 *  reserves a zero-quantity lot). */
export function assertLineNotAlreadyPicked(lineId: string, alreadyPicked: boolean): void {
  if (!alreadyPicked) return;
  throw new LineAlreadyPickedError(
    `PickLine: line ${lineId} already has a posted pick movement — it cannot be picked again.`,
    { lineId },
  );
}

export interface PickedWithinReservedCheck {
  readonly lineId: string;
  /** `order_lines.qty_actual` as Allocate stamped it — the single lot's reserved quantity. */
  readonly reserved: string;
  readonly qtyActual: string;
}

/** Finding 3: `qtyActual` may never exceed the line's own reserved quantity — an over-pick would
 *  otherwise silently consume another order's `qty_allocated` (no DB floor on that column) or fail
 *  as a raw 500 on the DB's own `variance_needs_reason` CHECK. Exact `Quantity` comparison, never
 *  `Number()` (this file's own discipline throughout). */
export function assertPickedWithinReserved(check: PickedWithinReservedCheck): void {
  if (Quantity.of(check.qtyActual).compare(Quantity.of(check.reserved)) <= 0) return;
  throw new PickQuantityExceedsReservedError(
    `PickLine: line ${check.lineId}'s picked quantity ${check.qtyActual} exceeds its reserved ` +
      `quantity ${check.reserved}.`,
    { lineId: check.lineId, reserved: check.reserved, qtyActual: check.qtyActual },
  );
}

export interface LineReservedForPickCheck {
  readonly lineId: string;
  /** `order_lines.location_id` — the single lot Allocate reserved for this line, or `null` when
   *  the line was never allocated any stock (e.g. the open remainder of a partially_allocated
   *  order). */
  readonly locationId: string | null;
  readonly qtyActual: string;
}

/** Finding 6: a line with no reservation (`locationId` null) may only be "picked" at `qtyActual`
 *  zero — a positive quantity with nothing reserved is rejected rather than silently accepted with
 *  no stock consumed and no ledger row. */
export function assertLineReservedForPick(check: LineReservedForPickCheck): void {
  if (check.locationId !== null) return;
  if (Quantity.of(check.qtyActual).compare(Quantity.zero()) === 0) return;
  throw new LineNotReservedForPickError(
    `PickLine: line ${check.lineId} has no reservation (location_id is null) — a positive quantity ` +
      `${check.qtyActual} cannot be picked against it.`,
    { lineId: check.lineId, qtyActual: check.qtyActual },
  );
}
