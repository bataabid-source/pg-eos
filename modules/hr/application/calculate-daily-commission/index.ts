// modules/hr/application/calculate-daily-commission/index.ts — WBS 3.13 part 2.
//
// Barrel for the calculate-daily-commission use case's ONE command (application/ layer public
// surface).

export type {
  CalculateDailyCommissionDeps,
  ClockDeps,
  CommissionDailyRepository,
  Logger,
} from './ports.js';
export {
  calculateDailyCommission,
  type CalculateDailyCommissionInput,
  type CalculateDailyCommissionResult,
} from './calculate-daily-commission.js';
