// modules/tms/api/create-delivery-task/composition.ts — WBS 3.4 part 1.
//
// Composition root for the create-delivery-task use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { CreateDeliveryTaskDeps, Logger } from '../../application/create-delivery-task/ports.js';
import { createDeliveryTaskPinoLogger } from '../../infrastructure/create-delivery-task/logger.js';
import { deliveryTasksRepository } from '../../infrastructure/create-delivery-task/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/create-delivery-task/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createCreateDeliveryTaskDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): CreateDeliveryTaskDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: deliveryTasksRepository,
    logger: clockDeps.logger ?? createDeliveryTaskPinoLogger,
  };
}
