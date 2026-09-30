// modules/wms/tests/receive-inbound/quarantine.test.ts — WBS 2.9 part 3 step 2 (pg-tester, RED-first).
//
// Integration tests on the lane DB, one describe per scenario in ./quarantine.feature (the
// migration and allocation scenarios live in tests/scenarios/migration-0047.spec.ts and
// ../process-outbound/allocate-excludes-quarantine.test.ts). Sources: slice brief
// _slice-2.9-p3-s2-qrt-quarantine, doc 40 Part E S1 scenario 1, GM decision D-211.
//
// Every expected number/role is READ from the DB (SKU minimum, approval_chains step-1 role,
// thresholds 'wms.quarantine.decision_due_hours') — nothing is hard-coded here.
//
// NEW SURFACE these tests bind to (RED until pg-builder adds it):
//   - createReceiveInboundDeps({ clock, ids, logger? }) unchanged; the composition loads the title
//     template EAGERLY from packages/i18n/ar/wms.json key wms.receiveInbound.quarantineDecision.title
//     (billing's loadReopenDecisionTitleAr precedent). That file lands with M-core's X part 23, so
//     these tests stay RED until it is merged.
//   - receiveLine posts a short-shelf-life receipt to a zone_type 'quarantine' location and writes
//     one platform.decisions row in the same transaction.
//   - QuarantineDecisionOpenError in modules/wms/domain/receive-inbound/errors.ts, mapped to 422 by
//     the api handlers (title = error.name); confirmPutaway throws it while the decision is open.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

import { approveInbound } from '../../application/receive-inbound/index.js';
import { createReceiveInboundDeps } from '../../api/receive-inbound/composition.js';
import { handleConfirmPutaway, handleReceiveLine } from '../../api/receive-inbound/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// Fixed fixture ids, distinct from every other wms test fixture; removed in afterAll.
const ACTOR_UUID = '5a1e0b0c-0000-4000-8000-00000000d201';
const CLIENT_UUID = '5a1e0b0c-0000-4000-8000-00000000d202';
const SKU_UUID = '5a1e0b0c-0000-4000-8000-00000000d203';
const ctx = { userId: ACTOR_UUID, clientId: null, isInternal: true };

const CLOCK_NOW = new Date('2026-09-29T00:00:00.000Z');
const MS_PER_DAY = 86_400_000;
const SHORT_BY_DAYS = 60; // S1 scenario 1: expiry well below the SKU minimum
const SKU_MIN_DAYS = '180'; // S1 Given: SKU minimum receipt shelf life 180 (tests/scenarios/S1.spec.ts:318-321)
const TITLE_KEY = 'wms.receiveInbound.quarantineDecision.title';
const I18N_WMS_AR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'i18n', 'ar', 'wms.json');
const CLIENT_NAME_AR = 'عميل اختبار الحجر — WBS 2.9';
const QUARANTINE_KIND = 'quarantine_decision';
const DUE_HOURS_KEY = 'wms.quarantine.decision_due_hours';
const QTY = '10.000';
const UOM = 'EA';
const ROLE_CODES = ['WH_MGR', 'WH_SUP'] as const;
const GRN_TEMPLATE_CODE = 'GRN-01';
const SKU_GROSS_WEIGHT_KG = '0.100';
const SKU_VOLUME_CBM = '0.001';
const HTTP_UNPROCESSABLE = 422;

const deps = createReceiveInboundDeps({
  clock: new FixedClock(CLOCK_NOW),
  ids: new SequentialIdGenerator(2120),
});

let entityId: string;
let warehouseId: string;
let grnTemplateId: string;
let minDays: number;
let titleTemplate: string;
let grnTemplateCreated = false;
const orderIds: string[] = [];
const correlationIds: string[] = [];

function nextCorrelation(): string {
  const id = randomUUID();
  correlationIds.push(id);
  return id;
}

