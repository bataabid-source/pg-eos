// WBS 1.9 — mock CustomerProfileClient implementation (brief Scope: "No backend HTTP endpoint;
// the UI uses a mock client" — same precedent as WBS 0.19). No client.ts file this slice (the
// Deliver list names none) — the port type lives here, the one file that needs it, mirroring
// decision-inbox's DecisionsClient shape.
import { CustomerProfileResultSchema } from './contract';
import type { CustomerProfileResult } from './contract';
import { DEMO_ACCOUNT_ID } from './constants';

export interface CustomerProfileClient {
  getCustomerProfile(accountId: string): Promise<CustomerProfileResult>;
}

// SOME gaps open — the default "/customers/:accountId" route's fixture. Literal values dictated by
// pg-tester (apps/admin/tests/customer-profile/customer-profile.test.tsx header comment).
const MOCK_PROFILE: CustomerProfileResult = {
  identity: {
    accountId: DEMO_ACCOUNT_ID,
    code: 'ACC-360-DEMO',
    nameAr: 'شركة ديمو للتجارة',
    nameEn: 'Demo Trading Co.',
    segmentCode: 'SEG-A',
    segmentNameAr: 'استراتيجي',
    ownerUserId: null,
    ownerNameAr: null,
  },
  contracts: [
    {
      contractId: 'aaaaaaaa-0000-4000-8000-000000000001',
      entityCode: 'PST',
      status: 'active',
      startDate: '2026-01-01',
      endDate: null,
      hasPriceList: true,
    },
    {
      contractId: 'aaaaaaaa-0000-4000-8000-000000000002',
      entityCode: 'PDL',
      status: 'draft',
      startDate: '2025-06-01',
      endDate: null,
      hasPriceList: false,
    },
  ],
  readiness: [
    { item: 'cr_number', present: true, owner: 'CFO' },
    { item: 'credit_limit', present: true, owner: 'CFO' },
    { item: 'segment', present: true, owner: 'CFO' },
    { item: 'payment_terms', present: false, owner: 'CFO' },
    { item: 'priced_contract', present: true, owner: 'CFO' },
  ],
  finance: { creditLimit: '5000.000', creditHold: true, holdReason: 'overdue' },
  profitability: { available: false },
};

// ALL gaps closed — scenario 3 only ("all clear" positive state).
const READY_PROFILE: CustomerProfileResult = {
  ...MOCK_PROFILE,
  readiness: MOCK_PROFILE.readiness.map((fact) => ({ ...fact, present: true })),
  finance: { creditLimit: '5000.000', creditHold: false, holdReason: null },
};

// Dev-time contract check (same convention as decision-inbox's mock-client): parse the fixture
// through the same schema a real payload would go through.
export const mockClient: CustomerProfileClient = {
  getCustomerProfile: () => Promise.resolve(CustomerProfileResultSchema.parse(MOCK_PROFILE)),
};

export const readyMockClient: CustomerProfileClient = {
  getCustomerProfile: () => Promise.resolve(CustomerProfileResultSchema.parse(READY_PROFILE)),
};
