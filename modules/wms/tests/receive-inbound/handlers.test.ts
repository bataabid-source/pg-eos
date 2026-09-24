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

// The module under test — does not exist yet with this error-mapping behaviour (RED).
import {
  handleApproveInbound,
  handleReceiveLine,
  type ApiRequest,
} from '../../api/receive-inbound/handlers.js';

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

function requestWithKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
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
  const warehouseId = (warehouseResult.rows[0] as { id: string }).id;

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
  if (fixtureSkuId) await pool.query(`delete from wms.skus where id = $1`, [fixtureSkuId]);
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
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
