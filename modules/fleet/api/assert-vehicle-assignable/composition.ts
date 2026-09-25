// modules/fleet/api/assert-vehicle-assignable/composition.ts — WBS 3.1.
//
// Composition root for the assert-vehicle-assignable use case: the ONE place the real
// infrastructure adapters are wired to the application ports. The application layer
// (../../application/…) programs only against ports; the api layer (./handlers.ts) and tests build
// their deps here. No clock/id-generator deps here, unlike ../register-vehicle/composition.ts — this
// use case is a pure read-and-assert with no injected clock (`at` is caller input, brief).

import type { Logger, AssertVehicleAssignableDeps } from '../../application/assert-vehicle-assignable/ports.js';
import { assertVehicleAssignablePinoLogger } from '../../infrastructure/assert-vehicle-assignable/logger.js';
import { assignabilityRepository } from '../../infrastructure/assert-vehicle-assignable/repository.js';

/** `logger` defaults to the pino adapter
 *  (../../infrastructure/assert-vehicle-assignable/logger.ts) — a caller (tests) may inject a
 *  fixed/spy Logger instead. */
export function createAssertVehicleAssignableDeps(overrides?: {
  readonly logger?: Logger;
}): AssertVehicleAssignableDeps {
  return {
    repo: assignabilityRepository,
    logger: overrides?.logger ?? assertVehicleAssignablePinoLogger,
  };
}
