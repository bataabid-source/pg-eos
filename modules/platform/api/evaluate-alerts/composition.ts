// modules/platform/api/evaluate-alerts/composition.ts — WBS 5.13 part 1, replicated (shape only)
// from the golden slice's composition.ts. The ONE place the real infrastructure adapters are
// wired to the application ports. The application layer (../../application/…) programs only
// against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { EvaluateAlertsDeps, Logger } from '../../application/evaluate-alerts/ports.js';
import { alertsPinoLogger } from '../../infrastructure/evaluate-alerts/logger.js';
import { alertRuleRepository } from '../../infrastructure/evaluate-alerts/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/evaluate-alerts/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createEvaluateAlertsDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): EvaluateAlertsDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: alertRuleRepository,
    logger: clockDeps.logger ?? alertsPinoLogger,
  };
}
