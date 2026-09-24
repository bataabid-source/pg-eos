// modules/imile/api/report-agent-health/composition.ts — WBS 3.14.
//
// Composition root for the report-agent-health use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, ReportAgentHealthDeps } from '../../application/report-agent-health/ports.js';
import { agentHealthPinoLogger } from '../../infrastructure/report-agent-health/logger.js';
import { agentHealthRepository } from '../../infrastructure/report-agent-health/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/report-agent-health/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createReportAgentHealthDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): ReportAgentHealthDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: agentHealthRepository,
    logger: clockDeps.logger ?? agentHealthPinoLogger,
  };
}
