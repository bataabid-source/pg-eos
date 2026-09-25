// modules/imile/infrastructure/evaluate-dtl-problem/logger.ts — WBS 3.17 (part 1).
//
// infrastructure/ layer: implements ../../application/evaluate-dtl-problem/ports.ts's `Logger`
// port as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/evaluate-dtl-problem/composition.ts as
// the default `logger` in EvaluateDtlProblemDeps; a caller (tests) may inject a fixed/spy Logger
// instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/evaluate-dtl-problem/ports.js';

const child = childLogger({ module: 'imile', useCase: 'evaluate-dtl-problem' });

export const evaluateDtlProblemPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
