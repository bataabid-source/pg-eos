// modules/imile/api/assign-driver-id/composition.ts — WBS 3.12.
//
// Composition root for the assign-driver-id use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; this file and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { AssignDriverIdDeps, Logger } from '../../application/assign-driver-id/ports.js';
import { assignDriverIdPinoLogger } from '../../infrastructure/assign-driver-id/logger.js';
import { driverIdAssignmentsRepository } from '../../infrastructure/assign-driver-id/repository.js';

/** `logger` defaults to the pino adapter — a caller (tests) may inject a fixed/spy Logger instead,
 *  same optional-override pattern already used for `clock`/`ids`. */
export function createAssignDriverIdDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): AssignDriverIdDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: driverIdAssignmentsRepository,
    logger: clockDeps.logger ?? assignDriverIdPinoLogger,
  };
}
