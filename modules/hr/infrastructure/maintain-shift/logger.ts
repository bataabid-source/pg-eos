// modules/hr/infrastructure/maintain-shift/logger.ts — WBS 5.5a part 2 (lane 2).
//
// infrastructure/ layer: implements ../../application/maintain-shift/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Shape copied from the platform/maintain-site precedent
// (../../../platform/infrastructure/maintain-site/logger.ts). Wired by
// ../../api/maintain-shift/composition.ts as the default `logger` in MaintainShiftDeps; a caller
// (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/maintain-shift/ports.js';

const child = childLogger({ module: 'hr', useCase: 'maintain-shift' });

export const maintainShiftPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
