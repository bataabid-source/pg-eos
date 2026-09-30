// modules/tms/infrastructure/create-delivery-task/logger.ts — WBS 3.4 part 1.
//
// infrastructure/ layer: implements ../../application/create-delivery-task/ports.ts's `Logger` port
// as a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/create-delivery-task/composition.ts as
// the default `logger` in CreateDeliveryTaskDeps; a caller (tests) may inject a spy instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/create-delivery-task/ports.js';

export const createDeliveryTaskPinoLogger: Logger = portLogger({ module: 'tms', useCase: 'create-delivery-task' });
