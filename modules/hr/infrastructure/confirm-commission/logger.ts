// modules/hr/infrastructure/confirm-commission/logger.ts — WBS 3.13 part 4.
//
// infrastructure/ layer: implements ../../application/confirm-commission/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino."

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/confirm-commission/ports.js';

export const confirmCommissionPinoLogger: Logger = portLogger({ module: 'hr', useCase: 'confirm-commission' });
