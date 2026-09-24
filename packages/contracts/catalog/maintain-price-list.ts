// packages/contracts/catalog/maintain-price-list.ts — WBS 1.2, M03 catalog.
//
// Zod input schemas for the maintain-price-list use case's six commands. Every id is a uuid;
// price/tier/free-unit fields are numeric(14,3) strings — `price`/`approvedPrice` strictly
// positive (A3 "never price at zero" — Scenario "A zero price is rejected"), `tierFrom`/`tierTo`/
// `freeUnits` non-negative. Dates are `z.iso.date()` (zod v4). `performedBy` does NOT exist on any
// schema: the actor is ALWAYS `ctx.userId`. Every list-mutating command (every command except
// CreatePriceList and GrantPriceException) carries `expectedVersion` — the optimistic-lock token
// the caller read most recently; a stale one -> StaleVersionError (409). `idem` is NOT part of
// these schemas — the api layer (../../modules/catalog/api/maintain-price-list/handlers.ts) adds
// it after parsing (slice brief).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// numeric(14,3): 1-11 integer digits, optional '.' + 1-3 fractional digits.
const NON_NEGATIVE_QUANTITY = z.string().regex(/^\d{1,11}(?:\.\d{1,3})?$/);
// A3 "never price at zero" — every price field in this use case is strictly positive.
const POSITIVE_QUANTITY = NON_NEGATIVE_QUANTITY.refine((value) => Number(value) > 0, {
  message: 'must be greater than 0',
});
// catalog.price_lists.version starts at 1 (migration 0013: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
// Master decision 4 (default): the currency every line writes when the caller omits one.
const DEFAULT_CURRENCY = 'KWD';
const CURRENCY_CODE = z.string().length(3).default(DEFAULT_CURRENCY);
// price_list_lines.free_units default 0 (01-Data-Model.sql:394).
const DEFAULT_FREE_UNITS = '0.000';

export const CreatePriceListInputSchema = z
  .object({
    entityId: UUID_ID,
    code: z.string().min(1),
    nameAr: z.string().min(1),
    segmentId: UUID_ID.nullable(),
    clientId: UUID_ID.nullable(),
    validFrom: z.iso.date(),
    validTo: z.iso.date().nullable(),
    isInternal: z.boolean(),
    correlationId: UUID_ID,
  })
  .refine((value) => !(value.segmentId !== null && value.clientId !== null), {
    message: 'at most one of segmentId/clientId may be set (Master decision 6)',
    path: ['clientId'],
  })
  .meta({ id: 'CreatePriceListInput' });

export type CreatePriceListInput = z.infer<typeof CreatePriceListInputSchema>;

export const UpsertPriceListLineInputSchema = z
  .object({
    priceListId: UUID_ID,
    serviceCode: z.string().min(1),
    price: POSITIVE_QUANTITY,
    currency: CURRENCY_CODE,
    tierFrom: NON_NEGATIVE_QUANTITY.optional(),
    tierTo: NON_NEGATIVE_QUANTITY.optional(),
    freeUnits: NON_NEGATIVE_QUANTITY.default(DEFAULT_FREE_UNITS),
    notes: z.string().optional(),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'UpsertPriceListLineInput' });

export type UpsertPriceListLineInput = z.infer<typeof UpsertPriceListLineInputSchema>;

const ImportPriceListLineRowSchema = z.object({
  serviceCode: z.string().min(1),
  price: POSITIVE_QUANTITY,
  currency: CURRENCY_CODE,
  tierFrom: NON_NEGATIVE_QUANTITY.optional(),
  tierTo: NON_NEGATIVE_QUANTITY.optional(),
  freeUnits: NON_NEGATIVE_QUANTITY.default(DEFAULT_FREE_UNITS),
  notes: z.string().optional(),
});

export const ImportPriceListLinesInputSchema = z
  .object({
    priceListId: UUID_ID,
    rows: z.array(ImportPriceListLineRowSchema).min(1),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ImportPriceListLinesInput' });

export type ImportPriceListLinesInput = z.infer<typeof ImportPriceListLinesInputSchema>;

export const ActivatePriceListInputSchema = z
  .object({
    priceListId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ActivatePriceListInput' });

export type ActivatePriceListInput = z.infer<typeof ActivatePriceListInputSchema>;

export const ExpirePriceListInputSchema = z
  .object({
    priceListId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ExpirePriceListInput' });

export type ExpirePriceListInput = z.infer<typeof ExpirePriceListInputSchema>;

export const GrantPriceExceptionInputSchema = z
  .object({
    entityId: UUID_ID,
    clientId: UUID_ID,
    serviceId: UUID_ID,
    approvedPrice: POSITIVE_QUANTITY,
    reason: z.string().min(1),
    validFrom: z.iso.date(),
    validTo: z.iso.date(),
    reviewAt: z.iso.date(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'GrantPriceExceptionInput' });

export type GrantPriceExceptionInput = z.infer<typeof GrantPriceExceptionInputSchema>;
