// WBS 1.9 — named constants (CLAUDE.md AGENT CONSTRAINTS: no magic numbers).
import type { ReadinessItemCode } from './contract';

// The one fixed demo accountId this slice navigates to (Master decision 9 — no customer
// search/list this slice). Literal value dictated by pg-tester's fixture
// (apps/admin/tests/customer-profile/customer-profile.test.tsx header comment).
export const DEMO_ACCOUNT_ID = '55555555-5555-4555-8555-555555555555';

// Tab order fixed by Master decision 8: Contracts, Finance, Profitability, in that order.
export const CUSTOMER_PROFILE_TABS = ['contracts', 'finance', 'profitability'] as const;
export type CustomerProfileTab = (typeof CUSTOMER_PROFILE_TABS)[number];

export const DEFAULT_CUSTOMER_PROFILE_TAB: CustomerProfileTab = 'contracts';

// TanStack Query cache key root for the Customer Profile query.
export const CUSTOMER_PROFILE_QUERY_KEY = 'customer-profile' as const;

// The five readiness items, in the order Master decision 2 lists them.
export const READINESS_ITEM_ORDER: readonly ReadinessItemCode[] = [
  'cr_number',
  'credit_limit',
  'segment',
  'payment_terms',
  'priced_contract',
];
