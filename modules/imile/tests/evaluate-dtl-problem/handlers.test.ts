// modules/imile/tests/evaluate-dtl-problem/handlers.test.ts — WBS 3.17 (part 1).
//
// Exercises the api layer's contract (../../api/evaluate-dtl-problem/handlers.ts) for the trigger
// endpoint that evaluates one raised DTL problem — one test per mapping:
//   - a missing Idempotency-Key header -> 400 (CLAUDE.md · ARCHITECTURE: "Every write endpoint
//     requires an Idempotency-Key");
//   - a body that fails the Zod contract -> 400;
//   - a replayed call that hits IdempotencyConflictError (same key, different body) -> 409;
//   - a same key / same body replay -> 200, identical response, no second port call;
//   - an unexpected thrown error (e.g. PortNotConfiguredError, or any untyped error) -> 500,
//     generic detail, logged through deps.logger.error (pino, no console.log — CLAUDE.md ·
//     AGENT CONSTRAINTS).
//
// Idempotency-Key shape: 400 missing / 409 conflict / 200 replay, same convention this module's
// slices already use elsewhere. Fixture/RLS pattern: admin pool, one real identity.users row for
// the actor — same as ./evaluate-dtl-problem.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createEvaluateDtlProblemDeps } from '../../api/evaluate-dtl-problem/composition.js';
import { PortNotConfiguredError } from '../../domain/evaluate-dtl-problem/errors.js';
import type { Logger } from '../../application/evaluate-dtl-problem/ports.js';
import type {
  DtlContentAnalysisPort,
  DtlContentAnalysisResult,
} from '../../application/evaluate-dtl-problem/ports.js';

// The module under test — does not exist yet with this error-mapping behaviour verified (RED).
import { handleEvaluateDtlProblem, type ApiRequest } from '../../api/evaluate-dtl-problem/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000003170c1';

const clock = new FixedClock(new Date('2026-09-25T02:00:00.000Z'));
const ids = new SequentialIdGenerator(31702);
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

const usedTrackingNos: string[] = [];

/** Deep, key-order-independent canonicalization for the byte-identical replay comparison below —
 *  the idempotent-replay path round-trips the stored response through a jsonb column, which
 *  reorders keys harmlessly, so a plain toEqual would produce a false failure. */
function canonicalJson(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, sortKeys(val)]),
      );
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}

function fakeContentAnalysisPort(
  result: DtlContentAnalysisResult,
): DtlContentAnalysisPort & { readonly callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    evaluate: async (): Promise<DtlContentAnalysisResult> => {
      calls += 1;
      return result;
    },
  };
}

/** A port fake that answers ONE deterministic result the first time it is called, and THROWS if it
 *  is ever called a second time — a fixed-result fake alone could not tell "the command genuinely
 *  ran only once (idempotency replay served the cached response)" apart from "the command ran a
 *  second time and happened to see the same result again". */
function singleUseContentAnalysisPort(
  result: DtlContentAnalysisResult,
): DtlContentAnalysisPort & { readonly callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    evaluate: async (): Promise<DtlContentAnalysisResult> => {
      calls += 1;
      if (calls > 1) {
        throw new Error('content-analysis port invoked a second time — an idempotent replay must never re-run the command');
      }
      return result;
    },
  };
}

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function validBody(trackingNo?: string): Record<string, unknown> {
  const tracking = trackingNo ?? `SHP-HANDLERS-${randomUUID()}`;
  usedTrackingNos.push(tracking);
  return {
    trackingNo: tracking,
    driverCode: 'DRV-9001',
    problemType: 'wrong_address',
    evidenceUrls: ['https://evidence.example/photo-1.jpg'],
    customerText: 'العميل يقول العنوان غير صحيح',
    driverText: null,
    raisedAt: '2026-09-24T12:00:00.000Z',
    correlationId: randomUUID(),
  };
}

function spyLogger(): Logger & { readonly errorCalls: Array<[Record<string, unknown>, string]> } {
  const errorCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    errorCalls,
    error: (obj, msg) => {
      errorCalls.push([obj, msg]);
    },
    info: () => {
      // not asserted here.
    },
  };
}