function expiryInDays(days: number): string {
  return new Date(CLOCK_NOW.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

async function orderVersion(orderId: string): Promise<number> {
  const r: QueryResult<{ version: number }> = await pool.query(`select version from wms.inbound_orders where id = $1`, [orderId]);
  return (r.rows[0] as { version: number }).version;
}

/** An approved single-line order for the fixture SKU, ready for receiveLine. */
async function approvedOrder(): Promise<{ orderId: string; lineId: string }> {
  const docNo: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'INB') as doc_no`, [entityId]);
  const order: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
     values ($1, $2, $3, $4, 'draft') returning id, version`,
    [entityId, docNo.rows[0]?.doc_no, CLIENT_UUID, warehouseId],
  );
  const orderRow = order.rows[0] as { id: string; version: number };
  orderIds.push(orderRow.id);
  const line: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
     values ('wms.inbound_orders', $1, 1, $2, $3::numeric, $4) returning id`,
    [orderRow.id, SKU_UUID, QTY, UOM],
  );
  await approveInbound(ctx, { orderId: orderRow.id, expectedVersion: orderRow.version, correlationId: nextCorrelation() }, deps);
  return { orderId: orderRow.id, lineId: (line.rows[0] as { id: string }).id };
}

async function receive(params: { orderId: string; lineId: string; batchNo: string; expiryDate: string; idemKey: string }) {
  const body = {
    orderId: params.orderId,
    lineId: params.lineId,
    qtyActual: QTY,
    batchNo: params.batchNo,
    expiryDate: params.expiryDate,
    expectedVersion: await orderVersion(params.orderId),
    correlationId: nextCorrelation(),
  };
  return handleReceiveLine({ headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: params.idemKey }, body, ctx }, deps);
}

interface BalanceZoneRow {
  readonly zone_code: string;
  readonly zone_type: string;
}

async function balanceZones(batchNo: string): Promise<readonly BalanceZoneRow[]> {
  const r: QueryResult<BalanceZoneRow> = await pool.query(
    `select z.code as zone_code, z.zone_type
       from wms.stock_balance sb
       join wms.locations l on l.id = sb.location_id
       join wms.zones z on z.id = l.zone_id
      where sb.client_id = $1 and sb.sku_id = $2 and sb.batch_no = $3`,
    [CLIENT_UUID, SKU_UUID, batchNo],
  );
  return r.rows;
}

async function movementsToZoneType(batchNo: string, zoneType: string): Promise<number> {
  const r: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n
       from wms.stock_movements m
       join wms.locations l on l.id = m.to_location_id
       join wms.zones z on z.id = l.zone_id
      where m.client_id = $1 and m.sku_id = $2 and m.batch_no = $3 and z.zone_type = $4`,
    [CLIENT_UUID, SKU_UUID, batchNo, zoneType],
  );
  return r.rows[0]?.n ?? 0;
}

async function movementCount(batchNo: string): Promise<number> {
  const r: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n from wms.stock_movements where client_id = $1 and sku_id = $2 and batch_no = $3`,
    [CLIENT_UUID, SKU_UUID, batchNo],
  );
  return r.rows[0]?.n ?? 0;
}

interface DecisionRow {
  readonly id: string;
  readonly entity_id: string;
  readonly status: string;
  readonly assigned_role: string;
  readonly title_ar: string;
  readonly context: Record<string, unknown>;
  readonly source_table: string;
  readonly due_ok: boolean;
}

async function decisionsFor(orderId: string, dueHours: number): Promise<readonly DecisionRow[]> {
  const r: QueryResult<DecisionRow> = await pool.query(
    `select id, entity_id, status, assigned_role, title_ar, context, source_table,
            (due_at = $3::timestamptz + ($4::numeric * interval '1 hour')) as due_ok
       from platform.decisions
      where kind = $1 and source_table = 'wms.inbound_orders' and source_id = $2`,
    [QUARANTINE_KIND, orderId, CLOCK_NOW.toISOString(), dueHours],
  );
  return r.rows;
}

async function decisionCount(orderId: string): Promise<number> {
  const r: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n from platform.decisions where kind = $1 and source_id = $2`,
    [QUARANTINE_KIND, orderId],
  );
  return r.rows[0]?.n ?? 0;
}

