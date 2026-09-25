// modules/sales/infrastructure/manage-account-credit/logger.ts — WBS 1.8, M02 sales.
//
// infrastructure/ layer: implements ../../application/manage-account-credit/ports.ts's `Logger`
// port as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by
// ../../api/manage-account-credit/composition.ts as the default `logger` in
// ManageAccountCreditDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/manage-account-credit/ports.js';

const child = childLogger({ module: 'sales', useCase: 'manage-account-credit' });

export const manageAccountCreditPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
