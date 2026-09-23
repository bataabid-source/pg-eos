// modules/wms/src/stock-ledger/domain.ts — WBS 2.8 (pg-backend).
//
// Pure domain: no I/O, no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). All quantity
// arithmetic goes through @pg-eos/domain-kit's Quantity (numeric(14,3), bigint-backed) — never a
// raw JS number/float.
//
// The fold in deriveBalances is the SAME fold wms.verify_balance_integrity() uses
// (01 §wms.verify_balance_integrity, v1.1, SCR-WMS-01):
// `sum(case when to_location_id is not null then qty else -qty end)`, grouped by the full
// stock_balance key (client_id, sku_id, location_id, coalesce(batch_no, '')) — decision 1 makes
// every entry single-sided (qty > 0, exactly one of fromLocationId/toLocationId set), so
// "location" here is always the one side that is set.

import { Quantity } from '@pg-eos/domain-kit';

import { InvalidLedgerEntryError, InvalidQuantityError } from './errors.js';

// 13B chk_stock_movements_type (§13B-24) — the ONLY legal movement_type list, copied verbatim.
export const MOVEMENT_TYPES = [
  'receipt',
  'putaway',
  'pick',
  'pack',
  'ship',
  'issue',
  'transfer',
  'adjust',
  'count',
  'damage',
  'return',
  'scrap',
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

const MOVEMENT_TYPE_SET: ReadonlySet<string> = new Set(MOVEMENT_TYPES);

export interface LedgerEntry {
  readonly clientId: string;
  readonly skuId: string;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly qty: Quantity;
  readonly batchNo: string;
  readonly movementType: MovementType;
  readonly uom: string;
}

/**
 * decision 1 + decision 4: exactly one side set, qty > 0, movementType in MOVEMENT_TYPES. Throws
 * before any DB call is ever made — no racy read, no partially-written state to unwind.
 */
export function validateEntry(entry: LedgerEntry): LedgerEntry {
  if (!entry.qty.isPositive()) {
    throw new InvalidQuantityError(
      `qty must be > 0 (01 wms.stock_movements constraint qty_not_zero, plus decision 1's qty > 0); ` +
        `got "${entry.qty.toString()}"`,
    );
  }

  const hasFrom = entry.fromLocationId !== null;
  const hasTo = entry.toLocationId !== null;
  if (hasFrom === hasTo) {
    throw new InvalidLedgerEntryError(
      `exactly one of fromLocationId/toLocationId must be set (decision 1); got ` +
        `fromLocationId=${JSON.stringify(entry.fromLocationId)} toLocationId=${JSON.stringify(entry.toLocationId)}`,
    );
  }

  if (!MOVEMENT_TYPE_SET.has(entry.movementType)) {
    throw new InvalidLedgerEntryError(
      `movementType ${JSON.stringify(entry.movementType)} is not one of ` +
        `${MOVEMENT_TYPES.join(', ')} (13B chk_stock_movements_type (§13B-24))`,
    );
  }

  return entry;
}

/** brief Public surface, verbatim: `${clientId}|${skuId}|${locationId}|${batchNo}`. */
export function balanceKey(
  clientId: string,
  skuId: string,
  locationId: string,
  batchNo: string,
): string {
  return `${clientId}|${skuId}|${locationId}|${batchNo}`;
}

/**
 * Folds single-sided ledger entries into a balance map, keyed by balanceKey. Permutation-invariant
 * by construction (Map accumulation via Quantity.add, which is itself commutative/associative).
 *
 * `entries` are assumed single-sided (decision 1) — an entry with neither side set has no location
 * to fold into and is rejected rather than silently ignored or mis-keyed.
 */
export function deriveBalances(entries: readonly LedgerEntry[]): ReadonlyMap<string, Quantity> {
  const balances = new Map<string, Quantity>();

  for (const entry of entries) {
    const locationId = entry.toLocationId ?? entry.fromLocationId;
    if (locationId === null) {
      throw new InvalidLedgerEntryError(
        'deriveBalances: entry has neither fromLocationId nor toLocationId set (decision 1)',
      );
    }

    const key = balanceKey(entry.clientId, entry.skuId, locationId, entry.batchNo);
    const signedQty = entry.toLocationId !== null ? entry.qty : entry.qty.negate();
    const running = balances.get(key) ?? Quantity.zero();
    balances.set(key, running.add(signedQty));
  }

  return balances;
}

/**
 * decision 1: a transfer is two single-sided rows sharing client/sku/qty/batch/uom — an out-row at
 * `from` and an in-row at `to`, both movementType 'transfer'. Caller (post-movement.ts) is
 * responsible for giving both rows the same correlationId / ref_table / ref_id.
 */
export function planTransfer(
  base: Omit<LedgerEntry, 'fromLocationId' | 'toLocationId' | 'movementType'>,
  from: string,
  to: string,
): readonly [LedgerEntry, LedgerEntry] {
  const outRow: LedgerEntry = {
    ...base,
    fromLocationId: from,
    toLocationId: null,
    movementType: 'transfer',
  };
  const inRow: LedgerEntry = {
    ...base,
    fromLocationId: null,
    toLocationId: to,
    movementType: 'transfer',
  };
  return [outRow, inRow];
}

/**
 * decision 5: a reversal is a counter-entry with the opposite side, the same qty/batch/uom, and
 * movementType 'adjust' — never an edit of the original row. Caller (post-movement.ts) attaches
 * ref_table/ref_id/reason_code = 'reversal' when posting it.
 */
export function planReversal(original: LedgerEntry): LedgerEntry {
  return {
    ...original,
    fromLocationId: original.toLocationId,
    toLocationId: original.fromLocationId,
    movementType: 'adjust',
  };
}
