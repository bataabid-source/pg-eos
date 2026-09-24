// modules/imile/tests/report-agent-health/handlers.test.ts — WBS 3.14.
//
// Restored per pg-reviewer finding 4 (2026-09-24, WBS 3.14 fix round): every other replicated
// slice (wms, catalog, hr, platform) tests its api/ handler layer directly, not just the
// application-layer command. This file exercises the api layer's contract
// (../../api/report-agent-health/handlers.ts), one test per mapping:
//   - a missing Idempotency-Key header -> 400;
//   - a body that fails the Zod contract -> 400;
//   - a replayed call that hits IdempotencyConflictError (same key, different body) -> 409;
//   - an unexpected thrown error -> 500, generic detail, logged through deps.logger.error (pino,
//     no console.log — CLAUDE.md · AGENT CONSTRAINTS).
//
// Shape based on the golden slice's modules/wms/tests/receive-inbound/handlers.test.ts (read-only
// reference). Fixture/RLS pattern: admin pool, one real identity.users row for the station-agent
// actor — same as ./report-agent-health.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createReportAgentHealthDeps } from '../../api/report-agent-health/composition.js';
import type { Logger } from '../../application/report-agent-health/ports.js';

// The module under test — does not exist yet with this error-mapping behaviour verified (RED).
import { handleReportAgentHealth, type ApiRequest } from '../../api/report-agent-health/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000314b1';

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(3142);
const deps = createReportAgentHealthDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

const usedAgentIds: string[] = [];

function freshAgentId(label: string): string {
  const agentId = `IMILE-STATION-HANDLERS-${label}-${randomUUID()}`;
  usedAgentIds.push(agentId);
  return agentId;
}

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function validBody(agentId: string): Record<string, unknown> {
  return {
    agentId,
    sessionValid: true,
    lastPullAt: clock.now().toISOString(),
    pendingPushes: 0,
    engineVersion: '1.0.0',
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

beforeAll(async () => {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_imilehealth_handlers_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات صحة وكيل iMile'],
  );
});

afterAll(async () => {
  if (usedAgentIds.length > 0) {
    await pool.query(`delete from imile.agent_health where agent_id = any($1::text[])`, [usedAgentIds]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleReportAgentHealth: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const result = await handleReportAgentHealth(requestWithoutKey(validBody(freshAgentId('NOKEY'))), deps);
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a body that fails the Zod contract is rejected with a 400 Problem', () => {
  it('handleReportAgentHealth: pendingPushes = -1 -> 400, not a thrown ZodError', async () => {
    const agentId = freshAgentId('BADBODY');
    const result = await handleReportAgentHealth(
      requestWithKey({ ...validBody(agentId), pendingPushes: -1 }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleReportAgentHealth: a body missing required fields -> 400', async () => {
    const result = await handleReportAgentHealth(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });
});

describe('a replayed call with the same Idempotency-Key but a DIFFERENT body -> 409 IdempotencyConflictError', () => {
  it('handleReportAgentHealth: same key, different body on the second call -> 409, title "IdempotencyConflictError"', async () => {
    const agentId = freshAgentId('IDEM-409');
    const idempotencyKey = randomUUID();
    const firstBody = validBody(agentId);

    const first = await handleReportAgentHealth(requestWithKey(firstBody, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = { ...firstBody, correlationId: randomUUID() }; // different correlationId -> different hash.
    const result = await handleReportAgentHealth(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  it('handleReportAgentHealth: same key, same body on the second call -> 200, identical response, no second insert', async () => {
    const agentId = freshAgentId('IDEM-REPLAY');
    const idempotencyKey = randomUUID();
    const body = validBody(agentId);

    const first = await handleReportAgentHealth(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleReportAgentHealth(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const countResult = await pool.query(`select count(*)::text as n from imile.agent_health where agent_id = $1`, [
      agentId,
    ]);
    expect((countResult.rows[0] as { n: string }).n).toBe('1');
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleReportAgentHealth: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const agentId = freshAgentId('UNKNOWN-500');
    const logger = spyLogger();
    const depsWithSpyLogger = createReportAgentHealthDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        insertAgentHealth: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleReportAgentHealth(
      requestWithKey({ ...validBody(agentId), correlationId }),
      brokenDeps,
    );

    expect(result.status).toBe(500);
    // The response detail is still generic — the thrown error's own message never reaches the client.
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    // err is the ACTUAL Error object (pino's own error serializer needs the real object, not just
    // its name), not a string summary.
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });
});

describe('createReportAgentHealthDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createReportAgentHealthDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createReportAgentHealthDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
