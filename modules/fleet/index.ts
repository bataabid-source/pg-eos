// modules/fleet — package shell created by scripts/new-slice.sh (lane blocker (c), 2026-09-24),
// copied from the golden module's shell (modules/wms). Public barrel: every use case
// re-exports its application layer here. Never hand-made (CLAUDE.md · SPEED AND QUALITY).
//
// 3.1 part 1 (register-vehicle only) — assert-vehicle-assignable's own exports are deferred to
// part 2 and stay out of this barrel until that use case's own commit (docs/CHANGELOG.md, 3.1 part 1).
export * from './application/register-vehicle/index.js';
export * from './domain/register-vehicle/errors.js';
