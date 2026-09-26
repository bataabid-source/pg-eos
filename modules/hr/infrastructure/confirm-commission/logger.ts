// modules/hr/infrastructure/confirm-commission/logger.ts — WBS 3.13 part 4.
//
// infrastructure/ layer: implements ../../application/confirm-commission/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino."

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/confirm-commission/ports.js';

const child = childLogger({ module: 'hr', useCase: 'confirm-commission' });

export const confirmCommissionPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
