// modules/imile/tests/evaluate-dtl-problem/evaluate-dtl-problem.test.ts — WBS 3.17 (part 1).
//
// Integration tests, one per scenario in ./evaluate-dtl-problem.feature, against the real database
// as pgeos_app. Sources: docs/notes/slice-briefs/_slice-3.17.brief.md, .claude/briefs/imile.brief.md,
// docs/package/07-iMile-Automation.md §5-1/§5-2 (lines 211-227), database/schema/01-Data-Model.sql:
// 1378-1398 (imile.dtl_problems), database/schema/13B-Schema-Reference-Consolidation.sql:2382-2394.
//
// Expected new surface (RED until it exists — same "test pins the contract" discipline as this
// module's own pull-shipments precedent):
//   modules/imile/domain/evaluate-dtl-problem/errors.ts
//     - PortNotConfiguredError.
//   modules/imile/domain/evaluate-dtl-problem/invariants.ts
//     - `isG0Complete(raw: unknown): boolean` — pure (see ./invariants.property.test.ts).
//   modules/imile/application/evaluate-dtl-problem/ports.ts
//     - `DtlProblemEvidence` — the shape handed to the port: { trackingNo, driverCode, problemType,
//       evidenceUrls, customerText, driverText, raisedAt: Date }.
//     - `DtlContentAnalysisResult` — { gateResult: unknown, decision: 'accept'|'reject'|'human'|
//       'reclassify', confidence: number, reason: string }.
//     - `DtlContentAnalysisPort.evaluate(evidence: DtlProblemEvidence):
//       Promise<DtlContentAnalysisResult>` — called ONLY when G0 passes (brief, Design: "Only G0 is
//       mechanical domain logic ... G1-G4 are NOT reimplemented as domain rules").
//   modules/imile/application/evaluate-dtl-problem/index.ts (re-exports evaluateDtlProblem)
//     - `evaluateDtlProblem(ctx, input, deps): Promise<EvaluateDtlProblemResult>`.
//   modules/imile/api/evaluate-dtl-problem/composition.ts
//     - `createEvaluateDtlProblemDeps(overrides)` — same wiring-default discipline as
//       createPullShipmentsDeps: `deps.port` defaults to NotConfiguredDtlContentAnalysisPort.
//
// Binding behaviour this suite asserts (brief, Design section):
//   - G0 completeness = evidence_urls non-empty AND (customer_text OR driver_text present) AND
//     raised_at present. Fail -> engine_decision 'human', the content-analysis port is NEVER
//     called, gate_result records only G0 (no g1-g4 keys).
//   - G0 pass -> the port is called exactly once with the problem's evidence; engine_decision,
//     engine_confidence and engine_reason are the port's OWN result, unmodified (the engine never
//     re-implements G1-G4 content-analysis rules itself — CLAUDE.md instruction to pg-tester).
//   - `closed_by` is written as `null` unconditionally, on every inserted row, regardless of
//     engine_decision (brief, Design: "Never sets closed_by ... this slice writes closed_by = null
//     unconditionally").
//   - a NotConfiguredDtlContentAnalysisPort throws PortNotConfiguredError; when the port throws
//     (any reason), NO imile.dtl_problems row is written — G0 passing alone never fabricates a
//     G1-G4 result.
//   - one platform.audit_log row per imile.dtl_problems insert (same hash-chain mechanism
//     pull-shipments already replicated from report-agent-health).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus a real
// identity.users row for a dedicated actor. PG_APP_USER=pgeos_app is REQUIRED to run this suite
// (every command call goes through withContext(ctx, fn) as pgeos_app, genuinely subject to RLS).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The modules under test — do not exist yet (RED).
import { evaluateDtlProblem } from '../../application/evaluate-dtl-problem/index.js';
import { createEvaluateDtlProblemDeps } from '../../api/evaluate-dtl-problem/composition.js';
import {
  InvalidPortResultError,
  MissingActorError,
  PortNotConfiguredError,
} from '../../domain/evaluate-dtl-problem/errors.js';
import { FakeDtlContentAnalysisPort } from '../../infrastructure/evaluate-dtl-problem/content-analysis-adapter.js';
import type {
  DtlContentAnalysisPort,
  DtlProblemEvidence,
  DtlContentAnalysisResult,
} from '../../application/evaluate-dtl-problem/ports.js';
import { EvaluateDtlProblemInputSchema } from '@pg-eos/contracts/imile/evaluate-dtl-problem';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const DTL_AUDITOR_ACTOR_UUID = '00000000-0000-4000-8000-0000003170a1';

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(3170);
const ctx = { userId: DTL_AUDITOR_ACTOR_UUID, clientId: null, isInternal: true };

