// modules/sales — package shell created by WBS 1.5 (proof slice, ADR-0001).
// Proof slice: data model + seed only (fixtures created/removed by the proof suite), no UI, no
// workflow, no public API — docs/adr/ADR-0001-1.5-proof-slice.md.
//
// WBS 1.4 is a mechanism slice (precedent WBS 2.8): a read-only pricing-resolution engine with no
// API endpoint and no state machine (slice brief docs/notes/slice-briefs/_slice-1.4.brief.md,
// "Scope taken by the lane"). Re-exported here — the module's public barrel — per the brief's
// Deliver list.
export * from './application/resolve-price/index.js';
export * from './domain/resolve-price/errors.js';
export * from './domain/resolve-price/tiered-pricing.js';
