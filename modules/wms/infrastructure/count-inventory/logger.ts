// modules/wms/infrastructure/count-inventory/logger.ts — WBS 2.13 (lane 2).
//
// infrastructure/ layer: implements ../../application/count-inventory/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/count-inventory/composition.ts as the
// default `logger` in CountInventoryDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/count-inventory/ports.js';

export const countInventoryPinoLogger: Logger = portLogger({ module: 'wms', useCase: 'count-inventory' });
