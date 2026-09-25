// modules/sales/api/customer-profile/composition.ts — WBS 1.9, M02 sales.
//
// Composition root for the customer-profile use case: the ONE place the real infrastructure
// adapter is wired to the application ports. The application layer (../../application/…) programs
// only against ports; tests build their deps here.
//
// No `clock`/`ids` (DEFAULT, pg-tester's own header comment): this slice is a pure read with
// nothing computed from time or randomness, unlike manage-contract/manage-account-credit's
// `createManageContractDeps({ clock, ids })`. `logger` defaults to a @pg-eos/logger child logger,
// same pattern as every other use case's composition root — a caller (tests) may inject a
// fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { CustomerProfileDeps, Logger } from '../../application/customer-profile/ports.js';
import { customerProfileRepository } from '../../infrastructure/customer-profile/repository.js';

const defaultLogger: Logger = childLogger({ module: 'sales', useCase: 'customer-profile' });

export function createCustomerProfileDeps(overrides?: { readonly logger?: Logger }): CustomerProfileDeps {
  return {
    repo: customerProfileRepository,
    logger: overrides?.logger ?? defaultLogger,
  };
}