async function chainRole(): Promise<string> {
  const r: QueryResult<{ approver_role: string }> = await pool.query(
    `select approver_role from platform.approval_chains where request_type = $1 and step_no = 1 and is_active`,
    [QUARANTINE_KIND],
  );
  const row = r.rows[0];
  if (!row) throw new Error("platform.approval_chains has no active ('quarantine_decision', step 1) row — migration 0047 not applied");
  return row.approver_role;
}

async function dueHours(): Promise<number> {
  const r: QueryResult<{ value: string }> = await pool.query(`select value::text as value from platform.thresholds where key = $1`, [DUE_HOURS_KEY]);
  const row = r.rows[0];
  if (!row) throw new Error(`platform.thresholds has no '${DUE_HOURS_KEY}' row — migration 0047 not applied`);
  return Number(row.value);
}

beforeAll(async () => {
  const i18n = JSON.parse(readFileSync(I18N_WMS_AR, 'utf8')) as Record<string, string>;
  const template = i18n[TITLE_KEY];
  if (typeof template !== 'string') throw new Error(`packages/i18n/ar/wms.json has no key ${TITLE_KEY}`);
  titleTemplate = template;
  const entity: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = 'PST'`);
  entityId = (entity.rows[0] as { id: string }).id;
  const wh: QueryResult<{ id: string }> = await pool.query(`select id from wms.warehouses where code = 'WH1'`);
  warehouseId = (wh.rows[0] as { id: string }).id;

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [ACTOR_UUID, `_quarantine_fixture_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار الحجر — WBS 2.9'],
  );
  const entities: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const row of entities.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [ACTOR_UUID, row.id]);
  }
  for (const roleCode of ROLE_CODES) {
    const role: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [roleCode]);
    const roleId = role.rows[0]?.id;
    if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
    await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [ACTOR_UUID, roleId]);
  }

  await pool.query(
    `insert into sales.accounts (id, code, name_ar, account_type) values ($1, $2, $3, 'client')`,
    [CLIENT_UUID, `_quarantine_fixture_${randomUUID()}`, CLIENT_NAME_AR],
  );
  await pool.query(
    `insert into wms.skus (id, client_id, code, name_ar, gross_weight_kg, volume_cbm, track_expiry, min_remaining_life_receipt_days)
     values ($1, $2, $3, $4, $5::numeric, $6::numeric, true, $7::int)`,
    [SKU_UUID, CLIENT_UUID, `QRT-SKU-${randomUUID()}`, 'صنف اختبار الحجر', SKU_GROSS_WEIGHT_KG, SKU_VOLUME_CBM, SKU_MIN_DAYS],
  );
  const min: QueryResult<{ m: number }> = await pool.query(`select min_remaining_life_receipt_days as m from wms.skus where id = $1`, [SKU_UUID]);
  minDays = (min.rows[0] as { m: number }).m;

  const grn: QueryResult<{ id: string; inserted: boolean }> = await pool.query(
    `insert into platform.document_templates (code, name_ar, entity_id, body_html)
     values ($1, $2, null, $3) on conflict (code) do update set body_html = excluded.body_html
     returning id, (xmax = 0) as inserted`,
    [GRN_TEMPLATE_CODE, 'إذن استلام بضاعة', '<div>GRN {{doc_no}}</div>'],
  );
  grnTemplateId = (grn.rows[0] as { id: string }).id;
  grnTemplateCreated = (grn.rows[0] as { inserted: boolean }).inserted;
});

