// modules/wms/infrastructure/manage-space/logger.ts — WBS 2.15 (lane 2).
//
// infrastructure/ layer: implements ../../application/manage-space/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." It never constructs its own root pino instance
// (@pg-eos/logger is the one place that happens). Wired by ../../api/manage-space/composition.ts
// as the default `logger` in ManageSpaceDeps; a caller (tests) may inject a fixed/spy Logger
// instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/manage-space/ports.js';

const child = childLogger({ module: 'wms', useCase: 'manage-space' });

export const manageSpacePinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
