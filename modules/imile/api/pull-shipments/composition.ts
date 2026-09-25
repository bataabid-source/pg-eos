// modules/imile/api/pull-shipments/composition.ts — WBS 3.14 (part 2).
//
// Composition root for the pull-shipments use case: the ONE place the real infrastructure
// adapters are wired to the application ports. The application layer (../../application/…)
// programs only against ports; this file and tests build their deps here.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';

import type { ImilePortalPort, Logger, PullShipmentsDeps } from '../../application/pull-shipments/ports.js';
import { pullShipmentsPinoLogger } from '../../infrastructure/pull-shipments/logger.js';
import { NotConfiguredImilePortalAdapter } from '../../infrastructure/pull-shipments/portal-adapter.js';
import { shipmentsRepository } from '../../infrastructure/pull-shipments/repository.js';

/** `logger` defaults to the pino adapter; `portal` defaults to the `NotConfiguredImilePortalAdapter`
 *  (the production wiring default — brief) — a caller (tests) may inject a fixed/spy Logger or a
 *  fixed ImilePortalPort instead, same pattern as `clock`/`ids`. `onBeforeUpdate` is a test-only
 *  seam (reviewer finding 9) — production callers never provide it, so it defaults to `undefined`
 *  and production behavior is unchanged. */
export function createPullShipmentsDeps(clockDeps: {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: Logger;
  readonly portal?: ImilePortalPort;
  readonly onBeforeUpdate?: () => Promise<void>;
}): PullShipmentsDeps {
  return {
    clock: clockDeps.clock,
    ids: clockDeps.ids,
    repo: shipmentsRepository,
    logger: clockDeps.logger ?? pullShipmentsPinoLogger,
    portal: clockDeps.portal ?? new NotConfiguredImilePortalAdapter(),
    onBeforeUpdate: clockDeps.onBeforeUpdate,
  };
}
