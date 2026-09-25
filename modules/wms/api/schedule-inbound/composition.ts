// modules/wms/api/schedule-inbound/composition.ts — WBS 2.9b (lane 2).
//
// Composition root for the schedule-inbound use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer
// (../../application/schedule-inbound/*) programs only against ports; the api layer
// (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, ScheduleInboundDeps } from '../../application/schedule-inbound/ports.js';
import { scheduleInboundPinoLogger } from '../../infrastructure/schedule-inbound/logger.js';
import { scheduleInboundRepository } from '../../infrastructure/schedule-inbound/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/schedule-inbound/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createScheduleInboundDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ScheduleInboundDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: scheduleInboundRepository,
    logger: clockDeps.logger ?? scheduleInboundPinoLogger,
  };
}