afterAll(async () => {
  // Own fixture rows only (D-183); audit rows stay (hash chain).
  if (orderIds.length > 0) {
    await pool.query(`delete from platform.decisions where source_id = any($1::uuid[])`, [orderIds]);
    await pool.query(`delete from platform.documents where source_id = any($1::uuid[])`, [orderIds]);
    await pool.query(`delete from wms.order_lines where order_id = any($1::uuid[])`, [orderIds]);
    await pool.query(`delete from wms.inbound_orders where id = any($1::uuid[])`, [orderIds]);
  }
  await pool.query(`delete from wms.stock_balance where client_id = $1`, [CLIENT_UUID]);
  await pool.query(`delete from wms.stock_movements where client_id = $1`, [CLIENT_UUID]);
  if (correlationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationIds]);
  }
  if (grnTemplateId && grnTemplateCreated) await pool.query(`delete from platform.document_templates where id = $1`, [grnTemplateId]);
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [ACTOR_UUID]);
  await pool.query(`delete from wms.skus where id = $1`, [SKU_UUID]);
  await pool.query(`delete from sales.accounts where id = $1`, [CLIENT_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ACTOR_UUID]);
  await pool.end();
});

describe('Scenario: a short-shelf-life receipt lands on a QRT-zone location and writes one open quarantine_decision', () => {
  const BATCH = 'QRT-B1';
  let orderId: string;
  let lineId: string;

  beforeAll(async () => {
    ({ orderId, lineId } = await approvedOrder());
    const result = await receive({ orderId, lineId, batchNo: BATCH, expiryDate: expiryInDays(SHORT_BY_DAYS), idemKey: randomUUID() });
    expect(result.status).toBe(200);
  });

  it('the fixture minimum is above the received remaining life (the S1 Given)', () => {
    expect(minDays).toBeGreaterThan(SHORT_BY_DAYS);
  });

  it('the (sku, batch) balance sits in a location whose zone code is QRT and zone_type quarantine', async () => {
    const zones = await balanceZones(BATCH);
    expect(zones).toHaveLength(1);
    expect(zones[0]?.zone_code).toBe('QRT');
    expect(zones[0]?.zone_type).toBe('quarantine');
  });

  it('no stock_movement to a storage location exists for the batch', async () => {
    expect(await movementsToZoneType(BATCH, 'storage')).toBe(0);
  });

  it('exactly one open quarantine_decision row exists for the order with the approval-chain role and due_at = occurred_at + threshold hours', async () => {
    const hours = await dueHours();
    const rows = await decisionsFor(orderId, hours);
    expect(rows).toHaveLength(1);
    const row = rows[0] as DecisionRow;
    expect(row.status).toBe('open');
    expect(row.source_table).toBe('wms.inbound_orders');
    expect(row.entity_id).toBe(entityId);
    expect(row.assigned_role).toBe(await chainRole());
    expect(row.due_ok).toBe(true);
    expect(hours).toBeGreaterThan(0);
  });

  it('title_ar is the template filled with the batch number and the context carries the computed facts', async () => {
    const [row] = await decisionsFor(orderId, await dueHours());
    expect(row?.title_ar).toBe(titleTemplate.replace('{batch}', BATCH).replace('{client}', CLIENT_NAME_AR));
    expect(row?.context).toMatchObject({
      orderId,
      lineId,
      skuId: SKU_UUID,
      batchNo: BATCH,
      expiryDate: expiryInDays(SHORT_BY_DAYS),
      minRemainingLifeReceiptDays: minDays,
      remainingDays: SHORT_BY_DAYS,
      qty: QTY,
    });
  });
});

describe('Scenario: a receipt at or above the minimum lands in RCV and writes no decision', () => {
  it('a receipt whose remaining life is above the minimum is in a receiving zone and has no decision', async () => {
    const BATCH = 'QRT-B2';
    const { orderId, lineId } = await approvedOrder();
    const result = await receive({ orderId, lineId, batchNo: BATCH, expiryDate: expiryInDays(minDays + 1), idemKey: randomUUID() });
    expect(result.status).toBe(200);
    const zones = await balanceZones(BATCH);
    expect(zones).toHaveLength(1);
    expect(zones[0]?.zone_type).toBe('receiving');
    expect(await decisionCount(orderId)).toBe(0);
  });
});

