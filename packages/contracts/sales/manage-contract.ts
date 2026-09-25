// packages/contracts/sales/manage-contract.ts — WBS 1.7, M02 sales.
//
// Zod input schemas for the manage-contract use case's eight commands (slice brief
// docs/notes/slice-briefs/_slice-1.7.brief.md, "Contract" section). Every id is a uuid. Dates are
// `z.iso.date()` (zod v4). `signedByClient` is the CLIENT's own signatory name — not a FK, not an
// actor field: the actor is ALWAYS `ctx.userId` (Master decision 11). Every contract-mutating
// command except CreateContract carries `expectedVersion` — the optimistic-lock token the caller
// read most recently; a stale one -> StaleVersionError (409). `idem` is NOT part of these schemas —
// the api layer (../../modules/sales/api/manage-contract/handlers.ts) adds it after parsing (slice
// brief, golden pattern reused from manage-quote).
//
// `AddContractSlaInputSchema.metric` is restricted to the six-value SLA vocabulary named in
// `01-Data-Model.sql:585` (the `sales.contract_sla.metric` column comment — pg-reviewer fix round
// 1, finding 12: not doc 40 §C2, which does not enumerate them) (Master decision 9) — a documented
// default tightening the application's own input, not a new DB CHECK (the column is free text).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// sales.contracts.version starts at 1 (migration 0019: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
// numeric(14,3): 1-11 integer digits, optional '.' + 1-3 fractional digits.
const NON_NEGATIVE_QUANTITY = z.string().regex(/^\d{1,11}(?:\.\d{1,3})?$/);
const POSITIVE_QUANTITY = NON_NEGATIVE_QUANTITY.refine((value) => Number(value) > 0, {
  message: 'must be greater than 0',
});
// Master decision 2's defaults.
const DEFAULT_BILLING_CYCLE = 'monthly';
const DEFAULT_PAYMENT_TERMS_DAYS = 30;
const DEFAULT_NOTICE_DAYS = 30;
const DEFAULT_MIN_MONTHLY_CHARGE = '0.000';

// 01-Data-Model.sql:585's own SLA vocabulary — application/contract-layer restriction only (Master decision 9).
const SLA_METRICS = ['otd_pct', 'inventory_accuracy', 'pick_time_min', 'damage_pct', 'answer_rate', 'aht_sec'] as const;

export const CreateContractInputSchema = z
  .object({
    entityId: UUID_ID,
    accountId: UUID_ID,
    quoteId: UUID_ID.nullable(),
    title: z.string().min(1),
    startDate: z.iso.date(),
    endDate: z.iso.date().nullable(),
    billingCycle: z.string().min(1).default(DEFAULT_BILLING_CYCLE),
    paymentTermsDays: z.number().int().min(0).default(DEFAULT_PAYMENT_TERMS_DAYS),
    autoRenew: z.boolean().default(false),
    noticeDays: z.number().int().min(0).default(DEFAULT_NOTICE_DAYS),
    minMonthlyCharge: NON_NEGATIVE_QUANTITY.default(DEFAULT_MIN_MONTHLY_CHARGE),
    slaEnabled: z.boolean().default(false),
    billsFailedAttempt: z.boolean().default(false),
    billsReturn: z.boolean().default(false),
    billsWaiting: z.boolean().default(false),
    billsReschedule: z.boolean().default(false),
    billsPartialDelivery: z.boolean().default(false),
    correlationId: UUID_ID,
  })
  .meta({ id: 'CreateContractInput' });

export type CreateContractInput = z.infer<typeof CreateContractInputSchema>;

export const SignContractInputSchema = z
  .object({
    contractId: UUID_ID,
    signedByClient: z.string().min(1),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'SignContractInput' });

export type SignContractInput = z.infer<typeof SignContractInputSchema>;

export const SetContractPriceListInputSchema = z
  .object({
    contractId: UUID_ID,
    priceListId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'SetContractPriceListInput' });

export type SetContractPriceListInput = z.infer<typeof SetContractPriceListInputSchema>;

export const ActivateContractInputSchema = z
  .object({
    contractId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ActivateContractInput' });

export type ActivateContractInput = z.infer<typeof ActivateContractInputSchema>;

export const SuspendContractInputSchema = z
  .object({
    contractId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'SuspendContractInput' });

export type SuspendContractInput = z.infer<typeof SuspendContractInputSchema>;

export const ResumeContractInputSchema = z
  .object({
    contractId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ResumeContractInput' });

export type ResumeContractInput = z.infer<typeof ResumeContractInputSchema>;

export const ExpireContractInputSchema = z
  .object({
    contractId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'ExpireContractInput' });

export type ExpireContractInput = z.infer<typeof ExpireContractInputSchema>;

export const AddContractSlaInputSchema = z
  .object({
    contractId: UUID_ID,
    metric: z.enum(SLA_METRICS),
    targetValue: POSITIVE_QUANTITY,
    direction: z.enum(['min', 'max']).default('min'),
    penaltyType: z.enum(['pct_of_monthly', 'fixed', 'none']).optional(),
    penaltyValue: NON_NEGATIVE_QUANTITY.optional(),
    bonusValue: NON_NEGATIVE_QUANTITY.optional(),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'AddContractSlaInput' });

export type AddContractSlaInput = z.infer<typeof AddContractSlaInputSchema>;
