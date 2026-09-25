// modules/sales/application/customer-profile/index.ts — WBS 1.9, M02 sales.
//
// Barrel for the customer-profile use case's one query (application/ layer public surface).

export type { CustomerProfileDeps, Logger } from './ports.js';
export {
  getCustomerProfile,
  type GetCustomerProfileInput,
  type CustomerProfileResult,
  type CustomerProfileIdentity,
  type CustomerProfileContract,
  type CustomerProfileReadinessItem,
  type CustomerProfileFinance,
  type ReadinessItemName,
} from './get-customer-profile.js';
