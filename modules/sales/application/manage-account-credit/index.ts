// modules/sales/application/manage-account-credit/index.ts — WBS 1.8, M02 sales.
//
// Barrel for the manage-account-credit use case's four commands/queries (application/ layer
// public surface).

export type {
  AccountCreditRepository,
  AccountCreditRow,
  ClockDeps,
  Logger,
  LogFields,
  ManageAccountCreditDeps,
  UpdateCreditHoldColumns,
  UpdateCreditLimitColumns,
} from './ports.js';
export { setCreditLimit, type SetCreditLimitInput, type SetCreditLimitResult } from './set-credit-limit.js';
export { setCreditHold, type SetCreditHoldInput, type SetCreditHoldResult } from './set-credit-hold.js';
export { releaseCreditHold, type ReleaseCreditHoldInput, type ReleaseCreditHoldResult } from './release-credit-hold.js';
export {
  getAccountCreditStatus,
  type GetAccountCreditStatusInput,
  type GetAccountCreditStatusResult,
} from './get-account-credit-status.js';
