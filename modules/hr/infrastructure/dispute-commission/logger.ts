// modules/hr/infrastructure/dispute-commission/logger.ts — WBS 3.13 part 4.
//
// infrastructure/ layer: implements ../../application/dispute-commission/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Shape copied from calculate-daily-commission's own
// logger.ts.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/dispute-commission/ports.js';

export const disputeCommissionPinoLogger: Logger = portLogger({ module: 'hr', useCase: 'dispute-commission' });
