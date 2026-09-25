// modules/wms/application/manage-space/index.ts — WBS 2.15 (lane 2).
//
// Barrel for the manage-space use case's two commands (application/ layer public surface).

export type { ClockDeps, Logger, LogFields, ManageSpaceDeps, ManageSpaceRepository } from './ports.js';
export { allocateSpace, type AllocateSpaceInput, type AllocateSpaceResult } from './allocate-space.js';
export { reserveSpace, type ReserveSpaceInput, type ReserveSpaceResult } from './reserve-space.js';
