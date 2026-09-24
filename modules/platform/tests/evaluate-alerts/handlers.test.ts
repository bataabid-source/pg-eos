// modules/platform/tests/evaluate-alerts/handlers.test.ts — WBS 5.13 part 1, replicated from the
// golden slice (modules/wms/tests/receive-inbound/handlers.test.ts) — this use case's api layer is
// modules/platform/api/evaluate-alerts/handlers.ts, scoped (per the build brief) to the
// AcknowledgeAlert handler only: EvaluateAlertRules is the pg-boss job body / internal trigger, not
// an HTTP write endpoint, in part 1.
//
// One test per mapping:
//   - a missing Idempotency-Key -> 400 Problem;
//   - an invalid body (contract validation failure) -> 400 Problem;
//   - StaleVersionError -> 409, title = error.name;
//   - AlertAlreadyAcknowledgedError -> 409;
//   - RoleRequiredError (ctx.isInternal = false) -> 403;
//   - MissingActorError (ctx.userId = null) -> 422 UNPROCESSABLE_ENTITY (fix round 2 finding 4: the
//     round-1 400 DEFAULT is overruled — the golden slice's own handlers.ts
//     (modules/wms/api/receive-inbound/handlers.ts ~L211-216) and this module's own
//     domain/evaluate-alerts/errors.ts already say 422; pg-backend is flipping the handlers.ts
//     mapping to match, concurrently with this fix round);
//   - AlertLogNotFoundError (unknown/RLS-hidden id) -> 404;
//   - an unknown error -> 500 Problem, and deps.logger.error DOES receive the error line (spyLogger
//     existed but was never asserted — pg-reviewer fix round 1 finding 12);
//   - the same Idempotency-Key + body twice -> the second response equals the first, the command
//     ran exactly once (version bumped once, EXACTLY ONE platform.audit_log row for the SAME
//     correlationId as the first call — a replay must not re-run the command's audit write either).
//
// Fixture/RLS pattern: same admin-pool style as ./evaluate-alerts.test.ts, deliberately minimal
// (one identity.users fixture actor, fresh platform.alert_log rows per test) since this file only
// exercises the API-mapping LAYER, not every business scenario (already covered by
// evaluate-alerts.test.ts). platform.audit_log is never deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import type { WithContextCtx } from '@pg-eos/db';
import { createEvaluateAlertsDeps } from '../../api/evaluate-alerts/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — EvaluateAlertsDeps carries `logger: Logger`
// (../../application/evaluate-alerts/ports.ts), and createEvaluateAlertsDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger.
import type { Logger } from '../../application/evaluate-alerts/ports.js';

// The module under test — does not exist yet (RED).
import { handleAcknowledgeAlert, type ApiRequest } from '../../api/evaluate-alerts/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000513c1';
const clock = new FixedClock(new Date('2026-09-24T09:00:00.000Z'));
const ids = new SequentialIdGenerator(5131);
const deps = createEvaluateAlertsDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

const fixtureAlertLogIds: number[] = [];

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string, overrideCtx?: WithContextCtx): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx: overrideCtx ?? ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

