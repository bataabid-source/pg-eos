// modules/imile/application/evaluate-dtl-problem/ports.ts — WBS 3.17 (part 1).
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: EvaluateDtlProblemDeps` (clock, ids, port, repo, logger) and never imports
// infrastructure/. ../../infrastructure/evaluate-dtl-problem/{repository,content-analysis-adapter}
// .ts implement these; ../../api/evaluate-dtl-problem/composition.ts wires them.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN interface(s) named after its
// own aggregate — do not import this file from another use case (same discipline as this module's
// own pull-shipments/ports.ts).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by
 *  ../../infrastructure/evaluate-dtl-problem/logger.ts (a @pg-eos/logger child-logger adapter); a
 *  fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Engine decision — the only four values `imile.dtl_problems.engine_decision` accepts
 *  (database/schema/13B-Schema-Reference-Consolidation.sql:2387-2389,
 *  chk_dtl_problems_engine_decision). */
export type DtlEngineDecision = 'accept' | 'reject' | 'human' | 'reclassify';

/** The shape handed to the content-analysis port — one raised problem's evidence. Field shapes
 *  derive from imile.dtl_problems (01-Data-Model.sql:1378-1398) — never a field not on that table
 *  (brief, Contract line). */
export interface DtlProblemEvidence {
  readonly trackingNo: string;
  readonly driverCode: string | null;
  readonly problemType: string;
  readonly evidenceUrls: readonly string[];
  readonly customerText: string | null;
  readonly driverText: string | null;
  readonly raisedAt: Date;
}

/** The port's own result — carried verbatim into the inserted imile.dtl_problems row (brief,
 *  Scenario "the engine_decision, engine_confidence and engine_reason come from the port's own
 *  result, unmodified"). `gateResult` is `unknown` here (the port owns its own G1-G4 shape); the
 *  application layer validates it is a plain object (round-1 finding 2: a non-object throws
 *  `InvalidPortResultError`, never gets an invented wrapper shape), then spreads it alongside the
 *  engine's own `g0` key — with the engine's `g0` always applied LAST, so a port result that
 *  happens to carry its own `g0` key can never overwrite the engine's decision (round-1 finding 2). */
export interface DtlContentAnalysisResult {
  readonly gateResult: unknown;
  readonly decision: DtlEngineDecision;
  readonly confidence: number;
  readonly reason: string;
}

/** The G1-G4 content-analysis gates (doc 07 §5-2) — NOT reimplemented as domain rules (brief,
 *  Design: each genuinely requires content understanding this slice cannot build honestly).
 *  Called ONLY when G0 (../../domain/evaluate-dtl-problem/invariants.ts's `isG0Complete`) passes.
 *  Implemented by ../../infrastructure/evaluate-dtl-problem/content-analysis-adapter.ts
 *  (`NotConfiguredDtlContentAnalysisPort` as the production wiring default, throwing
 *  `PortNotConfiguredError` — ../../domain/evaluate-dtl-problem/errors.ts). */
export interface DtlContentAnalysisPort {
  evaluate(evidence: DtlProblemEvidence): Promise<DtlContentAnalysisResult>;
}

export interface InsertDtlProblemParams {
  readonly trackingNo: string;
  readonly driverCode: string | null;
  readonly problemType: string;
  readonly evidenceUrls: readonly string[];
  readonly customerText: string | null;
  readonly driverText: string | null;
  readonly raisedAt: Date;
  /** `{ ...port-own-G1-G4-result, g0: { pass: boolean } }` on a G0 pass — `g0` spread LAST so it
   *  always wins over anything the port returns; `{ g0: { pass: false } }` only (no g1-g4 keys)
   *  on a G0 fail (brief, Scenario; round-1 finding 2). */
  readonly gateResult: unknown;
  readonly engineDecision: DtlEngineDecision;
  // A G0 (completeness) failure never reaches a real content analysis — `null`, never a fabricated
  // `0` (round-1 finding 3, Master decision; imile.dtl_problems.engine_confidence numeric(5,4)
  // already allows null, 01:1386).
  readonly engineConfidence: number | null;
  readonly engineReason: string;
}

export interface InsertedDtlProblemRow {
  readonly id: string;
}

/** Every DB statement the evaluate-dtl-problem use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/evaluate-dtl-problem/repository.ts. */
export interface DtlProblemsRepository {
  /** append-only INSERT — imile.dtl_problems has no version column and no update path this slice
   *  needs (brief, Design: "No update path"). `closed_by`/`auditor_decision`/`decided_at`/
   *  `actual_outcome`/`rule_was_correct`/`re_reviewed_at`/`re_review_agreed` all stay their column
   *  defaults (null) — never passed here. */
  insertDtlProblem(tx: NodePgDatabase, params: InsertDtlProblemParams): Promise<InsertedDtlProblemRow>;
  /** doc 40 P3/P7: one append-only platform.audit_log row per imile.dtl_problems insert — same
   *  hash-chain mechanism (a DB trigger, not application code) this module's other use cases
   *  already write through their own `writeAuditRow`. `entity_id` is always null — imile.dtl_problems
   *  has no entity_id column (brief, Design; G-01 row filed). */
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/evaluate-dtl-problem/composition.ts). The command programs only against these ports —
 *  the application layer never imports infrastructure/. */
export interface EvaluateDtlProblemDeps extends ClockDeps {
  readonly port: DtlContentAnalysisPort;
  readonly repo: DtlProblemsRepository;
  readonly logger: Logger;
}
