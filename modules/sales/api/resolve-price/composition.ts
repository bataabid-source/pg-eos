// modules/sales/api/resolve-price/composition.ts — WBS 1.4, M02 sales pricing engine.
//
// Composition root for the resolve-price use case: the ONE place the real infrastructure adapter
// is wired to the application port. No API endpoint exists yet (slice brief "Scope taken by the
// lane") — this is the module's public surface for a future caller (e.g. a billing job). Takes no
// clock/id args: `asOfDate` is always supplied explicitly by the caller (Master decision 1) and
// this engine performs no writes, so no IdGenerator is needed either.

import type { ResolvePriceDeps } from '../../application/resolve-price/ports.js';
import { pricingRepository } from '../../infrastructure/resolve-price/repository.js';

export function createResolvePriceDeps(): ResolvePriceDeps {
  return {
    repo: pricingRepository,
  };
}
