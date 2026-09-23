// modules/wms/src/sku-registration/domain.ts — WBS 2.6 (pg-backend).
//
// Pure domain: no I/O, no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). Validates the
// shape of a RegisterSkuInput before any DB call — the two 13B CHECK constraints (chk_skus_status,
// chk_skus_picking_policy) plus the DDL's required/optional split (decision 3, decision 4).

import { InvalidSkuInputError } from './errors.js';

// 13B chk_skus_status (2421-2423) — the ONLY legal status list, copied verbatim.
export const SKU_STATUSES = ['active', 'on_hold', 'discontinued'] as const;
export type SkuStatus = (typeof SKU_STATUSES)[number];

// 13B chk_skus_picking_policy (3575-3577) — the ONLY legal picking policy list, null allowed.
export const PICKING_POLICIES = ['FIFO', 'FEFO', 'LIFO'] as const;
export type PickingPolicy = (typeof PICKING_POLICIES)[number];

const SKU_STATUS_SET: ReadonlySet<string> = new Set(SKU_STATUSES);
const PICKING_POLICY_SET: ReadonlySet<string> = new Set(PICKING_POLICIES);

export interface RegisterSkuInput {
  readonly clientId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly clientSku?: string | null;
  readonly barcode?: string | null;
  readonly cartonBarcode?: string | null;
  readonly nameEn?: string | null;
  readonly category?: string | null;
  readonly subcategory?: string | null;
  readonly brand?: string | null;
  readonly originCountry?: string | null;
  readonly lengthCm?: number | null;
  readonly widthCm?: number | null;
  readonly heightCm?: number | null;
  readonly netWeightKg?: number | null;
  readonly grossWeightKg?: number | null;
  readonly volumeCbm?: number | null;
  readonly unitsPerPack?: number | null;
  readonly packsPerCarton?: number | null;
  readonly cartonsPerLayer?: number | null;
  readonly layersPerPallet?: number | null;
  readonly tempMin?: number | null;
  readonly tempMax?: number | null;
  readonly stackable?: boolean;
  readonly maxStackHeight?: number | null;
  readonly isFragile?: boolean;
  readonly isHazmat?: boolean;
  readonly unClass?: string | null;
  readonly lightSensitive?: boolean;
  readonly trackBatch?: boolean;
  readonly trackSerial?: boolean;
  readonly trackExpiry?: boolean;
  readonly pickingPolicy?: PickingPolicy;
  readonly shelfLifeDays?: number | null;
  readonly minRemainingLifeReceiptDays?: number | null;
  readonly minRemainingLifeIssueDays?: number | null;
  readonly quarantineDays?: number;
  readonly minStock?: number | null;
  readonly maxStock?: number | null;
  readonly reorderPoint?: number | null;
  readonly abcClass?: string | null;
  readonly unitValue?: number | null;
  readonly imageUrl?: string | null;
  readonly msdsUrl?: string | null;
  readonly status?: SkuStatus;
}

/**
 * decision 4: pure, no I/O. Throws one InvalidSkuInputError for clientId/code/nameAr missing or
 * empty (whitespace-only counts as empty), or status/pickingPolicy present and outside its enum.
 * Never mutates `input`; returns a shallow copy carrying every field the input had.
 */
export function validateSkuInput(input: RegisterSkuInput): RegisterSkuInput {
  if (input.clientId.trim().length === 0) {
    throw new InvalidSkuInputError('clientId is required and must not be empty/whitespace-only');
  }
  if (input.code.trim().length === 0) {
    throw new InvalidSkuInputError('code is required and must not be empty/whitespace-only');
  }
  if (input.nameAr.trim().length === 0) {
    throw new InvalidSkuInputError('nameAr is required and must not be empty/whitespace-only');
  }
  if (input.status !== undefined && !SKU_STATUS_SET.has(input.status)) {
    throw new InvalidSkuInputError(
      `status ${JSON.stringify(input.status)} is not one of ${SKU_STATUSES.join(', ')} (13B chk_skus_status)`,
    );
  }
  if (input.pickingPolicy !== undefined && !PICKING_POLICY_SET.has(input.pickingPolicy)) {
    throw new InvalidSkuInputError(
      `pickingPolicy ${JSON.stringify(input.pickingPolicy)} is not one of ${PICKING_POLICIES.join(', ')} (13B chk_skus_picking_policy)`,
    );
  }

  return { ...input };
}
