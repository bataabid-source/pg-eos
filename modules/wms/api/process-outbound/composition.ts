// modules/wms/api/process-outbound/composition.ts — WBS 2.11 part 1, following
// ../../api/receive-inbound/composition.ts (golden slice).
//
// Composition root for the process-outbound use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer
// (../../application/process-outbound/*) programs only against ports; the api layer
// (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, ProcessOutboundDeps } from '../../application/process-outbound/ports.js';
import { processOutboundPinoLogger } from '../../infrastructure/process-outbound/logger.js';
import { outboundOrderRepository } from '../../infrastructure/process-outbound/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/process-outbound/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createProcessOutboundDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ProcessOutboundDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: outboundOrderRepository,
    logger: clockDeps.logger ?? processOutboundPinoLogger,
  };
}
