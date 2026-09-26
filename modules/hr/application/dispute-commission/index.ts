// modules/hr/application/dispute-commission/index.ts — WBS 3.13 part 4.
//
// Barrel for the dispute-commission use case's ONE command (application/ layer public surface).

export type {
  DisputeCommissionDeps,
  ClockDeps,
  CommissionDailyRepository,
  CommissionDailyRow,
  Logger,
} from './ports.js';
export {
  disputeCommission,
  type DisputeCommissionInput,
  type DisputeCommissionResult,
} from './dispute-commission.js';
