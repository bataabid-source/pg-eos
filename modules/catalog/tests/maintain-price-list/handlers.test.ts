// modules/catalog/tests/maintain-price-list/handlers.test.ts — WBS 1.2, M03 catalog.
//
// The api layer's contract (modules/catalog/api/maintain-price-list/handlers.ts), one test per
// mapping (Master decision 12, slice brief):
//   - a missing Idempotency-Key -> 400 Problem;
//   - a Zod failure (price '0', price '-1', a bad uuid, both segmentId and clientId) -> 400;
//   - PriceBelowFloorError -> 422 (the acceptance criterion's own error, mapped as EVERY other
//     typed domain error is: decision 12 says "every other typed domain error -> 422", no
//     per-error whitelist like the golden slice needed);
//   - StaleVersionError and IdempotencyConflictError -> 409;
//   - an unknown error -> 500, logged once via deps.logger.error, never leaked to the client;
//   - a success call -> 200 with the command's own result.
// `title` is always `error.name` (golden convention, unchanged here).
//
// HANDLER NAMES (mirrors the golden `handle<Command>` convention — modules/wms/api/receive-inbound
// /handlers.ts's own exports, e.g. `handleApproveInbound`): handleCreatePriceList,
// handleUpsertPriceListLine, handleImportPriceListLines, handleActivatePriceList,
// handleExpirePriceList, handleGrantPriceException.
//
// CHOSEN PORT NAME (pg-tester default, for the "unknown error" test's broken-deps override):
// `deps.repo.getPriceListForUpdate` — mirrors the golden `deps.repo.getOrderForUpdate`.
//
// Fixture/RLS pattern: same admin-pool style as ./maintain-price-list.test.ts, deliberately
// minimal (one draft price list, one CFO actor) — this file only exercises the API-mapping LAYER.
// platform.audit_log is never deleted; ST-01's min_price/standard_cost are set here via the admin
// pool and restored to NULL in afterAll.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

import { createMaintainPriceListDeps } from '../../api/maintain-price-list/composition.js';
import type { Logger } from '../../application/maintain-price-list/ports.js';
import {
  handleActivatePriceList,
  handleCreatePriceList,
  handleImportPriceListLines,
  handleUpsertPriceListLine,
  type ApiRequest,
} from '../../api/maintain-price-list/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const ENTITY_CODE_PST = 'PST';
const SERVICE_CODE_ST01 = 'ST-01';
const SERVICE_CODE_HD04 = 'HD-04';
const ST01_STANDARD_COST = '100.000';
const ST01_MIN_PRICE = '115.000'; // 13B:2815 markup 15% applied to ST01_STANDARD_COST (fixture only).
const HD04_STANDARD_COST = '50.000';
const HD04_MIN_PRICE = '57.500'; // 13B:2815 markup 15% applied to HD04_STANDARD_COST (fixture only).
const CURRENCY_KWD = 'KWD';
const ROLE_CFO = 'CFO';

const FIXTURE_CFO_ACTOR_UUID = '00000000-0000-4000-8000-000000013101';
const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(1310);
const deps = createMaintainPriceListDeps({ clock, ids });
const ctx = { userId: FIXTURE_CFO_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let draftListId: string;
let draftListVersion: number;
const extraListIds: string[] = [];

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
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

async function insertFreshDraftList(): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into catalog.price_lists (entity_id, code, name_ar, valid_from, is_internal, status)
     values ($1, $2, $3, $4, false, 'draft') returning id, version`,
    [entityId, `PL-HANDLERS-${randomUUID()}`, 'قائمة اختبار معالجات التسعير', '2026-01-01'],
  );
  const row = result.rows[0] as { id: string; version: number };
  extraListIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [ENTITY_CODE_PST]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  await pool.query(`update catalog.services set min_price = $1, standard_cost = $2 where code = $3`, [
    ST01_MIN_PRICE,
    ST01_STANDARD_COST,
    SERVICE_CODE_ST01,
  ]);
  await pool.query(`update catalog.services set min_price = $1, standard_cost = $2 where code = $3`, [
    HD04_MIN_PRICE,
    HD04_STANDARD_COST,
    SERVICE_CODE_HD04,
  ]);

  const draft = await insertFreshDraftList();
  draftListId = draft.id;
  draftListVersion = draft.version;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_CFO_ACTOR_UUID, `_pricelist_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات التسعير'],
  );
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [FIXTURE_CFO_ACTOR_UUID, entityId]);
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [ROLE_CFO]);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [FIXTURE_CFO_ACTOR_UUID, (roleResult.rows[0] as { id: string }).id]);
});

