// modules/hr/infrastructure/calculate-daily-commission/logger.ts — WBS 3.13 part 2.
//
// infrastructure/ layer: implements ../../application/calculate-daily-commission/ports.ts's
// `Logger` port as a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md
// · AGENT CONSTRAINTS: "No console.log — pino." Shape copied from register-employee's own
// logger.ts. Wired by ../../api/calculate-daily-commission/composition.ts as the default `logger`
// in CalculateDailyCommissionDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/calculate-daily-commission/ports.js';

export const calculateDailyCommissionPinoLogger: Logger = portLogger({ module: 'hr', useCase: 'calculate-daily-commission' });
