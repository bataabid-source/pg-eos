// modules/platform/infrastructure/maintain-site/logger.ts — WBS 5.5a part 1 (lane 2).
//
// infrastructure/ layer: implements ../../application/maintain-site/ports.ts's `Logger` port as a
// thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Shape copied from the hr/register-employee precedent
// (modules/hr/infrastructure/register-employee/logger.ts). Wired by
// ../../api/maintain-site/composition.ts as the default `logger` in MaintainSiteDeps; a caller
// (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/maintain-site/ports.js';

const child = childLogger({ module: 'platform', useCase: 'maintain-site' });

export const maintainSitePinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
