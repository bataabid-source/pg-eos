// modules/sales/infrastructure/manage-quote/logger.ts — WBS 1.6, M02 sales.
//
// infrastructure/ layer: implements ../../application/manage-quote/ports.ts's `Logger` port as a
// thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/manage-quote/composition.ts as the
// default `logger` in ManageQuoteDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/manage-quote/ports.js';

const child = childLogger({ module: 'sales', useCase: 'manage-quote' });

export const manageQuotePinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
