// modules/sales/application/manage-contract/index.ts — WBS 1.7, M02 sales.
//
// Barrel for the manage-contract use case's nine commands/queries (application/ layer public
// surface).

export type {
  AccountRow,
  AuditTarget,
  ClockDeps,
  ContractForOrderRow,
  ContractRepository,
  ContractRow,
  ContractUpdateColumns,
  InsertContractParams,
  InsertContractSlaParams,
  Logger,
  LogFields,
  ManageContractDeps,
  PriceListRow,
  WriteAuditRowParams,
} from './ports.js';
export { createContract, type CreateContractInput, type CreateContractResult } from './create-contract.js';
export { signContract, type SignContractInput, type SignContractResult } from './sign-contract.js';
export { setContractPriceList, type SetContractPriceListInput, type SetContractPriceListResult } from './set-contract-price-list.js';
export { activateContract, type ActivateContractInput, type ActivateContractResult } from './activate-contract.js';
export { suspendContract, type SuspendContractInput, type SuspendContractResult } from './suspend-contract.js';
export { resumeContract, type ResumeContractInput, type ResumeContractResult } from './resume-contract.js';
export { expireContract, type ExpireContractInput, type ExpireContractResult } from './expire-contract.js';
export { addContractSla, type AddContractSlaInput, type AddContractSlaResult } from './add-contract-sla.js';
export { getContractForOrder, type GetContractForOrderInput, type GetContractForOrderResult } from './get-contract-for-order.js';
