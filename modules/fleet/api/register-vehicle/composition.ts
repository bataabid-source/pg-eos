// modules/fleet/api/register-vehicle/composition.ts — WBS 3.1.
//
// Composition root for the register-vehicle use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, RegisterVehicleDeps } from '../../application/register-vehicle/ports.js';
import { registerVehiclePinoLogger } from '../../infrastructure/register-vehicle/logger.js';
import { vehiclesRepository } from '../../infrastructure/register-vehicle/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/register-vehicle/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createRegisterVehicleDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): RegisterVehicleDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: vehiclesRepository,
    logger: clockDeps.logger ?? registerVehiclePinoLogger,
  };
}
