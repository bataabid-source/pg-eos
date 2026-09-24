// modules/platform/tests/maintain-site/handlers.test.ts — WBS 5.5a part 1 (lane 2).
//
// The api layer's contract (modules/platform/api/maintain-site/handlers.ts), one test per mapping:
//   - a missing Idempotency-Key -> 400 Problem (CreateSite/UpdateSite are both write commands);
//   - an invalid body, including an invalid `kind` -> 400 Problem (scenario: "An invalid kind is
//     rejected at the contract");
//   - StaleVersionError -> 409;
//   - SiteAccountRequiredError / SiteRadiusInvalidError / SiteNotFoundError / RoleRequiredError ->
//     422;
//   - an unknown error -> 500 Problem, logged via deps.logger.error, never sent to the client;
//   - the same Idempotency-Key + same body -> the second call replays the first response, no
//     second write; the same key + a DIFFERENT body -> IdempotencyConflictError (409);
//   - title = error.name.
//
// Fixture/RLS pattern: same admin-pool style as ./maintain-site.test.ts, deliberately minimal
// (one site) since this file only exercises the API-mapping LAYER, not every business scenario
// (already covered by maintain-site.test.ts). platform.audit_log is never deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createMaintainSiteDeps } from '../../api/maintain-site/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — MaintainSiteDeps carries `logger: Logger`
// (../../application/maintain-site/ports.js), and createMaintainSiteDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger.
import type { Logger } from '../../application/maintain-site/ports.js';

// The module under test — its error-mapping behaviour, per the api-layer contract above.
import { handleCreateSite, handleUpdateSite, type ApiRequest } from '../../api/maintain-site/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000505c1';
const OPS_DIR_ROLE_CODE = 'OPS_DIR';
const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(5051);
const deps = createMaintainSiteDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let draftSiteId: string;
let draftSiteVersion: number;
const extraSiteIds: string[] = [];
let nameCounter = 0;

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function uniqueName(): string {
  nameCounter += 1;
  return `موقع اختبار معالجات 5.5a رقم ${nameCounter}`;
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
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
    'PST',
  ]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  const siteResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into platform.sites (entity_id, kind, name_ar) values ($1, 'warehouse', $2) returning id, version`,
    [entityId, uniqueName()],
  );
  draftSiteId = (siteResult.rows[0] as { id: string; version: number }).id;
  draftSiteVersion = (siteResult.rows[0] as { id: string; version: number }).version;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
    FIXTURE_ACTOR_UUID,
    `_maintainsite_handlers_actor_${randomUUID()}@test.invalid`,
    'ممثل اختبار معالجات صيانة المواقع',
  ]);
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [FIXTURE_ACTOR_UUID, entityId]);
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    OPS_DIR_ROLE_CODE,
  ]);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);
});

afterAll(async () => {
  const allIds = [draftSiteId, ...extraSiteIds].filter(Boolean);
  if (allIds.length > 0) {
    await pool.query(`delete from hr.employees where default_site_id = any($1::uuid[])`, [allIds]);
    await pool.query(`delete from platform.sites where id = any($1::uuid[])`, [allIds]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleCreateSite: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const result = await handleCreateSite(
      requestWithoutKey({ kind: 'warehouse', nameAr: uniqueName(), correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });

  it('handleUpdateSite: no Idempotency-Key header -> 400', async () => {
    const result = await handleUpdateSite(
      requestWithoutKey({ siteId: draftSiteId, nameEn: 'x', expectedVersion: draftSiteVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleCreateSite: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleCreateSite(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleCreateSite: kind "depot" -> 400 (scenario: "An invalid kind is rejected at the contract"), and nothing is written', async () => {
    const nameAr = uniqueName();
    const result = await handleCreateSite(
      requestWithKey({ kind: 'depot', nameAr, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.sites where entity_id = $1 and name_ar = $2`,
      [entityId, nameAr],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('SiteNotFoundError maps to 422, title = error.name', () => {
  it('handleUpdateSite: a siteId with no visible platform.sites row -> 422, title "SiteNotFoundError"', async () => {
    const result = await handleUpdateSite(
      requestWithKey({
        siteId: randomUUID(),
        nameEn: 'x',
        expectedVersion: 1,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'SiteNotFoundError' });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleUpdateSite: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const result = await handleUpdateSite(
      requestWithKey({
        siteId: draftSiteId,
        nameEn: 'x',
        expectedVersion: draftSiteVersion + 999,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('SiteAccountRequiredError maps to 422, title = error.name', () => {
  it('handleCreateSite: kind "client_pickup" with no accountId -> 422, title "SiteAccountRequiredError"', async () => {
    const result = await handleCreateSite(
      requestWithKey({ kind: 'client_pickup', nameAr: uniqueName(), correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'SiteAccountRequiredError' });
  });
});

describe('SiteRadiusInvalidError maps to 422, title = error.name', () => {
  it('handleCreateSite: radiusM -5 -> 422, title "SiteRadiusInvalidError"', async () => {
    const result = await handleCreateSite(
      requestWithKey({ kind: 'warehouse', nameAr: uniqueName(), radiusM: -5, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'SiteRadiusInvalidError' });
  });
});

describe('RoleRequiredError maps to 422, title = error.name', () => {
  it('handleCreateSite: a caller with no granted role -> 422, title "RoleRequiredError"', async () => {
    const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000505c2';
    await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
      NO_ROLE_ACTOR_UUID,
      `_maintainsite_handlers_norole_${randomUUID()}@test.invalid`,
      'ممثل اختبار — بلا دور',
    ]);
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [NO_ROLE_ACTOR_UUID, entityId]);
    const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

    const result = await handleCreateSite(
      { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() }, body: { kind: 'warehouse', nameAr: uniqueName(), correlationId: randomUUID() }, ctx: noRoleCtx },
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });

    await pool.query(`delete from identity.user_entities where user_id = $1`, [NO_ROLE_ACTOR_UUID]);
    await pool.query(`delete from identity.users where id = $1`, [NO_ROLE_ACTOR_UUID]);
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first and the command ran once', () => {
  it('handleCreateSite: identical key + body -> identical response, one platform.sites row written', async () => {
    const idempotencyKey = randomUUID();
    const nameAr = uniqueName();
    const body = { kind: 'warehouse', nameAr, correlationId: randomUUID() };

    const first = await handleCreateSite(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleCreateSite(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.sites where entity_id = $1 and name_ar = $2`,
      [entityId, nameAr],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1); // written once, not twice.

    if (first.status === 200) extraSiteIds.push((first.body as { id: string }).id);
  });

  it('handleCreateSite: the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const idempotencyKey = randomUUID();
    const body = { kind: 'warehouse', nameAr: uniqueName(), correlationId: randomUUID() };

    const first = await handleCreateSite(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraSiteIds.push((first.body as { id: string }).id);

    const differentBody = { kind: 'warehouse', nameAr: uniqueName(), correlationId: randomUUID() };
    const result = await handleCreateSite(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleCreateSite: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const depsWithSpyLogger = createMaintainSiteDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...(depsWithSpyLogger as unknown as { repo: Record<string, unknown> }).repo,
        insertSite: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleCreateSite(
      requestWithKey({ kind: 'warehouse', nameAr: uniqueName(), correlationId }),
      brokenDeps as unknown as typeof deps,
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

// --- createMaintainSiteDeps({ clock, ids, logger }) --------------------------------------------

describe('createMaintainSiteDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createMaintainSiteDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createMaintainSiteDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
