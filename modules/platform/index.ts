// M00 platform — package shell created by WBS 0.4 (monorepo skeleton).
// The module's own surface is built by WBS 0.9–0.10 and 0.15–0.16; its hexagonal file tree is
// copied from the golden slice (WBS 2.9) by scripts/new-slice.sh — never hand-made (CLAUDE.md).
//
// WBS 5.13 part 1 (alert evaluation mechanism, doc 40 §B6 / doc 25 §1-§2): the two application
// commands and their typed domain errors — same public-surface pattern as
// modules/wms/index.ts's own golden-slice re-export.
export * from './application/evaluate-alerts/index.js';
export * from './domain/evaluate-alerts/errors.js';
