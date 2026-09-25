// modules/wms/api/take-occupancy-snapshot/composition.ts — WBS 2.14 (lane 2).
//
// Composition root for the take-occupancy-snapshot use case: the ONE place the real
// infrastructure adapters are wired to the application ports. The application layer
// (../../application/…) programs only against ports; the api layer (./handlers.ts) and tests
// build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, TakeOccupancySnapshotDeps } from '../../application/take-occupancy-snapshot/ports.js';
import { takeOccupancySnapshotPinoLogger } from '../../infrastructure/take-occupancy-snapshot/logger.js';
import { occupancySnapshotRepository } from '../../infrastructure/take-occupancy-snapshot/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/take-occupancy-snapshot/logger.ts)
 *  — a caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createTakeOccupancySnapshotDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): TakeOccupancySnapshotDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: occupancySnapshotRepository,
    logger: clockDeps.logger ?? takeOccupancySnapshotPinoLogger,
  };
}
