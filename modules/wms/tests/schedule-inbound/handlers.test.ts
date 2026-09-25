// modules/wms/tests/schedule-inbound/handlers.test.ts — WBS 2.9b (lane 2).
//
// Round-1 review finding 8: the api/ layer's contract (modules/wms/api/schedule-inbound/handlers.ts)
// had NO test at all — neither the golden slice's own precedent
// (modules/wms/tests/receive-inbound/handlers.test.ts) nor the manage-space precedent
// (modules/wms/tests/manage-space/handlers.test.ts) had a counterpart here. Same convention as
// both: one test per mapping —
//   - a missing Idempotency-Key -> 400 Problem;
//   - an invalid body (a ZodError, e.g. missing expectedAt) -> 400 Problem, not a thrown exception;
//   - every typed domain error this use case can throw maps to its documented HTTP status
//     (StaleVersionError -> 409; ScheduleInPastError/InvalidVehicleTypeError/
//     IllegalTransitionError/RoleRequiredError/OrderNotFoundError -> 422), title = error.name;
//   - an unknown error -> 500 Problem, generic detail, logged through deps.logger.error with
//     { correlationId, err: <the Error object> } (CLAUDE.md · AGENT CONSTRAINTS "No console.log —
//     pino"), never sent to the client;
//   - a successful call returns 200 and bumps the order's version.
//
// Fixture/RLS pattern: same admin-pool style as ./schedule-inbound.test.ts, deliberately minimal
// (one client, one SKU, one draft order per test where a fresh row is needed) since this file only
// exercises the API-mapping LAYER, not every business scenario (already covered by
// schedule-inbound.test.ts). platform.audit_log is never deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createScheduleInboundDeps } from '../../api/schedule-inbound/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — ScheduleInboundDeps carries `logger: Logger`
// (../../application/schedule-inbound/ports.js), and createScheduleInboundDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger — same
// convention as receive-inbound's and manage-space's own handlers.test.ts.
import type { Logger } from '../../application/schedule-inbound/ports.js';

// The module under test.
import { handleScheduleInbound, type ApiRequest } from '../../api/schedule-inbound/handlers.js';
// Round-2 review finding 4: InvalidLabourCountError cannot be reached through the real command via
// the handler — the contract's own `labourCount: z.number().int().min(0)` rejects a negative value
// as a 400 ZodError first (asserted below as the contract-boundary half). The handler's own
// 422-mapping for it is therefore asserted by making the command throw the real typed error from
// the repository port (same injected-failure technique as the 500 test below) — this exercises the
// api/ layer's mapping only; the domain rule itself is asserted end-to-end in
// ./schedule-inbound.test.ts and ./invariants.property.test.ts.
import { InvalidLabourCountError } from '../../domain/schedule-inbound/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const WH_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000000209d1';
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000209d2';
const WH_MGR_ROLE_CODE = 'WH_MGR';

