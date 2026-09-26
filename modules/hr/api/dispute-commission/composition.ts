// modules/hr/api/dispute-commission/composition.ts — WBS 3.13 part 4.
//
// Composition root for the dispute-commission use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; this file and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { DisputeCommissionDeps, Logger } from '../../application/dispute-commission/ports.js';
import { disputeCommissionPinoLogger } from '../../infrastructure/dispute-commission/logger.js';
import { commissionDailyRepository } from '../../infrastructure/dispute-commission/repository.js';

/** `logger` defaults to the pino adapter — a caller (tests) may inject a fixed/spy Logger instead,
 *  same optional-override pattern already used for `clock`/`ids`. */
export function createDisputeCommissionDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): DisputeCommissionDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: commissionDailyRepository,
    logger: clockDeps.logger ?? disputeCommissionPinoLogger,
  };
}
