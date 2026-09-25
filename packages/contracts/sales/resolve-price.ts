// packages/contracts/sales/resolve-price.ts — WBS 1.4, M02 sales pricing engine.
//
// Zod schemas for the resolve-price read-only resolution engine (slice brief "Contract" section).
// `ResolvePriceInputSchema`: every id a uuid, `qty` a strictly positive numeric(14,3) string
// (Scenario "Zero quantity is rejected at the contract boundary"), `asOfDate` a `z.iso.date()`
// (zod v4) always supplied by the caller — this engine never defaults it internally to "now".
// `ResolvePriceResultSchema`: a discriminated union on `status` matching Master decision 1
// exactly — `priced` (unitPriceSource + totalPrice + the ONE source-specific id that resolved it)
// or `pending` (a reason string, never a price field).
//
// TEMPLATE GUIDANCE: one contract file per use case — this slice has exactly one public function,
// resolvePrice, so exactly one input schema and one result schema.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// numeric(14,3): 1-11 integer digits, optional '.' + 1-3 fractional digits.
const NON_NEGATIVE_QUANTITY = z.string().regex(/^\d{1,11}(?:\.\d{1,3})?$/);
// A3 "never price at zero" — the quantity resolved must be strictly positive. A pure regex (never
// `Number()` on a numeric(14,3) string, CLAUDE.md · AGENT CONSTRAINTS): a negative lookahead
// structurally rejects every all-zero-digits value ("0", "0.0", "0.000", ...) while still
// matching the same digit shape as NON_NEGATIVE_QUANTITY (pg-reviewer round 1 finding 6).
const POSITIVE_QUANTITY = z.string().regex(/^(?!0+(?:\.0+)?$)\d{1,11}(?:\.\d{1,3})?$/);

export const ResolvePriceInputSchema = z
  .object({
    accountId: UUID_ID,
    serviceId: UUID_ID,
    entityId: UUID_ID,
    qty: POSITIVE_QUANTITY,
    asOfDate: z.iso.date(),
  })
  .meta({ id: 'ResolvePriceInput' });

export type ResolvePriceInput = z.infer<typeof ResolvePriceInputSchema>;

const UnitPriceSourceSchema = z.enum(['exception', 'contract', 'segment_list', 'standard_list']);

const ResolvePricePricedResultSchema = z
  .object({
    status: z.literal('priced'),
    unitPriceSource: UnitPriceSourceSchema,
    totalPrice: NON_NEGATIVE_QUANTITY,
    priceListId: UUID_ID.optional(),
    priceExceptionId: UUID_ID.optional(),
    contractId: UUID_ID.optional(),
  })
  .meta({ id: 'ResolvePricePricedResult' });

const ResolvePricePendingResultSchema = z
  .object({
    status: z.literal('pending'),
    reason: z.string().min(1),
  })
  .meta({ id: 'ResolvePricePendingResult' });

export const ResolvePriceResultSchema = z
  .discriminatedUnion('status', [ResolvePricePricedResultSchema, ResolvePricePendingResultSchema])
  .meta({ id: 'ResolvePriceResult' });

export type ResolvePriceResult = z.infer<typeof ResolvePriceResultSchema>;
