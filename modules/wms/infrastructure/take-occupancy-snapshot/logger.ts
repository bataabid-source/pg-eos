// modules/wms/infrastructure/take-occupancy-snapshot/logger.ts — WBS 2.14 (lane 2).
//
// infrastructure/ layer: implements ../../application/take-occupancy-snapshot/ports.ts's `Logger`
// port as a thin adapter over the shared @pg-eos/logger package's childLogger — CLAUDE.md ·
// AGENT CONSTRAINTS: "No console.log — pino." Wired by
// ../../api/take-occupancy-snapshot/composition.ts as the default `logger` in
// TakeOccupancySnapshotDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { childLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/take-occupancy-snapshot/ports.js';

const child = childLogger({ module: 'wms', useCase: 'take-occupancy-snapshot' });

export const takeOccupancySnapshotPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