// D-183: a DELETE against the shared database is only allowed in this suite's own `afterAll`, not
// in `beforeAll` (round-1 finding 11) — `beforeAll` only ever upserts the fixture actor.
beforeAll(async () => {
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [FIXTURE_ACTOR_UUID, `_dtlengine_handlers_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات محرك التدقيق الحي'],
  );
});

afterAll(async () => {
  if (usedTrackingNos.length > 0) {
    await pool.query(`delete from imile.dtl_problems where tracking_no = any($1::text[])`, [usedTrackingNos]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

const acceptResult: DtlContentAnalysisResult = {
  gateResult: { g1: 'pass', g2: 'pass', g3: 'pass', g4: 'pass' },
  decision: 'accept',
  confidence: 0.9,
  reason: 'evidence matches problem_type',
};

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleEvaluateDtlProblem: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port: fakeContentAnalysisPort(acceptResult) });
    const result = await handleEvaluateDtlProblem(requestWithoutKey(validBody()), deps);
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handleEvaluateDtlProblem: a body missing trackingNo -> 400', async () => {
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port: fakeContentAnalysisPort(acceptResult) });
    const body = validBody();
    delete body['trackingNo'];
    const result = await handleEvaluateDtlProblem(requestWithKey(body), deps);
    expect(result.status).toBe(400);
  });

  it('handleEvaluateDtlProblem: a body carrying a non-uuid correlationId -> 400', async () => {
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port: fakeContentAnalysisPort(acceptResult) });
    const body = { ...validBody(), correlationId: 'not-a-uuid' };
    const result = await handleEvaluateDtlProblem(requestWithKey(body), deps);
    expect(result.status).toBe(400);
  });
});

describe('a replayed call with the same Idempotency-Key but a DIFFERENT body -> 409 IdempotencyConflictError', () => {
  it('handleEvaluateDtlProblem: same key, different body on the second call -> 409, title "IdempotencyConflictError"', async () => {
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port: fakeContentAnalysisPort(acceptResult) });
    const idempotencyKey = randomUUID();
    const firstBody = validBody();

    const first = await handleEvaluateDtlProblem(requestWithKey(firstBody, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = validBody(); // a different trackingNo/correlationId -> different hash.
    const result = await handleEvaluateDtlProblem(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  it('handleEvaluateDtlProblem: same key, same body on the second call -> 200, byte-identical response, port invoked exactly once (no second evaluation)', async () => {
    const port = singleUseContentAnalysisPort(acceptResult);
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port });
    const idempotencyKey = randomUUID();
    const body = validBody();

    const first = await handleEvaluateDtlProblem(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleEvaluateDtlProblem(requestWithKey(body, idempotencyKey), deps);
    expect(second.status).toBe(200);
    // Byte-identical (key-order-independent canonical form) — not merely deep-equal, ruling out a
    // re-run that coincidentally produced the same shape.
    expect(second).toEqual(first);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(port.callCount()).toBe(1);
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleEvaluateDtlProblem: PortNotConfiguredError -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const brokenPort: DtlContentAnalysisPort = {
      evaluate: async () => {
        throw new PortNotConfiguredError(
          'DtlContentAnalysisPort is not configured — no OCR/handwriting-analysis vendor chosen yet.',
        );
      },
    };
    const deps = createEvaluateDtlProblemDeps({ clock, ids, logger, port: brokenPort });
    const body = validBody();
    const correlationId = body['correlationId'] as string;

    const result = await handleEvaluateDtlProblem(requestWithKey(body), deps);

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/OCR\/handwriting-analysis vendor/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
  });
});

describe('a ctx with no userId maps to a 422 Problem titled MissingActorError (round-1 finding 9)', () => {
  it('handleEvaluateDtlProblem: request.ctx.userId is null -> 422, title "MissingActorError"', async () => {
    const deps = createEvaluateDtlProblemDeps({ clock, ids, port: fakeContentAnalysisPort(acceptResult) });
    const noActorRequest: ApiRequest<Record<string, unknown>> = {
      headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
      body: validBody(),
      ctx: { userId: null, clientId: null, isInternal: true },
    };

    const result = await handleEvaluateDtlProblem(noActorRequest, deps);

    expect(result.status).toBe(422);
    expect('body' in result && result.body).toMatchObject({ title: 'MissingActorError' });
  });
});

describe('createEvaluateDtlProblemDeps accepts an injected logger and port', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createEvaluateDtlProblemDeps({ clock, ids, logger, port: fakeContentAnalysisPort(acceptResult) });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.port defaults to a port throwing PortNotConfiguredError when none is injected (production wiring default)', async () => {
    const defaultDeps = createEvaluateDtlProblemDeps({ clock, ids });
    await expect(
      defaultDeps.port.evaluate({
        trackingNo: 'SHP-DEFAULTPORT-HANDLER',
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
