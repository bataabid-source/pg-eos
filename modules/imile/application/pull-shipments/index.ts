// modules/imile/application/pull-shipments/index.ts — WBS 3.14 (part 2).
//
// Barrel for the pull-shipments use case's ONE command (application/ layer public surface).

export type {
  ClockDeps,
  ExistingShipmentRow,
  ImilePortalPort,
  InsertAgentHealthParams,
  InsertedAgentHealthRow,
  InsertShipmentParams,
  Logger,
  PortalShipmentRecord,
  PullShipmentsDeps,
  ShipmentsRepository,
  UpdateShipmentIMileFieldsParams,
} from './ports.js';
export { pullShipments, type PullShipmentsInput, type PullShipmentsResult } from './pull-shipments.js';