describe('Scenario: a replay under the same Idempotency-Key writes no second decision and no second movement', () => {
  it('one decision and one movement after two identical calls', async () => {
    const BATCH = 'QRT-B3';
    const { orderId, lineId } = await approvedOrder();
    const args = { orderId, lineId, batchNo: BATCH, expiryDate: expiryInDays(SHORT_BY_DAYS), idemKey: randomUUID() };
    const body = {
      orderId,
      lineId,
      qtyActual: QTY,
      batchNo: BATCH,
      expiryDate: args.expiryDate,
      expectedVersion: await orderVersion(orderId),
      correlationId: nextCorrelation(),
    };
    const call = () => handleReceiveLine({ headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: args.idemKey }, body, ctx }, deps);
    const first = await call();
    const second = await call();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await decisionCount(orderId)).toBe(1);
    expect(await movementCount(BATCH)).toBe(1);
  });
});

describe('Scenario: ConfirmPutaway of a quarantined line is refused with 422 while its decision is open', () => {
  it('handleConfirmPutaway answers 422 QuarantineDecisionOpenError; the line and the stock are unchanged', async () => {
    const BATCH = 'QRT-B4';
    const { orderId, lineId } = await approvedOrder();
    await receive({ orderId, lineId, batchNo: BATCH, expiryDate: expiryInDays(SHORT_BY_DAYS), idemKey: randomUUID() });
    const storage: QueryResult<{ id: string }> = await pool.query(
      `select l.id from wms.locations l
         join wms.zones z on z.id = l.zone_id
        where l.warehouse_id = $1 and z.zone_type = 'storage' and l.is_blocked = false
        order by l.code limit 1`,
      [warehouseId],
    );
    const toLocationId = (storage.rows[0] as { id: string }).id;
    const versionBefore = await orderVersion(orderId);
    const movementsBefore = await movementCount(BATCH);

    const result = await handleConfirmPutaway(
      {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: { orderId, lineId, toLocationId, expectedVersion: versionBefore, correlationId: nextCorrelation() },
        ctx,
      },
      deps,
    );

    expect(result.status).toBe(HTTP_UNPROCESSABLE);
    expect(result.body).toMatchObject({ title: 'QuarantineDecisionOpenError' });
    expect(await orderVersion(orderId)).toBe(versionBefore);
    expect(await movementCount(BATCH)).toBe(movementsBefore);
    const line: QueryResult<{ location_id: string | null }> = await pool.query(`select location_id from wms.order_lines where id = $1`, [lineId]);
    expect(line.rows[0]?.location_id).toBeNull();
    expect((await balanceZones(BATCH))[0]?.zone_type).toBe('quarantine');
  });
});

describe("Scenario: the receipt's GRN, wms.inbound.received event and audit rows are unchanged by the routing", () => {
  it('a quarantined single-line order still has its GRN document, one wms.inbound.received outbox event and the line audit row', async () => {
    const BATCH = 'QRT-B5';
    const { orderId, lineId } = await approvedOrder();
    const receiveCorrelation = randomUUID();
    correlationIds.push(receiveCorrelation);
    const body = {
      orderId,
      lineId,
      qtyActual: QTY,
      batchNo: BATCH,
      expiryDate: expiryInDays(SHORT_BY_DAYS),
      expectedVersion: await orderVersion(orderId),
      correlationId: receiveCorrelation,
    };
    const result = await handleReceiveLine({ headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() }, body, ctx }, deps);
    expect(result.status).toBe(200);
    const docs: QueryResult<{ n: number }> = await pool.query(`select count(*)::int as n from platform.documents where source_id = $1`, [orderId]);
    expect(docs.rows[0]?.n).toBe(1);
    const events: QueryResult<{ n: number }> = await pool.query(
      `select count(*)::int as n from platform.outbox where correlation_id = $1 and event_type = 'wms.inbound.received' and aggregate_id = $2`,
      [receiveCorrelation, orderId],
    );
    expect(events.rows[0]?.n).toBe(1);
    const audits: QueryResult<{ n: number }> = await pool.query(
      `select count(*)::int as n from platform.audit_log where correlation_id = $1 and schema_name = 'wms' and table_name = 'order_lines'`,
      [receiveCorrelation],
    );
    expect(audits.rows[0]?.n).toBe(1);
  });
});

