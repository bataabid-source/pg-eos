// packages/contracts/index.ts — WBS 0.13. Public surface of the package (brief "Deliver" list).
//
// This is the one clean import surface later slices use. `registry` is the shared, empty contract
// registry: no business route is authored here (brief — "Nothing else about any endpoint is
// decided here"). Module contracts register their own routes here from their own WBS tasks (0.9
// on). scripts/generate-openapi.ts and tests/openapi-document.test.ts both import this same
// instance so generation and the drift check are provably looking at the same data.
//
// Finding 13: re-exports the _shared/ and _harness/ barrels rather than hand-listing individual
// names, so a new export added to a leaf module reaches this public surface automatically.

import { ContractRegistry } from './_shared/registry.js';

export * from './_shared/index.js';
export * from './_harness/index.js';

/** The single shared contract registry (empty — see module comment above). */
export const registry = new ContractRegistry();
