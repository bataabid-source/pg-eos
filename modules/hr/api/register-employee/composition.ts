// modules/hr/api/register-employee/composition.ts — WBS 3.3.
//
// Composition root for the register-employee use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; the api layer (./handlers.ts) and tests build their deps here.
// Shape copied from the golden slice's own composition.ts (modules/wms/api/receive-inbound/
// composition.ts).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { Logger, RegisterEmployeeDeps } from '../../application/register-employee/ports.js';
import { registerEmployeePinoLogger } from '../../infrastructure/register-employee/logger.js';
import { employeeRepository } from '../../infrastructure/register-employee/repository.js';

/** `logger` defaults to the pino adapter (../../infrastructure/register-employee/logger.ts) — a
 *  caller (tests) may inject a fixed/spy Logger instead, same pattern as `clock`/`ids`. */
export function createRegisterEmployeeDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
}): RegisterEmployeeDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: employeeRepository,
    logger: clockDeps.logger ?? registerEmployeePinoLogger,
  };
}
