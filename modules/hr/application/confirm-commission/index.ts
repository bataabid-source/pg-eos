// modules/hr/application/confirm-commission/index.ts — WBS 3.13 part 4.
//
// Barrel for the confirm-commission use case's ONE command (application/ layer public surface).

export type {
  ConfirmCommissionDeps,
  ClockDeps,
  CommissionDailyRepository,
  CommissionDailyRow,
  Logger,
} from './ports.js';
export {
  confirmCommission,
  type ConfirmCommissionInput,
  type ConfirmCommissionResult,
} from './confirm-commission.js';
