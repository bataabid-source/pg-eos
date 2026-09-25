// modules/wms/infrastructure/schedule-inbound/logger.ts — WBS 2.9b (lane 2).
//
// infrastructure/ layer: implements ../../application/schedule-inbound/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." It never constructs its own root pino instance
// (@pg-eos/logger is the one place that happens). Wired by
// ../../api/schedule-inbound/composition.ts as the default `logger` in ScheduleInboundDeps; a
// caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/schedule-inbound/ports.js';

const child = childLogger({ module: 'wms', useCase: 'schedule-inbound' });

export const scheduleInboundPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
