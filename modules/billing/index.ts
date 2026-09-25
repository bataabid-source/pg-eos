// modules/billing — package shell created by scripts/new-slice.sh (lane blocker (c), 2026-09-24),
// copied from the golden module's shell (modules/wms). Public barrel.
//
// RESCOPED (Master ruling, round-1 review finding 1 — FINAL): WBS 4.2 has no application/ or api/
// layer (billing.billable_events is written only by WBS 4.3's future system-actor subscribers,
// 01-Data-Model.sql:1047 P10) — the barrel re-exports the domain/ invariants + errors and the
// infrastructure/ repository port directly.
export * from './domain/record-billable-event/errors.js';
export * from './domain/record-billable-event/invariants.js';
export * from './infrastructure/record-billable-event/repository.js';
export * from './infrastructure/record-billable-event/logger.js';
