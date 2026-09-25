// modules/fleet/application/assert-vehicle-assignable/index.ts — WBS 3.1.
//
// Barrel for the assert-vehicle-assignable use case (application/ layer public surface).

export type {
  Logger,
  LogFields,
  AssignabilityRepository,
  AssertVehicleAssignableDeps,
  VehicleDocumentRow,
  VehicleForAssignabilityCheck,
} from './ports.js';
export { assertVehicleAssignable, type AssertVehicleAssignableInput } from './assert-vehicle-assignable.js';
