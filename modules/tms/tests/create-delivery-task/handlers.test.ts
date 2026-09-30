// modules/tms/tests/create-delivery-task/handlers.test.ts — WBS 3.4 part 1.
//
// The api layer's contract (modules/tms/api/create-delivery-task/handlers.ts), one test per mapping,
// following the golden handlers test:
//   - missing Idempotency-Key -> 400; invalid body -> 400 (ZodError);
//   - success -> 200; the same key + body replays the FIRST response and the command runs once; the
//     same key with a different body -> 409 IdempotencyConflictError (the one place replay is proven);
//   - StaleVersionError / DeliveryTaskAlreadyExistsError -> 409; OrderNotReadyError /
//     AddressIncompleteError / OrderNotFoundError -> 422 (the Problem body carries the i18nKey of the
//     three keyed errors); an unknown error -> 500, generic detail, logged, never leaked;
//   - title = error.name.
// The mapping tests make the repository port throw the real typed error (api mapping only — the rules
// themselves are asserted at their own layer: invariants.unit.test.ts, create-delivery-task.test.ts).
//
// Expected surface: modules/tms/api/create-delivery-task/handlers.ts
//   handleCreateDeliveryTask(request: ApiRequest<unknown>, deps: CreateDeliveryTaskDeps): Promise<ApiResult<CreateDeliveryTaskResult>>
//   and ApiRequest re-exported from @pg-eos/api-kit; repository port method used by the stub:
//   deps.repo.getOrderForUpdate (first port call of the use case).

import { randomUUID } from 'node:crypto';

import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
import { EntityScopeRequiredError } from '@pg-eos/db';

import { createCreateDeliveryTaskDeps } from '../../api/create-delivery-task/composition.js';
import { handleCreateDeliveryTask, type ApiRequest } from '../../api/create-delivery-task/handlers.js';
import type { Logger } from '../../application/create-delivery-task/ports.js';
import {
  AddressIncompleteError,
  DeliveryTaskAlreadyExistsError,
  OrderNotFoundError,
  MissingActorError,
  OrderNotReadyError,
  StaleVersionError,
} from '../../domain/create-delivery-task/errors.js';
import {
  ADDRESS_INCOMPLETE_I18N_KEY,
  ALREADY_EXISTS_I18N_KEY,
  ORDER_NOT_READY_I18N_KEY,
  TASK_CREATED_EVENT_TYPE,
  Fixtures,
  pool,
} from './fixtures.js';

const SEED_BASE = 3042;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL_ERROR = 500;

const clock = new FixedClock(new Date('2026-09-30T00:00:00.000Z'));
const ids = new SequentialIdGenerator(SEED_BASE);
const deps = createCreateDeliveryTaskDeps({ clock, ids });
const fx = new Fixtures('handlers');

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx: fx.ctx() };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx: fx.ctx() };
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

function depsThrowing(error: Error, logger: Logger = spyLogger()): typeof deps {
  const base = createCreateDeliveryTaskDeps({ clock, ids, logger });
  return {
    ...base,
    repo: {
      ...base.repo,
      getOrderForUpdate: async (): Promise<never> => {
        throw error;
      },
    },
  };
}

beforeAll(async () => {
  await fx.setup();
});

afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleCreateDeliveryTask: no Idempotency-Key header -> 400, a Problem body, nothing written', async () => {
    const order = await fx.insertOrder('checked');
    const result = await handleCreateDeliveryTask(requestWithoutKey(fx.body(order)), deps);
    expect(result.status).toBe(HTTP_BAD_REQUEST);
    expect('body' in result && 'title' in result.body).toBe(true);
    const rows: QueryResult<{ id: string }> = await pool.query(`select id from tms.delivery_tasks where outbound_order_id = $1`, [order.id]);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('a body missing required fields -> 400, title "ZodError", not a thrown exception', async () => {
    const result = await handleCreateDeliveryTask(requestWithKey({}), deps);
    expect(result.status).toBe(HTTP_BAD_REQUEST);
    expect(result.body).toMatchObject({ title: 'ZodError' });
  });
});

