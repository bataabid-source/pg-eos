// modules/billing/application/accounting-periods/index.ts — WBS 4.19 (lane 2).
//
// Barrel for the accounting-periods use case's six commands (application/ layer public surface).
// applyPeriodReopenDecision is internal (no contract route): the Decision Inbox calls it once the
// reopen decision is approved.

export type {
  AccountingPeriodRepository,
  AccountingPeriodsDeps,
  AuditTarget,
  ClockDeps,
  FiscalYearRow,
  Logger,
  LogFields,
  PeriodRow,
  ReopenDecisionContext,
  ReopenDecisionRow,
} from './ports.js';
export { createFiscalYear, type CreateFiscalYearInput, type CreateFiscalYearResult } from './create-fiscal-year.js';
export { openPeriod, type OpenPeriodInput, type OpenPeriodResult } from './open-period.js';
export { closePeriod, type ClosePeriodInput, type ClosePeriodResult } from './close-period.js';
export { lockPeriod, type LockPeriodInput, type LockPeriodResult } from './lock-period.js';
export {
  requestReopenPeriod,
  type RequestReopenPeriodInput,
  type RequestReopenPeriodResult,
} from './request-reopen-period.js';
export {
  applyPeriodReopenDecision,
  type ApplyPeriodReopenDecisionInput,
  type ApplyPeriodReopenDecisionResult,
} from './apply-period-reopen-decision.js';
