// modules/wms/tests/receive-inbound/expiry-balance.test.ts — WBS 2.9 part 3 (pg-tester, RED-first).
//
// Integration tests, one describe per scenario in ./expiry-balance.feature, real database, every
// ledger call through withContext as pgeos_app (RLS applies). Sources: slice brief
// _slice-2.9-p3-fefo-expiry, doc 40 Part E S1, GM decision D-204 (one expiry per (client, SKU,
// batch) across ALL locations, ledger write path, no schema change).
//
// NEW SURFACE these tests bind to (RED until pg-builder adds it, all inside the brief's Write list):
//   - `PostMovementInput.expiryDate?: string | null` (ISO date 'YYYY-MM-DD') in
//     modules/wms/src/stock-ledger/post-movement.ts — written to wms.stock_movements.expiry_date and,
//     per brief decision 2, to the wms.stock_balance row: kept when non-null, filled when null.
//   - `LedgerPort.postReceipt` params gain `expiryDate?: string | null`, passed through by
//     modules/wms/infrastructure/receive-inbound/ledger.ts (asserted in the last describe).
//   - A different non-null expiry for the same (client, SKU, batch) — same row or any other
//     location — is refused with the EXISTING InvalidLedgerEntryError
//     (modules/wms/src/stock-ledger/errors.ts). No existing class is an exact fit (there is no
//     conflict error); brief decision 2(b) says "an existing ledger error", and
//     InvalidLedgerEntryError ("entry is inconsistent") is the closest. If the builder prefers a
//     new typed class, that is a test change routed back to the tester.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
import { withContext } from '@pg-eos/db';
import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';

import { InvalidLedgerEntryError, postMovement, reverseMovement, type LedgerDeps } from '../../index.js';
import { approveInbound, confirmPutaway, receiveLine, suggestLocation } from '../../application/receive-inbound/index.js';
import { createReceiveInboundDeps } from '../../api/receive-inbound/composition.js';
import { handleReceiveLine } from '../../api/receive-inbound/handlers.js';
import { inboundLedgerPort } from '../../infrastructure/receive-inbound/ledger.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// performed_by has no FK (01 wms.stock_movements.performed_by). Fresh actor per run (D-183: no
// pre-clean DELETE of a fixed id); deleted only in afterAll.
const ACTOR_UUID = randomUUID();
const ctx = { userId: ACTOR_UUID, clientId: null, isInternal: true };
const deps: LedgerDeps = {
  clock: new FixedClock(new Date('2026-09-29T00:00:00.000Z')),
  ids: new SequentialIdGenerator(2093),
};

// Feature-file literals.
const EXPIRY_MAR = '2027-03-01';
const EXPIRY_APR = '2027-04-01';
const EXPIRY_JUN = '2027-06-15';
const QTY_TEN = '10.000';
const QTY_FIVE = '5.000';
const QTY_FIFTEEN = '15.000';
const UOM_EA = 'EA';
// SKU weight/volume small enough to stay under every WH1 location hard limit (same reasoning as
// stock-ledger.test.ts FIXTURE_SKU_*).
const SKU_GROSS_WEIGHT_KG = '0.100';
const SKU_VOLUME_CBM = '0.001';
const FIXTURE_LOCATION_COUNT = 2;

let entityId: string;
let clientId: string;
let skuId: string;
let locL1: string;
let locL2: string;
const correlationIds: string[] = [];

interface BalanceRow {
  readonly location_id: string;
  readonly batch_no: string;
  readonly expiry_date: string | null;
  readonly qty_on_hand: string;
}

async function receive(batchNo: string, locationId: string, qty: string, expiryDate?: string | null) {
  const correlationId = randomUUID();
  correlationIds.push(correlationId);
  return postMovement(
    ctx,
    {
      entityId,
      entry: {
        clientId,
        skuId,
        fromLocationId: null,
        toLocationId: locationId,
        qty: Quantity.of(qty),
        batchNo,
        movementType: 'receipt',
        uom: UOM_EA,
      },
      correlationId,
      performedBy: ACTOR_UUID,
      ...(expiryDate === undefined ? {} : { expiryDate }),
    },
    deps,
  );
}

