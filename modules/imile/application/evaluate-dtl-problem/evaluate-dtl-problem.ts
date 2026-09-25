// modules/imile/application/evaluate-dtl-problem/evaluate-dtl-problem.ts — WBS 3.17 (part 1).
//
// ONE withIdempotentContext transaction per evaluation — step 0 (the idempotency advisory lock +
// platform.idempotency_keys upsert, ../../../../packages/db/src/idempotency.ts's
// withIdempotentContext) runs first whenever the command's own input carries an `idem`, ahead of
// everything this file does (same discipline as pull-shipments/report-agent-health, this module's
// own precedents). A replay (same key, same body) never re-runs this command's own work at all —
// withIdempotentContext short-circuits BEFORE `fn` is even invoked and resolves with the STORED
// response from the first call.
//
// Steps, per evaluation:
//   0. the idempotency check (above) — a replay short-circuits here, before ANY port call.
//   1. deps.clock.now() is read EXACTLY ONCE (`occurredAt`) — the one audit row this call writes
//      shares that instant (CLAUDE.md · AGENT CONSTRAINTS: no Date.now()/new Date() in domain/,
//      and here in application/ the clock port is still the only time source).
//   2. G0 completeness (../../domain/evaluate-dtl-problem/invariants.ts's `isG0Complete`) — the
//      ONLY mechanical domain logic this slice builds (brief, Design). A fail writes ONE
//      imile.dtl_problems row (engine_decision='human', gate_result={g0:{pass:false}} — no g1-g4
//      keys, `closed_by` stays null) plus its own audit row, and returns — the content-analysis
//      port is NEVER called (brief, Scenario "no content-analysis port call is made").
//   3. On a G0 pass: deps.port.evaluate(evidence) is called EXACTLY ONCE. Any error it throws
//      (including PortNotConfiguredError) is NOT caught here — it propagates past the command
//      boundary (api layer maps it to a generic 500), and because withContext rolls back the whole
//      transaction on a thrown error, NO imile.dtl_problems row is written (brief, Scenario
//      "port-not-configured-throws-and-writes-nothing": "G0 passing alone is never enough to
//      fabricate a G1-G4 result").
//   4. On a successful port call: the port's own gate_result MUST be a plain object — a non-object
//      result is a contract violation (`InvalidPortResultError`, thrown before any row is written,
//      transaction rolls back). Otherwise ONE imile.dtl_problems row is inserted with
//      gate_result={...port.gateResult, g0:{pass:true}} (g0 spread LAST so the engine's own G0
//      record always wins over anything the port itself returns under a `g0` key) and
//      engine_decision/engine_confidence/engine_reason taken VERBATIM from the port's own result
//      (brief, Scenario "come from the port's own result, unmodified") — `closed_by` stays null
//      unconditionally, regardless of decision (brief, Design: "Never sets closed_by ... this
//      slice's own behavior is consistent with, not a violation of," the reject_never_auto CHECK).
//      Plus its own audit row, recording every business field this insert actually writes.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { isG0Complete } from '../../domain/evaluate-dtl-problem/invariants.js';
import { InvalidPortResultError, MissingActorError } from '../../domain/evaluate-dtl-problem/errors.js';
import type { DtlEngineDecision, DtlProblemEvidence, EvaluateDtlProblemDeps } from './ports.js';

