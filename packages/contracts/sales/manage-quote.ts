// packages/contracts/sales/manage-quote.ts — WBS 1.6, M02 sales.
//
// Zod input schemas for the manage-quote use case's nine commands (slice brief
// docs/notes/slice-briefs/_slice-1.6.brief.md, "Contract" section). Every id is a uuid;
// price/qty/discount fields are numeric(14,3) strings — `qty`/`unitPrice` strictly positive,
// `discountAmt` non-negative (validated against the quote's own subtotal in the domain layer, not
// here — the contract cannot see the quote's subtotal). Dates are `z.iso.date()` (zod v4).
// `performedBy`/`approvedBy`/... do NOT exist on any schema: the actor is ALWAYS `ctx.userId`.
// Every quote-mutating command except CreateQuote/ReviseQuote (which create a NEW row) carries
// `expectedVersion` — the optimistic-lock token the caller read most recently; a stale one ->
// StaleVersionError (409). `idem` is NOT part of these schemas — the api layer
// (../../modules/sales/api/manage-quote/handlers.ts) adds it after parsing (slice brief).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// numeric(14,3): 1-11 integer digits, optional '.' + 1-3 fractional digits.
const NON_NEGATIVE_QUANTITY = z.string().regex(/^\d{1,11}(?:\.\d{1,3})?$/);
const POSITIVE_QUANTITY = NON_NEGATIVE_QUANTITY.refine((value) => Number(value) > 0, {
  message: 'must be greater than 0',
});
// sales.quotes.version starts at 1 (migration 0017: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
// Master decision 2 (default): the currency every quote carries when the caller omits one.
const DEFAULT_CURRENCY = 'KWD';
const CURRENCY_CODE = z.string().length(3).default(DEFAULT_CURRENCY);
const DEFAULT_DISCOUNT = '0.000';

export const CreateQuoteInputSchema = z
  .object({
    entityId: UUID_ID,
    accountId: UUID_ID,
    opportunityId: UUID_ID.nullable(),
    validUntil: z.iso.date(),
    currency: CURRENCY_CODE,
    termsAr: z.string().nullable(),
    termsEn: z.string().nullable(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'CreateQuoteInput' });

export type CreateQuoteInput = z.infer<typeof CreateQuoteInputSchema>;

export const UpsertQuoteLineInputSchema = z
  .object({
    quoteId: UUID_ID,
    serviceId: UUID_ID,
    qty: POSITIVE_QUANTITY,
    unitPrice: POSITIVE_QUANTITY,
    exceptionId: UUID_ID.nullable(),
    discountAmt: NON_NEGATIVE_QUANTITY.default(DEFAULT_DISCOUNT),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'UpsertQuoteLineInput' });

export type UpsertQuoteLineInput = z.infer<typeof UpsertQuoteLineInputSchema>;

export const SubmitForReviewInputSchema = z
  .object({
    quoteId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'SubmitForReviewInput' });

export type SubmitForReviewInput = z.infer<typeof SubmitForReviewInputSchema>;

export const ApproveCommercialInputSchema = z
  .object({
    quoteId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ApproveCommercialInput' });

export type ApproveCommercialInput = z.infer<typeof ApproveCommercialInputSchema>;

export const ApproveFinanceInputSchema = z
  .object({
    quoteId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ApproveFinanceInput' });

export type ApproveFinanceInput = z.infer<typeof ApproveFinanceInputSchema>;

export const ReturnToDraftInputSchema = z
  .object({
    quoteId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ReturnToDraftInput' });

export type ReturnToDraftInput = z.infer<typeof ReturnToDraftInputSchema>;

export const SendQuoteInputSchema = z
  .object({
    quoteId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'SendQuoteInput' });

export type SendQuoteInput = z.infer<typeof SendQuoteInputSchema>;

export const RecordDecisionInputSchema = z
  .object({
    quoteId: UUID_ID,
    decision: z.enum(['accepted', 'rejected']),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'RecordDecisionInput' });

export type RecordDecisionInput = z.infer<typeof RecordDecisionInputSchema>;

export const ReviseQuoteInputSchema = z
  .object({
    quoteId: UUID_ID,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ReviseQuoteInput' });

export type ReviseQuoteInput = z.infer<typeof ReviseQuoteInputSchema>;
