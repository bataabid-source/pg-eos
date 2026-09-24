// modules/catalog/api/maintain-price-list/composition.ts — WBS 1.2, M03 catalog.
//
// Composition root for the maintain-price-list use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, MaintainPriceListDeps } from '../../application/maintain-price-list/ports.js';
import { priceListPinoLogger } from '../../infrastructure/maintain-price-list/logger.js';
import { priceListRepository } from '../../infrastructure/maintain-price-list/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/maintain-price-list/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createMaintainPriceListDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): MaintainPriceListDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: priceListRepository,
    logger: clockDeps.logger ?? priceListPinoLogger,
  };
}
