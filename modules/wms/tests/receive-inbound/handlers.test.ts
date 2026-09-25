// modules/wms/tests/receive-inbound/handlers.test.ts — WBS 2.9, THE GOLDEN SLICE.
//
// The api layer's contract (modules/wms/api/receive-inbound/handlers.ts), one test per mapping:
//   - a missing Idempotency-Key -> 400 Problem;
//   - an invalid body -> 400 Problem;
//   - StaleVersionError -> 409, IllegalTransitionError -> 422, and the newer typed errors
//     (LineNotFoundError/LineAlreadyReceivedError/LineAlreadyPutAwayError) -> 422 (or 404 if
//     pg-backend reports one — asserted as membership below, never a single hardcoded number);
//   - an unknown error -> 500 Problem;
//   - title = error.name.
//
// Fixture/RLS pattern: same admin-pool style as ./receive-inbound.test.ts, deliberately minimal
// (one client, one SKU, one order) since this file only exercises the API-mapping LAYER, not every
// business scenario (already covered by receive-inbound.test.ts). platform.audit_log is never
// deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createReceiveInboundDeps } from '../../api/receive-inbound/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — ReceiveInboundDeps carries `logger: Logger`
// (../../application/receive-inbound/ports.ts), and createReceiveInboundDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger.
import type { Logger } from '../../application/receive-inbound/ports.js';

// The module under test — does not exist yet with this error-mapping behaviour (RED).
import {
  handleApproveInbound,
  handleCancelInbound,
  handleReceiveLine,
  type ApiRequest,
} from '../../api/receive-inbound/handlers.js';
// WBS 2.9b round-2 review finding 4: the eight typed errors the extended approveInbound (D2) /
// cancelInbound (D3) can throw. Two of them cannot be reached through the real command via the
// handler, because the contract rejects the input first as a 400 ZodError (asserted below as the
// contract-boundary half): a negative labourCount (`z.number().int().min(0)`) and an empty
// cancelReason (`z.string().min(1)`). For those two, the handler's own 422-mapping is asserted by
// making the command throw the real typed error from the repository port (same injected-failure
// technique as the 500 test below) — api/-layer mapping only; the domain rules themselves are
// asserted end-to-end in ./receive-inbound.test.ts.
import { CancelReasonRequiredError, InvalidLabourCountError } from '../../domain/schedule-inbound/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000209c1';
const WH_MGR_ROLE_CODE = 'WH_MGR';
const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(2091);
const deps = createReceiveInboundDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let fixtureClientId: string;
let fixtureSkuId: string;
let draftOrderId: string;
let draftOrderVersion: number;
let warehouseId: string;
const extraOrderIds: string[] = [];

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

/** A fresh draft order, independent of the shared `draftOrderId` fixture — the idempotency tests
 *  below approve their own order so replaying ApproveInbound against it never collides with
 *  another test's already-bumped version. */
async function insertFreshDraftOrder(): Promise<{ id: string; version: number }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, 'INB') as doc_no`,
    [entityId],
  );
  const orderResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
     values ($1, $2, $3, $4, 'draft') returning id, version`,
    [entityId, (docNoResult.rows[0] as { doc_no: string }).doc_no, fixtureClientId, warehouseId],
  );
  const row = orderResult.rows[0] as { id: string; version: number };
  extraOrderIds.push(row.id);
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

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_recvinb_handlers_${randomUUID()}`, 'عميل اختبار معالجات الاستلام'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;

  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, '1.000', '0.00100') returning id`,
    [fixtureClientId, `RECVINB-HANDLERS-${randomUUID()}`, 'صنف اختبار معالجات الاستلام'],
  );
  fixtureSkuId = (skuResult.rows[0] as { id: string }).id;

  const warehouseResult: QueryResult<{ id: string }> = await pool.query(
    `select id from wms.warehouses where code = 'WH1'`,
  );
  warehouseId = (warehouseResult.rows[0] as { id: string }).id;

  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, 'INB') as doc_no`,
    [entityId],
  );
  const orderResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
     values ($1, $2, $3, $4, 'draft') returning id, version`,
    [entityId, (docNoResult.rows[0] as { doc_no: string }).doc_no, fixtureClientId, warehouseId],
  );
  draftOrderId = (orderResult.rows[0] as { id: string; version: number }).id;
  draftOrderVersion = (orderResult.rows[0] as { id: string; version: number }).version;

  // Idempotent against a leftover row from a previously interrupted run reusing the same fixed
  // fixture id — platform.idempotency_keys FKs to identity.users, so it goes first.
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_recvinb_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات الاستلام'],
  );
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const row of allEntitiesResult.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
      FIXTURE_ACTOR_UUID,
      row.id,
    ]);
  }
  const roleResult: QueryResult<{ id: string }> = await pool.query(
    `select id from identity.roles where code = $1`,
    [WH_MGR_ROLE_CODE],
  );
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);
});

