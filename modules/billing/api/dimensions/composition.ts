// modules/billing/api/dimensions/composition.ts — WBS 4.1b PART 2 (lane 2).
//
// Composition root for the dimensions use case: the ONE place the real infrastructure adapter is
// wired to the application ports (golden slice: modules/wms/api/receive-inbound/composition.ts).
// The HTTP handlers (./handlers.ts) are 4.1b part 3 (R5) — tests build their deps here.

import type { Clock } from '@pg-eos/domain-kit';

import type { DimensionsDeps } from '../../application/dimensions/ports.js';
import { dimensionValueRepository } from '../../infrastructure/dimensions/repository.js';

export function createDimensionsDeps(clockDeps: { readonly clock: Clock }): DimensionsDeps {
  return {
    clock: clockDeps.clock,
    repo: dimensionValueRepository,
  };
}