describe('success and Idempotency-Key replay', () => {
  it('a valid body -> 200 with the created task', async () => {
    const order = await fx.insertOrder('checked');
    const result = await handleCreateDeliveryTask(requestWithKey(fx.body(order)), deps);
    expect(result.status).toBe(HTTP_OK);
    expect(result.body).toMatchObject({ status: 'created', version: 1 });
  });

  it('the same key + body twice: the second response equals the first and the command ran once (one row, one outbox row)', async () => {
    const order = await fx.insertOrder('checked');
    const key = randomUUID();
    const body = fx.body(order);

    const first = await handleCreateDeliveryTask(requestWithKey(body, key), deps);
    expect(first.status).toBe(HTTP_OK);
    // expectedVersion is now stale against the bumped order — the replay must return the FIRST response, not 409.
    const second = await handleCreateDeliveryTask(requestWithKey(body, key), deps);
    expect(second).toEqual(first);

    const rows: QueryResult<{ id: string }> = await pool.query(`select id from tms.delivery_tasks where outbound_order_id = $1`, [order.id]);
    expect(rows.rows).toHaveLength(1);
    const outbox: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox where aggregate_id = $1 and event_type = $2`,
      [rows.rows[0]?.id, TASK_CREATED_EVENT_TYPE],
    );
    expect(Number((outbox.rows[0] as { n: string }).n)).toBe(1);
  });

  it('the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const order = await fx.insertOrder('checked');
    const key = randomUUID();
    const first = await handleCreateDeliveryTask(requestWithKey(fx.body(order), key), deps);
    expect(first.status).toBe(HTTP_OK);
    const result = await handleCreateDeliveryTask(requestWithKey(fx.body(order), key), deps); // new correlationId => different body.
    expect(result.status).toBe(HTTP_CONFLICT);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

describe('typed domain errors map to their HTTP status, title = error.name', () => {
  const cases = [
    { error: new StaleVersionError('stale'), status: HTTP_CONFLICT, title: 'StaleVersionError', i18nKey: undefined },
    {
      error: new DeliveryTaskAlreadyExistsError('exists'),
      status: HTTP_CONFLICT,
      title: 'DeliveryTaskAlreadyExistsError',
      i18nKey: ALREADY_EXISTS_I18N_KEY,
    },
    { error: new OrderNotReadyError('not ready'), status: HTTP_UNPROCESSABLE, title: 'OrderNotReadyError', i18nKey: ORDER_NOT_READY_I18N_KEY },
    {
      error: new AddressIncompleteError('incomplete'),
      status: HTTP_UNPROCESSABLE,
      title: 'AddressIncompleteError',
      i18nKey: ADDRESS_INCOMPLETE_I18N_KEY,
    },
    { error: new OrderNotFoundError('missing'), status: HTTP_UNPROCESSABLE, title: 'OrderNotFoundError', i18nKey: undefined },
    { error: new MissingActorError('no actor'), status: HTTP_UNPROCESSABLE, title: 'MissingActorError', i18nKey: undefined },
    {
      error: new EntityScopeRequiredError('not exactly one entity'),
      status: HTTP_UNPROCESSABLE,
      title: 'EntityScopeRequiredError',
      i18nKey: undefined,
    },
  ] as const;

  it.each(cases)('$title -> $status (never a 500)', async ({ error, status, title, i18nKey }) => {
    const logger = spyLogger();
    const order = await fx.insertOrder('checked');
    const result = await handleCreateDeliveryTask(requestWithKey(fx.body(order)), depsThrowing(error, logger));
    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ title });
    if (i18nKey !== undefined) expect(JSON.stringify(result.body)).toContain(i18nKey);
    expect(logger.errorCalls).toHaveLength(0);
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('a repository failure -> 500, message never sent to the client, logger.error receives { correlationId, err }', async () => {
    const logger = spyLogger();
    const order = await fx.insertOrder('checked');
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const correlationId = fx.nextCorrelationId();
    const result = await handleCreateDeliveryTask(
      requestWithKey(fx.body(order, { correlationId })),
      depsThrowing(thrown, logger),
    );
    expect(result.status).toBe(HTTP_INTERNAL_ERROR);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);
    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBe(thrown);
  });
});

describe('createCreateDeliveryTaskDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy', () => {
    const logger = spyLogger();
    expect(createCreateDeliveryTaskDeps({ clock, ids, logger }).logger).toBe(logger);
  });
});