afterAll(async () => {
  await pool.query(`update catalog.services set min_price = null, standard_cost = null where code in ($1, $2)`, [
    SERVICE_CODE_ST01,
    SERVICE_CODE_HD04,
  ]);
  if (draftListId) {
    await pool.query(`delete from catalog.price_list_lines where price_list_id = $1`, [draftListId]);
    await pool.query(`delete from catalog.price_lists where id = $1`, [draftListId]);
  }
  if (extraListIds.length > 0) {
    await pool.query(`delete from catalog.price_list_lines where price_list_id = any($1::uuid[])`, [extraListIds]);
    await pool.query(`delete from catalog.price_lists where id = any($1::uuid[])`, [extraListIds]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_CFO_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleCreatePriceList: no Idempotency-Key header -> 400', async () => {
    const result = await handleCreatePriceList(
      requestWithoutKey({
        entityId,
        code: `PL-NOKEY-${randomUUID()}`,
        nameAr: 'قائمة بلا مفتاح',
        segmentId: null,
        clientId: null,
        validFrom: '2026-01-01',
        validTo: null,
        isInternal: false,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleCreatePriceList: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleCreatePriceList(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleUpsertPriceListLine: price "0" -> 400 (A3 "never price at zero")', async () => {
    const result = await handleUpsertPriceListLine(
      requestWithKey({
        priceListId: draftListId,
        serviceCode: SERVICE_CODE_ST01,
        price: '0',
        currency: CURRENCY_KWD,
        expectedVersion: draftListVersion,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleUpsertPriceListLine: price "-1" -> 400', async () => {
    const result = await handleUpsertPriceListLine(
      requestWithKey({
        priceListId: draftListId,
        serviceCode: SERVICE_CODE_ST01,
        price: '-1',
        currency: CURRENCY_KWD,
        expectedVersion: draftListVersion,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleUpsertPriceListLine: a non-uuid priceListId -> 400', async () => {
    const result = await handleUpsertPriceListLine(
      requestWithKey({
        priceListId: 'not-a-uuid',
        serviceCode: SERVICE_CODE_ST01,
        price: '10.000',
        currency: CURRENCY_KWD,
        expectedVersion: 1,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleCreatePriceList: both segmentId and clientId set -> 400', async () => {
    const result = await handleCreatePriceList(
      requestWithKey({
        entityId,
        code: `PL-BOTH-${randomUUID()}`,
        nameAr: 'قائمة خاطئة',
        segmentId: randomUUID(),
        clientId: randomUUID(),
        validFrom: '2026-01-01',
        validTo: null,
        isInternal: false,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('a success call returns 200 with the command result', () => {
  it('handleCreatePriceList: a valid body -> 200, body has priceListId and version 1', async () => {
    const result = await handleCreatePriceList(
      requestWithKey({
        entityId,
        code: `PL-OK-${randomUUID()}`,
        nameAr: 'قائمة ناجحة',
        segmentId: null,
        clientId: null,
        validFrom: '2026-01-01',
        validTo: null,
        isInternal: false,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect((result.body as { version: number }).version).toBe(1);
      const priceListId = (result.body as { priceListId: string }).priceListId;
      extraListIds.push(priceListId);
    }
  });
});

describe('PriceBelowFloorError maps to 422, title = error.name (decision 12: every other typed error -> 422)', () => {
  it('handleUpsertPriceListLine: a price below ST-01\'s floor -> 422, title "PriceBelowFloorError"', async () => {
    const list = await insertFreshDraftList();
    const result = await handleUpsertPriceListLine(
      requestWithKey({
        priceListId: list.id,
        serviceCode: SERVICE_CODE_ST01,
        price: '1.000',
        currency: CURRENCY_KWD,
        expectedVersion: list.version,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'PriceBelowFloorError' });
  });
});

// Fix round 1 (pg-reviewer F3) — the row number and serviceCode of an ImportPriceListLines
// rejection must reach the CLIENT (the Problem body), not just the thrown domain error's own
// fields — someone reading only the HTTP response needs to know WHICH row to fix.
describe('ImportPriceListLines: the offending row number and serviceCode reach the client (F3)', () => {
  it('handleImportPriceListLines: row 2 (rowIndex 1, HD-04) below floor -> 422, detail names "row 1" and "HD-04"', async () => {
    const list = await insertFreshDraftList();
    const result = await handleImportPriceListLines(
      requestWithKey({
        priceListId: list.id,
        rows: [
          { serviceCode: SERVICE_CODE_ST01, price: ST01_MIN_PRICE, currency: CURRENCY_KWD },
          { serviceCode: SERVICE_CODE_HD04, price: '1.000', currency: CURRENCY_KWD },
        ],
        expectedVersion: list.version,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      title: 'PriceBelowFloorError',
      detail: expect.stringMatching(/row 1/i),
    });
    expect(result.body).toMatchObject({
      detail: expect.stringContaining(SERVICE_CODE_HD04),
    });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleActivatePriceList: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const result = await handleActivatePriceList(
      requestWithKey({
        priceListId: draftListId,
        expectedVersion: draftListVersion + 999,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first', () => {
  it('handleCreatePriceList: identical key + body -> identical response, one row inserted', async () => {
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      code: `PL-REPLAY-${randomUUID()}`,
      nameAr: 'قائمة إعادة تشغيل',
      segmentId: null,
      clientId: null,
      validFrom: '2026-01-01',
      validTo: null,
      isInternal: false,
      correlationId: randomUUID(),
    };

    const first = await handleCreatePriceList(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraListIds.push((first.body as { priceListId: string }).priceListId);

    const second = await handleCreatePriceList(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);
  });

  it('handleCreatePriceList: the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const idempotencyKey = randomUUID();
    const body = {
      entityId,
      code: `PL-REPLAY-CONFLICT-${randomUUID()}`,
      nameAr: 'قائمة تعارض',
      segmentId: null,
      clientId: null,
      validFrom: '2026-01-01',
      validTo: null,
      isInternal: false,
      correlationId: randomUUID(),
    };

    const first = await handleCreatePriceList(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraListIds.push((first.body as { priceListId: string }).priceListId);

    const differentBody = { ...body, correlationId: randomUUID(), code: `PL-REPLAY-CONFLICT-2-${randomUUID()}` };
    const result = await handleCreatePriceList(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleActivatePriceList: an unexpected repository failure -> 500, generic detail, logger.error called once', async () => {
    const list = await insertFreshDraftList();
    const logger = spyLogger();
    const depsWithSpyLogger = createMaintainPriceListDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getPriceListForUpdate: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleActivatePriceList(
      requestWithKey({ priceListId: list.id, expectedVersion: list.version, correlationId }),
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

// --- createMaintainPriceListDeps({ clock, ids, logger }) -----------------------------------------

describe('createMaintainPriceListDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createMaintainPriceListDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createMaintainPriceListDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
