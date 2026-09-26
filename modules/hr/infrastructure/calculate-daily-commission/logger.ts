// modules/hr/infrastructure/calculate-daily-commission/logger.ts — WBS 3.13 part 2.
//
// infrastructure/ layer: implements ../../application/calculate-daily-commission/ports.ts's
// `Logger` port as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md
// · AGENT CONSTRAINTS: "No console.log — pino." Shape copied from register-employee's own
// logger.ts. Wired by ../../api/calculate-daily-commission/composition.ts as the default `logger`
// in CalculateDailyCommissionDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/calculate-daily-commission/ports.js';

const child = childLogger({ module: 'hr', useCase: 'calculate-daily-commission' });

export const calculateDailyCommissionPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