async function balances(batchNo: string): Promise<readonly BalanceRow[]> {
  const r: QueryResult<BalanceRow> = await pool.query(
    `select location_id, batch_no, to_char(expiry_date, 'YYYY-MM-DD') as expiry_date,
            qty_on_hand::text as qty_on_hand
       from wms.stock_balance
      where client_id = $1 and sku_id = $2 and batch_no = $3
      order by location_id`,
    [clientId, skuId, batchNo],
  );
  return r.rows;
}

async function movementCount(batchNo: string): Promise<number> {
  const r: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n from wms.stock_movements
      where client_id = $1 and sku_id = $2 and batch_no = $3`,
    [clientId, skuId, batchNo],
  );
  return r.rows[0]?.n ?? 0;
}

async function movementExpiries(batchNo: string): Promise<readonly (string | null)[]> {
  const r: QueryResult<{ expiry_date: string | null }> = await pool.query(
    `select to_char(expiry_date, 'YYYY-MM-DD') as expiry_date from wms.stock_movements
      where client_id = $1 and sku_id = $2 and batch_no = $3 order by occurred_at, id`,
    [clientId, skuId, batchNo],
  );
  return r.rows.map((row) => row.expiry_date);
}

async function outboxCountFor(ids: readonly string[]): Promise<number> {
  const r: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n from platform.outbox where correlation_id = any($1::uuid[])`,
    [ids],
  );
  return r.rows[0]?.n ?? 0;
}

/** Runs `fn`, asserts it is refused with InvalidLedgerEntryError, and asserts the refusal changed
 *  nothing: same balance rows, same movement count, and no outbox row for the refused correlation id
 *  (#185's three refusal-path assertions). */
async function expectRefusedWithoutSideEffects(batchNo: string, fn: () => Promise<unknown>): Promise<void> {
  const balancesBefore = await balances(batchNo);
  const movementsBefore = await movementCount(batchNo);
  const correlationsBefore = correlationIds.length;
  await expect(fn()).rejects.toBeInstanceOf(InvalidLedgerEntryError);
  expect(await balances(batchNo)).toEqual(balancesBefore);
  expect(await movementCount(batchNo)).toBe(movementsBefore);
  expect(await outboxCountFor(correlationIds.slice(correlationsBefore))).toBe(0);
}

