// modules/fleet/infrastructure/assert-vehicle-assignable/logger.ts — WBS 3.1.
//
// infrastructure/ layer: implements ../../application/assert-vehicle-assignable/ports.ts's
// `Logger` port as a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md
// · AGENT CONSTRAINTS: "No console.log — pino." Wired by
// ../../api/assert-vehicle-assignable/composition.ts as the default `logger` in
// AssertVehicleAssignableDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/assert-vehicle-assignable/ports.js';

export const assertVehicleAssignablePinoLogger: Logger = portLogger({ module: 'fleet', useCase: 'assert-vehicle-assignable' });
