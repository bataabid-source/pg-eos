// modules/hr/api/confirm-commission/composition.ts — WBS 3.13 part 4.
//
// Composition root for the confirm-commission use case: the ONE place the real infrastructure
// adapters are wired to the application ports.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { ConfirmCommissionDeps, Logger } from '../../application/confirm-commission/ports.js';
import { confirmCommissionPinoLogger } from '../../infrastructure/confirm-commission/logger.js';
import { commissionDailyRepository } from '../../infrastructure/confirm-commission/repository.js';

export function createConfirmCommissionDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ConfirmCommissionDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: commissionDailyRepository,
    logger: clockDeps.logger ?? confirmCommissionPinoLogger,
  };
}
