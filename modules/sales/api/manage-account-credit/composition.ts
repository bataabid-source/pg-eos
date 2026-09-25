// modules/sales/api/manage-account-credit/composition.ts — WBS 1.8, M02 sales.
//
// Composition root for the manage-account-credit use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, ManageAccountCreditDeps } from '../../application/manage-account-credit/ports.js';
import { manageAccountCreditPinoLogger } from '../../infrastructure/manage-account-credit/logger.js';
import { accountCreditRepository } from '../../infrastructure/manage-account-credit/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/manage-account-credit/logger.ts) —
 *  a caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createManageAccountCreditDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ManageAccountCreditDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: accountCreditRepository,
    logger: clockDeps.logger ?? manageAccountCreditPinoLogger,
  };
}