beforeAll(async () => {
  const entity: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = 'PST'`,
  );
  const entityRow = entity.rows[0];
  if (!entityRow) throw new Error('fixture entity PST not found in platform.entities');
  entityId = entityRow.id;

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [ACTOR_UUID, `_expiry_fixture_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار انتهاء الصلاحية — WBS 2.9'],
  );
  const entities: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const row of entities.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [ACTOR_UUID, row.id]);
  }

  const client: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_expiry_fixture_${randomUUID()}`, 'عميل اختبار انتهاء الدفعة — WBS 2.9'],
  );
  const clientRow = client.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  clientId = clientRow.id;

  const sku: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [clientId, `EXPIRY-SKU-${randomUUID()}`, 'صنف اختبار انتهاء الدفعة', SKU_GROSS_WEIGHT_KG, SKU_VOLUME_CBM],
  );
  const skuRow = sku.rows[0];
  if (!skuRow) throw new Error('fixture wms.skus insert returned no row');
  skuId = skuRow.id;

  const locations: QueryResult<{ id: string }> = await pool.query(
    `select l.id from wms.locations l
       join wms.zones z on z.id = l.zone_id
       join wms.warehouses w on w.id = l.warehouse_id
      where w.code = 'WH1' and z.zone_type = 'storage' and l.is_blocked = false
      order by l.code limit $1`,
    [FIXTURE_LOCATION_COUNT],
  );
  const [l1, l2] = locations.rows;
  if (!l1 || !l2) throw new Error(`expected ${FIXTURE_LOCATION_COUNT} unblocked WH1 storage locations`);
  locL1 = l1.id;
  locL2 = l2.id;
});

afterAll(async () => {
  // Own fixture rows only (D-183): balances, movements and outbox rows of this suite's client;
  // audit rows stay (hash chain).
  if (clientId) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [clientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [clientId]);
  }
  if (correlationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationIds]);
  }
  if (skuId) await pool.query(`delete from wms.skus where id = $1`, [skuId]);
  if (clientId) await pool.query(`delete from sales.accounts where id = $1`, [clientId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ACTOR_UUID]);
  await pool.end();
});

describe('Scenario: a received batch line with an expiry writes that expiry on its stock_balance row', () => {
  const BATCH = 'EXP-B1';

  it('the balance row and the movement row both carry the expiry', async () => {
    await receive(BATCH, locL1, QTY_TEN, EXPIRY_MAR);
    const rows = await balances(BATCH);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiry_date).toBe(EXPIRY_MAR);
    expect(rows[0]?.qty_on_hand).toBe(QTY_TEN);
    expect(await movementExpiries(BATCH)).toEqual([EXPIRY_MAR]);
  });
});

describe('Scenario: a second receipt of the same batch keeps the recorded expiry and adds quantity', () => {
  const BATCH = 'EXP-B2';

  it('the same expiry adds quantity, and a later receipt with no expiry does not erase it', async () => {
    await receive(BATCH, locL1, QTY_TEN, EXPIRY_MAR);
    await receive(BATCH, locL1, QTY_FIVE, EXPIRY_MAR);
    const rows = await balances(BATCH);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiry_date).toBe(EXPIRY_MAR);
    expect(rows[0]?.qty_on_hand).toBe(QTY_FIFTEEN);

    await receive(BATCH, locL1, QTY_FIVE);
    expect((await balances(BATCH))[0]?.expiry_date).toBe(EXPIRY_MAR);
  });
});

describe('Scenario: a receipt without expiry leaves expiry_date null; a later one with expiry fills it', () => {
  const BATCH = 'EXP-B3';

  it('a first receipt without expiry leaves null; a later receipt with an expiry fills it', async () => {
    await receive(BATCH, locL1, QTY_TEN);
    expect((await balances(BATCH))[0]?.expiry_date).toBeNull();

    await receive(BATCH, locL1, QTY_FIVE, EXPIRY_JUN);
    const rows = await balances(BATCH);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiry_date).toBe(EXPIRY_JUN);
    expect(rows[0]?.qty_on_hand).toBe(QTY_FIFTEEN);
  });
});

describe('Scenario: a different expiry for the same batch is refused at the same location', () => {
  const BATCH = 'EXP-B4';

  it('is refused with InvalidLedgerEntryError and changes no row (balance, movement, outbox)', async () => {
    await receive(BATCH, locL1, QTY_TEN, EXPIRY_MAR);
    await expectRefusedWithoutSideEffects(BATCH, () => receive(BATCH, locL1, QTY_FIVE, EXPIRY_APR));
    expect((await balances(BATCH))[0]?.expiry_date).toBe(EXPIRY_MAR);
  });
});

describe('Scenario: a different expiry for the same batch is refused at another location (SCR-WMS-BATCH-EXPIRY-01, D-204)', () => {
  const BATCH = 'EXP-B5';

  it('is refused with InvalidLedgerEntryError and changes no row (balance, movement, outbox)', async () => {
    await receive(BATCH, locL1, QTY_TEN, EXPIRY_MAR);
    await expectRefusedWithoutSideEffects(BATCH, () => receive(BATCH, locL2, QTY_FIVE, EXPIRY_APR));
    const rows = await balances(BATCH);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.location_id).toBe(locL1);
  });

  it('the same expiry at another location is accepted and its balance row carries it', async () => {
    await receive(BATCH, locL2, QTY_FIVE, EXPIRY_MAR);
    const rows = await balances(BATCH);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.expiry_date)).toEqual([EXPIRY_MAR, EXPIRY_MAR]);
  });
});

describe('The receive-inbound ledger adapter passes the expiry through', () => {
  const BATCH = 'EXP-B6';

  it('inboundLedgerPort.postReceipt with expiryDate writes it on the balance row', async () => {
    const correlationId = randomUUID();
    correlationIds.push(correlationId);
    await withContext(ctx, (tx) =>
      inboundLedgerPort.postReceipt(
        tx,
        {
          entityId,
          clientId,
          skuId,
          toLocationId: locL1,
          qty: QTY_TEN,
          batchNo: BATCH,
          uom: UOM_EA,
          correlationId,
          refId: randomUUID(),
          expiryDate: EXPIRY_MAR,
        },
        ACTOR_UUID,
        deps,
      ),
    );
    expect((await balances(BATCH))[0]?.expiry_date).toBe(EXPIRY_MAR);
  });
});

// --- put-away transfer (slice default 2(d)): the destination row takes the source row's expiry ----

describe('Scenario: a put-away transfer carries the source expiry to the destination balance row', () => {
  async function transfer(batchNo: string, from: string, to: string): Promise<void> {
    const correlationId = randomUUID();
    correlationIds.push(correlationId);
    await withContext(ctx, (tx) =>
      inboundLedgerPort.postPutawayTransfer(
        tx,
        { entityId, clientId, skuId, qty: QTY_FIVE, batchNo, uom: UOM_EA, fromLocationId: from, toLocationId: to, correlationId, refId: randomUUID() },
        ACTOR_UUID,
        deps,
      ),
    );
  }

  it('receipt with an expiry at the dock (L2), transfer to storage L1: the L1 row carries the expiry', async () => {
    const BATCH = 'EXP-T1';
    await receive(BATCH, locL2, QTY_TEN, EXPIRY_MAR);
    await transfer(BATCH, locL2, locL1);
    const l1 = (await balances(BATCH)).find((r) => r.location_id === locL1);
    expect(l1?.expiry_date).toBe(EXPIRY_MAR);
    expect(l1?.qty_on_hand).toBe(QTY_FIVE);
  });

  it('a null-expiry source leaves the destination expiry null', async () => {
    const BATCH = 'EXP-T2';
    await receive(BATCH, locL2, QTY_TEN);
    await transfer(BATCH, locL2, locL1);
    const l1 = (await balances(BATCH)).find((r) => r.location_id === locL1);
    expect(l1?.qty_on_hand).toBe(QTY_FIVE);
    expect(l1?.expiry_date).toBeNull();
  });
});

// --- handler level: receiveLine -> confirmPutaway (real use cases, real ports) -------------------

describe('Scenario: the line expiryDate reaches the stock_balance row through receiveLine and confirmPutaway', () => {
  const BATCH = 'EXP-H1';
  const WH_MGR_ROLE_CODE = 'WH_MGR';
  const WH_SUP_ROLE_CODE = 'WH_SUP';
  const GRN_TEMPLATE_CODE = 'GRN-01';
  const handlerDeps = createReceiveInboundDeps({
    clock: new FixedClock(new Date('2026-09-29T00:00:00.000Z')),
    ids: new SequentialIdGenerator(2095),
  });
  const orderIds: string[] = [];
  let warehouseId: string;
  let grnTemplateId: string;

  beforeAll(async () => {
    const wh: QueryResult<{ id: string }> = await pool.query(`select id from wms.warehouses where code = 'WH1'`);
    warehouseId = (wh.rows[0] as { id: string }).id;
    for (const roleCode of [WH_MGR_ROLE_CODE, WH_SUP_ROLE_CODE]) {
      const role: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [roleCode]);
      const roleId = role.rows[0]?.id;
      if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
      await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [ACTOR_UUID, roleId]);
    }
    // Same fixture as receive-inbound.test.ts: upsert the GRN template, keep its id, delete it by id
    // in afterAll after the documents that reference it.
    const template: QueryResult<{ id: string }> = await pool.query(
      `insert into platform.document_templates (code, name_ar, entity_id, body_html)
       values ($1, $2, null, $3) on conflict (code) do update set body_html = excluded.body_html returning id`,
      [GRN_TEMPLATE_CODE, 'إذن استلام بضاعة', '<div>GRN {{doc_no}}</div>'],
    );
    grnTemplateId = (template.rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    if (orderIds.length > 0) {
      await pool.query(`delete from platform.documents where source_id = any($1::uuid[])`, [orderIds]);
      await pool.query(`delete from wms.order_lines where order_id = any($1::uuid[])`, [orderIds]);
      await pool.query(`delete from wms.inbound_orders where id = any($1::uuid[])`, [orderIds]);
    }
    if (grnTemplateId) await pool.query(`delete from platform.document_templates where id = $1`, [grnTemplateId]);
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [ACTOR_UUID]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [ACTOR_UUID]);
  });

  async function orderVersion(orderId: string): Promise<number> {
    const r: QueryResult<{ version: number }> = await pool.query(`select version from wms.inbound_orders where id = $1`, [orderId]);
    return (r.rows[0] as { version: number }).version;
  }

  it('receiveLine with expiryDate writes it on the receipt balance row; confirmPutaway carries it to the storage row', async () => {
    const docNo: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'INB') as doc_no`, [entityId]);
    const order: QueryResult<{ id: string; version: number }> = await pool.query(
      `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
       values ($1, $2, $3, $4, 'draft') returning id, version`,
      [entityId, docNo.rows[0]?.doc_no, clientId, warehouseId],
    );
    const orderRow = order.rows[0] as { id: string; version: number };
    orderIds.push(orderRow.id);
    const line: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
       values ('wms.inbound_orders', $1, 1, $2, $3::numeric, $4) returning id`,
      [orderRow.id, skuId, QTY_TEN, UOM_EA],
    );
    const lineId = (line.rows[0] as { id: string }).id;
    const next = (): string => {
      const id = randomUUID();
      correlationIds.push(id);
      return id;
    };

    await approveInbound(ctx, { orderId: orderRow.id, expectedVersion: orderRow.version, correlationId: next() }, handlerDeps);
    await receiveLine(
      ctx,
      { orderId: orderRow.id, lineId, qtyActual: QTY_TEN, batchNo: BATCH, expiryDate: EXPIRY_MAR, expectedVersion: await orderVersion(orderRow.id), correlationId: next() },
      handlerDeps,
    );
    const afterReceipt = await balances(BATCH);
    expect(afterReceipt).toHaveLength(1);
    expect(afterReceipt[0]?.expiry_date).toBe(EXPIRY_MAR);
    const dockLocationId = afterReceipt[0]?.location_id;

    const suggestion = await suggestLocation(ctx, { skuId, qty: QTY_TEN, warehouseId }, handlerDeps);
    const chosen = suggestion.candidates.find((c) => c.locationId !== dockLocationId);
    if (!chosen) throw new Error('suggestLocation returned no storage candidate distinct from the receipt location');
    await confirmPutaway(
      ctx,
      { orderId: orderRow.id, lineId, toLocationId: chosen.locationId, expectedVersion: await orderVersion(orderRow.id), correlationId: next() },
      handlerDeps,
    );
    const storage = (await balances(BATCH)).find((r) => r.location_id === chosen.locationId);
    expect(storage?.expiry_date).toBe(EXPIRY_MAR);
  });

  it('handleReceiveLine for a batch that carries a different expiry at another location -> 422 InvalidLedgerEntryError and nothing is written', async () => {
    const REFUSED_BATCH = 'EXP-H2';
    // Seed: the batch already carries EXPIRY_APR at a storage location.
    await receive(REFUSED_BATCH, locL2, QTY_FIVE, EXPIRY_APR);

    const docNo: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'INB') as doc_no`, [entityId]);
    const order: QueryResult<{ id: string; version: number }> = await pool.query(
      `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
       values ($1, $2, $3, $4, 'draft') returning id, version`,
      [entityId, docNo.rows[0]?.doc_no, clientId, warehouseId],
    );
    const orderRow = order.rows[0] as { id: string; version: number };
    orderIds.push(orderRow.id);
    const line: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
       values ('wms.inbound_orders', $1, 1, $2, $3::numeric, $4) returning id`,
      [orderRow.id, skuId, QTY_TEN, UOM_EA],
    );
    const lineId = (line.rows[0] as { id: string }).id;
    const approveCorrelation = randomUUID();
    correlationIds.push(approveCorrelation);
    await approveInbound(ctx, { orderId: orderRow.id, expectedVersion: orderRow.version, correlationId: approveCorrelation }, handlerDeps);

    const lineRow = async (): Promise<unknown> =>
      (await pool.query(`select to_jsonb(l) as j from wms.order_lines l where id = $1`, [lineId])).rows[0];
    const orderVersionNow = await orderVersion(orderRow.id);
    const documentCount = async (): Promise<number> =>
      (await pool.query(`select count(*)::int as n from platform.documents where source_id = $1`, [orderRow.id])).rows[0].n as number;
    const lineBefore = await lineRow();
    const documentsBefore = await documentCount();
    const balancesBefore = await balances(REFUSED_BATCH);
    const movementsBefore = await movementCount(REFUSED_BATCH);

    const refusedCorrelation = randomUUID();
    correlationIds.push(refusedCorrelation);
    const result = await handleReceiveLine(
      {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: { orderId: orderRow.id, lineId, qtyActual: QTY_TEN, batchNo: REFUSED_BATCH, expiryDate: EXPIRY_MAR, expectedVersion: orderVersionNow, correlationId: refusedCorrelation },
        ctx,
      },
      handlerDeps,
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'InvalidLedgerEntryError' });
    // The line (status, qty_actual, batch, expiry, every column) and the order version are unchanged.
    expect(await lineRow()).toEqual(lineBefore);
    expect(await orderVersion(orderRow.id)).toBe(orderVersionNow);
    // No GRN / document, no movement, no balance change, no outbox row for the refused call.
    expect(await documentCount()).toBe(documentsBefore);
    expect(await movementCount(REFUSED_BATCH)).toBe(movementsBefore);
    expect(await balances(REFUSED_BATCH)).toEqual(balancesBefore);
    expect(await outboxCountFor([refusedCorrelation])).toBe(0);
  });
});

// --- the stored movement is what the outbox event and the audit row carry (decision 7) -----------

describe('Scenario: the wms.stock.moved payload and the audit new_value carry the movement expiry_date', () => {
  interface JsonRow {
    readonly j: Record<string, unknown>;
  }

  async function outboxPayloads(correlationId: string): Promise<readonly Record<string, unknown>[]> {
    const r: QueryResult<JsonRow> = await pool.query(
      `select payload as j from platform.outbox
        where correlation_id = $1 and event_type = 'wms.stock.moved' order by created_at, id`,
      [correlationId],
    );
    return r.rows.map((row) => row.j);
  }

  async function auditNewValues(correlationId: string): Promise<readonly Record<string, unknown>[]> {
    const r: QueryResult<JsonRow> = await pool.query(
      `select new_value as j from platform.audit_log
        where correlation_id = $1 and schema_name = 'wms' and table_name = 'stock_movements' and operation = 'insert'`,
      [correlationId],
    );
    return r.rows.map((row) => row.j);
  }

  it('a receipt with an expiry: the outbox payload and the audit new_value carry expiry_date', async () => {
    const BATCH = 'EXP-E1';
    const posted = await receive(BATCH, locL1, QTY_TEN, EXPIRY_MAR);
    const payloads = await outboxPayloads(posted.correlationId);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.['expiry_date']).toBe(EXPIRY_MAR);
    const audits = await auditNewValues(posted.correlationId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.['expiry_date']).toBe(EXPIRY_MAR);
  });

  it('a put-away transfer: both legs carry the source expiry in the outbox payload', async () => {
    const BATCH = 'EXP-E2';
    await receive(BATCH, locL2, QTY_TEN, EXPIRY_MAR);
    const correlationId = randomUUID();
    correlationIds.push(correlationId);
    await withContext(ctx, (tx) =>
      inboundLedgerPort.postPutawayTransfer(
        tx,
        { entityId, clientId, skuId, qty: QTY_FIVE, batchNo: BATCH, uom: UOM_EA, fromLocationId: locL2, toLocationId: locL1, correlationId, refId: randomUUID() },
        ACTOR_UUID,
        deps,
      ),
    );
    const payloads = await outboxPayloads(correlationId);
    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => p['expiry_date'])).toEqual([EXPIRY_MAR, EXPIRY_MAR]);
  });

  it('a reversal of a receipt with an expiry: the reversing row, its outbox payload and audit new_value carry it, and the balance row keeps it', async () => {
    const BATCH = 'EXP-E3';
    const original = await receive(BATCH, locL1, QTY_TEN, EXPIRY_MAR);
    const correlationId = randomUUID();
    correlationIds.push(correlationId);
    const reversal = await reverseMovement(
      ctx,
      { movementId: original.movementIds[0] as string, correlationId, performedBy: ACTOR_UUID },
      deps,
    );
    const reversalId = reversal.movementIds[0] as string;
    const stored: QueryResult<{ expiry_date: string | null }> = await pool.query(
      `select to_char(expiry_date, 'YYYY-MM-DD') as expiry_date from wms.stock_movements where id = $1`,
      [reversalId],
    );
    expect(stored.rows[0]?.expiry_date).toBe(EXPIRY_MAR);
    const payloads = await outboxPayloads(correlationId);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.['expiry_date']).toBe(EXPIRY_MAR);
    const audits = await auditNewValues(correlationId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.['expiry_date']).toBe(EXPIRY_MAR);
    const l1 = (await balances(BATCH)).find((r) => r.location_id === locL1);
    expect(l1?.expiry_date).toBe(EXPIRY_MAR);
  });
});

