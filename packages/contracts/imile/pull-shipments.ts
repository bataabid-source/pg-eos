// packages/contracts/imile/pull-shipments.ts — WBS 3.14 (part 2).
//
// Zod input/result schemas for the pull-shipments use case's ONE command, PullShipments.
// Input is ONLY `{ correlationId }` — no caller-supplied shipment data. The injected
// ImilePortalPort (application/pull-shipments/ports.ts) is the ONLY data source for shipment
// fields, same separation EvaluateAlertRules uses for its own job body
// (packages/contracts/platform/evaluate-alerts.ts): a pull cycle is an internal job trigger, not
// a form a caller fills in.
//
// Result field shapes are the module brief's own PullShipmentsResult shape (inserted / updated /
// skipped / unchanged counts over one pull cycle) — not derived from any table, so no table
// citation is needed here (brief, Contract line).

import { z } from 'zod';

const UUID_ID = z.string().uuid();
const NON_NEGATIVE_INT = z.number().int().nonnegative();

export const PullShipmentsInputSchema = z
  .object({
    correlationId: UUID_ID,
  })
  .meta({ id: 'PullShipmentsInput' });

export type PullShipmentsInput = z.infer<typeof PullShipmentsInputSchema>;

export const PullShipmentsResultSchema = z
  .object({
    inserted: NON_NEGATIVE_INT,
    updated: NON_NEGATIVE_INT,
    skipped: NON_NEGATIVE_INT,
    unchanged: NON_NEGATIVE_INT,
  })
  .meta({ id: 'PullShipmentsResult' });

export type PullShipmentsResult = z.infer<typeof PullShipmentsResultSchema>;
