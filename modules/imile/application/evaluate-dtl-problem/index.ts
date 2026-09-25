// modules/imile/application/evaluate-dtl-problem/index.ts — WBS 3.17 (part 1).
//
// Barrel for the evaluate-dtl-problem use case's ONE command (application/ layer public surface).

export type {
  ClockDeps,
  DtlContentAnalysisPort,
  DtlContentAnalysisResult,
  DtlEngineDecision,
  DtlProblemEvidence,
  DtlProblemsRepository,
  EvaluateDtlProblemDeps,
  InsertDtlProblemParams,
  InsertedDtlProblemRow,
  LogFields,
  Logger,
} from './ports.js';
export {
  evaluateDtlProblem,
  type EvaluateDtlProblemInput,
  type EvaluateDtlProblemResult,
} from './evaluate-dtl-problem.js';
