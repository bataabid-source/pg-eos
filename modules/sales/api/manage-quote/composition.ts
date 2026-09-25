// modules/sales/api/manage-quote/composition.ts — WBS 1.6, M02 sales.
//
// Composition root for the manage-quote use case: the ONE place the real infrastructure adapters
// are wired to the application ports. The application layer (../../application/…) programs only
// against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, ManageQuoteDeps } from '../../application/manage-quote/ports.js';
import { manageQuotePinoLogger } from '../../infrastructure/manage-quote/logger.js';
import { quoteRepository } from '../../infrastructure/manage-quote/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/manage-quote/logger.ts) — a caller
 *  (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createManageQuoteDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ManageQuoteDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: quoteRepository,
    logger: clockDeps.logger ?? manageQuotePinoLogger,
  };
}
