// modules/imile/application/assign-driver-id/index.ts — WBS 3.12.
//
// Barrel for the assign-driver-id use case's ONE command (application/ layer public surface).

export type {
  AssignDriverIdDeps,
  ClockDeps,
  DriverIdAssignmentsRepository,
  DriverIdStatusRow,
  InsertAssignmentColumns,
  InsertedAssignmentRow,
  LogFields,
  Logger,
} from './ports.js';
export {
  assignDriverId,
  type AssignDriverIdInput,
  type AssignDriverIdResult,
} from './assign-driver-id.js';
