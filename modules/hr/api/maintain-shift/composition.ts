// modules/hr/api/maintain-shift/composition.ts — WBS 5.5a part 2 (lane 2).
//
// Composition root for the maintain-shift use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.
// Shape copied from the platform/maintain-site precedent (../../../platform/api/maintain-site/
// composition.ts).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, MaintainShiftDeps } from '../../application/maintain-shift/ports.js';
import { maintainShiftPinoLogger } from '../../infrastructure/maintain-shift/logger.js';
import { shiftRepository } from '../../infrastructure/maintain-shift/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/maintain-shift/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createMaintainShiftDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): MaintainShiftDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: shiftRepository,
    logger: clockDeps.logger ?? maintainShiftPinoLogger,
  };
}