const usedTrackingNos = new Set<string>();

function freshTrackingNo(label: string): string {
  const trackingNo = `SHP-${label}-${randomUUID()}`;
  usedTrackingNos.add(trackingNo);
  return trackingNo;
}

function nextCorrelationId(): string {
  return randomUUID();
}

// Test isolation only: one module-level FixedClock shared by every scenario.
const SCENARIO_CLOCK_STEP_MS = 5_000;
function beginScenario(): void {
  clock.advance(SCENARIO_CLOCK_STEP_MS);
}

/** A call-tracking DtlContentAnalysisPort test double, defined here rather than in the module's
 *  own content-analysis-adapter.ts (that file's `FakeDtlContentAnalysisPort` is a production
 *  deliverable with no call log — round-1 finding 8; this local helper exists for the scenarios
 *  that need to assert "called exactly once, with the problem's evidence"). Records every call it
 *  receives. */
function fakeContentAnalysisPort(
  result: DtlContentAnalysisResult,
): DtlContentAnalysisPort & { readonly calls: readonly DtlProblemEvidence[] } {
  const calls: DtlProblemEvidence[] = [];
  return {
    calls,
    evaluate: async (evidence: DtlProblemEvidence): Promise<DtlContentAnalysisResult> => {
      calls.push(evidence);
      return result;
    },
  };
}

/** A port that throws if ever called — used to prove the G0-incomplete scenario never reaches
 *  gates G1-G4 (brief, Scenario "no content-analysis port call is made"). */
function unreachableContentAnalysisPort(): DtlContentAnalysisPort {
  return {
    evaluate: async (): Promise<DtlContentAnalysisResult> => {
      throw new Error(
        'content-analysis port must never be called for an incomplete (G0-failing) DTL problem',
      );
    },
  };
}

function completeProblemInput(trackingNo: string, overrides: Record<string, unknown> = {}): {
  trackingNo: string;
  driverCode: string | null;
  problemType: string;
  evidenceUrls: readonly string[];
  customerText: string | null;
  driverText: string | null;
  raisedAt: string;
  correlationId: string;
} {
  return {
    trackingNo,
    driverCode: 'DRV-2002',
    problemType: 'wrong_address',
    evidenceUrls: ['https://evidence.example/photo-1.jpg'],
    customerText: 'العميل يقول العنوان غير صحيح',
    driverText: 'السائق يقول العنوان صحيح ولم يستطع الوصول',
    raisedAt: '2026-09-24T12:00:00.000Z',
    correlationId: nextCorrelationId(),
    ...overrides,
  };
}

async function getDtlProblemRow(trackingNo: string): Promise<
  | {
      id: string;
      tracking_no: string;
      raised_at: Date;
      driver_code: string | null;
      problem_type: string | null;
      gate_result: Record<string, unknown> | null;
      engine_decision: string | null;
      engine_confidence: string | null;
      engine_reason: string | null;
      evidence_urls: string[] | null;
      customer_text: string | null;
      driver_text: string | null;
      closed_by: string | null;
      auditor_decision: string | null;
    }
  | undefined
