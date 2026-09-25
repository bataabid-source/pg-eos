// modules/imile — package shell created by scripts/new-slice.sh (lane blocker (c), 2026-09-24),
// copied from the golden module's shell (modules/wms). Public barrel: every use case
// re-exports its application layer here. Never hand-made (CLAUDE.md · SPEED AND QUALITY).
export * from './application/report-agent-health/index.js';

// WBS 3.14 (part 2) — pull-shipments, replicating the golden slice's own file tree. Named
// re-exports (not `export *`): ./application/report-agent-health/index.js already exports
// ClockDeps / Logger / InsertAgentHealthParams / InsertedAgentHealthRow — a wildcard re-export
// from both use cases would collide (same discipline as modules/wms/index.ts's own
// count-inventory precedent). pull-shipments's own colliding names are aliased with a
// `PullShipments` prefix here so both use cases' types stay reachable from this one module
// barrel.
export {
  pullShipments,
  type PullShipmentsInput,
  type PullShipmentsResult,
  type ExistingShipmentRow,
  type ImilePortalPort,
  type PortalShipmentRecord,
  type ShipmentsRepository,
  type InsertShipmentParams,
  type UpdateShipmentIMileFieldsParams,
  type PullShipmentsDeps,
  type ClockDeps as PullShipmentsClockDeps,
  type Logger as PullShipmentsLogger,
  type InsertAgentHealthParams as PullShipmentsInsertAgentHealthParams,
  type InsertedAgentHealthRow as PullShipmentsInsertedAgentHealthRow,
} from './application/pull-shipments/index.js';
export {
  StaleVersionError as PullShipmentsStaleVersionError,
  PortalUnreachableError,
  PortalNotConfiguredError,
  MissingActorError as PullShipmentsMissingActorError,
} from './domain/pull-shipments/errors.js';

// WBS 3.17 (part 1) — evaluate-dtl-problem, same discipline as pull-shipments above: named
// re-exports, `MissingActorError` aliased (collides with pull-shipments's own) — `PortNotConfiguredError`
// does not collide with pull-shipments's `PortalNotConfiguredError` (deliberately distinct names,
// one per use case's own port).
export {
  evaluateDtlProblem,
  type EvaluateDtlProblemInput,
  type EvaluateDtlProblemResult,
  type ClockDeps as EvaluateDtlProblemClockDeps,
  type DtlContentAnalysisPort,
  type DtlContentAnalysisResult,
  type DtlEngineDecision,
  type DtlProblemEvidence,
  type DtlProblemsRepository,
  type EvaluateDtlProblemDeps,
  type InsertDtlProblemParams,
  type InsertedDtlProblemRow,
  type LogFields as EvaluateDtlProblemLogFields,
  type Logger as EvaluateDtlProblemLogger,
} from './application/evaluate-dtl-problem/index.js';
export {
  PortNotConfiguredError,
  InvalidPortResultError,
  MissingActorError as EvaluateDtlProblemMissingActorError,
} from './domain/evaluate-dtl-problem/errors.js';
