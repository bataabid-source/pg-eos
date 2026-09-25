// modules/wms/infrastructure/process-outbound/logger.ts — WBS 2.11 part 1, following
// ../../infrastructure/receive-inbound/logger.ts (golden slice).
//
// infrastructure/ layer: implements ../../application/process-outbound/ports.ts's `Logger` port
// as a thin adapter over @pg-eos/logger's childLogger — CLAUDE.md · AGENT CONSTRAINTS: "No
// console.log — pino." Wired by ../../api/process-outbound/composition.ts as the default `logger`
// in ProcessOutboundDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/process-outbound/ports.js';

const child = childLogger({ module: 'wms', useCase: 'process-outbound' });

export const processOutboundPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