> {
  const result = await pool.query(
    `select id::text as id, tracking_no, raised_at, driver_code, problem_type, gate_result,
            engine_decision, engine_confidence::text as engine_confidence, engine_reason,
            evidence_urls, customer_text, driver_text, closed_by, auditor_decision
       from imile.dtl_problems where tracking_no = $1`,
    [trackingNo],
  );
  return result.rows[0];
}

async function getDtlProblemCount(trackingNo: string): Promise<number> {
  const result = await pool.query(`select count(*)::text as count from imile.dtl_problems where tracking_no = $1`, [
    trackingNo,
  ]);
  return Number(result.rows[0]?.count ?? '0');
}

async function auditRowsForCorrelation(correlationId: string): Promise<
  Array<{
    table_name: string;
    record_id: string | null;
    operation: string;
    new_value: unknown;
  }>
> {
  const result = await pool.query(
    `select table_name, record_id::text as record_id, operation, new_value
       from platform.audit_log where correlation_id = $1 order by occurred_at`,
    [correlationId],
  );
  return result.rows;
}

// D-183: a DELETE against the shared database is only allowed in this suite's own `afterAll`, not
// in `beforeAll` (round-1 finding 11). `beforeAll` only ever creates the fixture actor — an upsert,
// never a delete — so a leftover row from a previous, interrupted run is reused rather than purged.
async function createFixtureActor(userId: string): Promise<void> {
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [userId, `_dtlengine_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار محرك التدقيق الحي — WBS 3.17'],
  );
}

beforeAll(async () => {
  await createFixtureActor(DTL_AUDITOR_ACTOR_UUID);
});

afterAll(async () => {
  if (usedTrackingNos.size > 0) {
    await pool.query(`delete from imile.dtl_problems where tracking_no = any($1::text[])`, [[...usedTrackingNos]]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [DTL_AUDITOR_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [DTL_AUDITOR_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [DTL_AUDITOR_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [DTL_AUDITOR_ACTOR_UUID]);
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/imile/evaluate-dtl-problem — EvaluateDtlProblemInputSchema shape', () => {
  it('accepts every field the brief Contract line names, derived from imile.dtl_problems columns only', () => {
    const parsed = EvaluateDtlProblemInputSchema.parse(
      completeProblemInput(freshTrackingNo('CONTRACTSTUB')),
    );
    expect(parsed.trackingNo).toEqual(expect.any(String));
    expect(parsed.evidenceUrls).toEqual(expect.any(Array));
  });

  it('rejects a body with an empty trackingNo', () => {
    const result = EvaluateDtlProblemInputSchema.safeParse(
      completeProblemInput('', {}),
    );
    expect(result.success).toBe(false);
  });

  // review-round 2 finding 3: a blank string is not a photo URL (doc 07 §5-2) — the contract
  // itself must reject it, before it ever reaches isG0Complete.
  it('rejects a body whose evidenceUrls contains a blank string', () => {
    const result = EvaluateDtlProblemInputSchema.safeParse(
      completeProblemInput(freshTrackingNo('BLANKEVIDENCE'), { evidenceUrls: [''] }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a body whose evidenceUrls is empty (no evidence at all, distinct from a blank entry)', () => {
    const result = EvaluateDtlProblemInputSchema.safeParse(
      completeProblemInput(freshTrackingNo('NOEVIDENCE'), { evidenceUrls: [] }),
    );
    expect(result.success).toBe(true);
  });
});

// --- Scenario: G0-incomplete-goes-to-human ---------------------------------------------------

describe('Scenario: G0-incomplete-goes-to-human — a problem missing required evidence fails G0 and goes to a human', () => {
  it('engine_decision is "human", gate_result names G0 as the failing gate, and the content-analysis port is never called', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('2001');
    const port = unreachableContentAnalysisPort();
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port });
    const correlationId = nextCorrelationId();

    const result = await evaluateDtlProblem(
      ctx,
      {
        trackingNo,
        driverCode: null,
        problemType: 'no_delivery',
        evidenceUrls: [],
        customerText: null,
        driverText: null,
        raisedAt: '2026-09-24T12:00:00.000Z',
        correlationId,
      },
      deps,
    );

    expect(result.engineDecision).toBe('human');
    // review-round 2 finding 1: a G0 failure never computes a confidence score — never a
    // fabricated 0 — so both the returned result and the stored row must read null, not 0.
    expect(result.engineConfidence).toBeNull();
    // The reason names G0 (completeness) as the failing gate (Gherkin, Scenario
    // G0-incomplete-goes-to-human) — a prefix match against the production code's own
    // (internal, unexported) G0_FAIL_ENGINE_REASON constant's literal text
    // (evaluate-dtl-problem.ts), not an invented string.
    expect(result.engineReason).toMatch(/^G0 \(completeness\) failed:/);

    const row = await getDtlProblemRow(trackingNo);
    expect(row).toBeDefined();
    expect(row?.engine_decision).toBe('human');
    expect(row?.engine_confidence).toBeNull();
    expect(row?.engine_reason).toBe(result.engineReason);
    expect(row?.gate_result).toMatchObject({ g0: { pass: false } });
    // Never reaches G1-G4 — those keys are absent, not merely empty (brief: "an incomplete report
    // never reaches gates G1-G4").
    expect(row?.gate_result).not.toHaveProperty('g1');
    expect(row?.gate_result).not.toHaveProperty('g2');
    expect(row?.gate_result).not.toHaveProperty('g3');
    expect(row?.gate_result).not.toHaveProperty('g4');
    expect(row?.closed_by).toBeNull();

    const auditRows = await auditRowsForCorrelation(correlationId);
    const dtlAudit = auditRows.filter((r) => r.table_name === 'dtl_problems');
    expect(dtlAudit).toHaveLength(1);
    expect(dtlAudit[0]?.operation).toBe('insert');
    expect(dtlAudit[0]?.record_id).toBe(row?.id);
    // review-round 2 finding 2: the audit row's new_value must reflect the actual business fields
    // this insert wrote, not just an id/operation shell.
    expect(dtlAudit[0]?.new_value).toMatchObject({
      trackingNo,
      problemType: 'no_delivery',
      evidenceUrls: [],
      customerText: null,
      driverText: null,
      closedBy: null,
      engineDecision: 'human',
      engineConfidence: null,
    });
  });
});

// --- Scenario: complete-problem-delegates-to-port-verbatim -----------------------------------

describe('Scenario: complete-problem-delegates-to-port-verbatim — a complete problem is evaluated end to end by the content-analysis port', () => {
  it('G0 passes, the port is called exactly once, and engine_decision/confidence/reason come from the port unmodified', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('2002');
    const portResult: DtlContentAnalysisResult = {
      gateResult: { g1: 'pass', g2: 'pass', g3: 'pass', g4: 'pass' },
      decision: 'accept',
      confidence: 0.8734,
      reason: 'evidence matches problem_type; no driver-responsiveness flag',
    };
    const port = fakeContentAnalysisPort(portResult);
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port });
    const input = completeProblemInput(trackingNo);

    const result = await evaluateDtlProblem(ctx, input, deps);

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toEqual({
      trackingNo: input.trackingNo,
      driverCode: input.driverCode,
      problemType: input.problemType,
      evidenceUrls: input.evidenceUrls,
      customerText: input.customerText,
      driverText: input.driverText,
      raisedAt: new Date(input.raisedAt),
    });

    expect(result.engineDecision).toBe(portResult.decision);
    expect(result.engineConfidence).toBe(portResult.confidence);
    expect(result.engineReason).toBe(portResult.reason);

    const row = await getDtlProblemRow(trackingNo);
    expect(row).toBeDefined();
    expect(row?.engine_decision).toBe(portResult.decision);
    expect(Number(row?.engine_confidence)).toBeCloseTo(portResult.confidence, 4);
    expect(row?.engine_reason).toBe(portResult.reason);
    expect(row?.gate_result).toMatchObject({ g0: { pass: true }, g1: 'pass', g2: 'pass', g3: 'pass', g4: 'pass' });
    expect(row?.closed_by).toBeNull();

    const auditRows = await auditRowsForCorrelation(input.correlationId);
    const dtlAudit = auditRows.filter((r) => r.table_name === 'dtl_problems');
    expect(dtlAudit).toHaveLength(1);
    expect(dtlAudit[0]?.operation).toBe('insert');
    // review-round 2 finding 2: the G0-pass audit row must also carry the real business fields
    // and the port's own decision/confidence/reason/gateResult, not just an id/operation shell.
    expect(dtlAudit[0]?.new_value).toMatchObject({
      trackingNo: input.trackingNo,
      driverCode: input.driverCode,
      problemType: input.problemType,
      customerText: input.customerText,
      driverText: input.driverText,
      closedBy: null,
      engineDecision: portResult.decision,
      engineReason: portResult.reason,
      gateResult: portResult.gateResult,
    });
  });
});

// --- gate_result spread order + non-object gateResult contract violation (round-1 finding 2) ----

describe('gate_result spread order: the engine\'s own G0 record always wins over the port\'s own g0 key', () => {
  it('a port result carrying its own g0 key is discarded — the inserted row\'s gate_result.g0 stays { pass: true }', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('G0WINS');
    const portResult: DtlContentAnalysisResult = {
      // The port's own gateResult happens to carry a g0 key of its own — the engine's own G0
      // record (computed by isG0Complete, never the port's) must still win (evaluate-dtl-
      // problem.ts's fixed spread order: `{ ...portResult.gateResult, g0: { pass: true } }`).
      gateResult: { g0: { pass: false }, g1: 'pass' },
      decision: 'accept',
      confidence: 0.5,
      reason: 'port result carries its own (discarded) g0 key',
    };
    const port = fakeContentAnalysisPort(portResult);
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port });
    const input = completeProblemInput(trackingNo);

    await evaluateDtlProblem(ctx, input, deps);

    const row = await getDtlProblemRow(trackingNo);
    expect(row?.gate_result).toMatchObject({ g0: { pass: true }, g1: 'pass' });
  });

  it('a non-object gateResult (e.g. a string) throws InvalidPortResultError and writes no imile.dtl_problems row', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('BADGATERESULT');
    const portResult = {
      gateResult: 'not-an-object',
      decision: 'accept',
      confidence: 0.5,
      reason: 'malformed port result',
    } as unknown as DtlContentAnalysisResult;
    const port = fakeContentAnalysisPort(portResult);
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port });
    const input = completeProblemInput(trackingNo);

    await expect(evaluateDtlProblem(ctx, input, deps)).rejects.toBeInstanceOf(InvalidPortResultError);

    expect(await getDtlProblemCount(trackingNo)).toBe(0);
  });

  // review-round 2 finding 4: isPlainObject excludes arrays too (not just primitives) — an array
  // spread into the gate_result object would produce numeric-index keys, an invented shape.
  it('a non-object gateResult (an array) also throws InvalidPortResultError and writes no imile.dtl_problems row', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('BADGATERESULTARRAY');
    const portResult = {
      gateResult: ['g1', 'g2'],
      decision: 'accept',
      confidence: 0.5,
      reason: 'malformed port result (array)',
    } as unknown as DtlContentAnalysisResult;
    const port = fakeContentAnalysisPort(portResult);
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port });
    const input = completeProblemInput(trackingNo);

    await expect(evaluateDtlProblem(ctx, input, deps)).rejects.toBeInstanceOf(InvalidPortResultError);

    expect(await getDtlProblemCount(trackingNo)).toBe(0);
  });
});

// --- Scenario: port-decides-reject-never-auto-closed ------------------------------------------

describe('Scenario: port-decides-reject-never-auto-closed — the content-analysis port itself decides reject', () => {
  it('the inserted row\'s engine_decision is "reject" and closed_by stays null', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('REJECT');
    const portResult: DtlContentAnalysisResult = {
      gateResult: { g1: 'reject', g2: 'pass', g3: 'pass', g4: 'pass' },
      decision: 'reject',
      confidence: 0.95,
      reason: 'evidence contradicts the claimed problem_type',
    };
    // The real, production FakeDtlContentAnalysisPort (../../infrastructure/evaluate-dtl-problem/
    // content-analysis-adapter.ts) — round-1 finding 8: a deterministic, fixed-result adapter with
    // no call-tracking of its own, so it fits this scenario (which asserts only the inserted row's
    // own fields, never `port.calls`) rather than Scenario 2 (complete-problem-delegates-to-port-
    // verbatim), which genuinely needs the call-count/evidence assertions the inline
    // `fakeContentAnalysisPort` helper provides and the real class does not.
    const port = new FakeDtlContentAnalysisPort(portResult);
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port });
    const input = completeProblemInput(trackingNo);

    const result = await evaluateDtlProblem(ctx, input, deps);

    expect(result.engineDecision).toBe('reject');

    const row = await getDtlProblemRow(trackingNo);
    expect(row?.engine_decision).toBe('reject');
    // This slice never auto-closes anything, "reject" or otherwise (ADR-27 autonomy is a later
    // slice) — closed_by is unconditionally null, not merely null-because-not-reject.
    expect(row?.closed_by).toBeNull();
    expect(row?.auditor_decision).toBeNull();
  });
});

// --- Scenario: port-not-configured-throws-and-writes-nothing -----------------------------------

describe('Scenario: port-not-configured-throws-and-writes-nothing — the content-analysis port is not configured', () => {
  it('the call throws PortNotConfiguredError and no imile.dtl_problems row is written', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('NOTCONFIG');
    // Gherkin Given: "the content-analysis port is the NotConfiguredDtlContentAnalysisPort stub" —
    // no port override, so the REAL production default (composition.ts's
    // NotConfiguredDtlContentAnalysisPort, ../../infrastructure/evaluate-dtl-problem/content-
    // analysis-adapter.ts) actually runs end to end through evaluateDtlProblem, not a hand-written
    // stand-in (round-1 finding 7).
    const deps = createEvaluateDtlProblemDeps({ clock, ids });
    const input = completeProblemInput(trackingNo);

    await expect(evaluateDtlProblem(ctx, input, deps)).rejects.toBeInstanceOf(PortNotConfiguredError);

    expect(await getDtlProblemCount(trackingNo)).toBe(0);

    const auditRows = await auditRowsForCorrelation(input.correlationId);
    expect(auditRows.filter((r) => r.table_name === 'dtl_problems')).toHaveLength(0);
  });

  it('createEvaluateDtlProblemDeps defaults deps.port to a port that throws PortNotConfiguredError (production wiring default)', async () => {
    const defaultDeps = createEvaluateDtlProblemDeps({ clock, ids });
    await expect(
      defaultDeps.port.evaluate({
        trackingNo: 'SHP-DEFAULTPORT',
        driverCode: null,
        problemType: 'no_delivery',
        evidenceUrls: ['https://evidence.example/x.jpg'],
        customerText: 'text',
        driverText: null,
        raisedAt: new Date('2026-09-24T12:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(PortNotConfiguredError);
  });
});

// --- ctx without an actor -> MissingActorError (round-1 finding 9) --------------------------

describe('a ctx with no userId throws MissingActorError — every command\'s actor is ctx.userId ONLY', () => {
  it('evaluateDtlProblem rejects with MissingActorError and never reaches the content-analysis port or writes a row', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('NOACTOR');
    const port = unreachableContentAnalysisPort();
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port });
    const noActorCtx = { userId: null, clientId: null, isInternal: true };
    const input = completeProblemInput(trackingNo);

    await expect(evaluateDtlProblem(noActorCtx, input, deps)).rejects.toBeInstanceOf(MissingActorError);

    expect(await getDtlProblemCount(trackingNo)).toBe(0);
  });
});
