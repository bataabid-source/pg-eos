// modules/wms/api/manage-space/composition.ts — WBS 2.15 (lane 2).
//
// Composition root for the manage-space use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, ManageSpaceDeps } from '../../application/manage-space/ports.js';
import { manageSpacePinoLogger } from '../../infrastructure/manage-space/logger.js';
import { manageSpaceRepository } from '../../infrastructure/manage-space/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/manage-space/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createManageSpaceDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ManageSpaceDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: manageSpaceRepository,
    logger: clockDeps.logger ?? manageSpacePinoLogger,
  };
}
