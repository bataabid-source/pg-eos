// modules/hr — package shell created by scripts/new-slice.sh (lane blocker (c), 2026-09-24),
// copied from the golden module's shell (modules/wms). Public barrel: every use case re-exports
// its application layer and typed domain errors here, same shape as modules/wms/index.ts. Never
// hand-made (CLAUDE.md · SPEED AND QUALITY).
export * from './application/register-employee/index.js';
export * from './domain/register-employee/errors.js';
