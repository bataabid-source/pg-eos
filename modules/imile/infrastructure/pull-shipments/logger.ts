// modules/imile/infrastructure/pull-shipments/logger.ts — WBS 3.14 (part 2).
//
// infrastructure/ layer: implements ../../application/pull-shipments/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by
// ../../api/pull-shipments/composition.ts as the default `logger` in PullShipmentsDeps; a
// caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/pull-shipments/ports.js';

const child = childLogger({ module: 'imile', useCase: 'pull-shipments' });

export const pullShipmentsPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