const CLOCK_NOW = new Date('2026-09-25T00:00:00.000Z');
const FUTURE_EXPECTED_AT = new Date(CLOCK_NOW.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();
const PAST_EXPECTED_AT = new Date(CLOCK_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

const clock = new FixedClock(CLOCK_NOW);
const ids = new SequentialIdGenerator(2092);
const deps = createScheduleInboundDeps({ clock, ids });
const ctx = { userId: WH_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let fixtureClientId: string;
let warehouseId: string;
const fixtureSkuIds: string[] = [];
const fixtureOrderIds: string[] = [];
const commandCorrelationIds: string[] = [];

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

/** A fresh draft order, independent of any other test's fixture — every scenario below that
 *  mutates the order (a successful call, a StaleVersionError, an IllegalTransitionError) needs its
 *  own row so replaying one test never collides with another's already-bumped version. */
async function insertFreshDraftOrder(status: 'draft' | 'cancelled' = 'draft'): Promise<{ id: string; version: number }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, 'INB') as doc_no`,
    [entityId],
  );
  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, '1.000', '0.00100') returning id`,
    [fixtureClientId, `SCHEDINB-HANDLERS-${randomUUID()}`, 'صنف اختبار معالجات الجدولة'],
  );
  const skuId = (skuResult.rows[0] as { id: string }).id;
  fixtureSkuIds.push(skuId);

  const orderResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
     values ($1, $2, $3, $4, $5) returning id, version`,
    [entityId, (docNoResult.rows[0] as { doc_no: string }).doc_no, fixtureClientId, warehouseId, status],
  );
  const row = orderResult.rows[0] as { id: string; version: number };
  fixtureOrderIds.push(row.id);
  return row;
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
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  const warehouseResult: QueryResult<{ id: string }> = await pool.query(
    `select id from wms.warehouses where code = 'WH1'`,
  );
  warehouseId = (warehouseResult.rows[0] as { id: string }).id;

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_schedinb_handlers_${randomUUID()}`, 'عميل اختبار معالجات الجدولة'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;

  for (const userId of [WH_MGR_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
      [userId, `_schedinb_handlers_actor_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات الجدولة'],
    );
  }
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const userId of [WH_MGR_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    for (const row of allEntitiesResult.rows) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
        userId,
        row.id,
      ]);
    }
  }
  const roleResult: QueryResult<{ id: string }> = await pool.query(
    `select id from identity.roles where code = $1`,
    [WH_MGR_ROLE_CODE],
  );
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    WH_MGR_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);
  // NO_ROLE_ACTOR_UUID deliberately gets no identity.user_roles row at all.
});

afterAll(async () => {
  if (commandCorrelationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [commandCorrelationIds]);
  }
  if (fixtureOrderIds.length > 0) {
    await pool.query(`delete from wms.order_lines where order_id = any($1::uuid[])`, [fixtureOrderIds]);
    await pool.query(`delete from wms.inbound_orders where id = any($1::uuid[])`, [fixtureOrderIds]);
  }
  if (fixtureSkuIds.length > 0) await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  for (const userId of [WH_MGR_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleScheduleInbound: no Idempotency-Key header -> 400, Problem envelope carries a title', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleScheduleInbound(
      requestWithoutKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        expectedAt: FUTURE_EXPECTED_AT,
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem, not a thrown exception', () => {
  it('handleScheduleInbound: a body missing required fields -> 400', async () => {
    const result = await handleScheduleInbound(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleScheduleInbound: a body with expectedAt missing (ZodError) -> 400, title "ZodError"', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleScheduleInbound(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ title: 'ZodError' });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleScheduleInbound: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version + 999,
        correlationId: randomUUID(),
        expectedAt: FUTURE_EXPECTED_AT,
      }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('every typed domain error maps to its documented status, title = error.name', () => {
  it('handleScheduleInbound: a past expectedAt -> 422, title "ScheduleInPastError"', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        expectedAt: PAST_EXPECTED_AT,
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'ScheduleInPastError' });
  });

  it('handleScheduleInbound: vehicleType outside the closed list -> 422, title "InvalidVehicleTypeError"', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        expectedAt: FUTURE_EXPECTED_AT,
        vehicleType: 'motorcycle',
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'InvalidVehicleTypeError' });
  });

  it('handleScheduleInbound: an order that already left draft/approved (cancelled) -> 422, title "IllegalTransitionError"', async () => {
    const order = await insertFreshDraftOrder('cancelled');
    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        expectedAt: FUTURE_EXPECTED_AT,
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });

  it('handleScheduleInbound: caller without role WH_MGR/WH_SUP -> 422, title "RoleRequiredError"', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleScheduleInbound(
      {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: {
          orderId: order.id,
          expectedVersion: order.version,
          correlationId: randomUUID(),
          expectedAt: FUTURE_EXPECTED_AT,
        },
        ctx: noRoleCtx,
      },
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });
  });

  it('handleScheduleInbound: a non-existent orderId -> 422, title "OrderNotFoundError"', async () => {
    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: randomUUID(),
        expectedVersion: 1,
        correlationId: randomUUID(),
        expectedAt: FUTURE_EXPECTED_AT,
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'OrderNotFoundError' });
  });
});

// --- Round-2 review finding 4: the four logistics-term errors map to 422 ------------------------

describe('the round-1 logistics-term errors map to 422, title = error.name (round-2 finding 4)', () => {
  // One value outside each migration 0023 CHECK — same literals as ./schedule-inbound.test.ts.
  const invalidStringTermCases = [
    { term: 'handoverPoint', patch: { handoverPoint: 'airport' }, title: 'InvalidHandoverPointError' },
    { term: 'transportBy', patch: { transportBy: 'shared' }, title: 'InvalidTransportByError' },
    { term: 'labourBy', patch: { labourBy: 'contractor' }, title: 'InvalidLabourByError' },
  ] as const;

  it.each(invalidStringTermCases)(
    'handleScheduleInbound: $term outside the closed list -> 422, title "$title"',
    async ({ patch, title }) => {
      const order = await insertFreshDraftOrder();
      const result = await handleScheduleInbound(
        requestWithKey({
          orderId: order.id,
          expectedVersion: order.version,
          correlationId: randomUUID(),
          expectedAt: FUTURE_EXPECTED_AT,
          ...patch,
        }),
        deps,
      );
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({ title });
    },
  );

  it('handleScheduleInbound: a negative labourCount is stopped at the contract boundary -> 400, title "ZodError"', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        expectedAt: FUTURE_EXPECTED_AT,
        labourCount: -1,
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ title: 'ZodError' });
  });

  it('handleScheduleInbound: InvalidLabourCountError thrown by the command -> 422, title "InvalidLabourCountError" (never a 500)', async () => {
    const order = await insertFreshDraftOrder();
    const logger = spyLogger();
    const depsWithSpyLogger = createScheduleInboundDeps({ clock, ids, logger });
    const throwingDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getOrderForUpdate: async (): Promise<never> => {
          throw new InvalidLabourCountError('ScheduleInbound: labourCount (-1) must be >= 0.');
        },
      },
    };

    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        expectedAt: FUTURE_EXPECTED_AT,
      }),
      throwingDeps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'InvalidLabourCountError' });
    // A mapped (known) error is not an unhandled one — nothing logged at error level.
    expect(logger.errorCalls).toHaveLength(0);
  });
});

describe('a successful ScheduleInbound call returns 200 and bumps the order version', () => {
  it('handleScheduleInbound: valid body, Idempotency-Key present -> 200, version bumped', async () => {
    const order = await insertFreshDraftOrder();
    const correlationId = randomUUID();
    commandCorrelationIds.push(correlationId);

    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId,
        expectedAt: FUTURE_EXPECTED_AT,
      }),
      deps,
    );
    expect(result.status).toBe(200);

    const versionResult: QueryResult<{ version: number }> = await pool.query(
      `select version from wms.inbound_orders where id = $1`,
      [order.id],
    );
    expect(versionResult.rows[0]?.version).toBe(order.version + 1);
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleScheduleInbound: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const order = await insertFreshDraftOrder();
    const logger = spyLogger();
    const depsWithSpyLogger = createScheduleInboundDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getOrderForUpdate: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleScheduleInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId,
        expectedAt: FUTURE_EXPECTED_AT,
      }),
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

// --- createScheduleInboundDeps({ clock, ids, logger }) --------------------------------------------

describe('createScheduleInboundDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createScheduleInboundDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createScheduleInboundDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
