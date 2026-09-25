// modules/wms/infrastructure/count-inventory/logger.ts — WBS 2.13 (lane 2).
//
// infrastructure/ layer: implements ../../application/count-inventory/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/count-inventory/composition.ts as the
// default `logger` in CountInventoryDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/count-inventory/ports.js';

const child = childLogger({ module: 'wms', useCase: 'count-inventory' });

export const countInventoryPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