const AUDIT_OPERATION_INSERT = 'insert';
const ENGINE_DECISION_HUMAN: DtlEngineDecision = 'human';
// imile.dtl_problems.engine_confidence (numeric(5,4)) — a G0 fail never reached a real content
// analysis, so there is no confidence figure to report; `null` is stored/returned, never a
// fabricated score (round-1 finding 3, Master decision; brief, Contract line).
const G0_FAIL_ENGINE_CONFIDENCE = null;
const G0_FAIL_ENGINE_REASON =
  'G0 (completeness) failed: evidence_urls, customer_text/driver_text and raised_at must all be ' +
  'present before a problem reaches gates G1-G4 (doc 07 §5-2: "ناقص → بشري فوراً").';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface EvaluateDtlProblemInput {
  readonly trackingNo: string;
  readonly driverCode: string | null;
  readonly problemType: string;
  readonly evidenceUrls: readonly string[];
  readonly customerText: string | null;
  readonly driverText: string | null;
  readonly raisedAt: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface EvaluateDtlProblemResult {
  readonly id: string;
  readonly engineDecision: DtlEngineDecision;
  // A G0 (completeness) failure never reaches a real content analysis — `null`, never a fabricated
  // `0` (round-1 finding 3, Master decision).
  readonly engineConfidence: number | null;
  readonly engineReason: string;
}

export async function evaluateDtlProblem(
  ctx: WithContextCtx,
  input: EvaluateDtlProblemInput,
  deps: EvaluateDtlProblemDeps,
): Promise<EvaluateDtlProblemResult> {
  // doc 40 P3/P7: every audit row this command writes needs an actor — ctx.userId ONLY, same
  // discipline as this module's own pull-shipments/report-agent-health precedents. Checked before
  // the idempotency context.
  if (!ctx.userId) throw new MissingActorError('EvaluateDtlProblem requires ctx.userId.');
  const actorId = ctx.userId;

  // Step 0 — the idempotency check runs FIRST: a replay resolves from the stored response and
  // never invokes this callback at all, so the port is never re-contacted on a replay.
  return withIdempotentContext<EvaluateDtlProblemResult>(ctx, input.idem, async (tx) => {
    const occurredAt = deps.clock.now();
    const raisedAt = new Date(input.raisedAt);

    // Step 2 — G0 completeness, against the same field shape (evidence_urls/customer_text/
    // driver_text/raised_at) `isG0Complete` and its own property tests use.
    const g0Record = {
      evidence_urls: input.evidenceUrls,
      customer_text: input.customerText,
      driver_text: input.driverText,
      raised_at: input.raisedAt,
    };

    if (!isG0Complete(g0Record)) {
      const gateResult = { g0: { pass: false } };
      const inserted = await deps.repo.insertDtlProblem(tx, {
        trackingNo: input.trackingNo,
        driverCode: input.driverCode,
        problemType: input.problemType,
        evidenceUrls: input.evidenceUrls,
        customerText: input.customerText,
        driverText: input.driverText,
        raisedAt,
        gateResult,
        engineDecision: ENGINE_DECISION_HUMAN,
        engineConfidence: G0_FAIL_ENGINE_CONFIDENCE,
        engineReason: G0_FAIL_ENGINE_REASON,
      });
      await deps.repo.writeAuditRow(tx, {
        recordId: inserted.id,
        operation: AUDIT_OPERATION_INSERT,
        correlationId: input.correlationId,
        actorId,
        // doc 40 P3/P7: the audit row reflects every business field this insert actually writes
        // (round-1 finding 4) — same discipline as this module's own audit-row convention
        // precedent.
        newValue: {
          trackingNo: input.trackingNo,
          driverCode: input.driverCode,
          problemType: input.problemType,
          evidenceUrls: input.evidenceUrls,
          customerText: input.customerText,
          driverText: input.driverText,
          raisedAt: input.raisedAt,
          closedBy: null,
          engineDecision: ENGINE_DECISION_HUMAN,
          engineConfidence: G0_FAIL_ENGINE_CONFIDENCE,
          engineReason: G0_FAIL_ENGINE_REASON,
          gateResult,
        },
        occurredAt,
      });
      return {
        id: inserted.id,
        engineDecision: ENGINE_DECISION_HUMAN,
        engineConfidence: G0_FAIL_ENGINE_CONFIDENCE,
        engineReason: G0_FAIL_ENGINE_REASON,
      };
    }

    // Step 3 — G0 passed: the content-analysis port is the ONLY place G1-G4 are evaluated (brief,
    // Design). Any thrown error (including PortNotConfiguredError) propagates past this command's
    // own boundary — NOT caught here, unlike PullShipments' own PortalUnreachableError handling.
    const evidence: DtlProblemEvidence = {
      trackingNo: input.trackingNo,
      driverCode: input.driverCode,
      problemType: input.problemType,
      evidenceUrls: input.evidenceUrls,
      customerText: input.customerText,
      driverText: input.driverText,
      raisedAt,
    };
    const portResult = await deps.port.evaluate(evidence);

    // Step 4 — the port's own result, verbatim. `gateResult` MUST be a plain object (the port's
    // only documented shape, ports.ts's `DtlContentAnalysisResult`) — a non-object result is a
    // contract violation, not an invented shape to wrap under a made-up key (round-1 finding 2):
    // it throws here, before any imile.dtl_problems row is written, and the transaction rolls
    // back. `g0` is spread LAST so the engine's own G0 record always wins even if the port's own
    // result happens to carry its own `g0` key — only the engine may ever decide G0 (brief,
    // Design).
    if (!isPlainObject(portResult.gateResult)) {
      throw new InvalidPortResultError(
        'DtlContentAnalysisPort.evaluate returned a non-object gateResult; the port must return a ' +
          'plain object (its own documented G1-G4 shape).',
      );
    }
    const gateResult = { ...portResult.gateResult, g0: { pass: true } };

    const inserted = await deps.repo.insertDtlProblem(tx, {
      trackingNo: input.trackingNo,
      driverCode: input.driverCode,
      problemType: input.problemType,
      evidenceUrls: input.evidenceUrls,
      customerText: input.customerText,
      driverText: input.driverText,
      raisedAt,
      gateResult,
      engineDecision: portResult.decision,
      engineConfidence: portResult.confidence,
      engineReason: portResult.reason,
    });
    await deps.repo.writeAuditRow(tx, {
      recordId: inserted.id,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      // doc 40 P3/P7: every business field this insert actually writes (round-1 finding 4) — same
      // discipline as this module's own audit-row convention.
      newValue: {
        trackingNo: input.trackingNo,
        driverCode: input.driverCode,
        problemType: input.problemType,
        evidenceUrls: input.evidenceUrls,
        customerText: input.customerText,
        driverText: input.driverText,
        raisedAt: input.raisedAt,
        closedBy: null,
        engineDecision: portResult.decision,
        engineConfidence: portResult.confidence,
        engineReason: portResult.reason,
        gateResult,
      },
      occurredAt,
    });

    return {
      id: inserted.id,
      engineDecision: portResult.decision,
      engineConfidence: portResult.confidence,
      engineReason: portResult.reason,
    };
  });
}
