// modules/wms/api/count-inventory/composition.ts — WBS 2.13 (lane 2).
//
// Composition root for the count-inventory use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { CountInventoryDeps, Logger } from '../../application/count-inventory/ports.js';
import { countInventoryLedgerPort } from '../../infrastructure/count-inventory/ledger.js';
import { countInventoryPinoLogger } from '../../infrastructure/count-inventory/logger.js';
import { countInventoryRepository } from '../../infrastructure/count-inventory/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/count-inventory/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createCountInventoryDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): CountInventoryDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: countInventoryRepository,
    ledger: countInventoryLedgerPort,
    logger: clockDeps.logger ?? countInventoryPinoLogger,
  };
}
