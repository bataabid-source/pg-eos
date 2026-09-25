// modules/fleet — package shell created by scripts/new-slice.sh (lane blocker (c), 2026-09-24),
// copied from the golden module's shell (modules/wms). Public barrel: every use case
// re-exports its application layer here. Never hand-made (CLAUDE.md · SPEED AND QUALITY).
//
// `Logger`/`LogFields` collide between register-vehicle's and assert-vehicle-assignable's own
// ports.ts (each use case declares its own port interface, D-179 use-case isolation) — aliased here
// on the second use case's re-export, same discipline `imile`'s own pull-shipments/
// evaluate-dtl-problem barrel already established for this exact collision (brief, Write ONLY line).
export * from './application/register-vehicle/index.js';
export * from './domain/register-vehicle/errors.js';

export {
  assertVehicleAssignable,
  type AssertVehicleAssignableInput,
  type AssignabilityRepository,
  type AssertVehicleAssignableDeps,
  type VehicleDocumentRow,
  type VehicleForAssignabilityCheck,
  type Logger as AssertVehicleAssignableLogger,
  type LogFields as AssertVehicleAssignableLogFields,
} from './application/assert-vehicle-assignable/index.js';
export * from './domain/assert-vehicle-assignable/errors.js';
