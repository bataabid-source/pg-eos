// modules/sales/api/manage-contract/composition.ts — WBS 1.7, M02 sales.
//
// Composition root for the manage-contract use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, ManageContractDeps } from '../../application/manage-contract/ports.js';
import { manageContractPinoLogger } from '../../infrastructure/manage-contract/logger.js';
import { contractRepository } from '../../infrastructure/manage-contract/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/manage-contract/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createManageContractDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ManageContractDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: contractRepository,
    logger: clockDeps.logger ?? manageContractPinoLogger,
  };
}
