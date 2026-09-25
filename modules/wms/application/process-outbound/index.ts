// modules/wms/application/process-outbound/index.ts — WBS 2.11 part 1.
//
// Barrel for the process-outbound use case's part-1 commands (application/ layer public surface).
// Allocate/GeneratePickList are part 2's own additions to this barrel.

export type {
  AccountCreditRow,
  AuditTarget,
  ClientQualificationRow,
  ClockDeps,
  ContractCheckRow,
  OrderLineRow,
  OrderRow,
  OrderUpdateColumns,
  OutboundOrderRepository,
  ProcessOutboundDeps,
  SkuCheckRow,
  StockAvailabilityRow,
  StockedLocationBlockRow,
  StockLotRow,
} from './ports.js';
export { createOutbound, type CreateOutboundInput, type CreateOutboundResult } from './create-outbound.js';
export { runOutboundChecks, type RunOutboundChecksInput, type RunOutboundChecksResult } from './run-outbound-checks.js';
export { approveOutbound, type ApproveOutboundInput, type ApproveOutboundResult } from './approve-outbound.js';
export { cancelOutbound, type CancelOutboundInput, type CancelOutboundResult } from './cancel-outbound.js';