async function insertFiredAlertLogRow(entityRef: string): Promise<{ id: number; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into platform.alert_log (rule_code, entity_ref, fired_at, recipients, version)
     values ('N-13', $1, now(), $2::uuid[], 1) returning id, version`,
    [entityRef, [FIXTURE_ACTOR_UUID]],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture platform.alert_log insert returned no row');
  const id = Number(row.id);
  fixtureAlertLogIds.push(id);
  return { id, version: row.version };
}

async function alertLogVersion(id: number): Promise<number> {
  const result: QueryResult<{ version: number }> = await pool.query(
    `select version from platform.alert_log where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.alert_log row for id ${id}`);
  return row.version;
}

async function auditCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

const UNKNOWN_ALERT_LOG_ID_OFFSET = 1_000_000;

/** A bigint id guaranteed not to exist yet — AlertLogNotFoundError. */
async function unknownAlertLogId(): Promise<number> {
  const result: QueryResult<{ max_id: string | null }> = await pool.query(
    `select coalesce(max(id), 0)::text as max_id from platform.alert_log`,
  );
  return Number(result.rows[0]?.max_id ?? '0') + UNKNOWN_ALERT_LOG_ID_OFFSET;
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
    warn: () => {
      // not asserted here.
    },
  };
}

beforeAll(async () => {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_alert513_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات التنبيهات'],
  );
});

afterAll(async () => {
  if (fixtureAlertLogIds.length > 0) {
    await pool.query(`delete from platform.alert_log where id = any($1::bigint[])`, [fixtureAlertLogIds]);
  }
  // The idempotency-replay test writes a platform.idempotency_keys row for FIXTURE_ACTOR_UUID —
  // must be removed before the identity.users row it FKs to.
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleAcknowledgeAlert: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const { id, version } = await insertFiredAlertLogRow(`_alert513_h_missingkey_${randomUUID()}`);
    const result = await handleAcknowledgeAlert(
      requestWithoutKey({ alertLogId: id, expectedVersion: version, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleAcknowledgeAlert: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleAcknowledgeAlert(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleAcknowledgeAlert: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const { id, version } = await insertFiredAlertLogRow(`_alert513_h_stale_${randomUUID()}`);
    const result = await handleAcknowledgeAlert(
      requestWithKey({ alertLogId: id, expectedVersion: version + 999, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

// --- fix round 1 (pg-reviewer FAIL(19), finding 12) — the remaining typed-error mappings --------

describe('AlertAlreadyAcknowledgedError maps to 409, title = error.name', () => {
  it('handleAcknowledgeAlert: acknowledging an already-acknowledged row -> 409', async () => {
    const { id, version } = await insertFiredAlertLogRow(`_alert513_h_alreadyack_${randomUUID()}`);
    const first = await handleAcknowledgeAlert(
      requestWithKey({ alertLogId: id, expectedVersion: version, correlationId: randomUUID() }),
      deps,
    );
    expect(first.status).toBe(200);

    const second = await handleAcknowledgeAlert(
      requestWithKey({ alertLogId: id, expectedVersion: version + 1, correlationId: randomUUID() }),
      deps,
    );
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ title: 'AlertAlreadyAcknowledgedError' });
  });
});

describe('RoleRequiredError maps to 403, title = error.name', () => {
  it('handleAcknowledgeAlert: ctx.isInternal = false -> 403', async () => {
    const { id, version } = await insertFiredAlertLogRow(`_alert513_h_role_${randomUUID()}`);
    const nonInternalCtx: WithContextCtx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: false };
    const result = await handleAcknowledgeAlert(
      requestWithKey({ alertLogId: id, expectedVersion: version, correlationId: randomUUID() }, undefined, nonInternalCtx),
      deps,
    );
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });
  });
});

describe('MissingActorError maps to 422, title = error.name', () => {
  it('handleAcknowledgeAlert: ctx.userId = null -> 422 (fix round 2 finding 4)', async () => {
    const { id, version } = await insertFiredAlertLogRow(`_alert513_h_missingactor_${randomUUID()}`);
    const noActorCtx: WithContextCtx = { userId: null, clientId: null, isInternal: true };
    const result = await handleAcknowledgeAlert(
      requestWithKey({ alertLogId: id, expectedVersion: version, correlationId: randomUUID() }, undefined, noActorCtx),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'MissingActorError' });
  });
});

describe('AlertLogNotFoundError maps to 404, title = error.name', () => {
  it('handleAcknowledgeAlert: an unknown alertLogId -> 404', async () => {
    const alertLogId = await unknownAlertLogId();
    const result = await handleAcknowledgeAlert(
      requestWithKey({ alertLogId, expectedVersion: 1, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ title: 'AlertLogNotFoundError' });
  });
});

describe('an unknown error maps to 500 and IS logged through deps.logger.error', () => {
  it('handleAcknowledgeAlert: an unexpected repository failure -> 500, logger.error receives the real Error object', async () => {
    const { id, version } = await insertFiredAlertLogRow(`_alert513_h_500_${randomUUID()}`);
    const logger = spyLogger();
    const depsWithSpyLogger = createEvaluateAlertsDeps({ clock, ids, logger });
    const thrown = new Error('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getAlertLogForUpdate: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleAcknowledgeAlert(
      requestWithKey({ alertLogId: id, expectedVersion: version, correlationId }),
      brokenDeps,
    );

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first and the command ran once', () => {
  it('handleAcknowledgeAlert: identical key + body -> identical response, version bumped exactly once, EXACTLY ONE audit row', async () => {
    const { id, version } = await insertFiredAlertLogRow(`_alert513_h_replay_${randomUUID()}`);
    const idempotencyKey = randomUUID();
    const correlationId = randomUUID();
    const body = { alertLogId: id, expectedVersion: version, correlationId };

    const first = await handleAcknowledgeAlert(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    const auditCountAfterFirst = await auditCountForCorrelation(correlationId);
    expect(auditCountAfterFirst).toBe(1);

    // Same key, same body — even though expectedVersion is now stale against the bumped row, the
    // replay must return the FIRST response, not re-run the command and hit 409.
    const second = await handleAcknowledgeAlert(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    expect(await alertLogVersion(id)).toBe(version + 1); // bumped once.
    expect(await auditCountForCorrelation(correlationId)).toBe(auditCountAfterFirst); // no second row.
  });
});

// --- createEvaluateAlertsDeps({ clock, ids, logger }) --------------------------------------------

describe('createEvaluateAlertsDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createEvaluateAlertsDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createEvaluateAlertsDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
