// modules/platform/api/maintain-site/composition.ts — WBS 5.5a part 1 (lane 2).
//
// Composition root for the maintain-site use case: the ONE place the real infrastructure adapters
// are wired to the application ports. The application layer (../../application/…) programs only
// against ports; the api layer (./handlers.ts) and tests build their deps here. Shape copied from
// the hr/register-employee precedent (modules/hr/api/register-employee/composition.ts).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, MaintainSiteDeps } from '../../application/maintain-site/ports.js';
import { maintainSitePinoLogger } from '../../infrastructure/maintain-site/logger.js';
import { siteRepository } from '../../infrastructure/maintain-site/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/maintain-site/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createMaintainSiteDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): MaintainSiteDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: siteRepository,
    logger: clockDeps.logger ?? maintainSitePinoLogger,
  };
}
