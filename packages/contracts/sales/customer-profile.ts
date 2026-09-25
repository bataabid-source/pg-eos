// packages/contracts/sales/customer-profile.ts — WBS 1.9, M02 sales.
//
// Zod schemas for the customer-profile read-only aggregation (slice brief
// docs/notes/slice-briefs/_slice-1.9.brief.md, "Contract" section, Master decision 1). Group-level,
// no `entityId` parameter — a customer's contracts span every entity (Scope: "genuinely group-level,
// matching WBS 1.8's own group-level construction"). `getCustomerProfile`'s own function signature is
// not itself a Zod contract (same as 1.7's GetContractForOrderInput/1.8's
// GetAccountCreditStatusInput — a pure read validated by TypeScript alone), but the brief still asks
// for the input AND result shapes declared here so `apps/admin`'s mock client can share the exact
// same types (Master decision 7).
//
// TEMPLATE GUIDANCE: one contract file per use case — this slice has exactly one public function,
// getCustomerProfile, so exactly one input schema and one result schema.

import { z } from 'zod';

const UUID_ID = z.string().uuid();

export const GetCustomerProfileInputSchema = z
  .object({
    accountId: UUID_ID,
  })
  .meta({ id: 'GetCustomerProfileInput' });

export type GetCustomerProfileInput = z.infer<typeof GetCustomerProfileInputSchema>;

const CustomerProfileIdentitySchema = z
  .object({
    accountId: UUID_ID,
    code: z.string(),
    nameAr: z.string(),
    nameEn: z.string().nullable(),
    segmentCode: z.string().nullable(),
    segmentNameAr: z.string().nullable(),
    ownerUserId: UUID_ID.nullable(),
    ownerNameAr: z.string().nullable(),
  })
  .meta({ id: 'CustomerProfileIdentity' });

const CustomerProfileContractSchema = z
  .object({
    contractId: UUID_ID,
    entityCode: z.string(),
    status: z.string(),
    startDate: z.string(),
    endDate: z.string().nullable(),
    hasPriceList: z.boolean(),
  })
  .meta({ id: 'CustomerProfileContract' });

// D03 completeness metric (D-blueprint 02, line 1066) plus the fifth gap grounded in WBS 1.7's own
// INV-C2-2 (Master decision 2) — no other item is invented.
export const ReadinessItemNameSchema = z.enum([
  'cr_number',
  'credit_limit',
  'segment',
  'payment_terms',
  'priced_contract',
]);

export type ReadinessItemName = z.infer<typeof ReadinessItemNameSchema>;

const CustomerProfileReadinessItemSchema = z
  .object({
    item: ReadinessItemNameSchema,
    present: z.boolean(),
    // D03's stated owner for the first four; contract ownership (doc 06 §2-3/D-blueprint "D04")
    // for the fifth — no other role is named anywhere for these five facts (Master decision 2).
    owner: z.literal('CFO'),
  })
  .meta({ id: 'CustomerProfileReadinessItem' });

const CustomerProfileFinanceSchema = z
  .object({
    // numeric(14,3) as text — a genuine NULL surfaces as `null`, never a fabricated default
    // (same discipline as 1.8's GetAccountCreditStatusResult).
    creditLimit: z.string().nullable(),
    creditHold: z.boolean(),
    holdReason: z.string().nullable(),
  })
  .meta({ id: 'CustomerProfileFinance' });

// Master decision 5: hard-coded, never computed, never estimated.
const CustomerProfileProfitabilitySchema = z
  .object({
    available: z.literal(false),
  })
  .meta({ id: 'CustomerProfileProfitability' });

export const CustomerProfileResultSchema = z
  .object({
    identity: CustomerProfileIdentitySchema,
    contracts: z.array(CustomerProfileContractSchema),
    readiness: z.array(CustomerProfileReadinessItemSchema),
    finance: CustomerProfileFinanceSchema,
    profitability: CustomerProfileProfitabilitySchema,
  })
  .meta({ id: 'CustomerProfileResult' });

export type CustomerProfileResult = z.infer<typeof CustomerProfileResultSchema>;
