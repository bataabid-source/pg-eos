// modules/imile/api/evaluate-dtl-problem/composition.ts — WBS 3.17 (part 1).
//
// Composition root for the evaluate-dtl-problem use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; this file and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { DtlContentAnalysisPort, EvaluateDtlProblemDeps, Logger } from '../../application/evaluate-dtl-problem/ports.js';
import { evaluateDtlProblemPinoLogger } from '../../infrastructure/evaluate-dtl-problem/logger.js';
import { NotConfiguredDtlContentAnalysisPort } from '../../infrastructure/evaluate-dtl-problem/content-analysis-adapter.js';
import { dtlProblemsRepository } from '../../infrastructure/evaluate-dtl-problem/repository.js';

/** `logger` defaults to the pino adapter; `port` defaults to the
 *  `NotConfiguredDtlContentAnalysisPort` (the production wiring default — brief) — a caller
 *  (tests) may inject a fixed/spy Logger or a fixed DtlContentAnalysisPort instead, same optional-
 *  override pattern already used for `clock`/`ids`. */
export function createEvaluateDtlProblemDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
  readonly port?: DtlContentAnalysisPort;
}): EvaluateDtlProblemDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: dtlProblemsRepository,
    logger: clockDeps.logger ?? evaluateDtlProblemPinoLogger,
    port: clockDeps.port ?? new NotConfiguredDtlContentAnalysisPort(),
  };
}
