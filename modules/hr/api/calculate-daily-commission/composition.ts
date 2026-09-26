// modules/hr/api/calculate-daily-commission/composition.ts — WBS 3.13 part 2.
//
// Composition root for the calculate-daily-commission use case: the ONE place the real
// infrastructure adapters are wired to the application ports. The application layer
// (../../application/…) programs only against ports; this file and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { CalculateDailyCommissionDeps, Logger } from '../../application/calculate-daily-commission/ports.js';
import { calculateDailyCommissionPinoLogger } from '../../infrastructure/calculate-daily-commission/logger.js';
import { commissionDailyRepository } from '../../infrastructure/calculate-daily-commission/repository.js';

/** `logger` defaults to the pino adapter — a caller (tests) may inject a fixed/spy Logger instead,
 *  same optional-override pattern already used for `clock`/`ids`. */
export function createCalculateDailyCommissionDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): CalculateDailyCommissionDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: commissionDailyRepository,
    logger: clockDeps.logger ?? calculateDailyCommissionPinoLogger,
  };
}
