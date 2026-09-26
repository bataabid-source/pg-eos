// modules/wms/infrastructure/take-occupancy-snapshot/logger.ts — WBS 2.14 (lane 2).
//
// infrastructure/ layer: implements ../../application/take-occupancy-snapshot/ports.ts's `Logger`
// port as a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md ·
// AGENT CONSTRAINTS: "No console.log — pino." Wired by
// ../../api/take-occupancy-snapshot/composition.ts as the default `logger` in
// TakeOccupancySnapshotDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/take-occupancy-snapshot/ports.js';

export const takeOccupancySnapshotPinoLogger: Logger = portLogger({ module: 'wms', useCase: 'take-occupancy-snapshot' });
