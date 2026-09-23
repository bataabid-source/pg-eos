// M04 warehouse (wms) — package shell created by WBS 2.1 (proof slice, replicating the WBS 0.4
// monorepo skeleton pattern used for modules/platform and modules/identity).
// The module's own surface is built by later WBS 2.x tasks; its hexagonal file tree is copied
// from the golden slice (WBS 2.9) by scripts/new-slice.sh — never hand-made (CLAUDE.md).
//
// WBS 2.8 is a mechanism slice (precedent 0.17): no endpoint/UI/XState exists yet, so its code
// lives flat under src/stock-ledger/ instead of a hexagonal tree (brief docs/notes/
// slice-briefs/_slice-2.8.brief.md, "Type of slice"). Re-exported here — the module's public barrel — per the
// brief's Public surface block.
export * from './src/stock-ledger/index.js';

// WBS 2.6 is a mechanism slice (precedent WBS 2.8, WBS 0.17): the schema already delivers
// wms.skus (01-Data-Model.sql); this re-exports the registration mechanism built flat under
// src/sku-registration/ (brief docs/notes/slice-briefs/_slice-2.6.brief.md, "Type of slice").
export * from './src/sku-registration/index.js';
