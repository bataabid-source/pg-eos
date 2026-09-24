// modules/platform/application/evaluate-alerts/index.ts — WBS 5.13 part 1.
//
// Barrel for the evaluate-alerts use case's two commands (application/ layer public surface).

export type {
  AlertLogRow,
  AlertRuleRepository,
  AlertRuleRow,
  AuditRowParams,
  ClockDeps,
  EvaluateAlertsDeps,
  InsertedAlertLog,
  LogFields,
  Logger,
} from './ports.js';
export {
  evaluateAlertRules,
  type AlertFired,
  type EvaluateAlertRulesInput,
  type EvaluateAlertRulesResult,
} from './evaluate-alert-rules.js';
export { acknowledgeAlert, type AcknowledgeAlertInput, type AcknowledgeAlertResult } from './acknowledge-alert.js';
