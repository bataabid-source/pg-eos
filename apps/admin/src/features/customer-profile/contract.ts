// WBS 1.9 — Customer 360 screen contract (Master decision 7: the frontend RE-EXPORTS the
// backend's Zod schemas, it never redeclares them). pg-backend has published the real schema at
// `packages/contracts/sales/customer-profile.ts` — this file imports and re-exports it verbatim.
export {
  CustomerProfileResultSchema,
  GetCustomerProfileInputSchema,
  ReadinessItemNameSchema,
} from '@pg-eos/contracts/sales/customer-profile';
export type {
  CustomerProfileResult,
  GetCustomerProfileInput,
  ReadinessItemName,
} from '@pg-eos/contracts/sales/customer-profile';

import type { CustomerProfileResult } from '@pg-eos/contracts/sales/customer-profile';

// The real package exports only the top-level result schema/type (one contract file, one result
// shape — its own template guidance). These sub-shapes are derived, not redeclared, purely so this
// app's component files can name them individually (same convention decision-inbox already uses
// for its own single-file contract).
export type CustomerProfileIdentity = CustomerProfileResult['identity'];
export type CustomerProfileContract = CustomerProfileResult['contracts'][number];
export type ReadinessFact = CustomerProfileResult['readiness'][number];
export type CustomerProfileFinance = CustomerProfileResult['finance'];
export type CustomerProfileProfitability = CustomerProfileResult['profitability'];

// Alias kept for this app's own naming (screen/constants files reference "item code"); backed by
// the real package's `ReadinessItemName`.
export type { ReadinessItemName as ReadinessItemCode } from '@pg-eos/contracts/sales/customer-profile';
