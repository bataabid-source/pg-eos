// modules/fleet/infrastructure/register-vehicle/logger.ts — WBS 3.1.
//
// infrastructure/ layer: implements ../../application/register-vehicle/ports.ts's `Logger` port as
// a thin adapter over the shared @pg-eos/logger package's portLogger — CLAUDE.md · AGENT
// CONSTRAINTS: "No console.log — pino." Wired by ../../api/register-vehicle/composition.ts as the
// default `logger` in RegisterVehicleDeps; a caller (tests) may inject a fixed/spy Logger instead.

import { portLogger } from '@pg-eos/logger';

import type { Logger } from '../../application/register-vehicle/ports.js';

export const registerVehiclePinoLogger: Logger = portLogger({ module: 'fleet', useCase: 'register-vehicle' });
