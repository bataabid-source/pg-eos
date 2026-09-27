// packages/contracts/index.ts — WBS 0.13. Public surface of the package (brief "Deliver" list).
//
// This is the one clean import surface later slices use. `registry` is the shared contract
// registry. Every module's own `ROUTES` (packages/contracts/<module>/<usecase>.ts) is registered
// here, once, at import time, via routes.ts's `registerRoutes` — the single place that decides
// nothing about any endpoint itself (each module's own contract file does), it only wires them
// together (Master task, docs/STREAMS.md §Enablement item 6). scripts/generate-openapi.ts and
// tests/openapi-document.test.ts both import this same instance so generation and the drift check
// are provably looking at the same data.
//
// Finding 13: re-exports the _shared/ and _harness/ barrels rather than hand-listing individual
// names, so a new export added to a leaf module reaches this public surface automatically.

import { ContractRegistry } from './_shared/registry.js';
import { registerRoutes } from './routes.js';

/** X part 5a (ADR-0006 §1): the host mounts every entry of this list; exported here so apps/ import it
 *  by package name, never by a dist path. */
export { ALL_ROUTES } from './routes.js';

export * from './_shared/index.js';
export * from './_harness/index.js';

/** The single shared contract registry — every module's routes are registered on it below. */
export const registry = new ContractRegistry();

registerRoutes(registry);
