// modules/fleet/application/register-vehicle/index.ts — WBS 3.1.
//
// Barrel for the register-vehicle use case (application/ layer public surface).

export type { ClockDeps, Logger, LogFields, VehiclesRepository, RegisterVehicleDeps } from './ports.js';
export { registerVehicle, type RegisterVehicleInput, type RegisterVehicleResult } from './register-vehicle.js';
