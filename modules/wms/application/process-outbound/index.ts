// modules/wms/application/process-outbound/index.ts — WBS 2.11 part 1 + part 2.
//
// Barrel for the process-outbound use case's commands (application/ layer public surface).
// Allocate/GeneratePickList are part 2's own additions to this barrel (_slice-2.11.brief.md
// part 2, Master decisions 2/3).

export type {
  AccountCreditRow,
  AllocationLineRow,
  AuditTarget,
  CandidateLotRow,
  ClientQualificationRow,
  ClockDeps,
  ConsumedLineRow,
  ContractCheckRow,
  IncrementLotAllocatedParams,
  LedgerPort,
  OrderLineRow,
  OrderRow,
  OrderUpdateColumns,
  OutboundOrderRepository,
  PickListLineRow,
  PickOrderLineRow,
  PostedLedgerMovement,
  PostPickParams,
  ProcessOutboundDeps,
  SkuCheckRow,
  StockAvailabilityRow,
  StockedLocationBlockRow,
  StockLotRow,
  UpdateOrderLineAllocationParams,
  UpdateOrderLinePickParams,
} from './ports.js';
export { createOutbound, type CreateOutboundInput, type CreateOutboundResult } from './create-outbound.js';
export { runOutboundChecks, type RunOutboundChecksInput, type RunOutboundChecksResult } from './run-outbound-checks.js';
export { approveOutbound, type ApproveOutboundInput, type ApproveOutboundResult } from './approve-outbound.js';
export { cancelOutbound, type CancelOutboundInput, type CancelOutboundResult } from './cancel-outbound.js';
export { allocate, type AllocateInput, type AllocateResult } from './allocate.js';
export { generatePickList, type GeneratePickListInput, type GeneratePickListResult } from './generate-pick-list.js';
export { pickLine, type PickLineInput, type PickLineResult } from './pick-line.js';
export { checkOrder, type CheckOrderInput, type CheckOrderResult } from './check-order.js';
