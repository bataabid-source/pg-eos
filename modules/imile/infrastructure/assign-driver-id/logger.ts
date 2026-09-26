// modules/imile/infrastructure/assign-driver-id/logger.ts — WBS 3.12.
//
// infrastructure/ layer: implements ../../application/assign-driver-id/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/assign-driver-id/composition.ts as the
// default `logger` in AssignDriverIdDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/assign-driver-id/ports.js';

export const assignDriverIdPinoLogger: Logger = portLogger({ module: 'imile', useCase: 'assign-driver-id' });