afterAll(async () => {
  if (draftOrderId) {
    await pool.query(`delete from wms.order_lines where order_id = $1`, [draftOrderId]);
    await pool.query(`delete from wms.inbound_orders where id = $1`, [draftOrderId]);
  }
  if (extraOrderIds.length > 0) {
    await pool.query(`delete from wms.order_lines where order_id = any($1::uuid[])`, [extraOrderIds]);
    await pool.query(`delete from wms.inbound_orders where id = any($1::uuid[])`, [extraOrderIds]);
  }
  if (fixtureSkuId) await pool.query(`delete from wms.skus where id = $1`, [fixtureSkuId]);
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  // The idempotency-replay tests above write a platform.idempotency_keys row for
  // FIXTURE_ACTOR_UUID — must be removed before the identity.users row it FKs to.
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleApproveInbound: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const result = await handleApproveInbound(
      requestWithoutKey({ orderId: draftOrderId, expectedVersion: draftOrderVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });

  // WBS 2.9b pg-reviewer round-3 finding 4a: CancelInbound now requires an Idempotency-Key like
  // every other command (brief Scenario section) — no test previously proved the missing-header
  // rejection for it.
  it('handleCancelInbound: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const result = await handleCancelInbound(
      requestWithoutKey({
        orderId: draftOrderId,
        expectedVersion: draftOrderVersion,
        correlationId: randomUUID(),
        cancelReason: 'client requested cancellation',
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleApproveInbound: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleApproveInbound(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleApproveInbound: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const result = await handleApproveInbound(
      requestWithKey({
        orderId: draftOrderId,
        expectedVersion: draftOrderVersion + 999,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('IllegalTransitionError maps to 422, title = error.name', () => {
  it('handleReceiveLine on a still-draft order -> 422, title "IllegalTransitionError"', async () => {
    const lineResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
       values ('wms.inbound_orders', $1, 1, $2, '5.000', 'EA') returning id`,
      [draftOrderId, fixtureSkuId],
    );
    const lineId = (lineResult.rows[0] as { id: string }).id;

    const result = await handleReceiveLine(
      requestWithKey({
        orderId: draftOrderId,
        lineId,
        qtyActual: '5.000',
        expectedVersion: draftOrderVersion,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });
});

describe('a missing (or RLS-hidden) order maps to a typed 422 Problem, never a 500', () => {
  it('handleApproveInbound against a non-existent orderId -> 422 OrderNotFoundError', async () => {
    const result = await handleApproveInbound(
      requestWithKey({ orderId: randomUUID(), expectedVersion: 1, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'OrderNotFoundError' });
  });
});

describe('a cross-order line (LineNotFoundError) maps to 404 or 422, never a bare thrown exception', () => {
  it('handleReceiveLine with a lineId that does not belong to orderId', async () => {
    const otherOrderResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
       select entity_id, doc_no || '-X', client_id, warehouse_id, status from wms.inbound_orders where id = $1
       returning id`,
      [draftOrderId],
    );
    const otherOrderId = (otherOrderResult.rows[0] as { id: string }).id;
    const otherLineResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
       values ('wms.inbound_orders', $1, 1, $2, '3.000', 'EA') returning id`,
      [otherOrderId, fixtureSkuId],
    );
    const foreignLineId = (otherLineResult.rows[0] as { id: string }).id;

    try {
      const result = await handleReceiveLine(
        requestWithKey({
          orderId: draftOrderId, // the ORIGINAL order — foreignLineId belongs to a DIFFERENT order.
          lineId: foreignLineId,
          qtyActual: '3.000',
          expectedVersion: draftOrderVersion,
          correlationId: randomUUID(),
        }),
        deps,
      );
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({ title: 'LineNotFoundError' });
    } finally {
      await pool.query(`delete from wms.order_lines where order_id = $1`, [otherOrderId]);
      await pool.query(`delete from wms.inbound_orders where id = $1`, [otherOrderId]);
    }
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first and the command ran once', () => {
  it('handleApproveInbound: identical key + body -> identical response, version bumped exactly once', async () => {
    const order = await insertFreshDraftOrder();
    const idempotencyKey = randomUUID();
    const body = { orderId: order.id, expectedVersion: order.version, correlationId: randomUUID() };

    const first = await handleApproveInbound(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    // Same key, same body — even though expectedVersion is now stale against the bumped row, the
    // replay must return the FIRST response, not re-run the command and hit 409.
    const second = await handleApproveInbound(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const versionResult: QueryResult<{ version: number }> = await pool.query(
      `select version from wms.inbound_orders where id = $1`,
      [order.id],
    );
    expect(versionResult.rows[0]?.version).toBe((order.version as number) + 1); // bumped once.
  });

  it('handleApproveInbound: the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const order = await insertFreshDraftOrder();
    const idempotencyKey = randomUUID();
    const body = { orderId: order.id, expectedVersion: order.version, correlationId: randomUUID() };

    const first = await handleApproveInbound(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = { orderId: order.id, expectedVersion: order.version, correlationId: randomUUID() };
    const result = await handleApproveInbound(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });

  // WBS 2.9b pg-reviewer round-3 finding 4b: CancelInbound's own idempotent replay — exactly one
  // wms.inbound.cancelled outbox row and one version bump, not two, across two identical calls.
  it('handleCancelInbound: identical key + body -> identical response, version bumped exactly once, exactly one wms.inbound.cancelled outbox row', async () => {
    const order = await insertFreshDraftOrder();
    const idempotencyKey = randomUUID();
    const correlationId = randomUUID();
    const body = { orderId: order.id, expectedVersion: order.version, correlationId, cancelReason: 'client requested cancellation' };

    const first = await handleCancelInbound(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleCancelInbound(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const versionResult: QueryResult<{ version: number }> = await pool.query(
      `select version from wms.inbound_orders where id = $1`,
      [order.id],
    );
    expect(versionResult.rows[0]?.version).toBe((order.version as number) + 1); // bumped once.

    const outboxResult: QueryResult<{ id: string }> = await pool.query(
      `select id from platform.outbox where correlation_id = $1 and event_type = $2`,
      [correlationId, 'wms.inbound.cancelled'],
    );
    expect(outboxResult.rows).toHaveLength(1);
  });
});

// --- WBS 2.9b round-2 review finding 4: the eight 2.9b typed errors map to 422 -------------------

describe('WBS 2.9b: every typed error of the extended ApproveInbound/CancelInbound maps to 422, title = error.name', () => {
  // Derived from this file's own injected clock (2026-09-24), never from `new Date()`.
  const SLOT_FUTURE_EXPECTED_AT = new Date(clock.now().getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();
  const SLOT_PAST_EXPECTED_AT = new Date(clock.now().getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Reached through the real command — the contract accepts any non-empty string / any datetime,
  // the domain layer rejects. One value outside each migration 0023 CHECK, same literals as
  // ./receive-inbound.test.ts.
  const realPathCases = [
    { title: 'ScheduleInPastError', patch: { expectedAt: SLOT_PAST_EXPECTED_AT } },
    { title: 'InvalidVehicleTypeError', patch: { expectedAt: SLOT_FUTURE_EXPECTED_AT, vehicleType: 'motorcycle' } },
    { title: 'InvalidHandoverPointError', patch: { expectedAt: SLOT_FUTURE_EXPECTED_AT, handoverPoint: 'airport' } },
    { title: 'InvalidTransportByError', patch: { expectedAt: SLOT_FUTURE_EXPECTED_AT, transportBy: 'shared' } },
    { title: 'InvalidLabourByError', patch: { expectedAt: SLOT_FUTURE_EXPECTED_AT, labourBy: 'contractor' } },
    { title: 'LogisticsTermsRequireExpectedAtError', patch: { vehicleType: 'truck' } },
  ] as const;

  it.each(realPathCases)('handleApproveInbound -> 422, title "$title"', async ({ title, patch }) => {
    const order = await insertFreshDraftOrder();
    const result = await handleApproveInbound(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: randomUUID(), ...patch }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title });
  });

  it('handleApproveInbound: a negative labourCount is stopped at the contract boundary -> 400, title "ZodError"', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleApproveInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        expectedAt: SLOT_FUTURE_EXPECTED_AT,
        labourCount: -1,
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ title: 'ZodError' });
  });

  it('handleCancelInbound: an empty cancelReason is stopped at the contract boundary -> 400, title "ZodError"', async () => {
    const order = await insertFreshDraftOrder();
    const result = await handleCancelInbound(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: randomUUID(), cancelReason: '' }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ title: 'ZodError' });
  });

  /** Deps whose repository throws `error` on the first port call — the command surfaces it
   *  unchanged, so only the handler's mapping is under test. */
  function depsThrowing(error: Error): { readonly deps: typeof deps; readonly logger: ReturnType<typeof spyLogger> } {
    const logger = spyLogger();
    const depsWithSpyLogger = createReceiveInboundDeps({ clock, ids, logger });
    return {
      logger,
      deps: {
        ...depsWithSpyLogger,
        repo: {
          ...depsWithSpyLogger.repo,
          getOrderForUpdate: async (): Promise<never> => {
            throw error;
          },
        },
      },
    };
  }

  it('handleApproveInbound: InvalidLabourCountError thrown by the command -> 422, title "InvalidLabourCountError" (never a 500)', async () => {
    const order = await insertFreshDraftOrder();
    const throwing = depsThrowing(new InvalidLabourCountError('ApproveInbound: labourCount (-1) must be >= 0.'));
    const result = await handleApproveInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        expectedAt: SLOT_FUTURE_EXPECTED_AT,
      }),
      throwing.deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'InvalidLabourCountError' });
    expect(throwing.logger.errorCalls).toHaveLength(0);
  });

  it('handleCancelInbound: CancelReasonRequiredError thrown by the command -> 422, title "CancelReasonRequiredError" (never a 500)', async () => {
    const order = await insertFreshDraftOrder();
    const throwing = depsThrowing(new CancelReasonRequiredError('CancelInbound requires a non-empty cancelReason.'));
    const result = await handleCancelInbound(
      requestWithKey({
        orderId: order.id,
        expectedVersion: order.version,
        correlationId: randomUUID(),
        cancelReason: 'client requested cancellation',
      }),
      throwing.deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'CancelReasonRequiredError' });
    expect(throwing.logger.errorCalls).toHaveLength(0);
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleApproveInbound: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const order = await insertFreshDraftOrder();
    const logger = spyLogger();
    const depsWithSpyLogger = createReceiveInboundDeps({ clock, ids, logger });
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

    const result = await handleApproveInbound(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId }),
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

// --- createReceiveInboundDeps({ clock, ids, logger }) --------------------------------------------

describe('createReceiveInboundDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createReceiveInboundDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createReceiveInboundDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
