// modules/sales/infrastructure/manage-contract/logger.ts — WBS 1.7, M02 sales.
//
// infrastructure/ layer: implements ../../application/manage-contract/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/manage-contract/composition.ts as the
// default `logger` in ManageContractDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/manage-contract/ports.js';

const child = childLogger({ module: 'sales', useCase: 'manage-contract' });

export const manageContractPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
